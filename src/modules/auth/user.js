/**
 * The User every module receives as `req.user` (ARCHITECTURE §5), whatever
 * the way the person signed in
 *
 *   id        'oidc:<sub>' | 'local:<username>'
 *   role      'student' | 'admin'
 *   via       'oidc' | 'local'
 *   initials, color   stable, derived from the id, for presence badges
 */
import crypto from 'node:crypto';

export const ROLES = Object.freeze(['student', 'admin']);

/** True when `user` holds `role` or a higher one (an admin can do what a student can) */
export function hasRole(user, role) {
  const need = ROLES.indexOf(role);
  return Boolean(user) && need !== -1 && ROLES.indexOf(user.role) >= need;
}

/** "Ada Lovelace" → "AL", "curtis" → "CU" */
export function initialsOf(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join('').toUpperCase();
}

/** A hue picked from the id: the same person keeps the same badge colour everywhere */
export function colorOf(id) {
  const hue = crypto.createHash('sha256').update(String(id)).digest().readUInt16BE(0) % 360;
  return `hsl(${hue} 62% 42%)`;
}

export function createUser({ id, username, name, email = '', role = 'student', groups = [], via }) {
  if (!id || !via) throw new TypeError('A user needs an id and a via');
  if (!ROLES.includes(role)) throw new TypeError(`Unknown role "${role}"`);
  const display = name || username || String(id);
  return Object.freeze({
    id: String(id),
    username: username || String(id),
    name: display,
    email,
    role,
    groups: Object.freeze([...groups]),
    via,
    initials: initialsOf(display),
    color: colorOf(id),
  });
}
