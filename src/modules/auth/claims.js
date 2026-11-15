/**
 * From an identity provider's claims to a Lab Console user
 *
 * Providers disagree on where groups live and what they look like: a
 * top-level array (Pocket ID, Authentik, Authelia), a nested object
 * (Keycloak's `realm_access.roles`), a single string when there is only one
 * group, or nothing at all in the ID token because the provider only answers
 * at its userinfo endpoint. This file hides those differences; nothing in it
 * is specific to one product
 */
import { createUser } from './user.js';
import { resolveRole, isAllowed } from './roles.js';

const MAX_GROUPS = 200;
const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Read a claim by name. `path` is tried as one literal name first (some
 * providers use URLs or dotted names as claim names), then as a dotted path
 * into nested objects: "realm_access.roles"
 */
export function readClaim(claims, path) {
  if (claims === null || typeof claims !== 'object') return undefined;
  if (Object.hasOwn(claims, path)) return claims[path];
  let node = claims;
  for (const part of String(path).split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Normalise a groups claim to a list of names, or null when the claim is
 * absent (so the caller can look elsewhere). A string is one group, or
 * several separated by commas; anything that is not text is ignored
 */
export function toGroups(value) {
  if (value === undefined || value === null) return null;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const names = items.filter((g) => typeof g === 'string').map((g) => g.trim()).filter(Boolean).map((g) => g.slice(0, 200));
  return [...new Set(names)].slice(0, MAX_GROUPS);
}

/** Groups from the ID token, else from userinfo, else none */
export function groupsFrom(idClaims, userinfo, groupsClaim) {
  return toGroups(readClaim(idClaims, groupsClaim)) ?? toGroups(readClaim(userinfo, groupsClaim)) ?? [];
}

/** The subject of an ID token, as the user id `oidc:<sub>` uses it ('' when there is none) */
export const subjectOf = (idClaims) => text(idClaims?.sub, 255);

/**
 * Decide who this is and whether they may come in.
 * → { allowed: true, user } or { allowed: false, username, groups }
 *
 * Role and access are decided by roles.js (resolveRole, isAllowed);
 * `storedRole` is a role recorded for this user, when there is one
 */
export function userFromClaims({ idClaims, userinfo = null, settings, storedRole = null }) {
  const pick = (name) => text(idClaims?.[name]) || text(userinfo?.[name]);
  const sub = subjectOf(idClaims);
  if (!sub) throw new TypeError('The ID token has no subject');

  const groups = groupsFrom(idClaims, userinfo, settings.groupsClaim);
  const email = pick('email');
  const username = pick('preferred_username') || email || sub;
  const name = pick('name') || [pick('given_name'), pick('family_name')].filter(Boolean).join(' ') || username;

  if (!isAllowed({ groups, allowedGroups: settings.allowedGroups, adminGroups: settings.adminGroups })) {
    return { allowed: false, username, groups };
  }
  const role = resolveRole({ groups, adminGroups: settings.adminGroups, storedRole });
  return { allowed: true, user: createUser({ id: `oidc:${sub}`, username, name, email, role, groups, via: 'oidc' }) };
}

/** True when the ID token alone does not say enough and userinfo should be asked */
export function needsUserinfo(idClaims, groupsClaim) {
  const noGroups = toGroups(readClaim(idClaims, groupsClaim)) === null;
  const noName = !text(idClaims?.name) && !text(idClaims?.preferred_username) && !text(idClaims?.email);
  return noGroups || noName;
}
