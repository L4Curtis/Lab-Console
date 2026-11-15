/**
 * Repository of the days of console journal per device (table
 * journal_days, migration 010). The output itself stays in files
 * (data/journal/<benchDir>/<deviceDir>/<day>/<session>.log + .json)
 *
 *   record({ benchDir, deviceDir, day, bench, device, bytes, at })   a day exists (insert, or update its size)
 *   list()                 → [{ benchDir, deviceDir, day, bench, device, bytes, firstAt, updatedAt }] newest day first
 *   before(day)            → the days older than `day` (the retention sweep)
 *   remove(benchDir, deviceDir, day)
 *   totalBytes()           → the size of every day, as last recorded
 */
import { toIso } from '../values.js';

const view = (r) => ({
  benchDir: r.bench_dir, deviceDir: r.device_dir, day: r.day, bench: r.bench, device: r.device,
  bytes: Number(r.bytes), firstAt: r.first_at, updatedAt: r.updated_at,
});
const COLUMNS = 'bench_dir, device_dir, day, bench, device, bytes, first_at, updated_at';

export function createJournalDaysRepository(db, { now = () => new Date() } = {}) {
  return {
    async record({ benchDir, deviceDir, day, bench, device, bytes = 0, at = now() }) {
      const when = toIso(at) ?? toIso(now());
      return db.run(
        `INSERT INTO journal_days (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bench_dir, device_dir, day) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
        [String(benchDir), String(deviceDir), String(day), String(bench), String(device), Math.max(0, Number(bytes) || 0), when, when],
      );
    },
    async list() {
      return (await db.query(`SELECT ${COLUMNS} FROM journal_days ORDER BY day DESC, bench, device`)).map(view);
    },
    async before(day) {
      return (await db.query(`SELECT ${COLUMNS} FROM journal_days WHERE day < ? ORDER BY day, bench, device`, [String(day)])).map(view);
    },
    async remove(benchDir, deviceDir, day) {
      return db.run('DELETE FROM journal_days WHERE bench_dir = ? AND device_dir = ? AND day = ?', [String(benchDir), String(deviceDir), String(day)]);
    },
    async totalBytes() {
      const row = await db.get('SELECT coalesce(sum(bytes), 0) AS total FROM journal_days', []);
      return Number(row?.total ?? 0);
    },
  };
}
