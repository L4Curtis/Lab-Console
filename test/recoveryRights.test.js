/**
 * Who may start, confirm, follow and stop a recovery, and every refusal: not
 * an occupant, a locked bench (before and during), one per device, a job or
 * a check on the bench, a shared console line another team holds, an admin
 * switch, an administrator demoted while their recovery waits
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRecoveryApp, bootOwn, bootedOwn } from './helpers/recovery.js';
import { admin, student } from './helpers/fakes.js';
let j;
let awaiting;
let ended;
let confirm;
let start;
let personPowerCycles;
let walk;
before(async () => {
  ({ j, awaiting, ended, confirm, start, personPowerCycles, walk } = await startRecoveryApp());
});
after(() => j?.close());

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

test('not while a bench check runs on the bench: the check would race the recovery for the device', async () => {
  const services = j.app.deps.services;
  const before = services.checks;
  services.checks = { running: (bench) => (bench === 'B4M' ? { id: 'c1', bench, kind: 'cabling', actor: { name: 'Alice' } } : null) };
  try {
    const refused = await start('student1', 'R2', 'isr4300');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'recovery.check_running');
    assert.equal(refused.body.params.name, 'Alice');
    const view = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('R2'))}`);
    assert.equal(view.body.canStart, false);
    assert.equal(view.body.refusal.code, 'recovery.check_running');
  } finally {
    services.checks = before;
  }
  assert.equal(j.dev('R2').powerCycles, 0);
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
    assert.ok(bootedOwn(r5, 'R5-3008'), `${r5.state} ${r5.cfg.hostname}`);
  } finally {
    await j.api('admin', 'DELETE', '/api/benches/B4M/lock');
    await j.api('student3', 'POST', '/api/benches/B4M/leave');
  }
});

/** A request as an explicit session (signIn headers): the test's `as` cache would keep a revoked one */
async function asSession(session, method, path, body) {
  const res = await fetch(`${j.app.url}${path}`, {
    method,
    headers: { ...session.headers, accept: 'application/json', ...(method === 'GET' ? {} : { origin: j.app.url, 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Who runs the line's exclusive tasks from now on: 'system' or a user id */
function taskActors(name) {
  const room = j.services.consoles.rooms.get(`${j.device(name).target.host}:${j.device(name).target.port}`);
  const seen = [];
  const original = room.runExclusive;
  room.runExclusive = function (actor, ...rest) {
    seen.push(actor === 'system' ? 'system' : actor?.id);
    return original.call(this, actor, ...rest);
  };
  return { seen, restore: () => { room.runExclusive = original; } };
}

/** An admin starts a recovery on R4 of student1's bench and confirms up to the register; → { id, r4, session } */
async function adminRecoversR4(user) {
  const r4 = j.dev('R4');
  await bootOwn(r4);
  const session = j.app.signIn(user);
  const s = await asSession(session, 'POST', `/api/recovery/devices/${encodeURIComponent(j.key('R4'))}/start`, { family: 'isr_g1' });
  assert.equal(s.status, 202, JSON.stringify(s.body));
  const id = s.body.recovery.id;
  for (const step of ['power_cycle', 'confreg']) {
    await awaiting(id, step);
    assert.equal((await asSession(session, 'POST', `/api/recovery/runs/${id}/confirm`, { step })).status, 200);
    if (step === 'power_cycle') await personPowerCycles(id, r4);
  }
  await awaiting(id, 'boot');
  assert.equal(r4.nextConfReg, '0x2142');
  return { id, r4, session };
}

/** Refused at the next step, nothing past it typed, the register put back by a 'system' task */
async function refusedAndPutBack(id, r4, actors) {
  const rec = await ended(id);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.code, 'recovery.not_allowed');
  assert.equal(rec.steps.find((x) => x.id === 'boot').state, 'not_run', 'the refused step never ran');
  assert.equal(rec.putBack.ok, true, JSON.stringify(rec.putBack));
  assert.deepEqual(actors.seen, ['system'], 'put back by the system, not by the demoted person');
  assert.equal(r4.confReg, '0x2102');
  assert.ok(bootedOwn(r4, 'R4-3009'), `${r4.state} ${r4.cfg.hostname}`);
}

test('an admin demoted while their recovery waits (signed in again as a student): the next confirmation ends it, put back by the system', async () => {
  const user = admin({ id: 'oidc:demoted1', username: 'demoted1', name: 'Demoted One' });
  const { id, r4 } = await adminRecoversR4(user);
  j.app.deps.auth.sessions.revokeUser(user.id);
  const demoted = j.app.signIn({ ...user, role: 'student', groups: [] });
  const info = await asSession(demoted, 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('R4'))}`);
  assert.equal(info.body.canStart, false);
  const actors = taskActors('R4');
  try {
    // The confirmation is theirs to give (same person), but the step is decided on the role they have now
    assert.equal((await asSession(demoted, 'POST', `/api/recovery/runs/${id}/confirm`, { step: 'boot' })).status, 200);
    await refusedAndPutBack(id, r4, actors);
  } finally {
    actors.restore();
  }
});

test('an admin demoted in the directory, still holding an admin session: the next step is refused, and the line refuses them', async () => {
  const user = admin({ id: 'oidc:demoted2', username: 'demoted2', name: 'Demoted Two' });
  const device = j.device('R4');
  assert.equal(j.services.consoles.rooms.canPilot(user, device), true, 'an admin pilots another team\'s bench');
  const { id, r4, session } = await adminRecoversR4(user);
  const before = j.services.accounts;
  j.services.accounts = { get: (userId) => (userId === user.id ? { id: user.id, role: 'student', state: 'active' } : null) };
  const actors = taskActors('R4');
  try {
    assert.equal(j.services.consoles.rooms.canPilot(user, device), false, 'the directory\'s role, not the session\'s');
    assert.equal(j.services.consoles.rooms.canPilot(student(1), device), true, 'the bench\'s occupant still does');
    assert.equal((await asSession(session, 'POST', `/api/recovery/runs/${id}/confirm`, { step: 'boot' })).status, 200);
    await refusedAndPutBack(id, r4, actors);
  } finally {
    actors.restore();
    if (before === undefined) delete j.services.accounts;
    else j.services.accounts = before;
  }
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
