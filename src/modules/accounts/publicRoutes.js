/**
 * The accounts module's routes that work without a session, mounted above
 * the gate through auth.extend() (each one checks what it needs itself):
 *
 *   GET  /join, /reset           the page of an invitation or a reset link (the token is in the fragment)
 *   GET  /js/join.js             its script
 *   POST /auth/invitation        { token } → { role, approval, expiresAt }      what an invitation offers
 *   POST /auth/signup            { token, username, name, password } → { redirect } | { step } | { pending }
 *   POST /auth/reset-link        { token } → { username, expiresAt }            whose password a link resets
 *   POST /auth/reset             { token, password } → { ok }                   the account's sessions end
 *   POST /auth/passkey/options   → { options }                one-click sign-in: any passkey of this site
 *   POST /auth/passkey/verify    { response, next } → { redirect }
 *   POST /auth/passkey/step/options   → { kind, options }     the passkey a password sign-in still owes
 *   POST /auth/passkey/step/verify    { response } → { redirect }
 *
 * Every refusal of a link is the same 404 (`accounts.link_invalid`) whether
 * the token is unknown, expired, revoked or used up; the audit trail keeps
 * the reason. All of it is limited per client address (nobody is signed in
 * yet, so the address is the only key there is) and the sign-up per link
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sendError } from '../../lib/httpError.js';
import { requireSameOrigin, createRateLimiter, clientIp } from '../../lib/security.js';
import { hashPassword } from '../auth/password.js';
import { safeReturnPath } from '../auth/pendingLogins.js';
import { checkUsername, checkPassword, cleanDisplayName } from './policy.js';
import {
  registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication, credentialIdOf, PasskeyError,
} from './passkeys.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public');
const WINDOW = 15 * 60_000;

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
  const { config, auth, audit, directory, links, rp, ceremony, refusals, changed, exclusive, passwordCost, log } = ctx;
  const router = express.Router();
  const sameOrigin = requireSameOrigin(config.server.allowedOrigins);
  const small = express.json({ limit: '4kb' });
  const large = express.json({ limit: '32kb' }); // WebAuthn responses carry keys and signatures
  // A classroom shares one public address: generous per address, strict per link
  const linkAttempts = createRateLimiter({ limit: 120, windowMs: WINDOW });
  const signupFailures = createFailureCounter({ limit: 10, windowMs: WINDOW });
  const passkeyAttempts = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const addressOf = (req) => clientIp(req, config.server);
  const body = (req) => (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const limited = (limiter) => (req, res, next) => {
    if (limiter(addressOf(req))) return next();
    res.set('Retry-After', String(WINDOW / 1000));
    sendError(res, 429, 'accounts.throttled', 'Too many attempts. Try again later');
  };
  const noStore = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  };

  /** One answer for every unusable link; the reason goes to the audit trail (once per address and reason) */
  function badLink(req, res, problem, kind) {
    refusals.record(req, addressOf(req), `link:${problem}`, { method: kind, reason: problem });
    return sendError(res, 404, 'accounts.link_invalid', 'This link is not valid: it may have expired, been used or been withdrawn');
  }

  const page = (_req, res) => res.sendFile(path.join(publicDir, 'join.html'));
  router.get('/join', noStore, page);
  router.get('/reset', noStore, page);
  router.get('/js/join.js', (_req, res) => res.sendFile(path.join(publicDir, 'js', 'join.js')));

  // ── Invitations ────────────────────────────────────────────────────────────
  router.post('/auth/invitation', sameOrigin, small, limited(linkAttempts), (req, res) => {
    const { link, problem } = links.find(body(req).token, { kind: 'invite' });
    if (problem) return badLink(req, res, problem, 'invitation');
    res.json({ role: link.role, approval: link.maxUses > 1, expiresAt: new Date(link.expiresAt).toISOString() });
  });

  router.post('/auth/signup', sameOrigin, small, limited(linkAttempts), async (req, res) => {
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
    const usernameProblem = checkUsername(username);
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
    if (created.state === 'pending') return res.json({ pending: true });
    // A single-use link: the account is active at once. An administrator still owes a passkey first
    if (user.role === 'admin') {
      auth.steps.start(req, res, user, ['passkey-enrol'], { method: 'signup' });
      return res.json({ step: 'passkey-enrol' });
    }
    const session = auth.sessions.open(req, res, user);
    audit.log(req, 'auth.login', { method: 'signup', session: session.id, role: user.role });
    directory.touch(user.id);
    res.json({ redirect: '/' });
  });

  // ── Password reset links ───────────────────────────────────────────────────
  function resetTarget(token) {
    const { link, problem } = links.find(token, { kind: 'reset' });
    if (problem) return { problem };
    const account = directory.get(link.accountId);
    if (!account || account.via !== 'local') return { problem: 'unknown' };
    return { link, account };
  }

  router.post('/auth/reset-link', sameOrigin, small, limited(linkAttempts), (req, res) => {
    const target = resetTarget(body(req).token);
    if (target.problem) return badLink(req, res, target.problem, 'reset');
    res.json({ username: target.account.username, expiresAt: new Date(target.link.expiresAt).toISOString() });
  });

  router.post('/auth/reset', sameOrigin, small, limited(linkAttempts), async (req, res) => {
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
      await directory.setPassword(again.account.id, passwordHash);
      return again;
    });
    if (outcome.problem) return badLink(req, res, outcome.problem, 'reset');
    // Whoever was signed in with the old password is not any more
    const ended = auth.sessions.revokeUser(outcome.account.id);
    req.user = directory.toUser(outcome.account);
    audit.log(req, 'accounts.password.reset', { account: outcome.account.id, link: outcome.link.id, sessionsEnded: ended });
    res.json({ ok: true });
  });

  // ── Passkeys: one-click sign-in ────────────────────────────────────────────
  const unavailable = (res) => sendError(res, 409, 'accounts.passkeys_unavailable', 'Passkeys need Lab Console to be served over https');
  const refused = (req, res, reason, details = {}) => {
    refusals.record(req, addressOf(req), `passkey:${reason}`, { method: 'passkey', reason, ...details });
    return sendError(res, 401, 'accounts.passkey_refused', 'This passkey was not accepted');
  };

  router.post('/auth/passkey/options', sameOrigin, small, limited(passkeyAttempts), async (req, res) => {
    if (!rp.available) return unavailable(res);
    // A passkey that signs in alone must have checked who holds it (PIN, fingerprint)
    const options = await authenticationOptions(rp, { userVerification: 'required' });
    ceremony.start(req, res, { kind: 'login', challenge: options.challenge });
    res.json({ options });
  });

  router.post('/auth/passkey/verify', sameOrigin, large, limited(passkeyAttempts), async (req, res) => {
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
    // Checked after the signature: whether an account is disabled is not for strangers to learn
    if (account.state !== 'active' || account.via !== 'local') return refused(req, res, 'account_inactive', { account: account.id });
    await directory.usePasskey(account.id, passkey.id, result);
    const user = directory.toUser(account);
    const session = auth.sessions.open(req, res, user);
    audit.log(req, 'auth.login', { method: 'passkey', session: session.id, role: user.role, passkey: passkey.id });
    res.json({ redirect: safeReturnPath(input.next) });
  });

  // ── Passkeys: the step a password sign-in still owes ──────────────────────
  /** The step in progress and its account, still active; null otherwise */
  function currentStep(req) {
    const step = auth.steps.peek(req);
    if (!step) return null;
    const account = directory.get(step.user.id);
    if (!account || account.state !== 'active' || account.via !== 'local') return null;
    // The account may have registered a passkey since (another tab): then it signs in with it
    const kind = (account.passkeys ?? []).length ? 'passkey' : 'passkey-enrol';
    return { step, account, kind };
  }
  const stepExpired = (res) => sendError(res, 401, 'accounts.step_expired', 'Sign in again');

  router.post('/auth/passkey/step/options', sameOrigin, small, limited(passkeyAttempts), async (req, res) => {
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

  router.post('/auth/passkey/step/verify', sameOrigin, large, limited(passkeyAttempts), async (req, res) => {
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
        await directory.addPasskey(account.id, { ...passkey, name: defaultPasskeyName(req) });
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
    const done = auth.steps.complete(req, res, { method: current.kind === 'passkey-enrol' ? 'passkey-enrol' : 'passkey' });
    if (!done) return stepExpired(res);
    directory.touch(account.id);
    res.json(done);
  });

  return router;
}
