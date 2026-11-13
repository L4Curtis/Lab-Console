/**
 * Run-time settings (src/lib/settings.js): the values an administrator saved
 * for one namespace, as JSON text. They win over the environment's values
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE settings (
    namespace TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`);
}
