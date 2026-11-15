/**
 * Import of the state that version 2 kept in files before it had a database
 *
 * At start-up, after the migrations: each known file of the data directory
 * that is still there is read, its records are written through the
 * repositories in one transaction that also records the file in
 * legacy_imports, then the file is renamed <name>.imported. Files are never
 * deleted: a human can still read them, and a backup made before the switch
 * still restores. A file that cannot be read as what it should be is left for
 * a human as <name>.not-imported, with an error in the log; the records of a
 * readable file that do not make sense are skipped and counted.
 *
 * legacy_imports keeps the SHA-256 of each imported file. A crash between the
 * commit and the rename is harmless: the next start finds the same file
 * (same path, same hash) in legacy_imports and only renames it. A file that
 * comes back under an imported path with other content (pre-production
 * rolled back to a build without the database, then upgraded again) is
 * imported: the records the database already holds are skipped (sessions and
 * values by key, audit entries by content), the new ones are added.
 *
 * Importing more files later (a module moving its JSON documents into the
 * database) is one more entry in IMPORTERS: `files(store)` lists the paths
 * relative to DATA_DIR, `parse(text)` turns one file into records (throw when
 * the file as a whole is unusable), `write(repos, records, path)` stores them
 * and resolves to { records, skipped }.
 *
 * Imported today: the sign-in module's files and the audit trail (database
 * lot); the run-time settings (settings/<ns>.json), the SSO page
 * (auth/oidc.json) and the admin switches (admin/switches.json) as rows of the
 * settings table; teams/teams.json; benches/occupancy.json, locks.json and
 * reservations.json; accounts/users.json and invitations.json;
 * admin/announcements.json; diagrams/index.json (into an empty index only).
 * The console journal's list of days is rebuilt from the disk by the journal
 * itself (ConsoleJournal.reconcile)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HASH = /^[0-9a-f]{64}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ifFile = (store, rel) => {
  try {
    return fs.statSync(store.resolve(rel)).isFile() ? [rel] : [];
  } catch {
    return [];
  }
};

/** data/auth/sessions.json: { version: 1, sessions: { <sha-256 of the token>: { id, user, createdAt, … } } } */
const sessions = {
  files: (store) => ifFile(store, 'auth/sessions.json'),
  parse(text) {
    const doc = JSON.parse(text);
    if (doc?.version !== 1 || !isObject(doc.sessions)) throw new Error('not a version 1 sessions file');
    return Object.entries(doc.sessions);
  },
  async write(repos, entries) {
    let records = 0;
    let skipped = 0;
    for (const [hash, raw] of entries) {
      const valid = HASH.test(hash) && isObject(raw) && typeof raw.id === 'string' && raw.id
        && isObject(raw.user) && typeof raw.user.id === 'string' && raw.user.id
        && [raw.createdAt, raw.lastSeenAt, raw.expiresAt].every((t) => Number.isFinite(Number(t)));
      if (!valid) { skipped += 1; continue; }
      const { changes } = await repos.sessions.insertIfAbsent({
        id: raw.id, hash, user: raw.user,
        createdAt: Number(raw.createdAt), lastSeenAt: Number(raw.lastSeenAt), expiresAt: Number(raw.expiresAt),
        ip: typeof raw.ip === 'string' ? raw.ip : '', userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
        binding: typeof raw.binding === 'string' ? raw.binding : undefined,
      });
      if (changes) records += 1; else skipped += 1;
    }
    return { records, skipped };
  },
};

/** A small JSON document of the sign-in module → one auth_state value */
const authValue = (rel, name, check) => ({
  files: (store) => ifFile(store, rel),
  parse(text) {
    const doc = JSON.parse(text);
    if (!check(doc)) throw new Error('unexpected content');
    return doc;
  },
  async write(repos, doc) {
    const { changes } = await repos.authState.setIfAbsent(name, doc);
    return { records: changes, skipped: changes ? 0 : 1 };
  },
});

/** data/audit/<yyyy-mm>.jsonl: one entry per line, oldest first */
const audit = {
  files(store) {
    let names;
    try {
      names = fs.readdirSync(store.resolve('audit'));
    } catch {
      return [];
    }
    return names.filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort().flatMap((n) => ifFile(store, `audit/${n}`));
  },
  parse: (text) => text.split('\n'),
  async write(repos, lines) {
    let records = 0;
    let skipped = 0;
    const seen = new Map(); // identical entries in this file so far: a file imported again adds only what is new
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { skipped += 1; continue; } // a torn last line after a crash
      if (!isObject(entry) || typeof entry.action !== 'string' || !isObject(entry.actor) || entry.actor.id === undefined
        || entry.actor.id === null || !Number.isFinite(Date.parse(entry.ts))) {
        skipped += 1;
        continue;
      }
      const record = { ...entry, details: isObject(entry.details) ? entry.details : {} };
      const key = JSON.stringify([record.ts, record.action, String(record.actor.id), record.details]);
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      if (await repos.audit.countSame(record) >= occurrence) { skipped += 1; continue; } // already in the database
      await repos.audit.insert(record);
      records += 1;
    }
    return { records, skipped };
  },
};

// ── The documents of the wave 2 lots (teams, benches, accounts, admin) ──────
// Each importer reads the file that lot's build wrote, and writes its records
// with the repositories' insert-if-absent methods: what the database holds wins

/** A JSON document whose records are written one by one; `records(doc)` lists them, `put(r, record)` → { changes } */
const documentOf = (rel, { check, records, put }) => ({
  files: (store) => ifFile(store, rel),
  parse(text) {
    const doc = JSON.parse(text);
    if (!check(doc)) throw new Error('unexpected content');
    return records(doc);
  },
  async write(repos, list) {
    let done = 0;
    let skipped = 0;
    for (const record of list) {
      let changes;
      try {
        ({ changes } = await repos.transaction((r) => put(r, record)));
      } catch (err) {
        // A record that does not make sense is skipped, not the whole file
        if (!['db.constraint', 'db.unique', 'db.params', 'db.foreign_key'].includes(err.code)) throw err;
        changes = 0;
      }
      if (changes) done += 1; else skipped += 1;
    }
    return { records: done, skipped };
  },
});

const isPerson = (p) => isObject(p) && typeof p.id === 'string';

/** data/teams/teams.json: { teams: [{ id, name, createdAt, createdBy, members, invitations }] } */
const teams = documentOf('teams/teams.json', {
  check: (doc) => isObject(doc) && Array.isArray(doc.teams),
  records: (doc) => doc.teams.filter((t) => isObject(t) && typeof t.id === 'string' && typeof t.name === 'string'
    && Array.isArray(t.members) && t.members.every(isPerson) && Array.isArray(t.invitations ?? [])),
  put: (r, team) => r.teams.insertIfAbsent({ ...team, invitations: team.invitations ?? [] }),
});

/** data/benches/occupancy.json: { [bench]: { teamId, since, by, lastActivity, guests, requests } } */
const occupancy = documentOf('benches/occupancy.json', {
  check: isObject,
  records: (doc) => Object.entries(doc).filter(([, o]) => isObject(o) && typeof o.teamId === 'string'),
  put: (r, [bench, o]) => r.benches.importOccupancy(bench, o),
});

/** data/benches/locks.json: { [bench]: { reason, by, at } } */
const locks = documentOf('benches/locks.json', {
  check: isObject,
  records: (doc) => Object.entries(doc).filter(([, l]) => isObject(l)),
  put: (r, [bench, l]) => r.benches.importLock(bench, l),
});

/** data/benches/reservations.json: { reservations: [{ id, bench, teamId, start, end, by, createdAt, warnedAt?, startedAt? }] } */
const reservations = documentOf('benches/reservations.json', {
  check: (doc) => isObject(doc) && Array.isArray(doc.reservations),
  records: (doc) => doc.reservations.filter((x) => isObject(x) && typeof x.id === 'string' && typeof x.bench === 'string' && typeof x.teamId === 'string'),
  put: (r, reservation) => r.benches.importReservation(reservation),
});

/** data/accounts/users.json: { version: 1, accounts: { [id]: Account } } */
const accounts = documentOf('accounts/users.json', {
  check: (doc) => doc?.version === 1 && isObject(doc.accounts),
  records: (doc) => Object.values(doc.accounts).filter((a) => isObject(a) && typeof a.id === 'string' && ['local', 'oidc'].includes(a.via)),
  put: (r, account) => r.accounts.insertIfAbsent(account),
});

/** data/accounts/invitations.json: { version: 1, links: { [id]: Link } } (token hashes only) */
const links = documentOf('accounts/invitations.json', {
  check: (doc) => doc?.version === 1 && isObject(doc.links),
  records: (doc) => Object.values(doc.links).filter((l) => isObject(l) && typeof l.id === 'string' && typeof l.hash === 'string'),
  put: (r, link) => r.accountLinks.insertIfAbsent(link),
});

/** A document that becomes one row of the settings table (run-time settings, the SSO page, the admin switches) */
const settingsRow = (rel, namespace, { check, values, by = () => null, at = () => undefined }) => documentOf(rel, {
  check,
  records: (doc) => [doc],
  put: (r, doc) => r.settings.saveIfAbsent(namespace, values(doc), by(doc), at(doc) ?? new Date()),
});

/** data/auth/oidc.json: { version: 1, savedAt, settings, clientSecret } (the secret sealed or { clear }) */
const sso = settingsRow('auth/oidc.json', 'sso', {
  check: (doc) => doc?.version === 1 && isObject(doc.settings),
  values: (doc) => doc,
  at: (doc) => doc.savedAt,
});

/** data/admin/switches.json: { switches, updatedAt, updatedBy } */
const switches = settingsRow('admin/switches.json', 'switches', {
  check: (doc) => isObject(doc) && Array.isArray(doc.switches),
  values: (doc) => ({ switches: doc.switches }),
  by: (doc) => (typeof doc.updatedBy === 'string' ? doc.updatedBy : null),
  at: (doc) => doc.updatedAt,
});

/** data/admin/announcements.json: { current, history: [the last 20, newest first] } */
const announcements = documentOf('admin/announcements.json', {
  check: (doc) => isObject(doc) && Array.isArray(doc.history ?? []),
  records(doc) {
    const list = (doc.history ?? []).filter((a) => isObject(a) && typeof a.text === 'string' && typeof a.at === 'string');
    if (isObject(doc.current) && !list.some((a) => a.at === doc.current.at && a.text === doc.current.text)) list.unshift(doc.current);
    // The newest one is the banner unless it had been taken down (current: null)
    return list.map((a, i) => ({
      ...a,
      id: `legacy-${crypto.createHash('sha256').update(JSON.stringify([a.at, a.text, a.by?.id ?? null])).digest('hex').slice(0, 32)}`,
      level: ['info', 'warning'].includes(a.level) ? a.level : 'info',
      removedAt: i === 0 && !doc.current ? new Date().toISOString() : null,
    }));
  },
  put: (r, a) => r.announcements.insertIfAbsent(a),
});

/** data/diagrams/index.json: { active, history, versions }; imported whole, only into an empty index */
const diagramIndex = {
  files: (store) => ifFile(store, 'diagrams/index.json'),
  parse(text) {
    const doc = JSON.parse(text);
    if (!isObject(doc) || !Array.isArray(doc.versions) || !Array.isArray(doc.history)) throw new Error('not a diagram index');
    return doc;
  },
  async write(repos, doc) {
    if (await repos.diagrams.load()) return { records: 0, skipped: doc.versions.length };
    const versions = doc.versions.filter((v) => isObject(v) && typeof v.id === 'string');
    const known = new Set(versions.map((v) => v.id));
    const history = doc.history.filter((h) => isObject(h) && known.has(h.id));
    await repos.diagrams.save({ active: doc.active ?? null, history, versions }, null);
    return { records: versions.length, skipped: doc.versions.length - versions.length };
  },
};

/** data/settings/<ns>.json: { version: 1, values: { 'dotted.path': value }, updatedAt, updatedBy }; the namespace is the file's name */
const settingsFiles = {
  files(store) {
    let names;
    try {
      names = fs.readdirSync(store.resolve('settings'));
    } catch {
      return [];
    }
    return names.filter((n) => /^[a-z][a-z0-9-]{0,30}\.json$/.test(n)).sort().flatMap((n) => ifFile(store, `settings/${n}`));
  },
  parse(text) {
    const doc = JSON.parse(text);
    if (doc?.version !== 1 || !isObject(doc.values)) throw new Error('not a version 1 settings file');
    return doc;
  },
  async write(repos, doc, rel) {
    const namespace = path.basename(rel, '.json');
    const { changes } = await repos.settings.saveIfAbsent(namespace, doc.values, typeof doc.updatedBy === 'string' ? doc.updatedBy : null, doc.updatedAt ?? new Date());
    return { records: changes, skipped: changes ? 0 : 1 };
  },
};

export const IMPORTERS = [
  sessions,
  authValue('auth/local-admin.json', 'local-admin', (d) => isObject(d) && Number.isInteger(d.lastTotpStep)),
  authValue('auth/device-key.json', 'device-key', (d) => isObject(d) && typeof d.key === 'string'),
  audit,
  settingsFiles,
  sso,
  switches,
  teams,
  occupancy,
  locks,
  reservations,
  accounts,
  links,
  announcements,
  diagramIndex,
];

/** Rename without ever replacing an existing file */
function setAside(file, suffix) {
  let target = `${file}${suffix}`;
  if (fs.existsSync(target)) target = `${file}${suffix}-${Date.now()}`;
  fs.renameSync(file, target);
  return path.basename(target);
}

/**
 * Import every legacy file still present. Resolves to [{ path, records,
 * skipped }] for the files imported now. Rejects (and the start stops) only
 * when the database refuses the records: the file is then left untouched
 */
export async function importLegacyFiles({ store, repos, logger, importers = IMPORTERS }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const done = [];
  for (const importer of importers) {
    for (const rel of importer.files(store)) {
      const file = store.resolve(rel);
      let text;
      let records;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        log.error(`${rel} could not be read (${err.message}): left as it is`);
        continue;
      }
      const sha256 = crypto.createHash('sha256').update(text).digest('hex');
      const before = await repos.legacyImports.find(rel);
      if (before?.sha256 === sha256) {
        const kept = setAside(file, '.imported');
        log.warn(`${rel} was imported before but not renamed (interrupted start?): same content, not imported again; kept as ${kept}`);
        continue;
      }
      if (before) {
        log.warn(`${rel} was imported before and has come back with ${before.sha256 ? 'different' : 'unrecorded'} content: importing it, records already in the database are skipped`);
      }
      try {
        records = importer.parse(text);
      } catch (err) {
        const kept = setAside(file, '.not-imported');
        log.error(`${rel} could not be imported (${err.message}): kept as ${kept} for a human to look at`);
        continue;
      }
      let counts;
      try {
        counts = await repos.transaction(async (r) => {
          const result = await importer.write(r, records, rel);
          await r.legacyImports.record(rel, result, sha256);
          return result;
        });
      } catch (err) {
        throw new Error(`Importing ${rel} into the database failed: ${err.message}. The file was left as it is`, { cause: err });
      }
      const kept = setAside(file, '.imported');
      log.info(`${rel} imported into the database (${counts.records} record(s)${counts.skipped ? `, ${counts.skipped} skipped` : ''}); the file is kept as ${kept}`);
      done.push({ path: rel, ...counts });
    }
  }
  return done;
}
