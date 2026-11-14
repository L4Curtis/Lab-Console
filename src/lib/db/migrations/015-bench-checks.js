/**
 * Bench checks (src/modules/checks/): the last result of each kind of check
 * per bench (line status, cabling, ping matrix, interfaces), so that a page
 * reloaded, or a server restarted, still shows it.
 *
 * One row per (bench, kind): a new run replaces the previous one. `team_id`
 * is the team that held the bench when it ran (who may read it, with the
 * admins); `actor` is who started it ({ id, username, name }); `result` is the
 * report as JSON (devices, links, cells), never a configuration
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE bench_checks (
    bench TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    state TEXT NOT NULL,
    team_id TEXT,
    actor TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (bench, kind)
  )`);
  await tx.run('CREATE INDEX bench_checks_ended ON bench_checks (ended_at)');
}
