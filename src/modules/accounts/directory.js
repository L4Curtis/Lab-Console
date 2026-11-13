/**
 * The directory: every account Lab Console knows besides the environment's
 * administrator (tables accounts and account_passkeys, through
 * repos.accounts; kept in memory, read by load() in the module's start())
 *
 *   local accounts  created through an invitation; user name, display name,
 *                   scrypt hash, role, state, passkeys
 *   SSO accounts    recorded at their first sign-in through the identity
 *                   provider; their role comes from the provider's groups
 *                   unless an administrator forced one (`roleOverride`)
 *
 * States: 'active', 'pending' (signed up through a link for several people,
 * waiting for an administrator) and 'disabled'. Only active accounts sign in.
 *
 * The environment's administrator (LOCAL_ADMIN_*) is not in here: it is
 * always an administrator and nothing in the application can change it. Its
 * user name is reserved, whatever the case.
 *
 * Two rules hold whatever the caller:
 *   - user names are unique without regard to case;
 *   - the last active administrator of the directory cannot be demoted,
 *     disabled or rejected: the environment's emergency account is not meant
 *     for daily work, so the directory never loses its last administrator
 *     by a slip of the mouse.
 * Both are checked inside the write itself, so two requests at once cannot
 * slip past them.
 *
 * The directory is also an account provider for the local sign-in form
 * (auth/accounts.js): `provider.verify()` does the same scrypt work whether
 * or not the name exists, and asks a promoted administrator for a passkey
 * (`requires`), which their password alone never replaces
 */
import crypto from 'node:crypto';
import { createUser } from '../auth/user.js';
import { hashPassword, verifyPassword, SCRYPT_DEFAULTS } from '../auth/password.js';
import { httpError } from '../../lib/httpError.js';
import { createCachedDocument } from '../../lib/cachedDocument.js';
import { usernameKey } from './policy.js';

const FILE_VERSION = 1;
export const MAX_PASSKEYS = 10;
export const STATES = Object.freeze(['active', 'pending', 'disabled']);

/** The role an account has now: the forced one, else the one its groups gave at its last sign-in */
export const effectiveRole = (account) => (account.via === 'oidc' ? account.roleOverride ?? account.role : account.role);

/** The environment's administrator as the directory shows it: always an administrator, changed in .env only */
export function environmentAccount(username) {
  return {
    id: `local:${username}`, username, name: username, email: '', role: 'admin', state: 'active', via: 'local',
    hasPasskey: false, passkeys: 0, roleOverride: null, groupRole: null, groups: [], needsPasskey: false,
    createdAt: null, lastSignInAt: null, environment: true,
  };
}

const isActiveAdmin = (account) => account.state === 'active' && effectiveRole(account) === 'admin';

const fingerprint = (hash) => crypto.createHash('sha256').update(String(hash ?? '')).digest('base64url');

/**
 * What a sign-in step started with this account's credentials must still
 * find when it ends (auth.steps): the same password, and every passkey it
 * could have used. A password reset or change, or passkeys cleared by an
 * administrator, end the steps in progress as they end the sessions; a
 * passkey added meanwhile (another tab) does not
 */
export const stepBinding = (account) => ({ password: fingerprint(account.passwordHash), passkeys: (account.passkeys ?? []).map((p) => p.id) });
export function stepBindingHolds(binding, account) {
  if (!binding || typeof binding.password !== 'string' || !Array.isArray(binding.passkeys)) return false;
  const ids = new Set((account.passkeys ?? []).map((p) => p.id));
  return binding.password === fingerprint(account.passwordHash) && binding.passkeys.every((id) => ids.has(id));
}

export function createDirectory({ repos, envAdminName, now = Date.now, passwordCost = SCRYPT_DEFAULTS, logger }) {
  const log = logger ?? { error() {}, warn() {} };
  const file = createCachedDocument({
    name: 'the directory',
    fallback: { version: FILE_VERSION, accounts: {} },
    load: async () => ({ version: FILE_VERSION, accounts: await repos.accounts.load() }),
    save: (next, prev) => repos.transaction((r) => r.accounts.save(next.accounts, prev.accounts)),
  });
  const envKey = usernameKey(envAdminName);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

  // Hashed once, the first time it is needed, with the same cost as real
  // hashes: an unknown name costs exactly the work a known one does
  let dummy = null;
  const dummyHash = () => (dummy ??= hashPassword(crypto.randomBytes(16).toString('base64url'), passwordCost));

  const accounts = () => {
    const doc = file.get();
    return doc?.version === FILE_VERSION && doc.accounts && typeof doc.accounts === 'object' ? doc.accounts : {};
  };
  const localByKey = (all, key) => Object.values(all).find((a) => a.via === 'local' && a.usernameKey === key) ?? null;

  /** Read-modify-write; `fn(all)` changes the accounts in place and returns what the caller gets back */
  async function change(fn) {
    let result;
    await file.update((doc) => {
      const next = doc?.version === FILE_VERSION && doc.accounts ? doc : { version: FILE_VERSION, accounts: {} };
      result = fn(next.accounts);
      return next;
    });
    return result;
  }

  const mustFind = (all, id) => {
    const account = all[id];
    if (!account) throw httpError(404, 'accounts.unknown', 'No such account');
    return account;
  };

  /** Refuse a change that would leave the directory without an active administrator, when it has one */
  function guardLastAdmin(all, id, apply) {
    const before = Object.values(all).filter(isActiveAdmin).length;
    const target = all[id];
    const copy = { ...target };
    apply(copy);
    const after = before - (isActiveAdmin(target) ? 1 : 0) + (isActiveAdmin(copy) ? 1 : 0);
    if (before > 0 && after === 0) {
      throw httpError(409, 'accounts.last_admin', 'This is the last administrator: promote someone else first');
    }
    apply(target);
  }

  /** The User a session carries for this account (ARCHITECTURE §5) */
  function toUser(account) {
    return createUser({
      id: account.id, username: account.username, name: account.name, email: account.email ?? '',
      role: effectiveRole(account), groups: account.groups ?? [], via: account.via,
    });
  }

  /**
   * What other modules and administrators see of an account: the Account of
   * ARCHITECTURE §7 ({ id, username, name, role, state, via, hasPasskey })
   * plus what the users tab shows. Never a hash, never a key
   */
  function summary(account) {
    return {
      id: account.id,
      username: account.username,
      name: account.name,
      email: account.email ?? '',
      role: effectiveRole(account),
      state: account.state,
      via: account.via,
      hasPasskey: (account.passkeys ?? []).length > 0,
      passkeys: (account.passkeys ?? []).length,
      roleOverride: account.via === 'oidc' ? account.roleOverride ?? null : null,
      groupRole: account.via === 'oidc' ? account.role : null,
      groups: account.groups ?? [],
      needsPasskey: account.via === 'local' && account.role === 'admin' && !(account.passkeys ?? []).length,
      createdAt: iso(account.createdAt),
      lastSignInAt: iso(account.lastSignInAt),
      environment: false,
    };
  }

  /** Passkeys as their owner sees them: no public key, no counter */
  const passkeyView = (p) => ({ id: p.id, name: p.name, createdAt: iso(p.createdAt), lastUsedAt: iso(p.lastUsedAt), backedUp: Boolean(p.backedUp) });

  const provider = {
    id: 'directory',
    /** → { user, requires? } for an active local account whose password matches, else null. Same work in every case */
    async verify({ username, password }) {
      // No local account at all: every name is unknown alike, nothing to hide.
      // (The environment administrator's provider hashes in parallel, with
      // the same cost, so the answer takes as long either way)
      if (!Object.values(accounts()).some((a) => a.via === 'local')) return null;
      const key = usernameKey(username);
      const found = key && key !== envKey ? localByKey(accounts(), key) : null;
      const ok = await verifyPassword(password, found?.passwordHash ?? await dummyHash());
      if (!found || !ok) return null;
      const account = accounts()[found.id]; // read again: it may have changed during the hash
      if (!account || account.passwordHash !== found.passwordHash || account.state !== 'active') return null;
      const user = toUser(account);
      // An administrator signs in with a passkey: the password alone is not enough
      if (user.role === 'admin') return { user, requires: [(account.passkeys ?? []).length ? 'passkey' : 'passkey-enrol'], binding: stepBinding(account) };
      return { user };
    },
  };

  return {
    /** Read the accounts from the database (the module's start()) */
    load: () => file.load(),
    provider,
    toUser,
    summary,
    passkeyView,
    effectiveRole,

    get: (id) => (Object.hasOwn(accounts(), id) ? structuredClone(accounts()[id]) : null),
    list: () => Object.values(accounts()).sort((a, b) => String(a.usernameKey).localeCompare(String(b.usernameKey))),
    /** Is this user name taken (by a local account or by the environment's administrator)? */
    isTaken: (username) => {
      const key = usernameKey(username);
      return key === envKey || Boolean(localByKey(accounts(), key));
    },
    /** The account and passkey a credential id belongs to, or null */
    findCredential(credentialId) {
      for (const account of Object.values(accounts())) {
        const passkey = (account.passkeys ?? []).find((p) => p.id === credentialId);
        if (passkey) return { account: structuredClone(account), passkey: structuredClone(passkey) };
      }
      return null;
    },
    activeAdmins: () => Object.values(accounts()).filter(isActiveAdmin).map((a) => a.id),

    /** A new local account. Throws 409 accounts.username_unavailable when the name is taken */
    createLocal({ username, name, passwordHash, role, state, createdBy, invitation }) {
      const key = usernameKey(username);
      return change((all) => {
        if (key === envKey || localByKey(all, key)) throw httpError(409, 'accounts.username_unavailable', 'This user name is not available');
        const id = `local:${username.trim()}`;
        if (all[id]) throw httpError(409, 'accounts.username_unavailable', 'This user name is not available');
        all[id] = {
          id, via: 'local', username: username.trim(), usernameKey: key, name, email: '',
          role, state, passwordHash, passwordChangedAt: now(),
          webauthnUserId: crypto.randomBytes(16).toString('base64url'),
          passkeys: [], createdAt: now(), createdBy: createdBy ?? null, invitation: invitation ?? null, lastSignInAt: null,
        };
        return structuredClone(all[id]);
      });
    },

    /**
     * An SSO account signs in: record it (name, groups, the role its groups
     * give) and say whether it may. → false when an administrator disabled it
     */
    admitSso(user, { groupRole }) {
      return change((all) => {
        const existing = all[user.id];
        if (existing && existing.state !== 'active') return false;
        all[user.id] = {
          roleOverride: null, createdAt: now(), passkeys: [],
          ...existing,
          id: user.id, via: 'oidc', username: user.username, usernameKey: usernameKey(user.username), name: user.name, email: user.email,
          groups: [...user.groups], role: groupRole === 'admin' ? 'admin' : 'student', state: 'active', lastSignInAt: now(),
        };
        return true;
      });
    },

    /**
     * Set a role. Local: 'student' | 'admin'. SSO: 'student' | 'admin' forces
     * it, null goes back to the groups. → { before, after } (effective roles)
     */
    setRole(id, role) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.via === 'local' && role === null) throw httpError(400, 'accounts.bad_role', 'A local account needs a role');
        const before = effectiveRole(account);
        const stored = account.via === 'oidc' ? account.roleOverride ?? null : account.role;
        guardLastAdmin(all, id, (a) => {
          if (a.via === 'oidc') a.roleOverride = role;
          else a.role = role;
        });
        return { before, after: effectiveRole(account), changed: stored !== role, account: summary(account) };
      });
    },

    /** 'active' | 'disabled'; approving a pending account is approve() */
    setState(id, state) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.state === 'pending') throw httpError(409, 'accounts.pending', 'Approve or reject this account first');
        const before = account.state;
        guardLastAdmin(all, id, (a) => { a.state = state; });
        return { before, after: account.state, account: summary(account) };
      });
    },

    approve(id) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.state !== 'pending') throw httpError(409, 'accounts.not_pending', 'This account is not waiting for approval');
        account.state = 'active';
        return summary(account);
      });
    },

    /** A pending account is refused: it is removed, its user name is free again */
    reject(id) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.state !== 'pending') throw httpError(409, 'accounts.not_pending', 'This account is not waiting for approval');
        delete all[id];
        return summary(account);
      });
    },

    setPassword(id, passwordHash) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.via !== 'local') throw httpError(400, 'accounts.not_local', 'This account signs in through the identity provider');
        account.passwordHash = passwordHash;
        account.passwordChangedAt = now();
      });
    },

    setName(id, name) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.via !== 'local') throw httpError(400, 'accounts.not_local', 'This account signs in through the identity provider');
        account.name = name;
        return summary(account);
      });
    },

    touch(id) {
      return change((all) => {
        if (all[id]) all[id].lastSignInAt = now();
      }).catch((err) => log.error(`last sign-in of ${id} not recorded: ${err.message}`));
    },

    /** Check a password of a local account (its owner changing it) */
    async checkPassword(id, password) {
      const account = accounts()[id];
      const ok = await verifyPassword(password, account?.via === 'local' ? account.passwordHash : await dummyHash());
      return ok && account?.via === 'local';
    },

    addPasskey(id, passkey) {
      return change((all) => {
        const account = mustFind(all, id);
        if (account.via !== 'local') throw httpError(400, 'accounts.not_local', 'This account signs in through the identity provider');
        account.passkeys ??= [];
        if (account.passkeys.length >= MAX_PASSKEYS) throw httpError(409, 'accounts.too_many_passkeys', 'This account already has the most passkeys allowed', { max: MAX_PASSKEYS });
        if (Object.values(all).some((a) => (a.passkeys ?? []).some((p) => p.id === passkey.id))) {
          throw httpError(409, 'accounts.passkey_known', 'This passkey is already registered');
        }
        account.passkeys.push({ ...passkey, createdAt: now(), lastUsedAt: null });
        return passkeyView(account.passkeys.at(-1));
      });
    },

    renamePasskey(id, credentialId, name) {
      return change((all) => {
        const passkey = (mustFind(all, id).passkeys ?? []).find((p) => p.id === credentialId);
        if (!passkey) throw httpError(404, 'accounts.unknown_passkey', 'No such passkey');
        passkey.name = name;
        return passkeyView(passkey);
      });
    },

    /** Remove one passkey; an administrator keeps at least one (it is how they sign in) */
    removePasskey(id, credentialId) {
      return change((all) => {
        const account = mustFind(all, id);
        const list = account.passkeys ?? [];
        const at = list.findIndex((p) => p.id === credentialId);
        if (at === -1) throw httpError(404, 'accounts.unknown_passkey', 'No such passkey');
        if (account.role === 'admin' && list.length === 1) {
          throw httpError(409, 'accounts.last_passkey', 'An administrator signs in with a passkey: add another one before removing this one');
        }
        list.splice(at, 1);
      });
    },

    /** An administrator wipes an account's passkeys (a lost device): a promoted administrator registers a new one at the next sign-in */
    clearPasskeys(id) {
      return change((all) => {
        const account = mustFind(all, id);
        const count = (account.passkeys ?? []).length;
        account.passkeys = [];
        return count;
      });
    },

    /** A passkey was used: keep its new signature counter */
    usePasskey(id, credentialId, { counter, backedUp }) {
      return change((all) => {
        const passkey = (all[id]?.passkeys ?? []).find((p) => p.id === credentialId);
        if (!passkey) return;
        passkey.counter = counter;
        passkey.backedUp = Boolean(backedUp);
        passkey.lastUsedAt = now();
        all[id].lastSignInAt = now();
      });
    },
  };
}
