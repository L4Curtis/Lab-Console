/**
 * Health of the lab chain, as the server sees it: the jump server, the
 * console servers behind it, and the Proxmox API (reached through the jump
 * server, like everything on the lab network)
 *
 * One SSH connection with the current lab parameters, then one
 * `nc -z -w 3 <host> <port>` per console server and for Proxmox: the same
 * probe the consoles use, nothing is typed on a line.
 *
 * A console server is "up" when it ANSWERS on the network: a connection
 * accepted, or one actively refused (the TCP reset comes from the host). Its
 * telnet port (23) was not checked against the real equipment, whose
 * console lines are on 20xx ports: a server that does not listen on 23 must
 * not read as down. Only silence (a timeout, no route) is "down". Proxmox is
 * stricter: its API port must accept the connection.
 *
 * The Proxmox tunnel itself (the shared SSH connection its module keeps open
 * for the API and the console sockets) is read from the Proxmox module when
 * it publishes it (`services.proxmox.tunnel()` → { connected, transport,
 * connections, openChannels }). It connects on first use, so "idle" is normal.
 * Results are kept 30 seconds, so a page reloaded by a classroom does not
 * hammer the jump server; an administrator may ask for a fresh check (at
 * most every 10 seconds).
 *
 *   health.check({ fresh }) → { checkedAt, jump: { state, ms, error }, consoleServers: [...], proxmox: {...} }
 *   summary(result)         → what a student may see: states only, no address, no error text
 */
import ssh2 from 'ssh2';
import { sshConnectOptions, sshErrorInfo } from '../../lib/ssh.js';

const CACHE_MS = 30_000;
const FRESH_MIN_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 6_000;
export const CONSOLE_SERVER_PORT = 23;
const SAFE_HOST = /^[\w.-]{1,253}$/;

/**
 * One `nc -z` through the jump server → { state: 'ok' | 'down' | 'unknown', error? }.
 * `answers`: a refused connection counts as up (the host answered)
 */
export function probe(conn, host, port, { answers = false } = {}) {
  return new Promise((resolve) => {
    if (!SAFE_HOST.test(host) || !Number.isInteger(port)) return resolve({ state: 'down', error: 'invalid address' });
    let said = '';
    const timer = setTimeout(() => resolve({ state: 'down', error: 'no answer' }), PROBE_TIMEOUT_MS);
    conn.exec(`nc -z -w 3 ${host} ${port}`, (err, stream) => {
      if (err) { clearTimeout(timer); return resolve({ state: 'unknown', error: err.message }); }
      const hear = (d) => { said = (said + d).slice(-400); };
      stream.on('data', hear).stderr.on('data', hear);
      stream.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve({ state: 'ok' });
        resolve(answers && /refused/i.test(said) ? { state: 'ok', note: 'refused' } : { state: 'down', error: `exit ${code}` });
      });
      stream.on('close', () => { clearTimeout(timer); resolve({ state: 'unknown', error: 'closed' }); });
    });
  });
}

export function createHealth({ settings, config, services, logger, now = Date.now }) {
  const log = logger ?? { warn() {} };
  let last = null;      // { at, result }
  let running = null;

  /** What the Proxmox module says about its tunnel; null while it does not say */
  function tunnelState() {
    try {
      const t = services?.proxmox?.tunnel?.();
      if (!t) return null;
      return { state: t.connected ? 'connected' : 'idle', transport: t.transport ?? null, connections: t.connections ?? 0, openChannels: t.openChannels ?? 0 };
    } catch (err) {
      log.warn(`the Proxmox tunnel state could not be read: ${err.message}`);
      return null;
    }
  }

  async function run() {
    const lab = settings.get('lab');
    const started = now();
    const result = {
      checkedAt: new Date(started).toISOString(),
      jump: { state: 'unknown', host: `${lab.ssh.host}:${lab.ssh.port}` },
      consoleServers: lab.consoles.allowedHosts.map((host) => ({ host, port: CONSOLE_SERVER_PORT, state: 'unknown' })),
      proxmox: config.proxmox?.enabled
        ? { state: 'unknown', host: new URL(config.proxmox.url).host, tunnel: tunnelState() }
        : { state: 'off' },
    };
    const conn = new ssh2.Client();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
        conn.once('ready', () => { clearTimeout(timer); resolve(); });
        conn.once('error', (err) => { clearTimeout(timer); reject(err); });
        conn.connect({ ...sshConnectOptions(lab.ssh, log), readyTimeout: CONNECT_TIMEOUT_MS, keepaliveInterval: 0 });
      });
      result.jump = { ...result.jump, state: 'ok', ms: now() - started };
      await Promise.all(result.consoleServers.map(async (s) => Object.assign(s, await probe(conn, s.host, s.port, { answers: true }))));
      if (config.proxmox?.enabled) {
        const url = new URL(config.proxmox.url);
        Object.assign(result.proxmox, await probe(conn, url.hostname, Number(url.port || 8006)));
      }
    } catch (err) {
      const info = sshErrorInfo(err, lab.ssh);
      result.jump = { ...result.jump, state: 'down', code: info.code, params: info.params, error: info.message };
    } finally {
      conn.end();
    }
    return result;
  }

  return {
    async check({ fresh = false } = {}) {
      const age = last ? now() - last.at : Infinity;
      if (last && age < (fresh ? FRESH_MIN_MS : CACHE_MS)) return last.result;
      running ??= run().then((result) => {
        last = { at: now(), result };
        return result;
      }).finally(() => { running = null; });
      return running;
    },
    forget() { last = null; },
  };
}

/** States only: what any signed-in user may see */
export function summary(result) {
  return {
    checkedAt: result.checkedAt,
    jump: { state: result.jump.state },
    consoleServers: { ok: result.consoleServers.filter((s) => s.state === 'ok').length, total: result.consoleServers.length },
    proxmox: { state: result.proxmox.state, ...(result.proxmox.tunnel ? { tunnel: result.proxmox.tunnel.state } : {}) },
  };
}
