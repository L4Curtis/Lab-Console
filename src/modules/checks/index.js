/**
 * Bench checks module: line status, cabling, ping matrix and interfaces,
 * read from the real devices and shown on the diagram (SPEC "Lot checks")
 *
 * HTTP (/api/checks), every route behind the sign-in gate:
 *   GET  /benches/:bench              the last result of each kind this user may read, the check
 *                                     running, what this user may do, the limits
 *   GET  /latest                      the last results of every bench this user may read (the diagram layers)
 *   POST /benches/:bench/lines        line status of every device: free / busy outside the app / device silent
 *   POST /benches/:bench/cabling      CDP on every device against the diagram's links
 *   POST /benches/:bench/ping         ping matrix between the routers (addresses read from them)
 *   POST /benches/:bench/interfaces   addresses and state of every interface
 *   POST /benches/:bench/cancel       stop the check running on the bench
 *
 * Who: running a check needs services.benches.canOperate (the occupants of
 * an unlocked bench, admins), like a bench job, and no job on the bench; one
 * check at a time per bench; limited per person (CHECKS_PER_MINUTE) and the
 * line status per bench (one every LINES_COOLDOWN). Reading a result: the
 * line status is for everyone signed in (what the diagram already shows of
 * busy lines); the others (addresses, neighbours) for the members of the team
 * that held the bench when it ran, its actor and admins. Cancelling: its
 * actor, the bench's occupants, admins.
 *
 * SSE: 'checks:running' (sticky, everyone), 'checks:check' (to its readers).
 * Audit: check.<kind> (start), check.<kind>.cancel, check.<kind>.end.
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { createRateLimiter } from '../../lib/security.js';
import { scaledTimeouts } from '../jobs/runner.js';
import { CheckRunner, KINDS, publicCheck } from './runner.js';

const isAdmin = (u) => u?.role === 'admin';
const targetKey = (t) => `${t.host}:${t.port}`;

/**
 * @param options  test seam: { timeouts, wakeMs, retryMs, probeSeconds, pingRepeat, pingCellsMax, devicesAtOnce, linesCooldownMs, perMinute, now }
 */
export function createChecksModule({ config, logger, events, repos, audit, infra, services }, options = {}) {
  const log = logger.child('checks');
  const now = options.now ?? (() => Date.now());
  const linesCooldownMs = options.linesCooldownMs ?? 20_000;
  const perMinute = options.perMinute ?? 10;
  const allow = createRateLimiter({ limit: perMinute, windowMs: 60_000 });
  const lastLines = new Map(); // bench → when its line status last started

  const benches = () => services.benches;
  const isMember = (user, teamId) => Boolean(teamId && services.teams?.get?.(teamId)?.members?.includes(user?.id));

  /** May `user` read this check's result? */
  function readable(user, check) {
    if (!user?.id) return false;
    if (check.kind === 'lines') return true;
    return isAdmin(user) || check.actor?.id === user.id || isMember(user, check.teamId);
  }

  /** A check goes on device after device only while its actor may still run it */
  function mayGoOn(check) {
    const user = check.hidden.actorUser;
    return isAdmin(user) || Boolean(benches()?.canOperate?.(user, check.bench));
  }

  const runner = new CheckRunner({
    services, events, audit, repos, logger: log, readable, mayGoOn,
    options: {
      devicesAtOnce: options.devicesAtOnce ?? 5,
      timeouts: options.timeouts ?? scaledTimeouts(config.jobs?.timeScale ?? 1),
      wakeMs: options.wakeMs,
      retryMs: options.retryMs,
      probeSeconds: options.probeSeconds,
      pingRepeat: options.pingRepeat,
      pingCellsMax: options.pingCellsMax,
      now,
    },
  });

  // ── Benches and devices ───────────────────────────────────────────────────

  function lab(name) {
    const found = services.consoles?.registry?.model?.labs?.find((l) => l.name === name);
    if (!found) throw httpError(404, 'checks.unknown_bench', 'This bench does not exist.', { bench: String(name ?? '').slice(0, 40) });
    return found;
  }

  /** The bench's console devices a check may reach: on the allow-list, never an admin switch */
  function devicesOf(page, { routersOnly = false } = {}) {
    const admin = new Set((infra?.adminSwitches ?? []).map((s) => targetKey(s.target)));
    const registry = services.consoles?.registry;
    return page.devices
      .filter((d) => d.target && !admin.has(targetKey(d.target)))
      .map((d) => ({ ...(registry?.getDevice?.(d.key) ?? d), labName: page.name }))
      .filter((d) => d.allowed !== false)
      .filter((d) => !routersOnly || d.kind === 'router');
  }

  /** Why `user` may not run a check on `bench` (an HttpError), or null */
  function refusal(user, bench) {
    if (benches()?.canOperate?.(user, bench)) return null;
    const lock = benches()?.lock?.(bench);
    if (lock) return httpError(423, 'checks.locked', 'This bench is locked: only admins check it.', { reason: lock.reason });
    return httpError(403, 'checks.not_occupant', 'Only the occupants of this bench (and admins) run checks on it.', { bench });
  }

  /** The checks of `bench` this user may read, newest of each kind */
  const resultsFor = (user, bench) => Object.fromEntries(runner.lastOf(bench).filter((c) => readable(user, c)).map((c) => [c.kind, c]));

  // ── HTTP ──────────────────────────────────────────────────────────────────

  const router = express.Router();
  const json = express.json({ limit: '4kb' });
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  router.get('/latest', (req, res) => {
    noStore(res).json({ checks: runner.lastAll().filter((c) => readable(req.user, c)) });
  });

  router.get('/benches/:bench', (req, res) => {
    const page = lab(req.params.bench);
    const running = runner.running(page.name);
    noStore(res).json({
      bench: page.name,
      canRun: !refusal(req.user, page.name),
      running: running ? (readable(req.user, running) ? publicCheck(running) : summaryOf(running)) : null,
      results: resultsFor(req.user, page.name),
      routers: devicesOf(page, { routersOnly: true }).length,
      limits: { linesCooldownSeconds: Math.round(linesCooldownMs / 1000), perMinute },
    });
  });

  router.post('/benches/:bench/cancel', (req, res) => {
    const bench = lab(req.params.bench).name;
    const check = runner.running(bench);
    if (!check) throw httpError(404, 'checks.not_running', 'No check is running on this bench.');
    const may = isAdmin(req.user) || check.actor.id === req.user.id || benches()?.isOccupant?.(req.user, bench);
    if (!may) throw httpError(403, 'checks.cancel_forbidden', 'Only the person who started this check, the occupants of the bench and admins can stop it.');
    runner.cancel(check, req.user);
    res.json({ ok: true });
  });

  router.post('/benches/:bench/:kind', json, (req, res) => {
    const kind = req.params.kind;
    if (!KINDS.includes(kind)) throw httpError(404, 'checks.unknown_kind', 'There is no such check.', { kind: String(kind).slice(0, 20) });
    const page = lab(req.params.bench);
    const bench = page.name;
    const no = refusal(req.user, bench);
    if (no) throw no;
    if (services.jobs?.running?.(bench)) throw httpError(409, 'checks.job_running', 'A job is running on this bench: wait until it ends.');
    if (runner.running(bench)) {
      const other = runner.running(bench);
      throw httpError(409, 'checks.bench_busy', 'Another check is running on this bench.', { kind: other.kind, name: other.actor.name });
    }
    if (kind === 'lines') {
      const wait = (lastLines.get(bench) ?? -Infinity) + linesCooldownMs - now();
      if (wait > 0) throw httpError(429, 'checks.too_soon', 'The lines of this bench were just checked: try again in a moment.', { seconds: Math.ceil(wait / 1000) });
    }
    if (!allow(req.user.id)) throw httpError(429, 'checks.rate_limited', 'Too many checks: wait a minute.', { max: perMinute });
    const devices = devicesOf(page, { routersOnly: kind === 'ping' });
    if (!devices.length) throw httpError(400, kind === 'ping' ? 'checks.no_routers' : 'checks.no_devices', kind === 'ping' ? 'This bench has no router to ping from.' : 'This bench has no console device to check.');
    if (kind === 'lines') lastLines.set(bench, now());
    const holder = benches()?.holder?.(bench);
    const { check, refused } = runner.start({ kind, bench, actor: req.user, teamId: holder?.teamId ?? null, devices, lab: page });
    if (refused) throw httpError(refused.status, refused.code, refused.message, refused.params);
    res.status(202).json({ check: publicCheck(check) });
  });

  // What other modules may use (ARCHITECTURE §7)
  services.checks = {
    /** The check running on `bench`, or null: { id, kind, actor: { name }, devices } */
    running: (bench) => { const c = runner.running(bench); return c ? summaryOf(c) : null; },
  };

  return {
    id: 'checks',
    title: 'Bench checks',
    enabled: true,
    router,
    runner,
    async start() {
      await runner.load();
      events.publish('checks:running', { checks: [] }, { sticky: true });
    },
    shutdown() {
      runner.shutdown();
    },
  };
}

const summaryOf = (c) => ({ id: c.id, bench: c.bench, kind: c.kind, state: c.state, actor: { name: c.actor.name }, startedAt: c.startedAt, devices: c.devices.map((d) => ({ key: d.key, name: d.name, state: d.state })) });
