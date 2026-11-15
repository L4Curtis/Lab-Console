/**
 * Bench jobs settings (configuration fragment, see ARCHITECTURE §3)
 *
 *   config.jobs.devicesAtOnce     devices a job works on at the same time (five: one SSH channel each)
 *   config.jobs.countdownSeconds  a reset starts this long after it is asked for, cancellable meanwhile
 *   config.jobs.importMaxKb       largest ZIP accepted by a snapshot or template import
 *   config.jobs.timeScale         the driver's waiting budgets multiplied by this: 1 on the real lab
 *                                 (fifteen minutes for a boot); the simulator's devices boot in seconds,
 *                                 so a demonstration or a browser test may shorten them (0.05)
 */
import { int, str, fail } from '../../lib/env.js';

export function readConfig() {
  const rawScale = str('JOB_TIME_SCALE', '1');
  let timeScale = Number(rawScale);
  if (!Number.isFinite(timeScale) || timeScale < 0.001 || timeScale > 1) {
    fail(`JOB_TIME_SCALE must be a number between 0.001 and 1 (got "${rawScale}")`);
    timeScale = 1;
  }
  return {
    devicesAtOnce: int('JOB_DEVICES_AT_ONCE', 5, { min: 1, max: 20 }),
    countdownSeconds: int('JOB_COUNTDOWN_SECONDS', 10, { min: 1, max: 60 }),
    importMaxKb: int('JOB_IMPORT_MAX_KB', 2048, { min: 64, max: 20 * 1024 }),
    timeScale,
  };
}
