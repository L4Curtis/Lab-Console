/**
 * Teams (src/modules/teams/teams.js): a few students who share a bench. A
 * student is in one team at most (team_members.user_id is the key); an
 * invitation names a user name, compared without case (username_key).
 * `position` keeps the order people joined or were invited in
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  )`);
  await tx.run('CREATE UNIQUE INDEX teams_name_key ON teams (name_key)');

  await tx.run(`CREATE TABLE team_members (
    user_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams (id),
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    since TEXT NOT NULL,
    position INTEGER NOT NULL
  )`);
  await tx.run('CREATE INDEX team_members_team ON team_members (team_id)');

  await tx.run(`CREATE TABLE team_invitations (
    team_id TEXT NOT NULL REFERENCES teams (id),
    username_key TEXT NOT NULL,
    username TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    at TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (team_id, username_key)
  )`);
  await tx.run('CREATE INDEX team_invitations_username ON team_invitations (username_key)');
}
