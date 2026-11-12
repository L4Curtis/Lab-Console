/**
 * Sign-in settings (configuration fragment, see ARCHITECTURE §3)
 *
 * There is no way to run without authentication. The local administrator is
 * mandatory: it is the account that still works when the identity provider is
 * down or not configured yet. OpenID Connect is optional and is what
 * everybody else signs in with
 *
 *   config.auth.localAdmin   { username, passwordHash, totpSecret }
 *   config.auth.oidc         see oidcSettings.js (the seed of the runtime settings)
 */
import { str, list, bool, fail } from '../../lib/env.js';
import { parseHash } from './password.js';
import { base32Decode } from './totp.js';
import { normalizeOidcSettings } from './oidcSettings.js';

export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readLocalAdmin() {
  const username = str('LOCAL_ADMIN_USERNAME');
  const passwordHash = str('LOCAL_ADMIN_PASSWORD_HASH');
  const totpSecret = str('LOCAL_ADMIN_TOTP_SECRET').replace(/[\s-]/g, '').toUpperCase();

  const missing = [
    ['LOCAL_ADMIN_USERNAME', username], ['LOCAL_ADMIN_PASSWORD_HASH', passwordHash], ['LOCAL_ADMIN_TOTP_SECRET', totpSecret],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    fail(`The local administrator is not configured (${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing). `
      + 'Lab Console never runs without sign-in: run "npm run setup-admin" and copy the three lines it prints into .env');
  }

  if (username && !USERNAME.test(username)) {
    fail('LOCAL_ADMIN_USERNAME must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or a digit');
  }
  if (passwordHash && !parseHash(passwordHash)) {
    fail('LOCAL_ADMIN_PASSWORD_HASH is not a hash produced by "npm run setup-admin" (expected scrypt:N:r:p:salt:key). Never put the password itself here');
  }
  if (totpSecret) {
    let bytes = 0;
    try { bytes = base32Decode(totpSecret).length; } catch { /* reported below */ }
    if (bytes < 16) fail('LOCAL_ADMIN_TOTP_SECRET must be the base32 secret printed by "npm run setup-admin" (at least 26 characters)');
  }
  return { username, passwordHash, totpSecret };
}

function readOidc() {
  const { settings, problems } = normalizeOidcSettings({
    issuer: str('OIDC_ISSUER'),
    clientId: str('OIDC_CLIENT_ID'),
    clientSecret: str('OIDC_CLIENT_SECRET'),
    clientAuthMethod: str('OIDC_CLIENT_AUTH_METHOD'),
    scopes: str('OIDC_SCOPES'),
    groupsClaim: str('OIDC_GROUPS_CLAIM'),
    adminGroups: list('OIDC_ADMIN_GROUPS'),
    allowedGroups: list('OIDC_ALLOWED_GROUPS'),
    providerName: str('OIDC_PROVIDER_NAME'),
    allowInsecure: bool('OIDC_ALLOW_INSECURE', false),
  });
  for (const problem of problems) fail(problem);
  return settings;
}

export function readConfig() {
  return { localAdmin: readLocalAdmin(), oidc: readOidc() };
}
