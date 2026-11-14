/**
 * The gate: what a request without a user, or with too low a role, gets
 *
 *   requireAuth(req, res, next)   401 JSON under /api and for writes, 302 /login otherwise
 *   requireRole('admin')          middleware, 401 without a user, 403 JSON below the role
 */
import { sendError } from '../../lib/httpError.js';
import { hasRole } from './user.js';
import { safeReturnPath } from './pendingLogins.js';

const isApiRequest = (req) => (req.originalUrl || req.url || '').startsWith('/api/');

/** Refuse a request that carries no user */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (isApiRequest(req) || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return sendError(res, 401, 'auth.required', 'Sign in to continue');
  }
  const back = safeReturnPath(req.originalUrl);
  res.redirect(302, back === '/' ? '/login' : `/login?next=${encodeURIComponent(back)}`);
}

/** Refuse a user whose role is too low */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 401, 'auth.required', 'Sign in to continue');
    if (!hasRole(req.user, role)) return sendError(res, 403, 'auth.forbidden', 'You are not allowed to do this', { role });
    next();
  };
}
