/**
 * The directory of accounts (src/modules/accounts/directory.js), their
 * passkeys, and the invitation and password reset links (links.js)
 *
 * accounts: local accounts (created through an invitation, with a scrypt
 * hash) and SSO accounts (recorded at their first sign-in). User names are
 * unique without regard to case among local accounts: the module checks it
 * inside the write, the index only speeds the lookup up.
 * account_links: only the SHA-256 of a link's token is stored
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    via TEXT NOT NULL,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    role_override TEXT,
    state TEXT NOT NULL,
    groups_list TEXT NOT NULL,
    password_hash TEXT,
    password_changed_at TEXT,
    webauthn_user_id TEXT,
    created_at TEXT,
    created_by TEXT,
    invitation TEXT,
    last_sign_in_at TEXT
  )`);
  await tx.run('CREATE INDEX accounts_username_key ON accounts (username_key)');

  await tx.run(`CREATE TABLE account_passkeys (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL,
    transports TEXT NOT NULL,
    device_type TEXT,
    backed_up INTEGER NOT NULL,
    created_at TEXT,
    last_used_at TEXT,
    position INTEGER NOT NULL
  )`);
  await tx.run('CREATE INDEX account_passkeys_account ON account_passkeys (account_id)');

  await tx.run(`CREATE TABLE account_links (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    role TEXT,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL,
    accounts_list TEXT NOT NULL,
    account_id TEXT,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_by TEXT,
    revoked_at TEXT,
    revoked_by TEXT,
    last_used_at TEXT
  )`);
  await tx.run('CREATE INDEX account_links_kind ON account_links (kind, created_at)');
  await tx.run('CREATE INDEX account_links_account ON account_links (account_id)');
}
