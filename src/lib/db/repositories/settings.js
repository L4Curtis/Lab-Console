/**
 * Repository of the run-time settings (table settings, migration 004): the
 * values an administrator saved, one JSON document per namespace
 *
 *   all()                        → { [namespace]: values }
 *   get(namespace)               → values, or undefined
 *   save(namespace, values, by)  insert, or update the saved values; `by` is the user id
 *   remove(namespace)            back to the environment's values
 */
import { toIso, toJson } from '../values.js';

export function createSettingsRepository(db, { now = () => new Date() } = {}) {
  return {
    async all() {
      const rows = await db.query('SELECT namespace, data FROM settings ORDER BY namespace');
      return Object.fromEntries(rows.map((r) => [r.namespace, JSON.parse(r.data)]));
    },
    async get(namespace) {
      const found = await db.get('SELECT data FROM settings WHERE namespace = ?', [String(namespace)]);
      return found === undefined ? undefined : JSON.parse(found.data);
    },
    save: (namespace, values, by = null) => db.run(
      `INSERT INTO settings (namespace, data, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (namespace) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [String(namespace), toJson(values), toIso(now()), by === null || by === undefined ? null : String(by)],
    ),
    remove: (namespace) => db.run('DELETE FROM settings WHERE namespace = ?', [String(namespace)]),
  };
}
