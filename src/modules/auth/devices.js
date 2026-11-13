/**
 * Known browsers of the local sign-in (the OWASP "device cookie")
 *
 * After a successful local sign-in the browser receives a long-lived cookie
 * that says "this browser has already signed in as <name>". The next time it
 * signs in with that name, the attempt limiter counts its attempts on that
 * browser alone (throttle.js): what strangers do to the name or to the global
 * count no longer keeps the owner out. It is not a credential: the user name,
 * the password and the code are still all required.
 *
 * The cookie is stateless and opaque:
 *
 *   version (1 byte) | issued at, seconds (4 bytes) | random id (16 bytes) | HMAC-SHA256 (32 bytes)
 *
 * The HMAC covers the first three fields and the user name, so the name is
 * not in the cookie, a cookie only counts for the name it was issued for,
 * and nobody can make one without the key. A cookie lives `maxAgeMs` (180 days)
 *
 * The key is a random secret of its own, kept in the database (auth_state
 * 'device-key', loadDeviceKey). It does not derive from the administrator's credentials on
 * purpose: replacing them after a suspected compromise - exactly when someone
 * is likely to be hammering the form - must not turn the administrator's own
 * browsers into strangers that the shared refusals keep out. Whatever was
 * obtained with the old credentials ends anyway: the sessions through their
 * binding (envAdmin.js, sessions.js), and a cookie on its own opens nothing.
 * Deleting that value (then restarting) forgets every known browser
 */
import crypto from 'node:crypto';
import { nameKey } from './throttle.js';

const KEY_NAME = 'device-key';
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url, no padding

/**
 * The key of the known-browser cookies: the one saved in the database, or a
 * new one, saved there, when there is none yet (or it is not usable). If it
 * cannot be read, a key for this run only: known browsers are strangers
 * until it can be read again, and the saved one is never overwritten.
 * `state` is the auth state repository (createRepositories(db).authState)
 */
export async function loadDeviceKey({ state, logger }) {
  const log = logger ?? { warn() {}, error() {} };
  let saved;
  try {
    saved = await state.get(KEY_NAME);
  } catch (err) {
    log.error(`the known-browser key could not be read (${err.message}): known browsers are not recognised until it can be`);
    return crypto.randomBytes(32);
  }
  if (typeof saved?.key === 'string' && KEY_TEXT.test(saved.key)) return Buffer.from(saved.key, 'base64url');
  if (saved !== undefined) log.warn('the saved known-browser key is not usable: a new one replaces it, known browsers have to sign in again');
  const key = crypto.randomBytes(32);
  try {
    await state.set(KEY_NAME, { key: key.toString('base64url') });
  } catch (err) {
    log.error(`the known-browser key could not be saved (${err.message}): known browsers will not be recognised after a restart`);
  }
  return key;
}

const VERSION = 1;
const BYTES = 1 + 4 + 16 + 32;
const VALUE = /^[A-Za-z0-9_-]{71}$/; // BYTES in base64url, no padding
export const DEVICE_MAX_AGE_MS = 180 * 24 * 60 * 60_000;

export function createDeviceCookies({ key, now = Date.now, maxAgeMs = DEVICE_MAX_AGE_MS }) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new TypeError('Known-browser cookies need a 32-byte key');
  const mac = (head, username) => crypto.createHmac('sha256', key).update(head).update('\0').update(nameKey(username)).digest();

  return {
    maxAgeMs,

    /** A new cookie value for a browser that has just signed in as `username` */
    issue(username) {
      const head = Buffer.alloc(1 + 4 + 16);
      head.writeUInt8(VERSION, 0);
      head.writeUInt32BE(Math.floor(now() / 1000), 1);
      crypto.randomFillSync(head, 5, 16);
      return Buffer.concat([head, mac(head, username)]).toString('base64url');
    },

    /** The browser's id when `value` is a valid, unexpired cookie for `username`; null otherwise */
    check(value, username) {
      if (typeof value !== 'string' || !VALUE.test(value) || !nameKey(username)) return null;
      const raw = Buffer.from(value, 'base64url');
      if (raw.length !== BYTES || raw.readUInt8(0) !== VERSION) return null;
      const head = raw.subarray(0, 21);
      if (!crypto.timingSafeEqual(raw.subarray(21), mac(head, username))) return null;
      const issuedMs = raw.readUInt32BE(1) * 1000;
      const at = now();
      if (issuedMs > at + 60_000 || at - issuedMs >= maxAgeMs) return null;
      return head.subarray(5).toString('hex');
    },
  };
}
