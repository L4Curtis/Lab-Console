/**
 * Repository of the audit trail (table audit_entries, migration 003)
 *
 *   insert(entry)       entry = { ts, action, actor: { id, username, name, role, via }, ip?, details }
 *   query({ since, until, actorId, actions, bench, limit })   → entries, newest first
 *   countSame(entry)    → number of entries with the same time, action, actor id and details (imports)
 *   count()             → number of entries
 *
 * `since` / `until` are ISO-8601 strings (inclusive); `actions` is a list of
 * exact actions or dotted prefixes ('console' selects console.open and
 * console.control.grant, never consolex); every criterion is optional.
 * Entries come back in the shape they were given
 */
import { toIso, toJson, fromJson, newId } from '../values.js';

const COLUMNS = 'id, ts, action, actor_id, actor_username, actor_name, actor_role, actor_via, ip, bench, details';
const text = (v) => (v === undefined || v === null ? null : String(v));

function entryOf(r) {
  const actor = { id: r.actor_id };
  for (const [key, column] of [['username', 'actor_username'], ['name', 'actor_name'], ['role', 'actor_role'], ['via', 'actor_via']]) {
    if (r[column] !== null) actor[key] = r[column];
  }
  return { ts: r.ts, action: r.action, actor, ...(r.ip ? { ip: r.ip } : {}), details: fromJson(r.details, {}) };
}

export function createAuditRepository(db) {
  return {
    async insert(entry) {
      const ts = toIso(entry.ts);
      if (!ts) throw new TypeError(`An audit entry needs a valid time (got ${entry.ts})`);
      const { actor = {}, details = {} } = entry;
      return db.run(`INSERT INTO audit_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        newId(Date.parse(ts)), ts, String(entry.action), String(actor.id),
        text(actor.username), text(actor.name), text(actor.role), text(actor.via),
        entry.ip ? String(entry.ip) : null,
        typeof details?.bench === 'string' ? details.bench : null,
        toJson(details),
      ]);
    },

    async query({ since, until, actorId, actions, bench, limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (since) { where.push('ts >= ?'); params.push(since); }
      if (until) { where.push('ts <= ?'); params.push(until); }
      if (actorId) { where.push('actor_id = ?'); params.push(String(actorId)); }
      if (bench) { where.push('bench = ?'); params.push(String(bench)); }
      if (actions) {
        if (!actions.length) return [];
        where.push(`(${actions.map(() => '(action = ? OR substr(action, 1, ?) = ?)').join(' OR ')})`);
        for (const a of actions) params.push(String(a), String(a).length + 1, `${a}.`);
      }
      params.push(limit);
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM audit_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT ?`,
        params,
      );
      return rows.map(entryOf);
    },

    async countSame(entry) {
      const ts = toIso(entry.ts);
      if (!ts) throw new TypeError(`An audit entry needs a valid time (got ${entry.ts})`);
      const found = await db.get(
        'SELECT count(*) AS n FROM audit_entries WHERE ts = ? AND action = ? AND actor_id = ? AND details = ?',
        [ts, String(entry.action), String(entry.actor?.id), toJson(entry.details ?? {})],
      );
      return Number(found.n);
    },

    async count() {
      return Number((await db.get('SELECT count(*) AS n FROM audit_entries')).n);
    },
  };
}
