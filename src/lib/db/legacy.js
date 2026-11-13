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
 * A crash between the commit and the rename is harmless: the next start sees
 * the file in legacy_imports, does not import it again, and only renames it.
 *
 * Importing more files later (a module moving its JSON documents into the
 * database) is one more entry in IMPORTERS: `files(store)` lists the paths
 * relative to DATA_DIR, `parse(text)` turns one file into records (throw when
 * the file as a whole is unusable), `write(repos, records)` stores them and
 * resolves to { records, skipped }
 */
import fs from 'node:fs';
import path from 'node:path';

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
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { skipped += 1; continue; } // a torn last line after a crash
      if (!isObject(entry) || typeof entry.action !== 'string' || !isObject(entry.actor) || entry.actor.id === undefined
        || entry.actor.id === null || !Number.isFinite(Date.parse(entry.ts))) {
        skipped += 1;
        continue;
      }
      await repos.audit.insert({ ...entry, details: isObject(entry.details) ? entry.details : {} });
      records += 1;
    }
    return { records, skipped };
  },
};

export const IMPORTERS = [
  sessions,
  authValue('auth/local-admin.json', 'local-admin', (d) => isObject(d) && Number.isInteger(d.lastTotpStep)),
  authValue('auth/device-key.json', 'device-key', (d) => isObject(d) && typeof d.key === 'string'),
  audit,
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
      if (await repos.legacyImports.has(rel)) {
        log.warn(`${rel} was imported before but not renamed (interrupted start?): renamed now, not imported again`);
        setAside(file, '.imported');
        continue;
      }
      let records;
      try {
        records = importer.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        const kept = setAside(file, '.not-imported');
        log.error(`${rel} could not be imported (${err.message}): kept as ${kept} for a human to look at`);
        continue;
      }
      let counts;
      try {
        counts = await repos.transaction(async (r) => {
          const result = await importer.write(r, records);
          await r.legacyImports.record(rel, result);
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
