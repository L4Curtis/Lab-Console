/**
 * Helpers for the accounts tests: the application with the accounts module
 * (and the consoles one, for live sockets), and short calls to its API
 *
 *   const lab = await startAccountsApp({ clock });
 *   const { status, body } = await call(lab, 'admin', 'POST', '/api/accounts/invitations', { uses: 1 });
 *   await confirmed(lab, 'PATCH', '/api/accounts/users/local%3Aalice', { role: 'admin' });   // a change that needs a confirmation
 *   const { token } = await invite(lab);
 *   const res = await signUp(lab, token, { username: 'alice' }, browser);
 *
 * `who` is a name startTestApp knows ('admin', 'student1'…), a User, a
 * TestBrowser (its cookies are used and kept), or null for nobody
 */
import { startTestApp, shiftedClock, confirmTicket } from './app.js';
import { TestBrowser } from './browser.js';
import { createAccountsModule } from '../../src/modules/accounts/index.js';
import { createConsolesModule } from '../../src/modules/consoles/index.js';
import { createAdminModule } from '../../src/modules/admin/index.js';

/** The cheapest scrypt cost the platform accepts: the suite stays fast */
export const FAST_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });
export const PASSWORD = 'correct horse battery';

/** A clock the tests move by hand: clock.ms, clock.now(), clock.advance(ms) */
export function testClock(start = Date.now()) {
  const clock = { ms: start, now: () => clock.ms, advance: (ms) => { clock.ms += ms; } };
  return clock;
}

/**
 * The administration module comes too: it confirms the sensitive changes. The
 * sign-in and administration modules run on `lab.time` (a shiftedClock, which
 * confirmed() moves); `clock` is the accounts module's own
 */
export async function startAccountsApp({ clock, env, publicHost, fetchOptions } = {}) {
  const time = shiftedClock();
  const lab = await startTestApp({
    env,
    publicHost,
    now: time.now,
    modules: (deps) => [
      createConsolesModule(deps),
      createAccountsModule(deps, { passwordCost: FAST_SCRYPT, ...(clock ? { now: clock.now } : {}), fetchOptions }),
      createAdminModule(deps, { now: time.now }),
    ],
  });
  return Object.assign(lab, { time });
}

/** A change that needs a confirmation, by the environment's administrator with a fresh ticket; → { status, body, res } */
export async function confirmed(lab, method, path, body = {}) {
  return call(lab, 'localAdmin', method, path, { ...body, confirmation: await confirmTicket(lab, lab.time) });
}

/** One request; → { status, body (parsed JSON or null), res } */
export async function call(lab, who, method, path, body) {
  const headers = { origin: lab.url, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const options = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  let res;
  if (who instanceof TestBrowser) {
    res = await who.fetch(lab.url + path, options);
  } else {
    if (who) Object.assign(headers, typeof who === 'object' && who.cookie ? { cookie: who.cookie } : lab.as(who));
    res = await fetch(lab.url + path, { ...options, redirect: 'manual' });
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, res };
}

/** An invitation created by the (SSO) admin of the tests; → { url, token, invitation } */
export async function invite(lab, { uses = 1, ttl = '24h', role = 'student', note = '' } = {}) {
  const input = { uses, ttl, role, note };
  const { status, body } = role === 'admin' ? await confirmed(lab, 'POST', '/api/accounts/invitations', input) : await call(lab, 'admin', 'POST', '/api/accounts/invitations', input);
  if (status !== 200) throw new Error(`invitation refused: ${status} ${JSON.stringify(body)}`);
  return { url: body.url, token: body.url.split('#')[1], invitation: body.invitation };
}

export function signUp(lab, token, { username = 'alice', name = 'Alice Martin', password = PASSWORD } = {}, browser = new TestBrowser()) {
  return call(lab, browser, 'POST', '/auth/signup', { token, username, name, password });
}

/** Sign in on the local form with a TestBrowser; → { status, body } */
export function localSignIn(lab, browser, username, password = PASSWORD, code = '') {
  return call(lab, browser, 'POST', '/auth/local', { username, password, code });
}

/** A local account, created through a single-use invitation; → { id, browser (signed in) } */
export async function createLocalAccount(lab, username, { role = 'student', name = username } = {}) {
  const { token } = await invite(lab, { role });
  const browser = new TestBrowser();
  const { status, body } = await signUp(lab, token, { username, name }, browser);
  if (status !== 200) throw new Error(`sign-up refused: ${status} ${JSON.stringify(body)}`);
  return { id: `local:${username}`, browser, answer: body };
}
