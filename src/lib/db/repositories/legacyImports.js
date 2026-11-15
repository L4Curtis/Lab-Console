/**
 * Repository of the files already imported (table legacy_imports, migrations 001 and 005)
 *
 *   find(path)                                  → { sha256 } (null when recorded without one), or undefined
 *   record(path, { records, skipped }, sha256)  insert, or update the row of a file imported again
 *
 * `path` is relative to DATA_DIR; `sha256` is the hex SHA-256 of the file's content
 */
import { toIso } from '../values.js';

export function createLegacyImportsRepository(db, { now = () => new Date() } = {}) {
  return {
    async find(path) {
      const found = await db.get('SELECT sha256 FROM legacy_imports WHERE path = ?', [String(path)]);
      return found === undefined ? undefined : { sha256: found.sha256 ?? null };
    },
    async record(path, { records = 0, skipped = 0 } = {}, sha256 = null) {
      return db.run(
        `INSERT INTO legacy_imports (path, imported_at, records, skipped, sha256) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET imported_at = excluded.imported_at, records = excluded.records,
           skipped = excluded.skipped, sha256 = excluded.sha256`,
        [String(path), toIso(now()), records, skipped, sha256],
      );
    },
  };
}
