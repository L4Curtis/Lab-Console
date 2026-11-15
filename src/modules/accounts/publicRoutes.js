/**
 * The accounts module's routes that work without a session, mounted above
 * the gate through auth.extend() (each one checks what it needs itself):
 *
 *   GET  /join, /reset           the page of an invitation or a reset link (the token is in the fragment)
 *   GET  /js/join.js             its script
 *   POST /auth/invitation        { token } → { role, approval, expiresAt }      what an invitation offers
 *   POST /auth/signup            { token, username, name, password } → { step: 'passkey-enrol', pending? }
 *   POST /auth/reset-link        { token } → { username, expiresAt }            whose password a link resets
 *   POST /auth/reset             { token, password } → { step: 'passkey-enrol' } | { ok }
 *                                the account's sessions end and its passkeys are removed
 *   POST /auth/passkey/options   → { options }                one-click sign-in: any passkey of this site
 *   POST /auth/passkey/verify    { response, next } → { redirect }
 *   POST /auth/passkey/step/options   → { kind, options }     the passkey a sign-in still owes
 *   POST /auth/passkey/step/verify    { response } → { redirect } | { pending }
 *
 * Every local account signs in with a passkey (docs/v2/AUTH.md §2b). A
 * sign-up and a reset therefore end in the same step a password sign-in
 * does (auth.steps): no session until a passkey is registered, and an
 * account left there registers one at its next password sign-in. An
 * account waiting for an administrator's approval registers its passkey at
 * sign-up too, and gets no session at the end of the step ({ pending }).
 * Where this site cannot offer passkeys, sign-up, reset and the step are
 * refused with 409 accounts.passkeys_unavailable, before any link is used.
 *
 * Every refusal of a link is the same 404 (`accounts.link_invalid`) whether
 * the token is unknown, expired, revoked or used up; the audit trail keeps
 * the reason. All of it is limited per client address (nobody is signed in
 * yet, so the address is the only key there is) and the sign-up per link
 */
import path from 'node:path';
import express from 'express';
import { jsonBody } from '../../lib/bodies.js';
import { sendError } from '../../lib/httpError.js';
import { requireSameOrigin, createRateLimiter, clientIp } from '../../lib/security.js';
import { hashPassword } from '../auth/password.js';
import { safeReturnPath } from '../auth/pendingLogins.js';
import { checkUsername, checkPassword, cleanDisplayName } from './policy.js';
import { stepBinding, stepBindingHolds } from './directory.js';
import {
  registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication, credentialIdOf, PasskeyError,
} from './passkeys.js';

const WINDOW = 15 * 60_000;
/**
 * Passkey requests per client address and minute: one-click sign-in
 * (options and verify together), and the step after a password, a sign-up
 * or a reset. Every local account signs in through them, and a classroom
 * often shares one public address: room for a hundred people at once
 */
export const PASSKEY_LIMITS = Object.freeze({ oneClick: 300, step: 240, windowMs: 60_000 });

const PASSWORD_MESSAGES = {
  password_short: 'The password needs at least 10 characters',
  password_long: 'The password is too long',
  password_common: 'This password is too common: choose another one',
  password_like_username: 'The password must not contain the user name',
};
/** A password the policy refused (policy.js checkPassword): 400 with the reason as the code */
export const passwordProblem = (res, code) => sendError(res, 400, `accounts.${code}`, PASSWORD_MESSAGES[code] ?? 'This password cannot be used');

/**
 * Refusals counted per key in a fixed window: `blocked(key)` once `limit`
 * failures happened, `failed(key)` counts one. Successes cost nothing, so a
 * link for a whole class is not slowed down by its own sign-ups
 */
function createFailureCounter({ limit, windowMs }) {
  const entries = new Map(); // key → { start, count }
  const current = (key) => {
    const entry = entries.get(key);
    if (entry && Date.now() - entry.start < windowMs) return entry;
    entries.delete(key);
    return null;
  };
  return {
    blocked: (key) => (current(key)?.count ?? 0) >= limit,
    failed(key) {
      const entry = current(key) ?? { start: Date.now(), count: 0 };
      entry.count += 1;
      entries.delete(key);
      entries.set(key, entry);
      if (entries.size > 10_000) entries.delete(entries.keys().next().value);
    },
  };
}

/** A passkey's first name: what the browser says about the device, or a dated label */
export const defaultPasskeyName = (req) => {
  const agent = String(req.headers['user-agent'] ?? '');
  const os = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac OS/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' · ') || 'Passkey';
};

export function publicRoutes(ctx) {
  const { config, auth, audit, directory, links, rp, ceremony, refusals, changed, exclusive, passwordCost, log, assets } = ctx;
  const router = express.Router();
  const sameOrigin = requireSameOrigin(config.server.allowedOrigins);
  const small = jsonBody('4kb');
  const large = jsonBody('32kb'); // WebAuthn responses carry keys and signatures
  // A classroom shares one public address: generous per address, strict per link
  const linkAttempts = createRateLimiter({ limit: 120, windowMs: WINDOW });
  const signupFailures = createFailureCounter({ limit: 10, windowMs: WINDOW });
  // One-click sign-in: every opening of the local form asks for options
  // (conditional UI), so a classroom behind one address needs room
  const passkeyAttempts = createRateLimiter({ limit: PASSKEY_LIMITS.oneClick, windowMs: PASSKEY_LIMITS.windowMs });
  // The step after a password has its own budget: the class's one-click
  // traffic never refuses a promoted administrator's step
  const stepAttempts = createRateLimiter({ limit: PASSKEY_LIMITS.step, windowMs: PASSKEY_LIMITS.windowMs });
  const addressOf = (req) => clientIp(req, config.server);
  const body = (req) => (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  /** Refuse past the limiter's budget, with that limiter's own window as Retry-After */
  const limited = (limiter, windowMs) => (req, res, next) => {
    if (limiter(addressOf(req))) return next();
    res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
    sendError(res, 429, 'accounts.throttled', 'Too many attempts. Try again later');
  };
  const noStore = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  };

  /** Passkeys cannot be offered on this site: no local account is created, reset or signed in (docs/v2/AUTH.md §2b) */
  const unavailable = (res) => sendError(res, 409, 'accounts.passkeys_unavailable', 'Local accounts sign in with a passkey, which needs Lab Console to be served over https');
  const needsPasskeys = (_req, res, next) => (rp.available ? next() : unavailable(res));

  /** One answer for every unusable link; the reason goes to the audit trail (once per address and reason) */
  function badLink(req, res, problem, kind) {
    refusals.record(req, addressOf(req), `link:${problem}`, { method: kind, reason: problem });
    return sendError(res, 404, 'accounts.link_invalid', 'This link is not valid: it may have expired, been used or been withdrawn');
  }

  const page = (_req, res) => assets.sendPage(res, 'join.html');
  router.get('/join', noStore, page);
  router.get('/reset', noStore, page);
  router.get('/js/join.js', (_req, res) => res.sendFile(path.join(assets.dir, 'js', 'join.js')));

  // ── Invitations ────────────────────────────────────────────────────────────
  router.post('/auth/invitation', sameOrigin, small, limited(linkAttempts, WINDOW), needsPasskeys, (req, res) => {
    const { link, problem } = links.find(body(req).token, { kind: 'invite' });
    if (problem) return badLink(req, res, problem, 'invitation');
    res.json({ role: link.role, approval: link.maxUses > 1, expiresAt: new Date(link.expiresAt).toISOString() });
  });

  router.post('/auth/signup', sameOrigin, small, limited(linkAttempts, WINDOW), needsPasskeys, async (req, res) => {
    const input = body(req);
    const first = links.find(input.token, { kind: 'invite' });
    if (first.problem) return badLink(req, res, first.problem, 'invitation');
    const linkId = first.link.id;
    if (signupFailures.blocked(linkId)) return sendError(res, 429, 'accounts.throttled', 'Too many attempts. Try again later');
    const refuse = (send) => {
      signupFailures.failed(linkId);
      return send();
    };

    const username = typeof input.username === 'string' ? input.username.trim() : '';
    // A name already taken (the environment's administrator's included) is
    // refused like a reserved one, before any hashing: same answer, same time.
    // Saying that a chosen name is taken is accepted (owner decision, 13 Nov,
    // docs/v2/AUTH.md §2b): only the holder of a valid invitation can ask, and
    // the per-link limit (10 refusals per 15 minutes) keeps probing slow
    const usernameProblem = checkUsername(username) ?? (directory.isTaken(username) ? 'username_unavailable' : null);
    if (usernameProblem) return refuse(() => sendError(res, usernameProblem === 'username_invalid' ? 400 : 409, `accounts.${usernameProblem}`, 'This user name cannot be used'));
    const name = cleanDisplayName(input.name);
    if (!name) return refuse(() => sendError(res, 400, 'accounts.name_invalid', 'Give a display name of 1 to 64 characters'));
    const weak = checkPassword(input.password, { username });
    if (weak) return refuse(() => passwordProblem(res, weak));
    const passwordHash = await hashPassword(input.password, passwordCost);

    let account;
    try {
      account = await exclusive(async () => {
        // Checked again inside the lock: two sign-ups on the last use of a link, or on one name
        const again = links.find(input.token, { kind: 'invite' });
        if (again.problem) return { problem: again.problem };
        if (directory.isTaken(username)) return { taken: true };
        const link = again.link;
        const state = link.maxUses > 1 ? 'pending' : 'active';
        const id = `local:${username}`;
        const problem = await links.use(link.id, id);
        if (problem) return { problem };
        try {
          const created = await directory.createLocal({ username, name, passwordHash, role: link.role, state, createdBy: link.createdBy, invitation: link.id });
          return { created, link };
        } catch (err) {
          await links.release(link.id, id);
          if (err.code === 'accounts.username_unavailable') return { taken: true };
          throw err;
        }
      });
    } catch (err) {
      log.error(`sign-up failed: ${err.stack || err}`);
      return sendError(res, 500, 'server.internal', 'Internal error');
    }
    if (account.problem) return badLink(req, res, account.problem, 'invitation');
    if (account.taken) return refuse(() => sendError(res, 409, 'accounts.username_unavailable', 'This user name cannot be used'));

    const { created, link } = account;
    const user = directory.toUser(created);
    req.user = user;
    audit.log(req, 'accounts.signup', { account: created.id, username: created.username, role: created.role, state: created.state, invitation: link.id });
    changed('users');
    // Whatever the role, the passkey is registered as part of the sign-up and
    // before any session (the step). A single-use link gives an active
    // account, signed in at the end of the step; a link for several people, a
    // pending one that only registers its passkey and waits for approval
    auth.steps.start(req, res, user, ['passkey-enrol'], { method: 'signup', binding: stepBinding(created) });
    res.json({ step: 'passkey-enrol', ...(created.state === 'pending' ? { pending: true } : {}) });
  });

  // ── Password reset links ───────────────────────────────────────────────────
  function resetTarget(token) {
    const { link, problem } = links.find(token, { kind: 'reset' });
    if (problem) return { problem };
    const account = directory.get(link.accountId);
    if (!account || account.via !== 'local') return { problem: 'unknown' };
    return { link, account };
  }

  router.post('/auth/reset-link', sameOrigin, small, limited(linkAttempts, WINDOW), needsPasskeys, (req, res) => {
    const target = resetTarget(body(req).token);
    if (target.problem) return badLink(req, res, target.problem, 'reset');
    res.json({ username: target.account.username, expiresAt: new Date(target.link.expiresAt).toISOString() });
  });

  /**
   * A reset link sets a new password AND replaces the passkeys: the old ones
   * are removed when the link is used (a lost or stolen phone is the usual
   * reason to ask for one, and it may still hold a passkey), and the person
   * registers a new one at once, in the step that follows, before any
   * session. Left there, the account registers one at its next password
   * sign-in. A disabled account gets no step: it registers one once enabled
   */
  router.post('/auth/reset', sameOrigin, small, limited(linkAttempts, WINDOW), needsPasskeys, async (req, res) => {
    const input = body(req);
    const first = resetTarget(input.token);
    if (first.problem) return badLink(req, res, first.problem, 'reset');
    const weak = checkPassword(input.password, { username: first.account.username });
    if (weak) return passwordProblem(res, weak);
    const passwordHash = await hashPassword(input.password, passwordCost);
    const outcome = await exclusive(async () => {
      const again = resetTarget(input.token);
      if (again.problem) return again;
      const problem = await links.use(again.link.id, again.account.id);
      if (problem) return { problem };
      const removed = await directory.resetCredentials(again.account.id, passwordHash);
      return { ...again, removed };
    });
    if (outcome.problem) return badLink(req, res, outcome.problem, 'reset');
    // Whoever was signed in with the old password or an old passkey is not any
    // more; a sign-in step started with them is over too (its binding no longer holds)
    const ended = auth.sessions.revokeUser(outcome.account.id);
    const account = directory.get(outcome.account.id);
    const user = directory.toUser(account);
    req.user = user;
    audit.log(req, 'accounts.password.reset', { account: account.id, link: outcome.link.id, sessionsEnded: ended, passkeysRemoved: outcome.removed });
    changed('users');
    if (account.state === 'disabled') return res.json({ ok: true });
    auth.steps.start(req, res, user, ['passkey-enrol'], { method: 'reset', binding: stepBinding(account) });
    res.json({ step: 'passkey-enrol' });
  });

  // ── Passkeys: one-click sign-in ────────────────────────────────────────────
  const refused = (req, res, reason, details = {}) => {
    refusals.record(req, addressOf(req), `passkey:${reason}`, { method: 'passkey', reason, ...details });
    return sendError(res, 401, 'accounts.passkey_refused', 'This passkey was not accepted');
  };

  router.post('/auth/passkey/options', sameOrigin, small, limited(passkeyAttempts, PASSKEY_LIMITS.windowMs), async (req, res) => {
    if (!rp.available) return unavailable(res);
    // A passkey that signs in alone must have checked who holds it (PIN, fingerprint)
    const options = await authenticationOptions(rp, { userVerification: 'required' });
    ceremony.start(req, res, { kind: 'login', challenge: options.challenge });
    res.json({ options });
  });

  router.post('/auth/passkey/verify', sameOrigin, large, limited(passkeyAttempts, PASSKEY_LIMITS.windowMs), async (req, res) => {
    if (!rp.available) return unavailable(res);
    const input = body(req);
    const started = ceremony.take(req, res, 'login');
    if (!started) return refused(req, res, 'no_challenge');
    const credentialId = credentialIdOf(input.response);
    const found = credentialId ? directory.findCredential(credentialId) : null;
    if (!found) return refused(req, res, 'unknown_credential');
    const { account, passkey } = found;
    const handle = input.response?.response?.userHandle;
    if (handle && handle !== account.webauthnUserId) return refused(req, res, 'wrong_user');
    let result;
    try {
      result = await verifyAuthentication(rp, started, input.response, passkey, { requireUserVerification: true });
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err;
      log.warn(err.message);
      return refused(req, res, err.reason, { account: account.id });
    }
    // Checked after the signature (whether an account is disabled is not for
    // strangers to learn), on the account as it is now
    const current = directory.get(account.id);
    if (!current || current.state !== 'active' || current.via !== 'local') return refused(req, res, 'account_inactive', { account: account.id });
    await directory.usePasskey(account.id, passkey.id, result);
    const user = directory.toUser(current);
    const session = auth.sessions.open(req, res, user);
    audit.log(req, 'auth.login', { method: 'passkey', session: session.id, role: user.role, passkey: passkey.id });
    res.json({ redirect: safeReturnPath(input.next) });
  });

  // ── Passkeys: the step a sign-in still owes ───────────────────────────────
  /**
   * The step in progress and its account, still holding the credentials the
   * step was started with (directory.js stepBinding: a reset or a change of
   * password, or passkeys cleared, end it), and active - or pending, for the
   * step of a sign-up through a link for several people (a pending account
   * cannot sign in, so it has no other step); null otherwise
   */
  function currentStep(req) {
    const step = auth.steps.peek(req);
    if (!step) return null;
    const account = directory.get(step.user.id);
    if (!account || !['active', 'pending'].includes(account.state) || account.via !== 'local') return null;
    if (!stepBindingHolds(step.binding, account)) return null;
    // The account may have registered a passkey since (another tab): then it signs in with it
    const kind = (account.passkeys ?? []).length ? 'passkey' : 'passkey-enrol';
    return { step, account, kind };
  }
  const stepExpired = (res) => sendError(res, 401, 'accounts.step_expired', 'Sign in again');

  router.post('/auth/passkey/step/options', sameOrigin, small, limited(stepAttempts, PASSKEY_LIMITS.windowMs), async (req, res) => {
    if (!rp.available) return unavailable(res);
    const current = currentStep(req);
    if (!current) {
      auth.steps.fail(req, res);
      return stepExpired(res);
    }
    const { account, kind } = current;
    if (kind === 'passkey-enrol') {
      const options = await registrationOptions(rp, account);
      ceremony.start(req, res, { kind: 'enrol', challenge: options.challenge, userId: account.id });
      return res.json({ kind, options });
    }
    const options = await authenticationOptions(rp, { credentials: account.passkeys, userVerification: 'preferred' });
    ceremony.start(req, res, { kind: 'step', challenge: options.challenge, userId: account.id });
    res.json({ kind, options });
  });

  router.post('/auth/passkey/step/verify', sameOrigin, large, limited(stepAttempts, PASSKEY_LIMITS.windowMs), async (req, res) => {
    if (!rp.available) return unavailable(res);
    const input = body(req);
    const current = currentStep(req);
    const started = current ? ceremony.take(req, res, current.kind === 'passkey-enrol' ? 'enrol' : 'step') : null;
    const fail = (reason) => {
      // A refused proof ends the step: the password has to be typed again (and is limited there)
      auth.steps.fail(req, res);
      audit.log(req, 'auth.login.failed', { method: 'local+passkey', reason, account: current?.account.id });
      return sendError(res, 401, 'accounts.passkey_refused', 'This passkey was not accepted. Sign in again');
    };
    if (!current) {
      auth.steps.fail(req, res);
      return stepExpired(res);
    }
    if (!started || started.userId !== current.account.id) return fail('no_challenge');
    const { account } = current;
    try {
      if (current.kind === 'passkey-enrol') {
        const passkey = await verifyRegistration(rp, started, input.response);
        // Checked again inside the write: a reset during the ceremony wins
        await directory.addPasskey(account.id, { ...passkey, name: defaultPasskeyName(req) }, { password: current.step.binding.password });
        req.user = directory.toUser(account);
        audit.log(req, 'accounts.passkey.add', { account: account.id, passkey: passkey.id, enrolment: true });
        changed('users');
      } else {
        const credentialId = credentialIdOf(input.response);
        const passkey = (account.passkeys ?? []).find((p) => p.id === credentialId);
        if (!passkey) return fail('unknown_credential');
        const result = await verifyAuthentication(rp, started, input.response, passkey, { requireUserVerification: false });
        await directory.usePasskey(account.id, passkey.id, result);
      }
    } catch (err) {
      if (!(err instanceof PasskeyError) && !err.code?.startsWith?.('accounts.')) throw err;
      log.warn(`passkey step refused for ${account.id}: ${err.message}`);
      return fail(err.reason ?? err.code);
    }
    // The account as it is now: an administrator may have changed its role or state during the step
    const now = directory.get(account.id);
    if (now?.state === 'pending') {
      // Signed up through a link for several people: the passkey is registered,
      // the account waits for an administrator; no session
      auth.steps.fail(req, res);
      return res.json({ pending: true });
    }
    if (!now || now.state !== 'active') return fail('account_inactive');
    const done = auth.steps.complete(req, res, { method: current.kind === 'passkey-enrol' ? 'passkey-enrol' : 'passkey', user: directory.toUser(now) });
    if (!done) return stepExpired(res);
    directory.touch(account.id);
    res.json(done);
  });

  return router;
}
