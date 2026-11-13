/**
 * Confirmation before a sensitive change (the lab parameters): the signed-in
 * administrator proves itself again, and gets a ticket the change must carry
 *
 *   - the environment's administrator: its password and a fresh one-time code
 *     (auth.reauthenticate; the code is burnt, as at sign-in);
 *   - a local account promoted to administrator: one of its passkeys
 *     (services.accounts.confirmation, the accounts module);
 *   - an SSO administrator has neither on this server: it cannot confirm, and
 *     the page says to use one of the two accounts above.
 *
 * A ticket is 256 random bits, kept in memory only, valid 2 minutes, for one
 * change, by the same user in the same session. Attempts are limited per
 * user (10 per 15 minutes), successes included.
 */
import crypto from 'node:crypto';
import { httpError } from '../../lib/httpError.js';
import { createRateLimiter } from '../../lib/security.js';

export const TICKET_TTL_MS = 2 * 60_000;

export function createConfirmations({ auth, services, now = Date.now }) {
  const tickets = new Map(); // ticket → { userId, sessionId, expires }
  const attempts = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });

  const sweep = () => {
    const t = now();
    for (const [k, v] of tickets) if (v.expires <= t) tickets.delete(k);
  };

  /** How this user confirms: 'totp' | 'passkey' | null */
  function methodOf(user) {
    if (!user) return null;
    if (user.id === auth.environmentAdminId) return 'totp';
    if (services.accounts?.confirmation?.available(user)) return 'passkey';
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
      if (!method) throw httpError(403, 'admin.confirm_unavailable', 'This account cannot confirm a sensitive change: sign in with the environment administrator or an administrator account with a passkey');
      if (!attempts(req.user.id)) throw httpError(429, 'admin.confirm_throttled', 'Too many confirmation attempts: wait a few minutes');
      const ok = method === 'totp'
        ? await auth.reauthenticate(req.user, { password: input.password, code: input.code })
        : await services.accounts.confirmation.verify(req, res, input.response);
      if (!ok) throw httpError(401, 'admin.confirm_failed', 'The confirmation was not accepted');
      return issue(req);
    },

    /** Use a ticket for one change; throws 403 admin.confirm_required when it is missing, stale or someone else's */
    consume(req, ticket) {
      sweep();
      const found = typeof ticket === 'string' ? tickets.get(ticket) : null;
      if (found) tickets.delete(ticket);
      if (!found || found.userId !== req.user?.id || found.sessionId !== req.sessionId || found.expires <= now()) {
        throw httpError(403, 'admin.confirm_required', 'Confirm this change first (passkey, or password and code)');
      }
    },
  };
}
