/**
 * A team invitation is bound to an account, not to a user name: a local
 * account and an SSO account may share a user name (SSO accounts are
 * recorded with the name their provider gives), and only the account the
 * invitation was made for accepts it, declines it, sees it and hears about
 * it. Sign-up refuses a user name any account already holds, SSO ones
 * included. The real accounts and teams modules, wired as in production
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { FAST_SCRYPT, invite, signUp, call, createLocalAccount } from './helpers/accounts.js';
import { TestBrowser } from './helpers/browser.js';
import { student } from './helpers/fakes.js';
import { createUser } from '../src/modules/auth/user.js';
import { createTeamsModules } from '../src/modules/teams/index.js';
import { createAccountsModule } from '../src/modules/accounts/index.js';

let app;
before(async () => {
  app = await startTestApp({ modules: (deps) => [...createTeamsModules(deps, { tickMs: 0 }), createAccountsModule(deps, { passwordCost: FAST_SCRYPT })] });
  for (const n of [1, 2]) await app.deps.services.accounts.admit(student(n), { groupRole: 'student' });
});
after(() => app?.close());

/** An SSO account whose provider gives it this user name */
const ssoUser = (username) => createUser({ id: `oidc:sso-${username}`, username, name: `SSO ${username}`, role: 'student', groups: ['students'], via: 'oidc' });

test('sign-up refuses a user name an SSO account holds, whatever the case', async () => {
  const { token } = await invite(app);
  const taken = await signUp(app, token, { username: 'STUDENT2', name: 'Not Student Two' }, new TestBrowser());
  assert.equal(taken.status, 409, JSON.stringify(taken.body));
  assert.equal(app.deps.services.accounts.get('local:STUDENT2'), null);
  assert.equal(app.deps.services.accounts.findAllByUsername('student2').length, 1);
});

test('an invitation names the account: an SSO namesake of the invited local account neither sees, declines nor accepts it', async () => {
  const carol = await createLocalAccount(app, 'carol');
  const team = await call(app, 'student1', 'POST', '/api/teams', { name: 'Team Carol' });
  assert.equal(team.status, 201);
  const id = team.body.team.id;
  const invited = await call(app, 'student1', 'POST', `/api/teams/${id}/invitations`, { username: 'Carol' });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  assert.deepEqual(invited.body.team.invitations.map((i) => [i.username, i.userId]), [['carol', 'local:carol']]);

  // Later an SSO account with the same user name signs in for the first time
  const namesake = ssoUser('carol');
  assert.equal(await app.deps.services.accounts.admit(namesake, { groupRole: 'student' }), true);

  const seen = await call(app, namesake, 'GET', '/api/teams');
  assert.deepEqual(seen.body.invitations, [], 'the namesake does not see the invitation');
  const accepted = await call(app, namesake, 'POST', `/api/teams/${id}/accept`);
  assert.equal(accepted.status, 404);
  assert.equal(accepted.body.code, 'teams.no_invitation');
  const declined = await call(app, namesake, 'DELETE', `/api/teams/${id}/invitations/carol`);
  assert.equal(declined.status, 403, 'not their invitation to decline');
  assert.equal(app.deps.services.teams.get(id).invitations.length, 1);

  // A new invitation by that name is now ambiguous: nobody is invited
  const other = await call(app, 'student2', 'POST', '/api/teams', { name: 'Team Two' });
  const ambiguous = await call(app, 'student2', 'POST', `/api/teams/${other.body.team.id}/invitations`, { username: 'carol' });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.code, 'teams.ambiguous_user');
  assert.deepEqual(app.deps.services.teams.get(other.body.team.id).invitations, []);

  // The account it was made for sees it and accepts it
  const mine = await call(app, carol.browser, 'GET', '/api/teams');
  assert.deepEqual(mine.body.invitations.map((i) => i.team.id), [id]);
  assert.equal((await call(app, carol.browser, 'POST', `/api/teams/${id}/accept`)).status, 200);
  assert.deepEqual(app.deps.services.teams.get(id).members.sort(), ['local:carol', 'oidc:student1']);
  assert.equal(app.deps.services.teams.teamOf(namesake.id), null);
});

test('the invitation event reaches the account invited, not its namesake', async () => {
  const team = await call(app, 'student2', 'GET', '/api/teams');
  const id = team.body.mine.id;
  await createLocalAccount(app, 'dora');
  const namesake = ssoUser('dora');
  const published = [];
  const original = app.deps.events.publish;
  app.deps.events.publish = (name, payload, opts) => { published.push({ name, opts }); return original.call(app.deps.events, name, payload, opts); };
  try {
    assert.equal((await call(app, 'student2', 'POST', `/api/teams/${id}/invitations`, { username: 'dora' })).status, 201);
  } finally {
    app.deps.events.publish = original;
  }
  const invitation = published.find((e) => e.name === 'teams:invitation');
  assert.ok(invitation, 'an invitation event was published');
  const dora = app.deps.services.accounts.get('local:dora');
  assert.equal(invitation.opts.audience({ id: dora.id, username: 'dora', role: 'student' }), true);
  assert.equal(invitation.opts.audience(namesake), false);
  const changed = published.find((e) => e.name === 'teams:changed');
  assert.equal(changed.opts.audience(namesake), false);
  assert.equal(changed.opts.audience({ id: dora.id, username: 'dora', role: 'student' }), true);
});
