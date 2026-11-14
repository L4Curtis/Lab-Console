/**
 * Repository of the guided tour (table tour_progress, migration 017)
 *
 *   get(userId)            → 'done' | 'skipped' | null (never shown)
 *   set(userId, state)     remembers how the tour ended; a later call replaces the earlier one
 */
import { toIso } from '../values.js';

export const TOUR_STATES = Object.freeze(['done', 'skipped']);

export function createTourRepository(db, { now = () => new Date() } = {}) {
  return {
    async get(userId) {
      const rows = await db.query('SELECT state FROM tour_progress WHERE user_id = ?', [String(userId)]);
      return rows[0]?.state ?? null;
    },
    async set(userId, state) {
      if (!TOUR_STATES.includes(state)) throw new TypeError(`Unknown tour state: ${state}`);
      return db.run(
        `INSERT INTO tour_progress (user_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        [String(userId), state, toIso(now())],
      );
    },
  };
}
