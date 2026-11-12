/**
 * Sign-ins in progress at the identity provider
 *
 * Between the moment a browser is sent to the provider and the moment it
 * comes back, the server must remember what it asked for: the `state`, the
 * `nonce`, the PKCE verifier and where to go afterwards. That is kept here,
 * in memory, for ten minutes, under a random id that only the browser that
 * started the sign-in holds (in an HttpOnly cookie). An entry can be taken
 * once: a callback that is replayed finds nothing
 */
import crypto from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{43}$/;
const hashOf = (id) => crypto.createHash('sha256').update(id).digest('hex');

export function createPendingLogins({ ttlMs = 10 * 60_000, max = 500, now = Date.now } = {}) {
  const entries = new Map(); // hash of the id → { data, expiresAt }, oldest first

  return {
    ttlMs,

    /** Remember `data`; returns the id to hand to the browser */
    put(data) {
      const at = now();
      for (const [hash, entry] of entries) {
        if (entry.expiresAt > at && entries.size < max) break; // the rest is younger
        entries.delete(hash); // expired, or the oldest one giving way: the map never grows past `max`
      }
      const id = crypto.randomBytes(32).toString('base64url');
      entries.set(hashOf(id), { data, expiresAt: at + ttlMs });
      return id;
    },

    /** Hand the data back and forget it. null when unknown, expired or already taken */
    take(id) {
      if (typeof id !== 'string' || !ID.test(id)) return null;
      const hash = hashOf(id);
      const entry = entries.get(hash);
      if (!entry) return null;
      entries.delete(hash);
      return entry.expiresAt > now() ? entry.data : null;
    },

    /** Forget without using (the browser started over) */
    discard(id) {
      if (typeof id === 'string' && ID.test(id)) entries.delete(hashOf(id));
    },

    get size() { return entries.size; },
  };
}

/**
 * Where to go after signing in: a path on this site and nothing else.
 * Anything that could lead a browser to another origin - an absolute URL,
 * `//host`, a backslash, a control character - becomes "/". So does a path
 * back into the sign-in routes, which would loop
 */
export function safeReturnPath(value) {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'http://lab.invalid');
    if (url.origin !== 'http://lab.invalid' || url.pathname.startsWith('//')) return '/';
    if (url.pathname === '/login' || url.pathname.startsWith('/auth/')) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}
