/**
 * Portability of the SQL (ARCHITECTURE §6, "database"): the rules the
 * adapter enforces on every statement, every migration run statement by
 * statement against them, and no SQL outside src/lib/db
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations } from '../src/lib/db/index.js';
import { portabilityProblems, placeholderCount } from '../src/lib/db/portable.js';
import { openSqlite } from '../src/lib/db/sqlite.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js file under `dir`, recursively */
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

/** The source without its comments (good enough for our own files: no '//' or '/*' inside strings that matter here) */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('portabilityProblems', () => {
  test('known SQLite-only (or PostgreSQL-only) constructs are reported', () => {
    const refused = {
      'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)': /AUTOINCREMENT/,
      'CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)': /rowid alias/,
      'CREATE TABLE t (id TEXT PRIMARY KEY) WITHOUT ROWID': /WITHOUT ROWID/,
      'CREATE TABLE t (id TEXT PRIMARY KEY) STRICT': /STRICT/,
      'INSERT OR REPLACE INTO t (id) VALUES (?)': /INSERT OR/,
      'INSERT OR IGNORE INTO t (id) VALUES (?)': /INSERT OR/,
      'REPLACE INTO t (id) VALUES (?)': /REPLACE INTO/,
      'INSERT INTO t (id) VALUES (?) ON CONFLICT DO UPDATE SET id = excluded.id': /needs a conflict target/,
      'CREATE TABLE t (id TEXT PRIMARY KEY ON CONFLICT REPLACE)': /conflict clause/,
      'SELECT rowid FROM t': /rowid/,
      'PRAGMA foreign_keys = ON': /adapter/,
      'VACUUM': /adapter/,
      'SELECT datetime(\'now\') AS d': /SQLite-only function/,
      'SELECT strftime(\'%s\', ts) FROM t': /SQLite-only function/,
      'SELECT ifnull(a, b) FROM t': /SQLite-only function/,
      'SELECT group_concat(a) FROM t': /SQLite-only function/,
      'SELECT json_extract(data, ?) FROM t': /SQLite-only function/,
      'SELECT max(a, b) FROM t': /min\(a, b\)/,
      'SELECT id FROM t WHERE name GLOB ?': /GLOB/,
      'SELECT id FROM t ORDER BY name COLLATE NOCASE': /collations/,
      'INSERT INTO t (id, at) VALUES (?, CURRENT_TIMESTAMP)': /from the application/,
      'SELECT id FROM t WHERE flag = TRUE': /booleans are integers/,
      'CREATE TABLE t (id TEXT PRIMARY KEY, at DATETIME)': /column types/,
      'CREATE TABLE t (id TEXT PRIMARY KEY, ok BOOLEAN)': /column types/,
      'CREATE TABLE t (id TEXT PRIMARY KEY, data BLOB)': /column types/,
      'SELECT id FROM t LIMIT 10, 20': /LIMIT \? OFFSET \?/,
      'SELECT id FROM t LIMIT -1 OFFSET ?': /negative LIMIT/,
      'SELECT id FROM t WHERE a IS ?': /IS \/ IS NOT only compare with NULL/,
      'SELECT id FROM t WHERE a = $1': /plain \?/,
      'SELECT id FROM t WHERE a = :name': /plain \?/,
      'SELECT id FROM t WHERE a = ?1': /plain \?/,
      'SELECT a::text FROM t': /:: cast/,
      'SELECT "order" FROM t': /quoted identifier/,
      'SELECT [order] FROM t': /quoted identifier/,
      'DELETE FROM t; DELETE FROM u': /one statement per call/,
      '': /non-empty/,
    };
    for (const [sql, pattern] of Object.entries(refused)) {
      const problems = portabilityProblems(sql);
      assert.ok(problems.some((p) => pattern.test(p)), `${sql} → ${JSON.stringify(problems)}`);
    }
  });

  test('portable statements pass, and literals or comments never trigger a rule', () => {
    for (const sql of [
      'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, big BIGINT, r REAL, data TEXT NOT NULL)',
      'CREATE INDEX t_n ON t (n, id)',
      'INSERT INTO t (id, n) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n',
      'INSERT INTO t (id, n) VALUES (?, ?) ON CONFLICT DO NOTHING',
      'INSERT INTO t (id, n) VALUES (?, ?) RETURNING id',
      'SELECT id, coalesce(n, 0) AS n FROM t WHERE substr(id, 1, ?) = ? AND lower(name) = lower(?) ORDER BY id LIMIT ? OFFSET ?',
      'SELECT count(*) AS n, max(n) AS top FROM t WHERE a IS NULL OR b IS NOT NULL OR c IS DISTINCT FROM ?',
      'SELECT CASE WHEN n > ? THEN 1 ELSE 0 END AS flag FROM t',
      'SELECT \'INSERT OR REPLACE; datetime(now) TRUE "x"\' AS text FROM t -- AUTOINCREMENT, PRAGMA\n',
      'SELECT id /* rowid? GLOB */ FROM t;',
    ]) {
      assert.deepEqual(portabilityProblems(sql), [], sql);
    }
  });

  test('placeholders are counted outside literals and comments', () => {
    assert.equal(placeholderCount('SELECT ? AS a, \'?\' AS b -- ?\n FROM t WHERE x = ? /* ? */'), 2);
  });
});

describe('every migration is portable', () => {
  test('each statement a migration runs, on an empty database, breaks no rule', async (t) => {
    const db = openSqlite(':memory:');
    t.after(() => db.close());
    const migrations = await loadMigrations();
    const seen = [];
    await db.transaction(async (tx) => {
      // A transaction executor that writes down every statement before it runs
      const recording = {
        ...tx,
        query: (sql, params) => { seen.push(sql); return tx.query(sql, params); },
        get: (sql, params) => { seen.push(sql); return tx.get(sql, params); },
        run: (sql, params) => { seen.push(sql); return tx.run(sql, params); },
      };
      for (const m of migrations) {
        const before = seen.length;
        await m.up(recording);
        assert.ok(seen.length > before, `${m.id} runs at least one statement`);
      }
    });
    for (const sql of seen) assert.deepEqual(portabilityProblems(sql), [], sql);
    // Every table has a primary key; every index is created explicitly (no reliance on implicit ones)
    for (const sql of seen.filter((s) => /^\s*CREATE TABLE/i.test(s))) assert.match(sql, /PRIMARY KEY/i, sql);
  });

  test('the migration and repository sources hold none of the known constructs, even in code a test does not reach', () => {
    const forbidden = [
      /\bAUTOINCREMENT\b/i, /\bINSERT\s+OR\b/i, /\bREPLACE\s+INTO\b/i, /\bPRAGMA\b/i, /\bWITHOUT\s+ROWID\b/i,
      /\b(?:datetime|strftime|julianday|unixepoch|ifnull|group_concat|json_[a-z_]+)\s*\(/i, /\bCURRENT_TIMESTAMP\b/i, /\$\d/,
    ];
    const files = [...sources(path.join(root, 'src/lib/db/migrations')), ...sources(path.join(root, 'src/lib/db/repositories'))];
    assert.ok(files.length >= 8);
    for (const file of files) {
      const code = withoutComments(fs.readFileSync(file, 'utf8'));
      for (const pattern of forbidden) assert.doesNotMatch(code, pattern, `${path.relative(root, file)}: ${pattern}`);
    }
  });
});

test('no SQL outside src/lib/db: modules go through a repository', () => {
  const sql = /\b(?:SELECT\s+[\w*,\s().]+\s+FROM\s+\w|INSERT\s+INTO\s+\w|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s+\w|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s)/;
  const offenders = sources(path.join(root, 'src'))
    .filter((file) => !file.startsWith(path.join(root, 'src/lib/db') + path.sep))
    .filter((file) => sql.test(withoutComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});
