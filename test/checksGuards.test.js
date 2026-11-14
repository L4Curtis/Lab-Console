/**
 * Bench checks, what they must never do: touch a console line someone uses
 * (open in the application, a command half-typed, a configuration mode), run
 * while a job writes to the bench, carry on once their actor lost the bench;
 * who may cancel and who may read what
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startChecksApp, waitFor } from './helpers/checks.js';
import { openReady } from './helpers/consoleClient.js';
import { student } from './helpers/fakes.js';

let c;
const B = '/api/checks/benches/B4M';
const by = (list, name) => list.find((d) => d.name === name);

before(async () => {
  c = await startChecksApp();
  await c.holdBench('student1');
});

after(async () => {
  await c?.close();
});

test('lines open in the application are left alone by every check: nothing is typed, not even an Enter, the pilot keeps the keyboard', { timeout: 120_000 }, async () => {
  const r1 = await openReady(c.app, 'student1', c.device('R1'));
  r1.type('enable\r'); await r1.see(/R1#$/);
  r1.type('configure terminal\r'); await r1.see(/R1\(config\)#$/);
  const r2 = await openReady(c.app, 'student1', c.device('R2'));
  r2.type('enable\r'); await r2.see(/R2#$/);
  r2.type('clear counters'); await r2.see(/clear counters$/);
  const logs = { R1: c.dev('R1').commandLog.length, R2: c.dev('R2').commandLog.length };
  const rooms = c.services.consoles.rooms;

  for (const kind of ['interfaces', 'cabling', 'ping']) {
    const r = await c.api('student1', 'POST', `${B}/${kind}`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const check = await c.until('B4M', kind);
    for (const name of ['R1', 'R2']) {
      const d = by(check.devices, name);
      assert.equal(d.state, 'skipped', `${kind} ${name}`);
      assert.equal(d.code, 'checks.line_in_use');
      assert.deepEqual(c.dev(name).commandLog.slice(logs[name]), [], `${kind}: nothing was typed on ${name}`);
    }
    // The others were read as usual
    assert.equal(by(check.devices, kind === 'ping' ? 'R4' : 'S1').state, 'done', kind);
  }
  assert.equal(c.dev('R1').mode, 'config', 'still in configuration mode');
  assert.ok(!c.dev('R2').commandLog.includes('clear counters'), 'the half-typed command was not run');
  assert.equal(rooms.get(c.targetOf('R1')).pilot, student(1).id, 'the person keeps the keyboard');
  assert.equal(rooms.get(c.targetOf('R2')).pilot, student(1).id);
  assert.doesNotMatch(r1.text, /check:/, 'nothing shown on the open console');

  // The cabling report does not blame a line it did not read
  const cabling = c.runner.last('B4M', 'cabling');
  const link = cabling.result.links.find((l) => [l.a.name, l.b.name].includes('R1'));
  assert.equal(link.status, 'unverified');
  assert.equal(link.reason.code, 'not_read');
  // Nor does a ping matrix have a row for them
  assert.equal(c.runner.last('B4M', 'ping').result.routers.find((d) => d.name === 'R1').addresses, null);
  await Promise.all([r1.close(), r2.close()]);
  await waitFor(() => !rooms.get(c.targetOf('R1')) && !rooms.get(c.targetOf('R2')), 5000, 'the consoles to close');
});

test('no job starts while a check runs on the bench, and one can start once it is over', { timeout: 60_000 }, async () => {
  const started = await c.api('student1', 'POST', `${B}/cabling`);
  assert.equal(started.status, 202);
  const backup = await c.api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [c.key('R1')] });
  assert.equal(backup.status, 409);
  assert.equal(backup.body.code, 'jobs.check_running');
  assert.equal(backup.body.params.kind, 'cabling');
  const reset = await c.api('student1', 'POST', '/api/jobs/benches/B4M/reset', { devices: [c.key('R1')], confirm: 'B4M' });
  assert.equal(reset.body.code, 'jobs.check_running');
  assert.equal(c.services.jobs.running('B4M') ?? null, null, 'no job was created');
  assert.equal((await c.api('student1', 'POST', `${B}/cancel`)).status, 200);
  await c.until('B4M', 'cabling');
  const after = await c.api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [c.key('R1')] });
  assert.equal(after.status, 202, JSON.stringify(after.body));
  await waitFor(() => !c.services.jobs.running('B4M'), 30_000, 'the backup to end');
});

test('a check stops where it is once its actor lost the bench: the devices left are not_allowed', { timeout: 60_000 }, async () => {
  const r = await c.api('student1', 'POST', `${B}/interfaces`);
  assert.equal(r.status, 202);
  assert.equal((await c.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'maintenance' })).status, 200);
  try {
    const check = await c.until('B4M', 'interfaces');
    const stopped = check.devices.filter((d) => d.code === 'checks.not_allowed');
    assert.ok(stopped.length > 0, JSON.stringify(check.devices.map((d) => [d.name, d.state, d.code])));
    assert.ok(stopped.every((d) => d.state === 'failed'));
  } finally {
    assert.equal((await c.api('admin', 'DELETE', '/api/benches/B4M/lock')).status, 200);
  }
});

test('a teammate stops and reads a check; a guest runs one but does not read the team\'s', { timeout: 60_000 }, async () => {
  const team = c.services.teams.teamOf(student(1));
  assert.equal((await c.api('student1', 'POST', `/api/teams/${team.id}/invitations`, { username: 'student2' })).status, 201);
  assert.equal((await c.api('student2', 'POST', `/api/teams/${team.id}/accept`)).status, 200);
  assert.equal((await c.api('student3', 'POST', '/api/benches/B4M/join')).status, 202);
  assert.equal((await c.api('student1', 'POST', `/api/benches/B4M/requests/${encodeURIComponent(student(3).id)}/accept`)).status, 200);

  // A teammate who is not the actor stops the check, then reads it
  assert.equal((await c.api('student1', 'POST', `${B}/cabling`)).status, 202);
  const stop = await c.api('student2', 'POST', `${B}/cancel`);
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const cabling = await c.until('B4M', 'cabling');
  assert.equal(cabling.state, 'cancelled');
  assert.equal(cabling.cancelledBy.username, 'student2');
  assert.equal(cabling.actor.username, 'student1');
  assert.equal((await c.api('student2', 'GET', B)).body.results.cabling.id, cabling.id, 'a member reads what the team ran');

  // A guest occupant runs a check and reads its own result, not the team's
  const guest = await c.api('student3', 'POST', `${B}/ping`);
  assert.equal(guest.status, 202, JSON.stringify(guest.body));
  assert.equal((await c.api('student3', 'POST', `${B}/cancel`)).status, 200);
  const ping = await c.until('B4M', 'ping');
  const seen = (await c.api('student3', 'GET', B)).body;
  assert.equal(seen.canRun, true);
  assert.equal(seen.results.ping.id, ping.id, 'its own');
  assert.equal(seen.results.cabling, undefined, 'the team\'s is not for a guest');
  assert.ok(!(await c.api('student3', 'GET', '/api/checks/latest')).body.checks.some((x) => x.kind === 'cabling'));
  assert.equal((await c.api('student2', 'GET', B)).body.results.ping.id, ping.id, 'a member reads the guest\'s check, run on the team\'s bench');
});

test('a ping matrix past the limit lists the cells it did not try, with the reason', { timeout: 60_000 }, async () => {
  for (const [name, n] of [['R1', 1], ['R2', 2]]) {
    c.dev(name).configure([0, 1, 2].flatMap((i) => [`interface Loopback${i}`, ` ip address 10.${n}.${i}.1 255.255.255.255`]));
  }
  c.runner.pingCellsMax = 4;
  try {
    assert.equal((await c.api('student1', 'POST', `${B}/ping`)).status, 202);
    const { result } = await c.until('B4M', 'ping');
    const total = result.cells.length;
    assert.ok(total > 4, 'every cell is listed, tried or not');
    const skipped = result.cells.filter((x) => x.state === 'skipped');
    assert.equal(skipped.length, total - 4);
    assert.ok(skipped.every((x) => x.code === 'checks.too_many_cells' && x.params.max === 4 && x.sent === 0));
    assert.equal(result.summary.skipped, total - 4);
    assert.equal(result.tooMany, true);
    assert.ok(result.cells.slice(0, 4).every((x) => x.state !== 'skipped'), 'the first four were tried');
  } finally {
    c.runner.pingCellsMax = 400;
  }
});
