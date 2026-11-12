/**
 * The identity surface of ARCHITECTURE §5, in its anonymous implementation
 * (AUTH_MODE=off). The same assertions describe what any implementation of
 * src/modules/auth/ must keep offering to the other modules
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, requireAuth, requireRole, createUser, hasRole, ANONYMOUS } from '../src/modules/auth/index.js';
import { initialsOf, colorOf } from '../src/modules/auth/user.js';
import { student, admin, fakeRequest, fakeResponse } from './helpers/fakes.js';

const config = { auth: { mode: 'off' }, defaultLocale: 'fr' };
const through = (middleware, req) => {
  const res = fakeResponse();
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, res };
};

test('service surface: everything §5 promises is there', () => {
  const auth = createAuth({ config });
  assert.equal(auth.mode, 'off');
  for (const fn of ['attach', 'requireAuth', 'requireRole', 'authenticateUpgrade']) assert.equal(typeof auth[fn], 'function', fn);
  for (const fn of ['list', 'revoke', 'revokeUser']) assert.equal(typeof auth.sessions[fn], 'function', `sessions.${fn}`);
  assert.equal(typeof auth.router, 'function', 'an Express router for /login and /auth/*');
});

test('AUTH_MODE=off: every request and every upgrade carries the same anonymous admin', async () => {
  const auth = createAuth({ config });
  const req = fakeRequest({ url: '/api/consoles/labs' });
  assert.equal(through(auth.attach, req).passed, true);
  assert.equal(req.user, ANONYMOUS);
  assert.equal(await auth.authenticateUpgrade(fakeRequest({ url: '/ws/console' })), ANONYMOUS);
  assert.deepEqual(
    { id: ANONYMOUS.id, role: ANONYMOUS.role, via: ANONYMOUS.via, username: ANONYMOUS.username },
    { id: 'anonymous', role: 'admin', via: 'anonymous', username: 'anonymous' },
  );
  assert.equal(through(auth.requireAuth, req).passed, true);
  assert.equal(through(auth.requireRole('admin'), req).passed, true);
  assert.deepEqual(auth.sessions.list(), []);
  assert.equal(auth.sessions.revoke('whatever'), false);
  assert.equal(auth.sessions.revokeUser('anonymous'), 0);
});

test('AUTH_MODE=on is refused by this build instead of running open', () => {
  assert.throws(() => createAuth({ config: { auth: { mode: 'on' } } }), /AUTH_MODE=on needs the sign-in module/);
  assert.throws(() => createAuth({ config: {} }), /AUTH_MODE=on/, 'a missing mode is "on", never "off"');
});

test('requireAuth: no user → 401 JSON under /api, redirect to /login for a page', () => {
  const api = through(requireAuth, fakeRequest({ url: '/api/consoles/labs' }));
  assert.equal(api.passed, false);
  assert.equal(api.res.statusCode, 401);
  assert.deepEqual(api.res.body, { error: 'Sign in to continue', code: 'auth.required', params: {} });

  const page = through(requireAuth, fakeRequest({ url: '/' }));
  assert.equal(page.passed, false);
  assert.equal(page.res.statusCode, 302);
  assert.equal(page.res.redirectedTo, '/login');

  const write = through(requireAuth, fakeRequest({ method: 'POST', url: '/upload' }));
  assert.equal(write.res.statusCode, 401, 'a write is never answered with a redirect');
  assert.equal(through(requireAuth, fakeRequest({ url: '/', user: student(1) })).passed, true);
});

test('requireRole: wrong role → 403 JSON, missing session → 401', () => {
  const asStudent = through(requireRole('admin'), fakeRequest({ url: '/api/admin/sessions', user: student(1) }));
  assert.equal(asStudent.passed, false);
  assert.equal(asStudent.res.statusCode, 403);
  assert.deepEqual(asStudent.res.body, { error: 'You are not allowed to do this', code: 'auth.forbidden', params: { role: 'admin' } });

  assert.equal(through(requireRole('admin'), fakeRequest({ user: admin() })).passed, true);
  assert.equal(through(requireRole('student'), fakeRequest({ user: admin() })).passed, true, 'an admin can do what a student can');
  assert.equal(through(requireRole('student'), fakeRequest({ user: student(1) })).passed, true);
  assert.equal(through(requireRole('admin'), fakeRequest({ url: '/api/admin/sessions' })).res.statusCode, 401);
  assert.equal(through(requireRole('root'), fakeRequest({ user: admin() })).res.statusCode, 403, 'an unknown role is held by nobody');
});

test('hasRole: student < admin', () => {
  assert.equal(hasRole(admin(), 'admin'), true);
  assert.equal(hasRole(student(1), 'admin'), false);
  assert.equal(hasRole(student(1), 'student'), true);
  assert.equal(hasRole(null, 'student'), false);
  assert.equal(hasRole({ role: 'teacher' }, 'student'), false);
});

test('createUser: the User shape of §5, frozen, with a stable badge', () => {
  const user = createUser({ id: 'oidc:42', username: 'alovelace', name: 'Ada Lovelace', email: 'ada@example.org', role: 'student', groups: ['rt2'], via: 'oidc' });
  assert.deepEqual(Object.keys(user).sort(), ['color', 'email', 'groups', 'id', 'initials', 'name', 'role', 'username', 'via']);
  assert.equal(user.initials, 'AL');
  assert.match(user.color, /^hsl\(\d{1,3} \d+% \d+%\)$/);
  assert.equal(createUser({ id: 'oidc:42', via: 'oidc' }).color, user.color, 'same id, same colour');
  assert.notEqual(colorOf('oidc:43'), user.color);
  assert.throws(() => { user.role = 'admin'; }, TypeError);
  assert.throws(() => { user.groups.push('admins'); }, TypeError);
  assert.throws(() => createUser({ id: 'x', via: 'oidc', role: 'root' }), /Unknown role/);
  assert.throws(() => createUser({ username: 'x' }), /needs an id/);
  assert.equal(JSON.parse(JSON.stringify(user)).id, 'oidc:42', 'serializable as is, for /auth/me and presence');
});

test('initialsOf', () => {
  assert.equal(initialsOf('Ada Lovelace'), 'AL');
  assert.equal(initialsOf('jean-pierre.martin'), 'JM');
  assert.equal(initialsOf('curtis'), 'CU');
  assert.equal(initialsOf('élodie'), 'ÉL');
  assert.equal(initialsOf(''), '?');
});
