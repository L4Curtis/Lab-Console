/**
 * Invitation links and password reset links: one mechanism for both
 *
 * A link carries a token of 256 random bits. The server keeps only its
 * SHA-256 (data/accounts/invitations.json): the file, or a backup of it,
 * gives nobody a usable link. The token is shown once, to the administrator
 * who created the link, and travels in the URL's fragment (`/join#<token>`),
 * which browsers never send to a server, so it does not end up in a proxy's
 * access log either.
 *
 * Looking a token up compares its hash with every stored hash in constant
 * time and without stopping at the first match, so how long a refusal takes
 * says nothing about the links that exist. A link is usable while it is not
 * revoked, not expired and not used up; every other case is one and the same
 * refusal for whoever presents it (the reason is kept for the audit trail).
 *
 *   kind 'invite'  role, maxUses (1 = the account is active at once; more =
 *                  each account waits for an administrator's approval)
 *   kind 'reset'   accountId, always single use; a new one replaces the old
 */
import crypto from 'node:crypto';

export const LINK_TTLS = Object.freeze({ '1h': 60 * 60_000, '24h': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000 });
export const RESET_TTLS = Object.freeze({ '1h': LINK_TTLS['1h'], '24h': LINK_TTLS['24h'] });
export const MAX_USES = 100;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEEP_AFTER_END_MS = 30 * 24 * 60 * 60_000; // ended links stay listed (and audited) a month, then go
const FILE_VERSION = 1;

const hashOf = (token) => crypto.createHash('sha256').update(token).digest();

export function createLinks({ store, now = Date.now }) {
  const file = store.json('accounts/invitations.json', { version: FILE_VERSION, links: {} });
  const all = () => {
    const doc = file.get();
    return doc?.version === FILE_VERSION && doc.links && typeof doc.links === 'object' ? doc.links : {};
  };

  /** Why a link cannot be used now, or null when it can */
  function problemOf(link, at = now()) {
    if (link.revokedAt) return 'revoked';
    if (at >= link.expiresAt) return 'expired';
    if (link.uses >= link.maxUses) return 'used';
    return null;
  }

  /** What an administrator sees: never the hash */
  function view(link) {
    const { hash: _hash, ...rest } = link;
    return { ...rest, expiresAt: new Date(link.expiresAt).toISOString(), createdAt: new Date(link.createdAt).toISOString(), state: problemOf(link) ?? 'active' };
  }

  /** Read-modify-write of the whole file; `fn(links)` changes them in place */
  const change = (fn) => file.update((doc) => {
    const next = doc?.version === FILE_VERSION && doc.links ? doc : { version: FILE_VERSION, links: {} };
    // Housekeeping on every write: ended links are forgotten after a month
    const at = now();
    for (const [id, link] of Object.entries(next.links)) {
      const problem = problemOf(link, at);
      const endedAt = link.revokedAt ?? (problem === 'used' ? link.lastUsedAt : problem === 'expired' ? link.expiresAt : null);
      if (endedAt && at - endedAt > KEEP_AFTER_END_MS) delete next.links[id];
    }
    fn(next.links);
    return next;
  });

  return {
    /**
     * Create a link. → { link (as an administrator sees it), token (shown once) }
     *   { kind: 'invite', role, maxUses, ttlMs, createdBy, note } or { kind: 'reset', accountId, ttlMs, createdBy }
     */
    async create({ kind, role = 'student', maxUses = 1, ttlMs, accountId = null, createdBy, note = '' }) {
      const token = crypto.randomBytes(32).toString('base64url');
      const at = now();
      const link = {
        id: crypto.randomBytes(9).toString('base64url'),
        kind,
        hash: hashOf(token).toString('hex'),
        role: kind === 'invite' ? role : null,
        maxUses: kind === 'reset' ? 1 : maxUses,
        uses: 0,
        accounts: [],
        accountId: kind === 'reset' ? accountId : null,
        note: String(note ?? '').slice(0, 120),
        createdAt: at,
        expiresAt: at + ttlMs,
        createdBy,
        revokedAt: null,
        revokedBy: null,
      };
      await change((links) => {
        // One reset link per account: a new one replaces whatever was still pending
        if (kind === 'reset') {
          for (const other of Object.values(links)) {
            if (other.kind === 'reset' && other.accountId === accountId && !other.revokedAt) {
              other.revokedAt = at;
              other.revokedBy = createdBy;
            }
          }
        }
        links[link.id] = link;
      });
      return { link: view(link), token };
    },

    /**
     * Find the link a token belongs to. → { link, problem } where problem is
     * null (usable), 'unknown', 'revoked', 'expired' or 'used'. `kind`
     * restricts the search: a reset token is no invitation, and the reverse
     */
    find(token, { kind } = {}) {
      const presented = hashOf(typeof token === 'string' && TOKEN.test(token) ? token : 'not a token');
      let found = null;
      for (const link of Object.values(all())) {
        const stored = Buffer.from(String(link.hash), 'hex');
        // Every stored hash is compared, the whole of it, whatever matched before
        const same = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);
        if (same && (!kind || link.kind === kind)) found = link;
      }
      if (!found || typeof token !== 'string' || !TOKEN.test(token)) return { link: null, problem: 'unknown' };
      return { link: found, problem: problemOf(found) };
    },

    /** Count one use of a link that must still be usable (checked again inside the write) */
    async use(id, accountId) {
      let problem = null;
      await change((links) => {
        const link = links[id];
        problem = link ? problemOf(link) : 'unknown';
        if (problem) return;
        link.uses += 1;
        link.lastUsedAt = now();
        if (accountId) link.accounts.push(accountId);
      });
      return problem;
    },

    /** Give a use back (the account it was for could not be created after all) */
    release(id, accountId) {
      return change((links) => {
        const link = links[id];
        if (!link || link.uses === 0) return;
        link.uses -= 1;
        link.accounts = link.accounts.filter((a) => a !== accountId);
      });
    },

    /** → the link as an administrator sees it, or null when unknown or already revoked */
    async revoke(id, by) {
      let revoked = null;
      await change((links) => {
        const link = links[id];
        if (!link || link.revokedAt) return;
        link.revokedAt = now();
        link.revokedBy = by;
        revoked = view(link);
      });
      return revoked;
    },

    /** Reset links of an account end (its password was changed another way, or it is gone) */
    revokeResets(accountId, by) {
      return change((links) => {
        for (const link of Object.values(links)) {
          if (link.kind === 'reset' && link.accountId === accountId && !problemOf(link)) {
            link.revokedAt = now();
            link.revokedBy = by;
          }
        }
      });
    },

    /** Links of one kind, newest first, as an administrator sees them */
    list({ kind = 'invite' } = {}) {
      return Object.values(all()).filter((l) => l.kind === kind).sort((a, b) => b.createdAt - a.createdAt).map(view);
    },
  };
}
