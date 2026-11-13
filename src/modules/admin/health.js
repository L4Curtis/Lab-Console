/**
 * Health of the lab chain, as the server sees it: the jump server, the
 * console servers behind it, and the Proxmox API (reached through the jump
 * server, like everything on the lab network)
 *
 * One SSH connection with the current lab parameters, then one
 * `nc -z -w 3 <host> <port>` per console server (its telnet port, 23) and for
 * Proxmox: the same probe the consoles use, nothing is typed on a line.
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

function probe(conn, host, port) {
  return new Promise((resolve) => {
    if (!SAFE_HOST.test(host) || !Number.isInteger(port)) return resolve({ state: 'down', error: 'invalid address' });
    const timer = setTimeout(() => resolve({ state: 'down', error: 'no answer' }), PROBE_TIMEOUT_MS);
    conn.exec(`nc -z -w 3 ${host} ${port}`, (err, stream) => {
      if (err) { clearTimeout(timer); return resolve({ state: 'unknown', error: err.message }); }
      stream.on('data', () => {}).stderr.on('data', () => {});
      stream.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { state: 'ok' } : { state: 'down', error: `exit ${code}` }); });
      stream.on('close', () => { clearTimeout(timer); resolve({ state: 'unknown', error: 'closed' }); });
    });
  });
}

export function createHealth({ settings, config, logger, now = Date.now }) {
  const log = logger ?? { warn() {} };
  let last = null;      // { at, result }
  let running = null;

  async function run() {
    const lab = settings.get('lab');
    const started = now();
    const result = {
      checkedAt: new Date(started).toISOString(),
      jump: { state: 'unknown', host: `${lab.ssh.host}:${lab.ssh.port}` },
      consoleServers: lab.consoles.allowedHosts.map((host) => ({ host, port: CONSOLE_SERVER_PORT, state: 'unknown' })),
      proxmox: config.proxmox?.enabled
        ? { state: 'unknown', host: new URL(config.proxmox.url).host }
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
      await Promise.all(result.consoleServers.map(async (s) => Object.assign(s, await probe(conn, s.host, s.port))));
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
    proxmox: { state: result.proxmox.state },
  };
}
