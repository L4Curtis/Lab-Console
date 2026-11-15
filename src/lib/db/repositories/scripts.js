/**
 * Repository of the script library (table scripts, migration 013)
 *
 *   visibleTo({ userId, teamId, allTeams }) → the scripts that user may see, without their body:
 *                      their own (shelf p:<userId>), their team's (t:<teamId>), the published ones, and
 *                      with `allTeams` (an administrator) every team's
 *   get(id)         → the script with its body, or null
 *   insert(script)  → the script; throws DatabaseError 'db.unique' when the title is taken on the shelf
 *   update(id, patch)   title, description, body, updatedAt, updatedBy → true when the script exists
 *   remove(id)      → true when it existed
 *   countOn(shelf)  → how many scripts sit on that shelf
 *
 * A script is { id, scope, shelf, teamId, ownerId, ownerName, title, description, body?, lines,
 * createdAt, updatedAt, updatedBy }. The module decides who may do what; this only stores
 */
import { toIso } from '../values.js';

const COLUMNS = 'id, scope, shelf, team_id, owner_id, owner_name, title, description, lines, created_at, updated_at, updated_by';

const view = (r) => ({
  id: r.id, scope: r.scope, shelf: r.shelf, teamId: r.team_id ?? null, ownerId: r.owner_id, ownerName: r.owner_name,
  title: r.title, description: r.description, lines: Number(r.lines),
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  ...(r.body === undefined ? {} : { body: r.body }),
});

export const titleKey = (title) => String(title).trim().toLowerCase();

export function createScriptsRepository(db, { now = () => new Date() } = {}) {
  return {
    async visibleTo({ userId, teamId = null, allTeams = false }) {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM scripts
         WHERE scope = 'published' OR shelf = ? OR shelf = ? OR (scope = 'team' AND ? = 1)
         ORDER BY title_key, id`,
        [`p:${userId}`, teamId ? `t:${teamId}` : 'none', allTeams ? 1 : 0],
      );
      return rows.map(view);
    },
    async get(id) {
      const row = await db.get(`SELECT ${COLUMNS}, body FROM scripts WHERE id = ?`, [String(id)]);
      return row ? view(row) : null;
    },
    async insert(s) {
      const at = toIso(s.createdAt ?? now());
      await db.run(
        `INSERT INTO scripts (id, scope, shelf, team_id, owner_id, owner_name, title, title_key, description, body, lines, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(s.id), s.scope, s.shelf, s.teamId ?? null, String(s.ownerId), String(s.ownerName), s.title, titleKey(s.title), s.description, s.body,
          Math.max(0, Number(s.lines) || 0), at, at, String(s.updatedBy ?? s.ownerName)],
      );
      return s;
    },
    async update(id, { title, description, body, lines, updatedBy, updatedAt = now() }) {
      const { changes } = await db.run(
        `UPDATE scripts SET title = ?, title_key = ?, description = ?, body = ?, lines = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        [title, titleKey(title), description, body, Math.max(0, Number(lines) || 0), toIso(updatedAt), String(updatedBy), String(id)],
      );
      return changes > 0;
    },
    async remove(id) {
      const { changes } = await db.run('DELETE FROM scripts WHERE id = ?', [String(id)]);
      return changes > 0;
    },
    async countOn(shelf) {
      const row = await db.get('SELECT count(*) AS n FROM scripts WHERE shelf = ?', [String(shelf)]);
      return Number(row?.n ?? 0);
    },
  };
}
