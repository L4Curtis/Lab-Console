/**
 * Small stand-ins shared by the tests: users, a recording logger, and an
 * Express-like request / response pair for middleware that needs no server
 */
import { EventEmitter } from 'node:events';
import express from 'express';
import { createUser } from '../../src/modules/auth/user.js';
import { createAuth } from '../../src/modules/auth/index.js';

export const student = (n = 1, extra = {}) =>
  createUser({ id: `oidc:student${n}`, username: `student${n}`, name: `Student ${n}`, role: 'student', groups: ['students'], via: 'oidc', ...extra });
export const admin = (extra = {}) =>
  createUser({ id: 'oidc:admin', username: 'admin', name: 'Ada Admin', role: 'admin', groups: ['admins'], via: 'oidc', ...extra });

/**
 * Kept for tests written before the sign-in existed: the user is named by an
 * `x-test-user` header (or `?as=` on a WebSocket URL). No header: nobody.
 *
 *   const lab = await startTestApp({ auth: fakeAuth() });
 *   fetch(`${lab.url}/api/benches`, { headers: { 'x-test-user': 'student1' } })
 *
 * Nothing is bypassed: this wraps the real sign-in module, opens a real
 * session for the named user in the session store, and puts its cookie on
 * the request before the real gate looks at it. New tests should not need
 * it: `lab.as('student1')` from startTestApp returns the Cookie header itself
 *
 * Known users: student1, student2, student3, admin - or pass your own map
 */
export function fakeAuth(users = { student1: student(1), student2: student(2), student3: student(3), admin: admin() }) {
  return async (deps) => {
    const real = await createAuth(deps);
    const cookies = new Map(); // user name → Cookie header of their session
    const impersonate = (req) => {
      const name = req.headers['x-test-user'] ?? new URL(req.url, 'http://localhost').searchParams.get('as');
      if (!name || !Object.hasOwn(users, name)) return;
      if (!cookies.has(name)) cookies.set(name, real.sessions.create(users[name], { ip: '127.0.0.1', userAgent: 'test' }).cookie);
      req.headers.cookie = cookies.get(name);
    };
    const router = express.Router();
    router.use((req, _res, next) => { impersonate(req); next(); });
    router.use(real.router);
    return {
      ...real,
      attach(req, res, next) { impersonate(req); real.attach(req, res, next); },
      authenticateUpgrade(req) { impersonate(req); return real.authenticateUpgrade(req); },
      router,
      users,
    };
  };
}

/** A logger that keeps what it is told: log.lines = [{ level, message }] */
export function recordingLogger() {
  const lines = [];
  const at = (level) => (message) => lines.push({ level, message: String(message) });
  const log = { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
  return log;
}

/** What a handler sees of an incoming request */
export function fakeRequest({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1', user } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, originalUrl: url, headers, socket: { remoteAddress }, user });
  return req;
}

/** Records what a handler answered: res.statusCode, res.body, res.headers, res.redirectedTo, res.chunks */
export function fakeResponse() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, redirectedTo: null, chunks: [], ended: false,
    status(code) { res.statusCode = code; return res; },
    set(name, value) { res.headers[name.toLowerCase()] = value; return res; },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    writeHead(code, headers = {}) { res.statusCode = code; for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v; },
    json(body) { res.body = body; res.ended = true; return res; },
    redirect(code, to) { res.statusCode = code; res.redirectedTo = to; res.ended = true; },
    write(chunk) { res.chunks.push(String(chunk)); return true; },
    end() { res.ended = true; },
  };
  return res;
}

/** The SSE events a fake response received: [{ topic, data }] */
export function sseEvents(res) {
  return res.chunks
    .filter((chunk) => chunk.startsWith('event: '))
    .map((chunk) => {
      const [, topic, data] = /^event: (.*)\ndata: (.*)\n\n$/s.exec(chunk);
      return { topic, data: JSON.parse(data) };
    });
}
