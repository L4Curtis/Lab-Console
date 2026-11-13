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
import { startAccountsApp, call, invite, signUp, localSignIn, createLocalAccount, PASSWORD } from './helpers/accounts.js';
import { relyingParty } from '../src/modules/accounts/passkeys.js';
import { PASSKEY_LIMITS } from '../src/modules/accounts/publicRoutes.js';

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
  let ritaKey;
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
    ritaKey = key;
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

  test('a role changed during the step: the session opened at its end has the new role', async () => {
    // rita (administrator, one passkey) types her password; meanwhile she is demoted (sam stays an administrator)
    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'rita')).body, { step: 'passkey' });
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent('local:rita')}`, { role: 'student' })).status, 200);
    const rita = lab.deps.services.accounts.get('local:rita');
    assert.equal(rita.role, 'student');
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
  });
});

describe('a sign-in step does not outlive the credentials it was started with', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ publicHost: 'localhost' }); });
  after(() => lab.close());

  /** A promoted local administrator with a registered passkey; → { id, key, browser (signed in) } */
  async function adminWithPasskey(username) {
    const { id } = await createLocalAccount(lab, username);
    assert.equal((await promote(lab, id)).status, 200);
    const key = new SoftAuthenticator({ origin: lab.url });
    const browser = new TestBrowser();
    await localSignIn(lab, browser, username);
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) })).status, 200);
    return { id, key, browser };
  }

  test('a password reset ends an enrolment step started with the old password', async () => {
    const { id } = await createLocalAccount(lab, 'tara');
    assert.equal((await promote(lab, id)).status, 200);
    // Someone who knows the old password starts the sign-in and asks for the enrolment ceremony
    const attacker = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, attacker, 'tara')).body, { step: 'passkey-enrol' });
    const options = await call(lab, attacker, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.status, 200);

    const link = await call(lab, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '1h' });
    const reset = await call(lab, null, 'POST', '/auth/reset', { token: link.body.url.split('#')[1], password: 'a brand new passphrase' });
    assert.equal(reset.status, 200);

    const key = new SoftAuthenticator({ origin: lab.url });
    const done = await call(lab, attacker, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) });
    assert.equal(done.status, 401);
    assert.equal(done.body.code, 'accounts.step_expired');
    assert.equal(sessionCookie(lab, attacker), null);
    assert.equal((await call(lab, attacker, 'GET', '/api/accounts/users')).status, 401, 'no administrator session');
    assert.equal((await call(lab, attacker, 'POST', '/auth/passkey/step/options', {})).status, 401, 'and the step is gone');
    assert.equal(lab.deps.services.accounts.get(id).passkeys, 0, 'nothing was registered');
  });

  test('a password changed in My account ends a passkey step started with the old one', async () => {
    const { id, key, browser: owner } = await adminWithPasskey('ugo');
    const attacker = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, attacker, 'ugo')).body, { step: 'passkey' });
    const changed = await call(lab, owner, 'POST', '/api/accounts/me/password', { current: PASSWORD, password: 'another long passphrase' });
    assert.equal(changed.status, 200);
    const options = await call(lab, attacker, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.status, 401);
    assert.equal(options.body.code, 'accounts.step_expired');

    // The owner's own step with the new password still works
    const again = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, again, 'ugo', 'another long passphrase')).body, { step: 'passkey' });
    const fresh = await call(lab, again, 'POST', '/auth/passkey/step/options', {});
    assert.equal((await call(lab, again, 'POST', '/auth/passkey/step/verify', { response: key.authenticate(fresh.body.options) })).status, 200);
    assert.equal(lab.deps.services.accounts.get(id).role, 'admin');
  });

  test('passkeys cleared by an administrator: a step that was owed one does not become an enrolment', async () => {
    const { id } = await adminWithPasskey('vera');
    const attacker = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, attacker, 'vera')).body, { step: 'passkey' });
    assert.equal((await call(lab, 'admin', 'DELETE', `/api/accounts/users/${encodeURIComponent(id)}/passkeys`)).body.removed, 1);
    const options = await call(lab, attacker, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.status, 401, 'not an enrolment for whoever held the step');
    assert.equal(options.body.code, 'accounts.step_expired');
    assert.deepEqual((await localSignIn(lab, new TestBrowser(), 'vera')).body, { step: 'passkey-enrol' }, 'a new sign-in enrols, as intended');
  });

  test('a passkey registered meanwhile in another tab keeps the step going: it now asks for that passkey', async () => {
    const { id } = await createLocalAccount(lab, 'wanda');
    await promote(lab, id);
    const first = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, first, 'wanda')).body, { step: 'passkey-enrol' });
    const key = new SoftAuthenticator({ origin: lab.url });
    const second = new TestBrowser();
    await localSignIn(lab, second, 'wanda');
    const enrol = await call(lab, second, 'POST', '/auth/passkey/step/options', {});
    assert.equal((await call(lab, second, 'POST', '/auth/passkey/step/verify', { response: key.register(enrol.body.options) })).status, 200);
    const options = await call(lab, first, 'POST', '/auth/passkey/step/options', {});
    assert.equal(options.body.kind, 'passkey');
    assert.equal((await call(lab, first, 'POST', '/auth/passkey/step/verify', { response: key.authenticate(options.body.options) })).status, 200);
  });
});

describe('passkey refusals: another account\'s passkey, a credential registered twice, the eleventh', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ publicHost: 'localhost' }); });
  after(() => lab.close());

  const addPasskey = async (browser, key, extra = {}) => {
    const options = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    return call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(options.body.options, extra), name: 'key' });
  };

  test('a student cannot rename or remove another account\'s passkey through My account', async () => {
    const { browser: xavier } = await createLocalAccount(lab, 'xavier');
    const { browser: yasmin } = await createLocalAccount(lab, 'yasmin');
    const added = await addPasskey(yasmin, new SoftAuthenticator({ origin: lab.url }));
    assert.equal(added.status, 200);
    const pid = encodeURIComponent(added.body.passkey.id);
    const renamed = await call(lab, xavier, 'PATCH', `/api/accounts/me/passkeys/${pid}`, { name: 'mine now' });
    assert.equal(renamed.status, 404);
    assert.equal(renamed.body.code, 'accounts.unknown_passkey');
    const removed = await call(lab, xavier, 'DELETE', `/api/accounts/me/passkeys/${pid}`);
    assert.equal(removed.status, 404);
    assert.equal(removed.body.code, 'accounts.unknown_passkey');
    const theirs = await call(lab, yasmin, 'GET', '/api/accounts/me');
    assert.deepEqual(theirs.body.passkeys.map((p) => [p.id, p.name]), [[added.body.passkey.id, 'key']], 'untouched');
  });

  test('a credential already registered, on another account or the same one, is refused', async () => {
    const { browser: zack } = await createLocalAccount(lab, 'zack');
    const { browser: abel } = await createLocalAccount(lab, 'abel');
    const key = new SoftAuthenticator({ origin: lab.url });
    assert.equal((await addPasskey(zack, key)).status, 200);
    const twice = await addPasskey(abel, key, { credential: key.credentials[0] });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'accounts.passkey_known');
    assert.equal((await call(lab, abel, 'GET', '/api/accounts/me')).body.passkeys.length, 0);
    assert.equal((await addPasskey(zack, key, { credential: key.credentials[0] })).body.code, 'accounts.passkey_known');
  });

  test('ten passkeys at most per account', async () => {
    const { browser } = await createLocalAccount(lab, 'bruno');
    const key = new SoftAuthenticator({ origin: lab.url });
    for (let i = 0; i < 10; i++) assert.equal((await addPasskey(browser, key)).status, 200, `passkey ${i + 1}`);
    const eleventh = await addPasskey(browser, key);
    assert.equal(eleventh.status, 409);
    assert.equal(eleventh.body.code, 'accounts.too_many_passkeys');
    assert.equal(eleventh.body.params.max, 10);
  });
});

describe('the browsers of local accounts become known, whatever way they signed in', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ publicHost: 'localhost', env: { TRUSTED_PROXIES: '127.0.0.1' } }); });
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
    assert.equal(carol.body.redirect, '/');
  });

  test('sign-up and one-click passkey sign-in leave the known-browser cookie, as a password does', async () => {
    const { token } = await invite(lab);
    const browser = new TestBrowser();
    assert.equal((await signUp(lab, token, { username: 'dina' }, browser)).status, 200);
    assert.ok(deviceCookie(browser), 'after sign-up');

    const key = new SoftAuthenticator({ origin: lab.url });
    const reg = await call(lab, browser, 'POST', '/api/accounts/me/passkeys/options', {});
    assert.equal((await call(lab, browser, 'POST', '/api/accounts/me/passkeys', { response: key.register(reg.body.options) })).status, 200);
    const other = new TestBrowser();
    const options = await call(lab, other, 'POST', '/auth/passkey/options', {});
    assert.equal((await call(lab, other, 'POST', '/auth/passkey/verify', { response: key.authenticate(options.body.options) })).status, 200);
    assert.ok(deviceCookie(other), 'after a one-click passkey sign-in');

    // That browser now gets in while strangers keep the name and the global count full
    for (let i = 0; i < 3; i++) await signInFrom(`198.19.0.${i}`, 'dina', 'nope nope nope');
    assert.equal((await signInFrom('198.19.1.1', 'dina', PASSWORD)).status, 429, 'a stranger\'s browser is kept waiting');
    assert.equal((await signInFrom('198.19.1.2', 'dina', PASSWORD, other)).status, 200, 'the known browser is not');
  });
});

describe('passkey requests are limited per address, each budget with its own Retry-After', () => {
  let lab;
  before(async () => { lab = await startAccountsApp({ publicHost: 'localhost' }); });
  after(() => lab.close());

  test('a classroom\'s one-click requests leave the step after a password alone; Retry-After is the minute', async () => {
    const { id } = await createLocalAccount(lab, 'elsa');
    await promote(lab, id);
    let refused = null;
    for (let i = 1; i <= PASSKEY_LIMITS.oneClick + 1 && !refused; i++) {
      const res = await call(lab, new TestBrowser(), 'POST', '/auth/passkey/options', {});
      if (res.status === 429) refused = { at: i, res };
    }
    assert.equal(refused?.at, PASSKEY_LIMITS.oneClick + 1, 'a whole class opening the login page fits');
    assert.equal(refused.res.body.code, 'accounts.throttled');
    assert.equal(refused.res.res.headers.get('retry-after'), '60');

    const browser = new TestBrowser();
    assert.deepEqual((await localSignIn(lab, browser, 'elsa')).body, { step: 'passkey-enrol' });
    const step = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal(step.status, 200, 'the step has its own budget');
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
