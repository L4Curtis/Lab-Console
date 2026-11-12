/**
 * Time-based one-time passwords (RFC 6238, on top of HOTP, RFC 4226)
 *
 * The local administrator's second factor. Codes are the ones every
 * authenticator app produces: HMAC-SHA1, 6 digits, 30-second steps. A code is
 * accepted for the current step and one step either side (clock drift), and
 * the caller remembers the last accepted step so that a code seen over
 * someone's shoulder cannot be used a second time
 */
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_DEFAULTS = Object.freeze({ algorithm: 'sha1', digits: 6, period: 30, window: 1 });

/** Bytes → RFC 4648 base32, without padding (what authenticator apps expect) */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 → bytes. Spaces, dashes, padding and lower case are tolerated; anything else throws */
export function base32Decode(text) {
  const clean = String(text ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new TypeError('Not a base32 string');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret for an authenticator app: 160 random bits, as RFC 4226 recommends */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP value for one counter (RFC 4226 §5.3), as a zero-padded string */
export function hotp(key, counter, { algorithm = TOTP_DEFAULTS.algorithm, digits = TOTP_DEFAULTS.digits } = {}) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The step number a moment falls in */
export function stepAt(timeMs, period = TOTP_DEFAULTS.period) {
  return Math.floor(timeMs / 1000 / period);
}

/** The code an authenticator shows at `timeMs` (tests, and the setup script's self-check) */
export function totp(key, timeMs = Date.now(), options = {}) {
  return hotp(key, stepAt(timeMs, options.period ?? TOTP_DEFAULTS.period), options);
}

/**
 * Check a code. Returns the step it belongs to, or null.
 *
 * Every candidate step is computed and compared in constant time, whatever
 * the input, so the answer time says nothing about how close a guess was.
 * `after` is the last step already used: that step and older ones are refused
 */
export function verifyTotp(key, code, { timeMs = Date.now(), after = -1, window = TOTP_DEFAULTS.window, ...options } = {}) {
  const digits = options.digits ?? TOTP_DEFAULTS.digits;
  const given = Buffer.alloc(digits, 0);
  const text = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  const wellFormed = new RegExp(`^\\d{${digits}}$`).test(text);
  if (wellFormed) given.write(text, 'ascii');

  const current = stepAt(timeMs, options.period ?? TOTP_DEFAULTS.period);
  let matched = null;
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(key, Math.max(step, 0), options), 'ascii');
    const same = crypto.timingSafeEqual(expected, given);
    if (same && wellFormed && step > after && step >= 0 && matched === null) matched = step;
  }
  return matched;
}

/** The otpauth:// URI an authenticator app reads from a QR code */
export function otpauthUri({ secret, account, issuer = 'Lab Console' }) {
  // Spaces as %20, not "+": several authenticator apps show a "+" literally
  const enc = encodeURIComponent;
  const label = `${enc(issuer)}:${enc(account)}`;
  const query = [
    `secret=${enc(secret)}`,
    `issuer=${enc(issuer)}`,
    `algorithm=${TOTP_DEFAULTS.algorithm.toUpperCase()}`,
    `digits=${TOTP_DEFAULTS.digits}`,
    `period=${TOTP_DEFAULTS.period}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
