/**
 * Test helpers for the bench checks: the mock lab behind the diagram's bench
 * B4M, cabled as the diagram draws it (dev/mockCabling.js), the application
 * with the consoles, teams, jobs and checks modules, a JSON client per user,
 * and waiting for a check to end
 *
 *   const c = await startChecksApp();      // { lab, app, api(who, method, path, body), dev(name), key(name), until(bench), … }
 *   await c.holdBench('student1');
 *   const { body } = await c.api('student1', 'POST', '/api/checks/benches/B4M/cabling');
 *   const check = await c.until('B4M');
 */
import { cablesFromLabs } from '../../dev/mockCabling.js';
import { createChecksModule } from '../../src/modules/checks/index.js';
import { startJobsApp, benchDiagram, JOB_TIMEOUTS, waitFor } from './jobs.js';

export { waitFor };

/** B4M for the checks: classic routers, three kinds of switches and one that does not run Cisco IOS */
export const CHECK_MODELS = {
  R1: { model: '2811' },
  R2: { model: '2811' },
  R3: { model: '2801' },
  R4: { model: '1841' },
  R5: { model: '2811' },
  S1: { model: '2960' },
  S2: { model: '3560' },
  S3: { model: '2960' },
  S5: { model: 'c1000' },
  S4: { model: 'aruba' },
};

/**
 * The jobs application (helpers/jobs.js) with the checks module; `extra(deps)`: more modules
 * (one or a list), created after the checks module
 */
export async function startChecksApp({ models = CHECK_MODELS, lab: labOptions = {}, checks = {}, cabling = true, env = {}, extra = null } = {}) {
  const { labs } = benchDiagram();
  const j = await startJobsApp({
    models,
    env,
    countdownMs: 4000,
    lab: { links: cabling ? cablesFromLabs(labs.filter((l) => l.name === 'B4M')) : [], ...labOptions },
    extra: (deps) => [
      createChecksModule(deps, { timeouts: JOB_TIMEOUTS, wakeMs: 1500, probeSeconds: 1, pingRepeat: 2, linesCooldownMs: 60_000, perMinute: 100, ...checks }),
      ...(extra ? [extra(deps)].flat() : []),
    ],
  });
  const module = j.modules.find((m) => m.id === 'checks');
  const targetOf = (name) => { const d = j.device(name); return `${d.target.host}:${d.target.port}`; };
  return {
    ...j,
    module,
    runner: module.runner,
    targetOf,
    port: (name) => j.device(name).target.port,
    /** Wait until no check runs on `bench`; → the last one of `kind` as the runner keeps it */
    async until(bench, kind, timeoutMs = 40_000) {
      await waitFor(() => !module.runner.running(bench), { ms: timeoutMs, what: `the check of ${bench} to end` });
      return module.runner.last(bench, kind);
    },
  };
}

/** A device's entry in a result's `devices` */
export const entryOf = (check, name) => (check.result.devices ?? check.result.routers).find((d) => d.name === name);
