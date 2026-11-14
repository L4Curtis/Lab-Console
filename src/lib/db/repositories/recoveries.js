/**
 * Repository of the password recoveries (table recoveries, migration 015)
 *
 *   save(recovery)                        insert or update one recovery
 *   get(id)                               → Recovery | null
 *   list({ bench, device, limit })        → Recovery[] newest first
 *   unfinished()                          → the recoveries a stopped server left open (closed at start-up)
 *
 * Recovery: { id, bench, device: { key, name }, family, actor: { id, username, name }, teamId,
 *             state, steps: [{ id, state, code, params, at }], code, createdAt, endedAt }
 */
import { toIso, toJson, fromJson } from '../values.js';

const COLUMNS = 'id, bench, device_key, device_name, family, actor, team_id, state, steps, code, created_at, ended_at';
const FINAL = ['done', 'failed', 'cancelled'];

const view = (r) => ({
  id: r.id,
  bench: r.bench,
  device: { key: r.device_key, name: r.device_name },
  family: r.family,
  actor: fromJson(r.actor, {}),
  teamId: r.team_id ?? null,
  state: r.state,
  steps: fromJson(r.steps, []),
  code: r.code ?? null,
  createdAt: r.created_at,
  endedAt: r.ended_at ?? null,
});

export function createRecoveriesRepository(db) {
  return {
    async save(rec) {
      return db.run(
        `INSERT INTO recoveries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, steps = excluded.steps, code = excluded.code, ended_at = excluded.ended_at`,
        [String(rec.id), String(rec.bench), String(rec.device.key), String(rec.device.name), String(rec.family), toJson(rec.actor ?? {}),
          rec.teamId ?? null, String(rec.state), toJson(rec.steps ?? []), rec.code ?? null, toIso(rec.createdAt), toIso(rec.endedAt)],
      );
    },
    async get(id) {
      const row = await db.get(`SELECT ${COLUMNS} FROM recoveries WHERE id = ?`, [String(id)]);
      return row ? view(row) : null;
    },
    async list({ bench, device, limit = 50 } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      const where = [];
      const args = [];
      if (bench !== undefined) { where.push('bench = ?'); args.push(String(bench)); }
      if (device !== undefined) { where.push('device_key = ?'); args.push(String(device)); }
      const rows = await db.query(`SELECT ${COLUMNS} FROM recoveries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${n}`, args);
      return rows.map(view);
    },
    async unfinished() {
      const rows = await db.query(`SELECT ${COLUMNS} FROM recoveries WHERE state NOT IN (${FINAL.map(() => '?').join(', ')})`, FINAL);
      return rows.map(view);
    },
  };
}
