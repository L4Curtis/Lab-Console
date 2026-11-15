/**
 * A team invitation names an account, not only a user name
 * (src/modules/teams/teams.js): invitee_id is the id of the account invited,
 * so a namesake (a local account and an SSO account may share a user name)
 * never accepts an invitation meant for someone else. Invitations written
 * before this migration are bound to the account of that name when exactly
 * one account has it; the others stay bound to the name only (invitee_id
 * NULL) and are matched by name, as before
 */
export async function up(tx) {
  await tx.run('ALTER TABLE team_invitations ADD COLUMN invitee_id TEXT');
  await tx.run(`UPDATE team_invitations SET invitee_id = (
    SELECT a.id FROM accounts a WHERE a.username_key = team_invitations.username_key
  ) WHERE (SELECT COUNT(*) FROM accounts a WHERE a.username_key = team_invitations.username_key) = 1`);
  await tx.run('CREATE INDEX team_invitations_invitee ON team_invitations (invitee_id)');
}
