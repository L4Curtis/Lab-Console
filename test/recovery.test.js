/**
 * The password recovery assistant through the real application and the mock
 * lab (SSH jump server, console server, telnet BREAK): a router locked by a
 * console line password walked through every step, each confirmed; a switch
 * whose Mode button was released too early, then recovered; who may start,
 * confirm, follow and stop a recovery, and every refusal; cancellation; the
 * audit trail and the database row; a recovery left open by a stopped server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startJobsApp, waitFor, JOB_TIMEOUTS } from './helpers/jobs.js';
import { createRecoveryModule } from '../src/modules/recovery/index.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger } from './helpers/fakes.js';

// The simulator's clock runs fifty times faster than the real one: boots take seconds,
// long enough for BREAKs sent through telnet's command mode to land in the boot
const SLOW = { timeScale: 0.02 };
const MODELS = {
  R1: { model: '2811', start: 'linepass', linePassword: 'left-by-a-group', ...SLOW },
  R2: { model: 'isr4331', enableSecret: 'lost', ...SLOW },
  S1: { model: '3560', start: 'linepass', linePassword: 'left-by-a-group', ...SLOW },
  S2: { model: 'c9300l' },
};
export const RECOVERY_TIMEOUTS = {
  ...JOB_TIMEOUTS, powerOnMs: 6000, breakEveryMs: 300, breakWindowMs: 5000, bootLoaderMs: 8000, flashInitMs: 5000, monitorMs: 3000, confirmMs: 15_000,
};

let j;
let recovery;
before(async () => {
  j = await startJobsApp({
    models: MODELS,
    extra: (deps) => {
      recovery = createRecoveryModule(deps, { timeouts: RECOVERY_TIMEOUTS, pollMs: 20 });
      return recovery;
    },
  });
  await j.holdBench('student1');
});
after(() => j?.close());

const live = (id) => recovery.runner.get(id);
const until = (id, check, what, ms = 20_000) => waitFor(() => { const r = live(id); return r && check(r) ? r : null; }, ms, what);
const awaiting = (id, step) => until(id, (r) => r.state === 'awaiting' && r.awaiting === step, `awaiting ${step}`);
const ended = (id) => until(id, (r) => ['done', 'failed', 'cancelled'].includes(r.state), 'the end', 60_000);
const confirm = (who, id, step) => j.api(who, 'POST', `/api/recovery/runs/${id}/confirm`, { step });
const start = (who, name, family, bench) => j.api(who, 'POST', `/api/recovery/devices/${encodeURIComponent(j.key(name, bench))}/start`, { family });

/** The person on site: power-cycles the device once the assistant says "now" */
async function personPowerCycles(id, dev, modeButton = false) {
  await until(id, (r) => r.current === 'power_cycle' && r.progress?.code === 'recovery.progress.power_now', 'power now');
  dev.powerCycle({ modeButton });
}

test('a router locked by its console line password, walked through every step, each confirmed', async () => {
  const r1 = j.dev('R1');
  const info = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('R1'))}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.canStart, true);
  assert.equal(info.body.device.name, 'R1');
  assert.ok(info.body.families.some((f) => f.id === 'isr_g1' && f.handsOn.includes('power_cycle')));

  const s = await start('student1', 'R1', 'isr_g1');
  assert.equal(s.status, 202, JSON.stringify(s.body));
  const id = s.body.recovery.id;
  // Read the console first, then wait for the person
  let rec = await awaiting(id, 'power_cycle');
  assert.equal(rec.look.state, 'password');
  assert.deepEqual(rec.steps.map((x) => [x.id, x.state]), [['look', 'done'], ['power_cycle', 'pending'], ['confreg', 'pending'], ['boot', 'pending'], ['restore_register', 'pending']]);

  // Someone else follows nothing, confirms nothing; the actor confirms the step on screen only
  assert.equal((await j.api('student2', 'GET', `/api/recovery/runs/${id}`)).status, 403);
  assert.equal((await confirm('student2', id, 'power_cycle')).status, 403);
  assert.equal((await confirm('admin', id, 'power_cycle')).body.code, 'recovery.confirm_forbidden');
  assert.equal((await confirm('student1', id, 'confreg')).body.code, 'recovery.not_awaiting');
  assert.equal(r1.powerCycles, 0);

  const c = await confirm('student1', id, 'power_cycle');
  assert.equal(c.status, 200);
  await personPowerCycles(id, r1);
  rec = await awaiting(id, 'confreg');
  assert.equal(r1.state, 'rommon');
  assert.ok(rec.steps.find((x) => x.id === 'power_cycle').result.breaks >= 1);
  assert.equal(r1.nextConfReg, null, 'nothing is typed before the confirmation');

  await confirm('student1', id, 'confreg');
  await awaiting(id, 'boot');
  assert.equal(r1.nextConfReg, '0x2142');
  await confirm('student1', id, 'boot');
  await awaiting(id, 'restore_register');
  assert.equal(r1.cfg.hostname, 'Router');
  await confirm('student1', id, 'restore_register');
  rec = await ended(id);
  assert.equal(rec.state, 'done', JSON.stringify(rec.error));
  assert.equal(r1.mode, '#');
  assert.equal(r1.nextConfReg, '0x2102');
  assert.ok(r1.startup.blocks.find((b) => b.head === 'line con 0').lines.includes('password left-by-a-group'), 'the startup-config is bypassed, not changed');

  // Followed by the occupants and admins, saved, audited step by step
  const got = await j.api('admin', 'GET', `/api/recovery/runs/${id}`);
  assert.equal(got.body.recovery.state, 'done');
  const stored = await j.app.deps.repos.recoveries.get(id);
  assert.equal(stored.state, 'done');
  assert.equal(stored.device.name, 'R1');
  assert.equal(stored.actor.username, 'student1');
  assert.deepEqual(stored.steps.map((x) => x.state), ['done', 'done', 'done', 'done', 'done']);
  const entries = () => j.app.deps.repos.audit.query({ actions: ['recovery'], limit: 200 });
  await waitFor(async () => (await entries()).some((e) => e.action === 'recovery.end' && e.details?.recovery === id), 5000, 'the audit entries');
  const actions = (await entries()).filter((e) => e.details?.recovery === id).map((e) => e.action);
  for (const a of ['recovery.start', 'recovery.confirm', 'recovery.step', 'recovery.end']) assert.ok(actions.includes(a), `${a} in ${actions.join(', ')}`);
  assert.equal(actions.filter((a) => a === 'recovery.confirm').length, 4);
  const list = await j.api('student1', 'GET', '/api/recovery/runs?bench=B4M');
  assert.ok(list.body.recoveries.some((x) => x.id === id));
  assert.equal((await j.api('student2', 'GET', '/api/recovery/runs?bench=B4M')).body.recoveries.length, 0);
});

test('a switch: Mode released too early, the same step again, then flash_init, config.text parked and put back', async () => {
  const s1 = j.dev('S1');
  const s = await start('student1', 'S1', 'catalyst');
  assert.equal(s.status, 202, JSON.stringify(s.body));
  const id = s.body.recovery.id;
  await awaiting(id, 'power_cycle');
  await confirm('student1', id, 'power_cycle');
  await personPowerCycles(id, s1, false);
  let rec = await until(id, (r) => r.state === 'awaiting' && r.error, 'the retry');
  assert.equal(rec.awaiting, 'power_cycle');
  assert.equal(rec.error.code, 'recovery.mode_missed');
  assert.equal(rec.error.retry, true);
  await confirm('student1', id, 'power_cycle');
  await personPowerCycles(id, s1, true);
  for (const step of ['flash_init', 'park_config', 'boot', 'restore_config']) {
    await awaiting(id, step);
    await confirm('student1', id, step);
  }
  rec = await ended(id);
  assert.equal(rec.state, 'done', JSON.stringify(rec.error));
  assert.equal(rec.steps.find((x) => x.id === 'power_cycle').tries, 2);
  assert.equal(s1.cfg.hostname, 'Switch');
  assert.equal(s1.parked, null);
  assert.ok(s1.startup, 'config.text is back');
});

test('who may start a recovery: nobody, another student, a bad family, an unknown device, a locked bench', async () => {
  const key = encodeURIComponent(j.key('R2'));
  assert.equal((await j.api(null, 'POST', `/api/recovery/devices/${key}/start`, { family: 'isr4300' })).status, 401);
  assert.equal((await j.api(null, 'GET', `/api/recovery/devices/${key}`)).status, 401);
  const other = await start('student2', 'R2', 'isr4300');
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'recovery.not_occupant');
  const view = await j.api('student2', 'GET', `/api/recovery/devices/${key}`);
  assert.equal(view.body.canStart, false);
  assert.equal(view.body.refusal.code, 'recovery.not_occupant');
  assert.equal((await start('student1', 'R2', 'nope')).body.code, 'recovery.bad_family');
  assert.equal((await start('student1', 'R2', 'nope')).status, 400);
  assert.equal((await j.api('student1', 'POST', '/api/recovery/devices/no%3Adevice/start', { family: 'isr_g1' })).status, 404);
  assert.equal((await j.api('student1', 'GET', '/api/recovery/runs/not-an-id')).status, 404);
  assert.equal((await j.api('student1', 'POST', '/api/recovery/runs/00000000-0000-0000-0000-000000000000/confirm', { step: 'look' })).status, 404);
  // A locked bench: its occupants wait, admins do not
  assert.equal((await j.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'maintenance' })).status, 200);
  try {
    const locked = await start('student1', 'R2', 'isr4300');
    assert.equal(locked.status, 423);
    assert.equal(locked.body.code, 'recovery.locked');
  } finally {
    await j.api('admin', 'DELETE', '/api/benches/B4M/lock');
  }
  assert.equal((await j.api('student1', 'GET', '/api/recovery/families')).body.families.length, 5);
});

test('one recovery per device; not while a job runs on the bench; stopped by an occupant or an admin, not by others', async () => {
  const s = await start('student1', 'R2', 'isr4300');
  assert.equal(s.status, 202);
  const id = s.body.recovery.id;
  await awaiting(id, 'power_cycle');
  const again = await start('admin', 'R2', 'isr4300');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'recovery.busy');
  // The device is held: a job on it fails that device, a recovery waits for jobs
  assert.equal((await j.api('student2', 'POST', `/api/recovery/runs/${id}/cancel`)).status, 403);
  const stop = await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  assert.equal(stop.status, 200);
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled');
  assert.equal(rec.cancelledBy.username, 'student1');
  assert.equal(j.dev('R2').powerCycles, 0);
  assert.equal((await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`)).status, 409);
  assert.equal((await confirm('student1', id, 'power_cycle')).status, 409);
  assert.equal((await j.app.deps.repos.recoveries.get(id)).state, 'cancelled');

  const job = await j.api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [j.key('S2')] });
  assert.equal(job.status, 202);
  const busy = await start('student1', 'R2', 'isr4300');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'recovery.job_running');
  await j.until(job.body.job.id);
});

test('nobody confirms: the recovery is abandoned, nothing typed past the look', async () => {
  const before = recovery.runner.timeouts.confirmMs;
  recovery.runner.timeouts = { ...recovery.runner.timeouts, confirmMs: 300 };
  try {
    const s = await start('student1', 'R2', 'isr4300');
    const rec = await ended(s.body.recovery.id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.code, 'recovery.abandoned');
    assert.equal(j.dev('R2').powerCycles, 0);
  } finally {
    recovery.runner.timeouts = { ...recovery.runner.timeouts, confirmMs: before };
  }
});

test('a recovery left open by a stopped server is closed as interrupted at start-up', async (t) => {
  const { repos, close } = await memoryDatabase();
  t.after(close);
  await repos.recoveries.save({
    id: '0190a000-0000-7000-8000-000000000001', bench: 'B4M', device: { key: 'p:1', name: 'R1' }, family: 'isr_g1', actor: { id: 'u1', name: 'A' },
    teamId: null, state: 'awaiting', steps: [{ id: 'look', state: 'done' }, { id: 'power_cycle', state: 'running' }, { id: 'confreg', state: 'pending' }], createdAt: Date.now(),
  });
  const events = { publish: () => {} };
  const m = createRecoveryModule({ config: {}, logger: recordingLogger(), events, repos, audit: { log: () => {} }, infra: {}, services: {} });
  await m.start();
  const row = await repos.recoveries.get('0190a000-0000-7000-8000-000000000001');
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'recovery.interrupted');
  assert.deepEqual(row.steps.map((s) => s.state), ['done', 'failed', 'not_run']);
  assert.ok(row.endedAt);
  assert.equal((await repos.recoveries.unfinished()).length, 0);
  assert.equal((await repos.recoveries.list({ device: 'p:1' })).length, 1);
});
