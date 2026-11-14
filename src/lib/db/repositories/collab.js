/**
 * Repository of the group work tables (migration 012): the notes of devices
 * and the chat of benches. The collab module (src/modules/collab/) is the
 * only caller
 *
 * Notes (table device_notes), one per device key:
 *   notes()                     → [{ key, bench, device, text, rev, updatedAt, by: { id, name } }]
 *   note(key)                   → one note, or null
 *   saveNote(note, fromRev)     → the saved note, or null when the stored revision is not `fromRev`
 *                               (0: there was no note). The new revision is fromRev + 1
 *   removeNote(key, fromRev)    → true when a note of that revision was deleted
 *
 * Chat (table bench_chat_messages), one thread per (team, bench):
 *   messages(teamId, bench, limit)      → the last `limit` messages, oldest first:
 *                                         [{ id, bench, text, at, author: { id, name } }]
 *   addMessage(message, keep)           stores it and drops the thread's older messages beyond `keep`
 *   removeMessage(bench, id)            → true when it existed, whichever team's thread it is in
 *   threadTeams()                       → ids of the teams that have a thread
 *   removeOrphanThreads()               drops the threads of teams that no longer exist in the `teams`
 *                                       table → the number of teams cleaned. It reads the table, not
 *                                       any module's memory, so it cannot wipe live threads
 */
import { toIso, newId } from '../values.js';

const noteView = (r) => ({
  key: r.device_key, bench: r.bench, device: r.device, text: r.body, rev: Number(r.rev), updatedAt: r.updated_at,
  by: { id: r.updated_by_id, name: r.updated_by_name },
});
const messageView = (r) => ({
  id: r.id, bench: r.bench, text: r.body, at: r.at, author: { id: r.author_id, name: r.author_name },
});

export function createCollabRepository(db, { now = () => new Date() } = {}) {
  return {
    async notes() {
      const rows = await db.query('SELECT device_key, bench, device, body, rev, updated_at, updated_by_id, updated_by_name FROM device_notes ORDER BY bench, device, device_key');
      return rows.map(noteView);
    },

    async note(key) {
      const row = await db.get('SELECT device_key, bench, device, body, rev, updated_at, updated_by_id, updated_by_name FROM device_notes WHERE device_key = ?', [String(key)]);
      return row ? noteView(row) : null;
    },

    async saveNote({ key, bench, device, text, by, at = now() }, fromRev) {
      const when = toIso(at) ?? toIso(now());
      const values = [String(bench), String(device), String(text), when, String(by.id), String(by.name)];
      const written = fromRev === 0
        ? await db.run(
          `INSERT INTO device_notes (device_key, bench, device, body, rev, updated_at, updated_by_id, updated_by_name)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT (device_key) DO NOTHING`,
          [String(key), ...values],
        )
        : await db.run(
          `UPDATE device_notes SET bench = ?, device = ?, body = ?, rev = rev + 1, updated_at = ?, updated_by_id = ?, updated_by_name = ?
           WHERE device_key = ? AND rev = ?`,
          [...values, String(key), fromRev],
        );
      return written.changes ? this.note(key) : null;
    },

    async removeNote(key, fromRev) {
      const { changes } = await db.run('DELETE FROM device_notes WHERE device_key = ? AND rev = ?', [String(key), fromRev]);
      return changes > 0;
    },

    async messages(teamId, bench, limit) {
      const rows = await db.query(
        `SELECT id, bench, author_id, author_name, body, at FROM bench_chat_messages
         WHERE team_id = ? AND bench = ? ORDER BY id DESC LIMIT ?`,
        [String(teamId), String(bench), Math.max(1, Math.min(1000, Number(limit) || 100))],
      );
      return rows.reverse().map(messageView);
    },

    async addMessage({ teamId, bench, author, text, at = now() }, keep) {
      const ms = at instanceof Date ? at.getTime() : Number(at);
      const id = newId(ms);
      await db.transaction(async (tx) => {
        await tx.run(
          'INSERT INTO bench_chat_messages (id, team_id, bench, author_id, author_name, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, String(teamId), String(bench), String(author.id), String(author.name), String(text), toIso(at)],
        );
        // Keep the newest `keep`: delete everything at or before the (keep + 1)th newest message of the thread
        await tx.run(
          `DELETE FROM bench_chat_messages WHERE team_id = ? AND bench = ? AND id <= (
             SELECT id FROM bench_chat_messages WHERE team_id = ? AND bench = ? ORDER BY id DESC LIMIT 1 OFFSET ?
           )`,
          [String(teamId), String(bench), String(teamId), String(bench), Math.max(1, Number(keep) || 1)],
        );
      });
      return messageView({ id, bench, author_id: author.id, author_name: author.name, body: text, at: toIso(at) });
    },

    async removeMessage(bench, id) {
      const { changes } = await db.run('DELETE FROM bench_chat_messages WHERE bench = ? AND id = ?', [String(bench), String(id)]);
      return changes > 0;
    },

    async threadTeams() {
      const rows = await db.query('SELECT DISTINCT team_id FROM bench_chat_messages ORDER BY team_id');
      return rows.map((r) => r.team_id);
    },

    async removeOrphanThreads() {
      return db.transaction(async (tx) => {
        const rows = await tx.query('SELECT DISTINCT team_id FROM bench_chat_messages WHERE team_id NOT IN (SELECT id FROM teams)');
        if (rows.length) await tx.run('DELETE FROM bench_chat_messages WHERE team_id NOT IN (SELECT id FROM teams)');
        return rows.length;
      });
    },
  };
}
