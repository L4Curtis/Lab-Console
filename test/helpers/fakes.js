/**
 * Small stand-ins shared by the tests: users, a recording logger, and an
 * Express-like request / response pair for middleware that needs no server
 */
import { EventEmitter } from 'node:events';
import express from 'express';
import { createUser } from '../../src/modules/auth/user.js';
import { requireAuth, requireRole } from '../../src/modules/auth/index.js';

export const student = (n = 1, extra = {}) =>
  createUser({ id: `oidc:student${n}`, username: `student${n}`, name: `Student ${n}`, role: 'student', groups: ['students'], via: 'oidc', ...extra });
export const admin = (extra = {}) =>
  createUser({ id: 'oidc:admin', username: 'admin', name: 'Ada Admin', role: 'admin', groups: ['admins'], via: 'oidc', ...extra });

/**
 * An identity for tests, with the surface of ARCHITECTURE §5: the user is
 * named by the `x-test-user` header (or `?as=` on a WebSocket URL, since a
 * browser cannot set headers there). No header: nobody is signed in.
 *
 *   const lab = await startTestApp({ auth: fakeAuth() });
 *   fetch(`${lab.url}/api/benches`, { headers: { 'x-test-user': 'student1' } })
 *
 * Known users: student1, student2, student3, admin - or pass your own map
 */
export function fakeAuth(users = { student1: student(1), student2: student(2), student3: student(3), admin: admin() }) {
  return ({ config }) => {
    const who = (req) => users[req.headers['x-test-user']] ?? users[new URL(req.url, 'http://localhost').searchParams.get('as')] ?? null;
    const router = express.Router();
    router.get('/auth/me', (req, res) => res.json({ user: who(req), mode: 'on', locale: config.defaultLocale, providerName: 'Test' }));
    router.get('/login', (_req, res) => res.type('html').send('<!doctype html><title>login</title>'));
    return {
      mode: 'on',
      attach(req, _res, next) { const user = who(req); if (user) req.user = user; next(); },
      requireAuth,
      requireRole,
      authenticateUpgrade: (req) => who(req),
      sessions: { list: () => [], revoke: () => false, revokeUser: () => 0 },
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
