/**
 * Everything requires a session (SPEC, lot auth; ARCHITECTURE §4).
 *
 * Instead of listing the routes by hand, this test records every route and
 * every mount the application registers while it is built (Proxmox
 * included), rebuilds their full paths, and asks each one as an anonymous
 * client. Only the explicit allow-list below may answer without a session;
 * everything else must refuse: 401 JSON for the API and for writes, a
 * redirect to /login for pages. The three WebSocket endpoints too.
 *
 * A new route is therefore covered the day it is added, and the allow-list
 * is checked the other way round: each entry must still exist
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startTestApp, repoRoot } from './helpers/app.js';

// The router package Express 5 is built on (the same instance Express loads)
const Router = createRequire(createRequire(import.meta.url).resolve('express'))('router');

/** Public without a session: what the login page needs and the sign-in itself. Exact paths, or prefixes ending in '/' */
const PUBLIC = [
  'GET /api/health',
  'GET /favicon.svg', 'GET /favicon.ico',
  'GET /login', 'GET /js/login.js',
  'GET /auth/me', 'GET /auth/login', 'GET /auth/callback',
  'POST /auth/local', 'POST /auth/logout',
  'USE /login', 'USE /auth', // no-store / noindex headers, and the JSON 404 of unknown /auth paths
  'USE /css/', 'USE /locales/', 'USE /js/core/', 'USE /vendor/',
];
const WEBSOCKETS = ['/ws/console', '/ws/proxmox/serial', '/ws/proxmox/vnc'];

/** Record route() and use() calls on every router while `build` runs */
async function recordRoutes(build) {
  const routes = [];
  const mounts = [];
  const originalRoute = Router.prototype.route;
  const originalUse = Router.prototype.use;
  Router.prototype.route = function route(routePath) {
    const r = originalRoute.call(this, routePath);
    routes.push({ router: this, path: routePath, route: r });
    return r;
  };
  Router.prototype.use = function use(...args) {
    const hasPath = typeof args[0] === 'string' || Array.isArray(args[0]) || args[0] instanceof RegExp;
    const at = hasPath ? args[0] : '/';
    for (const fn of args.slice(hasPath ? 1 : 0).flat(Infinity)) mounts.push({ router: this, path: at, fn });
    return originalUse.apply(this, args);
  };
  try {
    return { result: await build(), routes, mounts };
  } finally {
    Router.prototype.route = originalRoute;
    Router.prototype.use = originalUse;
  }
}

const join = (prefix, p) => (p === '/' ? prefix || '/' : `${prefix}${p}`).replace(/\/{2,}/g, '/');
const concrete = (p) => p.replace(/:(\w+)/g, 'x').replace(/\*\w*/g, 'x').replace(/\{|\}/g, '');

/** Full paths of every route and mount reachable from the application's router */
function endpoints(app, routes, mounts) {
  const prefixes = new Map([[app.router, ['']]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of mounts) {
      if (!(m.fn instanceof Router) || !prefixes.has(m.router)) continue;
      const known = prefixes.get(m.fn) ?? [];
      for (const parent of prefixes.get(m.router)) {
        for (const p of [].concat(m.path)) {
          const full = join(parent, p).replace(/\/$/, '');
          if (!known.includes(full)) { known.push(full); changed = true; }
        }
      }
      prefixes.set(m.fn, known);
    }
  }
  const out = [];
  for (const r of routes) {
    for (const prefix of prefixes.get(r.router) ?? []) {
      for (const p of [].concat(r.path)) {
        const methods = Object.keys(r.route.methods).filter((m) => m !== '_all');
        for (const method of methods.length ? methods : ['get']) out.push({ kind: method.toUpperCase(), path: join(prefix, p) });
      }
    }
  }
  for (const m of mounts) {
    if (m.fn instanceof Router) continue;
    for (const prefix of prefixes.get(m.router) ?? []) {
      for (const p of [].concat(m.path)) if (typeof p === 'string' && p !== '/') out.push({ kind: 'USE', path: join(prefix, p) });
    }
  }
  return out;
}

const isPublic = ({ kind, path: p }) => PUBLIC.some((entry) => {
  const [k, rule] = entry.split(' ');
  if (k !== kind) return false;
  return rule.endsWith('/') ? `${p}/`.startsWith(rule) : p === rule;
});

describe('route walk: nothing is served to an anonymous client outside the allow-list', () => {
  let lab;
  let found;
  before(async () => {
    const recorded = await recordRoutes(() => startTestApp({
      // Proxmox on (its routes and WebSockets exist), aimed at a port nobody listens on: nothing is contacted
      env: { PROXMOX_URL: 'https://127.0.0.1:1', PROXMOX_USERNAME: 'test', PROXMOX_PASSWORD: 'test' },
    }));
    lab = recorded.result;
    found = endpoints(lab.app, recorded.routes, recorded.mounts);
  });
  after(() => lab.close());

  test('the walk sees the routes of every module, and every allow-list entry still exists', () => {
    const paths = found.map((e) => `${e.kind} ${e.path}`);
    for (const expected of ['GET /api/modules', 'GET /api/events', 'GET /api/consoles/labs', 'GET /api/consoles/admin-switches',
      'GET /api/proxmox/vms', 'POST /api/proxmox/clone', 'PUT /api/proxmox/vms/:node/:vmid/vlan', 'POST /api/proxmox/vms/:node/:vmid/power']) {
      assert.ok(paths.includes(expected), `${expected} was not found by the walk`);
    }
    for (const entry of PUBLIC) {
      const [kind, rule] = entry.split(' ');
      assert.ok(found.some((e) => e.kind === kind && (rule.endsWith('/') ? `${e.path}/`.startsWith(rule) : e.path === rule)), `allow-list entry "${entry}" matches nothing`);
    }
    assert.ok(found.length >= 25, `only ${found.length} endpoints found`);
  });

  test('every route and mount outside the allow-list refuses an anonymous client', async () => {
    const checked = [];
    for (const endpoint of found) {
      if (isPublic(endpoint)) continue;
      const method = endpoint.kind === 'USE' ? 'GET' : endpoint.kind;
      const target = concrete(endpoint.kind === 'USE' ? `${endpoint.path}/probe` : endpoint.path);
      for (const [label, cookie] of [['no cookie', null], ['forged cookie', `${lab.deps.auth.cookieName}=${'A'.repeat(43)}`]]) {
        const res = await fetch(lab.url + target, {
          method,
          redirect: 'manual',
          headers: { origin: lab.url, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: ['GET', 'HEAD'].includes(method) ? undefined : '{}',
        });
        const where = `${endpoint.kind} ${endpoint.path} (${label})`;
        if (target.startsWith('/api/') || !['GET', 'HEAD'].includes(method)) {
          assert.equal(res.status, 401, where);
          assert.equal((await res.json()).code, 'auth.required', where);
        } else {
          assert.equal(res.status, 302, where);
          assert.match(res.headers.get('location'), /^\/login(\?next=|$)/, where);
          await res.arrayBuffer();
        }
      }
      checked.push(endpoint.path);
    }
    assert.ok(checked.length >= 10);
  });

  test('pages of the application, its scripts and anything unknown redirect to /login', async () => {
    for (const p of ['/', '/index.html', '/js/main.js', '/js/shared/workspace.js', '/js/modules/consoles/index.js', '/locales-not', '/anything']) {
      const res = await fetch(lab.url + p, { redirect: 'manual' });
      assert.equal(res.status, 302, p);
      assert.match(res.headers.get('location'), /^\/login/, p);
    }
  });

  test('the public paths answer without a session', async () => {
    for (const p of ['/api/health', '/favicon.svg', '/favicon.ico', '/login', '/js/login.js', '/auth/me', '/css/app.css', '/css/login.css',
      '/locales/fr/common.json', '/locales/en/auth.json', '/js/core/i18n.js', '/js/core/userMenu.js', '/vendor/fonts/plex-sans/400.css']) {
      const res = await fetch(lab.url + p);
      assert.equal(res.status, 200, p);
      await res.arrayBuffer();
    }
  });

  test('each of the three WebSocket endpoints refuses an anonymous client, and a forged cookie', async () => {
    const upgrade = (p, headers = {}) => new Promise((resolve, reject) => {
      const ws = new WebSocket(lab.wsUrl + p, { headers: { origin: lab.url, ...headers } });
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
      ws.on('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err); });
    });
    for (const p of WEBSOCKETS) {
      assert.equal(await upgrade(`${p}?device=x&node=a&vmid=1`), 401, p);
      assert.equal(await upgrade(`${p}?device=x`, { cookie: `${lab.deps.auth.cookieName}=${'A'.repeat(43)}` }), 401, `${p} (forged cookie)`);
      assert.equal(await upgrade(`${p}?as=admin`), 401, `${p} (?as= is not a way in)`);
    }
    // With a session the same endpoints are reached (the modules answer for themselves)
    const { headers } = lab.signIn('student1');
    assert.equal(await upgrade('/ws/console?device=nope', headers), 101);
  });

  test('the test header of fakeAuth() means nothing to the real application', async () => {
    const res = await fetch(`${lab.url}/api/modules`, { headers: { 'x-test-user': 'admin' } });
    assert.equal(res.status, 401);
  });
});

describe('there is no way to run without signing in', () => {
  const flag = ['AUTH', 'MODE'].join('_');

  test(`no ${flag}, no anonymous user, anywhere in the repository`, () => {
    const offenders = [];
    const skip = new Set(['node_modules', '.git', 'data']);
    const self = fileURLToPath(import.meta.url);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        if (file === self) continue; // this file has to name what it looks for
        if (!/\.(js|json|md|html|css|yml|yaml|example)$|^Dockerfile$|^\.env/.test(entry.name)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(flag)) offenders.push(`${path.relative(repoRoot, file)}: ${flag}`);
        if (/\bANONYMOUS\b|via: 'anonymous'|isAnonymous/.test(text)) offenders.push(`${path.relative(repoRoot, file)}: anonymous user`);
      }
    };
    walk(repoRoot);
    assert.deepEqual(offenders, []);
  });
});
