/**
 * OpenID Connect, end to end, against the mock provider (dev/mock-oidc.js):
 * the application, a "browser" that follows the redirects, and a provider
 * that can be told to misbehave. Every refusal the client must make is here:
 * wrong state, wrong nonce, PKCE mismatch, bad signature, replayed callback,
 * a group that is not allowed - plus the admin mapping, groups taken from
 * userinfo or given as one string, a public client, sign-out at the
 * provider, and a provider replaced at run time
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockOidc, DEFAULT_CLIENTS, DEFAULT_USERS } from '../dev/mock-oidc.js';
import { startTestApp, loadTestConfig, repoRoot } from './helpers/app.js';
import { TestBrowser, signInWithOidc } from './helpers/browser.js';

const oidcEnv = (idp, extra = {}) => ({
  OIDC_ISSUER: idp.issuer,
  OIDC_CLIENT_ID: 'lab-console',
  OIDC_CLIENT_SECRET: 'mock-secret',
  OIDC_ADMIN_GROUPS: 'admins',
  OIDC_PROVIDER_NAME: 'Mock SSO',
  ...extra,
});

const me = async (lab, browser) => (await (await browser.fetch(`${lab.url}/auth/me`)).json()).user;

/** Start a sign-in and stop at the provider's callback: → { browser, callback } (the URL the provider sends back) */
async function upToCallback(lab, username) {
  const browser = new TestBrowser();
  const start = await browser.fetch(`${lab.url}/auth/login`);
  await start.arrayBuffer();
  const authorize = new URL(start.headers.get('location'));
  const html = await (await browser.fetch(authorize.href)).text();
  const request = /req=([\w-]+)/.exec(html)[1];
  const pick = await browser.fetch(`${authorize.origin}/authorize/pick?req=${request}&user=${username}`);
  await pick.arrayBuffer();
  return { browser, authorize, callback: new URL(pick.headers.get('location')) };
}

describe('OpenID Connect with a confidential client', () => {
  let idp;
  let lab;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startTestApp({ env: oidcEnv(idp) });
  });
  afterEach(() => idp.misbehave());
  after(async () => { await lab.close(); await idp.close(); });

  test('/auth/me names the provider; the authorization request is code + PKCE S256 + state + nonce', async () => {
    assert.equal((await (await fetch(`${lab.url}/auth/me`)).json()).providerName, 'Mock SSO');
    const browser = new TestBrowser();
    const res = await browser.fetch(`${lab.url}/auth/login?next=%2F%23%2Finfra`);
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location'));
    assert.equal(url.origin + url.pathname, `${idp.issuer}/authorize`);
    const q = url.searchParams;
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), 'lab-console');
    assert.equal(q.get('redirect_uri'), `${lab.url}/auth/callback`);
    assert.equal(q.get('scope'), 'openid profile email groups');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge'), /^[\w-]{43}$/);
    assert.match(q.get('state'), /^[\w-]{20,}$/);
    assert.match(q.get('nonce'), /^[\w-]{20,}$/);
    const [cookie] = res.headers.getSetCookie();
    assert.match(cookie, /^lc_login=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
    assert.ok(!cookie.includes(q.get('state')), 'the browser holds an opaque id, the state stays on the server');
  });

  test('a student signs in and lands where they were heading', async () => {
    const { browser, landed, hops } = await signInWithOidc(lab, 'student1', { next: '/#/infra' });
    assert.equal(landed, `${lab.url}/#/infra`);
    assert.ok(hops.some((h) => h.startsWith(`${lab.url}/auth/callback?`)));
    const user = await me(lab, browser);
    assert.deepEqual({ id: user.id, username: user.username, name: user.name, role: user.role, via: user.via, groups: user.groups },
      { id: 'oidc:mock-student1', username: 'student1', name: 'Alice Martin', role: 'student', via: 'oidc', groups: ['students'] });
    assert.equal(browser.cookie(lab.url, 'lc_login'), null, 'the pending sign-in cookie is gone');
    assert.equal((await browser.fetch(`${lab.url}/api/modules`)).status, 200);
    const [entry] = await lab.deps.audit.query({ action: 'auth.login' });
    assert.equal(entry.actor.id, 'oidc:mock-student1');
    assert.equal(entry.details.method, 'oidc');
  });

  test('admin mapping: a member of OIDC_ADMIN_GROUPS is an administrator', async () => {
    const { browser } = await signInWithOidc(lab, 'admin');
    const user = await me(lab, browser);
    assert.equal(user.role, 'admin');
    assert.deepEqual(user.groups, ['students', 'admins']);
  });

  test('groups only at the userinfo endpoint are found there', async () => {
    idp.misbehave({ groupsInUserinfoOnly: true });
    const { browser } = await signInWithOidc(lab, 'admin');
    const user = await me(lab, browser);
    assert.equal(user.role, 'admin');
    assert.deepEqual(user.groups, ['students', 'admins']);
  });

  test('groups given as one string are split', async () => {
    idp.misbehave({ groupsAsString: true });
    const { browser } = await signInWithOidc(lab, 'admin');
    assert.deepEqual((await me(lab, browser)).groups, ['students', 'admins']);
  });

  test('wrong nonce: refused, no session', async () => {
    idp.misbehave({ wrongNonce: true });
    const { browser, landed } = await signInWithOidc(lab, 'student2');
    assert.equal(landed, `${lab.url}/login?error=sso_failed`);
    assert.equal(await me(lab, browser), null);
    assert.equal(browser.cookie(lab.url, 'lc_sid'), null);
  });

  test('an ID token whose signature does not verify: refused', async () => {
    idp.misbehave({ badSignature: true });
    const { browser, landed } = await signInWithOidc(lab, 'student2');
    assert.equal(landed, `${lab.url}/login?error=sso_failed`);
    assert.equal(await me(lab, browser), null);
  });

  test('wrong state: refused', async () => {
    const { browser, callback } = await upToCallback(lab, 'student2');
    callback.searchParams.set('state', 'forged-state-value-0123456789');
    const res = await browser.fetch(callback.href);
    assert.equal(res.headers.get('location'), '/login?error=sso_failed');
    assert.equal(await me(lab, browser), null);
  });

  test('PKCE mismatch: a code obtained by someone else, injected into this browser\'s sign-in, is refused', async () => {
    const victim = await upToCallback(lab, 'student2');
    const attacker = await upToCallback(lab, 'admin');
    // The victim's own state (so the state check passes) with the attacker's code
    const injected = new URL(victim.callback);
    injected.searchParams.set('code', attacker.callback.searchParams.get('code'));
    const res = await victim.browser.fetch(injected.href);
    assert.equal(res.headers.get('location'), '/login?error=sso_failed');
    assert.equal(await me(lab, victim.browser), null);
  });

  test('a callback without the browser that started it, or replayed, finds nothing', async () => {
    const { browser, callback } = await upToCallback(lab, 'student3');
    const stranger = new TestBrowser();
    const res = await stranger.fetch(callback.href);
    assert.equal(res.headers.get('location'), '/login?error=login_expired');

    const ok = await browser.fetch(callback.href);
    assert.equal(ok.headers.get('location'), '/');
    const replay = await browser.fetch(callback.href);
    assert.equal(replay.headers.get('location'), '/login?error=login_expired', 'single use');
  });

  test('the user refuses at the provider: back to the login page', async () => {
    const browser = new TestBrowser();
    const start = await browser.fetch(`${lab.url}/auth/login`);
    const authorize = new URL(start.headers.get('location'));
    const html = await (await browser.fetch(authorize.href)).text();
    const request = /req=([\w-]+)/.exec(html)[1];
    const { url } = await browser.go(`${authorize.origin}/authorize/pick?req=${request}&deny=1`);
    assert.equal(url, `${lab.url}/login?error=sso_failed`);
  });

  test('no open redirect: an absolute or protocol-relative ?next lands on /', async () => {
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      const { landed } = await signInWithOidc(lab, 'student1', { next });
      assert.equal(landed, `${lab.url}/`, next);
    }
  });

  test('sign-out goes through the provider\'s end-session endpoint, then back to /login', async () => {
    const { browser } = await signInWithOidc(lab, 'student1');
    const out = await browser.fetch(`${lab.url}/auth/logout`, { method: 'POST', headers: { origin: lab.url } });
    const { redirect } = await out.json();
    const url = new URL(redirect);
    assert.equal(url.origin + url.pathname, `${idp.issuer}/end-session`);
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), `${lab.url}/login`);
    assert.ok(url.searchParams.get('id_token_hint'));
    assert.equal(await me(lab, browser), null);
    const { url: back } = await browser.go(redirect);
    assert.equal(back, `${lab.url}/login`);
  });

  test('a provider without end-session: sign-out stays local', async () => {
    const { browser } = await signInWithOidc(lab, 'student1');
    idp.misbehave({ noEndSession: true });
    // The discovery document is cached by the client: build a fresh one with the same settings
    lab.deps.auth.oidc.configure({});
    const out = await browser.fetch(`${lab.url}/auth/logout`, { method: 'POST', headers: { origin: lab.url } });
    assert.deepEqual(await out.json(), { redirect: '/login' });
  });

  test('the provider can be replaced at run time; open sessions stay, the secret is never shown', async () => {
    const { browser } = await signInWithOidc(lab, 'student1');
    const other = await startMockOidc({ port: 0, users: [{ sub: 'other-1', username: 'zoe', name: 'Zoé', email: 'z@example.test', groups: ['staff'] }] });
    try {
      const visible = lab.deps.auth.oidc.configure({ issuer: other.issuer, providerName: 'Other', adminGroups: ['staff'] });
      assert.equal(visible.clientSecret, undefined);
      assert.equal(visible.hasClientSecret, true, 'the secret was kept');
      assert.equal(lab.deps.auth.oidc.settings.issuer, other.issuer);
      assert.ok(!JSON.stringify(lab.deps.auth.oidc.settings).includes('mock-secret'));
      assert.equal((await me(lab, browser)).id, 'oidc:mock-student1', 'the open session is untouched');
      assert.equal((await (await fetch(`${lab.url}/auth/me`)).json()).providerName, 'Other');

      const { browser: zoe } = await signInWithOidc(lab, 'zoe');
      const user = await me(lab, zoe);
      assert.equal(user.id, 'oidc:other-1');
      assert.equal(user.role, 'admin');

      assert.throws(() => lab.deps.auth.oidc.configure({ issuer: 'http://id.example.org' }), /must use https/);
      assert.equal(lab.deps.auth.oidc.settings.issuer, other.issuer, 'a refused change changes nothing');
    } finally {
      lab.deps.auth.oidc.configure({ issuer: idp.issuer, providerName: 'Mock SSO', adminGroups: ['admins'] });
      await other.close();
    }
  });

  test('a sign-in started before the provider changed must start again', async () => {
    const { browser, callback } = await upToCallback(lab, 'student1');
    lab.deps.auth.oidc.configure({});
    const res = await browser.fetch(callback.href);
    assert.equal(res.headers.get('location'), '/login?error=login_expired');
  });
});

describe('OpenID Connect: access limited to some groups', () => {
  let idp;
  let lab;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startTestApp({ env: oidcEnv(idp, { OIDC_ALLOWED_GROUPS: 'rt-2026' }) });
  });
  after(async () => { await lab.close(); await idp.close(); });

  test('a user in none of the allowed groups is refused with a clear reason, and audited', async () => {
    const { browser, landed } = await signInWithOidc(lab, 'student1');
    assert.equal(landed, `${lab.url}/login?error=not_allowed`);
    assert.equal(await me(lab, browser), null);
    const [entry] = await lab.deps.audit.query({ action: 'auth.login.failed' });
    assert.equal(entry.details.reason, 'not_allowed');
    assert.equal(entry.details.username, 'student1');
  });

  test('an administrator is never locked out by the allowed list', async () => {
    const { browser } = await signInWithOidc(lab, 'admin');
    assert.equal((await me(lab, browser)).role, 'admin');
  });
});

describe('OpenID Connect with a public client (no secret, PKCE only)', () => {
  let idp;
  let lab;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startTestApp({ env: oidcEnv(idp, { OIDC_CLIENT_ID: 'lab-console-public', OIDC_CLIENT_SECRET: '' }) });
  });
  after(async () => { await lab.close(); await idp.close(); });

  test('signs in', async () => {
    const { browser, landed } = await signInWithOidc(lab, 'student3');
    assert.equal(landed, `${lab.url}/`);
    assert.equal((await me(lab, browser)).username, 'student3');
  });
});

describe('OpenID Connect: starting sign-ins is limited per client address', () => {
  let idp;
  let lab;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startTestApp({ env: oidcEnv(idp, { TRUSTED_PROXIES: '127.0.0.1' }) });
  });
  after(async () => { await lab.close(); await idp.close(); });

  const start = async (ip) => {
    const res = await fetch(`${lab.url}/auth/login`, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });
    await res.arrayBuffer();
    return res.headers.get('location');
  };

  test('the 31st start in a minute from one address goes back to the login page; another address is not affected', async () => {
    for (let i = 0; i < 30; i++) assert.ok((await start('198.51.100.7')).startsWith(`${idp.issuer}/authorize?`), `start ${i + 1}`);
    assert.equal(await start('198.51.100.7'), '/login?error=throttled');
    assert.equal(await start('198.51.100.7'), '/login?error=throttled', 'and stays refused');
    assert.ok((await start('198.51.100.8')).startsWith(`${idp.issuer}/authorize?`), 'another address still starts');
  });
});

describe('OpenID Connect: the provider is down', () => {
  let lab;
  before(async () => {
    const idp = await startMockOidc({ port: 0 });
    const issuer = idp.issuer;
    await idp.close();
    lab = await startTestApp({ env: oidcEnv({ issuer }) });
  });
  after(() => lab.close());

  test('the application still starts, says so on the login page, and the local administrator still signs in', async () => {
    const res = await fetch(`${lab.url}/auth/login`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/login?error=provider_unavailable');
    const { postLocalSignIn } = await import('./helpers/browser.js');
    assert.equal((await postLocalSignIn(lab)).status, 200);
  });
});

describe('the mock provider cannot be switched on by accident', () => {
  test('it refuses NODE_ENV=production and any interface but loopback', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(startMockOidc({ port: 0 }), /NODE_ENV=production/);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
    await assert.rejects(startMockOidc({ port: 0, host: '0.0.0.0' }), /loopback/);
  });

  test('the token endpoint verifies PKCE, the client and single use', async () => {
    const idp = await startMockOidc({ port: 0 });
    try {
      const token = (form, headers = {}) => fetch(`${idp.issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) });
      const basic = { authorization: `Basic ${Buffer.from('lab-console:mock-secret').toString('base64')}` };
      const wrong = await token({ grant_type: 'authorization_code', code: 'x' }, { authorization: `Basic ${Buffer.from('lab-console:nope').toString('base64')}` });
      assert.equal(wrong.status, 401);
      const unknown = await token({ grant_type: 'authorization_code', code: 'x', redirect_uri: 'http://x/cb' }, basic);
      assert.equal((await unknown.json()).error, 'invalid_grant');
      const discovery = await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json();
      assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
      assert.equal((await (await fetch(`${idp.issuer}/jwks`)).json()).keys[0].alg, 'RS256');
    } finally {
      await idp.close();
    }
  });
});

describe('the pre-production stack signs in through the mock provider', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.preprod.yml'), 'utf8');
  /** The lines of one service, without the comments */
  const service = (name) => {
    const lines = compose.split('\n').filter((l) => !/^\s*#/.test(l));
    const startAt = lines.indexOf(`  ${name}:`);
    assert.notEqual(startAt, -1, `service ${name}`);
    const rest = lines.slice(startAt + 1);
    const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
    return end === -1 ? rest : rest.slice(0, end);
  };
  /** `KEY: value` pairs of a service's environment block */
  const environment = (lines) => {
    const from = lines.indexOf('    environment:');
    const pairs = [];
    for (const line of lines.slice(from + 1)) {
      const m = /^ {6}([A-Z_]+): ?(.*)$/.exec(line);
      if (!m) break;
      pairs.push([m[1], m[2].replace(/^"(.*)"$/, '$1')]);
    }
    return Object.fromEntries(pairs);
  };
  const issuer = 'http://192.0.2.250:9100';
  const expand = (value) => value.replace(/\$\{MOCK_OIDC_ISSUER:\?[^}]*\}/g, issuer);

  test('the mock runs from dev/, outside the production image, never under NODE_ENV=production', () => {
    const mock = service('mock-oidc');
    assert.ok(mock.includes('      - ./dev/mock-oidc.js:/mock/mock-oidc.js:ro'), 'the file is mounted read-only');
    assert.ok(fs.existsSync(path.join(repoRoot, 'dev', 'mock-oidc.js')));
    assert.equal(environment(mock).NODE_ENV, 'development');
    const command = mock.slice(mock.indexOf('    command:') + 1).map((l) => /^ {6}- (.*)$/.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(command.slice(0, 2), ['node', '/mock/mock-oidc.js']);
    assert.ok(command.includes('--expose'));
    assert.equal(expand(command[command.indexOf('--issuer') + 1]), issuer);
    assert.match(fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8'), /^dev$/m, 'the production image still has no dev/');
  });

  test('what it gives Lab Console is a valid configuration for the mock\'s own client and groups', async () => {
    const env = Object.fromEntries(Object.entries(environment(service('lab-console'))).map(([k, v]) => [k, expand(v)]));
    assert.equal(env.OIDC_ISSUER, issuer);
    assert.equal(DEFAULT_CLIENTS[env.OIDC_CLIENT_ID]?.secret, env.OIDC_CLIENT_SECRET);
    assert.ok(DEFAULT_USERS.some((u) => u.groups.includes(env.OIDC_ADMIN_GROUPS)), 'one mock user is an administrator');
    const config = await loadTestConfig(env);
    assert.equal(config.auth.oidc.enabled, true);
    assert.equal(config.auth.oidc.issuer, issuer);
  });

  test('--issuer: the mock announces the address browsers use, whatever it listens on', async () => {
    const idp = await startMockOidc({ port: 0, issuer: `${issuer}/` });
    try {
      assert.equal(idp.issuer, issuer);
      const discovery = await (await fetch(`http://127.0.0.1:${idp.port}/.well-known/openid-configuration`)).json();
      assert.equal(discovery.issuer, issuer);
      assert.ok(discovery.authorization_endpoint.startsWith(`${issuer}/`));
      assert.ok(discovery.token_endpoint.startsWith(`${issuer}/`));
    } finally {
      await idp.close();
    }
  });
});
