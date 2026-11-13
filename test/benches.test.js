/**
 * Benches (SPEC "Lot teams"): taking a bench for a team, joining on request,
 * the permission rule the consoles and the jobs ask (canPilot, canOperate),
 * locks, the automatic release on a fake clock, reservations and their
 * warning, the audiences of the events, and what only admins may do
 */
import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTeamsApp, waitFor, T0, MIN, HOUR } from './helpers/teams.js';
import { student, admin } from './helpers/fakes.js';

const S = (n) => student(n);
const ADMIN = admin();

/** A team made of these students, the first one creating it; → team id */
async function makeTeam(t, name, ...people) {
  const [first, ...rest] = people;
  const { body, status } = await t.api(first, 'POST', '/api/teams', { name });
  assert.equal(status, 201, JSON.stringify(body));
  for (const p of rest) {
    await t.api(first, 'POST', `/api/teams/${body.team.id}/invitations`, { username: p.username });
    const ok = await t.api(p, 'POST', `/api/teams/${body.team.id}/accept`);
    assert.equal(ok.status, 200);
  }
  return body.team.id;
}

/** A device of the diagram, as the consoles module hands it to canPilot */
function device(t, bench, name) {
  const lab = t.services.consoles.registry.model.labs.find((l) => l.name === bench);
  const d = lab.devices.find((x) => x.name === name);
  return t.services.consoles.registry.getDevice(d.key);
}

describe('benches: taking, joining and the permission matrix', () => {
  let t;
  let teamA; // S1, S2
  let teamB; // S5
  const guest = S(3);
  const outsider = S(4);
  before(async () => {
    t = await startTeamsApp();
    teamA = await makeTeam(t, 'Équipe A', S(1), S(2));
    teamB = await makeTeam(t, 'Équipe B', S(5));
  });
  after(async () => { await t.close(); });

  const pilot = (user, d) => t.services.benches.canPilot(user, d);
  const everyone = () => [S(1), S(2), guest, outsider, ADMIN];

  test('nobody signed in: 401; an unknown bench: 404', async () => {
    assert.equal((await t.api(null, 'GET', '/api/benches')).status, 401);
    assert.equal((await t.api(null, 'POST', '/api/benches/B4M/take')).status, 401);
    const unknown = await t.api(S(1), 'POST', '/api/benches/B9Z/take');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'benches.unknown');
  });

  test('a free bench: anyone opens its consoles, nobody but admins operates it', async () => {
    const r1 = device(t, 'B4M', 'R1');
    for (const u of everyone()) assert.equal(pilot(u, r1), true, u.username);
    assert.equal(pilot(null, r1), false, 'no user, no console');
    assert.equal(t.services.benches.canOperate(S(1), 'B4M'), false);
    assert.equal(t.services.benches.canOperate(ADMIN, 'B4M'), true);
    assert.equal(t.services.benches.holder('B4M'), null);
    const detail = await t.api(S(1), 'GET', '/api/benches/B4M');
    assert.equal(detail.body.you.canTake, true);
    assert.equal(detail.body.you.canJoin, false);
  });

  test('without a team nobody takes a bench', async () => {
    const res = await t.api(outsider, 'POST', '/api/benches/B4M/take');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'benches.no_team');
    const adm = await t.api(ADMIN, 'POST', '/api/benches/B4M/take');
    assert.equal(adm.body.code, 'benches.no_team', 'admins assign instead');
  });

  test('a member takes the bench for the team: every member is an occupant', async () => {
    const state = await t.listen(outsider);
    const res = await t.api(S(1), 'POST', '/api/benches/B4M/take');
    assert.equal(res.status, 200);
    assert.equal(res.body.holder.teamId, teamA);
    assert.equal(res.body.holder.teamName, 'Équipe A');
    assert.deepEqual(t.services.benches.holder('B4M'), { teamId: teamA, since: new Date(T0).toISOString() });
    assert.deepEqual(t.services.benches.occupants('B4M').sort(), ['oidc:student1', 'oidc:student2']);
    assert.equal(t.services.benches.isOccupant(S(2), 'B4M'), true);
    // Everyone sees who holds the bench
    const seen = await state.until((e) => e.topic === 'benches:state' && e.data.benches.find((b) => b.bench === 'B4M').holder);
    assert.equal(seen.data.benches.find((b) => b.bench === 'B4M').holder.teamName, 'Équipe A');
    const again = await t.api(S(2), 'POST', '/api/benches/B4M/take');
    assert.equal(again.status, 200, 'taking your own bench again changes nothing');
    const actions = (await t.lab.deps.audit.query({ bench: 'B4M', action: 'bench.take' })).length;
    assert.equal(actions, 1);
  });

  test('a taken bench: occupants and admins pilot, everyone else watches', async () => {
    const r1 = device(t, 'B4M', 'R1');
    assert.equal(pilot(S(1), r1), true);
    assert.equal(pilot(S(2), r1), true);
    assert.equal(pilot(guest, r1), false, 'not accepted yet');
    assert.equal(pilot(outsider, r1), false);
    assert.equal(pilot(S(5), r1), false, 'another team');
    assert.equal(pilot(ADMIN, r1), true);
    assert.equal(t.services.benches.canOperate(S(1), 'B4M'), true);
    assert.equal(t.services.benches.canOperate(outsider, 'B4M'), false);
    assert.equal(t.services.benches.canOperate(ADMIN, 'B4M'), true);
  });

  test('another team cannot take it; a team holds one bench at a time', async () => {
    const taken = await t.api(S(5), 'POST', '/api/benches/B4M/take');
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'benches.taken');
    assert.equal(taken.body.params.team, 'Équipe A');
    const second = await t.api(S(2), 'POST', '/api/benches/B4H/take');
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'benches.team_has_bench');
    assert.equal(second.body.params.bench, 'B4M');
  });

  test('a join request reaches the occupants only; a member accepts it', async () => {
    const member1 = await t.listen(S(1));
    const member2 = await t.listen(S(2));
    const asker = await t.listen(guest);
    const other = await t.listen(outsider);
    const adm = await t.listen(ADMIN);

    const res = await t.api(guest, 'POST', '/api/benches/B4M/join');
    assert.equal(res.status, 202);
    const seen = await member2.until((e) => e.topic === 'benches:requests:B4M' && e.data.requests.length === 1);
    assert.equal(seen.data.requests[0].username, 'student3');
    await member1.until((e) => e.topic === 'benches:requests:B4M' && e.data.requests.length === 1);
    await t.settle(asker, other, adm);
    for (const s of [asker, other, adm]) assert.ok(!s.topics().includes('benches:requests:B4M'), 'only the occupants hear about requests');
    // …and the REST view shows the requests to occupants and admins only
    assert.equal((await t.api(outsider, 'GET', '/api/benches/B4M')).body.requests.length, 0);
    assert.equal((await t.api(S(1), 'GET', '/api/benches/B4M')).body.requests.length, 1);
    assert.equal((await t.api(guest, 'GET', '/api/benches/B4M')).body.you.pending, true);

    const twice = await t.api(guest, 'POST', '/api/benches/B4M/join');
    assert.equal(twice.status, 202);
    assert.equal((await t.api(S(1), 'GET', '/api/benches/B4M')).body.requests.length, 1, 'asking twice is one request');

    const notMember = await t.api(outsider, 'POST', '/api/benches/B4M/requests/oidc:student3/accept');
    assert.equal(notMember.status, 403);
    assert.equal(notMember.body.code, 'benches.not_member');

    const accepted = await t.api(S(2), 'POST', `/api/benches/B4M/requests/${encodeURIComponent('oidc:student3')}/accept`);
    assert.equal(accepted.status, 200);
    const told = await asker.until((e) => e.topic === 'benches:request');
    assert.deepEqual(told.data, { bench: 'B4M', state: 'accepted', by: 'Student 2' });
    await t.settle(other);
    assert.ok(!other.topics().includes('benches:request'));
    assert.equal(t.services.benches.isOccupant(guest, 'B4M'), true);
    assert.equal(pilot(guest, device(t, 'B4M', 'R1')), true, 'an accepted guest pilots');
    assert.equal(t.services.benches.canOperate(guest, 'B4M'), true);
    // Now an occupant, the guest receives the requests topic
    await asker.until((e) => e.topic === 'benches:requests:B4M');
    const again = await t.api(guest, 'POST', '/api/benches/B4M/join');
    assert.equal(again.body.code, 'benches.already_occupant');
  });

  test('a refused request: the asker is told and stays outside', async () => {
    const asker = await t.listen(outsider);
    await t.api(outsider, 'POST', '/api/benches/B4M/join');
    const byGuest = await t.api(guest, 'POST', '/api/benches/B4M/requests/oidc:student4/refuse');
    assert.equal(byGuest.status, 403, 'a guest does not answer for the team');
    const refused = await t.api(S(1), 'POST', '/api/benches/B4M/requests/oidc:student4/refuse');
    assert.equal(refused.status, 200);
    const told = await asker.until((e) => e.topic === 'benches:request');
    assert.equal(told.data.state, 'refused');
    assert.equal(t.services.benches.isOccupant(outsider, 'B4M'), false);
    const gone = await t.api(S(1), 'POST', '/api/benches/B4M/requests/oidc:student4/accept');
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'benches.no_request', 'answering a request that is not there');
    // A request can also be withdrawn by the one who made it
    await t.api(outsider, 'POST', '/api/benches/B4M/join');
    assert.equal((await t.api(outsider, 'DELETE', '/api/benches/B4M/join')).status, 200);
    const nothing = await t.api(outsider, 'DELETE', '/api/benches/B4M/join');
    assert.equal(nothing.status, 404);
    assert.equal(nothing.body.code, 'benches.no_request', 'withdrawing a request that is not there');
  });

  test('at most 20 requests wait on a bench; asking twice is still one', async () => {
    const people = Array.from({ length: 20 }, (_, i) => S(100 + i));
    for (const p of people) assert.equal((await t.api(p, 'POST', '/api/benches/B4M/join')).status, 202, p.username);
    const late = await t.api(S(120), 'POST', '/api/benches/B4M/join');
    assert.equal(late.status, 429);
    assert.equal(late.body.code, 'benches.too_many_requests');
    assert.equal((await t.api(people[0], 'POST', '/api/benches/B4M/join')).status, 202, 'a request already waiting is not refused');
    for (const p of people) await t.api(p, 'DELETE', '/api/benches/B4M/join');
  });

  test('joining a free bench makes no sense', async () => {
    const res = await t.api(outsider, 'POST', '/api/benches/B6B/join');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'benches.not_taken');
  });

  test('a shared device follows any of its benches', async () => {
    const s5 = device(t, 'B4M', 'S5'); // the same console line as B4H S5 and B5B S5
    assert.deepEqual(t.benches.benchesOfDevice(s5).sort(), ['B4H', 'B4M', 'B5B']);
    assert.equal(pilot(outsider, s5), true, 'B4H and B5B are free');
    await t.api(S(5), 'POST', '/api/benches/B4H/take');
    await t.api(ADMIN, 'PUT', '/api/benches/B5B/lock', { reason: 'Prepared for the graded lab' });
    assert.equal(pilot(outsider, s5), false, 'every bench of the device is taken by others or locked');
    assert.equal(t.services.benches.holder('B4H').teamId, teamB);
    assert.equal(pilot(S(5), s5), true, 'team B pilots it through B4H');
    assert.equal(pilot(S(1), s5), true, 'team A pilots it through B4M');
    assert.equal(pilot(ADMIN, s5), true);
    await t.api(ADMIN, 'DELETE', '/api/benches/B5B/lock');
    assert.equal(pilot(outsider, s5), true, 'B5B is open again');
    assert.equal(pilot(outsider, device(t, 'B5B', 'R1')), true);
  });

  test('admin switches stay open to every signed-in user, whatever the locks', async () => {
    const sw = { key: 'admin:b5-sw1', name: 'Admin switch 1', labName: 'Bay 5 Admin switch 1', target: { host: '10.22.9.212', port: 2040 } };
    for (const name of t.benches.names()) await t.api(ADMIN, 'PUT', `/api/benches/${name}/lock`, { reason: 'Exam' });
    for (const u of everyone()) assert.equal(pilot(u, sw), true, u.username);
    assert.equal(pilot(null, sw), false);
    for (const name of t.benches.names()) await t.api(ADMIN, 'DELETE', `/api/benches/${name}/lock`);
  });

  test('a device outside the diagram belongs to no bench', () => {
    assert.equal(pilot(outsider, { key: 'nope', name: 'X', target: { host: '10.0.0.1', port: 1 } }), false);
    assert.equal(pilot(ADMIN, { key: 'nope', name: 'X' }), true, 'admins pilot anything');
  });

  test('a locked bench refuses everyone but admins, and shows its reason', async () => {
    const studentLock = await t.api(S(1), 'PUT', '/api/benches/B4M/lock', { reason: 'Mine' });
    assert.equal(studentLock.status, 403);
    for (const reason of ['', '   ', 'x'.repeat(201), 42]) {
      const bad = await t.api(ADMIN, 'PUT', '/api/benches/B4M/lock', { reason });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'benches.bad_reason');
    }
    const locked = await t.api(ADMIN, 'PUT', '/api/benches/B4M/lock', { reason: 'Prepared for the graded lab' });
    assert.equal(locked.status, 200);
    assert.equal(t.services.benches.lock('B4M').reason, 'Prepared for the graded lab');
    const r1 = device(t, 'B4M', 'R1');
    for (const u of [S(1), S(2), guest, outsider, S(5)]) {
      assert.equal(pilot(u, r1), false, `${u.username} on a locked bench`);
      assert.equal(t.services.benches.canOperate(u, 'B4M'), false);
    }
    assert.equal(pilot(ADMIN, r1), true);
    assert.equal(t.services.benches.canOperate(ADMIN, 'B4M'), true);
    // A locked free bench too
    await t.api(ADMIN, 'PUT', '/api/benches/B6B/lock', { reason: 'Broken cable' });
    assert.equal(pilot(outsider, device(t, 'B6B', 'R1')), false);
    const take = await t.api(S(5), 'POST', '/api/benches/B6B/take');
    assert.equal(take.status, 423);
    assert.equal(take.body.code, 'benches.locked');
    assert.equal(take.body.params.reason, 'Broken cable');
    const join = await t.api(outsider, 'POST', '/api/benches/B4M/join');
    assert.equal(join.status, 423);
    const shown = await t.api(outsider, 'GET', '/api/benches/B4M');
    assert.equal(shown.body.lock.reason, 'Prepared for the graded lab');
    assert.equal(shown.body.you.canPilot, false);
    const unlockByStudent = await t.api(S(1), 'DELETE', '/api/benches/B4M/lock');
    assert.equal(unlockByStudent.status, 403);
    await t.api(ADMIN, 'DELETE', '/api/benches/B4M/lock');
    await t.api(ADMIN, 'DELETE', '/api/benches/B6B/lock');
    const twice = await t.api(ADMIN, 'DELETE', '/api/benches/B6B/lock');
    assert.equal(twice.status, 409);
    assert.equal(pilot(S(1), r1), true);
  });

  test('history: occupants and admins see who did what on the bench', async () => {
    const res = await t.api(guest, 'GET', '/api/benches/B4M/history');
    assert.equal(res.status, 200);
    const actions = res.body.history.map((e) => e.action);
    for (const a of ['bench.take', 'bench.join.request', 'bench.join.accept', 'bench.lock', 'bench.unlock']) assert.ok(actions.includes(a), a);
    // The jobs lot records what it does on a bench as 'job.<something>': the history shows those too, and only those
    t.lab.deps.audit.log(S(1), 'job.backup', { bench: 'B4M', device: 'R1' });
    t.lab.deps.audit.log(S(1), 'console.open', { bench: 'B4M', device: 'R1' });
    t.lab.deps.audit.log(S(1), 'job.backup', { bench: 'B5M', device: 'R1' });
    const withJobs = (await t.api(guest, 'GET', '/api/benches/B4M/history')).body.history;
    assert.equal(withJobs.filter((e) => e.action === 'job.backup').length, 1, 'a job on this bench, not on another');
    assert.ok(!withJobs.some((e) => e.action === 'console.open'));
    assert.ok(res.body.history.every((e) => !('ip' in e)), 'no addresses');
    assert.equal(res.body.history.find((e) => e.action === 'bench.take').actor.name, 'Student 1');
    assert.equal((await t.api(outsider, 'GET', '/api/benches/B4M/history')).status, 403);
    assert.equal((await t.api(ADMIN, 'GET', '/api/benches/B4M/history')).status, 200);
  });

  test('a guest leaves; only the team or an admin releases', async () => {
    const byGuest = await t.api(guest, 'POST', '/api/benches/B4M/release');
    assert.equal(byGuest.status, 403);
    assert.equal(byGuest.body.code, 'benches.not_member');
    const left = await t.api(guest, 'POST', '/api/benches/B4M/leave');
    assert.equal(left.status, 200);
    assert.equal(t.services.benches.isOccupant(guest, 'B4M'), false);
    const notGuest = await t.api(S(1), 'POST', '/api/benches/B4M/leave');
    assert.equal(notGuest.status, 409, 'a member leaves the team, not the bench');
    assert.equal(notGuest.body.code, 'benches.member_of_holder');
    const stranger = await t.api(outsider, 'POST', '/api/benches/B4M/leave');
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.code, 'benches.not_guest', 'leaving a bench where you are no guest');
    const again = await t.api(guest, 'POST', '/api/benches/B4M/leave');
    assert.equal(again.body.code, 'benches.not_guest', 'leaving twice');
    const adminRemove = await t.api(ADMIN, 'DELETE', '/api/benches/B4M/guests/oidc:student4');
    assert.equal(adminRemove.body.code, 'benches.not_guest');
  });

  test('releasing calls the onRelease hooks and offers what they return', async () => {
    const calls = [];
    const off = t.services.benches.onRelease((info) => { calls.push(info); return { kind: 'backup', bench: info.labName }; });
    const detail = await t.api(S(1), 'GET', '/api/benches/B4M');
    assert.equal(detail.body.backupOffer, true, 'the UI offers a backup only when a handler exists');
    const res = await t.api(S(2), 'POST', '/api/benches/B4M/release');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.offers, [{ kind: 'backup', bench: 'B4M' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].labName, 'B4M');
    assert.equal(calls[0].teamId, teamA);
    assert.equal(calls[0].by.id, 'oidc:student2');
    off();
    assert.equal((await t.api(S(1), 'GET', '/api/benches/B4M')).body.backupOffer, false);
    assert.equal(t.services.benches.holder('B4M'), null);
    assert.deepEqual(t.services.benches.occupants('B4M'), []);
    const twice = await t.api(S(2), 'POST', '/api/benches/B4M/release');
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'benches.not_taken');
    // A hook that throws does not prevent the release
    const offBad = t.services.benches.onRelease(() => { throw new Error('boom'); });
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    assert.equal((await t.api(S(1), 'POST', '/api/benches/B4M/release')).status, 200);
    offBad();
  });

  test('admin overrides: assign a bench, remove a guest, release any bench', async () => {
    const studentAssign = await t.api(S(1), 'POST', '/api/benches/B5M/assign', { teamId: teamA });
    assert.equal(studentAssign.status, 403);
    const unknownTeam = await t.api(ADMIN, 'POST', '/api/benches/B5M/assign', { teamId: 'nope' });
    assert.equal(unknownTeam.status, 404);
    // Team B holds B4H; the admin gives it to team A
    const assigned = await t.api(ADMIN, 'POST', '/api/benches/B4H/assign', { teamId: teamA });
    assert.equal(assigned.status, 200);
    assert.equal(t.services.benches.holder('B4H').teamId, teamA);
    // …then moves team A to B5M: one bench per team, B4H is given back
    await t.api(ADMIN, 'POST', '/api/benches/B5M/assign', { teamId: teamA });
    assert.equal(t.services.benches.holder('B4H'), null);
    assert.equal(t.services.benches.holder('B5M').teamId, teamA);
    await t.api(guest, 'POST', '/api/benches/B5M/join');
    await t.api(S(1), 'POST', '/api/benches/B5M/requests/oidc:student3/accept');
    const studentRemove = await t.api(S(1), 'DELETE', '/api/benches/B5M/guests/oidc:student3');
    assert.equal(studentRemove.status, 403);
    const told = await t.listen(guest);
    const removed = await t.api(ADMIN, 'DELETE', '/api/benches/B5M/guests/oidc:student3');
    assert.equal(removed.status, 200);
    assert.equal((await told.until((e) => e.topic === 'benches:request')).data.state, 'removed');
    assert.equal(t.services.benches.isOccupant(guest, 'B5M'), false);
    const released = await t.api(ADMIN, 'POST', '/api/benches/B5M/release');
    assert.equal(released.status, 200);
    const entry = await waitFor(async () => (await t.lab.deps.audit.query({ bench: 'B5M', action: 'bench.release' }))[0]);
    assert.equal(entry.details.reason, 'admin');
    assert.equal(entry.actor.id, 'oidc:admin');
    for (const a of ['bench.assign', 'bench.guest.remove']) assert.ok((await t.lab.deps.audit.query({ action: a })).length > 0, a);
  });

  test('a dissolved team gives its bench back', async () => {
    const teamC = await makeTeam(t, 'Équipe C', S(7));
    await t.api(S(7), 'POST', '/api/benches/B6H/take');
    assert.equal(t.services.benches.holder('B6H').teamId, teamC);
    await t.api(S(7), 'POST', `/api/teams/${teamC}/leave`);
    await waitFor(() => t.services.benches.holder('B6H') === null);
    const entry = await waitFor(async () => (await t.lab.deps.audit.query({ bench: 'B6H', action: 'bench.release' }))[0]);
    assert.equal(entry.details.reason, 'dissolved');
  });
});

describe('benches: automatic release after BENCH_IDLE_HOURS without activity', () => {
  let t;
  let team;
  before(async () => {
    t = await startTeamsApp();
    team = await makeTeam(t, 'Les lents', S(1));
  });
  after(async () => { await t.close(); });

  test('activity postpones the release; three idle hours end it', async () => {
    const calls = [];
    t.services.benches.onRelease((info) => { calls.push(info); });
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    t.clock.ms = T0 + 2 * HOUR + 59 * MIN;
    await t.tick();
    assert.equal(t.services.benches.holder('B4M').teamId, team, 'not yet');

    t.services.benches.touch('B4M'); // the consoles report activity
    await t.lab.deps.store.flush();
    const detail = await t.api(S(1), 'GET', '/api/benches/B4M');
    assert.equal(detail.body.releaseAt, new Date(T0 + 5 * HOUR + 59 * MIN).toISOString());

    t.clock.ms = T0 + 3 * HOUR + 30 * MIN;
    await t.tick();
    assert.ok(t.services.benches.holder('B4M'), 'the activity postponed it');

    t.clock.ms = T0 + 5 * HOUR + 59 * MIN;
    await t.tick();
    assert.equal(t.services.benches.holder('B4M'), null, 'released after three idle hours');
    const entry = await waitFor(async () => (await t.lab.deps.audit.query({ bench: 'B4M', action: 'bench.release.idle' }))[0]);
    assert.equal(entry.actor.id, 'system');
    assert.equal(entry.details.reason, 'idle');
    assert.deepEqual(calls, [{ labName: 'B4M', teamId: team, by: 'system', reason: 'idle' }]);
  });

  test('touch is cheap: at most one write a minute, nothing on a free bench', async () => {
    t.services.benches.touch('B4H'); // free: nothing happens
    await t.lab.deps.store.flush();
    assert.equal(t.services.benches.holder('B4H'), null);
    await t.api(S(1), 'POST', '/api/benches/B4H/take');
    const taken = t.clock.ms;
    t.clock.ms += 30_000;
    t.services.benches.touch('B4H');
    await t.lab.deps.store.flush();
    assert.equal((await t.api(S(1), 'GET', '/api/benches/B4H')).body.lastActivity, new Date(taken).toISOString());
    // The "I am still here" button forces it
    const res = await t.api(S(1), 'POST', '/api/benches/B4H/touch');
    assert.equal(res.status, 200);
    await t.lab.deps.store.flush();
    assert.equal((await t.api(S(1), 'GET', '/api/benches/B4H')).body.lastActivity, new Date(t.clock.ms).toISOString());
    const outsider = await t.api(S(2), 'POST', '/api/benches/B4H/touch');
    assert.equal(outsider.status, 403);
  });

  test('a shorter BENCH_IDLE_HOURS is honoured', async () => {
    const short = await startTeamsApp({ env: { BENCH_IDLE_HOURS: '1' } });
    try {
      await makeTeam(short, 'Rapides', S(1));
      await short.api(S(1), 'POST', '/api/benches/B5H/take');
      short.clock.ms = T0 + HOUR;
      await short.tick();
      assert.equal(short.services.benches.holder('B5H'), null);
    } finally {
      await short.close();
    }
  });
});

describe('benches: reservations', () => {
  let t;
  let teamA; // S1, S2
  let teamB; // S5
  const iso = (ms) => new Date(ms).toISOString();
  const book = (who, bench, from, to, extra = {}) => t.api(who, 'POST', '/api/benches/reservations', { bench, start: iso(from), end: iso(to), ...extra });

  before(async () => {
    t = await startTeamsApp();
    teamA = await makeTeam(t, 'Équipe A', S(1), S(2));
    teamB = await makeTeam(t, 'Équipe B', S(5));
  });
  after(async () => { await t.close(); });

  test('a team books a slot; everyone sees the calendar', async () => {
    const res = await book(S(1), 'B5M', T0 + HOUR, T0 + 3 * HOUR);
    assert.equal(res.status, 201);
    assert.equal(res.body.reservation.teamId, teamA);
    assert.equal(res.body.reservation.teamName, 'Équipe A');
    const list = await t.api(S(4), 'GET', `/api/benches/reservations?bench=B5M&from=${iso(T0)}&to=${iso(T0 + 24 * HOUR)}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.reservations.length, 1);
    assert.deepEqual(list.body.limits, { maxFuture: 2, maxHours: 4, maxDaysAhead: 14 });
    const outside = await t.api(S(4), 'GET', `/api/benches/reservations?from=${iso(T0 + 4 * HOUR)}`);
    assert.equal(outside.body.reservations.length, 0);
    assert.equal((await t.api(null, 'GET', '/api/benches/reservations')).status, 401);
  });

  test('bad slots are refused', async () => {
    const cases = [
      [book(S(5), 'B5M', T0 + 4 * HOUR, T0 + 4 * HOUR), 400, 'benches.bad_slot'],
      [book(S(5), 'B5M', T0 + 4 * HOUR + 7 * MIN, T0 + 5 * HOUR), 400, 'benches.bad_slot'],
      [t.api(S(5), 'POST', '/api/benches/reservations', { bench: 'B5M', start: 'tomorrow', end: iso(T0 + 5 * HOUR) }), 400, 'benches.bad_slot'],
      [book(S(5), 'B5M', T0 - 2 * HOUR, T0 - HOUR), 400, 'benches.slot_in_past'],
      [book(S(5), 'B5M', T0 + 4 * HOUR, T0 + 9 * HOUR), 400, 'benches.slot_too_long'],
      [book(S(5), 'B5M', T0 + 15 * 24 * HOUR, T0 + 15 * 24 * HOUR + HOUR), 400, 'benches.slot_too_far'],
      [book(S(5), 'B9Z', T0 + 4 * HOUR, T0 + 5 * HOUR), 404, 'benches.unknown'],
      [book(S(4), 'B5M', T0 + 4 * HOUR, T0 + 5 * HOUR), 409, 'benches.no_team'],
    ];
    for (const [pending, status, code] of cases) {
      const res = await pending;
      assert.equal(res.status, status, code);
      assert.equal(res.body.code, code);
    }
  });

  test('two slots of one bench never overlap; adjacent ones are fine', async () => {
    const clash = await book(S(5), 'B5M', T0 + 2 * HOUR, T0 + 4 * HOUR);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, 'benches.slot_overlap');
    assert.equal(clash.body.params.team, 'Équipe A');
    const inside = await book(S(5), 'B5M', T0 + 90 * MIN, T0 + 2 * HOUR);
    assert.equal(inside.body.code, 'benches.slot_overlap');
    const adminClash = await book(ADMIN, 'B5M', T0 + 2 * HOUR, T0 + 4 * HOUR, { teamId: teamB });
    assert.equal(adminClash.body.code, 'benches.slot_overlap', 'admins cannot double-book either');
    const adjacent = await book(S(5), 'B5M', T0 + 3 * HOUR, T0 + 4 * HOUR);
    assert.equal(adjacent.status, 201);
    const otherBench = await book(S(5), 'B6H', T0 + HOUR, T0 + 3 * HOUR);
    assert.equal(otherBench.status, 201, 'the same hours on another bench');
  });

  test('a team has at most RESERVATION_MAX_FUTURE future slots; admins are not limited', async () => {
    const third = await book(S(5), 'B6B', T0 + 24 * HOUR, T0 + 25 * HOUR);
    assert.equal(third.status, 409);
    assert.equal(third.body.code, 'benches.too_many_slots');
    assert.equal(third.body.params.max, 2);
    const byAdmin = await book(ADMIN, 'B6B', T0 + 24 * HOUR, T0 + 30 * HOUR, { teamId: teamB });
    assert.equal(byAdmin.status, 201, 'longer than 4 h and a third slot');
    assert.equal(byAdmin.body.reservation.teamId, teamB);
    const unknown = await book(ADMIN, 'B6B', T0 + 40 * HOUR, T0 + 41 * HOUR, { teamId: 'nope' });
    assert.equal(unknown.status, 404);
  });

  test('only the team that booked (or an admin) cancels a slot', async () => {
    const mine = (await t.api(S(5), 'GET', '/api/benches/reservations?bench=B6B')).body.reservations[0];
    const outsider = await t.api(S(1), 'DELETE', `/api/benches/reservations/${mine.id}`);
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.code, 'benches.not_your_reservation');
    assert.equal((await t.api(S(5), 'DELETE', `/api/benches/reservations/${mine.id}`)).status, 200);
    const gone = await t.api(S(5), 'DELETE', `/api/benches/reservations/${mine.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'benches.no_reservation');
    const b6h = (await t.api(S(5), 'GET', '/api/benches/reservations?bench=B6H')).body.reservations[0];
    assert.equal((await t.api(ADMIN, 'DELETE', `/api/benches/reservations/${b6h.id}`)).status, 200);
    for (const a of ['bench.reserve', 'bench.reservation.cancel']) assert.ok((await t.lab.deps.audit.query({ action: a })).length > 0, a);
  });

  test('the occupants are warned ten minutes before another team\'s slot, and only them', async () => {
    // Team B holds B5M now; team A booked it from T0 + 1 h
    const take = await t.api(S(5), 'POST', '/api/benches/B5M/take');
    assert.equal(take.status, 200, 'free until the slot starts');
    const occupant = await t.listen(S(5));
    const booker = await t.listen(S(1));
    const outsider = await t.listen(S(4));
    t.clock.ms = T0 + 49 * MIN;
    await t.tick();
    await t.settle(occupant);
    assert.ok(!occupant.topics().includes('benches:warning'), 'eleven minutes before: not yet');
    t.clock.ms = T0 + 50 * MIN;
    await t.tick();
    const warning = await occupant.until((e) => e.topic === 'benches:warning');
    assert.deepEqual(warning.data, { bench: 'B5M', start: iso(T0 + HOUR), end: iso(T0 + 3 * HOUR), team: 'Équipe A', minutes: 10 });
    await t.settle(booker, outsider);
    assert.ok(!booker.topics().includes('benches:warning'));
    assert.ok(!outsider.topics().includes('benches:warning'));
    t.clock.ms = T0 + 55 * MIN;
    await t.tick();
    await t.settle(occupant);
    assert.equal(occupant.events.filter((e) => e.topic === 'benches:warning').length, 1, 'warned once');
  });

  test('before its slot the team waits; at the start of the slot it takes the bench', async () => {
    const early = await t.api(S(1), 'POST', '/api/benches/B5M/take');
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'benches.taken');
    const members = await t.listen(S(2));
    t.clock.ms = T0 + HOUR;
    await t.tick();
    await members.until((e) => e.topic === 'benches:slot' && e.data.bench === 'B5M');
    const detail = await t.api(S(1), 'GET', '/api/benches/B5M');
    assert.equal(detail.body.you.canTake, true);
    const res = await t.api(S(1), 'POST', '/api/benches/B5M/take');
    assert.equal(res.status, 200);
    assert.equal(t.services.benches.holder('B5M').teamId, teamA);
    const entry = await waitFor(async () => (await t.lab.deps.audit.query({ bench: 'B5M', action: 'bench.release' }))[0]);
    assert.equal(entry.details.reason, 'reservation');
    assert.equal(entry.details.teamId, teamB);
  });

  test('during another team\'s slot a free bench is not for the taking', async () => {
    await t.api(S(1), 'POST', '/api/benches/B5M/release');
    const res = await t.api(S(5), 'POST', '/api/benches/B5M/take');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'benches.reserved');
    assert.equal(res.body.params.team, 'Équipe A');
    assert.equal((await t.api(S(5), 'GET', '/api/benches/B5M')).body.you.canTake, false);
  });

  test('a dissolved team loses its slots', async () => {
    const teamC = await makeTeam(t, 'Équipe C', S(7));
    assert.equal((await book(S(7), 'B6B', T0 + 30 * HOUR, T0 + 31 * HOUR)).status, 201);
    await t.api(ADMIN, 'DELETE', `/api/teams/${teamC}`);
    await waitFor(async () => (await t.api(S(1), 'GET', '/api/benches/reservations?bench=B6B')).body.reservations.every((r) => r.teamId !== teamC));
  });
});

describe('benches: a booking cannot be used to evict the holder', () => {
  let t;
  let teamA; // S1
  let teamB; // S5
  const iso = (ms) => new Date(ms).toISOString();
  const book = (who, bench, from, to, extra = {}) => t.api(who, 'POST', '/api/benches/reservations', { bench, start: iso(from), end: iso(to), ...extra });

  before(async () => {
    t = await startTeamsApp();
    teamA = await makeTeam(t, 'Équipe A', S(1));
    teamB = await makeTeam(t, 'Équipe B', S(5));
    t.clock.ms = T0 + 7 * MIN;
    assert.equal((await t.api(S(1), 'POST', '/api/benches/B4M/take')).status, 200);
  });
  after(async () => { await t.close(); });

  test('a slot that has started is refused, and so the holder cannot be replaced at once', async () => {
    const started = await book(S(5), 'B4M', T0, T0 + 4 * HOUR);
    assert.equal(started.status, 400);
    assert.equal(started.body.code, 'benches.slot_in_past');
    const take = await t.api(S(5), 'POST', '/api/benches/B4M/take');
    assert.equal(take.status, 409);
    assert.equal(take.body.code, 'benches.taken');
    assert.equal(t.services.benches.holder('B4M').teamId, teamA);
    // Team A was not released, and nobody was told it was
    const releases = await t.lab.deps.audit.query({ bench: 'B4M', action: 'bench.release' });
    assert.equal(releases.length, 0);
  });

  test('on a bench held by another team a slot starts at least ten minutes ahead', async () => {
    const soon = await book(S(5), 'B4M', T0 + 15 * MIN, T0 + 2 * HOUR); // eight minutes from now
    assert.equal(soon.status, 409);
    assert.equal(soon.body.code, 'benches.slot_too_soon');
    assert.equal(soon.body.params.minutes, 10);
    const ok = await book(S(5), 'B4M', T0 + 30 * MIN, T0 + 2 * HOUR); // twenty-three minutes from now
    assert.equal(ok.status, 201);
    assert.equal((await t.api(S(5), 'POST', '/api/benches/B4M/take')).body.code, 'benches.taken', 'not before the slot');
  });

  test('the holder is warned for that slot', async () => {
    const holder = await t.listen(S(1));
    t.clock.ms = T0 + 20 * MIN;
    await t.tick();
    const warning = await holder.until((e) => e.topic === 'benches:warning');
    assert.equal(warning.data.bench, 'B4M');
    assert.equal(warning.data.minutes, 10);
    t.clock.ms = T0 + 7 * MIN;
  });

  test('the holder itself, a free bench and admins are not held to the ten minutes', async () => {
    assert.equal((await book(S(1), 'B4M', T0 + 2 * HOUR, T0 + 3 * HOUR)).status, 201, 'its own bench');
    assert.equal((await book(S(5), 'B5M', T0 + 15 * MIN, T0 + HOUR)).status, 201, 'a free bench');
    const byAdmin = await book(ADMIN, 'B4M', T0 + 3 * HOUR, T0 + 4 * HOUR, { teamId: teamB });
    assert.equal(byAdmin.status, 201);
    const past = await book(ADMIN, 'B6H', T0, T0 + 2 * HOUR, { teamId: teamB });
    assert.equal(past.status, 201, 'admins arrange the calendar as they wish');
    const over = await book(S(5), 'B6B', T0 - 2 * HOUR, T0 - HOUR);
    assert.equal(over.body.code, 'benches.slot_in_past');
  });

  test('a team that takes a bench after the warning time was passed is warned in its turn', async () => {
    // B5M is free and booked by team B from T0 + 15 min: a tick finds nobody to warn
    await t.api(S(1), 'POST', '/api/benches/B4M/release');
    t.clock.ms = T0 + 7 * MIN;
    await t.tick();
    const teamC = await makeTeam(t, 'Équipe C', S(7));
    t.clock.ms = T0 + 8 * MIN;
    assert.equal((await t.api(S(7), 'POST', '/api/benches/B5M/take')).status, 200);
    const holder = await t.listen(S(7));
    await t.tick();
    const warning = await holder.until((e) => e.topic === 'benches:warning');
    assert.equal(warning.data.bench, 'B5M');
    assert.equal(warning.data.team, 'Équipe B');
    assert.equal(warning.data.minutes, 7);
    assert.equal(t.services.benches.holder('B5M').teamId, teamC);
    await t.tick();
    await t.settle(holder);
    assert.equal(holder.events.filter((e) => e.topic === 'benches:warning').length, 1, 'once');
  });
});

describe('benches: decisions are taken on the bench as it is when the change runs', () => {
  let t;
  const occupancyDoc = () => t.lab.deps.store.json('benches/occupancy.json', {});
  beforeEach(async () => { t = await startTeamsApp(); });
  afterEach(async () => { await t.close(); });

  test('a member of the team that lost a bench cannot release the bench of the team that took it', async () => {
    await makeTeam(t, 'Équipe A', S(1), S(2));
    const teamB = await makeTeam(t, 'Équipe B', S(5));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    // Sent together: A releases, B takes, a second member of A releases "again"
    const [first, take, second] = await Promise.allSettled([
      t.benches.release(S(1), 'B4M'),
      t.benches.take(S(5), 'B4M'),
      t.benches.release(S(2), 'B4M'),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(take.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.status, 403);
    assert.equal(second.reason.code, 'benches.not_member');
    assert.equal(t.services.benches.holder('B4M')?.teamId, teamB, 'team B still holds the bench');
  });

  test('…nor answer the join requests of the bench of the team that took it', async () => {
    await makeTeam(t, 'Équipe A', S(1));
    const teamB = await makeTeam(t, 'Équipe B', S(5));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    await t.api(S(3), 'POST', '/api/benches/B4M/join');
    const [released, take, answer] = await Promise.allSettled([
      t.benches.release(S(1), 'B4M'),
      t.benches.take(S(5), 'B4M'),
      t.benches.answer(S(1), 'B4M', 'oidc:student3', true),
    ]);
    assert.equal(released.status, 'fulfilled');
    assert.equal(take.status, 'fulfilled');
    assert.equal(answer.status, 'rejected');
    assert.equal(answer.reason.code, 'benches.not_member');
    assert.equal(t.services.benches.holder('B4M').teamId, teamB);
    assert.deepEqual(t.services.benches.occupants('B4M'), ['oidc:student5'], 'nobody was let in');
  });

  test('a release that expects another occupancy changes nothing', async () => {
    await makeTeam(t, 'Équipe A', S(1));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    await assert.rejects(
      t.benches.release('system', 'B4M', 'dissolved', { expect: (o) => o.teamId === 'another-team' }),
      (err) => err.status === 409 && err.code === 'benches.changed',
    );
    assert.ok(t.services.benches.holder('B4M'));
  });

  test('the automatic release does not delete a team that took the bench while a hook was running', async () => {
    await makeTeam(t, 'Équipe A', S(1));
    await makeTeam(t, 'Équipe B', S(5));
    const teamC = await makeTeam(t, 'Équipe C', S(7));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    await t.api(S(5), 'POST', '/api/benches/B5M/take');
    // Both are idle. While B4M is being released, the hook (slow, like a backup) lets B give B5M back and C take it
    t.services.benches.onRelease(async ({ labName }) => {
      if (labName !== 'B4M') return;
      assert.equal((await t.api(S(5), 'POST', '/api/benches/B5M/release')).status, 200);
      assert.equal((await t.api(S(7), 'POST', '/api/benches/B5M/take')).status, 200);
    });
    t.clock.ms = T0 + 3 * HOUR;
    await t.tick();
    assert.equal(t.services.benches.holder('B4M'), null, 'B4M was idle');
    assert.equal(t.services.benches.holder('B5M')?.teamId, teamC, 'team C keeps the bench it just took');
  });

  test('"we are still here" sent just before the release saves the bench', async () => {
    const team = await makeTeam(t, 'Équipe A', S(1));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
    t.clock.ms = T0 + 3 * HOUR;
    t.services.benches.touch('B4M', { force: true }); // queued before the release the tick is about to ask for
    await t.tick();
    assert.equal(t.services.benches.holder('B4M')?.teamId, team);
    await t.lab.deps.store.flush();
    t.clock.ms = T0 + 6 * HOUR;
    await t.tick();
    assert.equal(t.services.benches.holder('B4M'), null, 'and three hours later it goes');
  });

  test('a lock set while a take was waiting in the queue wins', async () => {
    await makeTeam(t, 'Équipe A', S(1));
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const blocker = occupancyDoc().update(async () => { await gate; }); // holds the occupancy queue
    const taking = t.benches.take(S(1), 'B4M'); // has already looked at the lock: none
    assert.equal((await t.api(ADMIN, 'PUT', '/api/benches/B4M/lock', { reason: 'Exam' })).status, 200);
    open();
    await blocker;
    await assert.rejects(taking, (err) => err.status === 423 && err.code === 'benches.locked');
    assert.equal(t.services.benches.holder('B4M'), null);
    const admin = await t.api(ADMIN, 'POST', '/api/benches/B4M/assign', { teamId: t.services.teams.teamOf(S(1)).id });
    assert.equal(admin.status, 200, 'admins still assign a locked bench');
  });
});
