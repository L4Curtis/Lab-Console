/**
 * Identity: who is behind a request (ARCHITECTURE §5)
 *
 * createAuth(deps) returns the service every module receives as `deps.auth`:
 *
 *   auth.mode                          'on' | 'off'
 *   auth.attach(req, res, next)        sets req.user (or leaves it undefined)
 *   auth.requireAuth(req, res, next)   401 JSON under /api, 302 /login otherwise
 *   auth.requireRole('admin')          middleware, 403 JSON
 *   auth.authenticateUpgrade(req)      → User | null, for WebSocket upgrades
 *   auth.sessions.list() / .revoke(sessionId) / .revokeUser(userId)
 *   auth.router                        /login and /auth/*, mounted before the gate
 *   auth.shutdown?()
 *
 * Only the anonymous implementation exists in this build (AUTH_MODE=off): one
 * anonymous administrator, no login, exactly the upstream behaviour. The
 * surface above is the contract - the real sign-in replaces what is inside
 * this folder and nothing outside it
 */
import express from 'express';
import { sendError } from '../../lib/httpError.js';
import { ANONYMOUS, hasRole } from './user.js';

export { createUser, hasRole, ANONYMOUS, ROLES } from './user.js';

const isApiRequest = (req) => (req.originalUrl || req.url || '').startsWith('/api/');

/** Shared by every implementation: refuse a request that carries no user */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (isApiRequest(req) || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return sendError(res, 401, 'auth.required', 'Sign in to continue');
  }
  res.redirect(302, '/login');
}

/** Shared by every implementation: refuse a user whose role is too low */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 401, 'auth.required', 'Sign in to continue');
    if (!hasRole(req.user, role)) return sendError(res, 403, 'auth.forbidden', 'You are not allowed to do this', { role });
    next();
  };
}

export function createAuth({ config }) {
  const mode = config.auth?.mode ?? 'on';
  if (mode !== 'off') {
    throw new Error('AUTH_MODE=on needs the sign-in module, which this build does not include yet (set AUTH_MODE=off)');
  }

  const router = express.Router();
  // What the browser needs to know about its own session; never anything secret
  router.get('/auth/me', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ user: ANONYMOUS, mode, locale: config.defaultLocale, providerName: null });
  });
  // Nobody signs in when the mode is off: the login page is the application
  router.get('/login', (_req, res) => res.redirect(302, '/'));

  return {
    mode,
    attach(req, _res, next) {
      req.user = ANONYMOUS;
      next();
    },
    requireAuth,
    requireRole,
    authenticateUpgrade: () => ANONYMOUS,
    sessions: {
      list: () => [],
      revoke: () => false,
      revokeUser: () => 0,
    },
    router,
  };
}
