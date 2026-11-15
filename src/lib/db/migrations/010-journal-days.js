/**
 * The console journal (src/modules/consoles/journal.js) keeps its output in
 * files, data/journal/<bench>/<device>/<day>/<session>.log, each with its
 * sidecar of who was there. This table lists the days that exist per device,
 * so the journal page, the retention sweep and the global cap never walk the
 * directory tree. bench_dir / device_dir are the safe names used on disk;
 * bench / device the names people see
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE journal_days (
    bench_dir TEXT NOT NULL,
    device_dir TEXT NOT NULL,
    day TEXT NOT NULL,
    bench TEXT NOT NULL,
    device TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    first_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bench_dir, device_dir, day)
  )`);
  await tx.run('CREATE INDEX journal_days_day ON journal_days (day)');
}
