/**
 * The database of the platform (ARCHITECTURE §6, "database")
 *
 *   const db = await openDatabase({ file: store.resolve('lab-console.db'), logger });
 *   const repos = createRepositories(db);
 *   await importLegacyFiles({ store, repos, logger });
 *
 * openDatabase opens the adapter and brings the schema to the code's version
 * (migrate.js) before anything else may use it; when a migration fails the
 * database is closed again and the error says which one. Only SQLite exists
 * today; a PostgreSQL adapter would be chosen here, with the same interface
 */
import { openSqlite } from './sqlite.js';
import { loadMigrations, migrate } from './migrate.js';

export { DatabaseError, portabilityProblems, assertPortable } from './portable.js';
export { MigrationError, loadMigrations, migrate } from './migrate.js';
export { createRepositories } from './repositories/index.js';
export { importLegacyFiles } from './legacy.js';

/** file: a path, or ':memory:' (tests). Resolves to a migrated database */
export async function openDatabase({ file, logger, migrations } = {}) {
  if (!file) throw new TypeError('openDatabase needs a file');
  const db = openSqlite(file);
  try {
    await migrate(db, migrations ?? await loadMigrations(), { logger });
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }
  return db;
}
