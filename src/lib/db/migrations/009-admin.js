/**
 * The administration's own records: the announcement banner (the current
 * one and the last ones, src/modules/admin/announcements.js) and the index
 * of diagram versions (src/lib/diagrams.js). The diagram files themselves
 * stay files (data/diagrams/versions/<id>.drawio): the database says which
 * version is which, who imported it, and the stack of activations a rollback
 * walks back (the last row is the active diagram)
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE announcements (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    level TEXT NOT NULL,
    at TEXT NOT NULL,
    expires_at TEXT,
    by_id TEXT NOT NULL,
    by_name TEXT NOT NULL,
    removed_at TEXT
  )`);
  await tx.run('CREATE INDEX announcements_at ON announcements (at)');

  await tx.run(`CREATE TABLE diagram_versions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    at TEXT NOT NULL,
    by_id TEXT NOT NULL,
    by_username TEXT NOT NULL,
    source TEXT NOT NULL,
    labs TEXT,
    devices INTEGER,
    warnings INTEGER
  )`);
  await tx.run('CREATE INDEX diagram_versions_at ON diagram_versions (at)');

  await tx.run(`CREATE TABLE diagram_activations (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    at TEXT NOT NULL,
    by_id TEXT NOT NULL,
    position INTEGER NOT NULL
  )`);
  await tx.run('CREATE INDEX diagram_activations_position ON diagram_activations (position)');
}
