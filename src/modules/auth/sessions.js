/**
 * Server-side sessions (ARCHITECTURE §5)
 *
 * The browser holds a random 256-bit token in a cookie; the server keeps
 * everything else, keyed by the SHA-256 of that token. The token itself is
 * never stored: the auth_sessions table (which lets a restart keep everyone
 * signed in) is useless to whoever reads it, backups included
 *
 *   const sessions = await createSessionStore({ repo, … });   // loads the saved sessions
 *   const { token, session } = sessions.create(user, { ip, userAgent });
 *   sessions.find(token)              → session | null   (also refreshes the idle timer)
 *   sessions.peek(token)              → session | null   (does not count as activity)
 *   sessions.rotate(token)            → new token for the same session
 *   sessions.revoke(id) / .revokeUser(userId) / .end(token)
 *   sessions.list()                   → what an administrator may see: no token, no hash
 *
 * A session ends after `idleMs` without activity or `absoluteMs` after it was
 * created, whichever comes first. An open console counts as activity. When a
 * session ends, for any reason, the WebSockets opened with it are destroyed
 * and `onEnd(session, reason)` is called
 *
 * `bindingOf(user)` ties a session to the credentials it was opened with: its
 * value is stored with the session, and a saved session whose binding is no
 * longer the current one is not restored. The local administrator's binding
 * is derived from its user name, password hash and TOTP secret (envAdmin.js),
 * so replacing them and restarting ends every session opened with the old
 * ones - the usual answer to a suspected compromise
 *
 * The sessions live in memory, so that every request is answered without
 * waiting; the repository (repositories/sessions.js) is written behind them:
 * at once for a sign-in, a rotation or an end, lazily (every 30 s) for "last
 * seen". Those writes never fail a request: a full disk only costs the
 * sessions' survival across a restart, and says so in the log
 */
import crypto from 'node:crypto';
import { createUser } from './user.js';

export const SESSION_IDLE_MS = 8 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const SAVE_DELAY_MS = 30_000;  // "last seen" is flushed lazily; logins and revocations at once
const SWEEP_MS = 60_000;
const MAX_PER_USER = 10;

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSessionStore({
  repo, logger, now = Date.now, idleMs = SESSION_IDLE_MS, absoluteMs = SESSION_ABSOLUTE_MS, onEnd = () => {},
  bindingOf = () => undefined,
}) {
  if (!repo) throw new TypeError('createSessionStore needs the sessions repository');
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const sessions = new Map(); // hash → session
  const sockets = new Map();  // hash → Set of raw sockets (WebSocket upgrades)
  const seen = new Set();     // ids whose lastSeenAt changed since the last write
  const writes = new Set();   // promises of writes still in flight
  let saveTimer = null;

  const expired = (session, at = now()) => at >= session.expiresAt || at - session.lastSeenAt >= idleMs;

  // ── Persistence ────────────────────────────────────────────────────────────
  /** Write behind: never rejects, never throws into a request */
  function persist(what, write) {
    let pending;
    try {
      pending = Promise.resolve(write());
    } catch (err) {
      pending = Promise.reject(err);
    }
    const settled = pending.then(() => true, (err) => {
      log.error(`sessions could not be saved (${what}): ${err.message}`);
      return false;
    });
    writes.add(settled);
    settled.finally(() => writes.delete(settled));
    return settled;
  }

  async function load() {
    let saved;
    try {
      saved = await repo.all();
    } catch (err) {
      log.error(`sessions could not be read (${err.message}); everyone has to sign in again`);
      return;
    }
    let unbound = 0;
    for (const raw of saved) {
      let session;
      try {
        session = {
          hash: raw.hash,
          id: raw.id,
          user: createUser(raw.user),
          createdAt: raw.createdAt,
          lastSeenAt: raw.lastSeenAt,
          expiresAt: raw.expiresAt,
          ip: typeof raw.ip === 'string' ? raw.ip : '',
          userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
          binding: typeof raw.binding === 'string' ? raw.binding : undefined,
        };
        if (!/^[0-9a-f]{64}$/.test(session.hash) || ![session.createdAt, session.lastSeenAt, session.expiresAt].every(Number.isFinite)) session = null;
      } catch {
        session = null; // a record that no longer describes a valid user is simply not restored
      }
      if (session && session.binding !== bindingOf(session.user)) {
        // Opened with credentials that have been replaced since (or for an account that is gone)
        unbound += 1;
        session = null;
      }
      if (session && !expired(session)) sessions.set(session.hash, session);
      else persist('cleanup', () => repo.remove(raw.id));
    }
    if (unbound) log.warn(`${unbound} saved session(s) not restored: opened with sign-in credentials that have changed since`);
  }

  /** Write the pending "last seen" times now */
  function saveSeen() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const byId = new Map([...sessions.values()].map((s) => [s.id, s]));
    const entries = [...seen].flatMap((id) => (byId.has(id) ? [[id, byId.get(id).lastSeenAt]] : []));
    seen.clear();
    if (!entries.length) return Promise.resolve(true);
    return persist('activity', () => repo.touchAll(entries));
  }

  function seenNow(session) {
    seen.add(session.id);
    if (saveTimer) return;
    saveTimer = setTimeout(saveSeen, SAVE_DELAY_MS);
    saveTimer.unref();
  }

  // ── Ending a session ───────────────────────────────────────────────────────
  function drop(hash, reason) {
    const session = sessions.get(hash);
    if (!session) return false;
    sessions.delete(hash);
    seen.delete(session.id);
    persist('end', () => repo.remove(session.id));
    for (const socket of sockets.get(hash) ?? []) socket.destroy();
    sockets.delete(hash);
    try {
      onEnd(session, reason);
    } catch (err) {
      log.error(`session end hook failed: ${err.message}`);
    }
    return true;
  }

  function lookup(token, { touch }) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const hash = hashOf(token);
    const session = sessions.get(hash);
    if (!session) return null;
    const at = now();
    if (expired(session, at)) {
      drop(hash, 'expired');
      return null;
    }
    if (touch && at - session.lastSeenAt > 1000) {
      session.lastSeenAt = at;
      seenNow(session);
    }
    return session;
  }

  /** End what has expired; an open console keeps its session alive (idle only, never past the absolute limit) */
  function sweep() {
    const at = now();
    let ended = 0;
    for (const [hash, session] of [...sessions]) {
      if (sockets.get(hash)?.size && at < session.expiresAt) {
        session.lastSeenAt = at;
        seenNow(session);
      } else if (expired(session, at)) {
        drop(hash, 'expired');
        ended += 1;
      }
    }
    return ended;
  }

  const summary = (s) => ({
    id: s.id,
    user: s.user,
    createdAt: new Date(s.createdAt).toISOString(),
    lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    expiresAt: new Date(Math.min(s.expiresAt, s.lastSeenAt + idleMs)).toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
    connections: sockets.get(s.hash)?.size ?? 0,
  });

  await load();
  const sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref();

  return {
    idleMs,
    absoluteMs,

    /** Open a session for `user`. The returned token goes in the cookie and is not kept here */
    create(user, { ip = '', userAgent = '', idToken } = {}) {
      if (!user?.id) throw new TypeError('A session needs a user');
      // One person, a bounded number of sessions: the oldest gives way
      const mine = [...sessions].filter(([, s]) => s.user.id === user.id).sort(([, a], [, b]) => a.lastSeenAt - b.lastSeenAt);
      while (mine.length >= MAX_PER_USER) drop(mine.shift()[0], 'replaced');

      const token = crypto.randomBytes(32).toString('base64url');
      const at = now();
      const session = {
        hash: hashOf(token), // internal: never listed, and the file is keyed by it anyway
        id: crypto.randomBytes(9).toString('base64url'), // public handle for lists and revocation
        user,
        createdAt: at,
        lastSeenAt: at,
        expiresAt: at + absoluteMs,
        ip: String(ip).slice(0, 64),
        userAgent: String(userAgent).slice(0, 256),
        binding: bindingOf(user),
      };
      // Kept in memory only, for the provider's sign-out; never written to disk (ARCHITECTURE §13)
      session.idToken = idToken;
      sessions.set(session.hash, session);
      persist('sign-in', () => repo.insert(session));
      return { token, session };
    },

    find: (token) => lookup(token, { touch: true }),
    peek: (token) => lookup(token, { touch: false }),

    /** Give a live session a new token; the old one stops working at once */
    rotate(token) {
      const session = lookup(token, { touch: true });
      if (!session) return null;
      const oldHash = hashOf(token);
      const next = crypto.randomBytes(32).toString('base64url');
      const newHash = hashOf(next);
      sessions.delete(oldHash);
      session.hash = newHash;
      sessions.set(newHash, session);
      if (sockets.has(oldHash)) {
        sockets.set(newHash, sockets.get(oldHash));
        sockets.delete(oldHash);
      }
      persist('rotation', () => repo.rehash(session.id, newHash));
      return next;
    },

    /** End the session a token belongs to (sign-out, or a new sign-in replacing it) */
    end(token, reason = 'logout') {
      if (typeof token !== 'string' || !TOKEN.test(token)) return false;
      return drop(hashOf(token), reason);
    },

    /** End one session by its public id (administration) */
    revoke(id, reason = 'revoked') {
      for (const [hash, session] of sessions) {
        if (session.id !== id) continue;
        drop(hash, reason);
        return true;
      }
      return false;
    },

    /** End every session of one user; returns how many */
    revokeUser(userId, reason = 'revoked') {
      let count = 0;
      for (const [hash, session] of [...sessions]) {
        if (session.user.id === userId && drop(hash, reason)) count += 1;
      }
      return count;
    },

    /** Live sessions, most recently active first */
    list() {
      sweep();
      return [...sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(summary);
    },

    /** Remember a socket opened with this session, so that ending the session closes it */
    trackSocket(token, socket) {
      if (typeof token !== 'string' || !TOKEN.test(token)) return;
      const hash = hashOf(token);
      if (!sessions.has(hash)) return socket.destroy();
      if (!sockets.has(hash)) sockets.set(hash, new Set());
      const set = sockets.get(hash);
      set.add(socket);
      socket.once('close', () => {
        set.delete(socket);
        if (!set.size && sockets.get(hash) === set) sockets.delete(hash);
      });
    },

    sweep,
    get size() { return sessions.size; },

    /** Stop the timers and write what is pending; resolves (true when every write succeeded) once it is stored */
    async shutdown() {
      clearInterval(sweeper);
      saveSeen();
      const results = await Promise.all([...writes]);
      return results.every(Boolean);
    },
  };
}
