/**
 * Sign-ins in progress at the identity provider
 *
 * Between the moment a browser is sent to the provider and the moment it
 * comes back, the server must remember what it asked for: the `state`, the
 * `nonce`, the PKCE verifier and where to go afterwards. That is kept here,
 * in memory, for ten minutes, under a random id that only the browser that
 * started the sign-in holds (in an HttpOnly cookie). An entry can be taken
 * once: a callback that is replayed finds nothing
 *
 * Anyone can start a sign-in, so the store is bounded twice: `max` entries in
 * all, and `perOwner` per client address. A client that starts more loses
 * its own oldest attempt first, so strangers starting sign-ins in a loop do
 * not push out the real users' attempts; only a crowd of addresses filling
 * all of `max` within the ten minutes could
 */
import crypto from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{43}$/;
const hashOf = (id) => crypto.createHash('sha256').update(id).digest('hex');

export function createPendingLogins({ ttlMs = 10 * 60_000, max = 5000, perOwner = 10, now = Date.now } = {}) {
  const entries = new Map(); // hash of the id → { data, expiresAt, owner }, oldest first
  const owners = new Map();  // owner → Set of hashes, oldest first

  function forget(hash) {
    const entry = entries.get(hash);
    if (!entry) return null;
    entries.delete(hash);
    const mine = owners.get(entry.owner);
    mine?.delete(hash);
    if (mine && !mine.size) owners.delete(entry.owner);
    return entry;
  }

  return {
    ttlMs,

    /** Remember `data` for `owner` (the client address); returns the id to hand to the browser */
    put(data, { owner = '' } = {}) {
      const at = now();
      for (const [hash, entry] of entries) {
        if (entry.expiresAt > at) break; // the rest is younger
        forget(hash);
      }
      const key = String(owner);
      const mine = owners.get(key);
      while (mine && mine.size >= perOwner) forget(mine.values().next().value); // this client's oldest gives way
      while (entries.size >= max) forget(entries.keys().next().value); // then the oldest of all
      const id = crypto.randomBytes(32).toString('base64url');
      const hash = hashOf(id);
      entries.set(hash, { data, expiresAt: at + ttlMs, owner: key });
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(hash);
      return id;
    },

    /** Hand the data back and forget it. null when unknown, expired or already taken */
    take(id) {
      if (typeof id !== 'string' || !ID.test(id)) return null;
      const entry = forget(hashOf(id));
      if (!entry) return null;
      return entry.expiresAt > now() ? entry.data : null;
    },

    /** Forget without using (the browser started over) */
    discard(id) {
      if (typeof id === 'string' && ID.test(id)) forget(hashOf(id));
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
