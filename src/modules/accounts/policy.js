/**
 * What a local account may be called, and which passwords it may have
 *
 * User names are strict on purpose: they appear in the audit trail, in
 * presence badges, in file names of later lots, and they are typed on the
 * sign-in form, so letters, digits and single separators only. They are
 * unique without regard to case, across the directory and the
 * environment's administrator ("Alice" and "alice" are the same person);
 * the spelling chosen at sign-up is kept for display.
 *
 * Passwords: at least 10 characters (NIST SP 800-63B: length, not
 * composition rules), at most 1024 (scrypt input is bounded), not one of the
 * passwords everyone tries first, and not the user name itself. They are
 * stored as scrypt hashes (auth/password.js), never in clear
 */
import { MAX_PASSWORD_LENGTH } from '../auth/password.js';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const NAME_MAX = 64;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = MAX_PASSWORD_LENGTH;

/** Starts with a letter; letters and digits, with single dots, dashes or underscores between them */
const USERNAME = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

/** Names that would read as the platform itself, or as someone in charge */
const RESERVED = new Set([
  'admin', 'administrator', 'administrateur', 'root', 'system', 'sysadmin', 'support', 'staff', 'teacher',
  'anonymous', 'guest', 'nobody', 'null', 'undefined', 'me', 'api', 'auth', 'login', 'logout', 'lab-console', 'labconsole',
]);

/** The passwords tried first by anyone guessing (lower case; the comparison ignores case) */
const COMMON_PASSWORDS = new Set([
  'password1', 'password12', 'password123', 'password1234', 'passw0rd123', 'p@ssw0rd123', 'p@ssword123',
  'motdepasse', 'motdepasse1', 'motdepasse123', 'mot2passe123',
  '0123456789', '1234567890', '12345678910', '123456789a', 'a123456789', '9876543210', '0987654321',
  'azertyuiop', 'azerty1234', 'azerty123456', 'azertyuiop123', 'qwertyuiop', 'qwerty1234', 'qwerty123456', 'qwertyuiop123',
  '1q2w3e4r5t', 'q1w2e3r4t5', '1qaz2wsx3edc', 'zaq12wsxcde', 'abcdefghij', 'abcd123456', 'abc1234567',
  'iloveyou12', 'jetaime123', 'bienvenue1', 'bienvenue123', 'welcome123', 'changeme123', 'letmein123', 'trustno1234',
  'soleil1234', 'football12', 'sunshine12', 'princess12', 'dragon1234', 'superman12', 'administrator', 'administrateur',
  'labconsole', 'lab-console', 'labconsole1', 'cisco12345', 'ciscocisco', 'cisco123456', 'reseaux123', 'network123',
]);

/** The key two user names are compared by */
export const usernameKey = (name) => (typeof name === 'string' ? name.trim().normalize('NFKC').toLowerCase() : '');

/** → null when `name` may be a new account's user name, else a reason: 'username_invalid' | 'username_unavailable' */
export function checkUsername(name) {
  if (typeof name !== 'string') return 'username_invalid';
  const value = name.trim();
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX || !USERNAME.test(value)) return 'username_invalid';
  if (RESERVED.has(usernameKey(value))) return 'username_unavailable';
  return null;
}

/** A display name: trimmed, 1 to 64 characters, no control characters. → the cleaned name or null */
export function cleanDisplayName(name) {
  if (typeof name !== 'string') return null;
  const value = name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!value || [...value].length > NAME_MAX || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/.test(value)) return null;
  return value;
}

/**
 * → null when `password` is acceptable for `username`, else a reason:
 * 'password_short' | 'password_long' | 'password_common' | 'password_like_username'
 */
export function checkPassword(password, { username = '' } = {}) {
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN) return 'password_short';
  if (password.length > PASSWORD_MAX) return 'password_long';
  const folded = password.normalize('NFKC').toLowerCase();
  if (COMMON_PASSWORDS.has(folded) || /^(.)\1+$/u.test(folded)) return 'password_common';
  const name = usernameKey(username);
  if (name.length >= USERNAME_MIN && folded.includes(name)) return 'password_like_username';
  return null;
}
