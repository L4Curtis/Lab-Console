/**
 * Repository of the benches (tables bench_occupancy, bench_locks,
 * bench_reservations, migration 007). The benches module keeps the three
 * small documents in memory (src/lib/cachedDocument.js) and writes what changed:
 *
 *   loadOccupancy() → { [bench]: { teamId, since, by, lastActivity, guests, requests } }
 *   loadLocks()     → { [bench]: { reason, by, at } }
 *   loadReservations() → { reservations: [{ id, bench, teamId, start, end, by, createdAt, warnedAt?, startedAt? }] }
 *   saveOccupancy(next, prev) / saveLocks(next, prev) / saveReservations(next, prev)
 *   importOccupancy(bench, o) / importLock(bench, l) / importReservation(r)   the files of before: rows already there win
 *
 * by / guests / requests are people ({ id, username, name }), kept as JSON
 */
import { toIso, toJson, fromJson } from '../values.js';
import { changedRecords, byId } from '../../cachedDocument.js';

const at = (value) => toIso(value) ?? toIso(Date.now());

export function createBenchesRepository(db) {
  const occupancyRow = (bench, o, conflict) => db.run(
    `INSERT INTO bench_occupancy (bench, team_id, since, taken_by, last_activity, guests, requests) VALUES (?, ?, ?, ?, ?, ?, ?) ${conflict}`,
    [String(bench), String(o.teamId), at(o.since), toJson(o.by ?? null), at(o.lastActivity ?? o.since), toJson(o.guests ?? []), toJson(o.requests ?? [])],
  );
  const lockRow = (bench, l, conflict) => db.run(
    `INSERT INTO bench_locks (bench, reason, locked_by, at) VALUES (?, ?, ?, ?) ${conflict}`,
    [String(bench), String(l.reason ?? ''), toJson(l.by ?? null), at(l.at)],
  );
  const reservationRow = (r, conflict) => db.run(
    `INSERT INTO bench_reservations (id, bench, team_id, starts_at, ends_at, booked_by, created_at, warned_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
    [String(r.id), String(r.bench), String(r.teamId), at(r.start), at(r.end), toJson(r.by ?? null), at(r.createdAt), toIso(r.warnedAt), toIso(r.startedAt)],
  );

  return {
    async loadOccupancy() {
      const rows = await db.query('SELECT bench, team_id, since, taken_by, last_activity, guests, requests FROM bench_occupancy ORDER BY bench');
      return Object.fromEntries(rows.map((r) => [r.bench, {
        teamId: r.team_id, since: r.since, by: fromJson(r.taken_by, null), lastActivity: r.last_activity,
        guests: fromJson(r.guests, []), requests: fromJson(r.requests, []),
      }]));
    },
    async loadLocks() {
      const rows = await db.query('SELECT bench, reason, locked_by, at FROM bench_locks ORDER BY bench');
      return Object.fromEntries(rows.map((r) => [r.bench, { reason: r.reason, by: fromJson(r.locked_by, null), at: r.at }]));
    },
    async loadReservations() {
      const rows = await db.query(`SELECT id, bench, team_id, starts_at, ends_at, booked_by, created_at, warned_at, started_at
        FROM bench_reservations ORDER BY starts_at, id`);
      return {
        reservations: rows.map((r) => ({
          id: r.id, bench: r.bench, teamId: r.team_id, start: r.starts_at, end: r.ends_at, by: fromJson(r.booked_by, null), createdAt: r.created_at,
          ...(r.warned_at ? { warnedAt: r.warned_at } : {}), ...(r.started_at ? { startedAt: r.started_at } : {}),
        })),
      };
    },

    async saveOccupancy(next, prev) {
      const { upserts, removals } = changedRecords(prev, next);
      for (const bench of removals) await db.run('DELETE FROM bench_occupancy WHERE bench = ?', [bench]);
      for (const [bench, o] of upserts) {
        await occupancyRow(bench, o, `ON CONFLICT (bench) DO UPDATE SET team_id = excluded.team_id, since = excluded.since, taken_by = excluded.taken_by,
          last_activity = excluded.last_activity, guests = excluded.guests, requests = excluded.requests`);
      }
    },
    async saveLocks(next, prev) {
      const { upserts, removals } = changedRecords(prev, next);
      for (const bench of removals) await db.run('DELETE FROM bench_locks WHERE bench = ?', [bench]);
      for (const [bench, l] of upserts) {
        await lockRow(bench, l, 'ON CONFLICT (bench) DO UPDATE SET reason = excluded.reason, locked_by = excluded.locked_by, at = excluded.at');
      }
    },
    async saveReservations(next, prev) {
      const { upserts, removals } = changedRecords(byId(prev?.reservations), byId(next?.reservations));
      for (const id of removals) await db.run('DELETE FROM bench_reservations WHERE id = ?', [id]);
      for (const [, r] of upserts) {
        await reservationRow(r, `ON CONFLICT (id) DO UPDATE SET bench = excluded.bench, team_id = excluded.team_id, starts_at = excluded.starts_at,
          ends_at = excluded.ends_at, booked_by = excluded.booked_by, warned_at = excluded.warned_at, started_at = excluded.started_at`);
      }
    },

    importOccupancy: async (bench, o) => occupancyRow(bench, o, 'ON CONFLICT DO NOTHING'),
    importLock: async (bench, l) => lockRow(bench, l, 'ON CONFLICT DO NOTHING'),
    importReservation: async (r) => reservationRow(r, 'ON CONFLICT DO NOTHING'),
  };
}
