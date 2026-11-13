/**
 * Identity: who is behind a request (ARCHITECTURE §5)
 *
 * createAuth(deps) returns the service every module receives as `deps.auth`:
 *
 *   auth.attach(req, res, next)        sets req.user and req.sessionId (or leaves them undefined)
 *   auth.requireAuth(req, res, next)   401 JSON under /api and for writes, 302 /login otherwise
 *   auth.requireRole('admin')          middleware, 403 JSON
 *   auth.authenticateUpgrade(req)      → User | null, for WebSocket upgrades
 *   auth.sessions.list() / .revoke(sessionId) / .revokeUser(userId) / .create(user, meta)
 *   auth.accounts.add(provider)        another source of local accounts (accounts.js)
 *   auth.oidc.settings / .configure(raw)   the identity provider, replaceable at run time
 *   auth.router                        /login, /js/login.js and /auth/*, mounted before the gate
 *   auth.shutdown()
 *
 * Two ways in, one kind of session:
 *   - OpenID Connect (oidc.js), for everybody, when a provider is configured;
 *   - local accounts (accounts.js), whose first provider is the administrator
 *     of the environment (envAdmin.js), always there.
 * There is no other way in and no switch that turns the gate off
 *
 * Routes (all above the gate, so each one protects itself):
 *   GET  /login           the sign-in page (redirects to ?next when already signed in)
 *   GET  /js/login.js     its script
 *   GET  /auth/me         { user, locale, providerName }; user is null when signed out
 *   GET  /auth/login      start an OpenID Connect sign-in        ?next=/path
 *   GET  /auth/callback   the provider sends the browser back here
 *   POST /auth/local      { username, password, code, next } → { redirect }
 *   POST /auth/logout     → { redirect } (the provider's sign-out page when it has one)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sendError } from '../../lib/httpError.js';
import { requireSameOrigin, createRateLimiter, clientIp } from '../../lib/security.js';
import { hasRole } from './user.js';
import { cookieSettings, readCookie, serializeCookie, clearCookie, appendCookie } from './cookies.js';
import { createSessionStore } from './sessions.js';
import { createPendingLogins, safeReturnPath } from './pendingLogins.js';
import { createLoginThrottle } from './throttle.js';
import { createAccountProviders } from './accounts.js';
import { createEnvAdminProvider } from './envAdmin.js';
import { createDeviceCookies, loadDeviceKey } from './devices.js';
import { createRefusalAudit } from './refusals.js';
import { createOidc, OidcError } from './oidc.js';
import { normalizeOidcSettings, isInsecureIssuer } from './oidcSettings.js';
import { userFromClaims, needsUserinfo } from './claims.js';

export { createUser, hasRole, ROLES } from './user.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public');
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

/** The OIDC settings an administrator may see: everything but the secret */
const visibleSettings = ({ clientSecret, ...rest }) => ({ ...rest, hasClientSecret: Boolean(clientSecret) });

/**
 * deps: { config, logger, events, store, audit } from the platform; `now` is
 * a test seam (a clock). Throws when there is no local administrator or no
 * PUBLIC_URL: the platform must not start without a way to sign in
 */
export function createAuth({ config, logger, events, store, audit, now = Date.now }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const settings = config.auth;
  if (!settings?.localAdmin?.username || !settings.localAdmin.passwordHash || !settings.localAdmin.totpSecret) {
    throw new Error('The local administrator is not configured: Lab Console never runs without sign-in (run "npm run setup-admin")');
  }
  const publicUrl = config.server.publicUrl;
  if (!publicUrl) throw new Error('PUBLIC_URL is required: cookie security and sign-in redirects derive from it');

  const cookies = cookieSettings(publicUrl);
  const serverTrust = config.server;
  const envAdmin = createEnvAdminProvider({ settings: settings.localAdmin, store, logger: log, now });
  const sessions = createSessionStore({
    store, logger: log, now,
    // The administrator's sessions do not outlive a change of its credentials
    bindingOf: (user) => (user.id === envAdmin.user.id ? envAdmin.binding : undefined),
    onEnd(session, reason) {
      // Whatever ended the session, its live streams go with it; the browser
      // reconnects by itself and meets the gate again
      events?.disconnect((user) => user?.id === session.user.id);
      if (reason === 'expired' || reason === 'revoked') {
        audit?.log('system', 'auth.session.end', { reason, user: session.user.id, username: session.user.username, session: session.id });
      }
    },
  });
  const pending = createPendingLogins({ now });
  const throttle = createLoginThrottle({ now });
  const devices = createDeviceCookies({ key: loadDeviceKey({ store, logger: log }), now });
  const refusals = createRefusalAudit({ audit, now });
  const accounts = createAccountProviders([envAdmin]);
  const startsPerMinute = createRateLimiter({ limit: 30, windowMs: 60_000 });
  // Each start leads to one callback at most; the margin covers a fixed window cut in two
  const callbacksPerMinute = createRateLimiter({ limit: 60, windowMs: 60_000 });
  const housekeeping = setInterval(() => {
    throttle.sweep();
    refusals.flush();
  }, 5 * 60_000);
  housekeeping.unref();

  // ── Identity provider: rebuilt whenever its settings change ────────────────
  let oidcSettings = settings.oidc;
  let oidc = null;
  function buildOidc(next) {
    oidcSettings = next;
    oidc = createOidc({ settings: next, publicUrl, logger: log, now });
    if (isInsecureIssuer(next)) log.warn(`OIDC issuer ${next.issuer} is plain http: acceptable for a mock provider on a test bench, never for real accounts`);
  }
  buildOidc(settings.oidc);

  // ── Session cookie ─────────────────────────────────────────────────────────
  const tokenOf = (req) => readCookie(req, cookies.session);
  const meta = (req) => ({ ip: clientIp(req, serverTrust), userAgent: String(req.headers['user-agent'] ?? '') });

  /** Open a session for someone who just proved who they are; whatever session the browser had ends (new id) */
  function signIn(req, res, user, { idToken } = {}) {
    sessions.end(tokenOf(req), 'replaced');
    const { token, session } = sessions.create(user, { ...meta(req), idToken });
    appendCookie(res, serializeCookie(cookies.session, token, { secure: cookies.secure }));
    req.user = session.user; // from here on the request is theirs (the audit trail signs it with them)
    req.sessionId = session.id;
    return session;
  }

  function attach(req, _res, next) {
    const session = sessions.find(tokenOf(req));
    if (session) {
      req.user = session.user;
      req.sessionId = session.id;
    }
    next();
  }

  function authenticateUpgrade(req) {
    const token = tokenOf(req);
    const session = sessions.find(token);
    if (!session) return null;
    // Ending the session (sign-out, revocation, expiry) destroys this socket
    sessions.trackSocket(token, req.socket);
    req.sessionId = session.id;
    return session.user;
  }

  // ── Routes ─────────────────────────────────────────────────────────────────
  const router = express.Router();
  const sameOrigin = requireSameOrigin(config.server.allowedOrigins);
  const json = express.json({ limit: '4kb' });
  const backToLogin = (res, error) => res.redirect(302, `/login?error=${error}`);

  // Nothing about signing in is cached or indexed
  router.use(['/login', '/auth'], (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });

  router.get('/login', (req, res) => {
    if (sessions.peek(tokenOf(req))) return res.redirect(302, safeReturnPath(req.query.next));
    res.sendFile(path.join(publicDir, 'login.html'));
  });
  router.get('/js/login.js', (_req, res) => res.sendFile(path.join(publicDir, 'js', 'login.js')));

  // What the browser may know about its own session; never anything secret.
  // Reading it is not activity: a forgotten tab must not keep a session alive
  router.get('/auth/me', (req, res) => {
    const session = sessions.peek(tokenOf(req));
    res.json({ user: session?.user ?? null, locale: config.defaultLocale, providerName: oidc.providerName });
  });

  router.get('/auth/login', async (req, res) => {
    const client = oidc;
    if (!client.enabled) return backToLogin(res, 'sso_disabled');
    const address = clientIp(req, serverTrust);
    if (!startsPerMinute(address)) return backToLogin(res, 'throttled');
    let started;
    try {
      started = await client.begin();
    } catch (err) {
      if (!(err instanceof OidcError)) log.error(`sign-in could not start: ${err.stack || err}`);
      return backToLogin(res, 'provider_unavailable');
    }
    pending.discard(readCookie(req, cookies.login)); // a second click replaces the first attempt
    const id = pending.put({ ...started.pending, client, returnTo: safeReturnPath(req.query.next) }, { owner: address });
    appendCookie(res, serializeCookie(cookies.login, id, { secure: cookies.secure, maxAgeSeconds: pending.ttlMs / 1000 }));
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
    if (attempt.client !== oidc) return refuse('provider_changed', 'login_expired');

    let result;
    let userinfo = null;
    try {
      // Rebuilt on PUBLIC_URL: what the provider was given, whatever Host header this request carries
      result = await attempt.client.complete(new URL(publicUrl + req.originalUrl), attempt);
      if (needsUserinfo(result.idClaims, oidcSettings.groupsClaim)) userinfo = await attempt.client.userinfo(result.accessToken, result.idClaims.sub);
    } catch (err) {
      if (!(err instanceof OidcError)) log.error(`sign-in failed unexpectedly: ${err.stack || err}`);
      else log.warn(`sign-in refused: ${err.message}`);
      return err?.kind === 'unavailable' ? refuse('provider_unavailable', 'provider_unavailable') : refuse('rejected', 'sso_failed');
    }

    let decision;
    try {
      decision = userFromClaims({ idClaims: result.idClaims, userinfo, settings: oidcSettings });
    } catch (err) {
      log.warn(`sign-in refused: ${err.message}`);
      return refuse('rejected', 'sso_failed');
    }
    if (!decision.allowed) {
      log.warn(`sign-in refused: ${decision.username} is in none of the allowed groups`);
      return refuse('not_allowed', 'not_allowed', { username: decision.username, groups: decision.groups });
    }

    const session = signIn(req, res, decision.user, { idToken: result.idToken });
    audit?.log(req, 'auth.login', { method: 'oidc', session: session.id, role: decision.user.role });
    res.redirect(302, attempt.returnTo);
  });

  router.post('/auth/local', sameOrigin, json, async (req, res) => {
    const body = req.body !== null && typeof req.body === 'object' ? req.body : {};
    const username = typeof body.username === 'string' ? body.username.slice(0, 128) : '';
    const client = clientIp(req, serverTrust);
    // A browser that already signed in with this name is limited on its own (throttle.js, devices.js)
    const device = devices.check(readCookie(req, cookies.device), username) ?? undefined;
    const slot = throttle.take({ client, username, device });
    if (!slot.allowed) {
      refusals.record(req, client, `throttled:${slot.scope}`, { method: 'local', reason: 'throttled', scope: slot.scope });
      res.set('Retry-After', String(slot.retryAfterSeconds));
      return sendError(res, 429, 'auth.throttled', 'Too many sign-in attempts. Try again later', { seconds: slot.retryAfterSeconds });
    }

    let user = null;
    try {
      user = await accounts.verify({ username, password: body.password, code: body.code }, { logger: log });
    } finally {
      if (user) throttle.succeeded({ client, username, device });
      else throttle.failed({ username, device });
    }
    if (!user) {
      audit?.log(req, 'auth.login.failed', { method: 'local', reason: 'invalid' });
      // One message for every cause: nothing says which field was wrong, or whether the account exists
      return sendError(res, 401, 'auth.invalid_credentials', 'Sign-in failed. Check the user name, the password and the code');
    }

    const session = signIn(req, res, user);
    appendCookie(res, serializeCookie(cookies.device, devices.issue(username), { secure: cookies.secure, maxAgeSeconds: devices.maxAgeMs / 1000 }));
    audit?.log(req, 'auth.login', { method: 'local', session: session.id, role: user.role, knownBrowser: Boolean(device) });
    res.json({ redirect: safeReturnPath(body.next) });
  });

  router.post('/auth/logout', sameOrigin, async (req, res) => {
    const token = tokenOf(req);
    const session = sessions.peek(token);
    let redirect = '/login';
    if (session) {
      if (session.user.via === 'oidc') redirect = (await oidc.endSessionUrl({ idToken: session.idToken })) ?? redirect;
      sessions.end(token, 'logout');
      req.user = session.user;
      audit?.log(req, 'auth.logout', { session: session.id });
    }
    appendCookie(res, clearCookie(cookies.session, { secure: cookies.secure }));
    res.json({ redirect });
  });

  // An unknown /auth/… path is a JSON 404, not a redirect to the page that brought the browser here
  router.use('/auth', (_req, res) => sendError(res, 404, 'server.not_found', 'Not found'));

  return {
    attach,
    requireAuth,
    requireRole,
    authenticateUpgrade,
    sessions: {
      list: () => sessions.list(),
      revoke: (sessionId) => sessions.revoke(sessionId),
      revokeUser: (userId) => sessions.revokeUser(userId),
      /**
       * Open a session for someone this server has just authenticated another
       * way (a passkey, an invitation) - and for tests, which sign in with it.
       * → { id, token, cookie } where `cookie` is a ready Cookie header value
       */
      create(user, details = {}) {
        const { token, session } = sessions.create(user, details);
        return { id: session.id, token, cookie: `${cookies.session}=${token}` };
      },
    },
    accounts: { add: accounts.add, get providers() { return accounts.ids; } },
    oidc: {
      get enabled() { return oidc.enabled; },
      get settings() { return visibleSettings(oidcSettings); },
      /**
       * Replace the identity provider's settings without a restart. `raw` has
       * the shape of normalizeOidcSettings(); an omitted clientSecret keeps
       * the current one. Open sessions are not touched; sign-ins in progress
       * have to start again. Throws a TypeError listing the problems
       */
      configure(raw) {
        const merged = { ...oidcSettings, ...raw };
        if (raw.clientSecret === undefined) merged.clientSecret = oidcSettings.clientSecret;
        const { settings: next, problems } = normalizeOidcSettings(merged);
        if (problems.length) throw Object.assign(new TypeError(problems.join('; ')), { problems });
        buildOidc(next);
        return visibleSettings(next);
      },
    },
    router,
    cookieName: cookies.session,
    get providerName() { return oidc.providerName; },
    shutdown() {
      clearInterval(housekeeping);
      refusals.flush({ force: true });
      return sessions.shutdown();
    },
  };
}
