/**
 * What the task runners (jobs, checks) share about one device's outcome
 */

/** A task's states once it is over */
export const FINAL = new Set(['done', 'failed', 'cancelled', 'partial']);

/**
 * A device stops here; `outcome` is 'failed' or 'skipped'. `r` is a driver's
 * answer ({ reason | code, message, params, stage, lastOutput }); `extra`
 * adds the stage and what the device did before it stopped (a job's report
 * keeps it). Without a code, the runner records its own "device failed"
 */
export class DeviceStop extends Error {
  constructor(outcome, r, extra = {}) {
    super(r?.message ?? 'stopped');
    this.outcome = outcome;
    this.code = r?.reason ?? r?.code ?? null;
    this.params = r?.params ?? {};
    this.stage = r?.stage ?? extra.stage ?? null;
    this.lastOutput = r?.lastOutput ?? null;
    this.result = extra.result ?? null;
  }
}
