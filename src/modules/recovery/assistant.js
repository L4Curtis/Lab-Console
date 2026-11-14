/**
 * The password recovery assistant: one recovery per device, run on the
 * server, step by step, each step confirmed by the person who started it
 * (SPEC "Lot recovery", ARCHITECTURE §9c)
 *
 * A recovery takes the device's console with room.runExclusive for its whole
 * length: nobody types into ROMMON or a boot loader behind its back, everyone
 * watching the console sees what it does, and the right of its actor to
 * drive the line is asked again before every byte (a lock or another team
 * taking the bench stops it). Inside, the procedures of
 * src/lib/drivers/ciscoRecovery.js run one at a time:
 *
 *   look       (at once) what the console shows decides where to begin
 *   then each step of the family's plan, only once the actor confirmed it:
 *     state 'awaiting' (awaiting: <step>) → POST /runs/:id/confirm { step } → 'running' → …
 *
 * A step that failed in a way the person can fix (a BREAK too late, Mode
 * released too early, nobody power-cycled) waits for its confirmation again;
 * any other failure ends the recovery ('failed', with the step, the code and
 * the end of the console output). Nobody confirming for `confirmMs` ends it
 * too (`recovery.abandoned`). Cancelling stops whatever is going on.
 *
 * Put back: from the step that bypasses the startup-config (confreg,
 * park_config, ignore_startup) until its restore step succeeds,
 * `facts.bypassed` says what is in place ('register' | 'parked' | 'ignore'),
 * saved with the row. A recovery that ends any other way than 'done' (stopped
 * by anyone or from the console tile, abandoned, refused mid-way, failed,
 * server shutdown) first undoes it (CiscoRecovery.putBack: state 'restoring',
 * a cancel then waits for it): in the same task while its actor may still
 * type, else as a 'system' task on the line (the bench locked or taken
 * mid-way, the line hung up). At shutdown nothing is booted (no time): the
 * register / file / variable only. What could not be put back ends the
 * recovery 'failed' with `recovery.left_<bypass>` and stays in the row
 * (`bypassed`); the next recovery of the device resumes at the restore step
 * when the device sits at its factory prompt (planFrom).
 *
 * Published: 'recovery:run' (the recovery, to those who may see it: its actor,
 * the occupants of the bench, the team that held the bench, admins) and
 * 'recovery:running' (sticky, everyone: which device is being recovered, by
 * whom, at which step). Saved through repos.recoveries at the start, after
 * every step and at the end; audited: recovery.start, recovery.confirm,
 * recovery.step, recovery.cancel, recovery.end.
 */
import { newId } from '../../lib/db/values.js';
import { CiscoRecovery, FAMILIES, STEPS, BYPASS, BYPASS_STEP, RESTORE_STEP, planFrom, scaledRecoveryTimeouts } from '../../lib/drivers/ciscoRecovery.js';

const FINAL = new Set(['done', 'failed', 'cancelled']);
const KEPT = 50;
const SHUTDOWN_MS = 8000; // what a stopping server gives the recoveries to put their device back

const personOf = (u) => ({ id: u.id, username: u.username ?? '', name: u.name || u.username || u.id });

/** A recovery stops here, with this code */
class Stop extends Error {
  constructor(r) {
    super(r?.message ?? 'stopped');
    this.code = r?.reason ?? r?.code ?? 'recovery.failed';
    this.params = r?.params ?? {};
    this.lastOutput = r?.lastOutput ?? null;
  }
}

export class RecoveryRunner {
  #all = new Map();       // id → recovery (running ones, and recent ones)
  #byDevice = new Map();  // device key → the running recovery

  /**
   * @param mayGoOn  (recovery) => boolean: may its actor still recover this device (asked before each step)
   * @param viewOf   (user, recovery) => boolean: may this user follow it
   * @param options  { timeouts, pollMs, now, shutdownMs }
   */
  constructor({ services, events, audit, repos, logger, mayGoOn = () => true, viewOf = () => false, options = {} }) {
    Object.assign(this, { services, events, audit, repos, log: logger, mayGoOn, viewOf });
    this.timeouts = options.timeouts ?? scaledRecoveryTimeouts(1);
    this.pollMs = options.pollMs ?? 250;
    this.now = options.now ?? (() => Date.now());
    this.shutdownMs = options.shutdownMs ?? SHUTDOWN_MS;
  }

  get(id) { return this.#all.get(id) ?? null; }
  running(deviceKey) { return this.#byDevice.get(deviceKey) ?? null; }

  /** The recoveries under way, as everyone may know them (no console output) */
  summary() {
    return [...this.#byDevice.values()].map((r) => ({ id: r.id, bench: r.bench, device: r.device, family: r.family, state: r.state, awaiting: r.awaiting, current: r.current, actor: { id: r.actor.id, name: r.actor.name } }));
  }

  /** Recent recoveries kept in memory, newest first */
  recent({ bench, device } = {}) {
    return [...this.#all.values()].filter((r) => (!bench || r.bench === bench) && (!device || r.device.key === device))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Start a recovery of `device` (the registry's device). The caller checked
   * who may; one recovery per device is checked here, synchronously
   */
  start({ actor, device, family, teamId = null }) {
    if (!FAMILIES[family]) return { refused: { status: 400, code: 'recovery.bad_family', message: 'Choose the family of the device.', params: {} } };
    const other = this.#byDevice.get(device.key);
    if (other) return { refused: { status: 409, code: 'recovery.busy', message: 'A recovery of this device is already under way.', params: { name: other.actor.name } } };
    const createdAt = new Date(this.now()).toISOString();
    const rec = {
      id: newId(),
      bench: device.labName,
      device: { key: device.key, name: device.name },
      family,
      actor: personOf(actor),
      teamId,
      state: 'starting',
      awaiting: null,
      current: null,
      progress: null,
      look: null,
      error: null,
      steps: STEPS[FAMILIES[family].method].map((id) => ({ id, state: 'pending', code: null, params: {}, at: null, tries: 0 })),
      facts: {},
      code: null,
      bypassed: null,
      putBack: null,
      createdAt,
      endedAt: null,
      cancelledBy: null,
      stoppedFrom: null,
      cause: null,
    };
    let ended;
    const hidden = { actorUser: actor, device, abort: new AbortController(), confirmed: null, cancelRequested: false, shutdown: false, ended: new Promise((resolve) => { ended = resolve; }), saved: Promise.resolve() };
    hidden.markEnded = ended;
    Object.defineProperty(rec, 'hidden', { value: hidden, enumerable: false });
    this.#all.set(rec.id, rec);
    this.#byDevice.set(device.key, rec);
    this.#trim();
    this.audit.log(actor, 'recovery.start', { bench: rec.bench, device: rec.device.name, family, recovery: rec.id });
    this.#save(rec);
    this.#publish(rec);
    queueMicrotask(() => this.#run(rec));
    return { recovery: rec };
  }

  /** The actor confirms the step the recovery waits for → null, or the refusal */
  confirm(rec, user, step) {
    if (FINAL.has(rec.state)) return { status: 409, code: 'recovery.over', message: 'This recovery is over.' };
    if (rec.actor.id !== user?.id) return { status: 403, code: 'recovery.confirm_forbidden', message: 'Only the person who started the recovery confirms its steps.' };
    if (rec.state !== 'awaiting' || rec.awaiting !== step) return { status: 409, code: 'recovery.not_awaiting', message: 'The recovery is not waiting for this step.', params: { step: rec.awaiting ?? '' } };
    rec.hidden.confirmed = step;
    this.audit.log(user, 'recovery.confirm', { bench: rec.bench, device: rec.device.name, recovery: rec.id, step });
    return null;
  }

  /**
   * Stop a recovery → null, or the refusal: over, or already stopping and
   * putting its device back (a cancel waits for that)
   */
  cancel(rec, user) {
    if (FINAL.has(rec.state)) return { status: 409, code: 'recovery.over', message: 'This recovery is over.' };
    if (rec.hidden.cancelRequested || rec.state === 'restoring') return { status: 409, code: 'recovery.putting_back', message: 'The recovery is stopping: it puts the device back first.' };
    rec.hidden.cancelRequested = true;
    rec.cancelledBy = user ? personOf(user) : null;
    this.audit.log(user ?? 'system', 'recovery.cancel', { bench: rec.bench, device: rec.device.name, recovery: rec.id, step: rec.current ?? rec.awaiting });
    rec.hidden.abort.abort();
    return null;
  }

  /**
   * At shutdown: stop every recovery; each puts its device's bypass back
   * without booting it, for `shutdownMs` at most (the consoles close too)
   */
  async shutdown() {
    const runs = [...this.#byDevice.values()];
    for (const rec of runs) {
      rec.hidden.shutdown = true;
      if (!rec.hidden.cancelRequested) this.cancel(rec, null);
    }
    if (!runs.length) return;
    let timer;
    await Promise.race([
      Promise.allSettled(runs.map((r) => r.hidden.ended)),
      new Promise((resolve) => { timer = setTimeout(resolve, this.shutdownMs); }),
    ]);
    clearTimeout(timer);
    await Promise.allSettled(runs.map((r) => r.hidden.saved));
  }

  // ── Running ───────────────────────────────────────────────────────────────

  async #run(rec) {
    const { actorUser: actor, device, abort } = rec.hidden;
    let room;
    try {
      room = this.services.consoles.rooms.open(device, actor, { task: true });
    } catch (err) {
      return this.#finish(rec, 'failed', { code: err.code ?? 'recovery.failed', params: err.params ?? {}, message: err.message });
    }
    const left = await this.#leftBefore(rec);
    let ending = null; // why it stopped (an error), null: done
    try {
      await room.runExclusive(actor, 'recovery', async (cli) => {
        const driver = this.#driver(rec, cli);
        try {
          await this.#steps(rec, driver, room, cli, left);
        } catch (err) {
          // Put the bypass back in this same task, while its actor may still type on this line
          if (rec.bypassed && !room.closed && room.canPilot(actor)) {
            ending = err;
            cli.resume();
            await this.#putBack(rec, driver);
          }
          throw err;
        }
      }, { signal: abort.signal });
    } catch (err) {
      ending = err;
    }
    // Else as a system task on the line: the actor lost the bench, or the line closed under it
    if (ending && rec.bypassed && !rec.putBack && !rec.hidden.shutdown) await this.#putBackAsSystem(rec);
    if (!ending) return this.#finish(rec, 'done', {});
    return this.#ended(rec, ending);
  }

  /** The plan, step by step, each confirmed */
  async #steps(rec, driver, room, cli, left) {
    const look = await this.#step(rec, 'look', () => driver.look({ screen: room.screen() }));
    if (!look.ok) throw new Stop(look);
    rec.look = { state: look.state, line: look.line };
    const plan = planFrom(rec.family, { ...rec.look, host: look.host }, { bypassed: left });
    if (!Array.isArray(plan)) throw new Stop(plan);
    // Resuming after an earlier recovery that left the device bypassed: it still is
    if (left && !plan.includes(BYPASS_STEP[this.#method(rec)])) this.#setBypass(rec, left);
    for (const s of rec.steps) if (s.id !== 'look' && !plan.includes(s.id)) s.state = 'skipped';
    for (let i = 0; i < plan.length;) {
      const id = plan[i];
      await this.#confirmation(rec, id, cli);
      if (!this.mayGoOn(rec)) throw new Stop({ reason: 'recovery.not_allowed', message: 'The bench is no longer yours: the recovery stops.' });
      // From the moment its command may reach the device, the bypass counts as in place
      if (id === BYPASS_STEP[this.#method(rec)]) this.#setBypass(rec, BYPASS[this.#method(rec)]);
      const r = await this.#step(rec, id, () => driver.run(id, rec.facts));
      if (r.ok) {
        Object.assign(rec.facts, factsOf(r));
        if (id === BYPASS_STEP[this.#method(rec)] && r.parked === false) this.#setBypass(rec, null); // no config.text: nothing set aside
        if (id === RESTORE_STEP[this.#method(rec)]) this.#setBypass(rec, null);
        i++;
        continue;
      }
      if (r.retry) continue; // the same step again, once the person is ready again
      throw new Stop(r);
    }
  }

  #method(rec) { return FAMILIES[rec.family].method; }

  #driver(rec, cli) {
    return new CiscoRecovery(cli, {
      family: rec.family,
      timeouts: this.timeouts,
      progress: (code, params = {}) => { rec.progress = { code, params }; this.#publish(rec); },
    });
  }

  #setBypass(rec, what) {
    rec.bypassed = what;
    rec.facts.bypassed = what;
    this.#save(rec);
  }

  /** What the last recovery of this device left in place (its row), or null */
  async #leftBefore(rec) {
    try {
      const rows = await this.repos.recoveries.list({ device: rec.device.key, limit: 5 });
      const last = rows.find((r) => r.id !== rec.id && r.family && FAMILIES[r.family]?.method === this.#method(rec));
      return last?.bypassed ?? null;
    } catch (err) {
      this.log.warn(`recovery ${rec.id}: the last recovery of ${rec.device.name} could not be read: ${err.message}`);
      return null;
    }
  }

  /** Undo the bypass (state 'restoring'); the outcome is kept in rec.putBack */
  async #putBack(rec, driver) {
    rec.state = 'restoring';
    rec.awaiting = null;
    rec.current = 'put_back';
    rec.progress = null;
    this.#publish(rec);
    let r;
    try {
      r = await driver.putBack(rec.bypassed, { boot: !rec.hidden.shutdown });
    } catch (err) {
      r = { ok: false, reason: `recovery.left_${rec.bypassed}`, params: { detail: err.message }, message: err.message, cause: err.code ?? null };
    }
    rec.current = null;
    rec.putBack = r.ok ? { ok: true, booted: Boolean(r.booted), at: r.at ?? null } : { ok: false, code: r.reason, params: r.params ?? {}, message: r.message, lastOutput: r.lastOutput ?? null };
    if (r.ok) this.#setBypass(rec, null);
    this.audit.log(rec.hidden.actorUser, 'recovery.put_back', { bench: rec.bench, device: rec.device.name, recovery: rec.id, ok: r.ok, code: r.ok ? null : r.reason });
    this.#publish(rec);
  }

  /** The put-back as a 'system' task: the actor may no longer type on this line, or the line closed */
  async #putBackAsSystem(rec) {
    const { actorUser: actor, device } = rec.hidden;
    try {
      const room = this.services.consoles.rooms.open(device, actor, { task: true });
      await room.runExclusive('system', 'recovery: put back', (cli) => this.#putBack(rec, this.#driver(rec, cli)));
    } catch (err) {
      if (!rec.putBack) {
        rec.putBack = { ok: false, code: `recovery.left_${rec.bypassed}`, params: { detail: err.message }, message: err.message, lastOutput: null };
        this.#publish(rec);
      }
    }
  }

  /** The recovery did not finish: how it ends, with what the put-back left */
  #ended(rec, err) {
    // The line freed from the console tile (by the pilot or an admin) is a stop too
    const freed = err.code === 'consoles.room_closed' && err.params?.reason === 'consoles.freed';
    const cancelled = err.cancelled || freed || (rec.hidden.abort.signal.aborted && err.code === 'automation.stopped');
    let state;
    let why;
    if (err instanceof Stop) {
      state = 'failed';
      why = { code: err.code, params: err.params, message: err.message, lastOutput: err.lastOutput };
    } else if (err.code === 'consoles.control_not_allowed') {
      // The bench was locked or taken in the middle of a step: its next byte was refused
      state = 'failed';
      why = { code: 'recovery.not_allowed', params: {}, message: 'The bench is no longer yours: the recovery stopped.' };
    } else if (cancelled) {
      state = 'cancelled';
      why = { code: 'recovery.cancelled' };
      if (!rec.hidden.cancelRequested) {
        // Stopped from the console tile (its task Stop, or the line hung up by the pilot or an admin)
        rec.stoppedFrom = 'console';
        this.audit.log('system', 'recovery.cancel', { bench: rec.bench, device: rec.device.name, recovery: rec.id, step: rec.steps.find((s) => s.state === 'cancelled')?.id ?? null, from: 'console' });
      }
    } else {
      state = 'failed';
      if (!err.code) this.log.warn(`recovery ${rec.id}: ${err.stack || err.message}`);
      why = { code: err.code ?? 'recovery.failed', params: err.params ?? {}, message: err.message };
    }
    if (rec.bypassed) {
      // Not put back: that is what the person must know first; the reason it stopped comes with it
      const p = rec.putBack && !rec.putBack.ok ? rec.putBack : { code: `recovery.left_${rec.bypassed}`, params: { detail: '' }, message: null, lastOutput: null };
      rec.cause = { code: why.code, params: why.params ?? {} };
      return this.#finish(rec, 'failed', { code: `recovery.left_${rec.bypassed}`, params: { detail: '', ...p.params }, message: p.message, lastOutput: p.lastOutput ?? why.lastOutput ?? null, replace: true });
    }
    return this.#finish(rec, state, why);
  }

  /** Wait for the actor to confirm `id`; nobody for `confirmMs` ends the recovery */
  async #confirmation(rec, id, cli) {
    rec.state = 'awaiting';
    rec.awaiting = id;
    rec.current = null;
    rec.progress = null;
    rec.hidden.confirmed = null;
    this.#publish(rec);
    const deadline = this.now() + this.timeouts.confirmMs;
    while (rec.hidden.confirmed !== id) {
      if (this.now() > deadline) throw new Stop({ reason: 'recovery.abandoned', message: 'Nobody confirmed the next step: the recovery stopped.', params: { step: id } });
      await cli.pause(this.pollMs); // rejects at once when the recovery is cancelled
    }
    rec.awaiting = null;
  }

  /** One step: its state, its outcome, saved, audited, published */
  async #step(rec, id, fn) {
    const step = rec.steps.find((s) => s.id === id);
    Object.assign(step, { state: 'running', code: null, params: {}, at: new Date(this.now()).toISOString() });
    step.tries++;
    rec.state = 'running';
    rec.current = id;
    rec.error = null;
    this.#publish(rec);
    let r;
    try {
      r = await fn();
    } catch (err) {
      Object.assign(step, { state: err.cancelled ? 'cancelled' : 'failed', code: err.cancelled ? 'recovery.cancelled' : err.code ?? 'recovery.failed' });
      throw err;
    }
    if (r.ok) {
      Object.assign(step, { state: 'done', result: publicResult(r) });
    } else {
      Object.assign(step, { state: 'failed', code: r.reason, params: r.params ?? {} });
      rec.error = { code: r.reason, params: r.params ?? {}, message: r.message, retry: Boolean(r.retry), lastOutput: r.lastOutput ?? null, step: id };
    }
    rec.current = null;
    this.audit.log(rec.hidden.actorUser, 'recovery.step', { bench: rec.bench, device: rec.device.name, recovery: rec.id, step: id, ok: r.ok, code: r.ok ? null : r.reason });
    this.#save(rec);
    this.#publish(rec);
    return r;
  }

  #finish(rec, state, { code = null, params = {}, message = null, lastOutput = null, replace = false }) {
    rec.state = state;
    rec.awaiting = null;
    rec.current = null;
    rec.progress = null;
    rec.code = state === 'done' ? null : code;
    if (state !== 'done' && (replace || !rec.error || rec.error.code !== code)) rec.error = { code, params, message, retry: false, lastOutput, step: rec.error?.step ?? null };
    if (state !== 'done' && rec.error) rec.error.retry = false;
    for (const s of rec.steps) if (s.state === 'pending') s.state = state === 'done' ? 'skipped' : 'not_run';
    rec.endedAt = new Date(this.now()).toISOString();
    if (this.#byDevice.get(rec.device.key) === rec) this.#byDevice.delete(rec.device.key);
    this.#save(rec);
    this.audit.log(rec.hidden.actorUser ?? 'system', 'recovery.end', {
      bench: rec.bench, device: rec.device.name, recovery: rec.id, family: rec.family, state, code: rec.code, cause: rec.cause?.code ?? null,
      putBack: rec.putBack ? rec.putBack.ok : null, bypassed: rec.bypassed,
      steps: rec.steps.filter((s) => s.state !== 'not_run' && s.state !== 'skipped').map((s) => `${s.id}:${s.state}`).join(' '),
    });
    try { this.services.benches?.touch?.(rec.bench); } catch { /* the bench went away */ }
    this.#publish(rec);
    rec.hidden.markEnded();
  }

  #save(rec) {
    rec.hidden.saved = this.repos.recoveries.save(record(rec)).catch((err) => this.log.warn(`recovery ${rec.id} not recorded: ${err.message}`));
  }

  #publish(rec) {
    this.events.publish('recovery:run', publicRecovery(rec), { audience: (u) => this.viewOf(u, rec) });
    this.events.publish('recovery:running', this.summary(), { sticky: true });
  }

  #trim() {
    const done = [...this.#all.values()].filter((r) => FINAL.has(r.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.#all.size > KEPT && done.length) this.#all.delete(done.shift().id);
  }
}

/** What a step found that later steps need (a switch whose config.text was parked) */
function factsOf(r) {
  return 'parked' in r ? { parked: r.parked } : {};
}

/** A step's result for the report: facts, never the console output */
function publicResult(r) {
  const out = {};
  for (const k of ['state', 'line', 'breaks', 'register', 'next', 'host', 'seconds', 'parked', 'earlier', 'restored']) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

/** The recovery as it is sent and returned (no hidden part) */
export function publicRecovery(rec) {
  const { facts: _facts, ...rest } = rec;
  return { ...rest, steps: rec.steps.map((s) => ({ ...s })) };
}

/** What the database keeps */
function record(rec) {
  return {
    id: rec.id, bench: rec.bench, device: rec.device, family: rec.family, actor: rec.actor, teamId: rec.teamId, state: rec.state,
    steps: rec.steps.map(({ id, state, code, params, at, tries, result }) => ({ id, state, code, params, at, tries, ...(result ? { result } : {}) })),
    code: rec.code, bypassed: rec.bypassed ?? null, createdAt: rec.createdAt, endedAt: rec.endedAt,
  };
}
