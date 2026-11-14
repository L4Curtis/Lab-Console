/**
 * What protects the equipment: no erase without a backup written and read
 * back (unless an admin ticks it by hand), a wrong enable secret, a device
 * that is not Cisco IOS, a bench locked during a job, cancellation at every
 * stage, the base configuration after a reset, and passwords that never
 * reach the disk
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startJobsApp, reportOf, waitFor } from './helpers/jobs.js';

let j;
const B = '/api/jobs/benches/B4M';
const SECRET = 'Zq9-enable-unique';

before(async () => {
  j = await startJobsApp({ models: {
    R1: { model: '2811' }, R2: { model: '2801' }, R3: { model: '2811' }, R4: { model: '2801', enableSecret: SECRET }, S1: { model: '2960' }, S4: { model: 'aruba' },
  } });
  await j.holdBench('student1');
});

after(async () => {
  await j?.close();
});

const erased = (name) => j.dev(name).startup === null || j.dev(name).cfg.hostname !== name;
const run = async (who, kind, body) => {
  const r = await j.api(who, 'POST', `${B}/${kind}`, body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return r.body.job;
};
/** Wait until a device of a running job reaches a step (or a state) */
const reach = (job, name, pred, what) => waitFor(() => {
  const d = j.job(job.id)?.devices.find((x) => x.name === name);
  return d && pred(d);
}, 20_000, `${name} ${what}`);

test('a wrong enable secret: the backup fails, nothing is erased, the reason is told; the right one works', { timeout: 30_000 }, async () => {
  const wrong = await j.until((await run('student1', 'reset', { devices: [j.key('R4')], confirm: 'B4M', enablePasswords: ['nope'] })).id);
  const r4 = reportOf(wrong, 'R4');
  assert.equal(r4.state, 'failed');
  assert.equal(r4.code, 'jobs.backup_failed');
  assert.equal(r4.params.cause, 'ios.enable_refused');
  assert.equal(erased('R4'), false);

  const backup = await j.until((await run('student1', 'backup', { devices: [j.key('R4')], enablePasswords: ['nope', SECRET] })).id);
  assert.equal(reportOf(backup, 'R4').state, 'done');
});

test('the backup cannot be written: the device is not erased; an admin may tick it to erase anyway, a student may not', { timeout: 40_000 }, async () => {
  const add = j.jobs.library.add;
  j.jobs.library.add = async () => { throw new Error('No space left on device'); };
  try {
    const job = await j.until((await run('student1', 'reset', { devices: [j.key('R1')], confirm: 'B4M' })).id);
    const r1 = reportOf(job, 'R1');
    assert.equal(r1.state, 'failed');
    assert.equal(r1.code, 'jobs.backup_failed');
    assert.equal(r1.params.cause, 'jobs.backup_not_written');
    assert.equal(erased('R1'), false, 'no backup, no erase');

    assert.equal((await j.api('student1', 'POST', `${B}/reset`, { devices: [j.key('R1')], confirm: 'B4M', forceErase: [j.key('R1')] })).body.code, 'jobs.force_admin_only');
    const forced = await j.until((await run('admin', 'reset', { devices: [j.key('R1')], confirm: 'B4M', forceErase: [j.key('R1')] })).id, 30_000);
    const f = reportOf(forced, 'R1');
    assert.equal(f.state, 'done', `${f.code} ${f.message}`);
    assert.ok(f.result.warnings.includes('erased_without_backup'));
    assert.equal(erased('R1'), true);
    const audit = await j.app.deps.audit.query({ action: 'job.reset', bench: 'B4M' });
    assert.ok(audit.some((e) => e.details.forceErase === 1 && e.actor.role === 'admin'));
  } finally {
    j.jobs.library.add = add;
  }
});

test('a backup that does not read back as it was taken: the device is not erased', { timeout: 30_000 }, async () => {
  const verify = j.jobs.library.verify;
  j.jobs.library.verify = async () => false;
  try {
    const job = await j.until((await run('student1', 'reset', { devices: [j.key('R2')], confirm: 'B4M' })).id);
    assert.equal(reportOf(job, 'R2').code, 'jobs.backup_failed');
    assert.equal(reportOf(job, 'R2').params.cause, 'jobs.backup_unverified');
    assert.equal(erased('R2'), false);
  } finally {
    j.jobs.library.verify = verify;
  }
});

test('a device that does not run Cisco IOS is skipped by a reset: nothing destructive is typed', { timeout: 30_000 }, async () => {
  const job = await j.until((await run('student1', 'reset', { devices: [j.key('S4')], confirm: 'B4M' })).id);
  assert.equal(reportOf(job, 'S4').state, 'skipped');
  assert.equal(reportOf(job, 'S4').code, 'ios.not_ios');
  assert.equal(job.state, 'done');
  assert.deepEqual(j.dev('S4').commandLog.filter((c) => /erase|reload|delete|write|copy|conf/.test(c)), []);
});

test('the base configuration is applied and saved after a reset', { timeout: 30_000 }, async () => {
  const t = await j.api('admin', 'POST', '/api/jobs/templates', { name: 'Base', configs: { '*': 'no ip domain-lookup\nline con 0\n logging synchronous\n' }, base: true });
  assert.equal(t.status, 201);
  const job = await j.until((await run('student1', 'reset', { devices: [j.key('R3')], confirm: 'B4M' })).id, 30_000);
  const r3 = reportOf(job, 'R3');
  assert.equal(r3.state, 'done', `${r3.code} ${r3.message}`);
  assert.equal(r3.result.base.name, 'Base');
  assert.deepEqual(r3.result.base.errors, []);
  assert.equal(r3.result.base.saved, true);
  assert.equal(j.dev('R3').cfg.hostname, 'Router');
  assert.ok(j.dev('R3').startup.global.includes('no ip domain-lookup'), 'saved');
  // Without the base when asked so
  const plain = await j.until((await run('student1', 'reset', { devices: [j.key('R3')], confirm: 'B4M', applyBase: false })).id, 30_000);
  assert.equal(reportOf(plain, 'R3').result.base, undefined);
  await j.api('admin', 'PUT', `/api/jobs/templates/${t.body.template.id}`, { base: false });
});

test('cancelled during the countdown: nothing is touched; outsiders may not cancel', { timeout: 20_000 }, async () => {
  j.jobs.runner.countdownMs = 5000;
  try {
    const job = await run('student1', 'reset', { devices: [j.key('R2')], confirm: 'B4M' });
    assert.equal(job.state, 'pending');
    assert.ok(Date.parse(job.startsAt) - Date.parse(job.createdAt) >= 4900);
    assert.equal((await j.api('student2', 'POST', `/api/jobs/runs/${job.id}/cancel`)).status, 403);
    const c = await j.api('student1', 'POST', `/api/jobs/runs/${job.id}/cancel`);
    assert.equal(c.status, 200);
    assert.equal(c.body.job.state, 'cancelled');
    assert.deepEqual(c.body.job.devices.map((d) => d.state), ['cancelled']);
    assert.equal(erased('R2'), false);
    assert.equal((await j.api('student1', 'POST', `/api/jobs/runs/${job.id}/cancel`)).body.code, 'jobs.not_running');
  } finally {
    j.jobs.runner.countdownMs = 300;
  }
});

test('cancelled while waiting for the keyboard someone holds: the device is left alone, the pilot keeps it', { timeout: 20_000 }, async () => {
  const device = j.device('R2');
  const ws = new WebSocket(`${j.app.wsUrl}/ws/console?device=${encodeURIComponent(device.key)}&cols=80&rows=24`, { headers: { origin: j.app.url, ...j.app.as('admin') } });
  await new Promise((resolve) => ws.once('open', resolve));
  try {
    const room = await waitFor(() => j.services.consoles.rooms.get(`${device.target.host}:${device.target.port}`), 5000, 'the room');
    await waitFor(() => room.pilot, 5000, 'a pilot');
    const job = await run('student1', 'backup', { devices: [device.key] });
    await reach(job, 'R2', (d) => d.state === 'waiting' && room.presence({ id: 'x' }).pending?.kind === 'task', 'waiting for the keyboard');
    await j.api('student1', 'POST', `/api/jobs/runs/${job.id}/cancel`);
    const done = await j.until(job.id);
    assert.equal(reportOf(done, 'R2').state, 'cancelled');
    assert.equal(done.state, 'cancelled');
    assert.equal(room.task, null);
    assert.ok(room.pilot, 'the person at the keyboard still has it');
  } finally {
    ws.close();
  }
});

test('cancelled while reading the device, while it reboots, while the script is sent: each device says where it stopped', { timeout: 60_000 }, async () => {
  // Reading
  const reading = await run('student1', 'backup', { devices: [j.key('R3')] });
  await reach(reading, 'R3', (d) => d.state === 'running', 'running');
  await j.api('student1', 'POST', `/api/jobs/runs/${reading.id}/cancel`);
  const r = await j.until(reading.id);
  assert.equal(reportOf(r, 'R3').state, 'cancelled');
  assert.equal(r.state, 'cancelled');

  // Rebooting: a slower device, cancelled once the boot is being followed
  j.dev('R2').timeScale = 0.02;
  try {
    const reset = await run('student1', 'reset', { devices: [j.key('R2')], confirm: 'B4M' });
    await reach(reset, 'R2', (d) => d.step === 'ios.steps.boot', 'following the boot');
    await j.api('admin', 'POST', `/api/jobs/runs/${reset.id}/cancel`);
    const x = await j.until(reset.id);
    const r2 = reportOf(x, 'R2');
    assert.equal(r2.state, 'cancelled');
    assert.equal(r2.stage, 'boot');
    assert.ok(x.snapshotId, 'its backup was taken before');
    assert.equal(x.cancelledBy.username, 'admin');
  } finally {
    j.dev('R2').timeScale = 0.002;
  }

  // Sending the script
  j.dev('S1').configure(Array.from({ length: 40 }, (_, i) => [`vlan ${100 + i}`, ` name V${100 + i}`]).flat());
  const b = await j.until((await run('student1', 'backup', { devices: [j.key('S1')] })).id);
  const p = await j.api('student1', 'POST', `${B}/preview`, { source: { snapshot: b.snapshotId }, devices: [j.key('S1')] });
  const inject = await run('student1', 'inject', { source: { snapshot: b.snapshotId }, devices: [j.key('S1')], scripts: { [j.key('S1')]: p.body.devices[0].sha256 }, mode: 'merge' });
  await reach(inject, 'S1', (d) => d.step === 'jobs.steps.inject' || d.stage === 'inject', 'sending');
  await j.api('student1', 'POST', `/api/jobs/runs/${inject.id}/cancel`);
  const i = await j.until(inject.id);
  assert.equal(reportOf(i, 'S1').state, 'cancelled');
  assert.equal(reportOf(i, 'S1').stage, 'inject');

  // The bench takes a new job at once
  const next = await run('student1', 'backup', { devices: [j.key('R3')] });
  assert.equal((await j.until(next.id)).state, 'done');
});

test('a bench locked during a job: what runs stops, what waits does not start; the job says why', { timeout: 30_000 }, async () => {
  j.jobs.runner.devicesAtOnce = 1;
  try {
    // One device at a time, in the bench's order: R2, then R3
    const job = await run('student1', 'backup', { devices: [j.key('R3'), j.key('R2')] });
    await reach(job, 'R2', (d) => d.state === 'running', 'running');
    assert.equal((await j.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'examen' })).status, 200);
    const done = await j.until(job.id);
    const states = done.devices.map((d) => `${d.name}:${d.state}:${d.code}`).join(' ');
    assert.equal(reportOf(done, 'R3').state, 'failed', states);
    assert.equal(reportOf(done, 'R3').code, 'jobs.not_allowed', states);
    // R2 was stopped at its next byte, unless it had just finished
    const r2 = reportOf(done, 'R2');
    assert.ok(r2.state === 'done' || (r2.state === 'failed' && r2.code === 'consoles.control_not_allowed'), states);
    assert.notEqual(done.state, 'done');
  } finally {
    j.jobs.runner.devicesAtOnce = 5;
    await j.api('admin', 'DELETE', '/api/benches/B4M/lock');
  }
});

test('enable passwords never reach the disk: not in the database, not in a report, not in the audit trail', async () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (f) => files.push(f))(path.join(d, e.name)); };
  walk(j.app.dataDir);
  await j.app.deps.store.flush();
  for (const f of files) assert.equal(fs.readFileSync(f).includes(SECRET), false, f);
  const runs = await j.api('admin', 'GET', '/api/jobs/runs?bench=B4M');
  assert.equal(JSON.stringify(runs.body).includes(SECRET), false);
});
