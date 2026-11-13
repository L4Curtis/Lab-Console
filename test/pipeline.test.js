/**
 * The request pipeline of ARCHITECTURE §4, on the real application.
 *
 * First signed in (a real session, opened in the session store by the test
 * helper), where every existing route must keep answering as upstream; then
 * with the fakeAuth() test seam, to prove what is public and what the gate
 * protects. test/routeWalk.test.js walks every route as an anonymous client
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { startTestApp } from './helpers/app.js';
import { fakeAuth, student } from './helpers/fakes.js';
import { httpError } from '../src/lib/httpError.js';
import { clientIp } from '../src/lib/security.js';

const get = (lab, path, headers = {}) => fetch(lab.url + path, { headers, redirect: 'manual' });
const as = (user) => ({ 'x-test-user': user });

/** Open a WebSocket; resolves to { ws, messages } once open, or to { status } when the upgrade is refused */
function connectAs(lab, path, { origin = lab.url, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(lab.wsUrl + path, { headers: { ...(origin ? { origin } : {}), ...headers } });
    const messages = [];
    ws.on('message', (raw, isBinary) => { if (!isBinary) messages.push(JSON.parse(raw.toString())); });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.on('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err); });
  });
}
const connect = connectAs;
const closed = (ws) => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.once('close', resolve); });

/** Read an SSE stream until `count` events arrived (or the timeout); returns [{ topic, data }] */
async function readEvents(res, count, timeoutMs = 2000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const m = /^event: (.*)\ndata: (.*)$/s.exec(block);
        if (m) events.push({ topic: m[1], data: JSON.parse(m[2]) });
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return events;
}

/** A module that only exists to observe the pipeline from the inside */
function probeModule(deps) {
  const router = express.Router();
  const json = express.json({ limit: '1kb' });
  router.get('/whoami', (req, res) => res.json({ user: req.user ?? null, ip: req.ip, clientIp: clientIp(req, deps.config.server) }));
  router.get('/admin-only', deps.auth.requireRole('admin'), (_req, res) => res.json({ ok: true }));
  router.post('/echo', json, (req, res) => res.json({ got: req.body }));
  router.get('/teapot', () => { throw httpError(418, 'probe.teapot', 'I am a teapot', { cups: 2 }); });
  router.get('/boom', async () => { throw new Error('secret internal detail'); });
  const wss = new WebSocketServer({ noServer: true });
  return {
    id: 'probe', title: 'Probe', enabled: true, router,
    upgrade(req, socket, head) {
      if (!req.url.startsWith('/ws/probe')) return false;
      wss.handleUpgrade(req, socket, head, (ws) => { ws.send(JSON.stringify({ user: req.user.id })); ws.close(); });
      return true;
    },
  };
}

describe('signed in: the application behaves as upstream', () => {
  let lab;
  let session; // Cookie header of an administrator's session
  before(async () => {
    lab = await startTestApp();
    session = lab.as('admin');
  });
  after(() => lab.close());
  const get = (lab, path, headers = {}) => fetch(lab.url + path, { headers: { ...session, ...headers }, redirect: 'manual' });
  const connect = (lab, path, options = {}) => connectAs(lab, path, { ...options, headers: { ...session, ...options.headers } });

  test('GET /api/health answers liveness only', async () => {
    const res = await get(lab, '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('every existing route still answers', async () => {
    const expected = {
      '/': 'text/html',
      '/index.html': 'text/html',
      '/js/main.js': 'text/javascript',
      '/js/core/dom.js': 'text/javascript',
      '/js/shared/workspace.js': 'text/javascript',
      '/js/modules/consoles/index.js': 'text/javascript',
      '/js/modules/infra/index.js': 'text/javascript',
      '/css/app.css': 'text/css',
      '/vendor/xterm/css/xterm.css': 'text/css',
      '/vendor/xterm/lib/xterm.js': 'text/javascript',
      '/vendor/xterm-addon-fit/lib/addon-fit.js': 'text/javascript',
      '/vendor/novnc/core/rfb.js': 'text/javascript',
      '/vendor/fonts/plex-sans/400.css': 'text/css',
      '/vendor/fonts/plex-mono/400.css': 'text/css',
      '/api/modules': 'application/json',
      '/api/consoles/labs': 'application/json',
      '/api/consoles/admin-switches': 'application/json',
      '/api/proxmox/status': 'application/json',
    };
    for (const [path, type] of Object.entries(expected)) {
      const res = await get(lab, path);
      assert.equal(res.status, 200, path);
      assert.ok(res.headers.get('content-type').startsWith(type), `${path}: ${res.headers.get('content-type')}`);
      await res.arrayBuffer();
    }
  });

  test('the API payloads keep their upstream shape', async () => {
    assert.deepEqual(await (await get(lab, '/api/modules')).json(), [
      { id: 'consoles', title: 'Lab consoles', enabled: true },
      { id: 'proxmox', title: 'Infrastructure', enabled: true },
      { id: 'accounts', title: 'Accounts', enabled: true },
      { id: 'admin', title: 'Administration', enabled: true },
    ]);
    const labs = await (await get(lab, '/api/consoles/labs')).json();
    assert.deepEqual(Object.keys(labs).sort(), ['error', 'labs', 'version', 'warnings']);
    assert.ok(labs.labs.length > 0);
    assert.deepEqual(await (await get(lab, '/api/proxmox/status')).json(), { proxmox: false });
    const vms = await get(lab, '/api/proxmox/vms');
    assert.equal(vms.status, 503);
  });

  test('GET /auth/me: the signed-in user and the default language', async () => {
    const res = await get(lab, '/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const me = await res.json();
    assert.deepEqual(Object.keys(me).sort(), ['locale', 'passkeys', 'providerName', 'user']);
    assert.equal(me.passkeys, false, 'http on an IP address: no passkeys');
    assert.equal(me.locale, 'fr');
    assert.equal(me.providerName, null);
    assert.equal(me.user.id, 'oidc:admin');
    assert.equal(me.user.role, 'admin');
  });

  test('already signed in: /login sends back to the application', async () => {
    const res = await get(lab, '/login');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  test('security headers are on every kind of response', async () => {
    for (const path of ['/', '/api/health', '/auth/me', '/css/app.css', '/api/nope', '/api/events']) {
      const res = await get(lab, path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(res.headers.get('x-powered-by'), null, path);
      await res.body.cancel();
    }
  });

  test('unknown API route: JSON 404 with a code', async () => {
    const res = await get(lab, '/api/nope');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found', code: 'server.not_found', params: {} });
    assert.equal((await get(lab, '/css/nope.css')).status, 404);
    assert.equal((await get(lab, '/locales/fr/nope.json')).status, 404);
  });

  test('state-changing requests must come from the platform itself', async () => {
    const post = (headers) => fetch(`${lab.url}/api/proxmox/clone`, { method: 'POST', headers: { ...session, ...headers } });
    for (const headers of [{}, { origin: 'https://evil.example' }]) {
      const res = await post(headers);
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'Cross-origin request refused', code: 'server.cross_origin', params: {} });
    }
    const own = await post({ origin: lab.url });
    assert.equal(own.status, 503, 'reaches the module (Proxmox is not configured in this test)');
  });

  test('SSE: /api/events replays the sticky topics of the existing modules', async () => {
    const res = await get(lab, '/api/events');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').startsWith('text/event-stream'));
    const events = await readEvents(res, 3);
    assert.deepEqual(events.map((e) => e.topic).sort(), ['admin:announcement', 'consoles:busy', 'labs:version']);
    assert.equal(events.find((e) => e.topic === 'admin:announcement').data, null, 'no announcement yet');
    assert.deepEqual(events.find((e) => e.topic === 'consoles:busy').data, []);
  });

  test('WebSocket /ws/console: the upgrade is accepted and the console protocol starts', async () => {
    const labs = await (await get(lab, '/api/consoles/labs')).json();
    const device = labs.labs.flatMap((l) => l.devices).find((d) => d.allowed);
    const { ws, messages, status } = await connect(lab, `/ws/console?device=${encodeURIComponent(device.key)}&cols=80&rows=24`);
    assert.equal(status, undefined, 'upgrade accepted');
    await closed(ws); // the jump server of this test does not exist: the session reports it and ends
    assert.equal(messages[0].type, 'status');
    assert.equal(messages.at(-1).type, 'exit');
  });

  test('WebSocket: unknown device is refused by the module, as upstream', async () => {
    const { ws, messages } = await connect(lab, '/ws/console?device=nope');
    await closed(ws);
    assert.deepEqual(messages, [{ type: 'error', message: 'This device no longer exists. Reload the page.', code: 'consoles.device_gone', params: {} }]);
  });

  test('WebSocket: a foreign origin is refused, an unknown path is a 404', async () => {
    assert.equal((await connect(lab, '/ws/console?device=x', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await connect(lab, '/ws/console?device=x', { origin: null })).status, 403);
    assert.equal((await connect(lab, '/ws/nope')).status, 404);
    assert.equal((await connect(lab, '/ws/proxmox/serial?node=a&vmid=1')).status, 404, 'Proxmox is off in this test');
  });

  test('every module received the platform services, and the registry is shared', () => {
    assert.deepEqual(Object.keys(lab.deps).sort(), ['audit', 'auth', 'config', 'diagrams', 'events', 'infra', 'logger', 'services', 'settings', 'store']);
    assert.equal(typeof lab.deps.services.consoles.registry.getDevice, 'function');
    assert.equal(typeof lab.deps.settings.get('lab').ssh, 'object');
    assert.equal(lab.deps.store.root, lab.dataDir);
  });

  test('the audit trail lands in DATA_DIR, signed with the request\'s user and address', async () => {
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, user: student(1) };
    assert.equal(await lab.deps.audit.log(req, 'console.open', { bench: 'B4M', device: 'R1' }), true);
    const [entry] = await lab.deps.audit.query({ bench: 'B4M' });
    assert.equal(entry.actor.id, 'oidc:student1');
    assert.equal(entry.ip, '127.0.0.1');
    assert.ok(fs.readdirSync(lab.deps.store.resolve('audit')).length === 1);
  });
});

describe('the gate: what is public, what needs a user, what needs a role', () => {
  let lab;
  before(async () => { lab = await startTestApp({ auth: fakeAuth(), modules: (deps) => [probeModule(deps)] }); });
  after(() => lab.close());

  test('health is public', async () => {
    const res = await get(lab, '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('public without a session: only what the login page needs', async () => {
    for (const path of ['/css/app.css', '/css/shared.css', '/js/core/dom.js', '/js/core/api.js', '/js/core/i18n.js', '/js/core/session.js',
      '/locales/fr/common.json', '/locales/en/common.json', '/vendor/fonts/plex-sans/400.css', '/favicon.svg', '/favicon.ico', '/login', '/auth/me']) {
      const res = await get(lab, path);
      assert.equal(res.status, 200, path);
      await res.arrayBuffer();
    }
    assert.equal((await (await get(lab, '/auth/me')).json()).user, null);
  });

  test('without a session, pages redirect to /login and nothing of the application is served', async () => {
    for (const path of ['/', '/index.html', '/js/main.js', '/js/shared/dialog.js', '/js/modules/consoles/index.js', '/anything']) {
      const res = await get(lab, path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`, path);
    }
  });

  test('without a session, the API answers 401 JSON - SSE, module list and module routes included', async () => {
    for (const path of ['/api/events', '/api/modules', '/api/probe/whoami', '/api/probe/admin-only', '/api/nope']) {
      const res = await get(lab, path);
      assert.equal(res.status, 401, path);
      assert.deepEqual(await res.json(), { error: 'Sign in to continue', code: 'auth.required', params: {} }, path);
    }
    const write = await fetch(`${lab.url}/api/probe/echo`, { method: 'POST', headers: { origin: lab.url, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(write.status, 401);
  });

  test('without a session, a WebSocket upgrade ends with 401 before any module sees it', async () => {
    assert.equal((await connect(lab, '/ws/probe')).status, 401);
    assert.equal((await connect(lab, '/ws/nope')).status, 401, 'not even the list of paths leaks');
  });

  test('with a session: req.user reaches the module, on HTTP and on WebSocket', async () => {
    const res = await get(lab, '/api/probe/whoami', as('student1'));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.id, 'oidc:student1');
    assert.equal((await get(lab, '/', as('student1'))).status, 200);
    assert.equal((await get(lab, '/js/main.js', as('student1'))).status, 200);

    const { ws, messages } = await connect(lab, '/ws/probe', { headers: as('student2') });
    await closed(ws);
    assert.deepEqual(messages, [{ user: 'oidc:student2' }]);
  });

  test('wrong role: 403 JSON for a student, 200 for an admin', async () => {
    const res = await get(lab, '/api/probe/admin-only', as('student1'));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'You are not allowed to do this', code: 'auth.forbidden', params: { role: 'admin' } });
    assert.equal((await get(lab, '/api/probe/admin-only', as('admin'))).status, 200);
  });

  test('a signed-in user still needs the same origin to change state', async () => {
    const post = (headers, body = '{"a":1}') => fetch(`${lab.url}/api/probe/echo`, { method: 'POST', headers: { ...as('student1'), 'content-type': 'application/json', ...headers }, body });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    const ok = await post({ origin: lab.url });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { got: { a: 1 } });
  });

  test('errors are JSON { error, code, params }; internals never leak', async () => {
    const teapot = await get(lab, '/api/probe/teapot', as('student1'));
    assert.equal(teapot.status, 418);
    assert.deepEqual(await teapot.json(), { error: 'I am a teapot', code: 'probe.teapot', params: { cups: 2 } });

    const boom = await get(lab, '/api/probe/boom', as('student1'));
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'Internal error', code: 'server.internal', params: {} });

    const post = (body) => fetch(`${lab.url}/api/probe/echo`, { method: 'POST', headers: { ...as('student1'), origin: lab.url, 'content-type': 'application/json' }, body });
    const malformed = await post('{"a":');
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid request', code: 'server.bad_request', params: {} });
    const huge = await post(JSON.stringify({ a: 'x'.repeat(5000) }));
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).code, 'server.too_large');
  });

  test('SSE over HTTP: the audience filter uses the user of each stream', async () => {
    const pupil = await get(lab, '/api/events', as('student1'));
    const root = await get(lab, '/api/events', as('admin'));
    assert.equal(pupil.status, 200);
    assert.equal(lab.deps.events.count(), 2);
    lab.deps.events.publish('admin:only', { n: 1 }, { audience: (user) => user.role === 'admin' });
    lab.deps.events.toUser('oidc:student1', 'me:only', { n: 2 });
    lab.deps.events.publish('all:users', { n: 3 });
    assert.deepEqual((await readEvents(root, 2)).map((e) => e.topic), ['admin:only', 'all:users']);
    assert.deepEqual((await readEvents(pupil, 2)).map((e) => e.topic), ['me:only', 'all:users']);
  });

  test('a spoofed X-Forwarded-For is ignored when no proxy is trusted', async () => {
    const res = await get(lab, '/api/probe/whoami', { ...as('student1'), 'x-forwarded-for': '203.0.113.7' });
    const { ip, clientIp: seen } = await res.json();
    assert.equal(seen, '127.0.0.1');
    assert.match(ip, /127\.0\.0\.1$/, 'Express agrees (req.ip)');
  });
});

describe('behind a trusted reverse proxy', () => {
  let lab;
  before(async () => {
    lab = await startTestApp({ env: { TRUSTED_PROXIES: '127.0.0.1' }, auth: fakeAuth(), modules: (deps) => [probeModule(deps)] });
  });
  after(() => lab.close());

  test('the forwarded address is the client, for clientIp() and for Express', async () => {
    const res = await get(lab, '/api/probe/whoami', { ...as('student1'), 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
    assert.deepEqual(await res.json().then(({ ip, clientIp: seen }) => ({ ip, seen })), { ip: '203.0.113.7', seen: '203.0.113.7' });
  });
});

test('close(): open streams end, pending writes finish, the port is freed', async () => {
  const lab = await startTestApp();
  const stream = await get(lab, '/api/events', lab.as('student1'));
  const reading = readEvents(stream, 99, 5000); // an open tab must not prevent the shutdown
  let written = false;
  lab.deps.store.json('benches/occupancy.json', {}).set({ B4M: ['oidc:student1'] }).then(() => { written = true; });
  const { deps, server } = lab;
  await lab.close();
  assert.equal(written, true, 'close() waited for the write');
  assert.equal(server.listening, false);
  assert.equal(deps.events.count(), 0);
  await reading;
  await assert.rejects(fetch(`${lab.url}/api/health`));
  assert.equal(fs.existsSync(lab.dataDir), false, 'the test helper removed its temporary directory');
});
