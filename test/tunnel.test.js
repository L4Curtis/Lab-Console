/**
 * SshTunnel transports - the Proxmox tunnel must cross the jump server even
 * when that server forbids TCP forwarding (AllowTcpForwarding no), by running
 * a relay command over an exec channel, the same mechanism the device consoles
 * use. These tests stand up a mock jump server in-process:
 *
 *   forwarding ON   emits 'tcpip'  → direct-tcpip to the target  (transport: forward)
 *   forwarding OFF  no 'tcpip'     → ssh2 answers ADMINISTRATIVELY_PROHIBITED
 *   exec            emits 'session'→'exec' → probes tools, runs `nc host port`
 *
 * The target is a plain TCP echo server, so a round-trip proves the byte path
 * without needing TLS on top.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import ssh2 from 'ssh2';
import { SshTunnel } from '../src/lib/sshTunnel.js';

const log = { info() {}, warn() {}, error() {}, child() { return log; } };

/** TCP echo server; every chunk comes back prefixed so we can tell it answered */
function startEcho() {
  const server = net.createServer((sock) => sock.on('data', (d) => sock.write(`echo:${d}`)));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

/**
 * @param allowForward  when false, no 'tcpip' listener is registered, so ssh2
 *                       refuses forwarding with ADMINISTRATIVELY_PROHIBITED
 * @param maxSessions   reject a session channel beyond this many (like sshd)
 */
function startJump(targetPort, { allowForward, maxSessions = 10 } = {}) {
  const stats = { connections: 0, forwardChannels: 0, execChannels: 0, clients: new Set(), peakSessionsPerConn: 0 };
  const server = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (client) => {
    stats.clients.add(client);
    let sessions = 0;
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      stats.connections++;
      if (allowForward) {
        client.on('tcpip', (accept, reject, info) => {
          if (info.destPort !== targetPort) return reject();
          const up = net.connect(info.destPort, '127.0.0.1');
          up.once('connect', () => { stats.forwardChannels++; const ch = accept(); ch.pipe(up).pipe(ch); ch.on('close', () => up.destroy()); });
          up.once('error', () => reject());
        });
      }
      client.on('session', (acceptSession) => {
        if (sessions >= maxSessions) return; // no accept() → ssh2 sends "open failed" like MaxSessions
        sessions++;
        stats.peakSessionsPerConn = Math.max(stats.peakSessionsPerConn, sessions);
        const session = acceptSession();
        session.once('exec', (accept, _reject, info) => {
          const stream = accept();
          const cmd = info.command;
          if (/command -v/.test(cmd)) {               // tool probe
            stream.write('/usr/bin/nc\n');
            stream.exit(0); stream.end(); sessions--;
            return;
          }
          const m = cmd.match(/nc\s+(\S+)\s+(\d+)/);   // `nc host port`
          if (!m) { stream.stderr.write('relay: bad command\n'); stream.exit(1); stream.end(); sessions--; return; }
          const up = net.connect(Number(m[2]), m[1]);
          up.once('connect', () => { stats.execChannels++; stream.pipe(up).pipe(stream); });
          up.once('error', (e) => { stream.stderr.write(`nc: ${e.message}\n`); stream.exit(1); stream.end(); sessions--; });
          const done = () => { up.destroy(); sessions--; };
          stream.on('close', done);
        });
      });
    });
    client.on('close', () => stats.clients.delete(client));
    client.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, stats, port: server.address().port })));
}

let echo;
const jumps = [];
const tunnels = [];
before(async () => { echo = await startEcho(); });
after(async () => {
  for (const t of tunnels) t.close();
  for (const j of jumps) { for (const c of j.stats.clients) c.end(); j.server.close(); }
  echo.server.close();
});

async function jump(opts) { const j = await startJump(echo.port, opts); jumps.push(j); return j; }
function tunnel(j, transport) {
  const t = new SshTunnel({ ssh: { host: '127.0.0.1', port: j.port, username: 'x', password: 'y', readyTimeoutMs: 5000, keepaliveIntervalMs: 0, tunnelTransport: transport }, logger: log });
  tunnels.push(t);
  return t;
}

/** Opens a channel, sends a byte, resolves the echoed reply */
function roundTrip(stream, payload = 'ping') {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (d) => { out += d; if (out.includes('echo:')) resolve(out.trim()); });
    stream.on('error', reject);
    stream.write(payload);
    setTimeout(() => reject(new Error(`no echo (got "${out}")`)), 3000);
  });
}

test('forward transport carries bytes when the jump server allows forwarding', async () => {
  const j = await jump({ allowForward: true });
  const t = tunnel(j, 'forward');
  assert.equal(await roundTrip(await t.forwardOut('127.0.0.1', echo.port)), 'echo:ping');
  assert.equal(t.state.transport, 'forward');
  assert.ok(j.stats.forwardChannels >= 1 && j.stats.execChannels === 0);
});

test('forward transport, forwarding blocked: a clear policy error, no silent hang', async () => {
  const j = await jump({ allowForward: false });
  const t = tunnel(j, 'forward');
  await assert.rejects(t.forwardOut('127.0.0.1', echo.port), /refuses TCP forwarding.*sshd policy|AllowTcpForwarding/);
});

test('auto transport downgrades to the exec relay when forwarding is blocked', async () => {
  const j = await jump({ allowForward: false });
  const t = tunnel(j, 'auto');
  assert.equal(await roundTrip(await t.forwardOut('127.0.0.1', echo.port)), 'echo:ping');
  assert.equal(t.state.transport, 'exec', 'the tunnel remembers the downgrade');
  assert.ok(j.stats.execChannels >= 1, 'went through an exec relay');
});

test('exec transport works and a concurrent burst spreads across connections (MaxSessions)', async () => {
  const j = await jump({ allowForward: false, maxSessions: 10 });
  const t = tunnel(j, 'exec');
  const streams = await Promise.all(Array.from({ length: 10 }, () => t.forwardOut('127.0.0.1', echo.port)));
  const replies = await Promise.all(streams.map((s) => roundTrip(s)));
  assert.ok(replies.every((r) => r === 'echo:ping'), 'all 10 relays carried bytes');
  assert.ok(t.state.connections >= 2, `burst used >1 connection (used ${t.state.connections})`);
  assert.ok(j.stats.peakSessionsPerConn <= 10, `stayed within MaxSessions per connection (peak ${j.stats.peakSessionsPerConn})`);
  for (const s of streams) s.end();
});

test('exec transport refuses an unexpected (non-allowlisted) relay target', async () => {
  const j = await jump({ allowForward: false });
  const t = tunnel(j, 'exec');
  await assert.rejects(t.forwardOut('127.0.0.1; rm -rf /', 8006), /unexpected target/);
});
