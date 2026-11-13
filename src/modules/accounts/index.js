/**
 * Accounts: the directory, invitations, password reset links, passkeys and
 * the identity provider's settings (SPEC, lot accounts)
 *
 * Built on the sign-in module's extension points (ARCHITECTURE §5), never
 * around them:
 *   - auth.accounts.add(directory.provider)   local accounts sign in on the same form
 *   - auth.sessions.open / auth.steps         a passkey or an invitation ends in the same kind of session
 *   - auth.extend(publicRouter)               the sign-up and passkey routes, above the gate
 *   - auth.oidc.configure / auth.oidc.trial   the SSO settings page
 *   - services.accounts                       read by the sign-in module at every provider sign-in
 *                                             (role set by an administrator, disabled accounts)
 *
 * Routes below the gate (/api/accounts):
 *   me/…        anyone signed in: My account (name, password, passkeys, sessions)
 *   users, invitations, sso/…   administrators only
 * Public routes (publicRoutes.js): /join, /reset, /js/join.js, /auth/invitation,
 * /auth/signup, /auth/reset-link, /auth/reset, /auth/passkey/…
 *
 * Every change of a role or a state ends the account's sessions, and with
 * them its consoles and live streams (auth.sessions.revokeUser)
 */
import express from 'express';
import { readCookie, serializeCookie, clearCookie, appendCookie } from '../auth/cookies.js';
import { SCRYPT_DEFAULTS } from '../auth/password.js';
import { clientIp } from '../../lib/security.js';
import { createRefusalAudit } from '../auth/refusals.js';
import { createDirectory, environmentAccount } from './directory.js';
import { createLinks } from './links.js';
import { createSso } from './sso.js';
import { relyingParty, createCeremonies, CEREMONY_TTL_MS } from './passkeys.js';
import { publicRoutes } from './publicRoutes.js';
import { meRoutes } from './meRoutes.js';
import { adminRoutes } from './adminRoutes.js';

/** One write at a time for operations that touch both files (a sign-up uses a link and creates an account) */
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * deps: the platform's (ARCHITECTURE §6). options: passwordCost (scrypt
 * parameters, a test seam: tests use the cheapest the platform accepts),
 * now (a clock), fetchOptions (the SSO test's guarded fetch, a test seam)
 */
export function createAccountsModule({ config, logger, events, store, audit, auth, services }, { passwordCost = SCRYPT_DEFAULTS, now = Date.now, fetchOptions } = {}) {
  const log = logger?.child ? logger.child('accounts') : logger ?? { info() {}, warn() {}, error() {} };
  const publicUrl = config.server.publicUrl;
  const directory = createDirectory({ store, envAdminName: config.auth.localAdmin.username, now, passwordCost, logger: log });
  const links = createLinks({ store, now });
  const sso = createSso({ config, store, auth, logger: log, now, fetchOptions });
  const rp = relyingParty(publicUrl);
  const ceremonies = createCeremonies({ now });
  const refusals = createRefusalAudit({ audit, now });
  const housekeeping = setInterval(() => refusals.flush(), 5 * 60_000);
  housekeeping.unref();

  // The passkey ceremony in progress, bound to the browser by an HttpOnly cookie
  const secure = publicUrl.startsWith('https://');
  const passkeyCookie = `${secure ? '__Host-' : ''}lc_passkey`;
  const ceremony = {
    start(req, res, data) {
      ceremonies.discard(readCookie(req, passkeyCookie));
      const id = ceremonies.put(data, { owner: clientIp(req, config.server) });
      appendCookie(res, serializeCookie(passkeyCookie, id, { secure, maxAgeSeconds: CEREMONY_TTL_MS / 1000 }));
    },
    /** Single use: forgotten before anything is checked. null unless it is a ceremony of this kind */
    take(req, res, kind) {
      const found = ceremonies.take(readCookie(req, passkeyCookie));
      appendCookie(res, clearCookie(passkeyCookie, { secure }));
      return found?.kind === kind ? found : null;
    },
  };

  /** Tell the open administration pages that the directory or the links changed */
  const changed = (what) => events?.publish('accounts:changed', { what, at: now() }, { audience: (user) => user?.role === 'admin' });

  const ctx = {
    config, log, audit, auth, events, directory, links, sso, rp, ceremony, refusals, changed, now, passwordCost,
    exclusive: createMutex(),
    linkUrl: (kind, token) => `${publicUrl}/${kind === 'reset' ? 'reset' : 'join'}#${token}`,
  };

  // ── Wiring into the sign-in module ─────────────────────────────────────────
  const removeProvider = auth.accounts.add(directory.provider);
  auth.extend(publicRoutes(ctx), { describe: () => ({ passkeys: rp.available }) });
  sso.load();

  services.accounts = {
    /** → Account ({ id, username, name, role, state, via, hasPasskey, … }) or null */
    get(userId) {
      if (userId === `local:${config.auth.localAdmin.username}`) return environmentAccount(config.auth.localAdmin.username);
      const account = directory.get(userId);
      return account ? directory.summary(account) : null;
    },
    list: () => [environmentAccount(config.auth.localAdmin.username), ...directory.list().map(directory.summary)],
    /** The role an administrator forced on this SSO account, or null (its groups decide) */
    roleOverride(userId) {
      const account = directory.get(userId);
      return account?.via === 'oidc' ? account.roleOverride ?? null : null;
    },
    /** Called by the sign-in module when an SSO account signs in: recorded; false when disabled */
    admit: (user, { groupRole } = {}) => directory.admitSso(user, { groupRole }),
  };

  const router = express.Router();
  router.use('/me', meRoutes(ctx));
  router.use(auth.requireRole('admin'), adminRoutes(ctx));

  return {
    id: 'accounts',
    title: 'Accounts',
    enabled: true,
    router,
    shutdown() {
      clearInterval(housekeeping);
      refusals.flush({ force: true });
      removeProvider();
    },
  };
}
