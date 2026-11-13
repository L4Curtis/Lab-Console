/**
 * The SSO settings page's API (SPEC, lot accounts): saved, applied without
 * a restart, the secret never given back, the environment's lock, the
 * guarded discovery test, the trial sign-in that opens no session, role
 * overrides and disabled SSO accounts at sign-in
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startMockOidc } from '../dev/mock-oidc.js';
import { signInWithOidc } from './helpers/browser.js';
import { startAccountsApp, call } from './helpers/accounts.js';

const SECRET = 'mock-secret';
const mockSettings = (idp, extra = {}) => ({
  enabled: true, providerName: 'Mock SSO', issuer: idp.issuer, clientId: 'lab-console', clientSecret: SECRET,
  scopes: 'openid profile email groups', groupsClaim: 'groups', adminGroups: 'admins', allowedGroups: '', ...extra,
});
const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()) : []);
const dataText = async (lab) => {
  await lab.deps.store.flush();
  return filesUnder(lab.dataDir).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
};

/** A small HTTP server answering `handler`; → { url, host, close() } */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    });
  });
}

describe('SSO settings: saved, applied at once, the secret write-only', () => {
  let idp;
  let lab;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startAccountsApp({ env: { APP_SECRET: 'x'.repeat(40) } });
  });
  after(async () => { await lab.close(); await idp.close(); });

  test('nothing configured yet: the page shows the callback URL to give the provider', async () => {
    const res = await call(lab, 'admin', 'GET', '/api/accounts/sso');
    assert.equal(res.status, 200);
    assert.equal(res.body.locked, false);
    assert.equal(res.body.source, 'none');
    assert.equal(res.body.settings.enabled, false);
    assert.equal(res.body.callbackUrl, `${lab.url}/auth/callback`);
    assert.equal(res.body.encrypted, true);
    const start = await fetch(`${lab.url}/auth/login`, { redirect: 'manual' });
    assert.equal(start.headers.get('location'), '/login?error=sso_disabled', 'no provider: no redirect to one');
  });

  test('saved, then a sign-in through the provider works without a restart', async () => {
    const saved = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.settings.enabled, true);
    assert.equal(saved.body.settings.hasClientSecret, true);
    assert.equal(saved.body.source, 'saved');
    assert.ok(!JSON.stringify(saved.body).includes(SECRET), 'never the secret');
    assert.deepEqual((await call(lab, null, 'GET', '/auth/me')).body.providerName, 'Mock SSO');

    const { landed, browser } = await signInWithOidc(lab, 'admin');
    assert.equal(new URL(landed).pathname, '/');
    const me = await call(lab, browser, 'GET', '/api/accounts/me');
    assert.equal(me.body.account.id, 'oidc:mock-admin');
    assert.equal(me.body.account.role, 'admin', 'admin through the admins group');
  });

  test('saved in the database (a file of mode 600), the secret encrypted under APP_SECRET; no answer or audit entry carries it', async () => {
    assert.equal(fs.statSync(path.join(lab.dataDir, 'lab-console.db')).mode & 0o777, 0o600);
    const saved = (await lab.deps.repos.settings.get('sso')).values;
    assert.equal(saved.clientSecret.alg, 'aes-256-gcm');
    assert.equal(saved.settings.issuer, idp.issuer);
    assert.ok(!(await dataText(lab)).includes(SECRET), 'nowhere in the data directory, audit trail included');
    assert.ok(!JSON.stringify((await call(lab, 'admin', 'GET', '/api/accounts/sso')).body).includes(SECRET));
  });

  test('an empty secret keeps the current one; a public client clears it', async () => {
    const kept = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { clientSecret: '', providerName: 'Renamed' }));
    assert.equal(kept.body.settings.hasClientSecret, true);
    assert.equal(kept.body.settings.providerName, 'Renamed');
    assert.equal(new URL((await signInWithOidc(lab, 'student1')).landed).pathname, '/', 'still signs in: the secret was kept');

    const pub = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { clientId: 'lab-console-public', clientSecret: '', clearClientSecret: true }));
    assert.equal(pub.body.settings.hasClientSecret, false);
    assert.equal(new URL((await signInWithOidc(lab, 'student2')).landed).pathname, '/', 'a public client (PKCE only)');
  });

  test('switched off: the button goes, the settings stay', async () => {
    const off = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { enabled: false, clientId: 'lab-console', clientSecret: SECRET }));
    assert.equal(off.body.settings.enabled, false);
    assert.equal(off.body.settings.issuer, idp.issuer);
    assert.equal((await call(lab, null, 'GET', '/auth/me')).body.providerName, null);
    const res = await fetch(`${lab.url}/auth/login`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/login?error=sso_disabled');
    assert.equal((await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp))).status, 200);
  });

  test('invalid settings are refused field by field', async () => {
    const res = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { issuer: 'http://id.example.org', clientId: '', scopes: 'profile email', groupsClaim: 'a b' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'accounts.sso_invalid');
    assert.deepEqual(res.body.params.problems.map((p) => p.code).sort(), ['client_id_required', 'groups_claim_invalid', 'issuer_insecure', 'scopes_openid']);
    assert.equal((await call(lab, 'admin', 'GET', '/api/accounts/sso')).body.settings.issuer, idp.issuer, 'nothing changed');
    assert.equal((await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { issuer: 'https://id.example.org?x=1' }))).body.params.problems[0].code, 'issuer_invalid');
  });

  test('the saved secret never follows a change of issuer or client id: a new one is required', async () => {
    const other = await startMockOidc({ port: 0 });
    try {
      assert.equal((await call(lab, 'admin', 'GET', '/api/accounts/sso')).body.settings.hasClientSecret, true);
      for (const change of [{ issuer: other.issuer }, { clientId: 'another-client' }]) {
        const res = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { ...change, clientSecret: '' }));
        assert.equal(res.status, 400, JSON.stringify(change));
        assert.equal(res.body.code, 'accounts.sso_invalid');
        assert.deepEqual(res.body.params.problems, [{ field: 'clientSecret', code: 'secret_required' }]);
      }
      const now = (await call(lab, 'admin', 'GET', '/api/accounts/sso')).body.settings;
      assert.deepEqual([now.issuer, now.clientId], [idp.issuer, 'lab-console'], 'nothing changed');

      // Nor through the sign-in module directly
      assert.throws(() => lab.deps.auth.oidc.configure({ ...lab.deps.auth.oidc.settings, issuer: other.issuer, enabled: true }), /needs its own secret/);
      assert.equal(lab.deps.auth.oidc.settings.issuer, idp.issuer);

      // With its own secret, or as a public client, the change goes through
      const moved = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { issuer: other.issuer, clientSecret: 'other-secret' }));
      assert.equal(moved.status, 200);
      assert.equal(moved.body.settings.hasClientSecret, true);
      const pub = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { clientSecret: '', clearClientSecret: true }));
      assert.equal(pub.status, 200);
      assert.equal(pub.body.settings.hasClientSecret, false);
    } finally {
      assert.equal((await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp))).status, 200);
      await other.close();
    }
  });

  test('try a sign-in while the provider is switched off: 409 accounts.sso_disabled', async () => {
    assert.equal((await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { enabled: false, clientSecret: '' }))).status, 200);
    const res = await call(lab, 'admin', 'POST', '/api/accounts/sso/trial');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'accounts.sso_disabled');
    assert.ok(!res.res.headers.getSetCookie().some((c) => c.startsWith('lc_login=')), 'no sign-in started');
    assert.equal((await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { clientSecret: '' }))).status, 200);
  });

  test('a role set by an administrator wins over the groups; a disabled SSO account stays out', async () => {
    const { browser } = await signInWithOidc(lab, 'student3');
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).body.account.role, 'student');
    const id = encodeURIComponent('oidc:mock-student3');
    const forced = await call(lab, 'admin', 'PATCH', `/api/accounts/users/${id}`, { role: 'admin' });
    assert.equal(forced.body.account.role, 'admin');
    assert.equal(forced.body.account.roleOverride, 'admin');
    assert.equal(forced.body.sessionsEnded, 1);
    assert.equal((await call(lab, browser, 'GET', '/api/accounts/me')).status, 401, 'signed out at once');
    const again = await signInWithOidc(lab, 'student3');
    assert.equal((await call(lab, again.browser, 'GET', '/api/accounts/me')).body.account.role, 'admin', 'the override wins over the groups');

    // The other way: an admin by group, forced to student
    const ada = await signInWithOidc(lab, 'admin');
    await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent('oidc:mock-admin')}`, { role: 'student' });
    assert.equal((await call(lab, ada.browser, 'GET', '/api/accounts/me')).status, 401);
    const demoted = await signInWithOidc(lab, 'admin');
    assert.equal((await call(lab, demoted.browser, 'GET', '/api/accounts/me')).body.account.role, 'student');
    // Back to the groups
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent('oidc:mock-admin')}`, { role: null })).body.account.role, 'admin');

    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${id}`, { role: null })).status, 200);
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${id}`, { state: 'disabled' })).status, 200);
    const refused = await signInWithOidc(lab, 'student3');
    assert.equal(new URL(refused.landed).pathname + new URL(refused.landed).search, '/login?error=account_disabled');
    assert.equal(refused.browser.cookie(lab.url, lab.deps.auth.cookieName), null);
  });

  test('try a sign-in: the claims and the role come back, no session is opened', async () => {
    const admin = lab.signIn('admin');
    const before = lab.deps.auth.sessions.list().length;
    const start = await call(lab, { cookie: admin.cookie }, 'POST', '/api/accounts/sso/trial');
    assert.equal(start.status, 200);
    assert.ok(start.body.url.startsWith(`${idp.issuer}/authorize`));
    // The login cookie comes with the answer; the browser carries it and the admin's session to the provider and back
    const login = start.res.headers.getSetCookie().find((c) => c.startsWith('lc_login='));
    assert.ok(login);
    const cookie = `${admin.cookie}; ${login.split(';')[0]}`;
    const picker = await (await fetch(start.body.url)).text();
    const req = /\/authorize\/pick\?req=([\w-]+)/.exec(picker)[1];
    const back = await fetch(`${idp.issuer}/authorize/pick?req=${req}&user=student1`, { redirect: 'manual' });
    const callback = await fetch(back.headers.get('location'), { redirect: 'manual', headers: { cookie } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/#/admin/sso');
    assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith(`${lab.deps.auth.cookieName}=`)), 'no session cookie');
    assert.equal(lab.deps.auth.sessions.list().length, before, 'no session for the person who signed in');

    const result = await call(lab, { cookie: admin.cookie }, 'GET', '/api/accounts/sso/trial');
    assert.equal(result.body.result.ok, true);
    assert.equal(result.body.result.username, 'student1');
    assert.equal(result.body.result.role, 'student');
    assert.deepEqual(result.body.result.groups, ['students']);
    assert.equal(result.body.result.idClaims.sub, 'mock-student1');
    assert.equal((await call(lab, { cookie: admin.cookie }, 'GET', '/api/accounts/sso/trial')).body.result, null, 'shown once');
    assert.equal((await lab.deps.audit.query({ action: 'accounts.sso.trial' }))[0].details.username, 'student1');
  });
});

describe('SSO settings set in the environment: the page is read-only', () => {
  let idp;
  let lab;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startAccountsApp({ env: { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'lab-console', OIDC_CLIENT_SECRET: SECRET, OIDC_PROVIDER_NAME: 'Env SSO' } });
  });
  after(async () => { await lab.close(); await idp.close(); });

  test('locked: shown without the secret, saving refused, nothing written', async () => {
    const res = await call(lab, 'admin', 'GET', '/api/accounts/sso');
    assert.equal(res.body.locked, true);
    assert.equal(res.body.source, 'environment');
    assert.equal(res.body.settings.issuer, idp.issuer);
    assert.equal(res.body.settings.hasClientSecret, true);
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
    const put = await call(lab, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp, { providerName: 'Other' }));
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'accounts.sso_locked');
    assert.equal(await lab.deps.repos.settings.get('sso'), undefined, 'nothing saved');
    assert.equal((await call(lab, null, 'GET', '/auth/me')).body.providerName, 'Env SSO');
  });

  test('a file saved by a version without the database is imported, and ignored while the environment names a provider', async () => {
    fs.mkdirSync(path.join(lab.dataDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(lab.dataDir, 'auth', 'oidc.json'), JSON.stringify({ version: 1, settings: { issuer: 'https://elsewhere.example', clientId: 'x', enabled: true }, clientSecret: '' }), { mode: 0o600 });
    const restarted = await startAccountsApp({ env: { DATA_DIR: lab.dataDir, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'lab-console', OIDC_CLIENT_SECRET: SECRET } });
    try {
      assert.equal((await call(restarted, 'admin', 'GET', '/api/accounts/sso')).body.settings.issuer, idp.issuer);
      assert.equal((await restarted.deps.repos.settings.get('sso')).values.settings.issuer, 'https://elsewhere.example', 'imported all the same');
      assert.ok(fs.existsSync(path.join(lab.dataDir, 'auth', 'oidc.json.imported')));
    } finally {
      await restarted.close();
    }
  });
});

describe('SSO settings survive a restart', () => {
  test('saved by one instance, applied by the next one at start-up; a secret without its APP_SECRET is flagged', async () => {
    const idp = await startMockOidc({ port: 0 });
    const first = await startAccountsApp({ env: { APP_SECRET: 'k'.repeat(40) } });
    try {
      assert.equal((await call(first, 'admin', 'PUT', '/api/accounts/sso', mockSettings(idp))).status, 200);
      await first.deps.store.flush();
      const second = await startAccountsApp({ env: { DATA_DIR: first.dataDir, APP_SECRET: 'k'.repeat(40) } });
      try {
        const described = (await call(second, 'admin', 'GET', '/api/accounts/sso')).body;
        assert.equal(described.settings.issuer, idp.issuer);
        assert.equal(described.settings.hasClientSecret, true);
        assert.equal(described.secretUnreadable, false);
        assert.equal(new URL((await signInWithOidc(second, 'student1')).landed).pathname, '/');
      } finally {
        await second.close();
      }
      const wrongKey = await startAccountsApp({ env: { DATA_DIR: first.dataDir, APP_SECRET: 'z'.repeat(40) } });
      try {
        const described = (await call(wrongKey, 'admin', 'GET', '/api/accounts/sso')).body;
        assert.equal(described.secretUnreadable, true);
        assert.equal(described.settings.hasClientSecret, false);
      } finally {
        await wrongKey.close();
      }
    } finally {
      await first.close();
      await idp.close();
    }
  });
});

describe('SSO discovery test: guarded against server-side request forgery', () => {
  let idp;
  let lab;
  const servers = [];
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startAccountsApp({ fetchOptions: { timeoutMs: 300 } });
  });
  after(async () => {
    await lab.close();
    await idp.close();
    await Promise.all(servers.map((s) => s.close()));
  });
  const test_ = (body) => call(lab, 'admin', 'POST', '/api/accounts/sso/test', body);

  test('the mock provider: found, the issuer matches, the endpoints are listed', async () => {
    const res = await test_({ issuer: idp.issuer });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.issuerMatches, true);
    assert.equal(res.body.endpoints.token, `${idp.issuer}/token`);
    assert.equal(res.body.pkce, true);
  });

  test('https only, unless loopback or the insecure flag', async () => {
    assert.equal((await test_({ issuer: 'http://id.example.org' })).body.reason, 'insecure');
    assert.equal((await test_({ issuer: 'ftp://id.example.org' })).body.reason, 'bad_url');
    assert.equal((await test_({ issuer: 'not a url' })).body.reason, 'bad_url');
  });

  test('link-local addresses (the cloud metadata service) are never contacted', async () => {
    assert.equal((await test_({ issuer: 'http://169.254.169.254', allowInsecure: true })).body.reason, 'forbidden_address');
    assert.equal((await test_({ issuer: 'http://[fe80::1]', allowInsecure: true })).body.reason, 'forbidden_address');
    assert.equal((await test_({ issuer: 'http://0.0.0.0', allowInsecure: true })).body.reason, 'forbidden_address');
  });

  test('no redirect to an internal address', async () => {
    const internal = await serve((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"issuer":"internal"}'); });
    servers.push(internal);
    // The issuer's host is "localhost"; the redirect leads to another host name, on the loopback network
    const redirecting = await serve((_req, res) => { res.statusCode = 302; res.setHeader('location', `${internal.url}/.well-known/openid-configuration`); res.end(); });
    servers.push(redirecting);
    const res = await test_({ issuer: `http://localhost:${redirecting.port}` });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, 'internal_address');
  });

  test('a deadline and a size limit', async () => {
    const silent = await serve(() => { /* never answers */ });
    servers.push(silent);
    assert.equal((await test_({ issuer: silent.url })).body.reason, 'timeout');
    const huge = await serve((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(`{"issuer":"${'x'.repeat(300 * 1024)}"}`); });
    servers.push(huge);
    assert.equal((await test_({ issuer: huge.url })).body.reason, 'too_large');
    const notJson = await serve((_req, res) => res.end('<html>hello</html>'));
    servers.push(notJson);
    assert.equal((await test_({ issuer: notJson.url })).body.reason, 'not_discovery');
    const missing = await serve((_req, res) => { res.statusCode = 404; res.end(); });
    servers.push(missing);
    const res = await test_({ issuer: missing.url });
    assert.deepEqual([res.body.reason, res.body.status], ['http_status', 404]);
  });

  test('every test is audited, by whom and for which issuer', async () => {
    await lab.deps.store.flush();
    const entries = (await lab.deps.audit.query({ action: 'accounts.sso.test' }));
    assert.ok(entries.length >= 5);
    assert.equal(entries[0].actor.id, 'oidc:admin');
  });
});
