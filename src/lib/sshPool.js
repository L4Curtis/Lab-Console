/**
 * A small pool of SSH connections to the jump server, shared by the console
 * lines: one TCP connection carries several `exec` channels (one per console
 * line, one per line probe) instead of one connection each.
 *
 * Why: thirty students opening their bench at 8:00 used to make thirty SSH
 * handshakes to the jump server, each with its own authentication log line
 * and its own keepalive. sshd caps the channels of one connection
 * (MaxSessions, 10 by default) and refuses one more with "open failed", so a
 * connection takes at most `channelsPerConnection` (8: room for a probe and a
 * margin) and the pool opens another one when they are all full.
 *
 *   const pool = new SshPool({ channelsPerConnection: 8, logger })
 *   const stream = await pool.exec(settings.ssh, 'telnet 10.22.9.211 2001', { pty })
 *   stream.close()                  // the slot is given back when the channel closes
 *   pool.stats()                    // [{ key, channels, state }]
 *   pool.close()                    // ends every connection (shutdown)
 *
 * Rules:
 *   - the connection settings are passed to every exec() (read from the
 *     settings service by the caller at that moment): connections are keyed by
 *     host, port, user and a fingerprint of the credentials, so a change made
 *     by an administrator applies to the next line while the lines already
 *     open finish on the old connection;
 *   - a slot is reserved synchronously, before the connection is even ready,
 *     so ten lines opened at once share connections instead of racing;
 *   - a connection that fails or closes is dropped at once (its lines end with
 *     it, ssh2 closes their channels) and the next exec() opens a new one;
 *   - a channel refused by the server ("open failed": its MaxSessions is lower
 *     than ours) caps that connection at what it holds, and the exec is
 *     retried once on another connection; an exec on a connection that died
 *     between the reservation and the request is retried once too;
 *   - a connection without channels is closed after `idleMs`, so a quiet
 *     platform holds nothing open on the jump server.
 */
import crypto from 'node:crypto';
import { Client } from 'ssh2';
import { sshConnectOptions } from './ssh.js';

export class SshPool {
  #entries = new Set();
  #closed = false;

  /**
   * @param channelsPerConnection  exec channels one connection may carry (keep it under sshd's MaxSessions)
   * @param idleMs                 a connection without channels is closed after this long (0: at once)
   * @param logger                 { info, warn, error, debug? }
   * @param createClient           () => ssh2 Client (tests)
   */
  constructor({ channelsPerConnection = 8, idleMs = 30_000, logger, createClient = () => new Client() } = {}) {
    if (!Number.isInteger(channelsPerConnection) || channelsPerConnection < 1) throw new TypeError('channelsPerConnection must be a positive integer');
    this.channelsPerConnection = channelsPerConnection;
    this.idleMs = idleMs;
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.createClient = createClient;
  }

  /**
   * Open an exec channel on a connection to `ssh` (the shape of config.ssh).
   * Resolves the ssh2 stream; rejects with the connection's error (pass it
   * to sshErrorInfo) or the channel's. `setup(stream)` runs synchronously as
   * soon as the channel exists, before any of its data or exit status can be
   * emitted: attach the listeners there, not after the promise resolves
   */
  async exec(ssh, command, options = {}, setup = () => {}) {
    if (this.#closed) throw Object.assign(new Error('The connection pool is closed'), { code: 'POOL_CLOSED' });
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = this.#reserve(ssh);
      try {
        await entry.ready;
        return await this.#open(entry, command, options, setup);
      } catch (err) {
        this.#release(entry);
        lastError = err;
        if (entry.dead && entry.connected) continue;          // died after it was up: a new connection may work
        if (err.channelRefused) { entry.capacity = Math.max(0, entry.channels); continue; } // MaxSessions below ours
        throw err;                                             // could not connect at all: the caller says why
      }
    }
    throw lastError;
  }

  /** One line per connection: key (host:port user), channels in use, state */
  stats() {
    return [...this.#entries].map((e) => ({ key: e.label, channels: e.channels, capacity: e.capacity, state: e.dead ? 'dead' : e.connected ? 'ready' : 'connecting' }));
  }

  /** Total channels in use, and connections open */
  get size() {
    let channels = 0;
    for (const e of this.#entries) channels += e.channels;
    return { connections: this.#entries.size, channels };
  }

  /** End every connection (their channels close with them) */
  close() {
    this.#closed = true;
    for (const e of [...this.#entries]) this.#drop(e);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #reserve(ssh) {
    const key = poolKey(ssh);
    for (const e of this.#entries) {
      if (e.key === key && !e.dead && e.channels < e.capacity) {
        e.channels++;
        clearTimeout(e.idleTimer);
        return e;
      }
    }
    const entry = this.#connect(ssh, key);
    entry.channels++;
    return entry;
  }

  #connect(ssh, key) {
    const client = this.createClient();
    const entry = {
      key,
      label: `${ssh.username}@${ssh.host}:${ssh.port}`,
      client,
      channels: 0,
      capacity: this.channelsPerConnection,
      connected: false,
      dead: false,
      idleTimer: null,
      ready: null,
    };
    entry.ready = new Promise((resolve, reject) => {
      client.once('ready', () => { entry.connected = true; resolve(); });
      client.on('error', (err) => {
        if (!entry.connected) reject(err);
        else this.log.warn(`jump server connection ${entry.label} failed: ${err.message}`);
        this.#drop(entry);
      });
      client.on('close', () => {
        if (!entry.connected) reject(Object.assign(new Error('Connection to the jump server closed'), { code: 'ECONNRESET' }));
        this.#drop(entry);
      });
    });
    entry.ready.catch(() => {}); // the exec() that waits for it reports the error
    this.#entries.add(entry);
    this.log.debug?.(`opening a jump server connection ${entry.label} (${this.#entries.size} open)`);
    client.connect(sshConnectOptions(ssh, this.log));
    return entry;
  }

  #open(entry, command, options, setup) {
    return new Promise((resolve, reject) => {
      if (entry.dead) return reject(Object.assign(new Error('Connection to the jump server closed'), { code: 'ECONNRESET' }));
      let stream;
      try {
        entry.client.exec(command, options, (err, s) => {
          if (err) {
            // "open failed" / "administratively prohibited": the server's MaxSessions
            if (/open failed|prohibited|resource shortage|channel open failure/i.test(err.message) || err.reason !== undefined) err.channelRefused = true;
            return reject(err);
          }
          stream = s;
          let released = false;
          stream.once('close', () => {
            if (released) return;
            released = true;
            this.#release(entry);
          });
          setup(stream);
          resolve(stream);
        });
      } catch (err) {
        reject(err); // "Not connected": the connection went away in between
      }
    });
  }

  #release(entry) {
    entry.channels = Math.max(0, entry.channels - 1);
    if (entry.channels > 0 || entry.dead) return;
    clearTimeout(entry.idleTimer);
    if (this.idleMs <= 0) return this.#drop(entry);
    entry.idleTimer = setTimeout(() => { if (entry.channels === 0) this.#drop(entry); }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  #drop(entry) {
    if (!this.#entries.has(entry)) return;
    entry.dead = true;
    clearTimeout(entry.idleTimer);
    this.#entries.delete(entry);
    try { entry.client.end(); } catch { /* already gone */ }
  }
}

/** Connections are shared only between identical settings; the credentials are fingerprinted, never kept as a key */
function poolKey(ssh) {
  const secret = crypto.createHash('sha256')
    .update(String(ssh.password ?? ''))
    .update('\0')
    .update(ssh.privateKey ? Buffer.from(ssh.privateKey) : Buffer.alloc(0))
    .update('\0')
    .update(String(ssh.passphrase ?? ''))
    .update('\0')
    .update(String(ssh.hostFingerprint ?? ''))
    .digest('base64url');
  return `${ssh.username}@${ssh.host}:${ssh.port}#${secret}`;
}
