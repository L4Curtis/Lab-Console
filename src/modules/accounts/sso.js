/**
 * The identity provider, set from the administration pages
 *
 * Saved in the database (table settings, namespace `sso`, through
 * repos.settings: the settings service leaves that row alone) and applied at
 * once with auth.oidc.configure(): no restart, open sessions untouched,
 * sign-ins in progress start again. The client secret is the one secret Lab
 * Console keeps in a form it can use (it must send it to the provider): in
 * clear inside the database (a file of mode 600), or encrypted with
 * AES-256-GCM under a key derived from APP_SECRET when that variable is set. It is write-only:
 * no answer ever contains it, only whether there is one.
 *
 * When OIDC_ISSUER is set in the environment, the environment wins: what was
 * saved is ignored and the page is read-only (`locked`).
 *
 * "Test" fetches the discovery document through the guarded fetch of
 * src/lib/safeFetch.js (https unless the insecure flag, a deadline, a size
 * limit, no redirect to an internal address) and reports what it found.
 * "Try a sign-in" goes to the provider with the current settings and comes
 * back without opening a session (auth.oidc.trial): the claims received and
 * the role they give are kept for the administrator who asked, 10 minutes
 */
import { secretKey, sealSecret, openSecret } from '../../lib/sealed.js';
import { normalizeOidcSettings, CLIENT_AUTH_METHODS } from '../auth/oidcSettings.js';
import { createSafeFetch, SafeFetchError } from '../../lib/safeFetch.js';

const FILE_VERSION = 1;
/** The row of the settings table that holds the provider set from the administration pages */
export const SSO_NAMESPACE = 'sso';
const TRIAL_TTL_MS = 10 * 60_000;
const DISCOVERY = { timeoutMs: 5000, maxBytes: 256 * 1024, maxRedirects: 3 };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The fields an administrator edits; the secret is handled apart */
const FIELDS = ['issuer', 'clientId', 'clientAuthMethod', 'scopes', 'groupsClaim', 'adminGroups', 'allowedGroups', 'providerName', 'allowInsecure', 'enabled'];

/**
 * Check what the page sent, field by field, with a code the page can
 * translate. → { values, problems: [{ field, code }] }. normalizeOidcSettings
 * stays the final word (it is what the sign-in module applies)
 */
export function checkSsoInput(body) {
  const problems = [];
  const values = {};
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).map((x) => text(x, 200)).filter(Boolean).slice(0, 100);

  values.enabled = body.enabled !== false;
  values.issuer = text(body.issuer, 500);
  values.clientId = text(body.clientId, 300);
  values.clientAuthMethod = text(body.clientAuthMethod, 40) || CLIENT_AUTH_METHODS[0];
  values.scopes = list(body.scopes);
  values.groupsClaim = text(body.groupsClaim, 200);
  values.adminGroups = list(body.adminGroups);
  values.allowedGroups = list(body.allowedGroups);
  values.providerName = text(body.providerName, 200);
  values.allowInsecure = body.allowInsecure === true;

  let url;
  try { url = values.issuer ? new URL(values.issuer) : null; } catch { url = null; }
  if (!values.issuer) {
    if (values.enabled) problems.push({ field: 'issuer', code: 'issuer_required' });
  } else if (!url || !['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    problems.push({ field: 'issuer', code: 'issuer_invalid' });
  } else if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !values.allowInsecure) {
    problems.push({ field: 'issuer', code: 'issuer_insecure' });
  }
  if (values.enabled && !values.clientId) problems.push({ field: 'clientId', code: 'client_id_required' });
  if (!CLIENT_AUTH_METHODS.includes(values.clientAuthMethod)) problems.push({ field: 'clientAuthMethod', code: 'auth_method_invalid' });
  if (values.scopes.length && !values.scopes.includes('openid')) problems.push({ field: 'scopes', code: 'scopes_openid' });
  if (values.providerName.length > 40) problems.push({ field: 'providerName', code: 'provider_name_long' });
  if (/[^\w.:/-]/.test(values.groupsClaim)) problems.push({ field: 'groupsClaim', code: 'groups_claim_invalid' });
  return { values, problems };
}

export function createSso({ config, repos, auth, logger, now = Date.now, fetchOptions = {} }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  let saved = null; // { version, savedAt, settings, clientSecret }, as last read or written
  const file = {
    get: () => saved,
    async set(doc, by) {
      await repos.settings.save(SSO_NAMESPACE, doc, by);
      saved = doc;
    },
  };
  const key = secretKey(config.appSecret, 'sso client secret');
  // The environment names a provider: it wins, and this page only shows it
  const locked = Boolean(config.auth.oidc.issuer);
  const trials = new Map(); // session id → { result, at }
  let secretUnreadable = false;

  /** Apply what was saved, at start-up. A broken record leaves the provider off, never the platform down */
  async function load() {
    if (locked) return;
    saved = (await repos.settings.get(SSO_NAMESPACE))?.values ?? null;
    if (!saved || saved.version !== FILE_VERSION || typeof saved.settings !== 'object') return;
    const secret = openSecret(saved.clientSecret, key);
    secretUnreadable = secret === null;
    if (secretUnreadable) log.error('the saved SSO client secret cannot be decrypted (APP_SECRET missing or changed): set it again on the SSO page');
    try {
      auth.oidc.configure({ ...saved.settings, clientSecret: secret ?? '' });
      log.info(`identity provider settings loaded from the database (${saved.settings.issuer || 'none'}${saved.settings.enabled === false ? ', switched off' : ''})`);
    } catch (err) {
      log.error(`the saved SSO settings were not applied: ${err.message}`);
    }
  }

  function describe() {
    const settings = auth.oidc.settings;
    return {
      locked,
      source: locked ? 'environment' : file.get() ? 'saved' : 'none',
      settings,
      callbackUrl: auth.oidc.redirectUri,
      encrypted: Boolean(key),
      secretUnreadable,
    };
  }

  /**
   * Save and apply. `body` is what the page sent: every field, plus
   * `clientSecret` (a new secret; absent or empty = keep the current one,
   * refused when the issuer or the client id changes: secret_required)
   * and `clearClientSecret: true` (a public client from now on).
   * → { changed: [field names], secretChanged }. Throws { status, code, problems } on refusal
   */
  async function save(body, actor) {
    if (locked) throw Object.assign(new Error('The identity provider is set in the environment'), { status: 409, code: 'accounts.sso_locked' });
    const { values, problems } = checkSsoInput(body);
    if (problems.length) throw Object.assign(new Error('Invalid settings'), { status: 400, code: 'accounts.sso_invalid', problems });

    const current = auth.oidc.settings;
    const newSecret = typeof body.clientSecret === 'string' && body.clientSecret !== '' ? body.clientSecret.slice(0, 1000) : undefined;
    // The saved secret belongs to one client of one provider: it never follows
    // a change of issuer or client id, or anyone able to save this page could
    // send it to a provider of their choosing and read it there
    const otherClient = values.issuer !== current.issuer || values.clientId !== current.clientId;
    if (current.hasClientSecret && otherClient && newSecret === undefined && body.clearClientSecret !== true) {
      throw Object.assign(new Error('A new issuer or client id needs its own client secret'), {
        status: 400, code: 'accounts.sso_invalid', problems: [{ field: 'clientSecret', code: 'secret_required' }],
      });
    }
    const secretChanged = Boolean(newSecret) || (body.clearClientSecret === true && current.hasClientSecret);
    const raw = { ...values, ...(newSecret ? { clientSecret: newSecret } : body.clearClientSecret === true ? { clientSecret: '' } : {}) };
    const check = normalizeOidcSettings({ ...raw, clientSecret: raw.clientSecret ?? '' });
    if (check.problems.length) throw Object.assign(new Error(check.problems.join('; ')), { status: 400, code: 'accounts.sso_invalid', problems: [] });

    const applied = auth.oidc.configure(raw);
    // The secret kept on disk: the new one, none, or the one saved before (the
    // environment cannot hold one here: without OIDC_ISSUER it refuses a secret)
    const replaced = newSecret !== undefined || body.clearClientSecret === true;
    const sealed = replaced ? sealSecret(newSecret ?? '', key) : file.get()?.clientSecret ?? '';
    const settings = Object.fromEntries(FIELDS.map((f) => [f, f === 'enabled' ? values.enabled : applied[f]]));
    await file.set({ version: FILE_VERSION, savedAt: new Date(now()).toISOString(), settings, clientSecret: sealed }, actor?.id ?? null);
    if (replaced) secretUnreadable = false;
    const changed = FIELDS.filter((f) => JSON.stringify(current[f]) !== JSON.stringify(applied[f]));
    return { changed, secretChanged };
  }

  /**
   * Fetch the discovery document of `issuer` (default: the current one).
   * → { ok: true, issuer, issuerMatches, endpoints, scopesSupported } or { ok: false, reason }
   */
  async function test({ issuer, allowInsecure } = {}) {
    const settings = auth.oidc.settings;
    const target = typeof issuer === 'string' && issuer.trim() ? issuer.trim() : settings.issuer;
    const insecure = typeof allowInsecure === 'boolean' ? allowInsecure : settings.allowInsecure;
    let url;
    try { url = new URL(target); } catch { return { ok: false, reason: 'bad_url' }; }
    if (url.search || url.hash || url.username || url.password) return { ok: false, reason: 'bad_url' };
    const discovery = `${target.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const fetch = createSafeFetch({ trustedHost: url.hostname, allowInsecure: insecure, ...DISCOVERY, ...fetchOptions });
    let document;
    try {
      const res = await fetch(discovery, { headers: { accept: 'application/json' } });
      if (!res.ok) return { ok: false, reason: 'http_status', status: res.status };
      document = await res.json().catch(() => null);
    } catch (err) {
      if (err instanceof SafeFetchError) return { ok: false, reason: err.reason };
      log.warn(`SSO discovery test failed: ${err.message}`);
      return { ok: false, reason: 'unreachable' };
    }
    if (!document || typeof document !== 'object' || typeof document.issuer !== 'string') return { ok: false, reason: 'not_discovery' };
    const field = (name) => (typeof document[name] === 'string' ? document[name].slice(0, 500) : null);
    return {
      ok: true,
      issuer: field('issuer'),
      issuerMatches: document.issuer === target,
      endpoints: {
        authorization: field('authorization_endpoint'),
        token: field('token_endpoint'),
        userinfo: field('userinfo_endpoint'),
        endSession: field('end_session_endpoint'),
        jwks: field('jwks_uri'),
      },
      scopesSupported: Array.isArray(document.scopes_supported) ? document.scopes_supported.filter((s) => typeof s === 'string').slice(0, 50) : [],
      pkce: Array.isArray(document.code_challenge_methods_supported) ? document.code_challenge_methods_supported.includes('S256') : null,
    };
  }

  function sweepTrials() {
    for (const [id, trial] of trials) if (now() - trial.at > TRIAL_TTL_MS) trials.delete(id);
  }

  return {
    locked,
    load,
    describe,
    save,
    test,
    /** Keep a trial's outcome for the administrator's session */
    keepTrial(sessionId, result) {
      sweepTrials();
      trials.set(sessionId, { result, at: now() });
    },
    /** The outcome waiting for this session, once (null when there is none) */
    takeTrial(sessionId) {
      sweepTrials();
      const trial = trials.get(sessionId);
      trials.delete(sessionId);
      return trial?.result ?? null;
    },
  };
}
