/**
 * Identity: who is behind a request (ARCHITECTURE §5)
 *
 * await createAuth(deps) resolves to the service every module receives as
 * `deps.auth`, once its saved state (sessions, keys) is loaded:
 *
 *   auth.attach(req, res, next)        sets req.user and req.sessionId (or leaves them undefined)
 *   auth.requireAuth(req, res, next)   401 JSON under /api and for writes, 302 /login otherwise
 *   auth.requireRole('admin')          middleware, 403 JSON
 *   auth.authenticateUpgrade(req)      → User | null, for WebSocket upgrades
 *   auth.sessions.list() / .revoke(sessionId) / .revokeUser(userId) / .create(user, meta)
 *   auth.sessions.open(req, res, user, meta)   sign a browser in (new session, cookie set)
 *   auth.accounts.add(provider)        another source of local accounts (accounts.js)
 *   auth.reauthenticate(user, { password, code })   the environment administrator proves itself again → boolean
 *   auth.steps.peek(req) / .complete(req, res, details) / .fail(req, res) / .start(req, res, user, requires)
 *                                      a sign-in waiting for a further proof (a passkey)
 *   auth.oidc.settings / .configure(raw)   the identity provider, replaceable at run time
 *   auth.oidc.trial(req, res, { returnTo, onResult })   a sign-in at the provider that opens no session
 *   auth.extend(router, { describe })  more public routes (above the gate), and fields of /auth/me
 *   auth.router                        /login, /js/login.js and /auth/*, mounted before the gate
 *   auth.shutdown()
 *
 * Two ways in, one kind of session:
 *   - OpenID Connect (oidc.js), for everybody, when a provider is configured;
 *   - local accounts (accounts.js), whose first provider is the administrator
 *     of the environment (envAdmin.js), always there.
 * There is no other way in and no switch that turns the gate off. Other
 * modules add ways that end in the same session (a passkey, an invitation)
 * through auth.extend() and auth.sessions.open(), never around them.
 *
 * Accounts known to the directory (services.accounts, the accounts module)
 * are consulted at every provider sign-in: a role set by an administrator
 * wins over the groups, and a disabled account is refused
 *
 * Routes (all above the gate, so each one protects itself):
 *   GET  /login           the sign-in page (redirects to ?next when already signed in)
 *   GET  /js/login.js     its script
 *   GET  /auth/me         { user, locale, providerName }; user is null when signed out
 *   GET  /auth/login, /auth/callback   the identity provider (oidcRoutes.js)
 *   POST /auth/local      a local account (localRoutes.js)
 *   POST /auth/logout     → { redirect } (the provider's sign-out page when it has one)
 * The gate itself (requireAuth, requireRole) is gate.js
 */
import path from 'node:path';
import express from 'express';
import { sendError } from '../../lib/httpError.js';
import { appAssets } from '../../lib/assets.js';
import { requireSameOrigin, clientIp } from '../../lib/security.js';
import { requireAuth, requireRole } from './gate.js';
import { oidcRoutes } from './oidcRoutes.js';
import { localRoutes } from './localRoutes.js';
import { cookieSettings, readCookie, serializeCookie, clearCookie, appendCookie } from './cookies.js';
import { createSessionStore } from './sessions.js';
import { createPendingLogins, safeReturnPath } from './pendingLogins.js';
import { createLoginThrottle } from './throttle.js';
import { createAccountProviders } from './accounts.js';
import { createEnvAdminProvider } from './envAdmin.js';
import { createDeviceCookies, loadDeviceKey } from './devices.js';
import { createRefusalAudit } from './refusals.js';
import { createOidc } from './oidc.js';
import { normalizeOidcSettings, isInsecureIssuer } from './oidcSettings.js';

export { createUser, hasRole, ROLES } from './user.js';
export { requireAuth, requireRole };


/** The OIDC settings an administrator may see: everything but the secret */
const visibleSettings = ({ clientSecret, ...rest }) => ({ ...rest, hasClientSecret: Boolean(clientSecret) });

/**
 * deps: { config, logger, events, repos, audit } from the platform (repos:
 * createRepositories(db), of which it uses `sessions` and `authState`;
 * assets: the front end, src/lib/assets.js, for the sign-in page); `now`
 * is a test seam (a clock). Rejects when there is no local administrator or
 * no PUBLIC_URL: the platform must not start without a way to sign in
 */
export async function createAuth({ config, logger, events, repos, audit, services = {}, assets = appAssets(), now = Date.now }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const settings = config.auth;
  if (!settings?.localAdmin?.username || !settings.localAdmin.passwordHash || !settings.localAdmin.totpSecret) {
    throw new Error('The local administrator is not configured: Lab Console never runs without sign-in (run "npm run setup-admin")');
  }
  const publicUrl = config.server.publicUrl;
  if (!publicUrl) throw new Error('PUBLIC_URL is required: cookie security and sign-in redirects derive from it');

  const cookies = cookieSettings(publicUrl);
  const serverTrust = config.server;
  const envAdmin = await createEnvAdminProvider({ settings: settings.localAdmin, state: repos.authState, logger: log, now });
  const sessions = await createSessionStore({
    repo: repos.sessions, logger: log, now,
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
  // Sign-ins whose password was right but that still owe a passkey: 5 minutes,
  // single use. Every local account goes through one, so a classroom behind
  // one public address needs room; only a right password (or a valid link)
  // starts one, so strangers cannot fill it
  const steps = createPendingLogins({ ttlMs: 5 * 60_000, max: 2000, perOwner: 100, now });
  const throttle = createLoginThrottle({ now });
  const devices = createDeviceCookies({ key: await loadDeviceKey({ state: repos.authState, logger: log }), now });
  const refusals = createRefusalAudit({ audit, now });
  const accounts = createAccountProviders([envAdmin]);
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
    steps.discard(readCookie(req, cookies.step)); // a step left half-way is over too
    const { token, session } = sessions.create(user, { ...meta(req), idToken });
    appendCookie(res, serializeCookie(cookies.session, token, { secure: cookies.secure }));
    req.user = session.user; // from here on the request is theirs (the audit trail signs it with them)
    req.sessionId = session.id;
    return session;
  }

  /** This browser has signed in as `username`: from now on it is limited on its own (throttle.js, devices.js) */
  function rememberBrowser(res, username) {
    appendCookie(res, serializeCookie(cookies.device, devices.issue(username), { secure: cookies.secure, maxAgeSeconds: devices.maxAgeMs / 1000 }));
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
  const extensions = express.Router(); // routes other modules add with auth.extend(), mounted before the /auth 404
  const describers = [];               // their fields of /auth/me
  const sameOrigin = requireSameOrigin(config.server.allowedOrigins);

  // Nothing about signing in is cached or indexed
  router.use(['/login', '/auth'], (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });

  router.get('/login', (req, res) => {
    if (sessions.peek(tokenOf(req))) return res.redirect(302, safeReturnPath(req.query.next));
    assets.sendPage(res, 'login.html');
  });
  router.get('/js/login.js', (_req, res) => res.sendFile(path.join(assets.dir, 'js', 'login.js')));

  // What the browser may know about its own session; never anything secret.
  // Reading it is not activity: a forgotten tab must not keep a session alive
  router.get('/auth/me', (req, res) => {
    const session = sessions.peek(tokenOf(req));
    const extra = {};
    for (const describe of describers) {
      try { Object.assign(extra, describe(req)); } catch (err) { log.error(`/auth/me extension failed: ${err.message}`); }
    }
    res.json({ ...extra, user: session?.user ?? null, locale: config.defaultLocale, providerName: oidc.providerName });
  });

  const provider = { get client() { return oidc; }, get settings() { return oidcSettings; } };
  const viaProvider = oidcRoutes({ provider, pending, cookies, serverTrust, publicUrl, refusals, signIn, services, audit, log });
  router.use(viaProvider.router);
  router.use(localRoutes({ accounts, throttle, devices, refusals, cookies, serverTrust, sameOrigin, signIn, rememberBrowser, startStep, audit, log }));

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

  // Ways in added by other modules (auth.extend); they protect themselves like the routes above
  router.use(extensions);

  // An unknown /auth/… path is a JSON 404, not a redirect to the page that brought the browser here
  router.use('/auth', (_req, res) => sendError(res, 404, 'server.not_found', 'Not found'));

  // ── Further steps: a password that was right, a passkey still owed ─────────
  function startStep(req, res, user, requires, { returnTo = '/', deviceName = null, method = 'local', binding = null } = {}) {
    steps.discard(readCookie(req, cookies.step));
    const id = steps.put({ user, requires: [...requires], returnTo, deviceName, method, binding }, { owner: clientIp(req, serverTrust) });
    appendCookie(res, serializeCookie(cookies.step, id, { secure: cookies.secure, maxAgeSeconds: steps.ttlMs / 1000 }));
  }
  const stepOf = (req) => steps.peek(readCookie(req, cookies.step));
  function endStep(req, res) {
    const step = steps.take(readCookie(req, cookies.step));
    appendCookie(res, clearCookie(cookies.step, { secure: cookies.secure }));
    return step;
  }

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
      /**
       * Sign this browser in as `user`, whom the caller has just authenticated
       * (a passkey, an invitation): the browser's previous session ends, a new
       * one is opened and its cookie set on `res`. A local account's browser
       * becomes known for its name (devices.js), as after a password: the
       * shared limits of the local form no longer keep it out. → the session ({ id, user, … })
       */
      open(req, res, user, { idToken } = {}) {
        const session = signIn(req, res, user, { idToken });
        if (user.via === 'local') rememberBrowser(res, user.username);
        return session;
      },
    },
    accounts: { add: accounts.add, get providers() { return accounts.ids; } },
    /**
     * Ask the signed-in environment administrator for its password and a
     * fresh one-time code again, before a sensitive change (the lab
     * parameters). → true or false; false for anyone else, who confirms with
     * a passkey instead (the accounts module). An accepted code is burnt, as
     * at sign-in
     */
    async reauthenticate(user, { password, code } = {}) {
      if (!user || user.id !== envAdmin.user.id) return false;
      const answer = await envAdmin.verify({ username: user.username, password: typeof password === 'string' ? password : '', code: typeof code === 'string' ? code : '' });
      return Boolean(answer?.user);
    },
    get environmentAdminId() { return envAdmin.user.id; },
    steps: {
      /**
       * The sign-in this browser has in progress: { user, requires, returnTo,
       * binding } or null. `binding` is what the account provider attached
       * when the step started (accounts.js), for it to check that the
       * credentials it was started with are still valid
       */
      peek: (req) => {
        const step = stepOf(req);
        return step ? { user: step.user, requires: step.requires, returnTo: step.returnTo, binding: step.binding ?? null } : null;
      },
      /**
       * The owed proof was given: the step ends, a session opens, the browser
       * becomes known for the name it typed. `user`: the account as it is now
       * (its role may have changed during the step); it must be the same
       * person. → { redirect } for the browser, or null when there is no step
       */
      complete(req, res, { method = 'passkey', user } = {}) {
        const step = endStep(req, res);
        if (!step) return null;
        if (user && user.id !== step.user.id) throw new Error('A step is completed for the person who started it');
        const session = signIn(req, res, user ?? step.user);
        if (step.deviceName) rememberBrowser(res, step.deviceName);
        audit?.log(req, 'auth.login', { method: `${step.method}+${method}`, session: session.id, role: session.user.role });
        return { redirect: step.returnTo };
      },
      /** The proof was refused: the step is over, the password must be typed again */
      fail(req, res) {
        return Boolean(endStep(req, res));
      },
      /**
       * Start a step for someone the caller authenticated another way (a new
       * account, or a password reset link: a passkey is owed before any
       * session); `binding` as for a provider's answer
       */
      start(req, res, user, requires, { returnTo = '/', method = 'signup', binding = null } = {}) {
        startStep(req, res, user, requires, { returnTo: safeReturnPath(returnTo), deviceName: user.via === 'local' ? user.username : null, method, binding });
      },
    },
    /**
     * Mount more public routes (above the gate: each one checks what it
     * needs itself) and, optionally, add fields to GET /auth/me:
     * describe(req) → an object merged into the answer (never a secret)
     */
    extend(extra, { describe } = {}) {
      if (extra) extensions.use(extra);
      if (describe) describers.push(describe);
    },
    oidc: {
      get enabled() { return oidc.enabled; },
      get settings() { return visibleSettings(oidcSettings); },
      /**
       * Replace the identity provider's settings without a restart. `raw` has
       * the shape of normalizeOidcSettings(); an omitted clientSecret keeps
       * the current one, for the same issuer and client id only (a secret
       * never goes to another provider). Open sessions are not touched;
       * sign-ins in progress have to start again. Throws a TypeError listing the problems
       */
      configure(raw) {
        const merged = { ...oidcSettings, ...raw, enabled: raw.enabled };
        const keepsSecret = raw.clientSecret === undefined;
        if (keepsSecret) merged.clientSecret = oidcSettings.clientSecret;
        const { settings: next, problems } = normalizeOidcSettings(merged);
        if (keepsSecret && oidcSettings.clientSecret && (next.issuer !== oidcSettings.issuer || next.clientId !== oidcSettings.clientId)) {
          problems.push('OIDC_CLIENT_SECRET: a new issuer or client id needs its own secret (or an empty one for a public client)');
        }
        if (problems.length) throw Object.assign(new TypeError(problems.join('; ')), { problems });
        buildOidc(next);
        return visibleSettings(next);
      },
      /** The callback URL to give the provider */
      get redirectUri() { return oidc.redirectUri; },
      /**
       * Send this browser to the provider with the current settings, and come
       * back to `returnTo` without opening a session: `onResult(outcome)`
       * receives the claims and the role they would give
       * ({ ok, idClaims, userinfo, groups, allowed, userId, username, role, groupRole, storedRole }
       * or { ok: false, error }). `reauth: true` asks the provider for a fresh
       * sign-in and refuses an answer that is not one (a person proving
       * themselves again). → { url } to send the browser to
       */
      trial: (req, res, options) => viaProvider.trial(req, res, options),
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
