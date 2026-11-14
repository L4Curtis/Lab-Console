/**
 * Shared by the IOS tests: a simulated device wired to a CliAutomation and the
 * driver, with budgets scaled like the simulator's clock, and the round trip
 * (configure, capture, erase and reload, replay, capture again)
 */
import assert from 'node:assert/strict';
import { FakeIos } from '../../dev/fakeIos.js';
import { CliAutomation } from '../../src/lib/cliAutomation.js';
import { CiscoIos, toReplayScript } from '../../src/lib/drivers/ciscoIos.js';

/** Real budgets divided by about a thousand, like the simulator's clock (timeScale 0.002) */
export const FAST = {
  observeMs: 250, quietMs: 80, wakeWaitMs: 250, promptMs: 1500, pressReturnMs: 2000, commandMs: 6000, eraseMs: 2000,
  bootTotalMs: 15_000, bootIdleMs: 1200, pnpWaitMs: 2000, questionSettleMs: 250, nudgeQuietMs: 300, settleMs: 50,
};
export const QUICK = { delayMs: 0, chunkDelayMs: 1, lineTimeoutMs: 1500 };

/** What changes on every capture: the byte count and the "last change" comments */
export const volatile = (config) => config.split('\n').filter((l) => !/^(Current configuration :|! Last configuration change at|! NVRAM config last updated at)/.test(l)).join('\n');

export async function roundTrip(model, setup, { secret = null, rsaModulus = null, device = {} } = {}) {
  let cli;
  const dev = new FakeIos({ model, hostname: 'Factory', start: 'privileged', timeScale: 0.002, ...device, out: (s) => setImmediate(() => cli.feed(s)) });
  cli = new CliAutomation({ write: (s) => setImmediate(() => dev.input(s)) });
  const ios = new CiscoIos(cli, { timeouts: FAST });
  try {
    return await cli.perform('job:round-trip', async () => {
      // 1. A group configures the device (typed, like a student's script)
      const typed = await cli.sendScript(setup, { ...QUICK, skipComments: false });
      assert.deepEqual(typed.errors, [], `${model}: the setup script is valid IOS`);
      // 2. Backup
      assert.equal((await ios.prepare({ enablePasswords: secret ? [secret] : [] })).ok, true);
      const facts = await ios.identify();
      const before = await ios.runningConfig();
      const readVlans = async () => (facts.kind === 'switch' ? ios.vlans() : { vlans: [], vtp: null });
      const { vlans: vlansBefore, vtp: vtpBefore } = await readVlans();
      assert.equal(before.ok, true, before.message);
      // 3. Reset
      const reset = await ios.eraseAndReload({ backup: { kind: 'snapshot', snapshotId: 'rt', config: before.config, hostname: before.hostname }, facts });
      assert.equal(reset.ok, true, `${model}: ${reset.reason} at ${reset.stage}: ${reset.lastOutput}`);
      assert.match(reset.hostname, /^(Router|Switch)$/);
      // 4. Replay on the factory device
      const { script, dropped, lineTimeouts } = toReplayScript(before.config, { vlans: vlansBefore, vtp: vtpBefore, facts, rsaModulus });
      const sent = await cli.sendScript(script, { ...QUICK, skipComments: false, lineTimeouts });
      assert.deepEqual(sent.errors, [], `${model}: the replay is accepted line by line`);
      assert.deepEqual(sent.slow, []);
      // 5. Capture again
      assert.equal((await ios.prepare({ enablePasswords: secret ? [secret] : [] })).ok, true);
      const after = await ios.runningConfig();
      const { vlans: vlansAfter, vtp: vtpAfter } = await readVlans();
      return { before, after, vlansBefore, vlansAfter, vtpBefore, vtpAfter, dropped, dev, script, sent };
    });
  } finally {
    dev.stop();
  }
}

export const BACKUP = { kind: 'snapshot', snapshotId: '2026-11-12T22-00-00-bench', config: 'version 15.0\nhostname R1\nend\n' };

/** A device, the engine and the driver; `written()` is everything typed to the device */
export function rig({ timeouts = {}, ...opts } = {}) {
  let cli;
  let written = '';
  const dev = new FakeIos({ hostname: 'R1', timeScale: 0.002, ...opts, out: (s) => setImmediate(() => cli.feed(s)) });
  cli = new CliAutomation({ write: (s) => { written += s; setImmediate(() => dev.input(s)); }, sendBreak: () => { written += '<BREAK>'; setImmediate(() => dev.sendBreak()); } });
  const progress = [];
  const ios = new CiscoIos(cli, { timeouts: { ...FAST, ...timeouts }, progress: (m, p) => progress.push(p.code) });
  return { dev, cli, ios, progress, written: () => written, done: () => dev.stop() };
}
