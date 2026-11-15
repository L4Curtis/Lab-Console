/**
 * Repository of the bench checks (table bench_checks, migration 015): the
 * last finished check of each kind on each bench
 *
 *   save(check)   insert, or replace the previous one of that bench and kind
 *   all()         → every check kept, oldest first (loaded once at start-up)
 *   remove(bench) forget a bench's checks (a bench gone from the diagram)
 *
 * Check: { id, bench, kind, state, teamId, actor: { id, username, name },
 *          startedAt, endedAt, result }
 */
import { toIso, toJson, fromJson } from '../values.js';

const COLUMNS = 'bench, kind, id, state, team_id, actor, started_at, ended_at, result';

const view = (r) => ({
  id: r.id,
  bench: r.bench,
  kind: r.kind,
  state: r.state,
  teamId: r.team_id ?? null,
  actor: fromJson(r.actor, {}),
  startedAt: r.started_at,
  endedAt: r.ended_at,
  result: fromJson(r.result, {}),
});

export function createChecksRepository(db) {
  return {
    async save(check) {
      return db.run(
        `INSERT INTO bench_checks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bench, kind) DO UPDATE SET id = excluded.id, state = excluded.state, team_id = excluded.team_id,
           actor = excluded.actor, started_at = excluded.started_at, ended_at = excluded.ended_at, result = excluded.result`,
        [String(check.bench), String(check.kind), String(check.id), String(check.state), check.teamId ?? null,
          toJson(check.actor ?? {}), toIso(check.startedAt), toIso(check.endedAt), toJson(check.result ?? {})],
      );
    },
    async all() {
      const rows = await db.query(`SELECT ${COLUMNS} FROM bench_checks ORDER BY ended_at, bench, kind`);
      return rows.map(view);
    },
    async remove(bench) {
      return db.run('DELETE FROM bench_checks WHERE bench = ?', [String(bench)]);
    },
  };
}
