/**
 * Test helpers for the password recovery: the jobs application (helpers/jobs.js)
 * with the recovery module, B4M's devices locked in the ways the real lab
 * finds them, and the person on site who power-cycles a device when told
 *
 *   const r = await startRecoveryApp();        // { j, recovery, start(who, name, family), awaiting(id, step), walk(…), … }
 *   const s = await r.start('student1', 'R1', 'isr_g1');
 *   await r.walk(s.body.recovery.id, r.j.dev('R1'), ['power_cycle', 'confreg'], 'boot');
 */
import assert from 'node:assert/strict';
import { createRecoveryModule } from '../../src/modules/recovery/index.js';
import { startJobsApp, waitFor, JOB_TIMEOUTS } from './jobs.js';

// The simulator's clock runs fifty times faster than the real one: boots take seconds,
// long enough for BREAKs sent through telnet's command mode to land in the boot
const SLOW = { timeScale: 0.02 };
export const MODELS = {
  R1: { model: '2811', start: 'linepass', linePassword: 'left-by-a-group', ...SLOW },
  R2: { model: 'isr4331', enableSecret: 'lost', ...SLOW },
  S1: { model: '3560', start: 'linepass', linePassword: 'left-by-a-group', ...SLOW },
  S2: { model: 'c9300l', enableSecret: 'lost', hostname: 'SW1-3005' },
  R3: { model: '1841', start: 'privileged', hostname: 'R3-3005', ...SLOW },
  R4: { model: '2801', start: 'linepass', linePassword: 'left-by-a-group', hostname: 'R4-3009', ...SLOW },
  R5: { model: '2811', start: 'linepass', linePassword: 'left-by-a-group', hostname: 'R5-3008', ...SLOW },
  S3: { model: '2960', start: 'linepass', linePassword: 'left-by-a-group', hostname: 'S3-3010', ...SLOW },
};
export const RECOVERY_TIMEOUTS = {
  ...JOB_TIMEOUTS, powerOnMs: 6000, breakEveryMs: 300, breakWindowMs: 5000, bootLoaderMs: 8000, flashInitMs: 5000, monitorMs: 3000, confirmMs: 15_000,
};

/** Booted with its own startup-config: not in ROMMON, not at switch:, its own hostname */
export const bootedOwn = (dev, host) => !dev.inBoot && ['linepass', 'exec', 'pressreturn', 'idle'].includes(dev.state) && dev.cfg.hostname === host;

/** Switched off and on, the device boots its own startup-config (locked again) */
export async function bootOwn(dev) {
  dev.powerCycle();
  await waitFor(() => !dev.inBoot && ['pressreturn', 'linepass', 'idle', 'exec'].includes(dev.state), { ms: 20_000, what: 'the device to boot' });
}

/** The application with the recovery module; student1's team holds B4M */
export async function startRecoveryApp() {
  let recovery;
  const j = await startJobsApp({
    models: MODELS,
    extra: (deps) => {
      recovery = createRecoveryModule(deps, { timeouts: RECOVERY_TIMEOUTS, pollMs: 20 });
      return recovery;
    },
  });
  await j.holdBench('student1');

  const live = (id) => recovery.runner.get(id);
  const until = (id, check, what, ms = 20_000) => waitFor(() => { const r = live(id); return r && check(r) ? r : null; }, { ms, what });
  const awaiting = (id, step) => until(id, (r) => r.state === 'awaiting' && r.awaiting === step, `awaiting ${step}`);
  const ended = (id) => until(id, (r) => ['done', 'failed', 'cancelled'].includes(r.state), 'the end', 60_000);
  const confirm = (who, id, step) => j.api(who, 'POST', `/api/recovery/runs/${id}/confirm`, { step });
  const start = (who, name, family, bench) => j.api(who, 'POST', `/api/recovery/devices/${encodeURIComponent(j.key(name, bench))}/start`, { family });

  /** The person on site: power-cycles the device once the assistant says "now" */
  async function personPowerCycles(id, dev, modeButton = false) {
    await until(id, (r) => r.current === 'power_cycle' && r.progress?.code === 'recovery.progress.power_now', 'power now');
    dev.powerCycle({ modeButton });
  }

  /** Confirm each step of `steps` in turn (the person power-cycling when asked), then wait for `next` */
  async function walk(id, dev, steps, next, { mode = false } = {}) {
    for (const step of steps) {
      await awaiting(id, step);
      assert.equal((await confirm('student1', id, step)).status, 200);
      if (step === 'power_cycle') await personPowerCycles(id, dev, mode);
    }
    return awaiting(id, next);
  }

  return { j, recovery, live, until, awaiting, ended, confirm, start, personPowerCycles, walk };
}
