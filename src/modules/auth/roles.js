/**
 * Who gets which role, and who may come in at all: one place for both
 *
 * Today a role comes from the identity provider's groups. Later a role can
 * also be stored per user (changed from the administration page); it is
 * passed as `storedRole` and then wins over the groups. Nothing else in the
 * code decides a role
 */
import { ROLES } from './user.js';

/**
 * → 'admin' | 'student'
 *   groups       the user's groups (strings), from the provider
 *   adminGroups  OIDC_ADMIN_GROUPS
 *   storedRole   a role recorded for this user, or null
 */
export function resolveRole({ groups = [], adminGroups = [], storedRole = null } = {}) {
  if (storedRole && ROLES.includes(storedRole)) return storedRole;
  return groups.some((g) => adminGroups.includes(g)) ? 'admin' : 'student';
}

/**
 * May this person sign in? Everybody when `allowedGroups` is empty; else one
 * of their groups must be listed. An administrator is never locked out by a
 * forgotten group: an admin group counts as allowed. Exact, case-sensitive names
 */
export function isAllowed({ groups = [], allowedGroups = [], adminGroups = [] } = {}) {
  if (!allowedGroups.length) return true;
  return groups.some((g) => allowedGroups.includes(g) || adminGroups.includes(g));
}
