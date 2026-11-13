/**
 * OpenID Connect sign-in: authorization code flow with PKCE (S256), `state`
 * and `nonce`, through openid-client. Nothing here is specific to a provider
 *
 *   const oidc = createOidc({ settings, publicUrl, logger });   // settings: see oidcSettings.js
 *   const { url, pending } = await oidc.begin();          // send the browser to `url`
 *   const { idClaims, userinfo, idToken } = await oidc.complete(callbackUrl, pending);
 *   oidc.endSessionUrl({ idToken })                        // provider sign-out, or null
 *
 * The provider is discovered on first use, not at start-up: if it is down
 * when the platform boots, the platform still starts, the local administrator
 * still signs in, and the provider is tried again at the next attempt.
 * One instance serves one set of settings; when they change, the sign-in
 * module builds a new instance (createAuth().oidc.configure)
 */
import * as client from 'openid-client';
import { isInsecureIssuer } from './oidcSettings.js';

const DISCOVERY_TIMEOUT_S = 10;
const RETRY_AFTER_FAILURE_MS = 10_000;

/** What went wrong, in terms the sign-in page can explain: `kind` is 'unavailable' or 'rejected' */
export class OidcError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'OidcError';
    this.kind = kind;
    this.cause = cause;
  }
}

export function createOidc({ settings, publicUrl, logger, now = Date.now }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const redirectUri = `${publicUrl}/auth/callback`;
  const insecure = isInsecureIssuer(settings);
  let configuration = null; // promise of a client.Configuration
  let failedAt = -Infinity;

  function discover() {
    if (!settings.enabled) return Promise.reject(new OidcError('unavailable', 'No identity provider is configured'));
    if (configuration) return configuration;
    if (now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.reject(new OidcError('unavailable', 'The identity provider could not be reached a moment ago'));

    // A public client has no secret and proves itself with PKCE alone
    const authentication = !settings.clientSecret
      ? client.None()
      : settings.clientAuthMethod === 'client_secret_post'
        ? client.ClientSecretPost(settings.clientSecret)
        : client.ClientSecretBasic(settings.clientSecret);
    const execute = [client.enableNonRepudiationChecks]; // always verify the ID token's signature against the provider's keys
    if (insecure) execute.push(client.allowInsecureRequests);

    const attempt = client.discovery(new URL(settings.issuer), settings.clientId, undefined, authentication, { execute, timeout: DISCOVERY_TIMEOUT_S })
      .then((found) => {
        log.info(`identity provider discovered: ${found.serverMetadata().issuer}`);
        return found;
      }, (err) => {
        configuration = null;
        failedAt = now();
        log.error(`identity provider discovery failed (${settings.issuer}): ${err.message}`);
        throw new OidcError('unavailable', 'The identity provider could not be reached', err);
      });
    configuration = attempt;
    return attempt;
  }

  return {
    enabled: settings.enabled,
    providerName: settings.enabled ? settings.providerName : null,
    redirectUri,

    /** Start a sign-in: the URL to send the browser to, and what must be remembered until it comes back */
    async begin() {
      const config = await discover();
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: settings.scopes.join(' '),
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url: url.href, pending: { state, nonce, codeVerifier } };
    },

    /**
     * Finish a sign-in. `callbackUrl` is the URL the provider sent the browser
     * back to, rebuilt on PUBLIC_URL (never on the Host header); `pending` is
     * what begin() returned. Throws an OidcError when anything does not match
     */
    async complete(callbackUrl, pending) {
      const config = await discover();
      let tokens;
      try {
        tokens = await client.authorizationCodeGrant(config, callbackUrl, {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        });
      } catch (err) {
        throw new OidcError('rejected', `The provider's answer was refused: ${err.message}`, err);
      }
      const idClaims = tokens.claims();
      if (!idClaims?.sub) throw new OidcError('rejected', 'The provider returned no ID token');
      return { idClaims, idToken: tokens.id_token, accessToken: tokens.access_token };
    },

    /** Ask the userinfo endpoint; null when the provider has none or refuses (the caller then does without) */
    async userinfo(accessToken, subject) {
      const config = await discover();
      if (!config.serverMetadata().userinfo_endpoint || !accessToken) return null;
      try {
        return await client.fetchUserInfo(config, accessToken, subject);
      } catch (err) {
        log.warn(`userinfo request failed: ${err.message}`);
        return null;
      }
    },

    /** Where to send the browser so the provider ends its own session too; null when it offers no such endpoint */
    async endSessionUrl({ idToken } = {}) {
      if (!settings.enabled) return null;
      let config;
      try { config = await discover(); } catch { return null; }
      if (!config.serverMetadata().end_session_endpoint) return null;
      try {
        return client.buildEndSessionUrl(config, {
          post_logout_redirect_uri: `${publicUrl}/login`,
          ...(idToken ? { id_token_hint: idToken } : {}),
        }).href;
      } catch (err) {
        log.warn(`could not build the provider's sign-out URL: ${err.message}`);
        return null;
      }
    },
  };
}
