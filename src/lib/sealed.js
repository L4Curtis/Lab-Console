/**
 * Secrets saved from the administration pages, kept in a form the server can
 * use again (it must send them: the SSO client secret to the provider, the
 * jump server's password to the jump server)
 *
 * With APP_SECRET set they are encrypted with AES-256-GCM under a key derived
 * from it (HKDF-SHA256, one key per purpose); without it they are kept in
 * clear, inside files of mode 600. A secret sealed under another APP_SECRET,
 * or under one that is no longer set, cannot be opened: openSecret() answers
 * null and the caller says so on its page.
 *
 *   const key = secretKey(config.appSecret, 'lab settings')   // null without APP_SECRET
 *   const sealed = sealSecret('s3cret', key)                 // { clear } | { alg, iv, tag, data } | ''
 *   openSecret(sealed, key)                                  // 's3cret' | '' | null
 */
import crypto from 'node:crypto';

/** The key for one purpose, derived from APP_SECRET; null without it */
export function secretKey(appSecret, purpose) {
  if (!appSecret) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(appSecret), 'lab-console', purpose, 32));
}

export function sealSecret(secret, key) {
  if (!secret) return '';
  if (!key) return { clear: secret };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { alg: 'aes-256-gcm', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
}

/** → the secret, or null when it cannot be read (encrypted with another APP_SECRET, or none set now) */
export function openSecret(sealed, key) {
  if (!sealed) return '';
  if (typeof sealed.clear === 'string') return sealed.clear;
  if (sealed.alg !== 'aes-256-gcm' || !key) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
