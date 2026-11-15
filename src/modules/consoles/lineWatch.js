/**
 * "Tell me when it is free": a student whose line was refused by the console
 * server (someone outside the application holds it) asks to be told when it
 * frees up. Every `retryMs` (30 s) the line is probed through the jump server
 * with `nc -z -w 3 <host> <port>` (exit 0: the console server accepts a
 * connection, so nobody holds it); after `maxMs` (30 min) the watch gives up.
 * Either way, only that user is told (events.toUser), on 'consoles:free'.
 *
 * A line opened in the application meanwhile counts as an answer too: the
 * student can join it to watch (state 'open').
 *
 *   watch.start(user, device) → { target, until }
 *   watch.stop(user, target) · watch.list(user) · watch.close()
 */
const PROBE_SECONDS = 3;
const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/;

export class LineWatch {
  #watches = new Map(); // `${userId} ${target}` → { user, device, target, until, timer, probing }

  /**
   * @param probe     async (device) → 'free' | 'busy' | 'unknown'
   * @param isOpen    (target) => boolean: a room exists for that line
   * @param notify    (userId, payload) => void
   * @param onFree    (target) => void: the line was seen free (clears "busy outside")
   */
  constructor({ probe, isOpen, notify, onFree = () => {}, retryMs = 30_000, maxMs = 30 * 60_000, now = () => Date.now(), logger }) {
    this.probe = probe;
    this.isOpen = isOpen;
    this.notify = notify;
    this.onFree = onFree;
    this.retryMs = retryMs;
    this.maxMs = maxMs;
    this.now = now;
    this.log = logger ?? { warn() {} };
  }

  start(user, device) {
    const target = `${device.target.host}:${device.target.port}`;
    const id = `${user.id} ${target}`;
    this.#stopId(id);
    const w = { user, device, target, until: this.now() + this.maxMs, timer: null, probing: false };
    this.#watches.set(id, w);
    this.#schedule(id, w);
    return { target, until: new Date(w.until).toISOString() };
  }

  stop(user, target) {
    return this.#stopId(`${user.id} ${target}`);
  }

  list(user) {
    return [...this.#watches.values()].filter((w) => w.user.id === user.id)
      .map((w) => ({ target: w.target, key: w.device.key, device: w.device.name, bench: w.device.labName, until: new Date(w.until).toISOString() }));
  }

  close() {
    for (const id of [...this.#watches.keys()]) this.#stopId(id);
  }

  #stopId(id) {
    const w = this.#watches.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.#watches.delete(id);
    return true;
  }

  #schedule(id, w) {
    w.timer = setTimeout(() => this.#tick(id, w), this.retryMs);
    w.timer.unref?.();
  }

  async #tick(id, w) {
    if (this.#watches.get(id) !== w) return;
    const payload = { target: w.target, key: w.device.key, device: w.device.name, bench: w.device.labName };
    let state;
    if (this.isOpen(w.target)) state = 'open';
    else {
      try {
        state = await this.probe(w.device, PROBE_SECONDS);
      } catch (err) {
        this.log.warn(`line probe ${w.target}: ${err.message}`);
        state = 'unknown';
      }
    }
    if (this.#watches.get(id) !== w) return; // stopped while probing
    if (state === 'free' || state === 'open') {
      this.#watches.delete(id);
      if (state === 'free') this.onFree(w.target);
      return this.notify(w.user.id, { ...payload, state });
    }
    if (this.now() + this.retryMs > w.until) {
      this.#watches.delete(id);
      return this.notify(w.user.id, { ...payload, state: 'expired' });
    }
    this.#schedule(id, w);
  }
}

/** The probe through the jump server: exit 0 = free; an absent `nc` (127) = unknown */
export function sshProbe({ pool, settings }) {
  return async (device, seconds = PROBE_SECONDS) => {
    const { host, port } = device.target;
    // Interpolated into a command line on the jump server: the same strict check as the console itself
    if (!HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid console target ${host}:${port}`);
    const { ssh } = settings.get('lab');
    let exit = null;
    let done;
    const closed = new Promise((resolve) => { done = resolve; });
    // Listeners go on in the pool's setup hook: the exit status may come with the channel's first packets
    const stream = await pool.exec(ssh, `nc -z -w ${seconds} ${host} ${port}`, {}, (s) => {
      s.on('exit', (c) => { exit = c; });
      s.on('close', () => done());
      s.resume?.();
      s.stderr?.resume?.();
    });
    const timer = setTimeout(() => { try { stream.close(); } catch { /* gone */ } }, (seconds + 5) * 1000);
    await closed;
    clearTimeout(timer);
    const code = exit;
    if (code === 0) return 'free';
    if (code === 1) return 'busy';
    return 'unknown';
  };
}
