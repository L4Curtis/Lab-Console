/**
 * Benches (src/modules/teams/benches.js): who holds each bench, the locks
 * admins put on benches, and the reservation calendar. Bench names are the
 * diagram's page names (natural keys). The guests and the pending join
 * requests of a held bench are short lists of people, kept with it as JSON
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE bench_occupancy (
    bench TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    since TEXT NOT NULL,
    taken_by TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    guests TEXT NOT NULL,
    requests TEXT NOT NULL
  )`);
  await tx.run('CREATE INDEX bench_occupancy_team ON bench_occupancy (team_id)');

  await tx.run(`CREATE TABLE bench_locks (
    bench TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    locked_by TEXT NOT NULL,
    at TEXT NOT NULL
  )`);

  await tx.run(`CREATE TABLE bench_reservations (
    id TEXT PRIMARY KEY,
    bench TEXT NOT NULL,
    team_id TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    booked_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    warned_at TEXT,
    started_at TEXT
  )`);
  await tx.run('CREATE INDEX bench_reservations_bench ON bench_reservations (bench, starts_at)');
  await tx.run('CREATE INDEX bench_reservations_team ON bench_reservations (team_id)');
}
