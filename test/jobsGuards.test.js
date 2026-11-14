/**
 * What a job may reveal and what it may destroy, beyond the bench it runs on:
 * reports seen by what was true when the job ran (never by who holds the
 * bench now; guests without configuration lines), shared console lines
 * another team holds, an injection the device refused, the startup-config of
 * a router that ignores it (1841 at 0x2141), a base configuration gone or
 * damaged since the reset started, and the refusals nobody tested
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startJobsApp, reportOf, waitFor } from './helpers/jobs.js';
import { student } from './helpers/fakes.js';

let j;
const B = '/api/jobs/benches/B4M';
const SECRET = 'SECRET-TEAM1';
const OTHER = 'OTHER-TEAM1';

before(async () => {
  j = await startJobsApp();
  await j.holdBench('student1');
});

after(async () => {
  await j?.close();
});

const run = async (who, kind, body) => {
  const r = await j.api(who, 'POST', `${B}/${kind}`, body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return r.body.job;
};

/** Every 'jobs:job' publication from now on, with who it reaches */
function spyJobEvents() {
  const events = j.app.deps.events;
  const original = events.publish;
  const seen = [];
  events.publish = function publish(topic, data, opts) {
    if (topic === 'jobs:job') seen.push({ text: JSON.stringify(data), audience: opts?.audience ?? (() => true) });
    return original.call(this, topic, data, opts);
  };
  return { seen, stop: () => { events.publish = original; } };
}

test('a job report is the team\'s: a guest follows it without a configuration line, the next team on the bench sees nothing of it', { timeout: 60_000 }, async () => {
  // The guest of team 1: student3 asks to join, a member accepts
  assert.equal((await j.api('student3', 'POST', '/api/benches/B4M/join')).status, 202);
  assert.equal((await j.api('student1', 'POST', `/api/benches/B4M/requests/${encodeURIComponent(student(3).id)}/accept`)).status, 200);
  assert.equal(j.services.benches.isOccupant(student(3), 'B4M'), true);

  j.dev('R1').configure([`username prof privilege 15 password 0 ${SECRET}`]);
  const backup = await j.until((await run('student1', 'backup', { devices: [j.key('R1')] })).id);
  assert.equal(backup.state, 'done');
  j.dev('R1').configure(['interface FastEthernet0/0', ` description ${OTHER}`]);

  const spy = spyJobEvents();
  let compare;
  try {
    compare = await j.until((await run('student1', 'compare', { snapshot: backup.snapshotId, devices: [j.key('R1')] })).id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    spy.stop();
  }
  const r1 = reportOf(compare, 'R1');
  assert.equal(r1.result.check.status, 'changed');
  assert.match(r1.result.check.patch, new RegExp(OTHER), 'the team reads the diff');

  // Live: the members get the whole report, the guest the report without a configuration line
  const toGuest = spy.seen.filter((e) => e.audience(student(3)));
  const toMember = spy.seen.filter((e) => e.audience(student(1)));
  assert.ok(toGuest.length > 0, 'the guest follows the job');
  for (const e of toGuest) assert.equal(e.text.includes(SECRET) || e.text.includes(OTHER), false, e.text);
  assert.ok(toGuest.at(-1).text.includes('"state":"done"'), 'the guest sees it end');
  assert.ok(toMember.some((e) => e.text.includes(OTHER)));
  assert.equal(spy.seen.some((e) => e.audience(student(2))), false, 'an outsider gets nothing');

  // Over: the guest no longer reads it, the bench detail never showed more than the summary
  assert.equal((await j.api('student3', 'GET', `/api/jobs/runs/${compare.id}`)).status, 403);
  assert.equal((await j.api('student3', 'GET', '/api/jobs/runs?bench=B4M')).body.jobs.some((x) => x.id === compare.id), false);

  // Team 1 lets the bench go, team 2 takes it: the reports stay team 1's
  assert.equal((await j.release('student1')).status, 200);
  await j.holdBench('student2', 'B4M', 'team-student2');
  try {
    const runs = await j.api('student2', 'GET', '/api/jobs/runs?bench=B4M');
    assert.equal(runs.status, 200);
    assert.equal(JSON.stringify(runs.body).includes(SECRET) || JSON.stringify(runs.body).includes(OTHER), false);
    assert.deepEqual(runs.body.jobs.filter((x) => [backup.id, compare.id].includes(x.id)), []);
    for (const id of [backup.id, compare.id]) {
      const one = await j.api('student2', 'GET', `/api/jobs/runs/${id}`);
      assert.equal(one.status, 403);
      assert.equal(one.body.code, 'jobs.job_forbidden');
    }
    assert.equal((await j.api('student2', 'GET', `/api/jobs/snapshots/${backup.snapshotId}`)).status, 403);
    // Team 1 still reads its own report, admins too
    const mine = await j.api('student1', 'GET', `/api/jobs/runs/${compare.id}`);
    assert.match(mine.body.job.devices[0].result.check.patch, new RegExp(OTHER));
    assert.equal((await j.api('admin', 'GET', `/api/jobs/runs/${compare.id}`)).status, 200);
  } finally {
    await j.release('student2');
    await j.holdBench('student1');
  }
});

test('a guest who runs a job sees its report without configuration lines; a running job shows occupants a summary', { timeout: 30_000 }, async () => {
  assert.equal((await j.api('student3', 'POST', '/api/benches/B4M/join')).status, 202);
  assert.equal((await j.api('student1', 'POST', `/api/benches/B4M/requests/${encodeURIComponent(student(3).id)}/accept`)).status, 200);
  const snap = (await j.api('student1', 'GET', '/api/jobs/snapshots?bench=B4M')).body.snapshots[0];
  j.jobs.runner.countdownMs = 5000;
  try {
    // A reset waiting for its countdown: the guest sees it, as a summary
    const pending = await run('student1', 'reset', { devices: [j.key('R1')], confirm: 'B4M' });
    const seen = await j.api('student3', 'GET', `/api/jobs/runs/${pending.id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.job.redacted, true);
    assert.equal((await j.api('student3', 'GET', B)).body.running.id, pending.id);
    assert.equal((await j.api('student1', 'GET', `/api/jobs/runs/${pending.id}`)).body.job.redacted, undefined);
    assert.equal((await j.api('student1', 'POST', `/api/jobs/runs/${pending.id}/cancel`)).status, 200);
  } finally {
    j.jobs.runner.countdownMs = 300;
  }
  // The guest's own job: the comparison's result, without its diff
  const own = await j.api('student3', 'POST', `${B}/compare`, { snapshot: snap.id, devices: [j.key('R1')] });
  assert.equal(own.status, 403, 'a guest does not read the team\'s snapshots');
  const backup = await run('student3', 'backup', { devices: [j.key('R1')] });
  await j.until(backup.id);
  const report = await j.api('student3', 'GET', `/api/jobs/runs/${backup.id}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.job.redacted, true);
  assert.equal(reportOf(report.body.job, 'R1').state, 'done');
  assert.equal((await j.api('student3', 'POST', '/api/benches/B4M/leave')).status, 200);
  assert.equal((await j.api('student3', 'GET', `/api/jobs/runs/${backup.id}`)).status, 200, 'its actor still sees it');
});

test('a shared console line is erased or written only when every bench using it is free or the team\'s; admins may', { timeout: 60_000 }, async () => {
  await j.holdBench('student2', 'B4H', 'team-student2');
  try {
    const reset = await j.api('student1', 'POST', `${B}/reset`, { devices: [j.key('S5')], confirm: 'B4M' });
    assert.equal(reset.status, 409);
    assert.equal(reset.body.code, 'jobs.shared_in_use');
    assert.equal(reset.body.params.device, 'S5');
    assert.equal(reset.body.params.bench, 'B4H');

    const t = await j.api('admin', 'POST', '/api/jobs/templates', { name: 'Partout', configs: { '*': 'no ip domain-lookup\n' } });
    assert.equal(t.status, 201);
    const p = await j.api('student1', 'POST', `${B}/preview`, { source: { template: t.body.template.id }, devices: [j.key('S5')] });
    const scripts = { [j.key('S5')]: p.body.devices[0].sha256 };
    for (const mode of ['merge', 'reset']) {
      const inject = await j.api('student1', 'POST', `${B}/inject`, { source: { template: t.body.template.id }, devices: [j.key('S5')], scripts, mode, confirm: 'B4M' });
      assert.equal(inject.body.code, 'jobs.shared_in_use', mode);
    }
    // Reading is no harm
    assert.equal((await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('S5')] })).status, 202);
    await waitFor(() => !j.jobs.runner.running('B4M'), 20_000, 'the backup to end');
    // An admin may
    j.jobs.runner.countdownMs = 5000;
    try {
      const byAdmin = await run('admin', 'reset', { devices: [j.key('S5')], confirm: 'B4M' });
      await j.api('admin', 'POST', `/api/jobs/runs/${byAdmin.id}/cancel`);
    } finally {
      j.jobs.runner.countdownMs = 300;
    }
  } finally {
    await j.release('student2', 'B4H');
  }
  // B4H free again (and B5B free): the team may reset its shared switch
  const ok = await j.until((await run('student1', 'reset', { devices: [j.key('S5')], confirm: 'B4M', applyBase: false })).id, 40_000);
  const s5 = reportOf(ok, 'S5');
  assert.equal(s5.state, 'done', `${s5.code} ${s5.message}`);
});

test('a shared line taken by another team during the countdown: the device is not touched', { timeout: 30_000 }, async () => {
  j.jobs.runner.countdownMs = 1500;
  try {
    const job = await run('student1', 'reset', { devices: [j.key('S5')], confirm: 'B4M' });
    await j.holdBench('student2', 'B4H', 'team-student2');
    const done = await j.until(job.id);
    assert.equal(reportOf(done, 'S5').state, 'failed');
    assert.equal(reportOf(done, 'S5').code, 'jobs.not_allowed');
  } finally {
    j.jobs.runner.countdownMs = 300;
    await j.release('student2', 'B4H');
  }
});

test('an injection the device refused lines of is not saved: the device fails with jobs.script_errors, startup-config untouched', { timeout: 30_000 }, async () => {
  const t = await j.api('admin', 'POST', '/api/jobs/templates', { name: 'Fautif', configs: { R1: 'interface FastEthernet0/0\n description AVANT\n bogus-command 42\n description APRES\n' } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const source = { template: t.body.template.id };
  const p = await j.api('student1', 'POST', `${B}/preview`, { source, devices: [j.key('R1')] });
  const dev = j.dev('R1');
  const startupBefore = JSON.stringify(dev.startup);
  const logBefore = dev.commandLog.length;
  const job = await j.until((await run('student1', 'inject', { source, devices: [j.key('R1')], scripts: { [j.key('R1')]: p.body.devices[0].sha256 }, mode: 'merge' })).id);
  const r1 = reportOf(job, 'R1');
  assert.equal(r1.state, 'failed', JSON.stringify(r1));
  assert.equal(r1.code, 'jobs.script_errors');
  assert.equal(r1.params.count, 1);
  assert.equal(r1.result.saved, false);
  assert.equal(r1.result.errors.length, 1);
  assert.match(r1.result.errors[0].command, /bogus-command 42/);
  assert.equal(job.state, 'failed');
  assert.deepEqual(dev.commandLog.slice(logBefore).filter((c) => /^copy|^wr/.test(c)), [], 'copy run start never typed');
  assert.equal(JSON.stringify(dev.startup), startupBefore);
});

test('the 1841 at 0x2141: its startup-config, which it ignores, is backed up before the reset erases it', { timeout: 40_000 }, async () => {
  const dev = j.dev('R3');
  assert.equal(dev.confReg, '0x2141');
  const factory = structuredClone(dev.cfg);
  dev.configure(['interface FastEthernet0/0', ' description TRAVAIL-DU-GROUPE']);
  dev.startup = structuredClone(dev.cfg);
  dev.cfg = factory;

  // A backup that does not read back as taken (here: its startup-config) stops the erase
  const verify = j.jobs.library.verify;
  j.jobs.library.verify = async (set, row, config, opts) => (opts?.startup ? false : verify.call(j.jobs.library, set, row, config, opts));
  try {
    const refused = await j.until((await run('student1', 'reset', { devices: [j.key('R3')], confirm: 'B4M', applyBase: false })).id);
    assert.equal(reportOf(refused, 'R3').code, 'jobs.backup_failed');
    assert.equal(reportOf(refused, 'R3').params.cause, 'jobs.backup_unverified');
    assert.ok(dev.startup, 'not erased');
  } finally {
    j.jobs.library.verify = verify;
  }

  const job = await j.until((await run('student1', 'reset', { devices: [j.key('R3')], confirm: 'B4M', applyBase: false })).id, 30_000);
  const r3 = reportOf(job, 'R3');
  assert.equal(r3.state, 'done', `${r3.code} ${r3.message}`);
  assert.equal(r3.result.startupKept, true);
  assert.equal(dev.confReg, '0x2102', 'the register is back to normal');
  const snap = await j.api('student1', 'GET', `/api/jobs/snapshots/${job.snapshotId}`);
  assert.equal(snap.body.snapshot.devices.find((d) => d.device === 'R3').startup, true);
  const r3File = await j.api('student1', 'GET', `/api/jobs/snapshots/${job.snapshotId}/devices/R3`);
  assert.match(r3File.body.startup, /description TRAVAIL-DU-GROUPE/);
  assert.doesNotMatch(r3File.body.config, /TRAVAIL-DU-GROUPE/, 'the running-config never had it');
  // Its file is indexed with its SHA-256 and read back
  const row = (await j.app.deps.repos.snapshots.get(job.snapshotId)).devices.find((d) => d.device === 'R3');
  assert.equal(row.startupFile, 'R3.startup.cfg');
  assert.equal(row.startupSha256.length, 64);

  // Erased, R3 has no startup-config any more: a second reset keeps a single file
  assert.equal(dev.startup, null);
  const again = await j.until((await run('student1', 'reset', { devices: [j.key('R3')], confirm: 'B4M', applyBase: false })).id, 30_000);
  assert.equal(reportOf(again, 'R3').state, 'done');
  assert.equal(reportOf(again, 'R3').result.startupKept, false);
  const row2 = (await j.app.deps.repos.snapshots.get(again.snapshotId)).devices.find((d) => d.device === 'R3');
  assert.equal(row2.startupFile, null);
});

test('the base configuration gone or damaged during the countdown: a warning, the reset itself succeeds', { timeout: 60_000 }, async () => {
  const publish = async (name) => {
    const t = await j.api('admin', 'POST', '/api/jobs/templates', { name, configs: { '*': 'no ip domain-lookup\n' }, base: true });
    assert.equal(t.status, 201);
    return j.jobs.library.template(t.body.template.id);
  };
  j.jobs.runner.countdownMs = 1500;
  try {
    const gone = await publish('Base disparue');
    const job = await run('student1', 'reset', { devices: [j.key('R1')], confirm: 'B4M' });
    assert.equal((await j.api('admin', 'DELETE', `/api/jobs/templates/${gone.id}`)).status, 200);
    const r1 = reportOf(await j.until(job.id, 30_000), 'R1');
    assert.equal(r1.state, 'done', `${r1.code} ${r1.message}`);
    assert.ok(r1.result.warnings.includes('base_missing'));
    assert.equal(r1.result.base, undefined);

    const damaged = await publish('Base abimee');
    const job2 = await run('student1', 'reset', { devices: [j.key('R1')], confirm: 'B4M' });
    fs.writeFileSync(path.join(j.jobs.library.files.abs(damaged.dir), '_any.cfg'), 'enable secret pirate\n');
    const r1b = reportOf(await j.until(job2.id, 30_000), 'R1');
    assert.equal(r1b.state, 'done');
    assert.ok(r1b.result.warnings.includes('base_damaged'));
    assert.equal(j.dev('R1').commandLog.some((c) => /pirate/.test(c)), false, 'nothing of the damaged file is sent');
    await j.api('admin', 'DELETE', `/api/jobs/templates/${damaged.id}`);
  } finally {
    j.jobs.runner.countdownMs = 300;
  }
});

test('refusals with their codes: cancel_forbidden, bad_mode, bad_search', { timeout: 20_000 }, async () => {
  // An occupant of a locked bench sees the admin's job, may not stop it
  assert.equal((await j.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'examen' })).status, 200);
  j.jobs.runner.countdownMs = 5000;
  try {
    const job = await run('admin', 'reset', { devices: [j.key('R2')], confirm: 'B4M' });
    assert.equal((await j.api('student1', 'GET', `/api/jobs/runs/${job.id}`)).status, 200);
    const c = await j.api('student1', 'POST', `/api/jobs/runs/${job.id}/cancel`);
    assert.equal(c.status, 403);
    assert.equal(c.body.code, 'jobs.cancel_forbidden');
    assert.equal((await j.api('admin', 'POST', `/api/jobs/runs/${job.id}/cancel`)).status, 200);
  } finally {
    j.jobs.runner.countdownMs = 300;
    await j.api('admin', 'DELETE', '/api/benches/B4M/lock');
  }
  const mode = await j.api('student1', 'POST', `${B}/inject`, { source: { template: 'x' }, mode: 'replace' });
  assert.equal(mode.status, 400);
  assert.equal(mode.body.code, 'jobs.bad_mode');
  for (const q of ['a', 'x'.repeat(101)]) {
    const s = await j.api('student1', 'GET', `/api/jobs/snapshots/search?q=${q}`);
    assert.equal(s.status, 400);
    assert.equal(s.body.code, 'jobs.bad_search');
  }
});
