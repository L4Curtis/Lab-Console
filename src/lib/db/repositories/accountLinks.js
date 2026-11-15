/**
 * Repository of the invitation and password reset links (table
 * account_links, migration 008). Only the SHA-256 of a link's token is
 * stored. The accounts module keeps the links in memory
 * (src/lib/cachedDocument.js) and writes what changed:
 *
 *   load()              → { [linkId]: Link }
 *   save(next, prev)    write the links that differ (inside repos.transaction)
 *   insertIfAbsent(link)   the import of data/accounts/invitations.json
 *
 * Link (as links.js keeps it): { id, kind: 'invite'|'reset', hash, role,
 * maxUses, uses, accounts: [accountId], accountId, note, createdAt,
 * expiresAt, createdBy, revokedAt, revokedBy, lastUsedAt? }; times are milliseconds
 */
import { toIso, fromIso, toJson, fromJson } from '../values.js';
import { changedRecords } from '../../cachedDocument.js';

const ms = (text) => (typeof text === 'string' ? fromIso(text) : null);
const json = (value) => (value === undefined || value === null ? null : toJson(value));

export function createAccountLinksRepository(db) {
  const write = (l, conflict) => db.run(
    `INSERT INTO account_links (id, kind, token_hash, role, max_uses, uses, accounts_list, account_id, note, created_at, expires_at,
       created_by, revoked_at, revoked_by, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
    [
      String(l.id), String(l.kind), String(l.hash), l.role ?? null, Number(l.maxUses) || 1, Number(l.uses) || 0, toJson(l.accounts ?? []),
      l.accountId ?? null, String(l.note ?? ''), toIso(l.createdAt), toIso(l.expiresAt), json(l.createdBy),
      toIso(l.revokedAt), json(l.revokedBy), toIso(l.lastUsedAt),
    ],
  );

  return {
    async load() {
      const rows = await db.query(`SELECT id, kind, token_hash, role, max_uses, uses, accounts_list, account_id, note, created_at, expires_at,
        created_by, revoked_at, revoked_by, last_used_at FROM account_links ORDER BY created_at, id`);
      return Object.fromEntries(rows.map((r) => [r.id, {
        id: r.id, kind: r.kind, hash: r.token_hash, role: r.role ?? null, maxUses: Number(r.max_uses), uses: Number(r.uses),
        accounts: fromJson(r.accounts_list, []), accountId: r.account_id ?? null, note: r.note, createdAt: ms(r.created_at),
        expiresAt: ms(r.expires_at), createdBy: fromJson(r.created_by, null), revokedAt: ms(r.revoked_at), revokedBy: fromJson(r.revoked_by, null),
        ...(r.last_used_at ? { lastUsedAt: ms(r.last_used_at) } : {}),
      }]));
    },

    async save(next, prev) {
      const { upserts, removals } = changedRecords(prev, next);
      for (const id of removals) await db.run('DELETE FROM account_links WHERE id = ?', [id]);
      for (const [, l] of upserts) {
        await write(l, `ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, token_hash = excluded.token_hash, role = excluded.role,
          max_uses = excluded.max_uses, uses = excluded.uses, accounts_list = excluded.accounts_list, account_id = excluded.account_id,
          note = excluded.note, created_at = excluded.created_at, expires_at = excluded.expires_at, created_by = excluded.created_by,
          revoked_at = excluded.revoked_at, revoked_by = excluded.revoked_by, last_used_at = excluded.last_used_at`);
      }
    },

    insertIfAbsent: async (link) => write(link, 'ON CONFLICT DO NOTHING'),
  };
}
