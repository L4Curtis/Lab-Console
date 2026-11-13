/**
 * Repository of the directory of accounts and their passkeys (tables
 * accounts, account_passkeys, migration 008). The accounts module keeps the
 * directory in memory (src/lib/cachedDocument.js) and writes what changed:
 *
 *   load()              → { [accountId]: Account }
 *   save(next, prev)    write the accounts that differ between two such values (inside repos.transaction)
 *   insertIfAbsent(account)   the import of data/accounts/users.json: an account already there wins
 *
 * Account (as directory.js keeps it): { id, via, username, usernameKey, name,
 * email, role, roleOverride?, state, groups?, passwordHash?, passwordChangedAt?,
 * webauthnUserId?, passkeys: [Passkey], createdAt, createdBy?, invitation?,
 * lastSignInAt }; times are milliseconds. Passkey: { id, name, publicKey,
 * counter, transports, deviceType?, backedUp, createdAt, lastUsedAt }
 */
import { toIso, fromIso, toJson, fromJson, toFlag, fromFlag } from '../values.js';
import { changedRecords } from '../../cachedDocument.js';

const ms = (text) => (typeof text === 'string' ? fromIso(text) : null);
const text = (value) => (value === undefined || value === null ? null : String(value));

export function createAccountsRepository(db) {
  async function writeAccount(a, conflict) {
    return db.run(
      `INSERT INTO accounts (id, via, username, username_key, name, email, role, role_override, state, groups_list, password_hash,
         password_changed_at, webauthn_user_id, created_at, created_by, invitation, last_sign_in_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [
        String(a.id), String(a.via), String(a.username ?? ''), String(a.usernameKey ?? String(a.username ?? '').toLowerCase()),
        String(a.name ?? a.username ?? ''), String(a.email ?? ''), String(a.role ?? 'student'), text(a.roleOverride), String(a.state ?? 'active'),
        toJson(a.groups ?? []), text(a.passwordHash), toIso(a.passwordChangedAt), text(a.webauthnUserId), toIso(a.createdAt),
        a.createdBy === undefined || a.createdBy === null ? null : toJson(a.createdBy), text(a.invitation), toIso(a.lastSignInAt),
      ],
    );
  }

  async function writePasskeys(a, conflict = '') {
    let position = 0;
    for (const p of a.passkeys ?? []) {
      await db.run(
        `INSERT INTO account_passkeys (id, account_id, name, public_key, counter, transports, device_type, backed_up, created_at, last_used_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
        [String(p.id), String(a.id), String(p.name ?? ''), String(p.publicKey ?? ''), Number(p.counter) || 0, toJson(p.transports ?? []),
          text(p.deviceType), toFlag(p.backedUp), toIso(p.createdAt), toIso(p.lastUsedAt), position++],
      );
    }
  }

  return {
    async load() {
      const rows = await db.query(`SELECT id, via, username, username_key, name, email, role, role_override, state, groups_list, password_hash,
        password_changed_at, webauthn_user_id, created_at, created_by, invitation, last_sign_in_at FROM accounts ORDER BY id`);
      const keys = await db.query(`SELECT id, account_id, name, public_key, counter, transports, device_type, backed_up, created_at, last_used_at
        FROM account_passkeys ORDER BY account_id, position`);
      const out = {};
      for (const r of rows) {
        const account = {
          id: r.id, via: r.via, username: r.username, usernameKey: r.username_key, name: r.name, email: r.email,
          role: r.role, state: r.state,
          passkeys: keys.filter((k) => k.account_id === r.id).map((k) => ({
            id: k.id, name: k.name, publicKey: k.public_key, counter: Number(k.counter), transports: fromJson(k.transports, []),
            ...(k.device_type ? { deviceType: k.device_type } : {}), backedUp: fromFlag(k.backed_up), createdAt: ms(k.created_at), lastUsedAt: ms(k.last_used_at),
          })),
          createdAt: ms(r.created_at), lastSignInAt: ms(r.last_sign_in_at),
        };
        if (r.via === 'oidc') Object.assign(account, { roleOverride: r.role_override ?? null, groups: fromJson(r.groups_list, []) });
        if (r.via === 'local') {
          Object.assign(account, {
            passwordHash: r.password_hash, passwordChangedAt: ms(r.password_changed_at), webauthnUserId: r.webauthn_user_id,
            createdBy: fromJson(r.created_by, null), invitation: r.invitation ?? null,
          });
        }
        out[r.id] = account;
      }
      return out;
    },

    async save(next, prev) {
      const { upserts, removals } = changedRecords(prev, next);
      for (const id of removals) {
        await db.run('DELETE FROM account_passkeys WHERE account_id = ?', [id]);
        await db.run('DELETE FROM accounts WHERE id = ?', [id]);
      }
      // Passkeys of every changed account go first: one moving between accounts finds its id free
      for (const [id] of upserts) await db.run('DELETE FROM account_passkeys WHERE account_id = ?', [id]);
      for (const [, a] of upserts) {
        await writeAccount(a, `ON CONFLICT (id) DO UPDATE SET via = excluded.via, username = excluded.username, username_key = excluded.username_key,
          name = excluded.name, email = excluded.email, role = excluded.role, role_override = excluded.role_override, state = excluded.state,
          groups_list = excluded.groups_list, password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at,
          webauthn_user_id = excluded.webauthn_user_id, created_at = excluded.created_at, created_by = excluded.created_by,
          invitation = excluded.invitation, last_sign_in_at = excluded.last_sign_in_at`);
        await writePasskeys(a);
      }
    },

    async insertIfAbsent(account) {
      const { changes } = await writeAccount(account, 'ON CONFLICT DO NOTHING');
      if (changes) await writePasskeys(account, 'ON CONFLICT DO NOTHING');
      return { changes };
    },
  };
}
