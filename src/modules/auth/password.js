/**
 * Password hashing for the local administrator: scrypt, from node:crypto
 *
 * A hash is one line, safe to paste in a .env file or a compose file (no `$`,
 * which both would try to expand):
 *
 *   scrypt:<N>:<r>:<p>:<salt, base64url>:<key, base64url>
 *
 * The cost parameters travel with the hash, so they can be raised later
 * without invalidating the one already configured
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** N = 2^15, r = 8, p = 3: the OWASP recommendation that fits in 32 MB */
export const SCRYPT_DEFAULTS = Object.freeze({ N: 32768, r: 8, p: 3 });
const KEY_BYTES = 32;
const SALT_BYTES = 16;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

const maxmem = ({ N, r }) => 128 * N * r + 1024 * 1024;

/** Take a stored hash apart; null when it is not one of ours or its costs are unreasonable */
export function parseHash(stored) {
  const parts = String(stored ?? '').trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const powerOfTwo = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 8 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || key.length < 16) return null;
  return { N, r, p, salt, key };
}

export async function hashPassword(password, { N, r, p } = SCRYPT_DEFAULTS) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('A password is required');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: maxmem({ N, r }) });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

/**
 * True when `password` matches `stored`. The derivation always runs, even for
 * an empty or oversized candidate, and the comparison is constant-time: how
 * long the answer takes says nothing about the password
 */
export async function verifyPassword(password, stored) {
  const parsed = typeof stored === 'string' ? parseHash(stored) : stored;
  if (!parsed) return false;
  const usable = typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
  const candidate = usable ? password.normalize('NFKC') : '';
  const { N, r, p, salt, key } = parsed;
  const derived = await scrypt(candidate, salt, key.length, { N, r, p, maxmem: maxmem({ N, r }) });
  return crypto.timingSafeEqual(derived, key) && usable;
}

/** Constant-time equality of two short strings of any length (user names, state values) */
export function safeEqual(a, b) {
  const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return crypto.timingSafeEqual(digest(a), digest(b)) && typeof a === 'string' && typeof b === 'string';
}
