/**
 * Group work (src/modules/collab/): the shared note of a device and the chat
 * of a bench.
 *
 * device_notes: at most one note per device, named by the device's key in the
 * diagram. `rev` counts the saves: a save names the revision it started from,
 * so two people editing at once never overwrite each other silently.
 * bench and device are the names shown when the note was last saved.
 *
 * bench_chat_messages: the chat belongs to the team that held the bench
 * (SPEC "Lot teams"): one thread per (team, bench), read by the bench's
 * occupants. Ids are time-ordered (UUID v7), so id order is message order;
 * the repository keeps the last messages of a thread and drops the rest
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE device_notes (
    device_key TEXT PRIMARY KEY,
    bench TEXT NOT NULL,
    device TEXT NOT NULL,
    body TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id TEXT NOT NULL,
    updated_by_name TEXT NOT NULL
  )`);
  await tx.run('CREATE INDEX device_notes_bench ON device_notes (bench)');

  await tx.run(`CREATE TABLE bench_chat_messages (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    bench TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
  await tx.run('CREATE INDEX bench_chat_messages_thread ON bench_chat_messages (team_id, bench, id)');
}
