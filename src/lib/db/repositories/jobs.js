/**
 * Repository of the bench jobs (table jobs, migration 012). A job is written
 * when it is created and again when it ends; the per-device report travels
 * as JSON. Passwords are never part of what is saved: the module keeps them
 * in memory only and passes `options` without them
 *
 *   save(job)              insert or replace one job
 *   get(id)                → Job | null
 *   list({ bench, limit }) → Job[] newest first
 *   unfinished()           → the jobs a stopped server left running (closed at start-up)
 *
 * Job: { id, bench, kind, state, teamId, actor: { id, username, name }, options, devices: [...],
 *        snapshotId, createdAt, endedAt }
 */
import { toIso, toJson, fromJson } from '../values.js';

const COLUMNS = 'id, bench, kind, state, team_id, actor, options, devices, snapshot_id, created_at, ended_at';
const FINAL = ['done', 'failed', 'cancelled', 'partial'];

const view = (r) => ({
  id: r.id,
  bench: r.bench,
  kind: r.kind,
  state: r.state,
  teamId: r.team_id ?? null,
  actor: fromJson(r.actor, {}),
  options: fromJson(r.options, {}),
  devices: fromJson(r.devices, []),
  snapshotId: r.snapshot_id ?? null,
  createdAt: r.created_at,
  endedAt: r.ended_at ?? null,
});

export function createJobsRepository(db) {
  return {
    async save(job) {
      return db.run(
        `INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, team_id = excluded.team_id, options = excluded.options,
           devices = excluded.devices, snapshot_id = excluded.snapshot_id, ended_at = excluded.ended_at`,
        [String(job.id), String(job.bench), String(job.kind), String(job.state), job.teamId ?? null, toJson(job.actor ?? {}),
          toJson(job.options ?? {}), toJson(job.devices ?? []), job.snapshotId ?? null, toIso(job.createdAt), toIso(job.endedAt)],
      );
    },
    async get(id) {
      const row = await db.get(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`, [String(id)]);
      return row ? view(row) : null;
    },
    async list({ bench, limit = 50 } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      const rows = bench === undefined
        ? await db.query(`SELECT ${COLUMNS} FROM jobs ORDER BY created_at DESC, id DESC LIMIT ${n}`)
        : await db.query(`SELECT ${COLUMNS} FROM jobs WHERE bench = ? ORDER BY created_at DESC, id DESC LIMIT ${n}`, [String(bench)]);
      return rows.map(view);
    },
    async unfinished() {
      const rows = await db.query(`SELECT ${COLUMNS} FROM jobs WHERE state NOT IN (${FINAL.map(() => '?').join(', ')})`, FINAL);
      return rows.map(view);
    },
  };
}
