/**
 * Password recovery module (SPEC "Lot recovery", ARCHITECTURE §9c): the
 * guided recovery of a device left locked by a console line password or an
 * enable secret nobody knows. Someone on site power-cycles the device when
 * the assistant says so; the application interrupts the boot, makes the
 * device start without its startup-config (bypassed, never erased) and
 * leaves it at a clean prompt; the team then injects a backup or starts
 * afresh (the jobs).
 *
 * HTTP (/api/recovery), every route behind the sign-in gate:
 *   GET  /families                     the device families and their steps
 *   GET  /devices/:key                 one device: may this user recover it (or why not), the
 *                                      recovery under way, the last ones of this device
 *   POST /devices/:key/start           { family }                   → 202 { recovery }
 *   GET  /runs?bench=                  the recoveries this user may see, newest first
 *   GET  /runs/:id
 *   POST /runs/:id/confirm             { step }   the next step, by the person who started it
 *   POST /runs/:id/cancel              its actor, the occupants of the bench, admins (the device
 *                                      is put back first: a second cancel meanwhile is refused)
 *
 * Who may start one: services.benches.canOperate(user, bench) (the occupants
 * of an unlocked bench, and admins), as for the jobs; never an admin switch;
 * a device whose console line other benches use only while those benches are
 * free, or held by the same team (admins are not refused); not while a job
 * or a bench check runs on the bench. Who sees one: its actor, the occupants of the bench, the
 * team that held the bench, admins.
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { FAMILIES, STEPS, HANDS_ON, scaledRecoveryTimeouts } from '../../lib/drivers/ciscoRecovery.js';
import { RecoveryRunner, publicRecovery } from './assistant.js';

const isAdmin = (u) => u?.role === 'admin';
const targetKey = (t) => `${t.host}:${t.port}`;
const ID = /^[0-9a-f-]{36}$/;

/**
 * @param options  test seam: { timeouts, pollMs, now }
 */
export function createRecoveryModule({ config, logger, events, repos, audit, infra, services }, options = {}) {
  const log = logger.child('recovery');
  const benches = () => services.benches;
  const teamOf = (user) => services.teams?.teamOf?.(user) ?? null;
  const isMember = (user, teamId) => Boolean(teamId && services.teams?.get?.(teamId)?.members?.includes(user?.id));

  /** May `user` follow `rec`: its actor, the bench's occupants, the team that held it, admins */
  function viewOf(user, rec) {
    if (!user?.id) return false;
    return isAdmin(user) || rec.actor?.id === user.id || Boolean(benches()?.isOccupant?.(user, rec.bench)) || isMember(user, rec.teamId);
  }

  /** `user` with the role the directory gives the account now, when it knows it */
  function asNow(user) {
    const role = user?.id ? services.accounts?.get?.(user.id)?.role : null;
    return role ? { ...user, role } : user;
  }

  /**
   * May the actor still go on with it (asked before every step). The actor
   * is the person as they last confirmed, with the directory's current role:
   * a demoted administrator does not keep the rights they started with
   */
  function mayGoOn(rec) {
    const user = asNow(rec.hidden.actorUser);
    if (isAdmin(user)) return true;
    return Boolean(benches()?.canOperate?.(user, rec.bench)) && !sharedConflict(user, rec.hidden.device);
  }

  const runner = new RecoveryRunner({
    services, events, audit, repos, logger: log, mayGoOn, viewOf,
    options: {
      timeouts: options.timeouts ?? scaledRecoveryTimeouts(config.jobs?.timeScale ?? 1),
      pollMs: options.pollMs,
      now: options.now,
      shutdownMs: options.shutdownMs,
    },
  });

  // ── Devices ───────────────────────────────────────────────────────────────

  /** The registry's device behind `key`, never an admin switch */
  function deviceOf(key) {
    const d = typeof key === 'string' && key.length <= 200 ? services.consoles?.registry?.getDevice?.(key) : null;
    const admin = new Set((infra?.adminSwitches ?? []).map((s) => targetKey(s.target)));
    if (!d || !d.target || admin.has(targetKey(d.target))) throw httpError(404, 'recovery.unknown_device', 'There is no such device.');
    return d;
  }

  /**
   * A device whose console line another bench uses, while that bench is not
   * free, or locked, or held by another team: the refusal, or null. Admins are never refused
   */
  function sharedConflict(user, device) {
    if (isAdmin(user)) return null;
    const key = targetKey(device.target);
    if (!services.consoles?.sharedTargets?.()?.has(key)) return null;
    const mine = teamOf(user)?.id ?? null;
    for (const other of services.consoles?.registry?.model?.labs ?? []) {
      if (other.name === device.labName || !other.devices?.some((x) => x.target && targetKey(x.target) === key)) continue;
      const holder = benches()?.holder?.(other.name);
      if (benches()?.lock?.(other.name) || (holder && holder.teamId !== mine)) {
        return httpError(409, 'recovery.shared_in_use', 'This device shares its console line with a bench another team holds: it is left alone.', { device: device.name, bench: other.name });
      }
    }
    return null;
  }

  /** Why `user` may not recover `device` (an HttpError), or null */
  function refusal(user, device) {
    const bench = device.labName;
    if (!benches()?.canOperate?.(user, bench)) {
      const lock = benches()?.lock?.(bench);
      if (lock) return httpError(423, 'recovery.locked', 'This bench is locked: nobody but admins works on it.', { reason: lock.reason });
      return httpError(403, 'recovery.not_occupant', 'Only the occupants of this bench (and admins) recover its devices.', { bench });
    }
    const shared = sharedConflict(user, device);
    if (shared) return shared;
    const job = services.jobs?.running?.(bench);
    if (job) return httpError(409, 'recovery.job_running', 'A job is running on this bench: wait for it to end.', { kind: job.kind });
    // A check types on the bench's free lines one after the other: a recovery would race it for a device
    const check = services.checks?.running?.(bench);
    if (check) return httpError(409, 'recovery.check_running', 'A check is running on this bench: wait for it to end.', { kind: check.kind, name: check.actor.name });
    const busy = runner.running(device.key);
    if (busy) return httpError(409, 'recovery.busy', 'A recovery of this device is already under way.', { name: busy.actor.name });
    return null;
  }

  async function recoveryOf(user, id) {
    if (typeof id !== 'string' || !ID.test(id)) throw httpError(404, 'recovery.no_recovery', 'There is no such recovery.');
    const rec = runner.get(id) ?? await repos.recoveries.get(id);
    if (!rec) throw httpError(404, 'recovery.no_recovery', 'There is no such recovery.');
    if (!viewOf(user, rec)) throw httpError(403, 'recovery.forbidden', 'This recovery is not yours to follow.');
    return rec;
  }
  const view = (rec) => (rec.hidden ? publicRecovery(rec) : rec);

  /** Live and stored recoveries this user may see, newest first */
  async function visible(user, { bench, device, limit = 20 } = {}) {
    const live = runner.recent({ bench, device });
    const ids = new Set(live.map((r) => r.id));
    const stored = (await repos.recoveries.list({ bench, device, limit })).filter((r) => !ids.has(r.id));
    return [...live, ...stored].filter((r) => viewOf(user, r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(view);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  const router = express.Router();
  const json = express.json({ limit: '2kb' });
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  router.get('/families', (_req, res) => {
    noStore(res).json({ families: familyList() });
  });

  router.get('/devices/:key', async (req, res) => {
    const device = deviceOf(req.params.key);
    const no = refusal(req.user, device);
    const running = runner.running(device.key);
    const last = running ? null : (await repos.recoveries.list({ device: device.key, limit: 1 }))[0];
    noStore(res).json({
      device: { key: device.key, name: device.name, bench: device.labName },
      families: familyList(),
      canStart: !no,
      refusal: no ? { code: no.code, params: no.params ?? {} } : null,
      running: running ? (viewOf(req.user, running) ? view(running) : { id: running.id, state: running.state, actor: { name: running.actor.name } }) : null,
      history: await visible(req.user, { device: device.key, limit: 5 }),
      // What the last recovery of this device left in place (the next one puts it back)
      left: running ? null : last?.bypassed ?? null,
      // Put back without booting (the server was stopping): where it was left ('rommon' | 'bootLoader')
      halted: !running && last?.putBack?.ok && !last.putBack.booted && ['rommon', 'bootLoader'].includes(last.putBack.at) ? last.putBack.at : null,
    });
  });

  router.post('/devices/:key/start', json, (req, res) => {
    const device = deviceOf(req.params.key);
    const no = refusal(req.user, device);
    if (no) throw no;
    const family = typeof req.body?.family === 'string' ? req.body.family : '';
    const { recovery, refused } = runner.start({ actor: req.user, device, family, teamId: benches()?.holder?.(device.labName)?.teamId ?? null });
    if (refused) throw httpError(refused.status, refused.code, refused.message, refused.params);
    res.status(202).json({ recovery: view(recovery) });
  });

  router.get('/runs', async (req, res) => {
    const bench = typeof req.query.bench === 'string' && req.query.bench.length <= 60 ? req.query.bench : undefined;
    noStore(res).json({ recoveries: await visible(req.user, { bench, limit: 50 }) });
  });

  router.get('/runs/:id', async (req, res) => {
    noStore(res).json({ recovery: view(await recoveryOf(req.user, req.params.id)) });
  });

  router.post('/runs/:id/confirm', json, async (req, res) => {
    const rec = await recoveryOf(req.user, req.params.id);
    const live = runner.get(rec.id);
    if (!live) throw httpError(409, 'recovery.over', 'This recovery is over.');
    const step = typeof req.body?.step === 'string' ? req.body.step : '';
    const no = runner.confirm(live, req.user, step);
    if (no) throw httpError(no.status, no.code, no.message, no.params ?? {});
    res.json({ recovery: view(live) });
  });

  router.post('/runs/:id/cancel', async (req, res) => {
    const rec = await recoveryOf(req.user, req.params.id);
    const live = runner.get(rec.id);
    if (!live || ['done', 'failed', 'cancelled'].includes(live.state)) throw httpError(409, 'recovery.over', 'This recovery is over.');
    if (!(isAdmin(req.user) || live.actor.id === req.user.id || benches()?.canOperate?.(req.user, live.bench))) {
      throw httpError(403, 'recovery.cancel_forbidden', 'Only the person who started the recovery, the occupants of the bench and admins may stop it.');
    }
    const no = runner.cancel(live, req.user);
    if (no) throw httpError(no.status, no.code, no.message);
    res.json({ recovery: view(live) });
  });

  services.recovery = {
    /** The recovery under way on a device (as everyone may know it), or null */
    running: (deviceKey) => runner.summary().find((r) => r.device.key === deviceKey) ?? null,
  };

  return {
    id: 'recovery',
    title: 'Password recovery',
    enabled: true,
    router,
    runner,
    async start() {
      // Recoveries a stopped server left open: they did not finish, say so (what they left
      // bypassed stays in the row: the next recovery of the device puts it back)
      for (const rec of await repos.recoveries.unfinished()) {
        const steps = rec.steps.map((s) => (['running', 'pending'].includes(s.state) ? { ...s, state: s.state === 'running' ? 'failed' : 'not_run' } : s));
        await repos.recoveries.save({ ...rec, state: 'failed', code: 'recovery.interrupted', steps, endedAt: new Date().toISOString() });
      }
      events.publish('recovery:running', runner.summary(), { sticky: true });
    },
    // At close, before the consoles module closes the rooms: each recovery puts its device back
    drain() {
      return runner.shutdown();
    },
    shutdown() {
      return runner.shutdown(); // nothing left once drain() ran (an app closed without it, a test)
    },
  };
}

/** The families, their kind and steps, for the browser */
function familyList() {
  return Object.entries(FAMILIES).map(([id, f]) => ({ id, kind: f.kind, models: f.models, software: f.software, triedOnLab: f.triedOnLab, steps: STEPS[f.method], handsOn: STEPS[f.method].filter((s) => HANDS_ON.has(s)) }));
}
