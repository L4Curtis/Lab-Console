/**
 * Files of the data directory already imported into the database (legacy.js):
 * one row per file, written in the same transaction as its records, so that
 * a file whose import committed is never imported twice
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE legacy_imports (
    path TEXT PRIMARY KEY,
    imported_at TEXT NOT NULL,
    records INTEGER NOT NULL,
    skipped INTEGER NOT NULL
  )`);
}
