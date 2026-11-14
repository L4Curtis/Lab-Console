#!/usr/bin/env node
/**
 * Mock lab for development, demos and tests - no real equipment needed
 *
 * A fake SSH jump server that accepts the SSH_* credentials and runs:
 *   telnet <host> <port>          a console line: the console server's own login
 *                                 (TELNET_* credentials), then the device
 *   nc -z -w <seconds> <host> <port>
 *                                 line probe: exit 0 when the console port accepts
 *                                 a connection (free), 1 when it refuses (busy, down)
 *   mock-power <host> <port> [mode]
 *                                 the simulator's stand-in for the person on site: switches
 *                                 the device off and on again (`mode`: with the Mode button
 *                                 held, for a switch). The application never sends it; a
 *                                 person trying the password recovery on a pre-production
 *                                 does, from a shell: ssh -p 2222 <user>@<host> mock-power 10.22.9.211 2001
 *
 * Devices are simulated by dev/fakeIos.js (four IOS / IOS XE families, boot,
 * erase, VLANs…) and live as long as the mock lab: a configuration survives
 * closing the console, a reload keeps running when nobody watches. A console
 * port takes one session at a time, like a real console server: a second
 * telnet to a line in use is refused. Device hostnames come from the diagram,
 * so R1 really answers "R1>".
 *
 *   npm run mock-lab            # then, in .env: SSH_HOST=127.0.0.1  SSH_PORT=2222
 *   MOCK_DOWN_PORTS=2003        # console port refuses connections (unplugged / dead line)
 *   MOCK_BUSY_PORTS=2004        # console port held by someone outside the app
 *   MOCK_LOGIN_PORTS=2001       # console server that prompts "login:" at once and
 *                               # hangs up on an empty login
 *   MOCK_SSH_HOST=0.0.0.0        # listen on every interface (a pre-production container);
 *                               # default 127.0.0.1, this machine only
 *   MOCK_SLOW_CONSOLE=1         # old devices: ~1 char/ms, 64-byte input buffer,
 *                               # 40 ms per command; overflowing input is dropped
 *   MOCK_MODELS=2001=2811,2002=c9300l   # model per console port (default: 2811 for
 *                               # names starting with R, 2960 otherwise); see MODELS, and
 *                               # 'aruba': a switch that does not run Cisco IOS (dev/fakeOther.js)
 *   MOCK_STATES=2005=linepass,2006=dialog,2007=rommon,2008=silent
 *                               # starting state per console port (default: user EXEC)
 *   MOCK_ENABLE_SECRET=class    # enable secret of every device (default: none)
 *   MOCK_LINE_PASSWORD=cisco    # console-line password for the "linepass" devices
 *   MOCK_TIME_SCALE=0.02        # boot lengths × this factor (a 4331 boots in 8 s)
 *
 * Like OpenSSH's sshd, one SSH connection carries at most `maxSessions`
 * session channels at a time (MaxSessions, 10 by default): one more is refused
 * with "open failed", which is what the application's connection pool must
 * respect. `stats()` says how many connections and channels are open:
 *   MOCK_MAX_SESSIONS=10
 *
 * It also does SSH port forwarding (direct-tcpip), like a real jump server, so
 * the Proxmox tunnel can be tested; MOCK_FORWARD maps lab addresses to local
 * ones; anything else is refused, as an unreachable lab host would be:
 *   MOCK_FORWARD=<PROXMOX_URL host:port>=127.0.0.1:8006   (default)
 *
 * Importable: startMockLab({ port: 0, ssh, telnet, … }) resolves
 * { port, close(), device(target), stats(), setBusy(port, on), setDown(port, on) } -
 * device('10.22.9.4:2001') is the FakeIos behind that console port (created on
 * first use); stats() → { connections, channels, peakChannels, refusedChannels }
 * (peakChannels is the most channels one connection ever had open at once).
 */
import fs from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import ssh2 from 'ssh2';
import { FakeIos, MODELS } from './fakeIos.js';
import { FakeOther } from './fakeOther.js';

const TELNET_ESCAPE = '\x1d';
const TARGET = /^([\w.-]{1,253}) (\d{1,5})$/;
const PROBE = /^nc -z -w ([1-9]|[12]\d|30) ([\w.-]{1,253}) (\d{1,5})$/;
const POWER = /^mock-power ([\w.-]{1,253}) (\d{1,5})( mode)?$/;

/**
 * @param port        TCP port (0: any free one)
 * @param ssh         { username, password } accepted by the jump server
 * @param telnet      { username, password } of the console server login, or null for none
 * @param names       Map 'host:port' → device hostname
 * @param devices     { 'host:port': FakeIos options } (model, start, enableSecret, linePassword…)
 * @param defaults    FakeIos options for every device (timeScale, enableSecret…)
 * @param downPorts / busyPorts / loginPorts   console ports (numbers)
 * @param slowConsole true for 9600-baud-like devices
 * @param maxSessions session channels per SSH connection (sshd MaxSessions, default 10)
 * @param forwards    Map 'labHost:port' → 'localHost:port' for direct-tcpip
 * @param log         (message) => void
 */
/**
 * An ed25519 host key ssh2 can read back: about one key in five hundred that
 * ssh2's generator writes is refused by its own parser ("Malformed OpenSSH
 * private key"), which made the mock lab fail to start now and then
 */
function hostKeyPair() {
  for (;;) {
    const key = ssh2.utils.generateKeyPairSync('ed25519').private;
    if (!(ssh2.utils.parseKey(key) instanceof Error)) return key;
  }
}

export function startMockLab({
  port = 2222, host = '127.0.0.1', ssh = {}, telnet = null, names = new Map(), devices = {}, defaults = {},
  downPorts = [], busyPorts = [], loginPorts = [], slowConsole = false, forwards = new Map(), log = () => {},
  maxSessions = 10,
} = {}) {
  const down = new Set(downPorts.map(Number));
  const busy = new Set(busyPorts.map(Number));
  const strict = new Set(loginPorts.map(Number));
  const fleet = new Map();      // 'host:port' → FakeIos
  const inUse = new Set();      // console ports with a session
  const clients = new Set();
  const hostKey = hostKeyPair();
  const counters = { peakChannels: 0, refusedChannels: 0 };
  const channelsOf = new Map(); // client → session channels open

  const keyOf = (target) => (typeof target === 'string' ? target : `${target.host}:${target.port}`);
  function device(target) {
    const key = keyOf(target);
    if (!fleet.has(key)) {
      const name = names.get(key) || 'Router';
      const model = devices[key]?.model ?? defaults.model ?? (/^R/i.test(name) ? '2811' : '2960');
      // IOS XE keeps printing syslog lines at the prompt
      const chatter = MODELS[model]?.family === 'iosxe' ? { chatterMs: 45_000 } : {};
      const opts = { hostname: name, timeScale: 0.02, ...chatter, ...defaults, ...devices[key], model };
      if (opts.model && !MODELS[opts.model] && opts.model !== 'aruba') throw new Error(`Unknown model "${opts.model}" for ${key}`);
      // 'aruba': a switch that does not run Cisco IOS (dev/fakeOther.js), which the jobs leave untouched
      const dev = opts.model === 'aruba' ? new FakeOther({ hostname: opts.hostname })
        : new FakeIos({ ...opts, slowConsole: slowConsole ? { bufferBytes: 64, commandMs: 40 } : null });
      dev.out = () => {};
      fleet.set(key, dev);
    }
    return fleet.get(key);
  }
  const lineFree = (key, p) => !down.has(p) && !busy.has(p) && !inUse.has(key);

  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    channelsOf.set(client, 0);
    client.on('close', () => { clients.delete(client); channelsOf.delete(client); });
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ssh.username && ctx.username === ssh.username && ctx.password === ssh.password) return ctx.accept();
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      // Port forwarding: the platform's Proxmox tunnel opens these channels
      client.on('tcpip', (accept, reject, info) => {
        const to = forwards.get(`${info.destIP}:${info.destPort}`);
        if (!to) { log(`forward refused: ${info.destIP}:${info.destPort}`); return reject(); }
        const [h, p] = to.split(':');
        const upstream = net.connect(Number(p), h);
        upstream.once('connect', () => {
          const channel = accept();
          channel.pipe(upstream).pipe(channel);
          channel.on('close', () => upstream.destroy());
          upstream.on('close', () => channel.close?.());
        });
        upstream.once('error', () => reject());
      });
      client.on('session', (accept, reject) => {
        // sshd's MaxSessions: one channel too many is refused ("open failed")
        if (channelsOf.get(client) >= maxSessions) { counters.refusedChannels++; return reject(); }
        channelsOf.set(client, channelsOf.get(client) + 1);
        counters.peakChannels = Math.max(counters.peakChannels, channelsOf.get(client));
        let counted = true;
        const release = () => { if (counted && channelsOf.has(client)) channelsOf.set(client, channelsOf.get(client) - 1); counted = false; };
        const session = accept();
        session.on('pty', (ok) => ok?.());
        session.on('window-change', (ok) => ok?.());
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.on('close', release);
          const probe = info.command.match(PROBE);
          if (probe) {
            const p = Number(probe[3]);
            stream.exit(lineFree(`${probe[2]}:${p}`, p) ? 0 : 1);
            return stream.end();
          }
          const power = info.command.match(POWER);
          if (power) {
            const dev = device(`${power[1]}:${power[2]}`);
            if (typeof dev.powerCycle !== 'function') { stream.stderr.write('mock: this device cannot be power-cycled\r\n'); stream.exit(1); return stream.end(); }
            dev.powerCycle({ modeButton: Boolean(power[3]) });
            stream.write(`power-cycled ${power[1]}:${power[2]}${power[3] ? ' with the Mode button held' : ''}\r\n`);
            stream.exit(0);
            return stream.end();
          }
          const m = info.command.match(/^telnet (.+)$/);
          const t = m && m[1].match(TARGET);
          if (!t) { stream.stderr.write(`mock: unsupported command: ${info.command}\r\n`); stream.exit(127); return stream.end(); }
          runTelnet(stream, t[1], Number(t[2]));
        });
      });
    });
    client.on('error', () => {});
  });

  /** One telnet session to a console port: the console server's login, then the device */
  function runTelnet(stream, h, p) {
    const key = `${h}:${p}`;
    const out = (s) => { if (stream.writable) stream.write(s); };
    out(`Trying ${h}...\r\n`);
    if (!lineFree(key, p)) {
      setTimeout(() => { out('telnet: Unable to connect to remote host: Connection refused\r\n'); stream.exit(1); stream.end(); }, 400);
      return;
    }
    inUse.add(key);
    const dev = device(key);
    let phase = 'connecting';
    let typed = '';
    let user = '';
    let escape = null;
    const finish = () => {
      if (phase === 'closed') return;
      phase = 'closed';
      inUse.delete(key);
      if (dev.out === out) dev.out = () => {};
    };
    const hangup = () => { out('\r\nConnection closed by foreign host.\r\n'); finish(); stream.exit(0); stream.end(); };
    const attach = () => { phase = 'device'; dev.out = out; };

    setTimeout(() => {
      if (phase === 'closed') return;
      out(`Connected to ${h}.\r\nEscape character is '^]'.\r\n`);
      if (!telnet) return attach();
      if (strict.has(p)) { phase = 'user'; out('\r\nlogin: '); } else phase = 'banner';
    }, 250);

    // The console server's own login (the app's AutoLogin answers it)
    const loginKey = (ch) => {
      if (phase === 'banner') { if (ch === '\r') { phase = 'user'; out('\r\n\r\nUser Access Verification\r\n\r\nUsername: '); } return; }
      if (ch === '\n') return;
      if (ch !== '\r') { typed += ch; if (phase === 'user') out(ch); return; }
      const value = typed; typed = '';
      if (phase === 'user') {
        if (!value.trim() && strict.has(p)) return hangup();
        user = value.trim(); phase = 'pass'; out('\r\nPassword: '); return;
      }
      if (user === telnet.username && value === telnet.password) { out('\r\n'); return attach(); }
      phase = 'user'; out('\r\n% Login invalid\r\n\r\nUsername: ');
    };
    // telnet's command mode (Ctrl+]): the app sends "send brk" for a serial BREAK
    const escapeKey = (ch) => {
      if (ch !== '\r') { escape += ch; out(ch); return; }
      const cmd = escape.trim(); escape = null;
      if (cmd === 'send brk') dev.sendBreak();
      if (cmd === 'quit' || cmd === 'close') return hangup();
    };

    stream.on('data', (d) => {
      for (const ch of d.toString('latin1')) {
        if (phase === 'closed' || phase === 'connecting') return;
        if (escape !== null) { escapeKey(ch); continue; }
        if (ch === TELNET_ESCAPE) { escape = ''; out('\r\ntelnet> '); continue; }
        if (phase === 'device') dev.input(ch);
        else loginKey(ch);
      }
    });
    stream.on('close', finish);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      resolve({
        port: bound,
        device,
        stats: () => ({
          connections: clients.size,
          channels: [...channelsOf.values()].reduce((a, b) => a + b, 0),
          ...counters,
        }),
        /** A console port held (or freed) by someone outside the application */
        setBusy: (p, on = true) => { if (on) busy.add(Number(p)); else busy.delete(Number(p)); },
        /** A console port that refuses connections (unplugged, dead line), or works again */
        setDown: (p, on = true) => { if (on) down.add(Number(p)); else down.delete(Number(p)); },
        close: () => new Promise((done) => {
          for (const dev of fleet.values()) dev.stop();
          for (const c of clients) c.end();
          server.close(() => done());
        }),
      });
    });
  });
}

// ── npm run mock-lab ────────────────────────────────────────────────────────

async function main() {
  try { process.loadEnvFile('.env'); } catch { /* optional */ }
  const env = process.env;
  const portList = (v) => (v || '').split(',').filter(Boolean).map(Number);
  const perPort = (v) => new Map((v || '').split(',').filter(Boolean).map((pair) => pair.split('=')).map(([p, value]) => [Number(p), value]));
  const pveTarget = (() => { try { const u = new URL(env.PROXMOX_URL); return `${u.hostname}:${u.port || 8006}`; } catch { return '10.22.9.71:8006'; } })();
  const forwards = new Map((env.MOCK_FORWARD || `${pveTarget}=127.0.0.1:8006`).split(',').filter(Boolean).map((r) => r.split('=')));

  const names = new Map();
  try {
    const { parseDrawio } = await import('../src/modules/consoles/drawio.js');
    const { labs } = parseDrawio(fs.readFileSync(env.DIAGRAM_PATH || './diagrams/diagram.drawio', 'utf8'), { networkPrefix: env.CONSOLE_NETWORK_PREFIX || '10.22.9' });
    for (const l of labs) for (const d of l.devices) names.set(`${d.target.host}:${d.target.port}`, d.name);
  } catch { /* hostnames fall back to "Router" */ }
  try {
    const infra = JSON.parse(fs.readFileSync(env.INFRA_CONFIG_PATH || './config/infrastructure.json', 'utf8'));
    for (const s of infra.adminSwitches || []) names.set(`${s.host}:${s.port}`, `SwitchAdmin-${s.id.toUpperCase()}`);
  } catch { /* optional */ }

  // Per-port models and states apply to every console host using that port
  const models = perPort(env.MOCK_MODELS);
  const states = perPort(env.MOCK_STATES);
  const devices = {};
  for (const key of new Set([...names.keys()])) {
    const p = Number(key.split(':')[1]);
    devices[key] = {
      ...(models.has(p) ? { model: models.get(p) } : {}),
      ...(states.has(p) ? { start: states.get(p) } : {}),
      ...(states.get(p) === 'linepass' ? { linePassword: env.MOCK_LINE_PASSWORD || 'cisco' } : {}),
    };
  }
  const lab = await startMockLab({
    port: Number(env.MOCK_SSH_PORT ?? 2222),
    host: env.MOCK_SSH_HOST || '127.0.0.1',
    ssh: { username: env.SSH_USERNAME, password: env.SSH_PASSWORD },
    telnet: env.TELNET_PASSWORD ? { username: env.TELNET_USERNAME, password: env.TELNET_PASSWORD } : null,
    names,
    devices,
    defaults: {
      timeScale: Number(env.MOCK_TIME_SCALE || 0.02),
      ...(env.MOCK_ENABLE_SECRET ? { enableSecret: env.MOCK_ENABLE_SECRET } : {}),
    },
    downPorts: portList(env.MOCK_DOWN_PORTS),
    busyPorts: portList(env.MOCK_BUSY_PORTS),
    loginPorts: portList(env.MOCK_LOGIN_PORTS),
    slowConsole: Boolean(env.MOCK_SLOW_CONSOLE),
    ...(env.MOCK_MAX_SESSIONS ? { maxSessions: Number(env.MOCK_MAX_SESSIONS) } : {}),
    forwards,
    log: (m) => console.log(m),
  });
  console.log(`Mock jump server on ${env.MOCK_SSH_HOST || '127.0.0.1'}:${lab.port} (${names.size} devices from the diagram, forwarding ${[...forwards.keys()].join(', ')})`);
  const stop = () => lab.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
