/**
 * Repository of the teams (tables teams, team_members, team_invitations,
 * migrations 006 and 011). The teams module keeps the whole list in memory
 * (src/lib/cachedDocument.js) and writes what changed:
 *
 *   load()              → { teams: [{ id, name, createdAt, createdBy, members: [Person + since], invitations: [{ username, userId, by, at }] }] }
 *   save(next, prev)    write the teams that differ between two such values (inside repos.transaction)
 *   insertIfAbsent(team)   the import of data/teams/teams.json: a team, a member or an invitation already there wins
 *
 * Person = { id, username, name }. Names are compared without case (name_key, username_key).
 * An invitation's userId (invitee_id) is the account invited; null for an
 * invitation bound to a name only (written before migration 011, or on a
 * platform without the accounts module)
 */
import { toIso, toJson, fromJson } from '../values.js';
import { changedRecords, byId } from '../../cachedDocument.js';

const fold = (text) => String(text ?? '').trim().toLowerCase();

export function createTeamsRepository(db) {
  async function remove(teamId) {
    await db.run('DELETE FROM team_invitations WHERE team_id = ?', [teamId]);
    await db.run('DELETE FROM team_members WHERE team_id = ?', [teamId]);
    await db.run('DELETE FROM teams WHERE id = ?', [teamId]);
  }

  async function writeTeam(team, conflict) {
    return db.run(
      `INSERT INTO teams (id, name, name_key, created_at, created_by) VALUES (?, ?, ?, ?, ?) ${conflict}`,
      [String(team.id), String(team.name), fold(team.name), toIso(team.createdAt) ?? toIso(Date.now()), toJson(team.createdBy ?? null)],
    );
  }

  async function writePeople(team, conflict = '') {
    let position = 0;
    for (const m of team.members ?? []) {
      await db.run(
        `INSERT INTO team_members (user_id, team_id, username, name, since, position) VALUES (?, ?, ?, ?, ?, ?) ${conflict}`,
        [String(m.id), String(team.id), String(m.username ?? ''), String(m.name ?? m.username ?? m.id), toIso(m.since) ?? toIso(Date.now()), position++],
      );
    }
    position = 0;
    for (const inv of team.invitations ?? []) {
      await db.run(
        `INSERT INTO team_invitations (team_id, username_key, username, invitee_id, invited_by, at, position) VALUES (?, ?, ?, ?, ?, ?, ?) ${conflict}`,
        [String(team.id), fold(inv.username), String(inv.username), inv.userId ? String(inv.userId) : null, toJson(inv.by ?? null), toIso(inv.at) ?? toIso(Date.now()), position++],
      );
    }
  }

  return {
    async load() {
      const teams = await db.query('SELECT id, name, created_at, created_by FROM teams ORDER BY created_at, id');
      const members = await db.query('SELECT user_id, team_id, username, name, since FROM team_members ORDER BY team_id, position');
      const invitations = await db.query('SELECT team_id, username, invitee_id, invited_by, at FROM team_invitations ORDER BY team_id, position');
      return {
        teams: teams.map((t) => ({
          id: t.id,
          name: t.name,
          createdAt: t.created_at,
          createdBy: fromJson(t.created_by, null),
          members: members.filter((m) => m.team_id === t.id).map((m) => ({ id: m.user_id, username: m.username, name: m.name, since: m.since })),
          invitations: invitations.filter((i) => i.team_id === t.id).map((i) => ({ username: i.username, userId: i.invitee_id ?? null, by: fromJson(i.invited_by, null), at: i.at })),
        })),
      };
    },

    async save(next, prev) {
      const { upserts, removals } = changedRecords(byId(prev?.teams), byId(next?.teams));
      for (const id of removals) await remove(id);
      // Every changed team loses its people first: someone moving between two teams in one write finds the place free
      for (const [id] of upserts) {
        await db.run('DELETE FROM team_invitations WHERE team_id = ?', [id]);
        await db.run('DELETE FROM team_members WHERE team_id = ?', [id]);
      }
      for (const [, team] of upserts) {
        await writeTeam(team, 'ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key');
        await writePeople(team);
      }
    },

    async insertIfAbsent(team) {
      const { changes } = await writeTeam(team, 'ON CONFLICT DO NOTHING');
      if (!changes) return { changes };
      await writePeople(team, 'ON CONFLICT DO NOTHING');
      return { changes };
    },
  };
}
