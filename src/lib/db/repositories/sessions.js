/**
 * Repository of the sign-in sessions (table auth_sessions, migration 002)
 *
 * Speaks the session store's language (times in milliseconds, the user as an
 * object) and stores the portable one (ISO text, JSON text). The token is
 * never given to it: only its SHA-256
 *
 *   all()                     → [{ id, hash, user, createdAt, lastSeenAt, expiresAt, ip, userAgent, binding }]
 *   insert(session)           a new session
 *   insertIfAbsent(session)   the same, ignored when the id or the hash exists (imports)
 *   remove(id)                → { changes }
 *   rehash(id, hash)          the token was rotated
 *   touch(id, lastSeenAt)     last activity
 *   touchAll([[id, lastSeenAt], …])   several, in one transaction
 */
import { toIso, fromIso, toJson, fromJson } from '../values.js';

const COLUMNS = 'id, token_hash, user_id, user_data, created_at, last_seen_at, expires_at, ip, user_agent, binding';
const VALUES = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

const userData = ({ id, username, name, email, role, groups, via }) => ({ id, username, name, email, role, groups, via });

function row(session) {
  const times = [session.createdAt, session.lastSeenAt, session.expiresAt].map(toIso);
  if (times.includes(null)) throw new TypeError('A session needs valid creation, activity and expiry times');
  return [
    String(session.id), String(session.hash), String(session.user.id), toJson(userData(session.user)),
    ...times, String(session.ip ?? ''), String(session.userAgent ?? ''), session.binding ?? null,
  ];
}

const record = (r) => ({
  id: r.id,
  hash: r.token_hash,
  user: fromJson(r.user_data),
  createdAt: fromIso(r.created_at),
  lastSeenAt: fromIso(r.last_seen_at),
  expiresAt: fromIso(r.expires_at),
  ip: r.ip,
  userAgent: r.user_agent,
  binding: r.binding ?? undefined,
});

export function createSessionsRepository(db) {
  const touch = (executor, id, lastSeenAt) => executor.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?', [toIso(lastSeenAt), id]);
  return {
    async all() {
      return (await db.query(`SELECT ${COLUMNS} FROM auth_sessions ORDER BY created_at, id`)).map(record);
    },
    insert: (session) => db.run(`INSERT INTO auth_sessions (${COLUMNS}) VALUES (${VALUES})`, row(session)),
    insertIfAbsent: (session) => db.run(`INSERT INTO auth_sessions (${COLUMNS}) VALUES (${VALUES}) ON CONFLICT DO NOTHING`, row(session)),
    remove: (id) => db.run('DELETE FROM auth_sessions WHERE id = ?', [id]),
    rehash: (id, hash) => db.run('UPDATE auth_sessions SET token_hash = ? WHERE id = ?', [hash, id]),
    touch: (id, lastSeenAt) => touch(db, id, lastSeenAt),
    touchAll: (entries) => db.transaction(async (tx) => {
      for (const [id, lastSeenAt] of entries) await touch(tx, id, lastSeenAt);
    }),
  };
}
