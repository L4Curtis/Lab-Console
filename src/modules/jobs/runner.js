/**
 * Bench jobs: backup, injection, reset and comparison with the live devices
 * (SPEC "Lot jobs")
 *
 * A job covers some devices of one bench and runs on the server. For each
 * device it opens the console line (services.consoles.rooms.open), takes the
 * keyboard with room.runExclusive (the pilot is asked, everyone watching sees
 * the task, the actor's right to drive is asked again before every byte) and
 * runs the Cisco IOS driver on it. Five devices at a time; one job per bench.
 *
 * Nothing destructive without a backup, in this order, in code:
 *   1. prepare (privileged EXEC) and identify: a device that does not run
 *      Cisco IOS / IOS XE is left untouched (skipped);
 *   2. backup: running-config (and VLANs, VTP on a switch) written to the
 *      job's snapshot, indexed with its SHA-256; before an erase or an
 *      injection, the startup-config too whenever it is not the running one
 *      (a router at register 0x2141 ignores it: that is what an erase loses);
 *   3. the backup is read back from disk and checked against the index and
 *      against what was just read (eraseAndReload's verifyBackup);
 *   4. only then erase and reload. A device whose backup failed is not
 *      erased, unless an admin ticked it by hand (an 'override' proof that
 *      names them).
 *
 * An injection is saved (copy running-config startup-config) only when the
 * device took every line and, after a reset, reads back as the source: the
 * startup-config is never overwritten with half a configuration.
 *
 * Enable and console-line passwords come with the request, live in this
 * job's memory while it runs, and are never saved, logged or sent back (the
 * driver masks them in what it reports).
 *
 * Progress: every change of a device is published at once, to the people
 * who may see the job (SSE 'jobs:job', audience) and as a short summary to
 * everyone ('jobs:running', sticky, for the diagram and the bench bar).
 * Cancellation stops whatever is going on (the countdown of a reset, a
 * device waiting for its keyboard, a command, a boot) and every device
 * reports where it stopped. Every job is audited (start, cancel, end with
 * each device's outcome): the bench history reads the audit trail.
 */
import { newId } from '../../lib/db/values.js';
import { CiscoIos, TIMEOUTS, toReplayScript, comparableConfig } from '../../lib/drivers/ciscoIos.js';
import { patterns, screenTail, escapeRe } from '../../lib/cliAutomation.js';
import { comparable, compareConfigs } from './library.js';
import { sha256 } from './configFiles.js';

const FINAL = new Set(['done', 'failed', 'cancelled', 'partial']);
const KEPT_PER_BENCH = 20;
const PACING = { delayMs: 50, chunkBytes: 32, chunkDelayMs: 40, lineTimeoutMs: 8000 };
/** Jobs that erase or write a device: they need its startup-config backed up too */
const MUTATING = new Set(['reset', 'inject']);

/** A device stops here; `outcome` is 'failed' or 'skipped' */
class DeviceStop extends Error {
  constructor(outcome, r, extra = {}) {
    super(r?.message ?? 'stopped');
    this.outcome = outcome;
    this.code = r?.reason ?? r?.code ?? 'jobs.device_failed';
    this.params = r?.params ?? {};
    this.stage = r?.stage ?? extra.stage ?? null;
    this.lastOutput = r?.lastOutput ?? null;
    this.result = extra.result ?? null; // what the device did before it stopped (the report keeps it)
  }
}
const failed = (r, extra) => new DeviceStop('failed', r, extra);

/** The driver's budgets scaled (1 on the real lab); counts are not durations */
export function scaledTimeouts(scale = 1, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(TIMEOUTS)) out[k] = k === 'wakes' ? v : Math.max(k === 'settleMs' ? 30 : 100, Math.round(v * scale));
  return { ...out, ...overrides };
}

const personOf = (u) => ({ id: u.id, username: u.username ?? '', name: u.name || u.username || u.id });

export class JobRunner {
  #jobs = new Map();       // id → Job (running ones, and the last ones per bench)
  #byBench = new Map();    // bench → the job that holds it
  #publishQueued = new Set();

  /**
   * @param services  the module services (consoles, benches, teams)
   * @param library   the snapshots and templates (library.js)
   * @param mayGoOn   (job, device) => boolean: may this job's actor still run it on this device (asked before each device)
   * @param options   { devicesAtOnce, countdownMs, timeouts, pacing, now }
   */
  /**
   * @param viewOf    (user, job, { live }) => 'full' | 'summary' | null: what this user may see of the job
   *                  (live: the job's own publications, which reach whoever follows it until its end)
   */
  constructor({ services, events, audit, repos, library, logger, viewOf, mayGoOn = () => true, options = {} }) {
    this.services = services;
    this.events = events;
    this.audit = audit;
    this.repos = repos;
    this.library = library;
    this.log = logger;
    this.viewOf = viewOf;
    this.mayGoOn = mayGoOn;
    this.devicesAtOnce = options.devicesAtOnce ?? 5;
    this.countdownMs = options.countdownMs ?? 10_000;
    this.timeouts = options.timeouts ?? scaledTimeouts(1);
    this.pacing = options.pacing ?? PACING;
    this.now = options.now ?? (() => Date.now());
  }

  /** The job that holds `bench` (pending or running), or null */
  running(bench) {
    return this.#byBench.get(bench) ?? null;
  }

  get(id) {
    return this.#jobs.get(id) ?? null;
  }

  /** Jobs known in memory (running and recent) */
  recent(bench) {
    return [...this.#jobs.values()].filter((j) => !bench || j.bench === bench).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Start a job. The caller checked who may run it; one job per bench is
   * checked here, synchronously, so two requests cannot both start one.
   *
   * @param kind      'backup' | 'reset' | 'inject' | 'compare'
   * @param devices   the registry's devices, already filtered
   * @param secrets   { enablePasswords, linePasswords }: memory only
   * @param options   what the job records (never a secret): label, forceErase, applyBase, mode, save,
   *                  source, scripts (per device key: the previewed script), snapshot (compare)…
   */
  start({ kind, bench, actor, teamId, devices, secrets = {}, options = {}, countdown = false }) {
    if (this.#byBench.has(bench)) {
      const other = this.#byBench.get(bench);
      return { refused: { status: 409, code: 'jobs.bench_busy', message: 'Another job is running on this bench.', params: { kind: other.kind, name: other.actor.name } } };
    }
    const createdAt = new Date(this.now()).toISOString();
    const job = {
      id: newId(),
      kind,
      bench,
      teamId: teamId ?? null,
      actor: personOf(actor),
      state: countdown ? 'pending' : 'running',
      createdAt,
      startsAt: countdown ? new Date(this.now() + this.countdownMs).toISOString() : createdAt,
      endedAt: null,
      snapshotId: null,
      options: publicOptions(options),
      devices: devices.map((d) => ({ key: d.key, name: d.name, state: 'queued', step: null, stage: null, code: null, params: {}, message: null, result: null })),
      cancelledBy: null,
    };
    // Kept off the published object: the user, the devices, the passwords, the scripts, the controller
    const hidden = {
      actorUser: actor,
      devices: new Map(devices.map((d) => [d.key, d])),
      secrets: {
        enablePasswords: cleanSecrets(secrets.enablePasswords),
        linePasswords: cleanSecrets(secrets.linePasswords),
      },
      options,
      abort: new AbortController(),
      timer: null,
      snapshot: null,
      snapshotOpening: null,
    };
    Object.defineProperty(job, 'hidden', { value: hidden, enumerable: false });
    this.#jobs.set(job.id, job);
    this.#byBench.set(bench, job);
    this.#trim(bench);
    this.audit.log(actor, `job.${kind}`, { bench, job: job.id, device: devices.map((d) => d.name).join(', '), ...auditOptions(options) });
    this.repos.jobs.save(this.#record(job)).catch((err) => this.log.warn(`job ${job.id} not recorded: ${err.message}`));
    this.#publish(job);
    if (countdown) {
      hidden.timer = setTimeout(() => this.#run(job), this.countdownMs);
    } else {
      queueMicrotask(() => this.#run(job));
    }
    return { job };
  }

  /** Stop a job: its countdown, its waiting devices, what they are doing now */
  cancel(job, user) {
    if (FINAL.has(job.state)) return false;
    job.cancelledBy = user ? personOf(user) : null;
    this.audit.log(user ?? 'system', `job.${job.kind}.cancel`, { bench: job.bench, job: job.id, state: job.state });
    if (job.state === 'pending') {
      clearTimeout(job.hidden.timer);
      for (const d of job.devices) d.state = 'cancelled';
      this.#finish(job, 'cancelled');
      return true;
    }
    job.hidden.abort.abort();
    this.#publish(job);
    return true;
  }

  /** At shutdown: stop everything running (the devices report where they were) */
  shutdown() {
    for (const job of this.#byBench.values()) this.cancel(job, null);
  }

  // ── Running ───────────────────────────────────────────────────────────────

  async #run(job) {
    if (job.state === 'cancelled') return;
    job.state = 'running';
    job.startedAt = new Date(this.now()).toISOString();
    this.#publish(job);
    const queue = [...job.devices];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) await this.#device(job, d);
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.devicesAtOnce, queue.length) }, worker));
    } catch (err) {
      this.log.warn(`job ${job.id}: ${err.stack || err.message}`);
    }
    const snap = job.hidden.snapshot;
    if (snap) this.library.close(snap);
    const states = job.devices.map((d) => d.state);
    let state;
    if (job.hidden.abort.signal.aborted) state = 'cancelled';
    else if (states.every((s) => s === 'done' || s === 'skipped')) state = 'done';
    else if (states.every((s) => s !== 'done')) state = 'failed';
    else state = 'partial';
    this.#finish(job, state);
  }

  #finish(job, state) {
    job.state = state;
    job.endedAt = new Date(this.now()).toISOString();
    if (this.#byBench.get(job.bench) === job) this.#byBench.delete(job.bench);
    // The passwords and the user go now: nothing of them outlives the job
    job.hidden.secrets.enablePasswords = [];
    job.hidden.secrets.linePasswords = [];
    this.repos.jobs.save(this.#record(job)).catch((err) => this.log.warn(`job ${job.id} not recorded: ${err.message}`));
    this.audit.log(job.hidden.actorUser ?? 'system', `job.${job.kind}.end`, {
      bench: job.bench,
      job: job.id,
      state,
      snapshot: job.snapshotId,
      devices: job.devices.map((d) => ({ device: d.name, state: d.state, code: d.code, stage: d.stage })),
    });
    try { this.services.benches?.touch?.(job.bench); } catch { /* the bench went away */ }
    this.#publish(job);
  }

  /** One device, start to end: its outcome lands in `d` */
  async #device(job, d) {
    const signal = job.hidden.abort.signal;
    if (signal.aborted) return this.#set(job, d, { state: 'cancelled', code: 'jobs.cancelled' });
    const device = job.hidden.devices.get(d.key);
    if (!this.mayGoOn(job, device)) {
      return this.#set(job, d, { state: 'failed', code: 'jobs.not_allowed', message: 'The bench is no longer yours to run jobs on.' });
    }
    const started = this.now();
    this.#set(job, d, { state: 'waiting', step: 'jobs.steps.keyboard' });
    let room;
    try {
      room = this.services.consoles.rooms.open(device, job.hidden.actorUser, { task: true });
    } catch (err) {
      return this.#set(job, d, { state: 'failed', code: err.code ?? 'jobs.device_failed', params: err.params ?? {}, message: err.message });
    }
    try {
      const result = await room.runExclusive(job.hidden.actorUser, `job:${job.kind}`, async (cli) => {
        this.#set(job, d, { state: 'running', step: 'jobs.steps.start' });
        const ios = new CiscoIos(cli, {
          timeouts: this.timeouts,
          progress: (_message, { code, stage }) => this.#set(job, d, { step: code ?? d.step, stage: stage ?? d.stage }),
        });
        const ctx = { job, d, device, room, cli, ios };
        if (job.kind === 'backup') return this.#backupDevice(ctx);
        if (job.kind === 'reset') return this.#resetDevice(ctx);
        if (job.kind === 'inject') return this.#injectDevice(ctx);
        return this.#compareDevice(ctx);
      }, { signal });
      this.#set(job, d, { state: 'done', step: null, stage: null, result: { ...result, seconds: Math.round((this.now() - started) / 1000) } });
    } catch (err) {
      if (err instanceof DeviceStop) {
        const result = err.result ? { ...err.result, seconds: Math.round((this.now() - started) / 1000) } : d.result;
        this.#set(job, d, { state: err.outcome, code: err.code, params: err.params, message: err.message, stage: err.stage ?? d.stage, lastOutput: err.lastOutput, result });
      } else if (err.cancelled || (signal.aborted && err.code === 'automation.stopped')) {
        this.#set(job, d, { state: 'cancelled', code: 'jobs.cancelled', stage: err.stage ?? d.stage });
      } else {
        this.#set(job, d, { state: 'failed', code: err.code ?? 'jobs.device_failed', params: err.params ?? {}, message: err.message, stage: err.stage ?? d.stage });
        if (!err.code) this.log.warn(`job ${job.id} ${d.name}: ${err.stack || err.message}`);
      }
    }
  }

  // ── The procedures ────────────────────────────────────────────────────────

  /**
   * prepare → identify → running-config (+ VLANs, VTP on a switch); with
   * `startup`, the startup-config too, kept (as `startup`) only when it is not
   * the running-config
   */
  async #read(ctx, { purpose = 'backup', startup = false } = {}) {
    const { job, d, ios, room } = ctx;
    const { enablePasswords, linePasswords } = job.hidden.secrets;
    const p = await ios.prepare({ enablePasswords, linePasswords, screen: room.screen() });
    if (!p.ok) throw failed(p, { stage: 'prepare' });
    this.#set(job, d, { step: 'jobs.steps.identify', stage: 'identify' });
    const id = await ios.identify();
    if (!id.ok) {
      if (id.reason === 'ios.not_ios') throw new DeviceStop('skipped', id, { stage: 'identify' });
      throw failed(id, { stage: 'identify' });
    }
    ctx.facts = id;
    this.#set(job, d, { step: purpose === 'backup' ? 'jobs.steps.backup' : 'jobs.steps.read', stage: purpose });
    const rc = await ios.runningConfig();
    if (!rc.ok) throw failed(rc, { stage: purpose });
    let vlans = null;
    let vtp = null;
    if (id.kind === 'switch') {
      const v = await ios.vlans();
      if (!v.ok) throw failed(v, { stage: purpose });
      vlans = v.supported ? v.vlans : null;
      vtp = v.vtp ?? null;
    }
    let kept = null;
    if (startup) {
      const text = await this.#startupConfig(ctx, purpose);
      if (text !== null && comparableConfig(text) !== comparableConfig(rc.config)) kept = text;
    }
    return { hostname: rc.hostname, config: rc.config, vlans, vtp, facts: id, startup: kept };
  }

  /**
   * show startup-config → its text, or null when the device has none.
   * An erase destroys it: when it cannot be read, the backup has failed.
   */
  async #startupConfig(ctx, stage) {
    const { cli } = ctx;
    const refused = (detail, lastOutput = null) => failed({ reason: 'jobs.startup_unread', message: `The startup configuration could not be read: ${detail}`, params: {}, lastOutput }, { stage });
    let p;
    try {
      cli.reset();
      p = await cli.findPrompt({ timeout: this.timeouts.promptMs });
    } catch (err) {
      if (err.cancelled) throw err;
      throw refused(err.message);
    }
    const promptAtEnd = new RegExp(`(?:^|\\n)${escapeRe(p.host)}# ?$`);
    const atPrompt = (b) => promptAtEnd.test(screenTail(b));
    const quick = { until: atPrompt, paging: false, timeout: this.timeouts.promptMs, idle: Infinity, settle: 80 };
    const off = await cli.command('terminal length 0', quick);
    const r = await cli.command('show startup-config', { until: atPrompt, paging: true, timeout: this.timeouts.commandMs, idle: Math.min(this.timeouts.commandMs, 60_000), settle: this.timeouts.settleMs });
    if (off.complete && !patterns.DEVICE_ERROR.test(off.output)) await cli.command('terminal length 24', quick);
    if (!r.complete) throw refused('the device stopped answering', r.output.slice(-600));
    const text = startupText(r.output, promptAtEnd);
    // What the device answers instead of a configuration is its first line
    if (/^(%\s*)?(startup-config is not present|Non-volatile configuration memory is not present|NVRAM[^\n]*(empty|invalid))/i.test(text)) return null;
    if (/^% ?(Invalid input|Incomplete command|Ambiguous command|Unknown command)/.test(text)) throw refused(text.split('\n')[0]);
    if (!/^(version|hostname|end)\b/m.test(text)) throw refused('the output does not look like a configuration', r.output.slice(-600));
    return text;
  }

  /** The job's snapshot, opened once the first device has something to put in it */
  async #snapshot(job, origin) {
    if (job.hidden.snapshot) return job.hidden.snapshot;
    job.hidden.snapshotOpening ??= this.library.open({
      bench: job.bench, teamId: job.teamId, label: job.hidden.options.label ?? '', origin, jobId: job.id, author: job.hidden.actorUser,
    }).then((set) => {
      job.hidden.snapshot = set;
      job.snapshotId = set.id;
      this.#publish(job);
      return set;
    });
    return job.hidden.snapshotOpening;
  }

  /**
   * Read the device, write it to the job's snapshot, read the files back:
   * → { set, row, data }. A job that erases or writes the device keeps its
   * startup-config too when it differs from the running one
   */
  async #backup(ctx, origin) {
    const { job, d } = ctx;
    const data = await this.#read(ctx, { startup: MUTATING.has(job.kind) });
    let set;
    let row;
    try {
      set = await this.#snapshot(job, origin);
      row = await this.library.add(set, { device: d.name, config: data.config, vlans: data.vlans, vtp: data.vtp, facts: data.facts, startup: data.startup });
    } catch (err) {
      throw failed({ reason: 'jobs.backup_not_written', message: `The backup could not be written: ${err.message}`, params: {} }, { stage: 'backup' });
    }
    this.#set(job, d, { step: 'jobs.steps.verify', stage: 'verify' });
    if (!(await this.library.verify(set, row, data.config, { startup: data.startup }))) {
      throw failed({ reason: 'jobs.backup_unverified', message: 'The backup written does not read back as it was taken.', params: {} }, { stage: 'verify' });
    }
    return { set, row, data };
  }

  async #backupDevice(ctx) {
    const { set, row, data } = await this.#backup(ctx, 'backup');
    return { snapshot: set.id, hostname: data.hostname, bytes: row.bytes, sha256: row.sha256, vlans: data.vlans?.length ?? null, facts: pickFacts(data.facts) };
  }

  /**
   * The erase, given what the backup gave. A device whose backup failed is
   * erased only when an admin ticked it, and never one that is not Cisco IOS
   */
  async #erase(ctx, backup, backupError) {
    const { job, d, ios } = ctx;
    let proof;
    let verifyBackup = null;
    if (backup) {
      proof = { kind: 'snapshot', snapshotId: backup.set.id, config: backup.data.config, hostname: backup.data.hostname };
      verifyBackup = () => this.library.verify(backup.set, backup.row, backup.data.config, { startup: backup.data.startup });
    } else {
      const forced = job.hidden.options.forceErase?.includes(d.key) && job.hidden.actorUser?.role === 'admin';
      if (!forced || backupError.outcome === 'skipped' || !ctx.facts) {
        throw failed({ reason: 'jobs.backup_failed', message: `The backup failed, so the device was not erased: ${backupError.message}`, params: { cause: backupError.code } }, { stage: backupError.stage ?? 'backup' });
      }
      proof = { kind: 'override', by: job.actor.username || job.actor.id, reason: `backup failed (${backupError.code})` };
      this.#set(job, d, { warnings: [...(d.warnings ?? []), 'erased_without_backup'] });
    }
    this.#set(job, d, { step: 'jobs.steps.erase', stage: 'erase' });
    const r = await ios.eraseAndReload({ backup: proof, verifyBackup, facts: ctx.facts, fixConfigRegister: true });
    if (!r.ok) throw failed(r);
    return r;
  }

  async #resetDevice(ctx) {
    const { job, d } = ctx;
    let backup = null;
    let backupError = null;
    try {
      backup = await this.#backup(ctx, 'reset');
    } catch (err) {
      if (!(err instanceof DeviceStop)) throw err;
      if (err.outcome === 'skipped') throw err;
      backupError = err;
    }
    const r = await this.#erase(ctx, backup, backupError);
    const result = {
      snapshot: backup?.set.id ?? null, startupKept: Boolean(backup?.data.startup), hostname: r.hostname, register: r.register, vlanDat: r.vlanDat,
      warnings: [...(d.warnings ?? []), ...(r.warnings ?? [])], bootSeconds: r.bootSeconds,
    };
    const base = job.hidden.options.base;
    if (base) await this.#applyBase(ctx, base, result);
    return result;
  }

  /**
   * The base configuration after a reset. The device is already erased: a
   * template gone or damaged since the job started is a warning, not a
   * failure, and a base the device refused lines of is not saved
   */
  async #applyBase(ctx, base, result) {
    const { job, d } = ctx;
    let entry;
    try {
      entry = await this.library.readDevice(base, d.name, { fallback: true });
    } catch {
      result.warnings.push('base_missing');
      return;
    }
    if (!entry) return;
    if (!entry.intact) {
      result.warnings.push('base_damaged');
      return;
    }
    this.#set(job, d, { step: 'jobs.steps.base', stage: 'base' });
    const { script, lineTimeouts } = toReplayScript(entry.config, { vlans: entry.vlans, vtp: entry.vtp, facts: { kind: ctx.facts.kind } });
    const sent = await this.#send(ctx, script, lineTimeouts);
    result.base = { template: base.id, name: base.name, lines: sent.total, errors: sent.errors };
    if (job.hidden.options.save === false) return;
    if (sent.errors.length) {
      result.base.saved = false;
      result.warnings.push('base_not_saved');
      return;
    }
    result.base.saved = await this.#save(ctx);
  }

  async #injectDevice(ctx) {
    const { job, d } = ctx;
    const plan = job.hidden.options.plans.get(d.key);
    const mode = job.hidden.options.mode;
    let backup = null;
    let backupError = null;
    try {
      backup = await this.#backup(ctx, 'inject');
    } catch (err) {
      if (!(err instanceof DeviceStop) || err.outcome === 'skipped') throw err;
      backupError = err;
    }
    let reset = null;
    if (mode === 'reset') reset = await this.#erase(ctx, backup, backupError);
    else if (!backup) throw failed({ reason: 'jobs.backup_failed', message: `The backup failed, so nothing was sent: ${backupError.message}`, params: { cause: backupError.code } }, { stage: backupError.stage });

    this.#set(job, d, { step: 'jobs.steps.inject', stage: 'inject' });
    const sent = await this.#send(ctx, plan.script, plan.lineTimeouts);

    // Read again and compare with what was injected, before anything is saved
    this.#set(job, d, { step: 'jobs.steps.check', stage: 'check' });
    const after = await this.#read(ctx, { purpose: 'check' });
    const expected = comparable({ config: plan.source.config, vlans: plan.source.vlans });
    const live = comparable({ config: after.config, vlans: after.vlans });
    let check;
    if (mode === 'reset') {
      check = compareConfigs(expected, live, { from: `${plan.from}`, to: `${d.name} (live)` });
    } else {
      const have = new Set(comparableConfig(after.config).split('\n'));
      const missing = comparableConfig(plan.source.config).split('\n').filter((l) => l.trim() && !have.has(l));
      check = { status: missing.length ? 'changed' : 'same', missing: missing.slice(0, 200), added: 0, removed: missing.length };
    }
    const result = {
      snapshot: backup?.set.id ?? null,
      startupKept: Boolean(backup?.data.startup),
      sha256: plan.sha256,
      lines: sent.total,
      errors: sent.errors,
      slow: sent.slow,
      saved: null,
      reset: reset ? { hostname: reset.hostname, register: reset.register, warnings: reset.warnings } : null,
      check,
    };
    // Lines refused, or a reset that does not read back as the source: the
    // startup-config is left as it was, the person reads the report and saves by hand
    if (sent.errors.length) {
      if (job.hidden.options.save) result.saved = false;
      throw failed({ reason: 'jobs.script_errors', message: `The device refused ${sent.errors.length} line(s): nothing was saved.`, params: { count: sent.errors.length } }, { stage: 'inject', result });
    }
    if (mode === 'reset' && check.status !== 'same') {
      if (job.hidden.options.save) result.saved = false;
      throw failed({ reason: 'jobs.check_differs', message: 'The device does not read back as the source: nothing was saved.', params: { added: check.added, removed: check.removed } }, { stage: 'check', result });
    }
    if (job.hidden.options.save) result.saved = await this.#save(ctx);
    return result;
  }

  async #compareDevice(ctx) {
    const { job, d } = ctx;
    const source = job.hidden.options.compareWith;
    const entry = await this.library.readDevice(source, d.name);
    const live = await this.#read(ctx, { purpose: 'check' });
    if (!entry) return { hostname: live.hostname, check: { status: 'only-live', patch: '', added: 0, removed: 0 } };
    return { hostname: live.hostname, check: compareConfigs(comparable(entry), comparable(live), { from: `${source.id}/${d.name}`, to: `${d.name} (live)` }) };
  }

  /** The script, paced, as the preview showed it; device errors are reported, the script goes on */
  async #send(ctx, script, lineTimeouts = {}) {
    const { cli, job, d } = ctx;
    const r = await cli.sendScript(script, { ...this.pacing, skipComments: false, lineTimeouts }, (_m, p) => {
      if (p?.total) this.#set(job, d, { progress: { done: p.done, total: p.total } });
    });
    return { total: r.total, sent: r.sent, errors: r.errors.slice(0, 50), slow: r.slow.slice(0, 50) };
  }

  /** copy running-config startup-config → true when the device said [OK] */
  async #save(ctx) {
    const { cli, job, d } = ctx;
    this.#set(job, d, { step: 'jobs.steps.save', stage: 'save' });
    const atPrompt = (b) => patterns.CISCO_PROMPT.test(screenTail(b));
    cli.reset();
    await cli.answer('copy running-config startup-config');
    for (let q = 0; q < 3; q++) {
      const r = await cli.expect({
        dest: /Destination filename \[[^\]\n]*\]\? ?$/,
        confirm: /\[confirm\] ?$/,
        done: (b) => atPrompt(b) && !/copy running-config startup-config\s*$/.test(b),
      }, { timeout: this.timeouts.commandMs, settle: this.timeouts.settleMs });
      // What follows an answer is read from scratch: the question itself must not match twice
      if (r.name === 'dest') { cli.reset(); await cli.answer(''); continue; }
      if (r.name === 'confirm') { cli.reset(); cli.send('\r'); continue; }
      return r.name === 'done' && /\[OK\]/.test(cli.buffer) && !patterns.DEVICE_ERROR.test(cli.buffer);
    }
    return false;
  }

  // ── State and its publication ─────────────────────────────────────────────

  #set(job, d, changes) {
    Object.assign(d, changes);
    if (FINAL_DEVICE.has(d.state)) {
      d.step = null;
      d.endedAt ??= new Date(this.now()).toISOString();
    }
    this.#publish(job);
  }

  /** Coalesced: one publication per job per tick */
  #publish(job) {
    if (this.#publishQueued.has(job.id)) return;
    this.#publishQueued.add(job.id);
    queueMicrotask(() => {
      this.#publishQueued.delete(job.id);
      // Two copies: the whole report for those who may read the bench's configurations, the report without them for the others
      this.events.publish('jobs:job', publicJob(job), { audience: (u) => this.viewOf(u, job, { live: true }) === 'full' });
      this.events.publish('jobs:job', redactedJob(job), { audience: (u) => this.viewOf(u, job, { live: true }) === 'summary' });
      this.events.publish('jobs:running', this.summary(), { sticky: true });
    });
  }

  /** Everyone's view: which bench runs what, device by device (no message, no output) */
  summary() {
    return {
      jobs: [...this.#byBench.values()].map((j) => ({
        id: j.id, kind: j.kind, bench: j.bench, state: j.state, startsAt: j.startsAt, actor: { name: j.actor.name },
        devices: j.devices.map((d) => ({ key: d.key, name: d.name, state: d.state, step: d.step })),
      })),
    };
  }

  #record(job) {
    return { ...publicJob(job), options: job.options };
  }

  /** Forget the oldest finished jobs of a bench (they stay in the database) */
  #trim(bench) {
    const done = [...this.#jobs.values()].filter((j) => j.bench === bench && FINAL.has(j.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (done.length > KEPT_PER_BENCH) this.#jobs.delete(done.shift().id);
  }
}

const FINAL_DEVICE = new Set(['done', 'failed', 'skipped', 'cancelled']);

/**
 * What people who may not read the bench's configurations see of a job: the
 * same report without a line of configuration (no diff, no missing lines,
 * no refused command, no console output)
 */
export function redactedJob(job) {
  const pub = job.hidden ? publicJob(job) : { ...job, devices: job.devices.map((d) => ({ ...d })) };
  pub.redacted = true;
  pub.devices = pub.devices.map(({ lastOutput: _output, ...d }) => ({ ...d, result: redactResult(d.result) }));
  return pub;
}

function redactResult(r) {
  if (!r || typeof r !== 'object') return r ?? null;
  const out = { ...r };
  if (out.check) {
    const { patch: _patch, missing: _missing, ...check } = out.check;
    out.check = check;
  }
  if (Array.isArray(out.errors)) out.errors = out.errors.map(({ command: _command, ...e }) => e);
  if (out.base && Array.isArray(out.base.errors)) out.base = { ...out.base, errors: out.base.errors.map(({ command: _command, ...e }) => e) };
  return out;
}

/** Captured `show startup-config` → its text: no echo, no "Using … bytes", no prompt, no pager marks, no syslog */
function startupText(captured, promptAtEnd) {
  let lines = captured.split('\n');
  const echo = lines.findIndex((l) => /\bsh(ow)?\s+star/i.test(l));
  if (echo >= 0) lines = lines.slice(echo + 1);
  lines = lines.map((l) => l.replace(/\s*--More--\s*/g, '').replace(/\s+$/, '')).filter((l) => !patterns.SYSLOG_LINE.test(l));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length && promptAtEnd.test(`\n${lines.at(-1)}`)) lines.pop();
  while (lines.length && (!lines[0].trim() || /^Using \d+ out of \d+ bytes/i.test(lines[0]))) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return `${lines.join('\n')}\n`;
}

/** What may be shown of a job (the published copy): no secret, no user object, no script */
export function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    bench: job.bench,
    teamId: job.teamId,
    actor: job.actor,
    state: job.state,
    createdAt: job.createdAt,
    startsAt: job.startsAt,
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt,
    snapshotId: job.snapshotId,
    options: job.options,
    cancelledBy: job.cancelledBy ?? null,
    devices: job.devices.map((d) => ({ ...d })),
  };
}

/** Options as recorded and shown: never a password, never a script */
function publicOptions(o) {
  const out = {};
  if (o.label) out.label = String(o.label);
  if (o.mode) out.mode = o.mode;
  if (o.save !== undefined) out.save = Boolean(o.save);
  if (o.forceErase?.length) out.forceErase = [...o.forceErase];
  if (o.base) out.base = { id: o.base.id, name: o.base.name };
  if (o.source) out.source = { ...o.source };
  if (o.rsaModulus) out.rsaModulus = o.rsaModulus;
  if (o.compareWith) out.compareWith = o.compareWith.id;
  if (o.plans) out.scripts = Object.fromEntries([...o.plans].map(([k, p]) => [k, p.sha256]));
  if (o.offer) out.offer = true;
  return out;
}

function auditOptions(o) {
  const out = {};
  if (o.mode) out.mode = o.mode;
  if (o.source) out.source = o.source;
  if (o.forceErase?.length) out.forceErase = o.forceErase.length;
  if (o.base) out.base = o.base.name;
  if (o.offer) out.offer = true;
  return out;
}

/** Up to three candidates, short strings: what the job will type, nothing else */
function cleanSecrets(list) {
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 64).slice(0, 3) : [];
}

const pickFacts = (f) => ({ model: f.model, version: f.version, family: f.family, kind: f.kind, configRegister: f.configRegister });

/** The exact script one device will receive, and its fingerprint (the preview and the job compute it the same way) */
export function planScript(source, { kind, rsaModulus = null } = {}) {
  const r = toReplayScript(source.config, { vlans: source.vlans, vtp: source.vtp, facts: { kind: kind ?? source.facts?.kind ?? undefined }, rsaModulus });
  return { script: r.script, dropped: r.dropped, vlans: r.vlans, lineTimeouts: r.lineTimeouts, sha256: sha256(r.script) };
}
