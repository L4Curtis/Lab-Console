/**
 * Every console room of the platform, keyed by console line ('host:port').
 * Replaces the upstream SessionManager: a second person opening a device now
 * joins its room instead of being told the line is busy.
 *
 *   rooms.get(targetKey) → ConsoleRoom | undefined
 *   rooms.list() → RoomSummary[]
 *   rooms.open(device, user, { cols, rows, readOnly }) → ConsoleRoom   creates or returns (throws RoomError)
 *   rooms.on('change', (summaries) => …) · rooms.on('activity', (entry) => …)
 *   rooms.busyOutside() → ['host:port', …]   lines the console server refused lately
 *
 * Limits (ARCHITECTURE §13: per user, not per address):
 *   - `maxSessions` lines open on the platform (joining an open line is free);
 *   - `maxSessionsPerClient` consoles per user (a bench wall tile, read-only,
 *     does not count).
 *
 * The lab connection parameters (jump server, console login, allowed hosts)
 * are read from the settings service at the moment a line is opened, so an
 * administrator's change applies to the next line without a restart.
 */
import { EventEmitter } from 'node:events';
import { ConsoleSession } from './consoleSession.js';
import { ConsoleRoom, RoomError } from './room.js';

const BUSY_MEMORY_MS = 15 * 60_000; // a refused line is shown "busy outside the app" this long, unless seen free

export const targetKey = (t) => `${t.host}:${t.port}`;

/** Is `target` inside the allowed console hosts and ports of these settings? */
export function targetAllowed(consoles, t) {
  return Boolean(consoles) && consoles.allowedHosts.includes(t.host) && Number.isInteger(t.port)
    && t.port >= consoles.portRange.min && t.port <= consoles.portRange.max;
}

export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #busy = new Map(); // target → time the console server refused it
  #sweep = null;
  #queued = false;

  /**
   * @param settings   the settings service (get('lab') → { ssh, telnet, consoles })
   * @param pool       SshPool shared by every line
   * @param limits     { maxSessions, maxSessionsPerClient, idleTimeoutMs }
   * @param canPilot   (user, device) => boolean: the single permission call
   * @param journal    ConsoleJournal or null
   * @param options    room timings ({ graceMs, controlTimeoutMs, pilotIdleMs, scrollbackBytes, silentMs })
   */
  constructor({ settings, pool, limits, canPilot = () => true, journal = null, options = {}, now = () => Date.now(), logger }) {
    super();
    this.settings = settings;
    this.pool = pool;
    this.limits = limits;
    this.canPilot = canPilot;
    this.journal = journal;
    this.options = options;
    this.now = now;
    this.log = logger ?? { info() {}, warn() {}, debug() {} };
    this.#sweep = setInterval(() => this.sweepIdle(), options.sweepMs ?? 30_000);
    this.#sweep.unref?.();
  }

  get(target) {
    return this.#rooms.get(target);
  }

  list() {
    return [...this.#rooms.values()].map((r) => r.summary());
  }

  get size() { return this.#rooms.size; }

  /** Consoles `user` is attached to (a read-only wall tile is not one) */
  countFor(userId) {
    let n = 0;
    for (const r of this.#rooms.values()) if (r.isAttached(userId, { countReadOnly: false })) n++;
    return n;
  }

  /**
   * May `user` open (or join) `device`? → { ok: true } | { ok: false, code, message, params }
   * Joining a line someone opened is always possible for a signed-in user
   * (to watch); opening a new line needs the right to pilot it.
   */
  canOpen(device, user, { readOnly = false } = {}) {
    const lab = this.settings.get('lab');
    if (!targetAllowed(lab.consoles, device.target)) {
      return { ok: false, code: 'consoles.not_allowed', params: { name: device.name }, message: `${device.name}'s console address is not on the platform's allow-list.` };
    }
    const room = this.#rooms.get(targetKey(device.target));
    if (!room) {
      if (readOnly) return { ok: false, code: 'consoles.room_gone', params: { name: device.name }, message: `Nobody has ${device.name}'s console open any more.` };
      if (!this.canPilot(user, device)) {
        return { ok: false, code: 'consoles.open_not_allowed', params: { name: device.name }, message: `${device.name} belongs to a bench taken by another team: you can watch its console once they open it.` };
      }
      if (this.#rooms.size >= this.limits.maxSessions) {
        return { ok: false, code: 'consoles.platform_full', params: {}, message: 'The platform has reached its maximum number of open consoles. Try again shortly.' };
      }
    }
    if (!readOnly && !room?.isAttached(user.id, { countReadOnly: false }) && this.countFor(user.id) >= this.limits.maxSessionsPerClient) {
      return { ok: false, code: 'consoles.client_full', params: { max: this.limits.maxSessionsPerClient }, message: `You can keep at most ${this.limits.maxSessionsPerClient} consoles open. Close one first.` };
    }
    return { ok: true };
  }

  /** The room of `device`, opened if needed (the caller attaches to it). Throws RoomError when refused */
  open(device, user, { cols, rows, readOnly = false } = {}) {
    const verdict = this.canOpen(device, user, { readOnly });
    if (!verdict.ok) throw new RoomError(verdict.message, verdict.code, verdict.params);
    const key = targetKey(device.target);
    const existing = this.#rooms.get(key);
    if (existing) return existing;

    const { ssh, telnet } = this.settings.get('lab'); // now, not at start-up: the admin may have changed them
    const session = new ConsoleSession({
      target: device.target, name: device.name, cols, rows, ssh, telnet, pool: this.pool, logger: this.log, silentMs: this.options.silentMs,
    });
    const room = new ConsoleRoom({
      device,
      session,
      canPilot: (u) => this.canPilot(u, device),
      journal: this.journal?.open({ bench: device.labName, device: device.name, target: key }) ?? null,
      options: { idleTimeoutMs: this.limits.idleTimeoutMs, ...this.options },
      now: this.now,
      logger: this.log,
    });
    this.#rooms.set(key, room);
    room.on('change', () => this.#changed());
    room.on('activity', (entry) => this.emit('activity', { ts: new Date(this.now()).toISOString(), ...entry }));
    session.on('status', (s) => {
      if (s.phase === 'connected' && this.#busy.delete(key)) this.#busyChanged();
    });
    room.on('close', ({ info }) => {
      if (this.#rooms.get(key) === room) this.#rooms.delete(key);
      if (info.code === 'consoles.line_refused') this.markBusy(key);
      this.log.info(`closed ${device.labName}/${device.name} (${info.code}) - ${this.#rooms.size} open`);
      this.#changed();
    });
    this.log.info(`opening ${device.labName}/${device.name} ${key} for ${user.id} - ${this.#rooms.size} open`);
    session.start();
    this.#changed();
    return room;
  }

  /** Lines the console server refused lately ("busy outside the app"), newest knowledge wins */
  busyOutside() {
    const now = this.now();
    for (const [k, at] of this.#busy) if (now - at > BUSY_MEMORY_MS) this.#busy.delete(k);
    return [...this.#busy.keys()];
  }

  markBusy(target) {
    this.#busy.set(target, this.now());
    this.#busyChanged();
  }

  markFree(target) {
    if (this.#busy.delete(target)) this.#busyChanged();
  }

  closeAll(reason, info) {
    for (const room of [...this.#rooms.values()]) room.close(reason, info);
  }

  sweepIdle() {
    for (const room of [...this.#rooms.values()]) room.closeIfIdle();
    if (this.#busy.size) {
      const before = this.#busy.size;
      this.busyOutside();
      if (this.#busy.size !== before) this.#busyChanged();
    }
  }

  shutdown(reason = 'Platform is restarting', info = { code: 'consoles.restarting' }) {
    clearInterval(this.#sweep);
    this.closeAll(reason, info);
  }

  #busyChanged() {
    this.emit('busy', this.busyOutside());
  }

  /** One 'change' per tick, however many rooms moved */
  #changed() {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      this.emit('change', this.list());
    });
  }
}
