/**
 * A console room: one console line, owned by the server, shared by everyone
 * who opens that device.
 *
 * A console server port takes one telnet client at a time, so two students
 * opening R1 used to get "line busy" for the second one. The line now belongs
 * to the server: the room holds the ConsoleSession (the SSH → telnet
 * transport) and any number of browsers attach to it. Everyone sees the same
 * output (with the last ~200 KB replayed on arrival); one person holds the
 * keyboard, the **pilot**; the others are **spectators**.
 *
 *   room.attach(client)        client: { user, send(msg), sendBytes(buf), close(), readOnly? } → detach()
 *   room.write(user, data)     ignored (false) unless the user may type now
 *   room.requestControl(user) / grantControl(to, by) / denyControl(to, by) / releaseControl(user)
 *   room.takeControl(admin)    / setShared(user, on) / hangUp(user)
 *   room.runExclusive(actor, label, async (cli) => …, { signal })   automation takes the keyboard
 *   room.summary()             what the live panel and the diagram show
 *   room.screen(maxBytes)      the end of the recent output, as text (a job's driver reads it first)
 *
 * Handover rule (SPEC "Lot rooms"), the same for a person and for a task:
 *   - nobody pilots → the requester gets the keyboard at once;
 *   - the pilot has not typed for `pilotIdleMs` (2 min) → at once, too;
 *   - otherwise the pilot is asked; no answer within `controlTimeoutMs`
 *     (30 s) → it passes anyway; "deny" keeps it (a task then rejects with
 *     `consoles.control_refused`);
 *   - an admin may take it at once; the pilot may release it or hand it to
 *     someone, and may switch to a shared keyboard (every attached person who
 *     may pilot can type).
 * Who may pilot is decided by `canPilot(user)` (the bench rule of the teams
 * lot, through the module's single call site); everyone else watches. A
 * person attached only through read-only clients (bench wall tiles) never
 * drives: neither pilot nor typist on a shared keyboard.
 *
 * The line stays open while someone is attached, `graceMs` (30 s) after the
 * last one leaves, at most `idleTimeoutMs` (60 min) without input; "free the
 * line" hangs up at once (while a task holds the line, only its actor, the
 * pilot or an admin may: the same people who may stop the task).
 *
 * Events: 'change' (presence, control, task, state), 'activity' ({ kind, user, detail }), 'close' (info)
 */
import { EventEmitter } from 'node:events';
import { DEFAULT_TYPING } from '../../lib/cliAutomation.js';

const DEFAULTS = {
  scrollbackBytes: 200 * 1024,
  graceMs: 30_000,
  controlTimeoutMs: 30_000,
  pilotIdleMs: 2 * 60_000,
  idleTimeoutMs: 60 * 60_000,
  // What a person types or pastes reaches the device in small chunks, like an injection does: a long
  // line pasted at once would overrun the input buffer of a slow console. Beyond `typeQueueBytes` waiting, input is refused
  typeChunkChars: DEFAULT_TYPING.chunkBytes,
  typeChunkDelayMs: DEFAULT_TYPING.chunkDelayMs,
  typeQueueBytes: 64 * 1024,
};

// A completed line on screen that is a prompt followed by what was typed: R1#show run, S1(config-if)#no shut
const PROMPT_LINE = /^[A-Za-z0-9][\w.-]{0,62}(?:\([\w.-]{1,40}\))?[>#] ?(\S.*)$/;

/** An error with the code and params the browser translates */
export class RoomError extends Error {
  constructor(message, code, params = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

/** `text` in pieces of at most `size` characters, never cutting a surrogate pair */
function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const who = (u) => (u ? { id: u.id, name: u.name || u.username || u.id, initials: u.initials ?? '', color: u.color ?? '' } : null);
const SYSTEM = Object.freeze({ id: 'system', name: 'Lab Console', initials: 'LC', color: '' });

export class ConsoleRoom extends EventEmitter {
  #clients = new Set();
  #people = new Map();     // userId → { user, clients, since, lastInput, readOnly }
  #pilot = null;           // userId
  #pilotSince = 0;
  #shared = false;
  #pending = null;         // { from: User | SYSTEM, kind: 'human' | 'task', label, until, timer, resolve, reject }
  #task = null;            // { label, actor, state: 'waiting' | 'running' }
  #scroll = [];
  #scrollBytes = 0;
  #graceTimer = null;
  #closed = false;
  #echo = { line: '', crAt: 0 };
  #typing = { queue: [], bytes: 0, timer: null }; // chunks of a long input still to reach the device, in order

  /**
   * @param device    the registry's device: { key, name, labName, target }
   * @param session   a ConsoleSession, started by the caller
   * @param canPilot  (user) => boolean
   * @param journal   a JournalWriter (or null)
   * @param options   timings and sizes, see DEFAULTS
   * @param now       clock
   */
  constructor({ device, session, canPilot = () => true, journal = null, options = {}, now = () => Date.now(), logger }) {
    super();
    this.device = device;
    this.key = `${device.target.host}:${device.target.port}`;
    this.session = session;
    this.canPilot = (user) => {
      try { return Boolean(user && canPilot(user)); } catch { return false; }
    };
    this.journal = journal;
    this.options = { ...DEFAULTS, ...options };
    this.now = now;
    this.log = logger ?? { info() {}, warn() {}, debug() {} };
    this.since = now();
    this.lastCommand = null;
    this.lastActivity = now();

    session.on('data', (buf) => this.#onOutput(buf));
    session.on('status', (s) => { this.#broadcast({ type: 'status', ...s }); this.#changed(); });
    session.on('close', (info) => this.#onClosed(info));
  }

  get cli() { return this.session.cli; }
  get pilot() { return this.#pilot; }
  get shared() { return this.#shared; }
  get task() { return this.#task ? { label: this.#task.label, by: this.#task.actor, state: this.#task.state } : null; }
  get closed() { return this.#closed; }
  /** The recent output a newcomer is replayed (the last ~200 KB), as bytes */
  get scrollback() { return Buffer.concat(this.#scroll); }
  /**
   * The end of what the console printed lately (the scrollback), as text: a
   * job hands it to the driver's prepare() so that it reads the screen
   * before typing anything (a "[confirm]" left on screen must not get an Enter)
   */
  screen(maxBytes = 4096) {
    const all = this.scrollback;
    // As the automation engine reads the console: no escape sequences, no carriage returns
    return all.subarray(Math.max(0, all.length - maxBytes)).toString('latin1')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\x1b[=>]/g, '').replace(/[\r\0\x07]/g, '');
  }

  /** People attached (one entry per user, whatever their number of tabs) */
  get users() { return [...this.#people.values()].map((p) => p.user); }
  /** Users counted against their per-user limit (a bench wall tile does not count) */
  isAttached(userId, { countReadOnly = true } = {}) {
    const p = this.#people.get(userId);
    return Boolean(p && (countReadOnly || p.counted > 0));
  }

  // ── Attaching ─────────────────────────────────────────────────────────────

  /** Attach a browser; returns the function that detaches it */
  attach(client) {
    if (this.#closed) throw new RoomError('This console has just closed.', 'consoles.room_closed');
    const { user } = client;
    clearTimeout(this.#graceTimer);
    this.#graceTimer = null;
    this.#clients.add(client);
    let p = this.#people.get(user.id);
    const first = !p;
    if (!p) {
      p = { user, clients: 0, counted: 0, since: this.now(), lastInput: 0 };
      this.#people.set(user.id, p);
    }
    p.user = user; // the latest copy (a name change)
    p.clients++;
    if (!client.readOnly) p.counted++;
    // The journal's read rights come from being on the line as someone who may drive it; a
    // spectator (a wall tile, an outsider watching an open line) is named for display only
    if (!client.readOnly && this.canPilot(user)) this.journal?.attended(user);
    else this.journal?.watched?.(user);

    // What a newcomer needs before the live stream: where the line stands, then the recent output
    if (this.session.lastStatus) client.send({ type: 'status', ...this.session.lastStatus });
    const replay = Buffer.concat(this.#scroll);
    client.send({ type: 'replay', bytes: replay.length });
    if (replay.length) client.sendBytes(replay);

    // An unowned line goes to the first person who may drive it
    if (!this.#pilot && !this.#task && !client.readOnly && this.canPilot(user)) this.#setPilot(user, 'free', null, { quiet: true });
    if (first) this.#activity(this.#people.size === 1 && !this.#everAttached ? 'open' : 'join', user);
    this.#everAttached = true;
    this.#changed();

    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#detach(client);
    };
  }

  #everAttached = false;

  #detach(client) {
    this.#clients.delete(client);
    const { user } = client;
    const p = this.#people.get(user.id);
    if (p) {
      p.clients--;
      if (!client.readOnly) p.counted--;
      if (p.clients <= 0) {
        this.#people.delete(user.id);
        if (this.#pending?.from.id === user.id) this.#clearPending('cancelled');
        if (this.#pilot === user.id) this.#passOn('left', user);
        this.#activity('leave', user);
      } else if (!client.readOnly && p.counted <= 0) {
        // Only a wall tile left: that person watches now, they no longer drive
        if (this.#pending?.from.id === user.id && this.#pending.kind === 'human') this.#clearPending('cancelled');
        if (this.#pilot === user.id) this.#passOn('left', user);
      }
    }
    this.#armGrace();
    this.#changed();
  }

  /**
   * Nobody attached (the last one left, or a job ran on a line nobody
   * watched): keep the line a moment (a page reload, a flaky network), then hang up
   */
  #armGrace() {
    if (this.#clients.size || this.#closed || this.#task) return;
    clearTimeout(this.#graceTimer);
    this.#graceTimer = setTimeout(() => {
      if (!this.#clients.size && !this.#task) this.close('Nobody is on the console any more', { code: 'consoles.browser_gone' });
    }, this.options.graceMs);
    this.#graceTimer.unref?.();
  }

  // ── The keyboard ──────────────────────────────────────────────────────────

  /**
   * May `user` type right now? Asked at every keystroke: the pilot keeps the
   * keyboard only while the bench rule still lets them drive (an admin locks
   * the bench, another team takes it: they watch from then on)
   */
  mayType(user) {
    if (this.#closed || !user) return false;
    if (this.#task?.state === 'running') return false;
    if (this.#pilot === user.id) return this.canPilot(user);
    return this.#shared && this.#mayDrive(user);
  }

  /**
   * Keystrokes of `user`: ignored unless they hold the keyboard (or it is shared).
   * A keystroke or a short text goes straight to the device; a long one (a pasted line) is cut in
   * chunks sent `typeChunkDelayMs` apart, what a slow console's input buffer can swallow. The rest
   * is dropped if the person stops being allowed to type meanwhile (a task starts, the keyboard
   * moves, a break is sent). → false when nothing was accepted
   */
  write(user, data) {
    if (typeof data !== 'string' || !this.mayType(user)) return false;
    const p = this.#people.get(user.id);
    if (p) p.lastInput = this.now();
    this.lastActivity = this.now();
    const chunks = chunksOf(data, this.options.typeChunkChars);
    const t = this.#typing;
    if (chunks.length <= 1 && !t.timer) return this.#put(data);
    if (t.bytes + data.length > this.options.typeQueueBytes) return false;
    for (const chunk of chunks) t.queue.push({ user, chunk });
    t.bytes += data.length;
    if (!t.timer) this.#drainTyping();
    return true;
  }

  #put(data) {
    if (data.includes('\r')) this.#echo.crAt = this.now();
    return this.session.write(data) !== false;
  }

  #drainTyping() {
    const t = this.#typing;
    const next = t.queue.shift();
    t.timer = null;
    if (!next) { t.bytes = 0; return; }
    t.bytes -= next.chunk.length;
    if (!this.mayType(next.user)) { this.#clearTyping(); return; }
    this.#put(next.chunk);
    t.timer = setTimeout(() => this.#drainTyping(), this.options.typeChunkDelayMs);
    t.timer.unref?.();
  }

  #clearTyping() {
    clearTimeout(this.#typing.timer);
    this.#typing = { queue: [], bytes: 0, timer: null };
  }

  /** The terminal size follows the pilot's window */
  resize(user, cols, rows) {
    if (this.#pilot !== user?.id && !(this.#people.size === 1 && this.#people.has(user?.id))) return false;
    this.session.resize(cols, rows);
    return true;
  }

  sendBreak(user) {
    if (!this.mayType(user)) return false;
    this.#clearTyping();
    this.session.sendBreak();
    return true;
  }

  // ── Control ───────────────────────────────────────────────────────────────

  /** → { ok, code?, params?, pending? } */
  requestControl(user) {
    if (this.#closed) return refusal('consoles.room_closed');
    if (!this.canPilot(user)) return refusal('consoles.control_not_allowed', { name: this.device.name });
    if (this.#watchesOnly(user)) return refusal('consoles.wall_read_only');
    if (this.#pilot === user.id) return { ok: true };
    if (this.#task) return refusal('consoles.task_running', { task: this.#task.label });
    if (!this.#pilot) { this.#setPilot(user, 'free'); return { ok: true }; }
    if (this.#pilotIdle()) { this.#setPilot(user, 'idle'); return { ok: true }; }
    if (this.#pending?.from.id === user.id) return { ok: true, pending: true };
    if (this.#pending) return refusal('consoles.control_pending', { name: this.#pending.from.name });
    this.#ask(user, 'human');
    return { ok: true, pending: true };
  }

  /** The pilot (or an admin) gives the keyboard to `to` (a user id or a User) */
  grantControl(to, by) {
    const toId = typeof to === 'string' ? to : to?.id;
    if (!this.#isPilotOrAdmin(by)) return refusal('consoles.control_not_pilot');
    if (!toId) return refusal('consoles.control_no_request');
    if (this.#pending && this.#pending.from.id === toId) {
      const pending = this.#pending;
      this.#clearPending(null);
      return this.#hand(pending, 'granted', by);
    }
    const target = this.#people.get(toId)?.user;
    if (!target) return refusal('consoles.control_gone'); // the requester left before the answer
    if (!this.#mayDrive(target)) return refusal('consoles.control_not_allowed', { name: this.device.name });
    this.#setPilot(target, 'granted', by);
    return { ok: true };
  }

  /** The pilot (or an admin) says no to the pending request */
  denyControl(to, by) {
    const toId = typeof to === 'string' ? to : to?.id;
    if (!this.#isPilotOrAdmin(by)) return refusal('consoles.control_not_pilot');
    if (!this.#pending || (toId && this.#pending.from.id !== toId)) return refusal('consoles.control_no_request');
    const pending = this.#pending;
    this.#clearPending(null);
    this.#control('denied', by, pending.from);
    pending.reject?.(new RoomError(`${who(by).name} kept the keyboard of ${this.device.name}`, 'consoles.control_refused', { name: who(by).name }));
    this.#changed();
    return { ok: true };
  }

  /** The pilot lets go: to whoever asked, or to nobody */
  releaseControl(user) {
    if (this.#pilot !== user?.id) return refusal('consoles.control_not_pilot');
    this.#passOn('released', user);
    this.#changed();
    return { ok: true };
  }

  /** An admin takes the keyboard at once */
  takeControl(user) {
    if (user?.role !== 'admin') return refusal('consoles.control_admin_only');
    if (this.#watchesOnly(user)) return refusal('consoles.wall_read_only');
    if (this.#task?.state === 'running') return refusal('consoles.task_running', { task: this.#task.label });
    if (this.#pending?.kind === 'human') this.#clearPending('cancelled');
    this.#setPilot(user, 'takeover', user);
    return { ok: true };
  }

  /** The pilot opens the keyboard to everyone who may pilot, or closes it again */
  setShared(user, on) {
    if (!this.#isPilotOrAdmin(user)) return refusal('consoles.control_not_pilot');
    this.#shared = Boolean(on);
    this.#control(on ? 'shared' : 'unshared', user, null);
    this.#activity('control', user, { event: on ? 'shared' : 'unshared' });
    this.#changed();
    return { ok: true };
  }

  /**
   * "Free the line": the pilot, an admin, or anyone who may drive an unowned
   * line. While a task holds the line, the rule of cancelTask applies: its
   * actor, the pilot or an admin, nobody else (a bystander must not cut an
   * erase-and-reload in half)
   */
  hangUp(user) {
    if (this.#closed) return refusal('consoles.room_closed');
    if (this.#task) {
      const allowed = this.#isPilotOrAdmin(user) || (Boolean(user) && user.id === this.#task.actor.id);
      if (!allowed) return refusal('consoles.task_running', { task: this.#task.label });
    } else if (!(this.#isPilotOrAdmin(user) || (!this.#pilot && this.#mayDrive(user)))) {
      return refusal('consoles.control_not_pilot');
    }
    this.#activity('freed', user);
    this.close(`${who(user).name} freed the line of ${this.device.name}`, { code: 'consoles.freed', params: { name: who(user).name, device: this.device.name } });
    return { ok: true };
  }

  // ── Automation ────────────────────────────────────────────────────────────

  /**
   * Run `fn(cli)` as the one task holding this line's keyboard. `actor` is a
   * User (a person exporting a config) or 'system' (a bench job).
   *   - refused at once when the room is closed, a task already runs, or the
   *     actor may not pilot (spectators): codes consoles.room_closed,
   *     consoles.task_running, consoles.control_not_allowed;
   *   - the actor's right to pilot is asked again once the keyboard is
   *     obtained, once the line is ready, and before every byte the task
   *     sends: a bench locked (or taken by another team, or the account
   *     disabled) meanwhile stops it with consoles.control_not_allowed, and
   *     nothing more reaches the device;
   *   - otherwise the keyboard is obtained with the handover rule; a pilot's
   *     "deny" rejects with consoles.control_refused;
   *   - then it waits until the line is ready (console server login done),
   *     locks every keyboard and runs `fn` inside cli.perform();
   *   - `signal` (AbortSignal) or cancelTask() stops it at any point: waiting
   *     for the pilot, waiting for the line, or inside `fn` (steps reject with
   *     err.cancelled);
   *   - afterwards a person keeps the keyboard; a system task gives it back.
   */
  async runExclusive(actor, label, fn, { signal } = {}) {
    const user = actor === 'system' || !actor ? null : actor;
    if (this.#closed) throw new RoomError('This console has closed.', 'consoles.room_closed');
    if (this.#task || this.cli.running) throw new RoomError(`Another task (${this.#task?.label ?? this.cli.running}) holds this console.`, 'consoles.task_running', { task: this.#task?.label ?? this.cli.running });
    if (user && !this.canPilot(user)) throw new RoomError(`You may watch ${this.device.name}, not drive it.`, 'consoles.control_not_allowed', { name: this.device.name });
    if (signal?.aborted) throw cancelled();

    const task = { label: String(label), actor: user ? who(user) : SYSTEM, state: 'waiting', abort: null };
    this.#task = task;
    const before = this.#pilot;
    const onAbort = () => task.abort?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#activity('task', user, { label: task.label, state: 'start' });
    this.#changed();
    let outcome = 'done';
    let obtained = false;
    const mayGoOn = () => !user || this.canPilot(user);
    const notAllowed = () => new RoomError(`You may watch ${this.device.name}, not drive it.`, 'consoles.control_not_allowed', { name: this.device.name });
    try {
      await this.#cancellable(task, this.#obtain(task, user));
      obtained = true;
      if (!mayGoOn()) throw notAllowed();
      await this.#cancellable(task, this.session.ready);
      if (this.#closed) throw new RoomError('This console has closed.', 'consoles.room_closed');
      if (!mayGoOn()) throw notAllowed();
      task.state = 'running';
      this.#clearTyping();
      task.abort = () => this.cli.cancel();
      this.journal?.mark(`task ${task.label} by ${task.actor.name}`);
      this.#changed();
      try {
        return await this.cli.perform(task.label, (cli) => fn(cli), { allowed: mayGoOn });
      } catch (err) {
        // Stopped because the actor lost the right to drive, not by a Stop
        if (err.cancelled && !mayGoOn()) throw Object.assign(notAllowed(), { cause: err });
        throw err;
      }
    } catch (err) {
      // The line went away under the task (dropped, freed, timed out): not a user's Stop
      if (this.#closed) {
        outcome = 'failed';
        throw Object.assign(new RoomError(`The console of ${this.device.name} closed during the task: ${this.#closeReason}`, 'consoles.room_closed', { name: this.device.name, reason: this.#closeCode }), { cause: err });
      }
      outcome = err.cancelled ? 'cancelled' : 'failed';
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.#pending?.kind === 'task') this.#clearPending(null);
      this.#task = null;
      if (!this.#closed && obtained) {
        // A person who asked for the keyboard keeps it; a system task gives it back
        const previous = this.#people.get(before)?.user;
        const next = user && this.#mayDrive(user) ? user : (this.#mayDrive(previous) ? previous : null);
        if (next && next.id !== this.#pilot) this.#setPilot(next, user ? 'task' : 'returned', null, { quiet: !user });
        else if (!next && this.#pilot && !this.#people.has(this.#pilot)) this.#passOn('left', null);
      }
      this.#activity('task', user, { label: task.label, state: outcome });
      this.#armGrace();
      this.#changed();
    }
  }

  /** Stop the running (or waiting) task: its actor, the pilot, or an admin */
  cancelTask(user) {
    if (!this.#task) return refusal('consoles.no_task');
    const allowed = user === 'system' || user?.role === 'admin' || user?.id === this.#task.actor.id || user?.id === this.#pilot;
    if (!allowed) return refusal('consoles.control_not_pilot');
    this.#task.abort?.();
    return { ok: true };
  }

  // ── Life and death ────────────────────────────────────────────────────────

  /** Hang up: every attached browser gets the reason, the line is freed */
  close(reason = 'Session closed', info = { code: 'consoles.session_closed' }) {
    if (this.#closed) return;
    this.session.close(reason, null, info); // → #onClosed
  }

  /** Close when nobody typed for idleTimeoutMs; returns true when it did */
  closeIfIdle() {
    if (this.#closed || this.#task) return false;
    if (this.now() - Math.max(this.session.lastActivity ?? 0, this.lastActivity) <= this.options.idleTimeoutMs) return false;
    const minutes = Math.round(this.options.idleTimeoutMs / 60_000);
    this.close(`Closed after ${minutes} minutes without input - ${this.device.name}'s console is free again`,
      { code: 'consoles.idle_timeout', params: { minutes, name: this.device.name } });
    return true;
  }

  /** What the live panel, the diagram and other modules see */
  summary() {
    const pilot = this.#people.get(this.#pilot)?.user;
    return {
      target: this.key,
      key: this.device.key,
      bench: this.device.labName,
      device: this.device.name,
      state: this.#closed ? 'closed' : this.session.phase ?? 'ssh',
      users: [...this.#people.values()].map((p) => ({ ...who(p.user), pilot: p.user.id === this.#pilot })),
      pilot: pilot ? who(pilot) : null,
      shared: this.#shared,
      task: this.task,
      since: new Date(this.since).toISOString(),
      lastActivity: new Date(Math.max(this.lastActivity, this.session.lastActivity ?? 0)).toISOString(),
      lastCommand: this.lastCommand,
    };
  }

  /** The presence frame for one browser */
  presence(user) {
    const pending = this.#pending;
    return {
      type: 'presence',
      users: [...this.#people.values()].map((p) => ({ ...who(p.user), role: p.user.role, canPilot: this.canPilot(p.user), readOnly: p.counted === 0 })),
      pilot: this.#pilot,
      you: user.id,
      canPilot: this.canPilot(user),
      mayType: this.mayType(user),
      shared: this.#shared,
      task: this.task,
      pending: pending ? { from: who(pending.from), kind: pending.kind, label: pending.label ?? null, until: new Date(pending.until).toISOString() } : null,
      state: this.#closed ? 'closed' : this.session.phase ?? 'ssh',
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** An admin, or the pilot while the bench rule still lets them drive */
  #isPilotOrAdmin(user) {
    return Boolean(user) && (user.role === 'admin' || (this.#pilot === user.id && this.canPilot(user)));
  }

  /** Attached only through read-only clients (bench wall tiles) */
  #watchesOnly(user) {
    const p = this.#people.get(user?.id);
    return Boolean(p) && p.counted <= 0;
  }

  /** May drive this line now: may pilot, and attached through a client with a keyboard */
  #mayDrive(user) {
    const p = this.#people.get(user?.id);
    return Boolean(p) && p.counted > 0 && this.canPilot(user);
  }

  #pilotIdle() {
    const p = this.#people.get(this.#pilot);
    if (!p) return true;
    return this.now() - Math.max(p.lastInput, this.#pilotSince) >= this.options.pilotIdleMs;
  }

  /** Ask the pilot on behalf of `from`; the answer (or the clock) settles it */
  #ask(from, kind, label = null) {
    const pending = { from: from ?? SYSTEM, kind, label, until: this.now() + this.options.controlTimeoutMs, timer: null, resolve: null, reject: null };
    const promise = kind === 'task' ? new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; }) : null;
    // Not unref'd: a task may be waiting on it (the timer is cleared when the room closes)
    pending.timer = setTimeout(() => {
      if (this.#pending !== pending) return;
      this.#clearPending(null);
      this.#hand(pending, 'timeout', null);
    }, this.options.controlTimeoutMs);
    this.#pending = pending;
    this.#control('request', pending.from, who(this.#people.get(this.#pilot)?.user), { until: new Date(pending.until).toISOString(), label });
    this.#activity('control', from, { event: 'request' });
    this.#changed();
    return promise;
  }

  /** A request was answered yes (or by the clock): a person gets the keyboard, a task goes on */
  #hand(pending, event, by) {
    if (pending.kind === 'task') {
      // A person's task goes on only while its actor may still drive (a bench locked during the wait)
      if (pending.from !== SYSTEM && !this.canPilot(pending.from)) {
        pending.reject?.(new RoomError(`You may watch ${this.device.name}, not drive it.`, 'consoles.control_not_allowed', { name: this.device.name }));
        this.#changed();
        return refusal('consoles.control_not_allowed', { name: this.device.name });
      }
      this.#control(event, by, pending.from, { label: pending.label });
      pending.resolve?.();
      this.#changed();
      return { ok: true };
    }
    const person = this.#people.get(pending.from.id)?.user;
    if (!person || !this.#mayDrive(person)) return refusal('consoles.control_gone');
    this.#setPilot(person, event, by);
    return { ok: true };
  }

  /** The task's way to the keyboard: free, idle pilot, the actor already, or ask */
  #obtain(task, user) {
    if (!this.#pilot || this.#pilot === user?.id || this.#pilotIdle()) return Promise.resolve();
    if (this.#pending) this.#clearPending('superseded'); // a task does not queue behind a person's request
    return this.#ask(user ?? SYSTEM, 'task', task.label);
  }

  /** Race `promise` with the task's cancellation */
  #cancellable(task, promise) {
    return new Promise((resolve, reject) => {
      task.abort = () => reject(cancelled());
      promise.then(resolve, reject);
    });
  }

  #clearPending(event) {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    if (event) {
      this.#control(event, null, pending.from);
      pending.reject?.(cancelled());
    }
  }

  #setPilot(user, event, by, { quiet = false } = {}) {
    const changed = this.#pilot !== user.id;
    this.#pilot = user.id;
    this.#pilotSince = this.now();
    if (this.#pending?.from.id === user.id && this.#pending.kind === 'human') this.#clearPending(null);
    this.journal?.piloted(user);
    if (changed) this.journal?.mark(`keyboard: ${who(user).name}${user.username ? ` (${user.username})` : ''}`);
    if (!quiet) this.#control(event, by ? who(by) : null, who(user));
    if (!quiet) this.#activity('control', user, { event });
    this.#changed();
  }

  /** The pilot leaves or lets go: whoever asked gets it, else nobody */
  #passOn(event, from) {
    const pending = this.#pending;
    if (pending?.kind === 'human' && this.#mayDrive(this.#people.get(pending.from.id)?.user)) {
      this.#clearPending(null);
      return this.#hand(pending, event, from);
    }
    if (pending?.kind === 'task') {
      this.#clearPending(null);
      this.#pilot = null;
      return this.#hand(pending, event, from);
    }
    this.#pilot = null;
    this.#shared = false;
    this.#control(event, from ? who(from) : null, null);
    this.#changed();
    return { ok: true };
  }

  #control(event, by, to, extra = {}) {
    this.#broadcast({ type: 'control', event, by: by ? who(by) : null, to: to ? who(to) : null, ...extra });
  }

  /** `actor` is the full user, for the audit trail; the feed shows `user` */
  #activity(kind, user, detail = {}) {
    this.emit('activity', { kind, user: user ? who(user) : null, actor: user?.username !== undefined ? user : null, bench: this.device.labName, device: this.device.name, target: this.key, ...detail });
  }

  /** Presence for everyone, and a 'change' for the manager (coalesced) */
  #changed() {
    if (this.#changeQueued) return;
    this.#changeQueued = true;
    queueMicrotask(() => {
      this.#changeQueued = false;
      for (const c of this.#clients) safe(() => c.send(this.presence(c.user)));
      this.emit('change', this);
    });
  }

  #changeQueued = false;

  /** A frame for every browser on this console (automation progress) */
  broadcast(msg) {
    this.#broadcast(msg);
  }

  #broadcast(msg) {
    for (const c of this.#clients) safe(() => c.send(msg));
  }

  #onOutput(buf) {
    this.#scroll.push(buf);
    this.#scrollBytes += buf.length;
    while (this.#scrollBytes > this.options.scrollbackBytes && this.#scroll.length > 1) {
      this.#scrollBytes -= this.#scroll.shift().length;
    }
    for (const c of this.#clients) safe(() => c.sendBytes(buf));
    this.journal?.output(buf);
    this.#trackEcho(buf);
  }

  /** The last command, rebuilt from what the device echoed after an Enter */
  #trackEcho(buf) {
    const text = buf.toString('latin1').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    let line = this.#echo.line;
    for (const ch of text) {
      if (ch === '\n') {
        const m = PROMPT_LINE.exec(line.trim());
        if (m && this.now() - this.#echo.crAt < 5000 && this.#task?.state !== 'running') {
          this.lastCommand = m[1].trim().slice(0, 200);
          this.#activity('command', this.#people.get(this.#pilot)?.user ?? null, { command: this.lastCommand });
          this.#changed();
        }
        line = '';
      } else if (ch === '\r') {
        // carriage return: the line is rewritten from its start, keep it until the newline
      } else if (ch === '\b') {
        line = line.slice(0, -1);
      } else if (ch >= ' ') {
        line = (line + ch).slice(-400);
      }
    }
    this.#echo.line = line;
  }

  #closeReason = '';
  #closeCode = null;

  #onClosed({ reason, info }) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#closeCode = info?.code ?? 'consoles.session_closed';
    clearTimeout(this.#graceTimer);
    this.#clearTyping();
    this.cli.cancel();
    this.#task?.abort?.();
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject?.(new RoomError(reason, 'consoles.room_closed'));
      this.#pending = null;
    }
    const params = { name: this.device.name, ...(info?.params ?? {}) };
    const frame = { type: 'exit', message: reason, code: info?.code ?? 'consoles.session_closed', params };
    this.journal?.mark(`console closed: ${reason}`);
    this.journal?.close();
    for (const c of [...this.#clients]) {
      safe(() => c.send(frame));
      safe(() => c.close?.());
    }
    this.#clients.clear();
    this.#activity('close', null, { code: frame.code });
    this.emit('close', { reason, info: { code: frame.code, params } });
    this.emit('change', this);
  }
}

function refusal(code, params = {}) {
  return { ok: false, code, params };
}

function cancelled() {
  return Object.assign(new RoomError('Stopped', 'automation.stopped'), { cancelled: true });
}

function safe(fn) {
  try { fn(); } catch { /* a browser that went away mid-send */ }
}
