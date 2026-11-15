/**
 * Signing in through the identity provider (OpenID Connect):
 *
 *   GET /auth/login      start a sign-in        ?next=/path
 *   GET /auth/callback   the provider sends the browser back here
 *
 * and the sign-in that opens no session (the SSO settings page, an SSO
 * administrator's confirmation: auth.oidc.trial), which comes back through
 * the same callback. The provider is replaceable at run time: `provider`
 * hands out the current client and settings
 */
import express from 'express';
import { createRateLimiter, clientIp } from '../../lib/security.js';
import { readCookie, serializeCookie, clearCookie, appendCookie } from './cookies.js';
import { safeReturnPath } from './pendingLogins.js';
import { OidcError } from './oidc.js';
import { userFromClaims, needsUserinfo, subjectOf, groupsFrom } from './claims.js';

/**
 * @param provider  { client, settings }: the current OIDC client and its settings (getters)
 * @param pending   the sign-ins in progress at the provider (pendingLogins.js)
 * @param signIn    (req, res, user, { idToken }) → session: opens the session
 */
export function oidcRoutes({ provider, pending, cookies, serverTrust, publicUrl, refusals, signIn, services, audit, log }) {
  const startsPerMinute = createRateLimiter({ limit: 30, windowMs: 60_000 });
  // Each start leads to one callback at most; the margin covers a fixed window cut in two
  const callbacksPerMinute = createRateLimiter({ limit: 60, windowMs: 60_000 });
  const backToLogin = (res, error) => res.redirect(302, `/login?error=${error}`);
  const router = express.Router();

  /** Remember an attempt at the provider in this browser (a cookie naming it); a second one replaces the first */
  function remember(req, res, attempt) {
    pending.discard(readCookie(req, cookies.login));
    const id = pending.put(attempt, { owner: clientIp(req, serverTrust) });
    appendCookie(res, serializeCookie(cookies.login, id, { secure: cookies.secure, maxAgeSeconds: pending.ttlMs / 1000 }));
  }

  router.get('/auth/login', async (req, res) => {
    const client = provider.client;
    if (!client.enabled) return backToLogin(res, 'sso_disabled');
    if (!startsPerMinute(clientIp(req, serverTrust))) return backToLogin(res, 'throttled');
    let started;
    try {
      started = await client.begin();
    } catch (err) {
      if (!(err instanceof OidcError)) log.error(`sign-in could not start: ${err.stack || err}`);
      return backToLogin(res, 'provider_unavailable');
    }
    remember(req, res, { ...started.pending, client, returnTo: safeReturnPath(req.query.next) });
    res.redirect(302, started.url);
  });

  router.get('/auth/callback', async (req, res) => {
    const refuse = (reason, error, details = {}) => {
      audit?.log(req, 'auth.login.failed', { method: 'oidc', reason, ...details });
      return backToLogin(res, error);
    };
    // Refusals anyone can produce for free are audited once per client and window (refusals.js)
    const address = clientIp(req, serverTrust);
    const refuseCheaply = (reason, error) => {
      refusals.record(req, address, reason, { method: 'oidc', reason });
      return backToLogin(res, error);
    };
    if (!callbacksPerMinute(address)) return refuseCheaply('throttled', 'throttled');

    // Single use: the attempt is forgotten before anything is checked, so a
    // replayed or forged callback has nothing to be compared with
    const attempt = pending.take(readCookie(req, cookies.login));
    appendCookie(res, clearCookie(cookies.login, { secure: cookies.secure }));
    if (!attempt) return refuseCheaply('no_pending_login', 'login_expired');
    // The settings changed while this person was at the provider: start again
    if (attempt.client !== provider.client) return refuse('provider_changed', 'login_expired');
    if (attempt.trial) return finishTrial(req, res, attempt);

    let result;
    let userinfo = null;
    try {
      // Rebuilt on PUBLIC_URL: what the provider was given, whatever Host header this request carries
      result = await attempt.client.complete(new URL(publicUrl + req.originalUrl), attempt);
      if (needsUserinfo(result.idClaims, provider.settings.groupsClaim)) userinfo = await attempt.client.userinfo(result.accessToken, result.idClaims.sub);
    } catch (err) {
      if (!(err instanceof OidcError)) log.error(`sign-in failed unexpectedly: ${err.stack || err}`);
      else log.warn(`sign-in refused: ${err.message}`);
      return err?.kind === 'unavailable' ? refuse('provider_unavailable', 'provider_unavailable') : refuse('rejected', 'sso_failed');
    }

    let decision;
    try {
      decision = decide(result.idClaims, userinfo);
    } catch (err) {
      log.warn(`sign-in refused: ${err.message}`);
      return refuse('rejected', 'sso_failed');
    }
    if (!decision.allowed) {
      log.warn(`sign-in refused: ${decision.username} is in none of the allowed groups`);
      return refuse('not_allowed', 'not_allowed', { username: decision.username, groups: decision.groups });
    }
    // The directory has the last word: a disabled account stays out, whatever the provider says
    let admitted;
    try {
      admitted = (await services.accounts?.admit?.(decision.user, { groupRole: decision.groupRole })) !== false;
    } catch (err) {
      log.error(`the directory could not record ${decision.user.id}: ${err.message}`);
      return refuse('directory_unavailable', 'sso_failed');
    }
    if (!admitted) return refuse('disabled', 'account_disabled', { username: decision.user.username });

    const session = signIn(req, res, decision.user, { idToken: result.idToken });
    audit?.log(req, 'auth.login', { method: 'oidc', session: session.id, role: decision.user.role });
    res.redirect(302, attempt.returnTo);
  });

  /** Who would this be, with which role? Groups decide, a role stored in the directory wins */
  function decide(idClaims, userinfo) {
    const settings = provider.settings;
    const id = `oidc:${subjectOf(idClaims)}`;
    const storedRole = services.accounts?.roleOverride?.(id) ?? null;
    const decision = userFromClaims({ idClaims, userinfo, settings, storedRole });
    const groupRole = userFromClaims({ idClaims, userinfo, settings: { ...settings, allowedGroups: [] } }).user.role;
    return { ...decision, groupRole, storedRole };
  }

  // ── A sign-in at the provider that opens no session ────────────────────────
  async function finishTrial(req, res, attempt) {
    let outcome;
    try {
      const result = await attempt.client.complete(new URL(publicUrl + req.originalUrl), attempt);
      const userinfo = await attempt.client.userinfo(result.accessToken, result.idClaims.sub).catch(() => null);
      const decision = decide(result.idClaims, userinfo);
      outcome = {
        ok: true,
        idClaims: result.idClaims,
        userinfo,
        groups: groupsFrom(result.idClaims, userinfo, provider.settings.groupsClaim),
        allowed: decision.allowed,
        userId: decision.user?.id ?? null,
        username: decision.user?.username ?? decision.username,
        role: decision.allowed ? decision.user.role : null,
        groupRole: decision.groupRole,
        storedRole: decision.storedRole,
      };
    } catch (err) {
      log.warn(`trial sign-in failed: ${err.message}`);
      outcome = { ok: false, error: err?.kind === 'unavailable' ? 'provider_unavailable' : 'sso_failed', message: err.message };
    }
    try {
      await attempt.trial.onResult(outcome);
    } catch (err) {
      log.error(`trial sign-in result was lost: ${err.message}`);
    }
    res.redirect(302, attempt.returnTo);
  }

  /**
   * Send this browser to the provider with the current settings, and come
   * back to `returnTo` without opening a session (auth.oidc.trial)
   */
  async function trial(req, res, { returnTo = '/', onResult, reauth = false }) {
    const client = provider.client;
    if (!client.enabled) throw Object.assign(new Error('No identity provider is enabled'), { code: 'sso_disabled' });
    const started = await client.begin({ reauth });
    remember(req, res, { ...started.pending, client, returnTo: safeReturnPath(returnTo), trial: { onResult } });
    return { url: started.url };
  }

  return { router, trial };
}
