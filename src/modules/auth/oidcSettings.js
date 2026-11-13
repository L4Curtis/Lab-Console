/**
 * OpenID Connect settings: one validated object, whatever its source
 *
 * Today the source is the environment (config.js); later an administration
 * page will edit the same object and the sign-in module will rebuild its
 * client from it without a restart (createAuth().oidc.configure). Both go
 * through normalizeOidcSettings(), so a value refused at start-up is refused
 * the same way at run time
 *
 *   const { settings, problems } = normalizeOidcSettings({ issuer, clientId, ... });
 *
 * `settings.enabled` is false when there is no issuer: OpenID Connect is
 * optional, the local administrator is not
 */

export const OIDC_DEFAULTS = Object.freeze({
  scopes: Object.freeze(['openid', 'profile', 'email', 'groups']),
  groupsClaim: 'groups',
  providerName: 'SSO',
  clientAuthMethod: 'client_secret_basic',
});

export const CLIENT_AUTH_METHODS = Object.freeze(['client_secret_basic', 'client_secret_post']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const words = (value, fallback) => {
  const items = Array.isArray(value) ? value : text(value).split(/[\s,]+/);
  const kept = items.map(text).filter(Boolean);
  return kept.length ? [...new Set(kept)] : [...fallback];
};
const names = (value) => [...new Set((Array.isArray(value) ? value : text(value).split(',')).map(text).filter(Boolean))];

/**
 * Check and complete raw settings. Never throws: `problems` lists every
 * refusal in a sentence that names the environment variable concerned
 */
export function normalizeOidcSettings(raw = {}) {
  const problems = [];
  // Kept exactly as the provider states it: the discovered issuer must match it
  // character for character, and some end with a slash (Authentik) while others do not
  const issuer = text(raw.issuer);
  const clientAuthMethod = text(raw.clientAuthMethod).toLowerCase() || OIDC_DEFAULTS.clientAuthMethod;
  const settings = {
    enabled: Boolean(issuer),
    issuer,
    clientId: text(raw.clientId),
    // Empty = a public client, which proves itself with PKCE alone
    clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : '',
    clientAuthMethod: CLIENT_AUTH_METHODS.includes(clientAuthMethod) ? clientAuthMethod : OIDC_DEFAULTS.clientAuthMethod,
    scopes: words(raw.scopes, OIDC_DEFAULTS.scopes),
    groupsClaim: text(raw.groupsClaim) || OIDC_DEFAULTS.groupsClaim,
    adminGroups: names(raw.adminGroups),
    allowedGroups: names(raw.allowedGroups),
    providerName: text(raw.providerName) || OIDC_DEFAULTS.providerName,
    allowInsecure: raw.allowInsecure === true,
  };

  if (!CLIENT_AUTH_METHODS.includes(clientAuthMethod)) {
    problems.push(`OIDC_CLIENT_AUTH_METHOD must be one of ${CLIENT_AUTH_METHODS.join(', ')}`);
  }

  if (!issuer) {
    if (settings.clientId || settings.clientSecret) {
      problems.push('OIDC_CLIENT_ID / OIDC_CLIENT_SECRET are set but OIDC_ISSUER is empty: set the issuer URL, or remove them');
    }
    return { settings: { ...settings, enabled: false }, problems };
  }

  let url;
  try { url = new URL(issuer); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    problems.push(`OIDC_ISSUER must be the provider's issuer URL, e.g. https://id.example.org (got "${issuer}")`);
  } else if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !settings.allowInsecure) {
    // Without TLS anyone on the path can sign in as anyone. Loopback is the mock provider on a developer's machine
    problems.push('OIDC_ISSUER must use https. Plain http is only accepted for localhost, or with OIDC_ALLOW_INSECURE=true on a test bench');
  }
  if (!settings.clientId) problems.push('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');
  if (!settings.scopes.includes('openid')) problems.push('OIDC_SCOPES must include "openid"');
  if (settings.providerName.length > 40) problems.push('OIDC_PROVIDER_NAME is the label of the sign-in button: 40 characters at most');
  if (/[^\w.:/-]/.test(settings.groupsClaim)) problems.push('OIDC_GROUPS_CLAIM is a claim name or a dotted path such as realm_access.roles');
  return { settings, problems };
}

/** True when the issuer is reached without TLS (the mock provider, a test bench) */
export const isInsecureIssuer = (settings) => settings.enabled && settings.issuer.startsWith('http://');
