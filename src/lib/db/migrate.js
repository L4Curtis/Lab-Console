/**
 * Schema migrations (ARCHITECTURE §6, "database")
 *
 * One file per change in src/lib/db/migrations/, named NNN-name.js (three
 * digits, then lowercase words joined by dashes), exporting
 *
 *   export async function up(tx) { await tx.run('CREATE TABLE …'); … }
 *
 * with portable SQL, one statement per tx.run(). A migration is never edited
 * once it has been merged: a change is a new file with the next number.
 *
 * At start-up the pending migrations run in order, all in ONE transaction,
 * each recorded in schema_migrations: either the database reaches the
 * version of the code, or nothing changes and the start stops with a message
 * naming the migration that failed. A database that records a migration the
 * code does not have (a newer version was started on it, or two branches
 * used the same number) also stops the start: running old code on a newer
 * schema would corrupt it quietly
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseError } from './portable.js';
import { toIso } from './values.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILE = /^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.js$/;

export class MigrationError extends DatabaseError {
  constructor(message, { cause } = {}) {
    super(message, 'db.migration', { cause });
    this.name = 'MigrationError';
  }
}

/** The migrations of a directory, in order: [{ version: '001', name: 'auth', id: '001-auth', up }] */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const migrations = [];
  for (const file of files) {
    const match = FILE.exec(file);
    if (!match) throw new MigrationError(`Migration file ${file} is not named NNN-name.js`);
    const [, version, name] = match;
    if (migrations.some((m) => m.version === version)) throw new MigrationError(`Two migrations are numbered ${version}: give one the next free number`);
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    if (typeof mod.up !== 'function') throw new MigrationError(`Migration ${file} does not export up(tx)`);
    migrations.push({ version, name, id: `${version}-${name}`, up: mod.up });
  }
  return migrations;
}

/**
 * Bring the database to the version of `migrations`. Resolves to the ids of
 * the migrations applied now ([] when it was up to date)
 */
export async function migrate(db, migrations, { logger, now = () => new Date() } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = await db.query('SELECT version, name FROM schema_migrations ORDER BY version');
  const known = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    const mine = known.get(row.version);
    if (!mine) {
      throw new MigrationError(`The database records migration ${row.version}-${row.name}, which this version of Lab Console does not have: it was used by a newer version. Start that version, or restore a backup of the data directory`);
    }
    if (mine.name !== row.name) {
      throw new MigrationError(`The database records migration ${row.version} as "${row.name}" but this version calls it "${mine.name}": two changes used the same number`);
    }
  }
  const done = new Set(applied.map((r) => r.version));
  const pending = migrations.filter((m) => !done.has(m.version));
  if (!pending.length) return [];

  let current;
  try {
    await db.transaction(async (tx) => {
      for (const migration of pending) {
        current = migration;
        await migration.up(tx);
        await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [migration.version, migration.name, toIso(now())]);
      }
    });
  } catch (err) {
    throw new MigrationError(`Database migration ${current?.id ?? '?'} failed: ${err.message}. Nothing was changed (every pending migration was rolled back); fix it and start again`, { cause: err });
  }
  const ids = pending.map((m) => m.id);
  log.info(`database migrated: ${ids.join(', ')}`);
  return ids;
}
