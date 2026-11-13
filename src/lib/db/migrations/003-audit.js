/**
 * The audit trail (src/lib/audit.js): one row per action, never updated.
 * The columns the administration filters on are real columns with an index
 * each (time, actor, action, bench); everything else stays in `details`
 * (JSON text). `id` is a UUID v7, so it also breaks ties between entries
 * recorded in the same millisecond
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE audit_entries (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_username TEXT,
    actor_name TEXT,
    actor_role TEXT,
    actor_via TEXT,
    ip TEXT,
    bench TEXT,
    details TEXT NOT NULL
  )`);
  await tx.run('CREATE INDEX audit_entries_ts ON audit_entries (ts, id)');
  await tx.run('CREATE INDEX audit_entries_actor ON audit_entries (actor_id, ts)');
  await tx.run('CREATE INDEX audit_entries_action ON audit_entries (action, ts)');
  await tx.run('CREATE INDEX audit_entries_bench ON audit_entries (bench, ts)');
}
