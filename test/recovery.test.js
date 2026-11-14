/**
 * The password recovery assistant through the real application and the mock
 * lab (SSH jump server, console server, telnet BREAK): a router locked by a
 * console line password walked through every step, each confirmed; a switch
 * whose Mode button was released too early, then recovered; a device that is
 * not locked; a recovery nobody confirms; one left open by a stopped server.
 * Who may do what: recoveryRights.test.js; putting a device back:
 * recoveryPutBack.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRecoveryApp } from './helpers/recovery.js';
import { waitFor } from './helpers/http.js';
import { createRecoveryModule } from '../src/modules/recovery/index.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger } from './helpers/fakes.js';
let j;
let recovery;
let until;
let awaiting;
let ended;
let confirm;
let start;
let personPowerCycles;
before(async () => {
  ({ j, recovery, until, awaiting, ended, confirm, start, personPowerCycles } = await startRecoveryApp());
});
after(() => j?.close());

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
  const revBefore = rec.rev;
  rec = await awaiting(id, 'confreg');
  assert.ok(rec.rev > revBefore, 'every change carries a higher rev: a client keeps the newest of an answer and a live update');
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
  await waitFor(async () => (await entries()).some((e) => e.action === 'recovery.end' && e.details?.recovery === id), { ms: 5000, what: 'the audit entries' });
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

test('a device at a privileged prompt is not locked: the assistant stops at once, nothing typed, no power cycle', async () => {
  const r3 = j.dev('R3');
  const s = await start('student1', 'R3', 'isr_g1');
  const rec = await ended(s.body.recovery.id);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.code, 'recovery.not_locked', JSON.stringify(rec.look));
  assert.equal(rec.error.params.host, 'R3-3005');
  assert.equal(rec.steps.find((x) => x.id === 'power_cycle').state, 'not_run');
  assert.equal(r3.powerCycles, 0);
  assert.equal(r3.mode, '#');
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
