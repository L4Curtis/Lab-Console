/**
 * A shared SSH connection to the jump server used as a TCP tunnel into the
 * isolated lab network (Proxmox API + console WebSockets)
 *
 *   platform ──SSH──► jump server ──► 10.22.9.71:8006
 *
 * Two transports reach the same destination; both are chosen automatically:
 *
 *   forward  A `direct-tcpip` channel (the equivalent of `ssh -L`). One SSH
 *            connection carries every request; forwarded channels do not count
 *            against sshd's MaxSessions. This is the default and the lightest.
 *
 *   exec     The jump server runs a relay command (`socat`/`nc`/bash /dev/tcp)
 *            that connects to Proxmox for us, and we speak TLS over its stdio.
 *            This is the SAME mechanism the device consoles already use (an
 *            exec channel running `telnet`), so it works even when the jump
 *            server refuses TCP forwarding (`AllowTcpForwarding no`,
 *            `DisableForwarding`, a narrow `PermitOpen`, or `restrict` in
 *            authorized_keys). Each relay is a *session* channel, so these DO
 *            count against MaxSessions (default 10) - hence the small pool of
 *            connections below.
 *
 * Transport selection (PROXMOX_TUNNEL_TRANSPORT): `auto` (default) tries
 * `forward` and, the first time the jump server answers "administratively
 * prohibited / open failed", switches to `exec` for the rest of the run and
 * logs it once. `forward` / `exec` force one transport.
 *
 * The connection(s) are opened lazily, shared by concurrent callers, kept
 * alive with SSH keepalives, and transparently re-opened if the jump server
 * drops them.
 */
import { Client } from 'ssh2';
import { sshConnectOptions, describeSshError } from './ssh.js';

const HOST_RE = /^[A-Za-z0-9._-]+$/; // relay targets are shell-interpolated: keep them boring

export class SshTunnel {
  #pool = [];            // [{ conn, channels, ready }] - a conn joins once `ready` resolves
  #transport;            // 'forward' | 'exec' | 'auto' (auto downgrades to 'exec' in place)
  #relayTool = new WeakMap(); // conn -> 'socat' | 'ncat' | 'nc' | 'bash' (probed once per conn)

  constructor({ ssh, logger }) {
    this.ssh = ssh;
    this.log = logger;
    this.#transport = (ssh.tunnelTransport || 'auto').toLowerCase();
    // A relay is a session channel; stay under a typical `MaxSessions 10` with
    // headroom for the one-off probe and keepalives, and spread bursts across a
    // few connections. (Forwarded channels are unlimited, so this only ever
    // constrains exec mode.)
    this.perConnChannels = 6;
    this.maxConns = 4;
  }

  /** Opens a byte stream to host:port as seen from the jump server */
  async forwardOut(host, port, retried = false) {
    const transport = this.#transport === 'exec' ? 'exec' : 'forward';
    try {
      return await this.#open(transport, host, port);
    } catch (err) {
      // A forwarding *policy* block is not a transient failure. In `auto`, fall
      // back to the exec relay and retry. This also catches concurrent requests
      // that were mid-forward when another one already flipped the mode, so a
      // whole burst downgrades cleanly rather than only the first request.
      if (transport === 'forward' && err.adminProhibited && this.#transport !== 'forward') {
        if (this.#transport !== 'exec') {
          this.#transport = 'exec';
          this.log.warn(`Jump server refuses TCP forwarding (${err.cause || 'open failed'}); switching the Proxmox tunnel to exec/relay mode, like the device consoles`);
        }
        return this.forwardOut(host, port, retried);
      }
      // The shared connection may have died between two calls: retry once fresh
      if (err.retryable && !retried) return this.forwardOut(host, port, true);
      throw err;
    }
  }

  get state() {
    return {
      transport: this.#transport,
      connected: this.#pool.some((e) => e.conn),
      connections: this.#pool.length,
      openChannels: this.#pool.reduce((n, e) => n + e.load, 0),
    };
  }

  close() {
    for (const e of this.#pool) { try { e.conn?.end(); } catch { /* ignore */ } }
    this.#pool = [];
  }

  async #open(transport, host, port) {
    const entry = await this.#acquire(); // reserves a slot (entry.load already ++)
    let released = false;
    const release = () => { if (!released) { released = true; entry.load--; } };
    try {
      const stream = transport === 'exec'
        ? await this.#execForward(entry.conn, host, port)
        : await this.#directForward(entry.conn, host, port);
      stream.once('close', release);
      return stream;
    } catch (err) {
      release();
      if (err.retryable) this.#dropConn(entry);
      throw err;
    }
  }

  // ── Transports ──────────────────────────────────────────────────────────

  #directForward(conn, host, port) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        conn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          settled = true;
          if (err) return reject(forwardError(err, host, port));
          resolve(stream);
        });
      } catch (err) {
        if (!settled) reject(Object.assign(new Error(err.message), { retryable: true }));
      }
    });
  }

  async #execForward(conn, host, port) {
    if (!HOST_RE.test(host) || !(port > 0 && port < 65536)) {
      throw new Error(`Refusing to relay to an unexpected target (${host}:${port})`);
    }
    const cmd = this.#relayCommand(await this.#tool(conn), host, port);
    return new Promise((resolve, reject) => {
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) {
          return reject(Object.assign(new Error(`Jump server could not start the relay to ${host}:${port}: ${err.message}`), { retryable: /not connected|no response|closed|channel open/i.test(err.message) }));
        }
        // The relay prints to stderr when it cannot connect ("nc: connect ...",
        // "socat ... refused"); surface it instead of a silent dead socket
        stream.stderr?.on('data', (d) => {
          const line = String(d).trim();
          if (line) this.log.warn(`relay ${host}:${port}: ${line}`);
        });
        resolve(stream);
      });
    });
  }

  /** Probes the jump server once per connection for the best available relay */
  async #tool(conn) {
    if (this.ssh.tunnelRelay) return 'custom';
    if (this.#relayTool.has(conn)) return this.#relayTool.get(conn);
    const probe = new Promise((resolve) => {
      let out = '';
      conn.exec('command -v socat ncat nc 2>/dev/null; echo "BASH=${BASH_VERSINFO:-0}"', { pty: false }, (err, stream) => {
        if (err) return resolve('nc'); // can't probe: nc is the safest common default
        stream.on('data', (d) => { out += d; });
        stream.on('close', () => {
          const has = (t) => new RegExp(`/${t}$`, 'm').test(out);
          const bashOk = /BASH=[4-9]/.test(out) || /BASH=[1-9]\d/.test(out);
          resolve(has('socat') ? 'socat' : has('ncat') ? 'ncat' : has('nc') ? 'nc' : bashOk ? 'bash' : 'nc');
        });
        stream.stderr?.resume();
      });
    });
    this.#relayTool.set(conn, probe);
    const tool = await probe;
    this.#relayTool.set(conn, tool);
    this.log.info(`Proxmox relay on ${this.ssh.host} uses ${this.ssh.tunnelRelay ? 'a custom command' : tool}`);
    return tool;
  }

  #relayCommand(tool, host, port) {
    if (this.ssh.tunnelRelay) {
      return this.ssh.tunnelRelay.replaceAll('{host}', host).replaceAll('{port}', port);
    }
    switch (tool) {
      case 'socat': return `socat -T30 STDIO TCP:${host}:${port}`;
      case 'ncat': return `ncat ${host} ${port}`;
      // bash /dev/tcp: pump both directions, then reap the reader when stdin ends
      case 'bash': return `bash -c 'exec 3<>/dev/tcp/${host}/${port}; cat <&3 & reader=$!; cat >&3; kill $reader 2>/dev/null'`;
      default: return `nc ${host} ${port}`;
    }
  }

  // ── Connection pool ───────────────────────────────────────────────────────

  /**
   * Returns a pool entry with a slot reserved (entry.load incremented up front)
   * so that a simultaneous cold burst spreads across connections instead of
   * stacking every relay onto the first one and tripping sshd's MaxSessions.
   */
  async #acquire() {
    // A connection (ready or still connecting) with a reserved slot free
    const spare = this.#pool.find((e) => e.load < this.perConnChannels);
    if (spare) { spare.load++; if (!spare.conn) await spare.ready; return spare; }

    // Open another connection while under the cap
    if (this.#pool.length < this.maxConns) {
      const entry = { conn: null, load: 1, ready: null };
      this.#pool.push(entry);
      entry.ready = this.#connect(entry).catch((err) => { this.#pool = this.#pool.filter((e) => e !== entry); throw err; });
      await entry.ready;
      return entry;
    }
    // At the connection cap: pile onto the least-loaded (may exceed the soft
    // per-conn target under extreme bursts; the client already caps in-flight)
    const least = this.#pool.reduce((a, b) => (a.load <= b.load ? a : b));
    least.load++;
    if (!least.conn) await least.ready;
    return least;
  }

  #connect(entry) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.once('ready', () => {
        entry.conn = conn;
        this.log.info(`SSH tunnel to ${this.ssh.host} is up (${this.#pool.length} connection${this.#pool.length > 1 ? 's' : ''})`);
        resolve(conn);
      });
      conn.once('error', (err) => {
        if (entry.conn !== conn) reject(new Error(describeSshError(err, this.ssh)));
        else this.log.warn(`SSH tunnel error: ${err.message}`);
      });
      conn.once('close', () => {
        if (entry.conn === conn) {
          this.#pool = this.#pool.filter((e) => e !== entry);
          this.log.info('SSH tunnel connection closed; it will reopen on next use');
        }
      });
      conn.connect(sshConnectOptions(this.ssh, this.log));
    });
  }

  #dropConn(entry) {
    this.#pool = this.#pool.filter((e) => e !== entry);
    try { entry.conn?.end(); } catch { /* ignore */ }
  }
}

/** Classifies a direct-tcpip CHANNEL_OPEN_FAILURE from the jump server */
function forwardError(err, host, port) {
  // ssh2 sets err.reason: 1 = ADMINISTRATIVELY_PROHIBITED, 2 = CONNECT_FAILED
  const admin = err.reason === 1 || /administratively prohibited|open failed/i.test(err.message);
  const e = new Error(admin
    ? `Jump server refuses TCP forwarding to ${host}:${port}: the account's sshd policy blocks it (AllowTcpForwarding / DisableForwarding / PermitOpen, or "restrict" / "no-port-forwarding" in authorized_keys)`
    : `Jump server could not open ${host}:${port}: ${err.message}`);
  e.adminProhibited = admin;
  e.cause = err.message;
  // "Connection refused" / "no route" from the far side is transient-ish but
  // not a dead SSH link; only reconnect when the SSH channel layer is at fault
  e.retryable = /not connected|no response|closed/i.test(err.message);
  return e;
}
