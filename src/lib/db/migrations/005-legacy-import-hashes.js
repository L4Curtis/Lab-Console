/**
 * The content of each imported legacy file (legacy.js): a file that comes
 * back under a path already imported is renamed without a second import only
 * when it is the same file (a crash between the commit and the rename);
 * different content is imported, its records already in the database
 * skipped. Rows recorded before this migration have no hash: their file, if
 * it comes back, is imported the same way
 */
export async function up(tx) {
  await tx.run('ALTER TABLE legacy_imports ADD COLUMN sha256 TEXT');
}
