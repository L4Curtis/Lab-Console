/**
 * Passkeys (SPEC, lot accounts): forced enrolment of a promoted local
 * administrator, the passkey step after a password, one-click sign-in, My
 * account, and the refusals - a wrong origin, a replayed or missing
 * challenge, a disabled account, http on an address
 *
 * The browser and the authenticator are played by test/helpers/webauthn.js;
 * the server side is the real @simplewebauthn/server
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestBrowser } from './helpers/browser.js';
import { SoftAuthenticator } from './helpers/webauthn.js';
import { startAccountsApp, call, invite, signUp, localSignIn, createLocalAccount } from './helpers/accounts.js';
import { relyingParty } from '../src/modules/accounts/passkeys.js';

const sessionCookie = (lab, browser) => browser.cookie(lab.url, lab.deps.auth.cookieName);
const promote = (lab, id) => call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { role: 'admin' });

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

describe('a local account promoted to administrator', () => {
  let lab;
  let key;
  let id;
  before(async () => {
    lab = await startAccountsApp({ publicHost: 'localhost' });
    key = new SoftAuthenticator({ origin: lab.url });
    ({ id } = await createLocalAccount(lab, 'nora'));
    assert.equal((await promote(lab, id)).status, 200);
  });
  after(() => lab.close());

  test('its password alone opens no session: it must register a passkey first', async () => {
    const browser = new TestBrowser();
    const res = await localSignIn(lab, browser, 'nora');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { step: 'passkey-enrol' });
    assert.equal(sessionCookie(lab, browser), null, 'no session yet');
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 401, 'the step cookie is not a session');

    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.body.kind, 'passkey-enrol');
    assert.equal(options.body.options.rp.id, 'localhost');
    assert.equal(options.body.options.user.name, 'nora');
    const done = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) });
    assert.equal(done.status, 200);
    assert.equal(done.body.redirect, '/');
    assert.ok(sessionCookie(lab, browser), 'now a session');
    const users = await call(lab, browser, 'GET', '/api/accounts/users');
    assert.equal(users.status, 200, 'an administrator\'s session');
    assert.equal(users.body.users.find((u) => u.id === id).passkeys, 1);
  });

  test('afterwards: password then passkey; the password alone never signs in', async () => {
    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'nora')).body, { step: 'passkey' });
    assert.equal(sessionCookie(lab, browser), null);
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.body.kind, 'passkey');
    assert.deepEqual(options.body.options.allowCredentials.map((c) => c.id), [key.credentials[0].id], 'only this account\'s passkeys');
    const done = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.authenticate(options.body.options) });
    assert.equal(done.status, 200);
    assert.ok(sessionCookie(lab, browser));
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
    const after = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(after.status, 401);
    assert.equal(after.body.code, 'accounts.step_expired');
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
    const options = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    const res = await call(lab, browser, 'POST', '/auth/passkey/verify', { response: key.authenticate(options.body.options, { userVerified: false }) });
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
    const options = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/verify', { response: stranger.authenticate(options.body.options) })).status, 401);
    const second = await call(lab, browser, 'POST', '/auth/passkey/options', {});
    const wrongHandle = key.authenticate(second.body.options);
    wrongHandle.response.userHandle = 'AAAAAAAAAAAAAAAAAAAAAA';
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/verify', { response: wrongHandle })).status, 401);
  });

  test('a disabled account\'s passkey no longer signs in', async () => {
    const { id: other } = await createLocalAccount(lab, 'oscar');
    const helper = new SoftAuthenticator({ origin: lab.url });
    const browser = new TestBrowser();
    await localSignIn(lab, browser, 'oscar');
    const reg = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal((await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: helper.register(reg.body.options), name: 'phone' })).status, 200);
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(other)}`, { state: 'disabled' })).status, 200);
    const one = new TestBrowser();
    const options = await call(lab, one, 'POST', '/auth/passkey/options', {});
    assert.equal((await call(lab, one, 'POST', '/auth/passkey/verify', { response: helper.authenticate(options.body.options) })).status, 401);
  });

  test('an administrator clears a lost passkey: the next sign-in asks to register one again', async () => {
    const cleared = await call(lab, 'admin', 'DELETE', `/api/accounts/users/${encodeURIComponent(id)}/passkeys`);
    assert.equal(cleared.body.removed, 1);
    assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'nora')).body, { step: 'passkey-enrol' });
  });
});

describe('passkeys in My account', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ publicHost: 'localhost' }); });
  after(() => lab.close());

  test('a student adds, renames and removes a passkey, and keeps the password', async () => {
    const { browser } = await createLocalAccount(lab, 'paula');
    const key = new SoftAuthenticator({ origin: lab.url });
    const options = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal(options.status, 200);
    const added = await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options), name: 'Laptop' });
    assert.equal(added.status, 200);
    assert.equal(added.body.passkey.name, 'Laptop');
    assert.ok(!('publicKey' in added.body.passkey));

    // Once is enough: the ceremony is over
    assert.equal((await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options) })).status, 400);

    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.passkeys.length, 1);
    const pid = encodeURIComponent(me.body.passkeys[0].id);
    assert.equal((await call(lab, browser, 'PATCH', `/api/accounts/me/passkeys/${pid}`, { name: 'Old laptop' })).body.passkey.name, 'Old laptop');
    assert.equal((await localSignIn(lab, new TestBrowser(), 'paula')).body.redirect, '/', 'a student keeps the password');
    assert.equal((await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${pid}`)).status, 200, 'a student may remove the last one');
    assert.equal((await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${pid}`)).status, 404);
  });

  test('a registration ceremony belongs to the session that started it', async () => {
    const { browser } = await createLocalAccount(lab, 'quinn');
    const key = new SoftAuthenticator({ origin: lab.url });
    const options = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    const other = new TestBrowser();
    await localSignIn(lab, other, 'quinn');
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

  test('an administrator keeps at least one passkey', async () => {
    const { id } = await createLocalAccount(lab, 'rita');
    await promote(lab, id);
    const key = new SoftAuthenticator({ origin: lab.url });
    const browser = new TestBrowser();
    await localSignIn(lab, browser, 'rita');
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) });
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    const pid = encodeURIComponent(me.body.passkeys[0].id);
    const res = await call(lab, browser, 'DELETE', `/api/accounts/me/passkeys/${pid}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'accounts.last_passkey');
  });

  test('an invitation to an administrator account: the passkey comes before the first session', async () => {
    const { token } = await invite(lab, { role: 'admin' });
    const browser = new TestBrowser();
    const res = await signUp(lab, token, { username: 'sam' }, browser);
    assert.deepEqual(res.body, { step: 'passkey-enrol' });
    assert.equal(sessionCookie(lab, browser), null);
    const key = new SoftAuthenticator({ origin: lab.url });
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    const done = await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) });
    assert.equal(done.status, 200);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/users')).status, 200);
  });

  test('SSO accounts rely on their provider: no passkeys for them', async () => {
    const res = await call(lab, 'student1', 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal(res.status, 404, 'not in the directory');
    await lab.deps.services.accounts.admit(lab.signIn('student2').user, { groupRole: 'student' });
    const known = await call(lab, 'student2', 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal(known.body.code, 'accounts.not_local');
  });
});

describe('without https (an address on the LAN), passkeys are not offered', () => {
  let lab;
  before(async () => { lab = await startAccountsApp(); });
  after(() => lab.close());

  test('the login page is told, the routes refuse, a local account cannot be promoted', async () => {
    assert.equal((await call(lab, null, 'GET', '/auth/me')).body.passkeys, false);
    const options = await call(lab, new TestBrowser(), 'POST', '/auth/passkey/options', {});
    assert.equal(options.status, 409);
    assert.equal(options.body.code, 'accounts.passkeys_unavailable');
    const { id, browser } = await createLocalAccount(lab, 'tom');
    assert.equal((await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {})).body.code, 'accounts.passkeys_unavailable');
    assert.equal((await promote(lab, id)).body.code, 'accounts.passkeys_unavailable');
  });
});
