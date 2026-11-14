/**
 * Bench jobs module: backup, injection, reset, comparison with the live
 * devices; snapshots (list, read, diff, ZIP, import, search); TP templates
 * and the base configuration; the TP folder; the backup offered when a bench
 * is released (SPEC "Lot jobs")
 *
 * HTTP (/api/jobs), every route behind the sign-in gate:
 *   GET  /benches/:bench                 devices (shared ones marked, admin switches never), people on
 *                                        their consoles, the job running, the base configuration, the
 *                                        backup offer of a release, what this user may do
 *   POST /benches/:bench/backup          { devices?, label?, enablePasswords?, linePasswords? }
 *   POST /benches/:bench/reset           { devices, confirm: '<bench>', forceErase?, applyBase?, save?, … }   starts after a countdown
 *   POST /benches/:bench/preview         { source: { snapshot | template }, devices?, rsaModulus? } → each device's exact script
 *   POST /benches/:bench/inject          { source, devices?, mode: 'reset' | 'merge', save?, rsaModulus?, scripts: { key: sha256 }, confirm? }
 *   POST /benches/:bench/compare         { snapshot, devices? }   a snapshot against the live devices
 *   GET  /benches/:bench/folder?snapshot=  the TP folder: final configurations and console journals, one ZIP
 *   GET  /runs?bench= · GET /runs/:id · POST /runs/:id/cancel
 *   GET  /snapshots?bench= · GET /snapshots/search?q= · GET /snapshots/:id · GET /snapshots/:id/devices/:device[?vlans=1]
 *   GET  /snapshots/:id/zip · GET /snapshots/:a/diff/:b[?device=] · POST /snapshots/import?bench=&label= (a ZIP) · DELETE /snapshots/:id
 *   GET  /templates · GET /templates/:id · GET /templates/:id/devices/:device
 *   POST /templates { name, description, snapshot?, devices?, configs? } · POST /templates/import?name=&description= (a ZIP)
 *   PUT  /templates/:id { name?, description?, base? } · DELETE /templates/:id          (templates: admins write, everyone reads)
 *
 * Who may run, follow and see a job: permissions.js. One job per bench, and
 * none while a bench check runs (services.checks.running). The routes are in
 * routes/benches.js (benches, runs) and routes/library.js (snapshots,
 * templates); the request input in input.js.
 * SSE: 'jobs:running' (sticky, everyone: which bench runs what, device by
 * device), 'jobs:job' (the job, to those who may see it), 'jobs:done' (once
 * per finished job, to the bench's occupants: { bench, jobId, kind, ok, state }).
 */
import express from 'express';
import { createBenchAccess } from '../teams/access.js';
import { Library } from './library.js';
import { JobRunner, scaledTimeouts, redactedJob } from './runner.js';
import { createJobPermissions } from './permissions.js';
import { benchRoutes } from './routes/benches.js';
import { libraryRoutes } from './routes/library.js';

const KINDS = ['backup', 'reset', 'inject', 'compare'];

/**
 * @param options  test seam: { timeouts (driver budgets), pacing (script typing), countdownMs, devicesAtOnce, now }
 */
export function createJobsModule({ config, logger, events, store, repos, audit, infra, services }, options = {}) {
  const cfg = config.jobs ?? { devicesAtOnce: 5, countdownSeconds: 10, importMaxKb: 2048, timeScale: 1 };
  const now = options.now ?? (() => Date.now());
  const access = createBenchAccess({ services, infra, prefix: 'jobs' });
  const library = new Library({ store, repos, services, audit, events, now });
  const perms = createJobPermissions({ services, access, library, now });
  const runner = new JobRunner({
    services, events, audit, repos, library, logger: logger.child('jobs'),
    viewOf: perms.viewOf, mayGoOn: perms.mayGoOn, currentUser: access.currentUser,
    options: {
      devicesAtOnce: options.devicesAtOnce ?? cfg.devicesAtOnce,
      countdownMs: options.countdownMs ?? cfg.countdownSeconds * 1000,
      timeouts: options.timeouts ?? scaledTimeouts(cfg.timeScale),
      pacing: options.pacing,
      now,
    },
  });

  const router = express.Router();
  router.use(benchRoutes({ services, store, audit, repos, access, perms, runner, library }));
  router.use(libraryRoutes({ store, audit, access, library, importMaxKb: cfg.importMaxKb }));

  // What other modules may use (ARCHITECTURE §7)
  services.jobs = {
    /** The job holding a bench (pending or running), as everyone may see it, or null */
    running: (labName) => runner.summary().jobs.find((j) => j.bench === labName) ?? null,
    /** Recent jobs (in memory), newest first, without a line of configuration (redactedJob) */
    list: ({ bench } = {}) => runner.recent(bench).map(redactedJob),
    kinds: KINDS,
    /** A team's snapshots as `user` may see them (its members and admins), newest first: the home page's "latest backups" */
    snapshots: async (user, { teamId, limit = 5 } = {}) => (teamId
      ? (await library.listSnapshots(user, { teamId, limit })).map((s) => library.view(s))
      : []),
  };

  let offRelease = null;
  return {
    id: 'jobs',
    title: 'Bench jobs',
    enabled: true,
    router,
    runner,
    library,
    offers: perms.offers,
    async start() {
      // Jobs a stopped server left behind: they did not finish, say so
      for (const job of await repos.jobs.unfinished()) {
        const devices = job.devices.map((d) => (['queued', 'waiting', 'running'].includes(d.state) ? { ...d, state: 'failed', code: 'jobs.interrupted', step: null } : d));
        await repos.jobs.save({ ...job, state: 'failed', devices, endedAt: new Date(now()).toISOString() });
      }
      events.publish('jobs:running', runner.summary(), { sticky: true });
      // A release offers a backup to the team that let the bench go
      offRelease = services.benches?.onRelease?.(({ labName, teamId }) => {
        if (!teamId) return null;
        perms.offer(labName, teamId);
        return { kind: 'backup', bench: labName, href: `#/jobs/${encodeURIComponent(labName)}/backup` };
      }) ?? null;
    },
    shutdown() {
      offRelease?.();
      runner.shutdown();
    },
  };
}
