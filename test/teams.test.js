/**
 * Teams (SPEC "Lot teams"): create, invite by user name, accept, leave, the
 * last one out dissolves; admins see, rename, edit and dissolve every team.
 * Every change is audited; an invitation reaches the person invited only
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTeamsApp, T0 } from './helpers/teams.js';
import { student } from './helpers/fakes.js';
import { loadTestConfig } from './helpers/app.js';
import { normalizeTeamName } from '../src/modules/teams/teams.js';

describe('teams: lifecycle', () => {
  let t;
  before(async () => { t = await startTeamsApp(); });
  after(async () => { await t.close(); });

  let teamId;

  test('nobody signed in: 401 on every route', async () => {
    for (const [method, path] of [['GET', '/api/teams'], ['POST', '/api/teams'], ['POST', '/api/teams/x/accept'], ['DELETE', '/api/teams/x']]) {
      const { status, body } = await t.api(null, method, path, method === 'GET' ? undefined : {});
      assert.equal(status, 401, `${method} ${path}`);
      assert.equal(body.code, 'auth.required');
    }
  });

  test('a student without a team sees no team and no invitation', async () => {
    const { status, body } = await t.api('student1', 'GET', '/api/teams');
    assert.equal(status, 200);
    assert.equal(body.mine, null);
    assert.deepEqual(body.invitations, []);
    assert.equal(body.admin, false);
  });

  test('bad names are refused', async () => {
    for (const name of ['', ' ', 'x', 'a'.repeat(41), 'tab\u0007bell', 42, null]) {
      const { status, body } = await t.api('student1', 'POST', '/api/teams', { name });
      assert.equal(status, 400, JSON.stringify(name));
      assert.equal(body.code, 'teams.bad_name');
    }
    assert.equal(normalizeTeamName('  Les   routeurs  '), 'Les routeurs');
  });

  test('a student creates a team and is its only member', async () => {
    const { status, body } = await t.api('student1', 'POST', '/api/teams', { name: '  Les   routeurs ' });
    assert.equal(status, 201);
    assert.equal(body.team.name, 'Les routeurs');
    assert.deepEqual(body.team.members, ['oidc:student1']);
    teamId = body.team.id;
    assert.equal(t.services.teams.teamOf('oidc:student1').id, teamId);
    assert.equal(t.services.teams.teamOf(student(1)).id, teamId);
    assert.equal(t.services.teams.get(teamId).name, 'Les routeurs');
    assert.equal(t.services.teams.teamOf('oidc:student2'), null);
  });

  test('one team at a time, and names are unique without case', async () => {
    const again = await t.api('student1', 'POST', '/api/teams', { name: 'Autre' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'teams.already_member');
    const twin = await t.api('student3', 'POST', '/api/teams', { name: 'LES ROUTEURS' });
    assert.equal(twin.status, 409);
    assert.equal(twin.body.code, 'teams.name_taken');
  });

  test('an invitation reaches the person invited, and nobody else', async () => {
    const invitee = await t.listen('student2');
    const other = await t.listen('student3');
    const { status } = await t.api('student1', 'POST', `/api/teams/${teamId}/invitations`, { username: 'Student2' });
    assert.equal(status, 201);
    const got = await invitee.until((e) => e.topic === 'teams:invitation');
    assert.deepEqual(got.data, { team: { id: teamId, name: 'Les routeurs' }, by: { name: 'Student 1' } });
    await t.settle(invitee, other);
    assert.ok(!other.topics().includes('teams:invitation'), 'a third student hears nothing');
    assert.ok(!other.topics().includes('teams:changed'));
    const mine = await t.api('student2', 'GET', '/api/teams');
    assert.deepEqual(mine.body.invitations.map((i) => i.team.id), [teamId]);
    // Inviting twice changes nothing
    const twice = await t.api('student1', 'POST', `/api/teams/${teamId}/invitations`, { username: 'student2' });
    assert.equal(twice.status, 200);
    assert.equal(t.services.teams.get(teamId).invitations.length, 1);
  });

  test('invitations: only members invite, bad user names and members are refused', async () => {
    const outsider = await t.api('student3', 'POST', `/api/teams/${teamId}/invitations`, { username: 'student3' });
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.code, 'teams.not_member');
    const bad = await t.api('student1', 'POST', `/api/teams/${teamId}/invitations`, { username: 'two words' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'teams.bad_username');
    const self = await t.api('student1', 'POST', `/api/teams/${teamId}/invitations`, { username: 'student1' });
    assert.equal(self.status, 409);
    assert.equal(self.body.code, 'teams.already_in_team');
    const unknown = await t.api('student1', 'POST', '/api/teams/nope/invitations', { username: 'student3' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'teams.unknown');
  });

  test('only the person invited may accept', async () => {
    const wrong = await t.api('student3', 'POST', `/api/teams/${teamId}/accept`);
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body.code, 'teams.no_invitation');
    const members = await t.listen('student1');
    const { status, body } = await t.api('student2', 'POST', `/api/teams/${teamId}/accept`);
    assert.equal(status, 200);
    assert.deepEqual(body.team.members, ['oidc:student1', 'oidc:student2']);
    assert.deepEqual(body.team.invitations, []);
    await members.until((e) => e.topic === 'teams:changed' && e.data.teamId === teamId);
  });

  test('an invitation is withdrawn by a member or declined by the invitee', async () => {
    await t.api('student1', 'POST', `/api/teams/${teamId}/invitations`, { username: 'student3' });
    const declined = await t.api('student3', 'DELETE', `/api/teams/${teamId}/invitations/student3`);
    assert.equal(declined.status, 200);
    await t.api('student2', 'POST', `/api/teams/${teamId}/invitations`, { username: 'student3' });
    const notYours = await t.api(student(4), 'DELETE', `/api/teams/${teamId}/invitations/student3`);
    assert.equal(notYours.status, 403, 'neither a member nor the invitee');
    const withdrawn = await t.api('student2', 'DELETE', `/api/teams/${teamId}/invitations/student3`);
    assert.equal(withdrawn.status, 200);
    assert.deepEqual(t.services.teams.get(teamId).invitations, []);
    const none = await t.api('student3', 'POST', `/api/teams/${teamId}/accept`);
    assert.equal(none.status, 404);
  });

  test('a student already in a team cannot accept another one', async () => {
    const other = await t.api('student3', 'POST', '/api/teams', { name: 'Les switchs' });
    await t.api('student3', 'POST', `/api/teams/${other.body.team.id}/invitations`, { username: 'student1' });
    const refused = await t.api('student1', 'POST', `/api/teams/${other.body.team.id}/accept`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'teams.already_member');
    await t.api('student3', 'POST', `/api/teams/${other.body.team.id}/leave`);
  });

  test('members rename their team; students see team names only, admins see everything', async () => {
    const renamed = await t.api('student2', 'PATCH', `/api/teams/${teamId}`, { name: 'Routeurs' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.team.name, 'Routeurs');
    const outsider = await t.api('student3', 'PATCH', `/api/teams/${teamId}`, { name: 'Pirates' });
    assert.equal(outsider.status, 403);
    const asStudent = await t.api('student3', 'GET', '/api/teams');
    assert.deepEqual(asStudent.body.teams, [{ id: teamId, name: 'Routeurs', size: 2 }]);
    const asAdmin = await t.api('admin', 'GET', '/api/teams');
    assert.equal(asAdmin.body.admin, true);
    assert.deepEqual(asAdmin.body.teams[0].people.map((p) => p.username), ['student1', 'student2']);
    const adminRename = await t.api('admin', 'PATCH', `/api/teams/${teamId}`, { name: 'Les routeurs' });
    assert.equal(adminRename.status, 200);
  });

  test('members leave; the last one out dissolves the team', async () => {
    const notMember = await t.api('student3', 'POST', `/api/teams/${teamId}/leave`);
    assert.equal(notMember.status, 403);
    const first = await t.api('student2', 'POST', `/api/teams/${teamId}/leave`);
    assert.deepEqual(first.body, { ok: true, dissolved: false });
    const last = await t.api('student1', 'POST', `/api/teams/${teamId}/leave`);
    assert.deepEqual(last.body, { ok: true, dissolved: true });
    assert.equal(t.services.teams.get(teamId), null);
    assert.deepEqual(t.services.teams.list(), []);
  });

  test('admins remove members and dissolve teams; students may not', async () => {
    const created = await t.api('student1', 'POST', '/api/teams', { name: 'Équipe B' });
    const id = created.body.team.id;
    await t.api('student1', 'POST', `/api/teams/${id}/invitations`, { username: 'student2' });
    await t.api('student2', 'POST', `/api/teams/${id}/accept`);
    const studentRemove = await t.api('student1', 'DELETE', `/api/teams/${id}/members/oidc:student2`);
    assert.equal(studentRemove.status, 403);
    assert.equal(studentRemove.body.code, 'auth.forbidden');
    const removed = await t.api('admin', 'DELETE', `/api/teams/${id}/members/${encodeURIComponent('oidc:student2')}`);
    assert.deepEqual(removed.body, { ok: true, dissolved: false });
    assert.deepEqual(t.services.teams.get(id).members, ['oidc:student1']);
    const missing = await t.api('admin', 'DELETE', `/api/teams/${id}/members/nobody`);
    assert.equal(missing.status, 404);
    const studentDissolve = await t.api('student1', 'DELETE', `/api/teams/${id}`);
    assert.equal(studentDissolve.status, 403);
    const dissolved = await t.api('admin', 'DELETE', `/api/teams/${id}`);
    assert.equal(dissolved.status, 200);
    assert.equal(t.services.teams.get(id), null);
  });

  test('every change is in the audit trail', async () => {
    const actions = (await t.lab.deps.audit.query({ action: 'team', limit: 100 })).map((e) => e.action);
    for (const a of ['team.create', 'team.invite', 'team.join', 'team.invite.decline', 'team.invite.revoke', 'team.rename', 'team.leave', 'team.member.remove', 'team.dissolve']) {
      assert.ok(actions.includes(a), `${a} audited`);
    }
  });

  test('a malformed body is a 400, a missing team a 404', async () => {
    const res = await fetch(`${t.lab.url}/api/teams`, { method: 'POST', headers: { ...t.lab.as('student3'), origin: t.lab.url, 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
    const missing = await t.api('admin', 'PATCH', '/api/teams/nope', { name: 'Valid name' });
    assert.equal(missing.status, 404);
  });
});

describe('teams: size', () => {
  let t;
  before(async () => { t = await startTeamsApp(); });
  after(async () => { await t.close(); });

  test('a team has at most 8 seats; an invitation holds one until it is answered', async () => {
    const created = await t.api('student1', 'POST', '/api/teams', { name: 'Grande équipe' });
    const id = created.body.team.id;
    for (let n = 10; n < 17; n += 1) {
      const res = await t.api('student1', 'POST', `/api/teams/${id}/invitations`, { username: `guest${n}` });
      assert.equal(res.status, 201, `guest${n}`);
    }
    const full = await t.api('student1', 'POST', `/api/teams/${id}/invitations`, { username: 'guest17' });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'teams.full');
    assert.equal(full.body.params.max, 8);
    assert.equal(t.services.teams.get(id).invitations.length, 7);
    // Withdrawing one frees a seat
    await t.api('student1', 'DELETE', `/api/teams/${id}/invitations/guest10`);
    assert.equal((await t.api('student1', 'POST', `/api/teams/${id}/invitations`, { username: 'guest17' })).status, 201);
  });

  test('accepting into a team that is already full is refused (safety net: a stale document or a lowered limit)', async () => {
    // The API never gets there (invitations hold a seat), so write the document by hand
    const since = new Date(T0).toISOString();
    const people = Array.from({ length: 8 }, (_, n) => ({ id: `oidc:seed${n}`, username: `seed${n}`, name: `Seed ${n}`, since }));
    const stale = { username: student(3).username, by: people[0], at: since };
    await t.lab.deps.store.json('teams/teams.json').update((doc) => {
      doc.teams.push({ id: 'fullteam', name: 'Équipe pleine', createdAt: since, createdBy: people[0], members: people, invitations: [stale] });
      return doc;
    });
    const res = await t.api('student3', 'POST', '/api/teams/fullteam/accept');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'teams.full');
    assert.equal(res.body.params.max, 8);
    assert.equal(t.services.teams.get('fullteam').members.length, 8);
    assert.equal(t.services.teams.teamOf('oidc:student3'), null);
  });
});

describe('teams: configuration', () => {
  test('defaults and bounds of the bench settings', async () => {
    const config = await loadTestConfig();
    assert.deepEqual(config.benches, { idleHours: 3, reservations: { maxFuture: 2, maxHours: 4, maxDaysAhead: 14 } });
    const custom = await loadTestConfig({ BENCH_IDLE_HOURS: '5', RESERVATION_MAX_FUTURE: '3', RESERVATION_MAX_HOURS: '2', RESERVATION_MAX_DAYS_AHEAD: '7' });
    assert.deepEqual(custom.benches, { idleHours: 5, reservations: { maxFuture: 3, maxHours: 2, maxDaysAhead: 7 } });
    await assert.rejects(loadTestConfig({ BENCH_IDLE_HOURS: '0' }), (err) => err.problems.some((p) => p.startsWith('BENCH_IDLE_HOURS')));
    await assert.rejects(loadTestConfig({ RESERVATION_MAX_HOURS: 'four' }), (err) => err.problems.some((p) => p.startsWith('RESERVATION_MAX_HOURS')));
  });
});
