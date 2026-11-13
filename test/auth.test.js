/**
 * The sign-in module in the real application: the service surface of
 * ARCHITECTURE §5, the local administrator's form (success and every
 * refusal, replay, throttling), cookies over http and https, sign-out, the
 * login page, and what happens to live connections when a session is
 * revoked or expires
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import express from 'express';
import { createAuth, requireAuth, requireRole, createUser, hasRole, ROLES } from '../src/modules/auth/index.js';
import { startTestApp, loadTestConfig, adminCode, silentLogger } from './helpers/app.js';
import fs from 'node:fs';
import { student, admin, fakeRequest, fakeResponse } from './helpers/fakes.js';
import { TestBrowser, postLocalSignIn } from './helpers/browser.js';
import { createStore } from '../src/lib/store.js';
import { tempDataDir } from './helpers/app.js';

const through = (middleware, req) => {
  const res = fakeResponse();
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, res };
};

const clock = () => {
  const c = { ms: Date.now(), now: () => c.ms, advance: (delta) => { c.ms += delta; } };
  return c;
};

/** A module that keeps its WebSocket open, to watch what ending a session does to it */
function keepOpenModule() {
  const wss = new WebSocketServer({ noServer: true });
  const router = express.Router();
  router.get('/whoami', (req, res) => res.json({ user: req.user.id, session: req.sessionId }));
  return {
    id: 'probe', title: 'Probe', enabled: true, router,
    upgrade(req, socket, head) {
      if (!req.url.startsWith('/ws/probe')) return false;
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ user: req.user.id })));
      return true;
    },
    shutdown() { for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}

function connect(lab, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(lab.wsUrl + path, { headers: { origin: lab.url, ...headers } });
    ws.once('message', (raw) => resolve({ ws, hello: JSON.parse(raw.toString()) }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.on('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err); });
  });
}
const closed = (ws) => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.once('close', resolve); });

/** Resolves when an SSE response's body ends (the server closed the stream) */
async function streamEnds(res, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  const started = Date.now();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return Date.now() - started < timeoutMs;
}

// ── The service surface ─────────────────────────────────────────────────────

describe('service surface (ARCHITECTURE §5)', () => {
  test('createAuth returns what the other modules rely on, and no switch to turn it off', async () => {
    const config = await loadTestConfig();
    const dir = tempDataDir();
    const auth = createAuth({ config, logger: silentLogger(), store: createStore(dir) });
    try {
      for (const name of ['attach', 'requireAuth', 'requireRole', 'authenticateUpgrade', 'shutdown']) assert.equal(typeof auth[name], 'function', name);
      for (const name of ['list', 'revoke', 'revokeUser', 'create']) assert.equal(typeof auth.sessions[name], 'function', name);
      assert.equal(typeof auth.router, 'function');
      assert.equal(typeof auth.accounts.add, 'function');
      assert.deepEqual(auth.accounts.providers, ['env-admin']);
      assert.equal(typeof auth.oidc.configure, 'function');
      assert.equal(auth.mode, undefined, 'there is no mode');
      assert.equal(auth.cookieName, 'lc_sid');
      assert.deepEqual(ROLES, ['student', 'admin']);
      assert.equal(typeof createUser, 'function');
      assert.equal(typeof hasRole, 'function');
    } finally {
      await auth.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('createAuth refuses to exist without a local administrator or a PUBLIC_URL', async (t) => {
    const config = await loadTestConfig();
    const dir = tempDataDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createStore(dir);
    const without = (patch) => ({ ...config, ...patch });
    for (const localAdmin of [undefined, { ...config.auth.localAdmin, username: '' }, { ...config.auth.localAdmin, passwordHash: '' }, { ...config.auth.localAdmin, totpSecret: '' }]) {
      assert.throws(() => createAuth({ config: without({ auth: { ...config.auth, localAdmin } }), store }), /local administrator is not configured/);
    }
    assert.throws(() => createAuth({ config: without({ server: { ...config.server, publicUrl: '' } }), store }), /PUBLIC_URL is required/);
  });

  test('requireAuth: next() with a user; 401 JSON under /api and for writes; 302 /login for pages, with the way back', () => {
    assert.equal(through(requireAuth, fakeRequest({ user: student(1) })).passed, true);
    const api = through(requireAuth, fakeRequest({ url: '/api/benches' })).res;
    assert.equal(api.statusCode, 401);
    assert.deepEqual(api.body, { error: 'Sign in to continue', code: 'auth.required', params: {} });
    assert.equal(through(requireAuth, fakeRequest({ method: 'POST', url: '/somewhere' })).res.statusCode, 401);
    const page = through(requireAuth, fakeRequest({ url: '/' })).res;
    assert.equal(page.redirectedTo, '/login');
    assert.equal(through(requireAuth, fakeRequest({ url: '/index.html?x=1' })).res.redirectedTo, '/login?next=%2Findex.html%3Fx%3D1');
    assert.equal(through(requireAuth, fakeRequest({ url: '//evil.example/x' })).res.redirectedTo, '/login');
  });

  test('requireRole: 401 without a user, 403 below the role, next() at or above it', () => {
    assert.equal(through(requireRole('admin'), fakeRequest()).res.statusCode, 401);
    const denied = through(requireRole('admin'), fakeRequest({ user: student(1) })).res;
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.body, { error: 'You are not allowed to do this', code: 'auth.forbidden', params: { role: 'admin' } });
    assert.equal(through(requireRole('admin'), fakeRequest({ user: admin() })).passed, true);
    assert.equal(through(requireRole('student'), fakeRequest({ user: admin() })).passed, true);
  });
});

// ── The local administrator ─────────────────────────────────────────────────

describe('local administrator sign-in', () => {
  let lab;
  const c = clock();
  let ipCounter = 0;
  /** Every test signs in from its own address (through the trusted proxy), and starts after the throttle windows */
  const freshStart = () => {
    c.advance(30 * 60_000);
    ipCounter += 1;
    return `203.0.113.${ipCounter}`;
  };
  const post = (fields, browser) => postLocalSignIn(lab, { code: adminCode(c.ms), ...fields }, browser);

  before(async () => { lab = await startTestApp({ env: { TRUSTED_PROXIES: '127.0.0.1' }, now: c.now }); });
  after(() => lab.close());

  test('user name + password + code: a session, its cookie, and the user', async () => {
    const ip = freshStart();
    const browser = new TestBrowser();
    const res = await post({ ip }, browser);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { redirect: '/' });
    const [cookie] = res.headers.getSetCookie();
    assert.match(cookie, /^lc_sid=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);

    const me = await (await browser.fetch(`${lab.url}/auth/me`)).json();
    assert.equal(me.user.id, 'local:root');
    assert.equal(me.user.role, 'admin');
    assert.equal(me.user.via, 'local');
    assert.equal((await browser.fetch(`${lab.url}/api/modules`)).status, 200);

    const [entry] = await lab.deps.audit.query({ action: 'auth.login' });
    assert.equal(entry.actor.id, 'local:root');
    assert.equal(entry.ip, ip, 'the audit trail has the real client address');
    assert.equal(entry.details.method, 'local');
  });

  test('the way back: a path on this site, never another site', async () => {
    freshStart();
    for (const [next, expected] of [['/#/infra', '/#/infra'], ['//evil.example', '/'], ['https://evil.example/', '/'], ['/\\evil.example', '/']]) {
      c.advance(31_000); // a new code each time
      const res = await post({ ip: `198.51.100.${expected.length}${next.length}`, next });
      assert.equal(res.status, 200, next);
      assert.deepEqual(await res.json(), { redirect: expected }, next);
    }
  });

  test('a wrong password, a wrong code, an unknown user or a missing field: one and the same refusal', async () => {
    const bodies = [];
    for (const fields of [
      { password: 'not-the-password' },
      { code: '000000' },
      { username: 'nobody' },
      { username: 'ROOT' },
      { code: '' },
      { password: null },
    ]) {
      const ip = freshStart();
      const res = await post({ ip, ...fields });
      assert.equal(res.status, 401, JSON.stringify(fields));
      assert.equal(res.headers.getSetCookie().length, 0, 'no cookie');
      bodies.push(await res.text());
    }
    assert.equal(new Set(bodies).size, 1, 'byte-identical answers');
    assert.deepEqual(JSON.parse(bodies[0]), { error: 'Sign-in failed. Check the user name, the password and the code', code: 'auth.invalid_credentials', params: {} });
    const failures = await lab.deps.audit.query({ action: 'auth.login.failed' });
    assert.ok(failures.length >= 6);
    assert.ok(failures.every((e) => !JSON.stringify(e).includes('not-the-password')), 'the audit trail never holds a typed password');
  });

  test('an unknown user name takes as long as the real one (the password is always hashed)', async () => {
    const time = async (username) => {
      const ip = freshStart();
      const started = process.hrtime.bigint();
      await (await post({ ip, username, password: 'wrong-password-123' })).arrayBuffer();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const known = [];
    const unknown = [];
    for (let i = 0; i < 3; i++) { known.push(await time('root')); unknown.push(await time(`ghost${i}`)); }
    const median = (xs) => xs.sort((a, b) => a - b)[1];
    // The scrypt derivation dominates: an early exit for unknown names would be several times faster
    assert.ok(median(unknown) > median(known) * 0.5, `known ${median(known)} ms, unknown ${median(unknown)} ms`);
  });

  test('a code that was accepted cannot be used again; the next one works', async () => {
    freshStart();
    const code = adminCode(c.ms);
    const first = await post({ ip: '192.0.2.10', code });
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const replay = await post({ ip: '192.0.2.11', code });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).code, 'auth.invalid_credentials');
    c.advance(30_000);
    const nextCode = await post({ ip: '192.0.2.12', code: adminCode(c.ms) });
    assert.equal(nextCode.status, 200);
    await nextCode.arrayBuffer();
  });

  test('throttling per client: the sixth attempt in 15 minutes is refused, with Retry-After', async () => {
    const ip = freshStart();
    for (let i = 0; i < 5; i++) {
      const res = await post({ ip, username: `guess${ipCounter}-${i}`, password: 'nope-nope-nope' });
      assert.equal(res.status, 401);
      await res.arrayBuffer();
    }
    const refused = await post({ ip }); // even with the right credentials
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '900');
    assert.deepEqual(await refused.json(), { error: 'Too many sign-in attempts. Try again later', code: 'auth.throttled', params: { seconds: 900 } });
    const other = await post({ ip: `${ip}0` });
    assert.equal(other.status, 200, 'another client is not affected');
    await other.arrayBuffer();
  });

  test('throttling per user name: failures from many addresses slow the next attempt down', async () => {
    freshStart();
    for (const ip of ['192.0.2.21', '192.0.2.22']) {
      const res = await post({ ip, password: 'wrong-wrong-wrong' });
      assert.equal(res.status, 401);
      await res.arrayBuffer();
    }
    const slowed = await post({ ip: '192.0.2.23' });
    assert.equal(slowed.status, 429, 'a third address meets the backoff too');
    assert.equal(slowed.headers.get('retry-after'), '1');
    await slowed.arrayBuffer();
    c.advance(1000);
    const ok = await post({ ip: '192.0.2.24' });
    assert.equal(ok.status, 200);
    await ok.arrayBuffer();
  });

  test('the client address comes from the trusted proxy only', async () => {
    freshStart();
    // The application trusts 127.0.0.1: the address it forwards is the client
    const res = await post({ ip: '6.6.6.6, 203.0.113.250' });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const [entry] = await lab.deps.audit.query({ action: 'auth.login' });
    assert.equal(entry.ip, '203.0.113.250');
  });

  test('the form must come from this site, as JSON of a sane size', async () => {
    freshStart();
    const send = (headers, body) => fetch(`${lab.url}/auth/local`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.99', ...headers }, body });
    const foreign = await send({ origin: 'https://evil.example' }, '{}');
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).code, 'server.cross_origin');
    assert.equal((await send({}, '{}')).status, 403, 'no Origin header: refused');
    const malformed = await send({ origin: lab.url }, '{"username":');
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid request', code: 'server.bad_request', params: {} });
    const huge = await send({ origin: lab.url }, JSON.stringify({ password: 'x'.repeat(10_000) }));
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).code, 'server.too_large');
  });

  test('a stranger keeping the name backed off and the global count full does not keep the administrator out of a known browser', async () => {
    freshStart();
    const mine = new TestBrowser();
    const first = await post({ ip: '192.0.2.50' }, mine);
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const deviceCookie = first.headers.getSetCookie().find((line) => line.startsWith('lc_device='));
    assert.match(deviceCookie, /^lc_device=[\w-]{71}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000$/);

    // The attack: wrong guesses on the administrator's name as soon as its
    // backoff allows, then random names from many addresses up to fifty failures
    let attacker = 0;
    const guess = async (username) => {
      attacker += 1;
      const res = await post({ ip: `198.18.${attacker >> 4}.${attacker & 15}`, username, password: 'guess-guess-guess' });
      await res.arrayBuffer();
      return res.status;
    };
    for (let i = 0; i < 6; i++) {
      assert.equal(await guess('root'), 401);
      c.advance(2 ** Math.max(0, i - 1) * 1000);
    }
    for (let i = 0; i < 44; i++) assert.equal(await guess(`name${i}`), 401, `guess ${i}`); // fifty failures in all
    assert.equal(await guess('someone-else'), 429, 'the global count is full');
    assert.equal(await guess('root'), 429, 'and the name is backed off');

    c.advance(31_000); // a new code
    const stranger = await post({ ip: '192.0.2.51' });
    assert.equal(stranger.status, 429, 'a browser that never signed in meets them');
    await stranger.arrayBuffer();
    const back = await post({ ip: '192.0.2.52' }, mine);
    assert.equal(back.status, 200, 'the known browser gets in, from any address');
    await back.arrayBuffer();
    const [entry] = await lab.deps.audit.query({ action: 'auth.login' });
    assert.equal(entry.action, 'auth.login');
    assert.equal(entry.details.knownBrowser, true);

    // The cookie only counts for its own name, and is limited on its own
    const other = await postLocalSignIn(lab, { username: 'someone', password: 'x-x-x-x-x-x', code: adminCode(c.ms), ip: '192.0.2.53' }, mine);
    assert.equal(other.status, 429, 'for another name the browser is a stranger');
    await other.arrayBuffer();
    for (let i = 0; i < 2; i++) {
      const wrong = await post({ ip: '192.0.2.54', password: 'not-the-password' }, mine);
      assert.equal(wrong.status, 401);
      await wrong.arrayBuffer();
    }
    const slowed = await post({ ip: '192.0.2.54', password: 'not-the-password' }, mine);
    assert.equal(slowed.status, 429, 'its own backoff');
    assert.equal(slowed.headers.get('retry-after'), '1');
    await slowed.arrayBuffer();
  });

  test('refusals anyone can send for free write a bounded number of audit entries', async () => {
    freshStart();
    const count = async (ip) => (await lab.deps.audit.query({ action: 'auth.login', limit: 5000 })).filter((e) => e.ip === ip).length;
    const ip = '192.0.2.60';
    for (let i = 0; i < 5; i++) await (await post({ ip, username: `x${i}`, password: 'nope-nope-nope' })).arrayBuffer();
    assert.equal(await count(ip), 5, 'attempts that were checked: one entry each');
    for (let i = 0; i < 200; i++) {
      const res = await post({ ip });
      assert.equal(res.status, 429);
      await res.arrayBuffer();
    }
    assert.equal(await count(ip), 6, 'two hundred throttled posts: one entry');

    // Callbacks that match no sign-in in progress: limited per address, audited once per kind
    const other = '192.0.2.61';
    const statuses = [];
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${lab.url}/auth/callback?code=x&state=y`, { redirect: 'manual', headers: { 'x-forwarded-for': other } });
      statuses.push(res.headers.get('location'));
    }
    assert.deepEqual(statuses.slice(0, 60), Array(60).fill('/login?error=login_expired'));
    assert.deepEqual(statuses.slice(60), Array(40).fill('/login?error=throttled'), 'at most 60 a minute from one address');
    const fresh = await fetch(`${lab.url}/auth/callback`, { redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.62' } });
    assert.equal(fresh.headers.get('location'), '/login?error=login_expired', 'another address is not affected');
    assert.equal(await count(other), 2, 'one "no pending sign-in" entry, one "throttled" entry');

    // When the window is over, what was left out is summed up in one entry
    c.advance(15 * 60_000);
    await (await fetch(`${lab.url}/auth/callback`, { redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.63' } })).arrayBuffer();
    const [summary] = await lab.deps.audit.query({ action: 'auth.login.suppressed' });
    assert.equal(summary.actor.id, 'system');
    assert.ok(summary.details.count >= 199 + 98, JSON.stringify(summary.details));
    assert.ok(summary.details.top.some((t) => t.ip === ip && t.count >= 199));
  });
});

// ── Replacing the administrator's credentials ───────────────────────────────

describe('replacing the local administrator\'s credentials ends its sessions', () => {
  test('after a restart with a new password, code or name, the old session is gone; with the same ones it stays', async () => {
    const { createApp } = await import('../src/server.js');
    const { hashPassword } = await import('../src/modules/auth/password.js');
    const { generateSecret } = await import('../src/modules/auth/totp.js');
    const dataDir = tempDataDir();
    const boot = async (env = {}) => {
      const app = createApp({ config: await loadTestConfig({ PUBLIC_URL: 'http://127.0.0.1:1', ...env }, dataDir), logger: silentLogger });
      const { port } = await app.listen({ port: 0 });
      return { app, url: `http://127.0.0.1:${port}` };
    };
    const status = async ({ url }, cookie) => (await fetch(`${url}/api/modules`, { headers: { cookie } })).status;
    try {
      let run = await boot();
      const res = await postLocalSignIn({ url: run.url });
      assert.equal(res.status, 200);
      const cookie = res.headers.getSetCookie()[0].split(';')[0];
      const other = run.app.deps.auth.sessions.create(student(1), {}).cookie;
      await run.app.close();

      run = await boot();
      assert.equal(await status(run, cookie), 200, 'same credentials: still signed in after a restart');
      await run.app.close();

      const otherHash = await hashPassword('another-long-password', { N: 16384, r: 8, p: 1 });
      for (const change of [{ LOCAL_ADMIN_TOTP_SECRET: generateSecret() }, { LOCAL_ADMIN_PASSWORD_HASH: otherHash }, { LOCAL_ADMIN_USERNAME: 'newadmin' }]) {
        run = await boot(change);
        assert.equal(await status(run, cookie), 401, Object.keys(change)[0]);
        assert.equal(await status(run, other), 200, 'other people stay signed in');
        await run.app.close();
      }
      run = await boot();
      assert.equal(await status(run, cookie), 401, 'and it does not come back with the old credentials');
      await run.app.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a stranger keeping the name backed off after a rotation does not keep the administrator out of a browser it signed in from before', async () => {
    const { createApp } = await import('../src/server.js');
    const { hashPassword } = await import('../src/modules/auth/password.js');
    const { generateSecret, base32Decode, totp } = await import('../src/modules/auth/totp.js');
    const dataDir = tempDataDir();
    const c = clock();
    const boot = async (env = {}) => {
      const config = await loadTestConfig({ PUBLIC_URL: 'http://127.0.0.1:1', TRUSTED_PROXIES: '127.0.0.1', ...env }, dataDir);
      const app = createApp({ config, logger: silentLogger, createAuth: (deps) => createAuth({ ...deps, now: c.now }) });
      const { port } = await app.listen({ port: 0 });
      return { app, url: `http://127.0.0.1:${port}` };
    };
    /** A browser whose cookies are given by hand: the port changes at every restart */
    const browserWith = (cookie) => ({ fetch: (url, { headers = {}, ...options }) => fetch(url, { ...options, headers: { ...headers, ...(cookie ? { cookie } : {}) } }) });
    let run;
    try {
      run = await boot();
      const first = await postLocalSignIn(run, { ip: '192.0.2.70', code: adminCode(c.ms) });
      assert.equal(first.status, 200);
      await first.arrayBuffer();
      const set = first.headers.getSetCookie();
      const session = set.find((line) => line.startsWith('lc_sid=')).split(';')[0];
      const device = set.find((line) => line.startsWith('lc_device=')).split(';')[0];
      await run.app.close();

      // Suspected compromise: new password, new code, restart
      const password = 'a-brand-new-long-password';
      const secret = generateSecret();
      const code = () => totp(base32Decode(secret), c.ms);
      run = await boot({ LOCAL_ADMIN_PASSWORD_HASH: await hashPassword(password, { N: 16384, r: 8, p: 1 }), LOCAL_ADMIN_TOTP_SECRET: secret });
      c.advance(60_000);
      assert.equal((await fetch(`${run.url}/api/modules`, { headers: { cookie: session } })).status, 401, 'the old session is gone');

      // The attacker keeps the name backed off from many addresses
      let failures = 0;
      for (let i = 0; failures < 10; i++) {
        const res = await postLocalSignIn(run, { ip: `198.19.0.${i + 1}`, password: 'guess-guess-guess', code: '123456' });
        await res.arrayBuffer();
        if (res.status === 401) failures += 1;
        else {
          assert.equal(res.status, 429);
          c.advance(Number(res.headers.get('retry-after')) * 1000);
        }
      }
      const stranger = await postLocalSignIn(run, { ip: '192.0.2.71', password, code: code() });
      assert.equal(stranger.status, 429, 'a browser that never signed in is kept waiting');
      assert.ok(Number(stranger.headers.get('retry-after')) >= 60);
      await stranger.arrayBuffer();

      const back = await postLocalSignIn(run, { ip: '192.0.2.72', password, code: code() }, browserWith(device));
      assert.equal(back.status, 200, 'the browser the administrator signed in from before the rotation gets in');
      await back.arrayBuffer();
      const [entry] = await run.app.deps.audit.query({ action: 'auth.login' });
      assert.equal(entry.details.knownBrowser, true);
      const old = await postLocalSignIn(run, { ip: '192.0.2.73', code: adminCode(c.ms) }, browserWith(device));
      assert.equal(old.status, 401, 'the cookie is no credential: the old password and code are dead');
      await old.arrayBuffer();
    } finally {
      await run?.app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ── Cookies over https ──────────────────────────────────────────────────────

describe('cookies follow PUBLIC_URL', () => {
  let lab;
  before(async () => { lab = await startTestApp({ env: { PUBLIC_URL: 'https://lab.example.org' } }); });
  after(() => lab.close());

  test('over https the session cookie is __Host-lc_sid, Secure, HttpOnly, SameSite=Lax, Path=/', async () => {
    const browser = new TestBrowser();
    const res = await postLocalSignIn(lab, {}, browser);
    assert.equal(res.status, 200);
    const [cookie] = res.headers.getSetCookie();
    assert.match(cookie, /^__Host-lc_sid=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    assert.ok(!/Domain=/i.test(cookie));
    assert.equal(lab.deps.auth.cookieName, '__Host-lc_sid');
    assert.equal((await browser.fetch(`${lab.url}/api/modules`)).status, 200);

    const token = browser.cookie(lab.url, '__Host-lc_sid');
    const plain = await fetch(`${lab.url}/api/modules`, { headers: { cookie: `lc_sid=${token}` } });
    assert.equal(plain.status, 401, 'the http name is not accepted on an https deployment');
  });
});

// ── Sign-out, the login page ────────────────────────────────────────────────

describe('sign-out and the login page', () => {
  let lab;
  before(async () => { lab = await startTestApp(); });
  after(() => lab.close());

  test('POST /auth/logout ends the session and clears the cookie', async () => {
    const browser = new TestBrowser();
    await (await postLocalSignIn(lab, {}, browser)).arrayBuffer();
    const token = browser.cookie(lab.url, 'lc_sid');
    const out = await browser.fetch(`${lab.url}/auth/logout`, { method: 'POST', headers: { origin: lab.url } });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { redirect: '/login' });
    assert.match(out.headers.getSetCookie()[0], /^lc_sid=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
    const again = await fetch(`${lab.url}/api/modules`, { headers: { cookie: `lc_sid=${token}` } });
    assert.equal(again.status, 401, 'the old cookie no longer opens anything');
    const [entry] = await lab.deps.audit.query({ action: 'auth.logout' });
    assert.equal(entry.actor.id, 'local:root');
  });

  test('POST /auth/logout from another site is refused', async () => {
    const { headers } = lab.signIn('student1');
    const res = await fetch(`${lab.url}/auth/logout`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal((await fetch(`${lab.url}/api/modules`, { headers })).status, 200, 'still signed in');
  });

  test('GET /login: the page, never cached, never indexed', async () => {
    const res = await fetch(`${lab.url}/login`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
    const html = await res.text();
    assert.match(html, /<script type="module" src="\/js\/login.js">/);
    assert.match(html, /id="local-form"/);
    assert.match(html, /id="login-extra"/, 'room for a passkey button');
    const script = await fetch(`${lab.url}/js/login.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    for (const asset of ['/css/login.css', '/css/auth.css', '/locales/fr/auth.json', '/locales/en/auth.json', '/js/core/userMenu.js']) {
      assert.equal((await fetch(lab.url + asset)).status, 200, asset);
    }
  });

  test('GET /login when already signed in goes where the user was heading', async () => {
    const { headers } = lab.signIn('student1');
    const res = await fetch(`${lab.url}/login?next=%2F%23%2Finfra`, { headers, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/#/infra');
  });

  test('/auth/me: the user, the default language and the provider label - nothing secret', async () => {
    const anonymous = await (await fetch(`${lab.url}/auth/me`)).json();
    assert.deepEqual(anonymous, { user: null, locale: 'fr', providerName: null });
    const { headers } = lab.signIn('student2');
    const me = await (await fetch(`${lab.url}/auth/me`, { headers })).json();
    assert.equal(me.user.id, 'oidc:student2');
    assert.ok(!JSON.stringify(me).includes(headers.cookie.split('=')[1]));
  });

  test('without an identity provider, /auth/login sends back to the login page with a reason', async () => {
    const res = await fetch(`${lab.url}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login?error=sso_disabled');
  });

  test('an unknown /auth path is a bare JSON 404', async () => {
    const res = await fetch(`${lab.url}/auth/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found', code: 'server.not_found', params: {} });
  });
});

// ── Live connections ────────────────────────────────────────────────────────

describe('revoking or outliving a session closes its live connections', () => {
  let lab;
  const c = clock();
  before(async () => { lab = await startTestApp({ now: c.now, modules: () => [keepOpenModule()] }); });
  after(() => lab.close());

  test('revoke(sessionId): the WebSocket and the SSE stream close, and cannot be reopened', async () => {
    const { id, headers } = lab.signIn('student1');
    const { ws, hello } = await connect(lab, '/ws/probe', headers);
    assert.deepEqual(hello, { user: 'oidc:student1' });
    const sse = await fetch(`${lab.url}/api/events`, { headers });
    assert.equal(sse.status, 200);
    const ending = streamEnds(sse);

    assert.equal(lab.deps.auth.sessions.revoke(id), true);
    await closed(ws);
    assert.equal(await ending, true, 'the SSE stream was ended by the server');
    assert.equal((await connect(lab, '/ws/probe', headers)).status, 401);
    assert.equal((await fetch(`${lab.url}/api/events`, { headers })).status, 401);
    const [entry] = await lab.deps.audit.query({ action: 'auth.session.end' });
    assert.equal(entry.details.reason, 'revoked');
  });

  test('revokeUser(userId): every session of that person, and only theirs', async () => {
    const a = lab.signIn('student2');
    const b = lab.signIn('student2');
    const other = lab.signIn('student3');
    const sockets = await Promise.all([a, b, other].map((s) => connect(lab, '/ws/probe', s.headers)));
    assert.equal(lab.deps.auth.sessions.revokeUser('oidc:student2'), 2);
    await Promise.all([closed(sockets[0].ws), closed(sockets[1].ws)]);
    assert.equal(sockets[2].ws.readyState, WebSocket.OPEN, 'another user keeps their console');
    assert.equal((await fetch(`${lab.url}/api/probe/whoami`, { headers: other.headers })).status, 200);
    sockets[2].ws.close();
  });

  test('sessions.list(): who is connected, with no token', async () => {
    const { id, token } = lab.signIn('admin');
    const listed = lab.deps.auth.sessions.list().find((s) => s.id === id);
    assert.equal(listed.user.id, 'oidc:admin');
    assert.ok(!JSON.stringify(lab.deps.auth.sessions.list()).includes(token));
  });

  test('an expired session opens nothing: no page, no API, no SSE, no WebSocket', async () => {
    const { headers } = lab.signIn('student3');
    assert.equal((await fetch(`${lab.url}/api/probe/whoami`, { headers })).status, 200);
    c.advance(8 * 3600_000 + 1000);
    assert.equal((await fetch(`${lab.url}/api/probe/whoami`, { headers })).status, 401);
    assert.equal((await fetch(`${lab.url}/api/events`, { headers })).status, 401);
    assert.equal((await connect(lab, '/ws/probe', headers)).status, 401);
    const page = await fetch(`${lab.url}/`, { headers, redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
  });
});
