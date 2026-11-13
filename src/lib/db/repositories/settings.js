/**
 * Repository of the run-time settings (table settings, migration 004): the
 * values an administrator saved, one JSON document per namespace (the saved
 * fields by dotted path, src/lib/settings.js), with who saved them and when
 *
 *   all()                        → { [namespace]: { values, updatedAt, updatedBy } }
 *   get(namespace)               → { values, updatedAt, updatedBy }, or undefined
 *   save(namespace, values, by)  insert, or update the saved values; `by` is the user id
 *   saveIfAbsent(namespace, values, by, at)   the import of a file of before: what the database holds wins
 *   remove(namespace)            back to the environment's values
 */
import { toIso, toJson } from '../values.js';

const doc = (r) => ({ values: JSON.parse(r.data), updatedAt: r.updated_at, updatedBy: r.updated_by ?? null });

export function createSettingsRepository(db, { now = () => new Date() } = {}) {
  return {
    async all() {
      const rows = await db.query('SELECT namespace, data, updated_at, updated_by FROM settings ORDER BY namespace');
      return Object.fromEntries(rows.map((r) => [r.namespace, doc(r)]));
    },
    async get(namespace) {
      const found = await db.get('SELECT data, updated_at, updated_by FROM settings WHERE namespace = ?', [String(namespace)]);
      return found === undefined ? undefined : doc(found);
    },
    async save(namespace, values, by = null) {
      return db.run(
        `INSERT INTO settings (namespace, data, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (namespace) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [String(namespace), toJson(values), toIso(now()), by === null || by === undefined ? null : String(by)],
      );
    },
    async saveIfAbsent(namespace, values, by = null, at = now()) {
      return db.run(
        'INSERT INTO settings (namespace, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (namespace) DO NOTHING',
        [String(namespace), toJson(values), toIso(at), by === null || by === undefined ? null : String(by)],
      );
    },
    async remove(namespace) { return db.run('DELETE FROM settings WHERE namespace = ?', [String(namespace)]); },
  };
}
