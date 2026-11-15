/**
 * Sign-in state (src/modules/auth): the sessions, and a few named values of
 * the sign-in module itself (the local administrator's last accepted TOTP
 * step, the key of the known-browser cookies)
 *
 * A session is found by the SHA-256 of its token (token_hash); the token
 * itself is never stored. `id` is the public handle shown to administrators
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    binding TEXT
  )`);
  await tx.run('CREATE UNIQUE INDEX auth_sessions_token_hash ON auth_sessions (token_hash)');
  await tx.run('CREATE INDEX auth_sessions_user ON auth_sessions (user_id)');
  await tx.run('CREATE INDEX auth_sessions_expires ON auth_sessions (expires_at)');

  await tx.run(`CREATE TABLE auth_state (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}
