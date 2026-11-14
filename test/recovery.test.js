/**
 * The password recovery assistant through the real application and the mock
 * lab (SSH jump server, console server, telnet BREAK): a router locked by a
 * console line password walked through every step, each confirmed; a switch
 * whose Mode button was released too early, then recovered; who may start,
 * confirm, follow and stop a recovery, and every refusal; cancellation; the
 * audit trail and the database row; a recovery left open by a stopped server.
 * A recovery that does not finish puts its device back: stopped after
 * confreg, park_config or boot, abandoned, refused mid-way, server shutdown;
 * what could not be put back is said, kept, and put back by the next one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startJobsApp, waitFor, JOB_TIMEOUTS } from './helpers/jobs.js';
import { createRecoveryModule } from '../src/modules/recovery/index.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger, student } from './helpers/fakes.js';

// The simulator's clock runs fifty times faster than the real one: boots take seconds,
// long enough for BREAKs sent through telnet's command mode to land in the boot
const SLOW = { timeScale: 0.02 };
const MODELS = {
  R1: { model: '2811', start: 'linepass', linePassword: 'left-by-a-group', ...SLOW },
  R2: { model: 'isr4331', enableSecret: 'lost', ...SLOW },
  S1: { model: '3560', start: 'linepass', linePassword: 'left-by-a-group', ...SLOW },
  S2: { model: 'c9300l', enableSecret: 'lost', hostname: 'SW1-2005' },
  R3: { model: '1841', start: 'privileged', hostname: 'R3-2005', ...SLOW },
  R4: { model: '2801', start: 'linepass', linePassword: 'left-by-a-group', hostname: 'R4-2009', ...SLOW },
  R5: { model: '2811', start: 'linepass', linePassword: 'left-by-a-group', hostname: 'R5-2008', ...SLOW },
  S3: { model: '2960', start: 'linepass', linePassword: 'left-by-a-group', hostname: 'S3-2010', ...SLOW },
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

/** Confirm each step of `steps` in turn (the person power-cycling when asked), then wait for `next` */
async function walk(id, dev, steps, next, { mode = false } = {}) {
  for (const step of steps) {
    await awaiting(id, step);
    assert.equal((await confirm('student1', id, step)).status, 200);
    if (step === 'power_cycle') await personPowerCycles(id, dev, mode);
  }
  return awaiting(id, next);
}

/** Switched off and on, the device boots its own startup-config (locked again) */
async function bootOwn(dev) {
  dev.powerCycle();
  await waitFor(() => !dev.inBoot && ['pressreturn', 'linepass', 'idle', 'exec'].includes(dev.state), 20_000, 'the device to boot');
}

/** Booted with its own startup-config: not in ROMMON, not at switch:, its own hostname */
const bootedOwn = (dev, host) => !dev.inBoot && ['linepass', 'exec', 'pressreturn', 'idle'].includes(dev.state) && dev.cfg.hostname === host;

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

test('a device at a privileged prompt is not locked: the assistant stops at once, nothing typed, no power cycle', async () => {
  const r3 = j.dev('R3');
  const s = await start('student1', 'R3', 'isr_g1');
  const rec = await ended(s.body.recovery.id);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.code, 'recovery.not_locked', JSON.stringify(rec.look));
  assert.equal(rec.error.params.host, 'R3-2005');
  assert.equal(rec.steps.find((x) => x.id === 'power_cycle').state, 'not_run');
  assert.equal(r3.powerCycles, 0);
  assert.equal(r3.mode, '#');
});

test('stopped after confreg: confreg 0x2102 and reset; the router boots its own startup-config, nothing left', async () => {
  const r4 = j.dev('R4');
  const s = await start('student1', 'R4', 'isr_g1');
  const id = s.body.recovery.id;
  await walk(id, r4, ['power_cycle', 'confreg'], 'boot');
  assert.equal(r4.nextConfReg, '0x2142');
  assert.equal(live(id).bypassed, 'register');
  assert.equal((await j.app.deps.repos.recoveries.get(id)).bypassed, 'register', 'saved as soon as it is in place');
  const stop = await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  assert.equal(stop.status, 200);
  const again = await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  assert.ok(again.status === 409 && ['recovery.putting_back', 'recovery.over'].includes(again.body.code), JSON.stringify(again.body));
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.deepEqual(rec.putBack, { ok: true, booted: true, at: rec.putBack.at });
  assert.equal(rec.bypassed, null);
  assert.equal(r4.confReg, '0x2102');
  assert.ok(bootedOwn(r4, 'R4-2009'), `${r4.state} ${r4.cfg.hostname}`);
  const stored = await j.app.deps.repos.recoveries.get(id);
  assert.equal(stored.state, 'cancelled');
  assert.equal(stored.bypassed, null);
  assert.equal((await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('R4'))}`)).body.left, null);
});

test('stopped after park_config: config.text renamed back at switch:, the switch boots its own startup-config', async () => {
  const s1 = j.dev('S1'); // left at Switch# by the second test: locked again by a power cycle
  await bootOwn(s1);
  const s = await start('student1', 'S1', 'catalyst');
  const id = s.body.recovery.id;
  await walk(id, s1, ['power_cycle', 'flash_init', 'park_config'], 'boot', { mode: true });
  assert.equal(s1.startup, null);
  assert.ok(s1.parked);
  assert.equal(live(id).bypassed, 'parked');
  assert.equal((await j.api('admin', 'POST', `/api/recovery/runs/${id}/cancel`)).status, 200, 'an admin may stop it');
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.equal(rec.cancelledBy.username, 'admin');
  assert.equal(rec.putBack.ok, true);
  assert.equal(s1.parked, null);
  assert.ok(s1.startup, 'flash:config.text is back');
  assert.ok(bootedOwn(s1, s1.startup.hostname), `${s1.state} ${s1.cfg.hostname}`);
});

test('abandoned after park_config: put back all the same', async () => {
  const s3 = j.dev('S3');
  const s = await start('student1', 'S3', 'catalyst');
  const id = s.body.recovery.id;
  const before = recovery.runner.timeouts.confirmMs;
  try {
    await walk(id, s3, ['power_cycle', 'flash_init'], 'park_config', { mode: true });
    recovery.runner.timeouts = { ...recovery.runner.timeouts, confirmMs: 300 };
    await confirm('student1', id, 'park_config');
    const rec = await ended(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.code, 'recovery.abandoned');
    assert.equal(rec.putBack.ok, true, JSON.stringify(rec.putBack));
    assert.equal(rec.bypassed, null);
  } finally {
    recovery.runner.timeouts = { ...recovery.runner.timeouts, confirmMs: before };
  }
  assert.equal(s3.parked, null);
  assert.equal(s3.startup.hostname, 'S3-2010');
  assert.ok(bootedOwn(s3, 'S3-2010'), `${s3.state} ${s3.cfg.hostname}`);
});

test('stopped from the console tile after boot: put back (0x2102 for the next boot), said to be stopped from the console', async () => {
  const r1 = j.dev('R1');
  await bootOwn(r1);
  const s = await start('student1', 'R1', 'isr_g1');
  const id = s.body.recovery.id;
  await walk(id, r1, ['power_cycle', 'confreg', 'boot'], 'restore_register');
  assert.equal(r1.cfg.hostname, 'Router');
  assert.equal(r1.confReg, '0x2142');
  const room = j.services.consoles.rooms.get(`${j.device('R1').target.host}:${j.device('R1').target.port}`);
  assert.equal(room.cancelTask('system').ok, true);
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.equal(rec.cancelledBy, null);
  assert.equal(rec.stoppedFrom, 'console');
  assert.equal(rec.putBack.ok, true, JSON.stringify(rec.putBack));
  assert.equal(r1.nextConfReg, '0x2102');
  assert.ok(r1.startup.blocks.find((b) => b.head === 'line con 0').lines.includes('password left-by-a-group'));
  await waitFor(async () => (await j.app.deps.repos.audit.query({ actions: ['recovery'], limit: 200 })).some((e) => e.action === 'recovery.cancel' && e.details?.recovery === id && e.details?.from === 'console'), 5000, 'the stop from the console audited');
});

test('the bench locked mid-way: a guest follows but may not stop it; the next step is refused, the device put back by the system', async () => {
  const r5 = j.dev('R5');
  assert.equal((await j.api('student3', 'POST', '/api/benches/B4M/join')).status, 202);
  assert.equal((await j.api('student1', 'POST', `/api/benches/B4M/requests/${encodeURIComponent(student(3).id)}/accept`)).status, 200);
  const s = await start('student1', 'R5', 'isr_g1');
  const id = s.body.recovery.id;
  try {
    await walk(id, r5, ['power_cycle', 'confreg'], 'boot');
    assert.equal(r5.nextConfReg, '0x2142');
    assert.equal((await j.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'maintenance' })).status, 200);
    // The guest still follows it (an occupant), but may not stop it on a locked bench
    assert.equal((await j.api('student3', 'GET', `/api/recovery/runs/${id}`)).status, 200);
    const no = await j.api('student3', 'POST', `/api/recovery/runs/${id}/cancel`);
    assert.equal(no.status, 403);
    assert.equal(no.body.code, 'recovery.cancel_forbidden');
    await confirm('student1', id, 'boot');
    const rec = await ended(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.code, 'recovery.not_allowed');
    assert.equal(rec.steps.find((x) => x.id === 'boot').state, 'not_run', 'the refused step never ran');
    assert.equal(rec.putBack.ok, true, JSON.stringify(rec.putBack));
    assert.equal(r5.confReg, '0x2102');
    assert.ok(bootedOwn(r5, 'R5-2008'), `${r5.state} ${r5.cfg.hostname}`);
  } finally {
    await j.api('admin', 'DELETE', '/api/benches/B4M/lock');
    await j.api('student3', 'POST', '/api/benches/B4M/leave');
  }
});

test('what cannot be put back is said and kept; the next recovery puts it back from the factory prompt, no power cycle', async () => {
  const s2 = j.dev('S2');
  s2.ignoreFlagSticks = true;
  const s = await start('student1', 'S2', 'c9300l');
  const id = s.body.recovery.id;
  await walk(id, s2, ['power_cycle', 'ignore_startup', 'boot'], 'restore_startup', { mode: true });
  await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  const rec = await ended(id);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.code, 'recovery.left_ignore');
  assert.equal(rec.cause.code, 'recovery.cancelled');
  assert.equal(rec.bypassed, 'ignore');
  assert.equal(rec.putBack.ok, false);
  assert.equal((await j.app.deps.repos.recoveries.get(id)).bypassed, 'ignore');
  const info = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('S2'))}`);
  assert.equal(info.body.left, 'ignore');

  // Fixed on site; the next recovery reads Switch> and only puts the flag back
  s2.ignoreFlagSticks = false;
  const cycles = s2.powerCycles;
  const next = await start('student1', 'S2', 'c9300l');
  const nid = next.body.recovery.id;
  await awaiting(nid, 'restore_startup');
  assert.deepEqual(live(nid).steps.filter((x) => x.state === 'skipped').map((x) => x.id), ['power_cycle', 'ignore_startup', 'boot']);
  await confirm('student1', nid, 'restore_startup');
  const done = await ended(nid);
  assert.equal(done.state, 'done', JSON.stringify(done.error));
  assert.equal(done.bypassed, null);
  assert.equal(s2.romvars.SWITCH_IGNORE_STARTUP_CFG, '0');
  assert.equal(s2.powerCycles, cycles);
  assert.equal((await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('S2'))}`)).body.left, null);
});

test('a shared console line another team holds, an admin switch: refused', async () => {
  await j.holdBench('student2', 'B4H', 'team-student2');
  try {
    const shared = await start('student1', 'S5', 'catalyst');
    assert.equal(shared.status, 409);
    assert.equal(shared.body.code, 'recovery.shared_in_use');
    assert.equal(shared.body.params.bench, 'B4H');
    const view = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('S5'))}`);
    assert.equal(view.body.refusal.code, 'recovery.shared_in_use');
  } finally {
    await j.release('student2', 'B4H');
  }
  const adminSwitch = j.app.deps.infra.adminSwitches[0];
  assert.ok(adminSwitch, 'the diagram has admin switches');
  for (const who of ['student1', 'admin']) {
    const r = await j.api(who, 'POST', `/api/recovery/devices/${encodeURIComponent(adminSwitch.key)}/start`, { family: 'catalyst' });
    assert.equal(r.status, 404, who);
    assert.equal(r.body.code, 'recovery.unknown_device');
    assert.equal((await j.api(who, 'GET', `/api/recovery/devices/${encodeURIComponent(adminSwitch.key)}`)).status, 404);
  }
});

test('server shutdown after confreg: the register put back without booting, the row saved', async () => {
  const r4 = j.dev('R4');
  const s = await start('student1', 'R4', 'isr_g1');
  const id = s.body.recovery.id;
  await walk(id, r4, ['power_cycle', 'confreg'], 'boot');
  await recovery.runner.shutdown();
  const rec = live(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.deepEqual({ ok: rec.putBack.ok, booted: rec.putBack.booted }, { ok: true, booted: false });
  assert.equal(r4.state, 'rommon', 'not booted: the server is stopping');
  assert.equal(r4.nextConfReg, '0x2102');
  const stored = await j.app.deps.repos.recoveries.get(id);
  assert.equal(stored.state, 'cancelled');
  assert.equal(stored.bypassed, null);
});
