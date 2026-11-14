/**
 * Bench checks: line status, cabling, ping matrix, interfaces (SPEC "Lot checks")
 *
 * They run on real equipment, so they only read:
 *   - the line status asks the console server (`nc -z` through the jump
 *     server, on the shared SSH connections) and never opens a line that is
 *     in use, in the application (its room exists) or outside it (the
 *     console server refuses it). A free line is opened as a task of the
 *     room manager, one Enter is sent and the device's answer is awaited:
 *     nothing means "device silent" (powered off, cable unplugged, hung).
 *     The line is hung up afterwards unless someone joined it meanwhile;
 *   - the others type `show` commands and `ping` only, through the room of
 *     each line and its runExclusive (the pilot is asked, the bench rule is
 *     asked again before every byte, everyone watching sees the task), like
 *     the bench jobs. Before anything else `show version` must say Cisco IOS
 *     or IOS XE: a device whose system is unknown is left alone after it.
 *     A console waiting for an answer that an Enter would give (a
 *     "[confirm]", the initial dialog, ROMMON, a boot) is not touched.
 *
 * One check at a time per bench, five devices at once, cancellable at any
 * point (the devices report where they stopped). What a check reads goes,
 * on the console, only to the people who may read its result (privateOutput),
 * and stays out of the journal. The last result of each kind is kept per bench
 * (repos.checks) and survives a reload or a restart.
 *
 * Progress: 'checks:running' (sticky, everyone: which bench runs which check,
 * device by device, no result) and 'checks:check' (the check, with its result
 * once over, to the people who may read it).
 */
import { newId } from '../../lib/db/values.js';
import { CiscoIos, classifyScreen } from '../../lib/drivers/ciscoIos.js';
import { scaledTimeouts } from '../jobs/runner.js';
import { diagramLinks } from './links.js';
import { compareCabling } from './cabling.js';

export const KINDS = Object.freeze(['lines', 'cabling', 'ping', 'interfaces']);
const FINAL = new Set(['done', 'failed', 'partial', 'cancelled']);
/** Screens an Enter would answer for someone: a check never types there */
const UNSAFE = new Set(['confirm', 'save', 'dialog', 'setup', 'autoinstall', 'question', 'rommon', 'bootLoader', 'booting']);
const PING_CELLS_MAX = 400;

/** A device stops here; `outcome` is 'failed' or 'skipped' */
class DeviceStop extends Error {
  constructor(outcome, r) {
    super(r?.message ?? 'stopped');
    this.outcome = outcome;
    this.code = r?.reason ?? r?.code ?? 'checks.device_failed';
    this.params = r?.params ?? {};
  }
}

const personOf = (u) => ({ id: u.id, username: u.username ?? '', name: u.name || u.username || u.id });
const targetKey = (t) => `${t.host}:${t.port}`;
const refusedLine = (err) => err?.code === 'consoles.room_closed' && err.params?.reason === 'consoles.line_refused';
/** Wait `ms`, or less when the check is cancelled */
const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});
const visible = (text) => /\S/.test(String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));

export class CheckRunner {
  #checks = new Map();   // bench → the check running there
  #last = new Map();     // `${bench} ${kind}` → the last finished check

  /**
   * @param readable  (user, check) => boolean: may this user read the check's result
   * @param mayGoOn   (check) => boolean: may its actor still run it (asked before each device)
   * @param options   { devicesAtOnce, timeouts, wakeMs, probeSeconds, pingRepeat, now }
   */
  constructor({ services, events, audit, repos, logger, readable, mayGoOn = () => true, options = {} }) {
    this.services = services;
    this.events = events;
    this.audit = audit;
    this.repos = repos;
    this.log = logger;
    this.readable = readable;
    this.mayGoOn = mayGoOn;
    this.devicesAtOnce = options.devicesAtOnce ?? 5;
    this.timeouts = options.timeouts ?? scaledTimeouts(1);
    this.wakeMs = options.wakeMs ?? 8000;
    this.probeSeconds = options.probeSeconds ?? 3;
    this.pingRepeat = options.pingRepeat ?? 3;
    this.retryMs = options.retryMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Load the last results kept in the database */
  async load() {
    for (const c of await this.repos.checks.all()) this.#last.set(`${c.bench} ${c.kind}`, fromRecord(c));
  }

  running(bench) { return this.#checks.get(bench) ?? null; }
  all() { return [...this.#checks.values()]; }
  last(bench, kind) { return this.#last.get(`${bench} ${kind}`) ?? null; }
  lastOf(bench) { return KINDS.map((k) => this.last(bench, k)).filter(Boolean); }
  lastAll() { return [...this.#last.values()]; }

  /**
   * Start a check; the caller checked who may. One per bench, checked here,
   * synchronously, so two requests cannot both start one.
   * @param devices  the registry's devices of the bench (admin switches excluded)
   * @param lab      the bench's page of the diagram (links, for the cabling)
   */
  start({ kind, bench, actor, teamId, devices, lab }) {
    const other = this.#checks.get(bench);
    if (other) return { refused: { status: 409, code: 'checks.bench_busy', message: 'Another check is running on this bench.', params: { kind: other.kind, name: other.actor.name } } };
    const startedAt = new Date(this.now()).toISOString();
    const check = {
      id: newId(),
      kind,
      bench,
      teamId: teamId ?? null,
      actor: personOf(actor),
      state: 'running',
      startedAt,
      endedAt: null,
      cancelledBy: null,
      devices: devices.map((d) => ({ key: d.key, name: d.name, state: 'queued', step: null, code: null, params: {} })),
      result: null,
    };
    const hidden = { actorUser: actor, devices: new Map(devices.map((d) => [d.key, d])), lab, abort: new AbortController() };
    Object.defineProperty(check, 'hidden', { value: hidden, enumerable: false });
    this.#checks.set(bench, check);
    this.audit.log(actor, `check.${kind}`, { bench, check: check.id, device: devices.map((d) => d.name).join(', ') });
    this.#publish(check);
    queueMicrotask(() => this.#run(check));
    return { check };
  }

  /** Stop a check: what each device is doing now, and the ones not started */
  cancel(check, user) {
    if (FINAL.has(check.state)) return false;
    check.cancelledBy = user ? personOf(user) : null;
    this.audit.log(user ?? 'system', `check.${check.kind}.cancel`, { bench: check.bench, check: check.id });
    check.hidden.abort.abort();
    this.#publish(check);
    return true;
  }

  shutdown() {
    for (const c of this.#checks.values()) this.cancel(c, null);
  }

  // ── Running ───────────────────────────────────────────────────────────────

  async #run(check) {
    let result = null;
    try {
      if (check.kind === 'lines') result = await this.#lines(check);
      else if (check.kind === 'interfaces') result = await this.#interfaces(check);
      else if (check.kind === 'cabling') result = await this.#cabling(check);
      else result = await this.#ping(check);
    } catch (err) {
      this.log.warn(`check ${check.id}: ${err.stack || err.message}`);
    }
    const states = check.devices.map((d) => d.state);
    let state;
    if (check.hidden.abort.signal.aborted) state = 'cancelled';
    else if (!states.length || states.every((s) => s === 'done' || s === 'skipped')) state = 'done';
    else if (states.every((s) => s !== 'done')) state = 'failed';
    else state = 'partial';
    check.state = state;
    check.endedAt = new Date(this.now()).toISOString();
    check.result = result ?? { devices: [] };
    if (this.#checks.get(check.bench) === check) this.#checks.delete(check.bench);
    const kept = publicCheck(check);
    this.#last.set(`${check.bench} ${check.kind}`, kept);
    try {
      await this.repos.checks.save(toRecord(kept));
    } catch (err) {
      this.log.warn(`check ${check.id} not recorded: ${err.message}`);
    }
    this.audit.log(check.hidden.actorUser ?? 'system', `check.${check.kind}.end`, {
      bench: check.bench, check: check.id, state, summary: check.result.summary ?? null,
      devices: check.devices.map((d) => ({ device: d.name, state: d.state, code: d.code })),
    });
    this.#publish(check);
  }

  /** Run `fn(d, device)` for every device, `devicesAtOnce` at a time */
  async #each(check, list, fn) {
    const queue = [...list];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const device = check.hidden.devices.get(d.key);
        if (check.hidden.abort.signal.aborted) { this.#set(check, d, { state: 'cancelled', code: 'checks.cancelled' }); continue; }
        if (!this.mayGoOn(check)) { this.#set(check, d, { state: 'failed', code: 'checks.not_allowed' }); continue; }
        try {
          await fn(d, device);
        } catch (err) {
          if (err instanceof DeviceStop) this.#set(check, d, { state: err.outcome, code: err.code, params: err.params });
          else if (err.cancelled || (check.hidden.abort.signal.aborted && err.code === 'automation.stopped')) this.#set(check, d, { state: 'cancelled', code: 'checks.cancelled' });
          else {
            this.#set(check, d, { state: 'failed', code: err.code ?? 'checks.device_failed', params: err.params ?? {} });
            if (!err.code) this.log.warn(`check ${check.id} ${d.name}: ${err.stack || err.message}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.devicesAtOnce, queue.length) }, worker));
  }

  /**
   * Hold the device's console as a task (rooms.open + runExclusive) and run
   * `fn(cli, room)`. A line the console server refuses right after it was
   * hung up (by this check's previous run, a moment ago: the console server
   * frees its port when telnet has gone) is tried again twice, a little later
   */
  async #task(check, d, device, label, fn) {
    const rooms = this.services.consoles.rooms;
    const signal = check.hidden.abort.signal;
    for (let attempt = 1; ; attempt++) {
      const existed = Boolean(rooms.get(targetKey(device.target)));
      this.#set(check, d, { state: 'waiting', step: 'checks.steps.keyboard' });
      const room = rooms.open(device, check.hidden.actorUser, { task: true });
      try {
        return await room.runExclusive(check.hidden.actorUser, `check:${label}`, (cli) => fn(cli, room), { signal, privateOutput: (u) => this.readable(u, check) });
      } catch (err) {
        if (!existed && attempt < 3 && !signal.aborted && refusedLine(err)) {
          await pause(this.retryMs * attempt, signal);
          continue;
        }
        throw err;
      } finally {
        this.#hangUpIfAlone(room, existed);
      }
    }
  }

  /** The device's console as a task, once `show version` said Cisco IOS / IOS XE: `fn(ios, cli, facts)` */
  #onConsole(check, d, device, label, fn) {
    return this.#task(check, d, device, label, async (cli, room) => {
      this.#set(check, d, { state: 'running', step: 'checks.steps.identify' });
      const screen = classifyScreen(room.screen()).state;
      if (UNSAFE.has(screen)) throw new DeviceStop('skipped', { reason: 'checks.console_waiting', params: { state: screen } });
      const ios = new CiscoIos(cli, { timeouts: this.timeouts });
      const id = await ios.identify();
      if (!id.ok) throw new DeviceStop(id.reason === 'ios.not_ios' ? 'skipped' : 'failed', id);
      d.facts = { hostname: id.hostname ?? ios.hostname ?? null, model: id.model, family: id.family, kind: id.kind, version: id.version };
      return fn(ios, cli, id);
    });
  }

  /** A line the check opened and nobody joined is freed at once: the console server's port is someone's */
  #hangUpIfAlone(room, existed) {
    if (existed || room.closed || room.task || room.users.length) return;
    room.close('Check done: the line is free again', { code: 'consoles.session_closed' });
  }

  // ── Line status ───────────────────────────────────────────────────────────

  async #lines(check) {
    const rooms = this.services.consoles.rooms;
    const out = new Map();
    const seen = new Map(); // target → the entry of the first device on that line (one probe per line)
    await this.#each(check, check.devices, async (d, device) => {
      const target = targetKey(device.target);
      const entry = { key: d.key, name: d.name, target, line: 'unknown', screen: null };
      out.set(d.key, entry);
      if (seen.has(target)) {
        Object.assign(entry, { line: seen.get(target).line, screen: seen.get(target).screen });
        return this.#set(check, d, { state: 'done' });
      }
      seen.set(target, entry);
      this.#set(check, d, { state: 'running', step: 'checks.steps.probe' });
      const room = rooms.get(target);
      if (room) {
        entry.line = room.summary().state === 'silent' ? 'silent' : 'in_app';
        return this.#set(check, d, { state: 'done' });
      }
      let probe;
      try {
        probe = await this.services.consoles.probe(device, this.probeSeconds);
      } catch (err) {
        entry.line = 'unknown';
        return this.#set(check, d, { state: 'failed', code: err.code ?? 'checks.probe_failed', params: { detail: String(err.message).slice(0, 200) } });
      }
      if (check.hidden.abort.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (probe === 'busy') {
        entry.line = 'busy';
        rooms.markBusy(target);
        return this.#set(check, d, { state: 'done' });
      }
      if (probe !== 'free') {
        entry.line = 'unknown';
        return this.#set(check, d, { state: 'failed', code: 'checks.probe_unknown' });
      }
      rooms.markFree(target);
      // In the application meanwhile: someone opened it while the console server answered
      if (rooms.get(target)) { entry.line = 'in_app'; return this.#set(check, d, { state: 'done' }); }
      await this.#wake(check, d, device, entry);
    });
    return { devices: check.devices.map((d) => out.get(d.key) ?? { key: d.key, name: d.name, line: 'unknown', screen: null }) };
  }

  /** One Enter on a free line: does the device answer? */
  async #wake(check, d, device, entry) {
    this.#set(check, d, { state: 'waiting', step: 'checks.steps.wake' });
    try {
      await this.#task(check, d, device, 'lines', async (cli) => {
        this.#set(check, d, { state: 'running', step: 'checks.steps.wake' });
        cli.reset();
        cli.send('\r');
        const answered = await cli.wait((b) => visible(b.replace(/^\r?\n/, '')), { timeout: this.wakeMs, settle: 300, optional: true });
        entry.line = answered ? 'free' : 'silent';
        entry.screen = answered ? classifyScreen(cli.buffer).state : null;
      });
      this.#set(check, d, { state: 'done' });
    } catch (err) {
      // The console server refused the line after all: someone outside took it meanwhile
      if (refusedLine(err)) {
        entry.line = 'busy';
        this.services.consoles.rooms.markBusy(targetKey(device.target));
        return this.#set(check, d, { state: 'done' });
      }
      throw err;
    }
  }

  // ── Interfaces ────────────────────────────────────────────────────────────

  async #interfaces(check) {
    const out = new Map();
    await this.#each(check, check.devices, async (d, device) => {
      const entry = { key: d.key, name: d.name, interfaces: null };
      out.set(d.key, entry);
      await this.#onConsole(check, d, device, 'interfaces', async (ios) => {
        this.#set(check, d, { step: 'checks.steps.interfaces' });
        const r = await ios.interfaces();
        if (!r.ok) throw new DeviceStop('failed', r);
        entry.interfaces = r.interfaces.map(publicInterface);
      });
      this.#set(check, d, { state: 'done', step: null });
    });
    return { devices: check.devices.map((d) => ({ ...deviceReport(d), interfaces: out.get(d.key)?.interfaces ?? null })) };
  }

  // ── Cabling ───────────────────────────────────────────────────────────────

  async #cabling(check) {
    const read = new Map();
    await this.#each(check, check.devices, async (d, device) => {
      const entry = { cdp: null, interfaces: null };
      read.set(d.key, entry);
      await this.#onConsole(check, d, device, 'cabling', async (ios) => {
        this.#set(check, d, { step: 'checks.steps.cdp' });
        const cdp = await ios.cdpNeighbors();
        if (!cdp.ok) throw new DeviceStop('failed', cdp);
        entry.cdp = { enabled: cdp.enabled, neighbors: cdp.neighbors.map(publicNeighbor) };
        this.#set(check, d, { step: 'checks.steps.interfaces' });
        const ifs = await ios.interfaces();
        if (ifs.ok) entry.interfaces = ifs.interfaces.map(publicInterface);
      });
      this.#set(check, d, { state: 'done', step: null });
    });
    const devices = check.devices.map((d) => ({ ...deviceReport(d), ...read.get(d.key) }));
    const compared = compareCabling(diagramLinks(check.hidden.lab), devices.map((d) => ({ ...d, hostname: d.hostname })));
    return { devices, ...compared };
  }

  // ── Ping matrix ───────────────────────────────────────────────────────────

  async #ping(check) {
    // 1. Every router's addresses (interfaces up/up with an IPv4 address)
    const addresses = new Map();
    await this.#each(check, check.devices, async (d, device) => {
      await this.#onConsole(check, d, device, 'ping', async (ios, _cli, id) => {
        if (id.kind !== 'router') throw new DeviceStop('skipped', { reason: 'checks.not_router', params: { model: id.model ?? '' } });
        this.#set(check, d, { step: 'checks.steps.interfaces' });
        const r = await ios.interfaces();
        if (!r.ok) throw new DeviceStop('failed', r);
        addresses.set(d.key, r.interfaces.filter((i) => i.ip && i.status === 'up' && i.protocol === 'up').map((i) => ({ interface: i.name, ip: i.ip })));
      });
      this.#set(check, d, { state: 'running', step: null });
    });
    const sources = check.devices.filter((d) => addresses.has(d.key) && d.state === 'running');
    const cells = [];
    for (const from of sources) {
      for (const to of sources) {
        if (to.key === from.key) continue;
        for (const a of addresses.get(to.key)) cells.push({ from: from.key, to: to.key, interface: a.interface, ip: a.ip, state: 'queued', sent: 0, received: 0, successRate: null, rtt: null });
      }
    }
    if (cells.length > PING_CELLS_MAX) cells.length = PING_CELLS_MAX;
    // 2. From each router, every address of the others
    await this.#each(check, sources, async (d, device) => {
      const mine = cells.filter((c) => c.from === d.key);
      await this.#onConsole(check, d, device, 'ping', async (ios) => {
        for (const c of mine) {
          this.#set(check, d, { step: 'checks.steps.ping', params: { ip: c.ip } });
          const r = await ios.ping(c.ip, { repeat: this.pingRepeat });
          if (!r.ok) { c.state = 'error'; c.code = r.reason; continue; }
          Object.assign(c, { sent: r.sent, received: r.received, successRate: r.successRate, rtt: r.rtt });
          c.state = r.received === 0 ? 'fail' : r.received === r.sent ? 'ok' : 'partial';
        }
      });
      this.#set(check, d, { state: 'done', step: null, params: {} });
    });
    for (const d of check.devices) if (d.state === 'running') this.#set(check, d, { state: 'done', step: null });
    for (const c of cells) if (c.state === 'queued') c.state = 'skipped';
    const routers = check.devices.map((d) => ({ ...deviceReport(d), addresses: addresses.get(d.key) ?? null }));
    const summary = { ok: 0, partial: 0, fail: 0, error: 0, skipped: 0 };
    for (const c of cells) summary[c.state] = (summary[c.state] ?? 0) + 1;
    return { routers, cells, repeat: this.pingRepeat, summary };
  }

  // ── Publication ───────────────────────────────────────────────────────────

  #set(check, d, patch) {
    Object.assign(d, patch);
    if (patch.state && patch.state !== 'running' && patch.state !== 'waiting' && !('step' in patch)) d.step = null;
    this.#publish(check);
  }

  #publish(check) {
    const view = publicCheck(check);
    this.events.publish('checks:check', view, { audience: (u) => this.readable(u, check) });
    this.events.publish('checks:running', { checks: this.all().map(summaryOf) }, { sticky: true });
  }
}

const publicInterface = (i) => ({ name: i.name, ip: i.ip, status: i.status, protocol: i.protocol });
const publicNeighbor = (n) => ({ deviceId: n.deviceId, ip: n.ip, platform: n.platform, localInterface: n.localInterface, remoteInterface: n.remoteInterface });
const deviceReport = (d) => ({ key: d.key, name: d.name, state: d.state, code: d.code, params: d.params, ...(d.facts ?? {}) });

/** What is kept and sent: no user object, no controller */
export function publicCheck(c) {
  return {
    id: c.id, kind: c.kind, bench: c.bench, state: c.state, teamId: c.teamId, actor: c.actor,
    startedAt: c.startedAt, endedAt: c.endedAt, cancelledBy: c.cancelledBy ?? null,
    devices: (c.devices ?? []).map((d) => ({ key: d.key, name: d.name, state: d.state, step: d.step ?? null, code: d.code ?? null, params: d.params ?? {} })),
    result: c.result ?? null,
  };
}

/** The row keeps the devices' progress and who cancelled inside the result */
function toRecord(p) {
  return { ...p, result: { ...(p.result ?? {}), progress: p.devices, cancelledBy: p.cancelledBy } };
}
function fromRecord(r) {
  const { progress = [], cancelledBy = null, ...result } = r.result ?? {};
  return { ...r, devices: progress, cancelledBy, result };
}

/** For everyone: which bench runs which check, device by device */
const summaryOf = (c) => ({ id: c.id, bench: c.bench, kind: c.kind, actor: { name: c.actor.name }, startedAt: c.startedAt, devices: c.devices.map((d) => ({ key: d.key, state: d.state })) });
