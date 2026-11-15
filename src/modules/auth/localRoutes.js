/**
 * Signing in with a local account (the environment's administrator first,
 * then the accounts the directory adds):
 *
 *   POST /auth/local   { username, password, code, next } → { redirect }, or { step } when the
 *                      account must still prove itself with a passkey (the step cookie is set);
 *                      the provider's own error when it refuses an account it recognised
 *                      (accounts.passkeys_unavailable: a local account on a site without passkeys)
 *
 * Throttled per address, per name and per known browser (throttle.js,
 * devices.js); one answer for every failure
 */
import express from 'express';
import { jsonBody } from '../../lib/bodies.js';
import { sendError } from '../../lib/httpError.js';
import { clientIp } from '../../lib/security.js';
import { readCookie } from './cookies.js';
import { safeReturnPath } from './pendingLogins.js';

/**
 * @param accounts       the local account providers (accounts.js)
 * @param signIn         (req, res, user) → session
 * @param rememberBrowser (res, username): this browser is now known for that name
 * @param startStep      (req, res, user, requires, options): a further proof owed
 */
export function localRoutes({ accounts, throttle, devices, refusals, cookies, serverTrust, sameOrigin, signIn, rememberBrowser, startStep, audit, log }) {
  const router = express.Router();

  router.post('/auth/local', sameOrigin, jsonBody('4kb'), async (req, res) => {
    const body = req.body !== null && typeof req.body === 'object' ? req.body : {};
    const username = typeof body.username === 'string' ? body.username.slice(0, 128) : '';
    const client = clientIp(req, serverTrust);
    // A browser that already signed in with this name is limited on its own (throttle.js, devices.js)
    const device = devices.check(readCookie(req, cookies.device), username) ?? undefined;
    const slot = throttle.take({ client, username, device });
    if (!slot.allowed) {
      refusals.record(req, client, `throttled:${slot.scope}`, { method: 'local', reason: 'throttled', scope: slot.scope });
      res.set('Retry-After', String(slot.retryAfterSeconds));
      return sendError(res, 429, 'auth.throttled', 'Too many sign-in attempts. Try again later', { seconds: slot.retryAfterSeconds });
    }

    let answer = null;
    try {
      answer = await accounts.verify({ username, password: body.password, code: body.code }, { logger: log });
    } finally {
      if (answer) throttle.succeeded({ client, username, device });
      else throttle.failed({ username, device });
    }
    const user = answer?.user;
    if (!user) {
      audit?.log(req, 'auth.login.failed', { method: 'local', reason: 'invalid' });
      // One message for every cause: nothing says which field was wrong, or whether the account exists
      return sendError(res, 401, 'auth.invalid_credentials', 'Sign-in failed. Check the user name, the password and the code');
    }
    // The credentials were right, but this account cannot sign in here: say why
    // (only someone who proved the password reads it, so nothing leaks)
    if (answer.refused) {
      audit?.log(req, 'auth.login.failed', { method: 'local', reason: answer.refused.code, username: user.username });
      return sendError(res, answer.refused.status, answer.refused.code, answer.refused.message);
    }
    // The password was right but this account owes a passkey: no session until it is given
    if (answer.requires.length) {
      startStep(req, res, user, answer.requires, { returnTo: safeReturnPath(body.next), deviceName: username, method: 'local', binding: answer.binding });
      audit?.log(req, 'auth.login.step', { method: 'local', step: answer.requires[0], username: user.username });
      return res.json({ step: answer.requires[0] });
    }

    const session = signIn(req, res, user);
    rememberBrowser(res, username);
    audit?.log(req, 'auth.login', { method: 'local', session: session.id, role: user.role, knownBrowser: Boolean(device) });
    res.json({ redirect: safeReturnPath(body.next) });
  });

  return router;
}
