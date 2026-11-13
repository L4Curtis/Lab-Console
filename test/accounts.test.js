/**
 * Accounts (SPEC, lot accounts): invitations, sign-up, reset links, roles
 * and states, the last administrator, My account, and every refusal
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { TestBrowser } from './helpers/browser.js';
import { startAccountsApp, call, invite, signUp, localSignIn, createLocalAccount, testClock, PASSWORD } from './helpers/accounts.js';
import { TEST_ADMIN, adminCode } from './helpers/app.js';
import { checkUsername, checkPassword, cleanDisplayName, usernameKey } from '../src/modules/accounts/policy.js';
import { createLinks } from '../src/modules/accounts/links.js';
import { createStore } from '../src/lib/store.js';

const auditText = (lab) => {
  const dir = path.join(lab.dataDir, 'audit');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('') : '';
};
const auditEntries = async (lab, action) => {
  await lab.deps.store.flush();
  return auditText(lab).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !action || e.action === action);
};

describe('policy: user names, display names, passwords', () => {
  test('user names: a strict pattern, reserved names, case folded for comparison', () => {
    for (const ok of ['alice', 'Alice.Martin', 'b4m-group_2', 'abc']) assert.equal(checkUsername(ok), null, ok);
    for (const bad of ['ab', 'a'.repeat(33), '1alice', 'alice.', '.alice', 'al..ice', 'al ice', 'alïce', 'al/ice', '', null, 42]) {
      assert.equal(checkUsername(bad), 'username_invalid', String(bad));
    }
    for (const reserved of ['admin', 'Root', 'SYSTEM', 'lab-console']) assert.equal(checkUsername(reserved), 'username_unavailable', reserved);
    assert.equal(usernameKey('  Alice '), 'alice');
  });

  test('display names: trimmed, at most 64 characters, no control or bidirectional characters', () => {
    assert.equal(cleanDisplayName('  Alice   Martin '), 'Alice Martin');
    assert.equal(cleanDisplayName(''), null);
    assert.equal(cleanDisplayName('x'.repeat(65)), null);
    assert.equal(cleanDisplayName('evil‮eman'), null);
    assert.equal(cleanDisplayName('tab\u0007'), null);
    assert.equal(cleanDisplayName('Chloé Dubois'), 'Chloé Dubois');
  });

  test('passwords: 10 characters at least, not a common one, not the user name', () => {
    assert.equal(checkPassword('short9char'), null);
    assert.equal(checkPassword('123456789'), 'password_short');
    assert.equal(checkPassword(undefined), 'password_short');
    assert.equal(checkPassword('x'.repeat(1025)), 'password_long');
    for (const common of ['motdepasse', 'AZERTYUIOP', 'password123', '1234567890', 'aaaaaaaaaaaa']) assert.equal(checkPassword(common), 'password_common', common);
    assert.equal(checkPassword('my-alice-password', { username: 'Alice' }), 'password_like_username');
    assert.equal(checkPassword(PASSWORD, { username: 'alice' }), null);
  });
});

describe('links: hashed tokens, constant-time lookup, expiry, uses, revocation', () => {
  test('only the hash is stored; every refusal has its reason', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'links-'));
    try {
      const clock = testClock();
      const store = createStore(dir);
      const links = createLinks({ store, now: clock.now });
      const by = { id: 'oidc:admin', username: 'admin' };
      const { link, token } = await links.create({ kind: 'invite', role: 'student', maxUses: 2, ttlMs: 60_000, createdBy: by });
      assert.match(token, /^[A-Za-z0-9_-]{43}$/, '256 bits, base64url');
      await store.flush();
      const file = fs.readFileSync(path.join(dir, 'accounts', 'invitations.json'), 'utf8');
      assert.ok(!file.includes(token), 'the token itself is never written');
      assert.equal(fs.statSync(path.join(dir, 'accounts', 'invitations.json')).mode & 0o777, 0o600);
      assert.ok(!('hash' in links.list()[0]), 'the hash is not shown either');

      assert.equal(links.find(token).problem, null);
      assert.equal(links.find(token, { kind: 'reset' }).problem, 'unknown', 'an invitation is not a reset link');
      assert.equal(links.find(`${token.slice(0, -1)}A`).problem, 'unknown');
      assert.equal(links.find('not a token').problem, 'unknown');
      assert.equal(await links.use(link.id, 'local:a'), null);
      assert.equal(await links.use(link.id, 'local:b'), null);
      assert.equal(links.find(token).problem, 'used');
      assert.equal(await links.use(link.id, 'local:c'), 'used', 'checked again inside the write');

      const second = await links.create({ kind: 'invite', role: 'student', maxUses: 1, ttlMs: 60_000, createdBy: by });
      clock.advance(60_000);
      assert.equal(links.find(second.token).problem, 'expired');
      const third = await links.create({ kind: 'invite', role: 'student', maxUses: 1, ttlMs: 60_000, createdBy: by });
      assert.equal((await links.revoke(third.link.id, by)).state, 'revoked');
      assert.equal(links.find(third.token).problem, 'revoked');
      assert.equal(await links.revoke(third.link.id, by), null, 'revoked once');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('invitations and sign-up', () => {
  let lab;
  let clock;
  before(async () => { clock = testClock(); lab = await startAccountsApp({ clock }); });
  after(() => lab.close());

  test('a single-use link gives an active account, signed in at once', async () => {
    const { url, token, invitation } = await invite(lab, { note: 'Alice' });
    assert.equal(url, `${lab.url}/join#${token}`, 'the token travels in the fragment');
    assert.equal(invitation.maxUses, 1);
    assert.ok(!JSON.stringify(invitation).includes(token));

    const offer = await call(lab, null, 'POST', '/auth/invitation', { token });
    assert.deepEqual(Object.keys(offer.body).sort(), ['approval', 'expiresAt', 'role']);
    assert.equal(offer.body.role, 'student');
    assert.equal(offer.body.approval, false);

    const browser = new TestBrowser();
    const res = await signUp(lab, token, { username: 'Alice', name: 'Alice Martin' }, browser);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { redirect: '/' });
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.status, 200, 'the new session works');
    assert.equal(me.body.account.id, 'local:Alice');
    assert.equal(me.body.account.role, 'student');
    assert.equal(me.body.account.state, 'active');

    const again = await signUp(lab, token, { username: 'alice2' });
    assert.equal(again.status, 404, 'a used link is refused');
    assert.equal(again.body.code, 'accounts.link_invalid');
    const list = await call(lab, 'admin', 'GET', '/api/accounts/invitations');
    const listed = list.body.invitations.find((i) => i.id === invitation.id);
    assert.equal(listed.uses, 1);
    assert.equal(listed.state, 'used');
    assert.deepEqual(listed.accounts, ['local:Alice']);

    const entries = await auditEntries(lab, 'accounts.signup');
    assert.equal(entries.at(-1).details.account, 'local:Alice');
    assert.ok(!auditText(lab).includes(token), 'the token never reaches the audit trail');
  });

  test('the account signs in on the local form with its password, whatever the case of its name', async () => {
    const browser = new TestBrowser();
    const res = await localSignIn(lab, browser, 'alice');
    assert.equal(res.status, 200);
    assert.equal(res.body.redirect, '/');
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).body.account.username, 'Alice');
    const wrong = await localSignIn(lab, new TestBrowser(), 'alice', 'not the password');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'auth.invalid_credentials');
  });

  test('a link for several people gives accounts that wait for approval; approve or reject in one click', async () => {
    const { token } = await invite(lab, { uses: 3 });
    assert.equal((await call(lab, null, 'POST', '/auth/invitation', { token })).body.approval, true);
    const bilal = await signUp(lab, token, { username: 'bilal', name: 'Bilal Haddad' });
    assert.equal(bilal.status, 200);
    assert.deepEqual(bilal.body, { pending: true });
    assert.equal(bilal.res.headers.getSetCookie().length, 0, 'no session for a pending account');
    assert.equal((await signUp(lab, token, { username: 'chloe' })).status, 200);

    // A pending account cannot sign in, and the refusal is the usual one
    const pending = await localSignIn(lab, new TestBrowser(), 'bilal');
    assert.equal(pending.status, 401);
    assert.equal(pending.body.code, 'auth.invalid_credentials');

    const users = (await call(lab, 'admin', 'GET', '/api/accounts/users')).body.users;
    assert.equal(users.find((u) => u.id === 'local:bilal').state, 'pending');
    assert.equal((await call(lab, 'admin', 'POST', '/api/accounts/users/local%3Abilal/approve')).status, 200);
    assert.equal((await localSignIn(lab, new TestBrowser(), 'bilal')).status, 200);
    assert.equal((await call(lab, 'admin', 'POST', '/api/accounts/users/local%3Abilal/approve')).status, 409, 'approved once');

    assert.equal((await call(lab, 'admin', 'POST', '/api/accounts/users/local%3Achloe/reject')).status, 200);
    assert.equal((await call(lab, 'admin', 'GET', '/api/accounts/users')).body.users.some((u) => u.id === 'local:chloe'), false, 'rejected = removed');
    assert.equal((await signUp(lab, token, { username: 'chloe' })).status, 200, 'the name is free again');
  });

  test('expired and revoked links are refused, with the same answer as an unknown one', async () => {
    const expiring = await invite(lab, { ttl: '1h' });
    clock.advance(60 * 60_000 + 1);
    const expired = await call(lab, null, 'POST', '/auth/invitation', { token: expiring.token });
    const unknown = await call(lab, null, 'POST', '/auth/invitation', { token: 'A'.repeat(43) });
    assert.equal(expired.status, 404);
    assert.deepEqual(expired.body, unknown.body);
    assert.equal((await signUp(lab, expiring.token, { username: 'late' })).status, 404);

    const revoked = await invite(lab);
    const del = await call(lab, 'admin', 'DELETE', `/api/accounts/invitations/${revoked.invitation.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.invitation.state, 'revoked');
    assert.equal((await signUp(lab, revoked.token, { username: 'revoked' })).status, 404);
    assert.equal((await call(lab, 'admin', 'DELETE', `/api/accounts/invitations/${revoked.invitation.id}`)).status, 404);
    assert.equal((await call(lab, null, 'POST', '/auth/invitation', {})).status, 404, 'no token at all');
  });

  test('user names are unique without regard to case, the environment administrator included; a refusal does not use the link', async () => {
    const { token } = await invite(lab);
    for (const [username, code] of [['ALICE', 'accounts.username_unavailable'], ['Root', 'accounts.username_unavailable'],
      ['admin', 'accounts.username_unavailable'], ['a', 'accounts.username_invalid'], ['../etc', 'accounts.username_invalid']]) {
      const res = await signUp(lab, token, { username });
      assert.equal(res.body.code, code, username);
    }
    assert.equal(TEST_ADMIN.username, 'root');
    assert.equal((await signUp(lab, token, { username: 'dora', name: '' })).body.code, 'accounts.name_invalid');
    for (const [password, code] of [['short', 'password_short'], ['motdepasse', 'password_common'], ['dora-is-great', 'password_like_username']]) {
      assert.equal((await signUp(lab, token, { username: 'dora', password })).body.code, `accounts.${code}`);
    }
    const ok = await signUp(lab, token, { username: 'dora' });
    assert.equal(ok.status, 200, 'the link was still usable after the refusals');
  });

  test('sign-up is limited per link: ten refusals, then nothing more for a while, even a good one', async () => {
    const { token } = await invite(lab);
    const answers = [];
    for (let i = 0; i < 10; i++) answers.push((await signUp(lab, token, { username: 'x' })).status);
    assert.deepEqual(answers, Array(10).fill(400));
    const blocked = await signUp(lab, token, { username: 'valid-name' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'accounts.throttled');
  });

  test('invitations: bad input refused; an administrator invitation needs passkeys, which plain http on an address has not', async () => {
    for (const body of [{ ttl: '2h' }, { uses: 0 }, { uses: 101 }, { uses: 1.5 }, { role: 'root' }]) {
      assert.equal((await call(lab, 'admin', 'POST', '/api/accounts/invitations', body)).status, 400, JSON.stringify(body));
    }
    const admin = await call(lab, 'admin', 'POST', '/api/accounts/invitations', { role: 'admin' });
    assert.equal(admin.status, 409);
    assert.equal(admin.body.code, 'accounts.passkeys_unavailable');
  });
});

describe('roles, states and the last administrator', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ publicHost: 'localhost' }); });
  after(() => lab.close());

  test('the environment administrator is listed first and cannot be changed here', async () => {
    const users = (await call(lab, 'admin', 'GET', '/api/accounts/users')).body.users;
    assert.equal(users[0].id, `local:${TEST_ADMIN.username}`);
    assert.equal(users[0].environment, true);
    const res = await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(users[0].id)}`, { role: 'student' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'accounts.environment_admin');
  });

  test('promoting or disabling ends the account\'s sessions and its live streams at once', async () => {
    const { id, browser } = await createLocalAccount(lab, 'eve');
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 200);
    const stream = await new Promise((resolve, reject) => {
      const req = http.get(`${lab.url}/api/events`, { headers: { cookie: browser.cookieHeader(lab.url) } }, resolve);
      req.on('error', reject);
    });
    assert.equal(stream.statusCode, 200);
    const ended = new Promise((resolve) => { stream.on('close', resolve); stream.on('end', resolve); stream.resume(); });

    const res = await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { role: 'admin' });
    assert.equal(res.status, 200);
    assert.equal(res.body.account.role, 'admin');
    assert.equal(res.body.account.needsPasskey, true);
    assert.equal(res.body.sessionsEnded, 1);
    await ended;
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 401, 'the session is gone');
    const role = (await auditEntries(lab, 'accounts.role')).at(-1);
    assert.deepEqual([role.details.from, role.details.to], ['student', 'admin']);
  });

  test('the last administrator of the directory cannot be demoted or disabled', async () => {
    // eve is the directory's only administrator (promoted above)
    const eve = encodeURIComponent('local:eve');
    for (const body of [{ role: 'student' }, { state: 'disabled' }]) {
      const res = await call(lab, 'admin', 'PATCH', `/api/accounts/users/${eve}`, body);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(res.body.code, 'accounts.last_admin');
    }
    const { id } = await createLocalAccount(lab, 'frank');
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { role: 'admin' })).status, 200);
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${eve}`, { role: 'student' })).status, 200, 'with another one, it can');
    const last = await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { state: 'disabled' });
    assert.equal(last.body.code, 'accounts.last_admin');
  });

  test('a disabled account cannot sign in; enabled again, it can', async () => {
    const { id } = await createLocalAccount(lab, 'gina');
    const path_ = `/api/accounts/users/${encodeURIComponent(id)}`;
    assert.equal((await call(lab, 'admin', 'PATCH', path_, { state: 'disabled' })).status, 200);
    const refused = await localSignIn(lab, new TestBrowser(), 'gina');
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'auth.invalid_credentials', 'nothing says the account exists');
    assert.equal((await call(lab, 'admin', 'PATCH', path_, { state: 'active' })).status, 200);
    assert.equal((await localSignIn(lab, new TestBrowser(), 'gina')).status, 200);
    for (const body of [{}, { state: 'deleted' }, { role: 'root' }, { role: null }]) {
      assert.equal((await call(lab, 'admin', 'PATCH', path_, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call(lab, 'admin', 'PATCH', '/api/accounts/users/local%3Anobody', { state: 'active' })).status, 404);
  });

  test('a student and nobody are refused every administration route', async () => {
    const routes = [
      ['GET', '/api/accounts/users'], ['PATCH', '/api/accounts/users/local%3Agina', { role: 'admin' }],
      ['POST', '/api/accounts/users/local%3Agina/approve'], ['POST', '/api/accounts/users/local%3Agina/reject'],
      ['POST', '/api/accounts/users/local%3Agina/reset-link', {}], ['DELETE', '/api/accounts/users/local%3Agina/passkeys'],
      ['GET', '/api/accounts/invitations'], ['POST', '/api/accounts/invitations', { role: 'admin' }], ['DELETE', '/api/accounts/invitations/x'],
      ['GET', '/api/accounts/sso'], ['PUT', '/api/accounts/sso', { enabled: false }], ['POST', '/api/accounts/sso/test', {}],
      ['POST', '/api/accounts/sso/trial'], ['GET', '/api/accounts/sso/trial'],
    ];
    const { browser } = await createLocalAccount(lab, 'henri');
    for (const [method, url, body] of routes) {
      for (const who of ['student1', browser]) {
        const res = await call(lab, who, method, url, body);
        assert.equal(res.status, 403, `${method} ${url}`);
        assert.equal(res.body.code, 'auth.forbidden');
      }
      assert.equal((await call(lab, null, method, url, body)).status, 401, `${method} ${url} (nobody)`);
    }
    // The role a student's browser believes it has is irrelevant: henri is still a student
    assert.equal((await call(lab, 'admin', 'GET', '/api/accounts/users')).body.users.find((u) => u.id === 'local:henri').role, 'student');
  });
});

describe('password reset links', () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  test('single use; the account\'s sessions end; the old password stops working', async () => {
    const { id, browser } = await createLocalAccount(lab, 'ivan');
    const created = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '1h' });
    assert.equal(created.status, 200);
    const token = created.body.url.split('#')[1];
    assert.equal(created.body.url, `${lab.url}/reset#${token}`);
    assert.deepEqual((await call(lab, null, 'POST', '/auth/reset-link', { token })).body.username, 'ivan');
    assert.equal((await call(lab, null, 'POST', '/auth/invitation', { token })).status, 404, 'a reset link is no invitation');

    assert.equal((await call(lab, null, 'POST', '/auth/reset', { token, password: 'motdepasse' })).body.code, 'accounts.password_common');
    const done = await call(lab, null, 'POST', '/auth/reset', { token, password: 'a brand new passphrase' });
    assert.deepEqual(done.body, { ok: true });
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 401, 'signed out everywhere');
    assert.equal((await localSignIn(lab, new TestBrowser(), 'ivan')).status, 401, 'old password');
    assert.equal((await localSignIn(lab, new TestBrowser(), 'ivan', 'a brand new passphrase')).status, 200);
    assert.equal((await call(lab, null, 'POST', '/auth/reset', { token, password: 'yet another passphrase' })).status, 404, 'single use');
    assert.ok(!auditText(lab).includes(token));
  });

  test('a new link replaces the previous one; SSO accounts have none; the environment administrator neither', async () => {
    const { id } = await createLocalAccount(lab, 'jade');
    const first = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, {});
    const second = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '24h' });
    assert.equal((await call(lab, null, 'POST', '/auth/reset-link', { token: first.body.url.split('#')[1] })).status, 404);
    assert.equal((await call(lab, null, 'POST', '/auth/reset-link', { token: second.body.url.split('#')[1] })).status, 200);
    assert.equal((await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '7d' })).status, 400);

    await lab.deps.services.accounts.admit(lab.signIn('student2').user, { groupRole: 'student' });
    const sso = await call(lab, 'admin', 'POST', '/api/accounts/users/oidc%3Astudent2/reset-link', {});
    assert.equal(sso.body.code, 'accounts.not_local');
    const env = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(`local:${TEST_ADMIN.username}`)}/reset-link`, {});
    assert.equal(env.body.code, 'accounts.environment_admin');
  });
});

describe('My account', () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  test('a local account changes its name and its password; the other sessions end, this one stays', async () => {
    const { browser } = await createLocalAccount(lab, 'kim');
    const other = new TestBrowser();
    assert.equal((await localSignIn(lab, other, 'kim')).status, 200);

    const renamed = await call(lab, browser, 'PATCH', '/api/accounts/me', { name: '  Kim  Lee ' });
    assert.equal(renamed.body.account.name, 'Kim Lee');
    assert.equal((await call(lab, browser, 'PATCH', '/api/accounts/me', { name: '' })).status, 400);

    const wrong = await call(lab, browser, 'POST', '/api/accounts/me/password', { current: 'nope nope nope', password: 'another good passphrase' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'accounts.wrong_password');
    const weak = await call(lab, browser, 'POST', '/api/accounts/me/password', { current: PASSWORD, password: 'azertyuiop' });
    assert.equal(weak.body.code, 'accounts.password_common');
    const ok = await call(lab, browser, 'POST', '/api/accounts/me/password', { current: PASSWORD, password: 'another good passphrase' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sessionsEnded, 1);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 200, 'this session stays');
    assert.equal((await call(lab, other, 'GET', '/api/accounts/me')).status, 401, 'the other one ended');
  });

  test('password checks are limited per user', async () => {
    const { browser } = await createLocalAccount(lab, 'lou');
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push((await call(lab, browser, 'POST', '/api/accounts/me/password', { current: 'wrong wrong', password: 'whatever whatever' })).status);
    assert.deepEqual(answers, [403, 403, 403, 403, 403, 429]);
  });

  test('sessions: listed with the current one marked, the others closed in one click', async () => {
    const { browser } = await createLocalAccount(lab, 'max');
    const other = new TestBrowser();
    await localSignIn(lab, other, 'max');
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.sessions.length, 2);
    assert.equal(me.body.sessions.filter((s) => s.current).length, 1);
    assert.ok(me.body.sessions.every((s) => !('token' in s) && !('hash' in s)));
    const ended = await call(lab, browser, 'POST', '/api/accounts/me/sessions/end-others');
    assert.equal(ended.body.ended, 1);
    assert.equal((await call(lab, other, 'GET', '/api/accounts/me')).status, 401);
    // Someone else's session cannot be closed from here
    const stranger = lab.signIn('student3');
    assert.equal((await call(lab, browser, 'DELETE', `/api/accounts/me/sessions/${stranger.id}`)).status, 404);
  });

  test('an SSO account and the environment administrator have nothing to change here', async () => {
    const sso = await call(lab, 'student1', 'GET', '/api/accounts/me');
    assert.equal(sso.body.account.via, 'oidc');
    assert.equal(sso.body.canChangePassword, false);
    for (const [method, url, body] of [['PATCH', '/api/accounts/me', { name: 'X' }], ['POST', '/api/accounts/me/password', { current: 'a', password: 'b' }]]) {
      assert.equal((await call(lab, 'student1', method, url, body)).body.code, 'accounts.unknown', 'not in the directory before signing in through the provider');
    }
    const env = new TestBrowser();
    const res = await call(lab, env, 'POST', '/auth/local', { username: TEST_ADMIN.username, password: TEST_ADMIN.password, code: adminCode() });
    assert.equal(res.status, 200);
    const me = await call(lab, env, 'GET', '/api/accounts/me');
    assert.equal(me.body.account.environment, true);
    assert.equal((await call(lab, env, 'POST', '/api/accounts/me/password', { current: TEST_ADMIN.password, password: 'x'.repeat(20) })).body.code, 'accounts.environment_admin');
  });
});
