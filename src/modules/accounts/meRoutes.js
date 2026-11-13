/**
 * My account (/api/accounts/me): what anyone signed in may change about
 * themselves. Below the gate, so req.user is always set
 *
 *   GET    /                        { account, passkeys, passkeysAvailable, sessions, canChangePassword }
 *   PATCH  /                        { name }                      local accounts
 *   POST   /password                { current, password }        local accounts; the other sessions end
 *   POST   /passkeys/options        → { options }                 local accounts
 *   POST   /passkeys                { response, name } → { passkey }
 *   PATCH  /passkeys/:id            { name }
 *   DELETE /passkeys/:id                                          an administrator keeps one
 *   POST   /sessions/end-others     → { ended }
 *   DELETE /sessions/:id            one of my own sessions
 *
 * SSO accounts get their name from the provider and sign in there: they
 * have no password and no passkey here. The environment's administrator is
 * changed in .env only: it sees its sessions and nothing to edit
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { createRateLimiter } from '../../lib/security.js';
import { hashPassword } from '../auth/password.js';
import { checkPassword, cleanDisplayName } from './policy.js';
import { environmentAccount } from './directory.js';
import { registrationOptions, verifyRegistration, PasskeyError } from './passkeys.js';
import { passwordProblem, defaultPasskeyName } from './publicRoutes.js';

export function meRoutes(ctx) {
  const { config, auth, audit, directory, links, rp, ceremony, changed, passwordCost, log } = ctx;
  const router = express.Router();
  const small = express.json({ limit: '4kb' });
  const large = express.json({ limit: '32kb' });
  // Limits are per user (ARCHITECTURE §13): a stolen session must not test passwords at leisure
  const passwordChecks = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
  const body = (req) => (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  const isEnvironmentAdmin = (req) => req.user.id === `local:${config.auth.localAdmin.username}`;
  /** The caller's local account, or a 400 explaining why there is none */
  function localAccount(req) {
    if (isEnvironmentAdmin(req)) throw httpError(400, 'accounts.environment_admin', 'The administrator of the environment is changed in its configuration only');
    const account = directory.get(req.user.id);
    if (!account) throw httpError(404, 'accounts.unknown', 'No such account');
    if (account.via !== 'local') throw httpError(400, 'accounts.not_local', 'This account signs in through the identity provider');
    return account;
  }

  const mySessions = (req) => auth.sessions.list()
    .filter((s) => s.user.id === req.user.id)
    .map(({ id, createdAt, lastSeenAt, expiresAt, ip, userAgent, connections }) => ({ id, createdAt, lastSeenAt, expiresAt, ip, userAgent, connections, current: id === req.sessionId }));

  router.get('/', (req, res) => {
    const account = isEnvironmentAdmin(req) ? null : directory.get(req.user.id);
    const local = account?.via === 'local';
    res.json({
      account: account ? directory.summary(account) : isEnvironmentAdmin(req) ? environmentAccount(config.auth.localAdmin.username) : { ...req.user, state: 'active', environment: false },
      passkeys: local ? (account.passkeys ?? []).map(directory.passkeyView) : [],
      passkeysAvailable: rp.available,
      canChangePassword: local,
      canAddPasskeys: local && rp.available,
      sessions: mySessions(req),
    });
  });

  router.patch('/', small, async (req, res) => {
    const account = localAccount(req);
    const name = cleanDisplayName(body(req).name);
    if (!name) throw httpError(400, 'accounts.name_invalid', 'Give a display name of 1 to 64 characters');
    const summary = await directory.setName(account.id, name);
    audit.log(req, 'accounts.name', { account: account.id });
    changed('users');
    res.json({ account: summary });
  });

  router.post('/password', small, async (req, res) => {
    const account = localAccount(req);
    const input = body(req);
    if (!passwordChecks(req.user.id)) {
      res.set('Retry-After', '900');
      throw httpError(429, 'accounts.throttled', 'Too many attempts. Try again later');
    }
    if (!await directory.checkPassword(account.id, input.current)) {
      audit.log(req, 'accounts.password.change.failed', { account: account.id });
      throw httpError(403, 'accounts.wrong_password', 'The current password is not right');
    }
    const weak = checkPassword(input.password, { username: account.username });
    if (weak) return passwordProblem(res, weak);
    await directory.setPassword(account.id, await hashPassword(input.password, passwordCost));
    await links.revokeResets(account.id, { id: req.user.id, username: req.user.username });
    // The other browsers signed in with the old password are signed out; this one stays
    let ended = 0;
    for (const s of auth.sessions.list()) {
      if (s.user.id === req.user.id && s.id !== req.sessionId && auth.sessions.revoke(s.id)) ended += 1;
    }
    audit.log(req, 'accounts.password.change', { account: account.id, sessionsEnded: ended });
    res.json({ ok: true, sessionsEnded: ended });
  });

  // ── Passkeys ───────────────────────────────────────────────────────────────
  router.post('/passkeys/options', small, async (req, res) => {
    const account = localAccount(req);
    if (!rp.available) throw httpError(409, 'accounts.passkeys_unavailable', 'Passkeys need Lab Console to be served over https');
    const options = await registrationOptions(rp, account);
    ceremony.start(req, res, { kind: 'register', challenge: options.challenge, userId: account.id, sessionId: req.sessionId });
    res.json({ options });
  });

  router.post('/passkeys', large, async (req, res) => {
    const account = localAccount(req);
    if (!rp.available) throw httpError(409, 'accounts.passkeys_unavailable', 'Passkeys need Lab Console to be served over https');
    const input = body(req);
    const started = ceremony.take(req, res, 'register');
    if (!started || started.userId !== account.id || started.sessionId !== req.sessionId) {
      throw httpError(400, 'accounts.passkey_refused', 'This passkey was not accepted');
    }
    let passkey;
    try {
      passkey = await verifyRegistration(rp, started, input.response);
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err;
      log.warn(`passkey registration refused for ${account.id}: ${err.message}`);
      audit.log(req, 'accounts.passkey.add.failed', { account: account.id, reason: err.reason });
      throw httpError(400, 'accounts.passkey_refused', 'This passkey was not accepted');
    }
    const name = cleanDisplayName(input.name) ?? defaultPasskeyName(req);
    const view = await directory.addPasskey(account.id, { ...passkey, name });
    audit.log(req, 'accounts.passkey.add', { account: account.id, passkey: passkey.id });
    changed('users');
    res.json({ passkey: view });
  });

  router.patch('/passkeys/:id', small, async (req, res) => {
    const account = localAccount(req);
    const name = cleanDisplayName(body(req).name);
    if (!name) throw httpError(400, 'accounts.name_invalid', 'Give a name of 1 to 64 characters');
    const view = await directory.renamePasskey(account.id, req.params.id, name);
    audit.log(req, 'accounts.passkey.rename', { account: account.id, passkey: req.params.id });
    res.json({ passkey: view });
  });

  router.delete('/passkeys/:id', async (req, res) => {
    const account = localAccount(req);
    await directory.removePasskey(account.id, req.params.id);
    audit.log(req, 'accounts.passkey.remove', { account: account.id, passkey: req.params.id });
    changed('users');
    res.json({ ok: true });
  });

  // ── Sessions ───────────────────────────────────────────────────────────────
  router.post('/sessions/end-others', (req, res) => {
    let ended = 0;
    for (const s of mySessions(req)) if (!s.current && auth.sessions.revoke(s.id)) ended += 1;
    audit.log(req, 'accounts.sessions.end_others', { ended });
    res.json({ ended });
  });

  router.delete('/sessions/:id', (req, res) => {
    const mine = mySessions(req).find((s) => s.id === req.params.id);
    if (!mine) throw httpError(404, 'accounts.unknown_session', 'No such session');
    auth.sessions.revoke(mine.id);
    audit.log(req, 'accounts.sessions.end', { session: mine.id, current: mine.current });
    res.json({ ok: true, current: mine.current });
  });

  return router;
}
