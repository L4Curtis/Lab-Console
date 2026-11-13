/**
 * Confirmation before a sensitive change (the lab parameters): the signed-in
 * administrator proves itself again, and gets a ticket the change must carry
 *
 *   - the environment's administrator: its password and a fresh one-time code
 *     (auth.reauthenticate; the code is burnt, as at sign-in);
 *   - a local account promoted to administrator: one of its passkeys
 *     (services.accounts.confirmation, the accounts module);
 *   - an SSO administrator signs in again at the identity provider (a fresh
 *     sign-in is asked for and checked, auth.oidc.trial with `reauth`). The
 *     browser leaves the page, so the change waits on the server (in memory,
 *     for this session only) and is applied when the same person comes back
 *     as an administrator; the outcome is read once, from the lab page
 *     (takeSsoOutcome). No session is opened or replaced by that trip.
 *
 * A ticket is 256 random bits, kept in memory only, valid 2 minutes, for one
 * change, by the same user in the same session. Attempts are limited per
 * user (10 per 15 minutes), successes included.
 */
import crypto from 'node:crypto';
import { httpError } from '../../lib/httpError.js';
import { createRateLimiter } from '../../lib/security.js';

export const TICKET_TTL_MS = 2 * 60_000;
const SSO_OUTCOME_TTL_MS = 10 * 60_000;

export function createConfirmations({ auth, services, now = Date.now }) {
  const tickets = new Map(); // ticket → { userId, sessionId, expires }
  const attempts = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const ssoOutcomes = new Map(); // session id → { userId, outcome, expires }

  const sweep = () => {
    const t = now();
    for (const [k, v] of tickets) if (v.expires <= t) tickets.delete(k);
  };

  /** How this user confirms: 'totp' | 'passkey' | 'sso' | null */
  function methodOf(user) {
    if (!user) return null;
    if (user.id === auth.environmentAdminId) return 'totp';
    if (services.accounts?.confirmation?.available(user)) return 'passkey';
    if (user.via === 'oidc' && auth.oidc.enabled) return 'sso';
    return null;
  }

  function issue(req) {
    sweep();
    const ticket = crypto.randomBytes(32).toString('base64url');
    const expires = now() + TICKET_TTL_MS;
    tickets.set(ticket, { userId: req.user.id, sessionId: req.sessionId, expires });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  return {
    methodOf,

    /** Options for navigator.credentials.get(), for a passkey confirmation */
    async options(req, res) {
      if (methodOf(req.user) !== 'passkey') throw httpError(409, 'admin.confirm_unavailable', 'This account cannot confirm with a passkey');
      return services.accounts.confirmation.options(req, res);
    },

    /** { password, code } or { response } → { ticket, expiresAt }; 401 admin.confirm_failed otherwise */
    async confirm(req, res, input) {
      const method = methodOf(req.user);
      // An SSO administrator confirms through the provider (beginSso), not with a form
      if (method !== 'totp' && method !== 'passkey') throw httpError(403, 'admin.confirm_unavailable', 'This account cannot confirm a sensitive change here: sign in with the environment administrator or an administrator account with a passkey');
      if (!attempts(req.user.id)) throw httpError(429, 'admin.confirm_throttled', 'Too many confirmation attempts: wait a few minutes');
      const ok = method === 'totp'
        ? await auth.reauthenticate(req.user, { password: input.password, code: input.code })
        : await services.accounts.confirmation.verify(req, res, input.response);
      if (!ok) throw httpError(401, 'admin.confirm_failed', 'The confirmation was not accepted');
      return issue(req);
    },

    /** Is this ticket good for this request? Throws 403 admin.confirm_required when it is missing, stale or someone else's; uses nothing up */
    verify(req, ticket) {
      sweep();
      const found = typeof ticket === 'string' ? tickets.get(ticket) : null;
      if (!found || found.userId !== req.user?.id || found.sessionId !== req.sessionId || found.expires <= now()) {
        throw httpError(403, 'admin.confirm_required', 'Confirm this change first (passkey, or password and code)');
      }
    },

    /**
     * Send an SSO administrator to sign in again at the provider; `apply()`
     * runs when it comes back as the same person, still an administrator,
     * with a fresh sign-in, and its result is kept for takeSsoOutcome().
     * → { url } for the browser. 403 admin.confirm_unavailable for any other account
     */
    async beginSso(req, res, apply) {
      if (methodOf(req.user) !== 'sso') throw httpError(403, 'admin.confirm_unavailable', 'This account does not confirm with the identity provider');
      if (!attempts(req.user.id)) throw httpError(429, 'admin.confirm_throttled', 'Too many confirmation attempts: wait a few minutes');
      const { id: userId } = req.user;
      const sessionId = req.sessionId;
      const keep = (outcome) => {
        const t = now();
        for (const [k, v] of ssoOutcomes) if (v.expires <= t) ssoOutcomes.delete(k);
        ssoOutcomes.set(sessionId, { userId, outcome, expires: t + SSO_OUTCOME_TTL_MS });
      };
      try {
        return await auth.oidc.trial(req, res, {
          returnTo: '/#/admin/lab',
          reauth: true,
          async onResult(answer) {
            if (!answer.ok) return keep({ ok: false, code: 'admin.sso_confirm_failed' });
            if (!answer.allowed || answer.userId !== userId || answer.role !== 'admin') return keep({ ok: false, code: 'admin.sso_confirm_mismatch' });
            // Signed out, or demoted, while at the provider: nothing is applied
            if (!auth.sessions.list().some((s) => s.id === sessionId && s.user.id === userId && s.user.role === 'admin')) {
              return keep({ ok: false, code: 'admin.sso_confirm_expired' });
            }
            try {
              keep({ ok: true, ...(await apply()) });
            } catch (err) {
              keep({ ok: false, code: err.code ?? 'server.internal', params: err.params ?? {}, message: err.message });
            }
          },
        });
      } catch (err) {
        if (err?.code === 'sso_disabled') throw httpError(409, 'admin.confirm_unavailable', 'The identity provider is not enabled');
        throw httpError(502, 'admin.sso_unreachable', 'The identity provider could not be reached');
      }
    },

    /** What came of the last trip to the provider for this session, once; null when there is none */
    takeSsoOutcome(req) {
      const found = ssoOutcomes.get(req.sessionId);
      ssoOutcomes.delete(req.sessionId);
      return found && found.userId === req.user?.id && found.expires > now() ? found.outcome : null;
    },

    /** Spend a ticket (it is good for one use, accepted or not) */
    spend(ticket) {
      if (typeof ticket === 'string') tickets.delete(ticket);
    },
  };
}
