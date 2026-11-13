/**
 * Administration of accounts (/api/accounts, administrators only: the
 * module mounts this router behind auth.requireRole('admin'))
 *
 *   GET    /users                      { users, passkeysAvailable }   the environment's administrator first
 *   PATCH  /users/:id                  { role } and / or { state: 'active' | 'disabled' }
 *                                      SSO accounts: role null = back to the groups
 *   POST   /users/:id/approve | /reject   a pending account (rejected = removed)
 *   POST   /users/:id/reset-link       { ttl: '1h' | '24h' } → { url, expiresAt }   local accounts
 *   DELETE /users/:id/passkeys         a lost device: a promoted administrator registers anew at the next sign-in
 *   GET    /invitations                { invitations }
 *   POST   /invitations                { ttl: '1h' | '24h' | '7d', uses: 1…100, role, note } → { invitation, url }
 *   DELETE /invitations/:id            revoke
 *   GET    /sso                        { locked, source, settings (no secret), callbackUrl, encrypted, secretUnreadable }
 *   PUT    /sso                        save and apply (refused when the environment sets the provider)
 *   POST   /sso/test                   { issuer?, allowInsecure? } → the discovery document's summary
 *   POST   /sso/trial                  → { url }: a sign-in at the provider that opens no session
 *   GET    /sso/trial                  → { result } of the last trial of this session (once)
 *
 * Any change of a role or a state ends the account's sessions at once (its
 * consoles and live streams with them). A link's token is in the answer that
 * creates it and nowhere else
 */
import express from 'express';
import { httpError, sendError } from '../../lib/httpError.js';
import { ROLES } from '../auth/user.js';
import { LINK_TTLS, RESET_TTLS, MAX_USES } from './links.js';
import { environmentAccount } from './directory.js';

export function adminRoutes(ctx) {
  const { config, auth, audit, directory, links, sso, rp, changed, linkUrl, log } = ctx;
  const router = express.Router();
  const small = express.json({ limit: '4kb' });
  const body = (req) => (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const environmentId = `local:${config.auth.localAdmin.username}`;
  const actorOf = (req) => ({ id: req.user.id, username: req.user.username });

  /** The account behind :id; the environment's administrator cannot be changed from here */
  function target(req) {
    if (req.params.id === environmentId) throw httpError(400, 'accounts.environment_admin', 'The administrator of the environment is changed in its configuration only');
    const account = directory.get(req.params.id);
    if (!account) throw httpError(404, 'accounts.unknown', 'No such account');
    return account;
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  router.get('/users', (_req, res) => {
    res.json({ users: [environmentAccount(config.auth.localAdmin.username), ...directory.list().map(directory.summary)], passkeysAvailable: rp.available });
  });

  router.patch('/users/:id', small, async (req, res) => {
    const account = target(req);
    const input = body(req);
    const wantsRole = Object.hasOwn(input, 'role');
    const wantsState = Object.hasOwn(input, 'state');
    if (!wantsRole && !wantsState) throw httpError(400, 'server.bad_request', 'Nothing to change');
    if (wantsRole && !(ROLES.includes(input.role) || (input.role === null && account.via === 'oidc'))) {
      throw httpError(400, 'accounts.bad_role', 'Unknown role');
    }
    if (wantsState && !['active', 'disabled'].includes(input.state)) throw httpError(400, 'accounts.bad_state', 'Unknown state');
    // A local administrator signs in with a passkey: there must be a way to register one
    if (wantsRole && input.role === 'admin' && account.via === 'local' && !rp.available) {
      throw httpError(409, 'accounts.passkeys_unavailable', 'A local account can only be an administrator when passkeys are available (https)');
    }

    let summary = directory.summary(account);
    const entries = [];
    if (wantsRole) {
      const { before, after, changed: stored, account: updated } = await directory.setRole(account.id, input.role);
      summary = updated;
      if (stored) entries.push(['accounts.role', { account: account.id, username: account.username, from: before, to: after, ...(account.via === 'oidc' ? { forced: input.role } : {}) }]);
    }
    if (wantsState) {
      const { before, after, account: updated } = await directory.setState(account.id, input.state);
      summary = updated;
      if (before !== after) entries.push(['accounts.state', { account: account.id, username: account.username, from: before, to: after }]);
    }
    // Whatever changed, the account starts again from a sign-in that sees the change
    const ended = entries.length ? auth.sessions.revokeUser(account.id) : 0;
    for (const [action, details] of entries) audit.log(req, action, { ...details, sessionsEnded: ended });
    if (entries.length) changed('users');
    res.json({ account: summary, sessionsEnded: ended });
  });

  router.post('/users/:id/approve', async (req, res) => {
    const account = target(req);
    const summary = await directory.approve(account.id);
    audit.log(req, 'accounts.approve', { account: account.id, username: account.username });
    changed('users');
    res.json({ account: summary });
  });

  router.post('/users/:id/reject', async (req, res) => {
    const account = target(req);
    await directory.reject(account.id);
    audit.log(req, 'accounts.reject', { account: account.id, username: account.username });
    changed('users');
    res.json({ ok: true });
  });

  router.post('/users/:id/reset-link', small, async (req, res) => {
    const account = target(req);
    if (account.via !== 'local') throw httpError(400, 'accounts.not_local', 'This account signs in through the identity provider');
    const ttl = body(req).ttl ?? '1h';
    if (!Object.hasOwn(RESET_TTLS, ttl)) throw httpError(400, 'accounts.bad_ttl', 'Unknown duration');
    const { link, token } = await links.create({ kind: 'reset', accountId: account.id, ttlMs: RESET_TTLS[ttl], createdBy: actorOf(req) });
    audit.log(req, 'accounts.reset_link.create', { account: account.id, username: account.username, link: link.id, expiresAt: link.expiresAt });
    res.json({ url: linkUrl('reset', token), expiresAt: link.expiresAt });
  });

  router.delete('/users/:id/passkeys', async (req, res) => {
    const account = target(req);
    if (account.via !== 'local') throw httpError(400, 'accounts.not_local', 'This account signs in through the identity provider');
    const removed = await directory.clearPasskeys(account.id);
    const ended = auth.sessions.revokeUser(account.id);
    audit.log(req, 'accounts.passkeys.clear', { account: account.id, username: account.username, removed, sessionsEnded: ended });
    changed('users');
    res.json({ removed, sessionsEnded: ended });
  });

  // ── Invitations ────────────────────────────────────────────────────────────
  router.get('/invitations', (_req, res) => res.json({ invitations: links.list({ kind: 'invite' }), passkeysAvailable: rp.available }));

  router.post('/invitations', small, async (req, res) => {
    const input = body(req);
    const ttl = input.ttl ?? '24h';
    const uses = input.uses ?? 1;
    const role = input.role ?? 'student';
    if (!Object.hasOwn(LINK_TTLS, ttl)) throw httpError(400, 'accounts.bad_ttl', 'Unknown duration');
    if (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES) throw httpError(400, 'accounts.bad_uses', 'Between 1 and 100 people', { max: MAX_USES });
    if (!ROLES.includes(role)) throw httpError(400, 'accounts.bad_role', 'Unknown role');
    if (role === 'admin' && !rp.available) throw httpError(409, 'accounts.passkeys_unavailable', 'A local account can only be an administrator when passkeys are available (https)');
    const note = typeof input.note === 'string' ? input.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
    const { link, token } = await links.create({ kind: 'invite', role, maxUses: uses, ttlMs: LINK_TTLS[ttl], createdBy: actorOf(req), note });
    audit.log(req, 'accounts.invitation.create', { link: link.id, role, uses, ttl });
    changed('invitations');
    res.json({ invitation: link, url: linkUrl('invite', token) });
  });

  router.delete('/invitations/:id', async (req, res) => {
    const revoked = await links.revoke(req.params.id, actorOf(req));
    if (!revoked || revoked.kind !== 'invite') return sendError(res, 404, 'accounts.unknown_invitation', 'No such invitation');
    audit.log(req, 'accounts.invitation.revoke', { link: revoked.id });
    changed('invitations');
    res.json({ invitation: revoked });
  });

  // ── Sign-in (SSO) ──────────────────────────────────────────────────────────
  router.get('/sso', (_req, res) => res.json(sso.describe()));

  router.put('/sso', small, async (req, res) => {
    let outcome;
    try {
      outcome = await sso.save(body(req));
    } catch (err) {
      if (!err.code?.startsWith?.('accounts.')) throw err;
      return sendError(res, err.status, err.code, err.message, err.problems?.length ? { problems: err.problems } : {});
    }
    // Never the secret: only that it changed
    audit.log(req, 'accounts.sso.update', { changed: outcome.changed, clientAuthChanged: outcome.secretChanged, issuer: auth.oidc.settings.issuer, enabled: auth.oidc.settings.enabled });
    log.info(`identity provider settings changed by ${req.user.username}`);
    res.json(sso.describe());
  });

  router.post('/sso/test', small, async (req, res) => {
    const input = body(req);
    const result = await sso.test({ issuer: input.issuer, allowInsecure: input.allowInsecure });
    audit.log(req, 'accounts.sso.test', { issuer: typeof input.issuer === 'string' ? input.issuer.slice(0, 300) : auth.oidc.settings.issuer, ok: result.ok, reason: result.reason });
    res.json(result);
  });

  router.post('/sso/trial', async (req, res) => {
    if (!auth.oidc.enabled) throw httpError(409, 'accounts.sso_disabled', 'Enable and save the identity provider first');
    const sessionId = req.sessionId;
    const by = req.user;
    let started;
    try {
      started = await auth.oidc.trial(req, res, {
        returnTo: '/#/admin/sso',
        onResult: (result) => {
          sso.keepTrial(sessionId, result);
          audit.log(by, 'accounts.sso.trial', { ok: result.ok, username: result.username, role: result.role, allowed: result.allowed, error: result.error });
        },
      });
    } catch (err) {
      log.warn(`trial sign-in could not start: ${err.message}`);
      throw httpError(502, 'accounts.sso_unreachable', 'The identity provider could not be reached');
    }
    res.json(started);
  });

  router.get('/sso/trial', (req, res) => res.json({ result: sso.takeTrial(req.sessionId) }));

  return router;
}
