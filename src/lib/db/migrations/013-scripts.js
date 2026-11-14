/**
 * The script library (src/modules/scripts/): lists of console commands that
 * people keep and share. Three shelves: a person's own (`personal`, seen by
 * its owner only), a team's (`team`, seen by the members), and the ones an
 * administrator publishes (`published`, seen by everybody signed in).
 *
 * `shelf` names the place a script sits on: 'p:<owner id>', 't:<team id>' or
 * 'pub'. A title is unique on its shelf (compared without case, title_key).
 * `lines` is the line count, kept so that a listing never has to carry the
 * bodies. There is no foreign key to teams: a dissolved team's scripts stay
 * (administrators still see them and may delete them)
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    shelf TEXT NOT NULL,
    team_id TEXT,
    owner_id TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    lines INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`);
  await tx.run('CREATE UNIQUE INDEX scripts_shelf_title ON scripts (shelf, title_key)');
  await tx.run('CREATE INDEX scripts_scope ON scripts (scope)');
}
