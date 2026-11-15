/**
 * Repository of the announcement banner (table announcements, migration 009)
 *
 *   recent(limit)        → the last announcements, newest first: [{ id, text, level, at, expiresAt, by: { id, name }, removedAt }]
 *   add(announcement)    a new one (it becomes the current one) → its id
 *   remove(id, at)       the administrator took it down
 *   insertIfAbsent(a)    the import of data/admin/announcements.json
 */
import { toIso, newId } from '../values.js';

export function createAnnouncementsRepository(db) {
  const insert = (a, conflict = '') => db.run(
    `INSERT INTO announcements (id, text, level, at, expires_at, by_id, by_name, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
    [String(a.id ?? newId(Date.parse(a.at) || Date.now())), String(a.text), String(a.level), toIso(a.at), toIso(a.expiresAt),
      String(a.by?.id ?? 'system'), String(a.by?.name ?? a.by?.id ?? 'system'), toIso(a.removedAt)],
  );
  return {
    async recent(limit = 20) {
      const rows = await db.query(`SELECT id, text, level, at, expires_at, by_id, by_name, removed_at FROM announcements
        ORDER BY at DESC, id DESC LIMIT ?`, [Math.max(1, Math.min(1000, Number(limit) || 20))]);
      return rows.map((r) => ({
        id: r.id, text: r.text, level: r.level, at: r.at, expiresAt: r.expires_at ?? null, by: { id: r.by_id, name: r.by_name }, removedAt: r.removed_at ?? null,
      }));
    },
    async add(a) {
      const id = a.id ?? newId(Date.parse(a.at) || Date.now());
      await insert({ ...a, id });
      return id;
    },
    async remove(id, at) {
      return db.run('UPDATE announcements SET removed_at = ? WHERE id = ? AND removed_at IS NULL', [toIso(at), String(id)]);
    },
    insertIfAbsent: async (a) => insert(a, 'ON CONFLICT DO NOTHING'),
  };
}
