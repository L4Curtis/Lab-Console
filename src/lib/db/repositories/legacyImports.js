/**
 * Repository of the files already imported (table legacy_imports, migration 001)
 *
 *   has(path)                         → boolean (path relative to DATA_DIR)
 *   record(path, { records, skipped })
 */
import { toIso } from '../values.js';

export function createLegacyImportsRepository(db, { now = () => new Date() } = {}) {
  return {
    async has(path) {
      return (await db.get('SELECT path FROM legacy_imports WHERE path = ?', [path])) !== undefined;
    },
    record: (path, { records = 0, skipped = 0 } = {}) => db.run(
      'INSERT INTO legacy_imports (path, imported_at, records, skipped) VALUES (?, ?, ?, ?)',
      [path, toIso(now()), records, skipped],
    ),
  };
}
