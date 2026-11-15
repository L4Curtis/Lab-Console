/**
 * Passkeys (SPEC, lot accounts; owner decision of 15 Nov): every local
 * account signs in with a passkey, students included. Registered as part of
 * the sign-up, at the next password sign-in of an account that has none
 * (accounts made before the rule), and again after a password reset link,
 * which removes the old ones. The password alone never opens a session; the
 * last passkey cannot be removed from My account; where passkeys cannot be
 * offered, local accounts are refused, clearly. Also: the passkey step after
 * a password, one-click sign-in, My account, and the refusals - a wrong
 * origin, a replayed or missing challenge, a disabled account
 *
 * The browser and the authenticator are played by test/helpers/webauthn.js;
 * the server side is the real @simplewebauthn/server
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TestBrowser } from './helpers/browser.js';
import { SoftAuthenticator } from './helpers/webauthn.js';
import { TEST_ADMIN, adminCode } from './helpers/app.js';
import { memoryDatabase } from './helpers/db.js';
import {
  startAccountsApp, call, confirmed, invite, signUp, localSignIn, createLocalAccount, enrol, usePasskey, signInWithPassword,
  passkeySignIn, authenticator, FAST_SCRYPT, PASSWORD,
} from './helpers/accounts.js';
import { relyingParty } from '../src/modules/accounts/passkeys.js';
import { PASSKEY_LIMITS } from '../src/modules/accounts/publicRoutes.js';
import { createDirectory, passwordFingerprint } from '../src/modules/accounts/directory.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createUser } from '../src/modules/auth/user.js';

const sessionCookie = (lab, browser) => browser.cookie(lab.url, lab.deps.auth.cookieName);
const promote = (lab, id) => confirmed(lab, 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { role: 'admin' });
const account = (lab, id) => lab.deps.services.accounts.get(id);
/** A one-time code of the environment's administrator from a step nobody used yet (confirmations burn theirs on lab.time) */
const freshAdminCode = (lab) => {
  lab.time.advance(30_000);
  return adminCode(lab.time.now());
};
const loginMethods = async (lab, id) => (await lab.deps.audit.query({ action: 'auth.login' })).filter((e) => e.actor.id === id).map((e) => e.details.method).reverse();
/** A sign-up through a fresh single-use invitation, left before its passkey; → { id, browser (holding the step) } */
async function signUpOnly(lab, username, options = {}) {
  const { token } = await invite(lab, options);
  const browser = new TestBrowser();
  const res = await signUp(lab, token, { username }, browser);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: `local:${username}`, browser, res };
}

describe('relying party: passkeys need https on a name, or localhost', () => {
  test('which PUBLIC_URL offers passkeys', () => {
    assert.deepEqual({ ...relyingParty('https://lab.example.org') }, { available: true, rpID: 'lab.example.org', origin: 'https://lab.example.org', name: 'Lab Console' });
    assert.equal(relyingParty('http://localhost:3000').available, true);
    assert.equal(relyingParty('http://localhost:3000').origin, 'http://localhost:3000');
    assert.equal(relyingParty('http://192.168.10.250:8089').available, false, 'http on the LAN');
    assert.equal(relyingParty('https://192.168.10.250').available, false, 'an IP address is no relying party');
    assert.equal(relyingParty('http://lab.example.org').available, false);
  });
});

describe('every local account signs in with a passkey: the sign-up registers one', () => {
  let lab;
  let key;
  before(async () => {
    lab = await startAccountsApp();
    key = authenticator(lab);
  });
  after(() => lab.close());

  test('a student signing up registers a passkey before any session, then signs in with one click', async () => {
    const { token } = await invite(lab);
    const browser = new TestBrowser();
    const res = await signUp(lab, token, { username: 'alba', name: 'Alba Roux' }, browser);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { step: 'passkey-enrol' }, 'a student too: the passkey comes first');
    assert.equal(sessionCookie(lab, browser), null, 'no session yet');
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 401, 'the step cookie is not a session');
    assert.equal(account(lab, 'local:alba').needsPasskey, true);

    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.body.kind, 'passkey-enrol');
    assert.equal(options.body.options.rp.id, 'localhost');
    assert.equal(options.body.options.user.name, 'alba');
    assert.equal(options.body.options.authenticatorSelection.residentKey, 'preferred', 'discoverable: it signs in alone');
    const done = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) });
    assert.deepEqual([done.status, done.body], [200, { redirect: '/' }]);
    assert.ok(sessionCookie(lab, browser), 'now a session');
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.account.role, 'student');
    assert.equal(me.body.passkeys.length, 1);
    assert.equal(account(lab, 'local:alba').needsPasskey, false);
    assert.ok(browser.cookie(lab.url, 'lc_device'), 'the browser is known for the name, as after a password');

    const other = new TestBrowser();
    const oneClick = await passkeySignIn(lab, other, key, { next: '/#/team' });
    assert.deepEqual([oneClick.status, oneClick.body], [200, { redirect: '/#/team' }]);
    assert.equal((await call(lab, other, 'GET', '/api/accounts/me')).body.account.id, 'local:alba');
    assert.deepEqual(await loginMethods(lab, 'local:alba'), ['signup+passkey-enrol', 'passkey']);
    const added = (await lab.deps.audit.query({ action: 'accounts.passkey.add' })).find((e) => e.details.account === 'local:alba');
    assert.equal(added.details.enrolment, true);
  });

  test('once a passkey exists, the password alone never opens a session: it asks for the passkey', async () => {
    const browser = new TestBrowser();
    const res = await localSignIn(lab, browser, 'ALBA');
    assert.deepEqual([res.status, res.body], [200, { step: 'passkey' }]);
    assert.equal(sessionCookie(lab, browser), null);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 401);
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.body.kind, 'passkey');
    assert.deepEqual(options.body.options.allowCredentials.map((c) => c.id), [key.credentials[0].id], "only this account's passkeys");
    const done = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.authenticate(options.body.options) });
    assert.equal(done.status, 200);
    assert.ok(sessionCookie(lab, browser));
    // A wrong password is still the one generic refusal: nothing says the account has a passkey
    const wrong = await localSignIn(lab, new TestBrowser(), 'alba', 'not the password at all');
    assert.deepEqual([wrong.status, wrong.body.code], [401, 'auth.invalid_credentials']);
  });

  test('a sign-up left before its passkey: the account exists, and registers one at its next password sign-in', async () => {
    const { id, browser: abandoned } = await signUpOnly(lab, 'bruno');
    assert.equal(account(lab, id).state, 'active');
    assert.equal(account(lab, id).passkeys, 0);
    assert.equal(sessionCookie(lab, abandoned), null);

    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'bruno')).body, { step: 'passkey-enrol' });
    assert.equal(sessionCookie(lab, browser), null, 'still no session with the password alone');
    const brunoKey = authenticator(lab);
    assert.equal((await enrol(lab, browser, brunoKey)).status, 200);
    assert.ok(sessionCookie(lab, browser));
    assert.deepEqual(await loginMethods(lab, id), ['local+passkey-enrol']);
    assert.equal((await passkeySignIn(lab, new TestBrowser(), brunoKey)).status, 200);
  });

  test('a refused registration at sign-up ends the step: no session, and no passkey registered', async () => {
    const { id, browser } = await signUpOnly(lab, 'carla');
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    const forged = authenticator(lab).register(options.body.options, { origin: 'https://evil.example' });
    const refused = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: forged });
    assert.deepEqual([refused.status, refused.body.code], [401, 'accounts.passkey_refused']);
    assert.equal(sessionCookie(lab, browser), null);
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/step/options', {})).body.code, 'accounts.step_expired');
    assert.equal(account(lab, id).passkeys, 0);
    assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'carla')).body, { step: 'passkey-enrol' }, 'asked again at the next sign-in');
  });

  test('a link for several people: the passkey is registered at sign-up, and the account waits for approval without a session', async () => {
    const { token } = await invite(lab, { uses: 3 });
    const browser = new TestBrowser();
    const res = await signUp(lab, token, { username: 'dalia' }, browser);
    assert.deepEqual(res.body, { step: 'passkey-enrol', pending: true });
    const daliaKey = authenticator(lab);
    const done = await enrol(lab, browser, daliaKey);
    assert.deepEqual([done.status, done.body], [200, { pending: true }]);
    assert.equal(sessionCookie(lab, browser), null, 'no session for a pending account');
    assert.equal(account(lab, 'local:dalia').state, 'pending');
    assert.equal(account(lab, 'local:dalia').passkeys, 1, 'but the passkey is kept');
    assert.equal((await passkeySignIn(lab, new TestBrowser(), daliaKey)).status, 401, 'not before the approval');
    assert.equal((await localSignIn(lab, new TestBrowser(), 'dalia')).status, 401, 'nor with the password');

    assert.equal((await call(lab, 'admin', 'POST', '/api/accounts/users/local%3Adalia/approve')).status, 200);
    const approved = new TestBrowser();
    assert.equal((await passkeySignIn(lab, approved, daliaKey)).status, 200, 'one click, from the first sign-in on');
    assert.equal((await call(lab, approved, 'GET', '/api/accounts/me')).body.account.state, 'active');
  });

  test('an administrator invitation: the same, the passkey before the first session', async () => {
    const { token } = await invite(lab, { role: 'admin' });
    const browser = new TestBrowser();
    assert.deepEqual((await signUp(lab, token, { username: 'sam' }, browser)).body, { step: 'passkey-enrol' });
    assert.equal(sessionCookie(lab, browser), null);
    assert.equal((await enrol(lab, browser)).status, 200);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/users')).status, 200, "an administrator's session");
  });
});

describe('accounts made before passkeys were required (the upgrade of a running installation)', () => {
  test('a student with a password and no passkey registers one at its next sign-in; from then on the password alone is not enough', async () => {
    const earlier = await startAccountsApp();
    try {
      // As the database of a running installation holds them today
      await earlier.deps.repos.accounts.insertIfAbsent({
        id: 'local:olga', via: 'local', username: 'olga', usernameKey: 'olga', name: 'Olga Petit', email: '', role: 'student', state: 'active',
        groups: [], passwordHash: await hashPassword(PASSWORD, FAST_SCRYPT), passwordChangedAt: Date.now(),
        webauthnUserId: crypto.randomBytes(16).toString('base64url'), passkeys: [], createdAt: Date.now(), lastSignInAt: Date.now(),
      });
      const lab = await startAccountsApp({ env: { DATA_DIR: earlier.dataDir } });
      try {
        const listed = (await call(lab, 'admin', 'GET', '/api/accounts/users')).body.users.find((u) => u.id === 'local:olga');
        assert.equal(listed.needsPasskey, true, 'the Users tab shows it');
        const browser = new TestBrowser();
        const first = await localSignIn(lab, browser, 'olga');
        assert.deepEqual([first.status, first.body], [200, { step: 'passkey-enrol' }], 'password first, then a passkey');
        assert.equal(sessionCookie(lab, browser), null);
        const key = authenticator(lab);
        assert.deepEqual((await enrol(lab, browser, key)).body, { redirect: '/' });
        assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).body.passkeys.length, 1);
        assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'olga')).body, { step: 'passkey' });
        assert.equal((await passkeySignIn(lab, new TestBrowser(), key)).status, 200);
      } finally {
        await lab.close();
      }
    } finally {
      await earlier.close();
    }
  });
});

describe('a local account promoted to administrator signs in like any local account', () => {
  let lab;
  let key;
  let id;
  before(async () => {
    lab = await startAccountsApp();
    ({ id, key } = await createLocalAccount(lab, 'nora'));
    assert.equal((await promote(lab, id)).status, 200);
  });
  after(() => lab.close());

  test('promoted, it keeps the passkey registered at sign-up: password then passkey, never the password alone', async () => {
    assert.equal(account(lab, id).needsPasskey, false);
    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'nora')).body, { step: 'passkey' });
    assert.equal(sessionCookie(lab, browser), null);
    assert.equal((await usePasskey(lab, browser, key)).status, 200);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/users')).status, 200, "an administrator's session");
  });

  test('a refused passkey ends the step: the password must be typed again', async () => {
    const browser = new TestBrowser();
    await localSignIn(lab, browser, 'nora');
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    const forged = key.authenticate(options.body.options, { origin: 'https://evil.example' });
    const refused = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: forged });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'accounts.passkey_refused');
    assert.equal(sessionCookie(lab, browser), null);
    const again = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(again.status, 401);
    assert.equal(again.body.code, 'accounts.step_expired');
  });

  test('one click: any passkey of the site signs in, with user verification', async () => {
    const browser = new TestBrowser();
    const options = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.options.allowCredentials ?? [], [], 'discoverable: the browser offers what it has');
    assert.equal(options.body.options.userVerification, 'required');
    const done = await call(lab, browser, 'POST', '/auth/passkey/verify', { response: key.authenticate(options.body.options), next: '/#/admin' });
    assert.equal(done.status, 200);
    assert.equal(done.body.redirect, '/#/admin');
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.account.id, id);
    assert.equal(me.body.account.role, 'admin');
  });

  test('one click without user verification is refused', async () => {
    const browser = new TestBrowser();
    const res = await passkeySignIn(lab, browser, key, { userVerified: false });
    assert.equal(res.status, 401);
    assert.equal(sessionCookie(lab, browser), null);
  });

  test('a wrong origin is refused, and the challenge is gone with it', async () => {
    const browser = new TestBrowser();
    const options = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    const phished = await call(lab, browser, 'POST', '/auth/passkey/verify', { response: key.authenticate(options.body.options, { origin: 'http://localhost.evil.example' }) });
    assert.equal(phished.status, 401);
    assert.equal(phished.body.code, 'accounts.passkey_refused');
    // The genuine answer to the same challenge comes too late: single use
    const genuine = await call(lab, browser, 'POST', '/auth/passkey/verify', { response: key.authenticate(options.body.options) });
    assert.equal(genuine.status, 401);
    assert.equal(sessionCookie(lab, browser), null);
  });

  test('a replayed response is refused: the challenge was single use, and a new one does not match it', async () => {
    const browser = new TestBrowser();
    const options = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    const response = key.authenticate(options.body.options);
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/verify', { response })).status, 200);
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/verify', { response })).status, 401, 'same ceremony: gone');
    const other = new TestBrowser();
    await call(lab, other, 'POST', '/auth/passkey/options', {});
    assert.equal((await call(lab, other, 'POST', '/auth/passkey/verify', { response })).status, 401, 'another ceremony: another challenge');
    assert.equal((await call(lab, new TestBrowser(), 'POST', '/auth/passkey/verify', { response })).status, 401, 'no ceremony at all');
  });

  test('a passkey nobody registered, or one answering for another account, is refused', async () => {
    const stranger = new SoftAuthenticator({ origin: lab.url });
    stranger.register({ challenge: 'AAAA', user: { id: 'AAAA' } });
    const browser = new TestBrowser();
    assert.equal((await passkeySignIn(lab, browser, stranger)).status, 401);
    const second = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    const wrongHandle = key.authenticate(second.body.options);
    wrongHandle.response.userHandle = 'AAAAAAAAAAAAAAAAAAAAAA';
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/verify', { response: wrongHandle })).status, 401);
  });

  test("a disabled account's passkey no longer signs in", async () => {
    const { id: other, key: oscarKey } = await createLocalAccount(lab, 'oscar');
    assert.equal((await passkeySignIn(lab, new TestBrowser(), oscarKey)).status, 200);
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(other)}`, { state: 'disabled' })).status, 200);
    assert.equal((await passkeySignIn(lab, new TestBrowser(), oscarKey)).status, 401);
  });

  test('an administrator clears a lost passkey: the next sign-in asks to register one again', async () => {
    const unconfirmed = await call(lab, 'admin', 'DELETE', `/api/accounts/users/${encodeURIComponent(id)}/passkeys`);
    assert.deepEqual([unconfirmed.status, unconfirmed.body.code], [403, 'admin.confirm_required'], "an administrator's passkeys: confirmed first");
    const cleared = await confirmed(lab, 'DELETE', `/api/accounts/users/${encodeURIComponent(id)}/passkeys`);
    assert.equal(cleared.body.removed, 1);
    assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'nora')).body, { step: 'passkey-enrol' });
  });
});

describe('passkeys in My account', () => {
  let lab;
  let ritaKey;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  test('a student adds, renames and removes passkeys; the last one cannot be removed', async () => {
    const { browser, key: first } = await createLocalAccount(lab, 'paula');
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.passkeys.length, 1, 'the one of the sign-up');
    const firstId = encodeURIComponent(me.body.passkeys[0].id);
    const last = await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${firstId}`);
    assert.deepEqual([last.status, last.body.code], [409, 'accounts.last_passkey'], 'a student keeps one too');

    const key = authenticator(lab);
    const options = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.options.excludeCredentials.map((c) => c.id), [first.credentials[0].id], 'the browser is told which one it already has');
    const added = await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options), name: 'Laptop' });
    assert.equal(added.status, 200);
    assert.equal(added.body.passkey.name, 'Laptop');
    assert.ok(!('publicKey' in added.body.passkey));

    // Once is enough: the ceremony is over
    assert.equal((await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options) })).status, 400);

    const pid = encodeURIComponent(added.body.passkey.id);
    assert.equal((await call(lab, browser, 'PATCH', `/api/accounts/me/passkeys/${pid}`, { name: 'Old laptop' })).body.passkey.name, 'Old laptop');
    assert.equal((await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${firstId}`)).status, 200, 'with two, one may go');
    assert.equal((await passkeySignIn(lab, new TestBrowser(), first)).status, 401, 'the removed one no longer signs in');
    assert.equal((await passkeySignIn(lab, new TestBrowser(), key)).status, 200);
    const lastOne = await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${pid}`);
    assert.deepEqual([lastOne.status, lastOne.body.code], [409, 'accounts.last_passkey']);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).body.passkeys.length, 1, 'nothing removed');
    assert.equal((await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${firstId}`)).status, 404);
  });

  test('a registration ceremony belongs to the session that started it', async () => {
    const { browser, key: quinnKey } = await createLocalAccount(lab, 'quinn');
    const key = authenticator(lab);
    const options = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    const other = new TestBrowser();
    assert.equal((await signInWithPassword(lab, other, 'quinn', quinnKey)).status, 200);
    // Another session of the same person, given the ceremony cookie, still cannot finish it
    const stolen = await other.fetch(`${lab.url}/api/accounts/me/passkeys`, {
      method: 'POST',
      headers: {
        origin: lab.url,
        'content-type': 'application/json',
        cookie: `${other.cookieHeader(lab.url)}; lc_passkey=${browser.cookie(lab.url, 'lc_passkey')}`,
      },
      body: JSON.stringify({ response: key.register(options.body.options) }),
    });
    assert.equal(stolen.status, 400);
    const wrongOrigin = await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options, { origin: 'https://evil.example' }) });
    assert.equal(wrongOrigin.status, 400, 'and the ceremony was single use anyway');
  });

  test('an administrator keeps at least one passkey too', async () => {
    const { id, browser: signedUp, key } = await createLocalAccount(lab, 'rita');
    ritaKey = key;
    await promote(lab, id);
    assert.equal((await call(lab, signedUp, 'GET', '/api/accounts/me')).status, 401, 'the promotion ended her session');
    const browser = new TestBrowser();
    assert.equal((await signInWithPassword(lab, browser, 'rita', key)).status, 200);
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    const res = await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${encodeURIComponent(me.body.passkeys[0].id)}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'accounts.last_passkey');
  });

  test('a role changed during the step: the session opened at its end has the new role', async () => {
    // rita (administrator, one passkey) types her password; meanwhile she is
    // demoted, which needs another administrator in the directory: sven
    await createLocalAccount(lab, 'sven', { role: 'admin' });
    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'rita')).body, { step: 'passkey' });
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal((await confirmed(lab, 'PATCH', `/api/accounts/users/${encodeURIComponent('local:rita')}`, { role: 'student' })).status, 200);
    assert.equal(account(lab, 'local:rita').role, 'student');
    const done = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: ritaKey.authenticate(options.body.options) });
    assert.equal(done.status, 200);
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.account.role, 'student');
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/users')).status, 403, 'no administrator session out of a stale step');
  });

  test('SSO accounts rely on their provider: no passkeys for them', async () => {
    const res = await call(lab, 'student1', 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal(res.status, 404, 'not in the directory');
    await lab.deps.services.accounts.admit(lab.signIn('student2').user, { groupRole: 'student' });
    const known = await call(lab, 'student2', 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal(known.body.code, 'accounts.not_local');
    assert.equal((await call(lab, 'admin', 'GET', '/api/accounts/users')).body.users.find((u) => u.id === 'oidc:student2').needsPasskey, false);
  });

  test('the environment administrator keeps password and code: no passkey, no step', async () => {
    const browser = new TestBrowser();
    const res = await call(lab, browser, 'POST', '/auth/local', { username: TEST_ADMIN.username, password: TEST_ADMIN.password, code: freshAdminCode(lab) });
    assert.deepEqual([res.status, res.body], [200, { redirect: '/' }]);
    assert.ok(sessionCookie(lab, browser));
    const listed = (await call(lab, browser, 'GET', '/api/accounts/users')).body.users[0];
    assert.deepEqual([listed.environment, listed.needsPasskey], [true, false]);
  });
});

describe('a password reset link sets a new password and replaces the passkeys', () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());
  const resetLink = async (id, ttl = '1h') => {
    const res = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.url.split('#')[1];
  };

  test('a lost phone: the old passkeys are removed, a new one is registered before the first session', async () => {
    const { id, browser: owner, key: lost } = await createLocalAccount(lab, 'ines');
    const thief = new TestBrowser();
    assert.equal((await passkeySignIn(lab, thief, lost)).status, 200, 'whoever holds the lost phone is signed in');
    const token = await resetLink(id);

    const browser = new TestBrowser();
    const res = await call(lab, browser, 'POST', '/auth/reset', { token, password: 'a brand new passphrase' });
    assert.deepEqual([res.status, res.body], [200, { step: 'passkey-enrol' }]);
    assert.equal(sessionCookie(lab, browser), null, 'no session before the new passkey');
    assert.equal(account(lab, id).passkeys, 0, 'the old passkeys are gone at once');
    for (const b of [owner, thief]) assert.equal((await call(lab, b, 'GET', '/api/accounts/me')).status, 401, 'every session ended');
    assert.equal((await passkeySignIn(lab, new TestBrowser(), lost)).status, 401, 'the lost passkey no longer signs in');
    const reset = (await lab.deps.audit.query({ action: 'accounts.password.reset' }))[0];
    assert.deepEqual([reset.details.passkeysRemoved, reset.details.sessionsEnded], [1, 2]);

    const fresh = authenticator(lab);
    const done = await enrol(lab, browser, fresh);
    assert.deepEqual([done.status, done.body], [200, { redirect: '/' }]);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).body.passkeys.length, 1);
    assert.deepEqual((await loginMethods(lab, id)).slice(-1), ['reset+passkey-enrol']);
    assert.equal((await passkeySignIn(lab, new TestBrowser(), fresh)).status, 200);
    assert.equal((await localSignIn(lab, new TestBrowser(), 'ines')).status, 401, 'the old password');
    assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'ines', 'a brand new passphrase')).body, { step: 'passkey' });
    assert.equal((await call(lab, null, 'POST', '/auth/reset', { token, password: 'yet another passphrase' })).status, 404, 'single use');
  });

  test('a reset left before its passkey: the new password, no passkey, and the next sign-in registers one', async () => {
    const { id } = await createLocalAccount(lab, 'jonas');
    const token = await resetLink(id);
    assert.deepEqual((await call(lab, new TestBrowser(), 'POST', '/auth/reset', { token, password: 'a brand new passphrase' })).body, { step: 'passkey-enrol' });
    assert.equal(account(lab, id).needsPasskey, true);
    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'jonas', 'a brand new passphrase')).body, { step: 'passkey-enrol' });
    assert.equal((await enrol(lab, browser)).status, 200);
  });

  test('a disabled account: password and passkeys replaced, but no step, so no session', async () => {
    const { id } = await createLocalAccount(lab, 'karim');
    const token = await resetLink(id);
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { state: 'disabled' })).status, 200);
    const browser = new TestBrowser();
    const res = await call(lab, browser, 'POST', '/auth/reset', { token, password: 'a brand new passphrase' });
    assert.deepEqual([res.status, res.body], [200, { ok: true }]);
    assert.equal(browser.cookie(lab.url, 'lc_step'), null);
    assert.equal(account(lab, id).passkeys, 0);
  });

  test('a registration that began before the reset never lands after it', async () => {
    const memory = await memoryDatabase();
    try {
      const directory = createDirectory({ repos: memory.repos, envAdminName: 'root', passwordCost: FAST_SCRYPT });
      await directory.load();
      const created = await directory.createLocal({ username: 'lea', name: 'Léa', passwordHash: await hashPassword(PASSWORD, FAST_SCRYPT), role: 'student', state: 'active' });
      const startedWith = passwordFingerprint(created);
      const passkey = (n) => ({ id: `credential-${n}-${'x'.repeat(16)}`, publicKey: 'AAAA', counter: 0, transports: [], backedUp: false, name: 'phone' });
      await directory.addPasskey(created.id, passkey(1), { password: startedWith });
      assert.equal(await directory.resetCredentials(created.id, await hashPassword('a brand new passphrase', FAST_SCRYPT)), 1);
      await assert.rejects(directory.addPasskey(created.id, passkey(2), { password: startedWith }), (err) => err.code === 'accounts.passkey_refused');
      assert.deepEqual(directory.get(created.id).passkeys, []);
    } finally {
      await memory.close();
    }
  });
});

describe('a sign-in step does not outlive the credentials it was started with', () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  test('a password reset ends an enrolment step started with the old password', async () => {
    const { id } = await signUpOnly(lab, 'tara');
    // Someone who knows the old password starts the sign-in and asks for the enrolment ceremony
    const attacker = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, attacker, 'tara')).body, { step: 'passkey-enrol' });
    const options = await call(lab, attacker, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.status, 200);

    const link = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '1h' });
    const reset = await call(lab, new TestBrowser(), 'POST', '/auth/reset', { token: link.body.url.split('#')[1], password: 'a brand new passphrase' });
    assert.equal(reset.status, 200);

    const done = await call(lab, attacker, 'POST', '/auth/passkey/step/verify', { response: authenticator(lab).register(options.body.options) });
    assert.equal(done.status, 401);
    assert.equal(done.body.code, 'accounts.step_expired');
    assert.equal(sessionCookie(lab, attacker), null);
    assert.equal((await call(lab, attacker, 'POST', '/auth/passkey/step/options', {})).status, 401, 'and the step is gone');
    assert.equal(account(lab, id).passkeys, 0, 'nothing was registered');
  });

  test('a password changed in My account ends a passkey step started with the old one', async () => {
    const { key, browser: owner } = await createLocalAccount(lab, 'ugo');
    const attacker = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, attacker, 'ugo')).body, { step: 'passkey' });
    const changed = await call(lab, owner, 'POST', '/api/accounts/me/password', { current: PASSWORD, password: 'another long passphrase' });
    assert.equal(changed.status, 200);
    const options = await call(lab, attacker, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.status, 401);
    assert.equal(options.body.code, 'accounts.step_expired');

    // The owner's own step with the new password still works
    assert.equal((await signInWithPassword(lab, new TestBrowser(), 'ugo', key, 'another long passphrase')).status, 200);
  });

  test('passkeys cleared by an administrator: a step that was owed one does not become an enrolment', async () => {
    const { id } = await createLocalAccount(lab, 'vera');
    const attacker = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, attacker, 'vera')).body, { step: 'passkey' });
    assert.equal((await call(lab, 'admin', 'DELETE', `/api/accounts/users/${encodeURIComponent(id)}/passkeys`)).body.removed, 1, "a student's: no confirmation");
    const options = await call(lab, attacker, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.status, 401, 'not an enrolment for whoever held the step');
    assert.equal(options.body.code, 'accounts.step_expired');
    assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'vera')).body, { step: 'passkey-enrol' }, 'a new sign-in enrols, as intended');
  });

  test('a passkey registered meanwhile in another tab keeps the step going: it now asks for that passkey', async () => {
    await signUpOnly(lab, 'wanda');
    const first = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, first, 'wanda')).body, { step: 'passkey-enrol' });
    const key = authenticator(lab);
    const second = new TestBrowser();
    await localSignIn(lab, second, 'wanda');
    assert.equal((await enrol(lab, second, key)).status, 200);
    const options = await call(lab, first, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.body.kind, 'passkey');
    assert.equal((await call(lab, first, 'POST', '/auth/passkey/step/verify', { response: key.authenticate(options.body.options) })).status, 200);
  });
});

describe("passkey refusals: another account's passkey, a credential registered twice, the eleventh", () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  const addPasskey = async (browser, key, extra = {}) => {
    const options = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    return call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options, extra), name: 'key' });
  };

  test("a student cannot rename or remove another account's passkey through My account", async () => {
    const { browser: xavier } = await createLocalAccount(lab, 'xavier');
    const { browser: yasmin } = await createLocalAccount(lab, 'yasmin');
    const added = await addPasskey(yasmin, authenticator(lab));
    assert.equal(added.status, 200);
    const pid = encodeURIComponent(added.body.passkey.id);
    const renamed = await call(lab, xavier, 'PATCH', `/api/accounts/me/passkeys/${pid}`, { name: 'mine now' });
    assert.equal(renamed.status, 404);
    assert.equal(renamed.body.code, 'accounts.unknown_passkey');
    const removed = await call(lab, xavier, 'DELETE', `/api/accounts/me/passkeys/${pid}`);
    assert.equal(removed.status, 404);
    assert.equal(removed.body.code, 'accounts.unknown_passkey');
    const theirs = await call(lab, yasmin, 'GET', '/api/accounts/me');
    assert.deepEqual(theirs.body.passkeys.filter((p) => p.id === added.body.passkey.id).map((p) => p.name), ['key'], 'untouched');
  });

  test('a credential already registered, on another account or the same one, is refused', async () => {
    const { browser: zack, key } = await createLocalAccount(lab, 'zack');
    // abel's sign-up presents zack's passkey again: refused, and the step is over
    const { browser: abelSignUp } = await (async () => {
      const { token } = await invite(lab);
      const browser = new TestBrowser();
      await signUp(lab, token, { username: 'abel' }, browser);
      return { browser };
    })();
    const options = await call(lab, abelSignUp, 'POST', '/auth/passkey/step/options', {});
    const twice = await call(lab, abelSignUp, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options, { credential: key.credentials[0] }) });
    assert.deepEqual([twice.status, twice.body.code], [401, 'accounts.passkey_refused']);
    assert.equal(account(lab, 'local:abel').passkeys, 0);
    // Through My account, the same: 409
    assert.equal((await addPasskey(zack, key, { credential: key.credentials[0] })).body.code, 'accounts.passkey_known');
  });

  test('ten passkeys at most per account', async () => {
    const { browser } = await createLocalAccount(lab, 'bruno');
    const key = authenticator(lab);
    for (let i = 1; i < 10; i++) assert.equal((await addPasskey(browser, key)).status, 200, `passkey ${i + 1}`);
    const eleventh = await addPasskey(browser, key);
    assert.equal(eleventh.status, 409);
    assert.equal(eleventh.body.code, 'accounts.too_many_passkeys');
    assert.equal(eleventh.body.params.max, 10);
  });
});

describe('the browsers of local accounts become known, whatever way they signed in', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ env: { TRUSTED_PROXIES: '127.0.0.1' } }); });
  after(() => lab.close());

  const deviceCookie = (browser) => browser.cookie(lab.url, 'lc_device');
  /** The local form from a given client address (behind the trusted proxy) */
  const signInFrom = async (ip, username, password, browser = new TestBrowser()) => {
    const res = await browser.fetch(`${lab.url}/auth/local`, {
      method: 'POST',
      headers: { origin: lab.url, 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username, password, code: '' }),
    });
    return { status: res.status, body: await res.json() };
  };

  test('strangers failing on names they made up never keep a student with the right password out', async () => {
    await createLocalAccount(lab, 'carol');
    for (let a = 0; a < 10; a++) {
      for (let i = 0; i < 5; i++) assert.equal((await signInFrom(`198.18.${a}.1`, `x${a}y${i}zz`, 'nope nope nope')).status, 401);
    }
    assert.equal((await signInFrom('198.18.99.1', 'made-up', 'nope nope nope')).status, 401, 'fifty failures and more');
    assert.equal((await signInFrom('198.18.99.2', 'made-up', 'nope nope nope')).status, 429, 'the global count is full');
    // A school PC: a browser that never signed in, from another address
    const carol = await signInFrom('192.0.2.200', 'carol', PASSWORD);
    assert.equal(carol.status, 200, JSON.stringify(carol.body));
    assert.deepEqual(carol.body, { step: 'passkey' }, 'on to her passkey');
  });

  test('sign-up and one-click passkey sign-in leave the known-browser cookie, as a password does', async () => {
    const { browser, key } = await createLocalAccount(lab, 'dina');
    assert.ok(deviceCookie(browser), 'after sign-up');
    const other = new TestBrowser();
    assert.equal((await passkeySignIn(lab, other, key)).status, 200);
    assert.ok(deviceCookie(other), 'after a one-click passkey sign-in');

    // That browser now gets in while strangers keep the name and the global count full
    for (let i = 0; i < 3; i++) await signInFrom(`198.19.0.${i}`, 'dina', 'nope nope nope');
    assert.equal((await signInFrom('198.19.1.1', 'dina', PASSWORD)).status, 429, "a stranger's browser is kept waiting");
    assert.equal((await signInFrom('198.19.1.2', 'dina', PASSWORD, other)).status, 200, 'the known browser is not');
  });
});

describe('a classroom behind one public address', () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  test('a dozen students typing their password at once each keep their own passkey step', async () => {
    const students = [];
    for (let i = 0; i < 12; i++) students.push(await createLocalAccount(lab, `pupil${i}`));
    // Every password first, from the same address, then every passkey
    const browsers = students.map(() => new TestBrowser());
    for (const [i, browser] of browsers.entries()) assert.deepEqual((await localSignIn(lab, browser, `pupil${i}`)).body, { step: 'passkey' });
    for (const [i, browser] of browsers.entries()) assert.equal((await usePasskey(lab, browser, students[i].key)).status, 200, `pupil${i}`);
  });

  test("a classroom's one-click requests leave the step after a password alone; Retry-After is the minute", async () => {
    const { key } = await createLocalAccount(lab, 'elsa');
    let refused = null;
    for (let i = 1; i <= PASSKEY_LIMITS.oneClick + 1 && !refused; i++) {
      const res = await call(lab, new TestBrowser(), 'POST', '/auth/passkey/options', {});
      if (res.status === 429) refused = { at: i, res };
    }
    assert.equal(refused?.at, PASSKEY_LIMITS.oneClick + 1, 'a whole class opening the login page fits');
    assert.equal(refused.res.body.code, 'accounts.throttled');
    assert.equal(refused.res.res.headers.get('retry-after'), '60');

    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'elsa')).body, { step: 'passkey' });
    assert.equal((await usePasskey(lab, browser, key)).status, 200, 'the step has its own budget');
  });
});

describe('without passkeys (http on an address), local accounts are refused, clearly', () => {
  let earlier;
  let lab;
  let links;
  before(async () => {
    // The same database, first served over a name (accounts, an invitation and a reset link made there), then over plain http on an address
    earlier = await startAccountsApp();
    const { id } = await createLocalAccount(earlier, 'tom');
    links = {
      invitation: (await invite(earlier)).token,
      reset: (await call(earlier, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '1h' })).body.url.split('#')[1],
    };
    lab = await startAccountsApp({ publicHost: '127.0.0.1', env: { DATA_DIR: earlier.dataDir } });
  });
  after(async () => {
    await lab?.close();
    await earlier?.close();
  });
  const unavailable = (res, what) => assert.deepEqual([res.status, res.body?.code], [409, 'accounts.passkeys_unavailable'], what);

  test('the pages are told; one-click sign-in is refused', async () => {
    assert.equal((await call(lab, null, 'GET', '/auth/me')).body.passkeys, false);
    unavailable(await call(lab, new TestBrowser(), 'POST', '/auth/passkey/options', {}), 'one click');
  });

  test('a local account with the right password is told why it cannot sign in; a wrong password still gets the generic refusal', async () => {
    const browser = new TestBrowser();
    const res = await localSignIn(lab, browser, 'tom');
    unavailable(res, 'the right password');
    assert.equal(sessionCookie(lab, browser), null, 'no fallback to the password');
    assert.equal(browser.cookie(lab.url, 'lc_step'), null, 'and no step that could never end');
    const wrong = await localSignIn(lab, new TestBrowser(), 'tom', 'not the password at all');
    assert.deepEqual([wrong.status, wrong.body.code], [401, 'auth.invalid_credentials'], 'nothing for someone without the password');
    const audited = (await lab.deps.audit.query({ action: 'auth.login.failed' })).find((e) => e.details.reason === 'accounts.passkeys_unavailable');
    assert.equal(audited.details.username, 'tom');
  });

  test('no local account can be created: the invitation page, the sign-up and new invitations are refused, and the link is not used', async () => {
    unavailable(await call(lab, null, 'POST', '/auth/invitation', { token: links.invitation }), 'what the link offers');
    unavailable(await signUp(lab, links.invitation, { username: 'ulla' }), 'sign-up');
    assert.equal(lab.deps.services.accounts.get('local:ulla'), null);
    const listed = (await call(lab, 'admin', 'GET', '/api/accounts/invitations')).body;
    assert.equal(listed.passkeysAvailable, false);
    assert.equal(listed.invitations.find((i) => i.state === 'active')?.uses, 0, 'the link is still unused');
    unavailable(await call(lab, 'admin', 'POST', '/api/accounts/invitations', { role: 'student' }), 'a student invitation');
    unavailable(await confirmed(lab, 'POST', '/api/accounts/invitations', { role: 'admin' }), 'an administrator invitation');
  });

  test('no reset link is made or used; no passkey is added; no local account is promoted', async () => {
    unavailable(await call(lab, null, 'POST', '/auth/reset-link', { token: links.reset }), 'what the link resets');
    unavailable(await call(lab, null, 'POST', '/auth/reset', { token: links.reset, password: 'a brand new passphrase' }), 'the reset');
    unavailable(await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent('local:tom')}/reset-link`, { ttl: '1h' }), 'a new link');
    const tom = lab.signIn(createUser({ id: 'local:tom', username: 'tom', name: 'tom', role: 'student', via: 'local' }));
    unavailable(await call(lab, tom, 'POST', '/api/accounts/me/passkeys/options', {}), 'My account');
    unavailable(await confirmed(lab, 'PATCH', `/api/accounts/users/${encodeURIComponent('local:tom')}`, { role: 'admin' }), 'promotion');
    assert.equal(lab.deps.services.accounts.get('local:tom').passkeys, 1, 'the passkey is kept for when https comes back');
  });

  test('the environment administrator still signs in', async () => {
    const browser = new TestBrowser();
    const res = await call(lab, browser, 'POST', '/auth/local', { username: TEST_ADMIN.username, password: TEST_ADMIN.password, code: freshAdminCode(lab) });
    assert.deepEqual([res.status, res.body], [200, { redirect: '/' }]);
  });
});
