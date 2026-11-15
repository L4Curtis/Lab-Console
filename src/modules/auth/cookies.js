/**
 * The cookies of the sign-in module (ARCHITECTURE §5)
 *
 *   session   `__Host-lc_sid` over https, `lc_sid` over http
 *   login     `__Host-lc_login` / `lc_login`: ties a sign-in in progress at the
 *             identity provider to the browser that started it (10 minutes)
 *   device    `__Host-lc_device` / `lc_device`: a browser that already signed
 *             in on the local form (devices.js), 180 days
 *   step      `__Host-lc_step` / `lc_step`: a sign-in whose password was right
 *             and that still owes a passkey (5 minutes)
 *
 * Over https the `__Host-` prefix makes the browser itself enforce `Secure`,
 * `Path=/` and no `Domain`, so a sibling sub-domain cannot plant or read the
 * cookie. All are `HttpOnly` (scripts never see them) and `SameSite=Lax`
 * (sent on the redirect coming back from the provider, never on another
 * site's background requests). The plain names only exist for http, that is
 * for development and tests: browsers refuse `__Host-` without TLS
 */

/** Names and attributes derived once from PUBLIC_URL */
export function cookieSettings(publicUrl) {
  const secure = String(publicUrl ?? '').startsWith('https://');
  const prefix = secure ? '__Host-' : '';
  return Object.freeze({ secure, session: `${prefix}lc_sid`, login: `${prefix}lc_login`, device: `${prefix}lc_device`, step: `${prefix}lc_step` });
}

/** Read one cookie from a request (Express or raw upgrade). Only an exact name matches */
export function readCookie(req, name) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * Build a Set-Cookie value. Without `maxAgeSeconds` it is a browser-session
 * cookie: gone when the browser closes, which is what a shared lab PC needs
 */
export function serializeCookie(name, value, { secure, maxAgeSeconds } = {}) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError('Cookie values are base64url tokens');
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  return parts.join('; ');
}

/** The Set-Cookie value that removes a cookie (same attributes, expired) */
export function clearCookie(name, { secure } = {}) {
  return serializeCookie(name, '', { secure, maxAgeSeconds: 0 });
}

/** Add a Set-Cookie header without dropping the ones already set on the response */
export function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : cookie);
}
