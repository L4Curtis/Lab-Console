/**
 * The data-access interface (src/lib/db): the SQLite adapter's semantics
 * (results, parameters, transactions, the one-connection queue, closing, the
 * file it creates) and the migrations (from empty, re-run, failure, a
 * database newer than the code)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../src/lib/db/sqlite.js';
import { openDatabase, loadMigrations, migrate, MigrationError, DatabaseError } from '../src/lib/db/index.js';
import { toIso, fromIso, toFlag, fromFlag, toJson, fromJson, newId } from '../src/lib/db/values.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger } from './helpers/fakes.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function scratch(t) {
  const db = openSqlite(':memory:');
  t.after(() => db.close());
  await db.run('CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL, n INTEGER)');
  return db;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-console-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('adapter: statements', () => {
  test('query → rows as plain objects, get → the first row or undefined, run → { changes }', async (t) => {
    const db = await scratch(t);
    assert.deepEqual(await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['a', 'first', 1]), { changes: 1 });
    await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['b', 'second', 2]);
    const rows = await db.query('SELECT id, label, n FROM items ORDER BY id');
    assert.deepEqual(rows, [{ id: 'a', label: 'first', n: 1 }, { id: 'b', label: 'second', n: 2 }]);
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    assert.deepEqual(await db.get('SELECT label FROM items WHERE id = ?', ['b']), { label: 'second' });
    assert.equal(await db.get('SELECT label FROM items WHERE id = ?', ['zzz']), undefined);
    assert.deepEqual(await db.query('SELECT id FROM items WHERE n > ?', [10]), []);
    assert.deepEqual(await db.run('UPDATE items SET n = n + 1', []), { changes: 2 });
    assert.deepEqual(await db.run('DELETE FROM items WHERE id = ?', ['nope']), { changes: 0 });
    await assert.rejects(db.query('SELECT id FROM nowhere'), (e) => e instanceof DatabaseError && e.code === 'db.error' && /no such table/.test(e.message));
    assert.deepEqual(await db.query('DELETE FROM items WHERE id = ? RETURNING id, n', ['a']), [{ id: 'a', n: 2 }], 'RETURNING is allowed');
  });

  test('parameters: one portable value per "?", or the statement is refused before it runs', async (t) => {
    const db = await scratch(t);
    const refused = async (params, pattern) => {
      const err = await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', params).catch((e) => e);
      assert.ok(err instanceof DatabaseError, String(err));
      assert.equal(err.code, 'db.params');
      assert.match(err.message, pattern);
    };
    await refused(['a', 'x'], /3 placeholder\(s\) but 2/);
    await refused(['a', 'x', true], /boolean: store booleans as 1 \/ 0/);
    await refused(['a', 'x', undefined], /undefined: pass null/);
    await refused(['a', new Date(), 1], /Date: store timestamps as ISO-8601/);
    await refused(['a', { label: 1 }, 1], /object: store JSON payloads as text/);
    await refused(['a', 'x', Infinity], /not a finite number/);
    await assert.rejects(db.run('INSERT INTO items (id, label) VALUES (?, ?)', 'a'), /Parameters are an array/);
    assert.equal((await db.query('SELECT id FROM items')).length, 0, 'nothing was written');
    // A '?' inside a string literal or a comment is not a placeholder
    assert.deepEqual(await db.get('SELECT \'is it?\' AS q, ? AS v -- or not?', [1]), { q: 'is it?', v: 1 });
  });

  test('non-portable SQL is refused before it reaches SQLite, with the rule it breaks', async (t) => {
    const db = await scratch(t);
    const err = await db.run('INSERT OR REPLACE INTO items (id, label) VALUES (?, ?)', ['a', 'x']).catch((e) => e);
    assert.equal(err.code, 'db.not_portable');
    assert.match(err.message, /ON CONFLICT/);
    await assert.rejects(db.query('SELECT datetime(?) AS d', ['now']), /SQLite-only function/);
    await assert.rejects(db.query('PRAGMA user_version'), /belong to the adapter/);
  });

  test('constraint violations carry a stable code', async (t) => {
    const db = await scratch(t);
    await db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
    const unique = await db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'y']).catch((e) => e);
    assert.equal(unique.code, 'db.unique');
    const notNull = await db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['b', null]).catch((e) => e);
    assert.equal(notNull.code, 'db.constraint');
  });

  test('foreign keys are enforced', async (t) => {
    const db = await scratch(t);
    await db.run('CREATE TABLE parts (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE)');
    const err = await db.run('INSERT INTO parts (id, item_id) VALUES (?, ?)', ['p', 'missing']).catch((e) => e);
    assert.equal(err.code, 'db.foreign_key');
    await db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
    await db.run('INSERT INTO parts (id, item_id) VALUES (?, ?)', ['p', 'a']);
    await db.run('DELETE FROM items WHERE id = ?', ['a']);
    assert.deepEqual(await db.query('SELECT id FROM parts'), [], 'ON DELETE CASCADE works');
  });
});

describe('adapter: transactions', () => {
  test('committed when the callback resolves; its value is returned', async (t) => {
    const db = await scratch(t);
    const value = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['b', 'y']);
      return (await tx.query('SELECT id FROM items')).length;
    });
    assert.equal(value, 2);
    assert.equal((await db.query('SELECT id FROM items')).length, 2);
  });

  test('rolled back when the callback throws, and the error is passed on', async (t) => {
    const db = await scratch(t);
    await db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['keep', 'x']);
    const boom = new Error('boom');
    await assert.rejects(db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
      await tx.run('UPDATE items SET label = ? WHERE id = ?', ['changed', 'keep']);
      throw boom;
    }), (err) => err === boom);
    assert.deepEqual(await db.query('SELECT id, label FROM items'), [{ id: 'keep', label: 'x' }]);
    // A failing statement inside rolls everything back too
    await assert.rejects(db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['b', 'x']);
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['keep', 'dup']);
    }), { code: 'db.unique' });
    assert.deepEqual(await db.query('SELECT id FROM items'), [{ id: 'keep' }]);
    // And the connection is usable afterwards
    await db.transaction((tx) => tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['c', 'x']));
    assert.equal((await db.query('SELECT id FROM items')).length, 2);
  });

  test('concurrent transactions are serialized: one never sees the other in the middle', async (t) => {
    const db = await scratch(t);
    await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['counter', 'c', 0]);
    const steps = [];
    // Read-modify-write with a pause in the middle: interleaved, both would read 0
    const increment = (name) => db.transaction(async (tx) => {
      steps.push(`${name} begin`);
      const { n } = await tx.get('SELECT n FROM items WHERE id = ?', ['counter']);
      await tick(10);
      await tx.run('UPDATE items SET n = ? WHERE id = ?', [n + 1, 'counter']);
      steps.push(`${name} end`);
    });
    await Promise.all([increment('A'), increment('B'), increment('C')]);
    assert.deepEqual(steps, ['A begin', 'A end', 'B begin', 'B end', 'C begin', 'C end']);
    assert.equal((await db.get('SELECT n FROM items WHERE id = ?', ['counter'])).n, 3);
  });

  test('a statement on the database issued by other code during a transaction runs after it, in call order', async (t) => {
    const db = await scratch(t);
    const order = [];
    const inside = db.transaction(async (tx) => {
      await tick(5);
      assert.equal(await tx.get('SELECT id FROM items WHERE id = ?', ['outside']), undefined, 'not yet');
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['inside', 'x']);
      order.push('inside');
    });
    const outside = db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['outside', 'x']).then(() => order.push('outside'));
    await Promise.all([inside, outside]);
    assert.deepEqual(order, ['inside', 'outside']);
  });

  test('a call on the database from inside a transaction is refused at once instead of waiting forever', async (t) => {
    const db = await scratch(t);
    let later;
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
      const reentry = { code: 'db.tx_reentry', message: /use the tx argument inside a transaction/ };
      // Awaited: would have frozen every database access for good
      await assert.rejects(db.get('SELECT id FROM items WHERE id = ?', ['a']), reentry);
      await assert.rejects(db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['b', 'x']), reentry);
      await assert.rejects(db.transaction(() => {}), reentry);
      await assert.rejects(db.close(), reentry);
      // Through a nested savepoint and further async hops, still recognised
      await tx.transaction(async () => {
        await tick(1);
        await assert.rejects(db.query('SELECT id FROM items'), reentry);
      });
      // Work started inside that runs once the transaction is over uses the database normally
      later = new Promise((resolve, reject) => {
        setTimeout(() => db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['later', 'x']).then(resolve, reject), 20);
      });
    });
    await later;
    assert.deepEqual((await db.query('SELECT id FROM items ORDER BY id')).map((r) => r.id), ['a', 'later']);
    assert.equal(db.pending, 0);
  });

  test('statements issued without awaiting are applied in call order', async (t) => {
    const db = await scratch(t);
    const writes = [];
    for (let i = 0; i < 20; i++) writes.push(db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n', ['k', 'x', i]));
    writes.push(db.run('DELETE FROM items WHERE id = ?', ['k']));
    writes.push(db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['k', 'last', 99]));
    await Promise.all(writes);
    assert.deepEqual(await db.get('SELECT label, n FROM items WHERE id = ?', ['k']), { label: 'last', n: 99 });
  });

  test('a nested transaction is a savepoint: its failure rolls back only itself', async (t) => {
    const db = await scratch(t);
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['outer', 'x']);
      await assert.rejects(tx.transaction(async (inner) => {
        await inner.run('INSERT INTO items (id, label) VALUES (?, ?)', ['inner', 'x']);
        throw new Error('inner fails');
      }), /inner fails/);
      await tx.transaction((inner) => inner.run('INSERT INTO items (id, label) VALUES (?, ?)', ['inner2', 'x']));
    });
    assert.deepEqual((await db.query('SELECT id FROM items ORDER BY id')).map((r) => r.id), ['inner2', 'outer']);
  });

  test('a transaction executor refuses to work once its transaction is over, and cannot close the database', async (t) => {
    const db = await scratch(t);
    let kept;
    await db.transaction(async (tx) => { kept = tx; });
    await assert.rejects(kept.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']), { code: 'db.tx_over' });
    await assert.rejects(db.transaction((tx) => tx.close()), { code: 'db.tx_close' });
    assert.deepEqual(await db.query('SELECT id FROM items'), []);
  });
});

describe('adapter: closing and the file', () => {
  test('close waits for what is queued, then refuses new statements', async (t) => {
    const db = openSqlite(':memory:');
    await db.run('CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)');
    const slow = db.transaction(async (tx) => {
      await tick(10);
      await tx.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
    });
    const queued = db.get('SELECT count(*) AS n FROM items');
    await db.close();
    await slow;
    assert.deepEqual(await queued, { n: 1 });
    await assert.rejects(db.query('SELECT id FROM items'), { code: 'db.closed' });
    await assert.rejects(db.transaction(async () => {}), { code: 'db.closed' });
    await db.close(); // twice is fine
    t.diagnostic('closed');
  });

  test('a file database: mode 0600, WAL journal, survives a reopen', async (t) => {
    const file = path.join(tempDir(t), 'lab-console.db');
    const db = openSqlite(file);
    await db.run('CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)');
    await db.run('INSERT INTO items (id, label) VALUES (?, ?)', ['a', 'x']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    await db.close();
    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    raw.close();
    const again = openSqlite(file);
    t.after(() => again.close());
    assert.deepEqual(await again.query('SELECT id, label FROM items'), [{ id: 'a', label: 'x' }]);
  });

  test('a file that is not a database is refused with a clear error', async (t) => {
    const file = path.join(tempDir(t), 'lab-console.db');
    fs.writeFileSync(file, 'this is not a database, just text long enough to have a header'.repeat(10));
    const err = await openDatabase({ file }).catch((e) => e);
    assert.ok(err instanceof DatabaseError, String(err));
    assert.match(err.message, /lab-console\.db/);
  });
});

describe('values: how types are stored', () => {
  test('timestamps are fixed-length ISO-8601 UTC text, so text order is time order', () => {
    assert.equal(toIso(Date.UTC(2026, 10, 13, 9)), '2026-11-13T09:00:00.000Z');
    assert.equal(toIso(new Date('2026-11-13T10:00:00+01:00')), '2026-11-13T09:00:00.000Z');
    assert.equal(toIso('2026-11-13'), '2026-11-13T00:00:00.000Z');
    for (const bad of [undefined, null, '', 'yesterday', NaN, 8.64e15 + 1, Date.UTC(10000, 0, 1)]) assert.equal(toIso(bad), null, String(bad));
    assert.equal(fromIso('2026-11-13T09:00:00.000Z'), Date.UTC(2026, 10, 13, 9));
    assert.ok(Number.isNaN(fromIso(null)));
  });

  test('booleans are 1 / 0, JSON is text, a damaged payload gives the fallback', () => {
    assert.deepEqual([toFlag(true), toFlag(false), toFlag(undefined)], [1, 0, 0]);
    assert.deepEqual([fromFlag(1), fromFlag(0), fromFlag(1n), fromFlag('1')], [true, false, true, false]);
    assert.equal(toJson({ a: [1] }), '{"a":[1]}');
    assert.equal(toJson(undefined), 'null');
    assert.deepEqual(fromJson('{"a":1}'), { a: 1 });
    assert.deepEqual(fromJson('{oops', { fallback: true }), { fallback: true });
    assert.equal(fromJson(null), null);
  });

  test('ids are UUID v7: well-formed, unique, and in creation order within one millisecond', () => {
    const at = Date.UTC(2026, 10, 13, 9);
    const ids = Array.from({ length: 5000 }, () => newId(at));
    for (const id of ids.slice(0, 10)) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), ids, 'sorted as text = created order (even past 4096 in one millisecond)');
    assert.ok(newId(at + 10_000) > ids.at(-1));
  });
});

describe('migrations', () => {
  test('from an empty database: every migration applied in order and recorded; a re-run changes nothing', async (t) => {
    const migrations = await loadMigrations();
    assert.ok(migrations.length >= 4);
    assert.deepEqual(migrations.map((m) => m.version), [...migrations.map((m) => m.version)].sort());
    const db = openSqlite(':memory:');
    t.after(() => db.close());
    const log = recordingLogger();
    const applied = await migrate(db, migrations, { logger: log, now: () => new Date('2026-11-13T09:00:00Z') });
    assert.deepEqual(applied, migrations.map((m) => m.id));
    const rows = await db.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows, migrations.map((m) => ({ version: m.version, name: m.name, applied_at: '2026-11-13T09:00:00.000Z' })));
    assert.ok(log.lines.some((l) => /database migrated/.test(l.message ?? l)), 'the log says what was applied');

    assert.deepEqual(await migrate(db, migrations), [], 'nothing pending');
    assert.equal((await db.query('SELECT version FROM schema_migrations')).length, migrations.length);
  });

  test('openDatabase migrates; the tables of the platform exist', async (t) => {
    const { db, close } = await memoryDatabase();
    t.after(close);
    assert.ok((await db.query('SELECT version FROM schema_migrations')).length >= 4);
    for (const table of ['legacy_imports', 'auth_sessions', 'auth_state', 'audit_entries', 'settings']) {
      assert.deepEqual(await db.query(`SELECT count(*) AS n FROM ${table}`), [{ n: 0 }], table);
    }
  });

  test('a later migration is applied on its own on a database that has the earlier ones', async (t) => {
    const migrations = await loadMigrations();
    const db = openSqlite(':memory:');
    t.after(() => db.close());
    await migrate(db, migrations.slice(0, 2));
    const extra = { version: '999', name: 'extra', id: '999-extra', up: (tx) => tx.run('CREATE TABLE extra (id TEXT PRIMARY KEY)') };
    assert.deepEqual(await migrate(db, [...migrations, extra]), [...migrations.slice(2), extra].map((m) => m.id));
  });

  test('a failing migration rolls back every pending one and names itself', async (t) => {
    const db = openSqlite(':memory:');
    t.after(() => db.close());
    const good = { version: '001', name: 'good', id: '001-good', up: (tx) => tx.run('CREATE TABLE good (id TEXT PRIMARY KEY)') };
    const bad = { version: '002', name: 'bad', id: '002-bad', up: async (tx) => { await tx.run('CREATE TABLE half (id TEXT PRIMARY KEY)'); await tx.run('CREATE TABLE good (id TEXT PRIMARY KEY)'); } };
    const err = await migrate(db, [good, bad]).catch((e) => e);
    assert.ok(err instanceof MigrationError, String(err));
    assert.match(err.message, /Database migration 002-bad failed: .*already exists.*Nothing was changed/);
    assert.deepEqual(await db.query('SELECT version FROM schema_migrations'), []);
    await assert.rejects(db.query('SELECT id FROM good'), /no such table/);
    await assert.rejects(db.query('SELECT id FROM half'), /no such table/);
    // A non-portable statement in a migration fails the same way
    const sqliteOnly = { version: '001', name: 'auto', id: '001-auto', up: (tx) => tx.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)') };
    await assert.rejects(migrate(db, [sqliteOnly]), /001-auto failed: Non-portable SQL \(AUTOINCREMENT/);
  });

  test('openDatabase stops on a failed migration and leaves nothing open', async (t) => {
    const file = path.join(tempDir(t), 'lab-console.db');
    const bad = [{ version: '001', name: 'bad', id: '001-bad', up: (tx) => tx.run('CREATE TABLE (') }];
    await assert.rejects(openDatabase({ file, migrations: bad }), MigrationError);
    // The file is not held: it opens again, and still has no migration recorded
    const db = await openDatabase({ file });
    t.after(() => db.close());
    assert.ok((await db.query('SELECT version FROM schema_migrations')).length >= 4);
  });

  test('a database migrated by a newer version, or with another migration under the same number, is refused', async (t) => {
    const migrations = await loadMigrations();
    const db = openSqlite(':memory:');
    t.after(() => db.close());
    await migrate(db, migrations);
    await db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', ['998', 'from-the-future', toIso(Date.now())]);
    await assert.rejects(migrate(db, migrations), /records migration 998-from-the-future, which this version of Lab Console does not have/);
    await db.run('DELETE FROM schema_migrations WHERE version = ?', ['998']);
    const renamed = migrations.map((m, i) => (i === 0 ? { ...m, name: 'something-else' } : m));
    await assert.rejects(migrate(db, renamed), /two changes used the same number/);
  });

  test('migration files: NNN-name.js, unique numbers, each exports up(tx)', async (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, '001-first.js'), 'export async function up() {}\n');
    assert.deepEqual((await loadMigrations(dir)).map((m) => m.id), ['001-first']);
    fs.writeFileSync(path.join(dir, '001-again.js'), 'export async function up() {}\n');
    await assert.rejects(loadMigrations(dir), /Two migrations are numbered 001/);
    fs.rmSync(path.join(dir, '001-again.js'));
    fs.writeFileSync(path.join(dir, '2-Bad_Name.js'), 'export async function up() {}\n');
    await assert.rejects(loadMigrations(dir), /not named NNN-name\.js/);
    fs.rmSync(path.join(dir, '2-Bad_Name.js'));
    fs.writeFileSync(path.join(dir, '002-no-up.js'), 'export const down = 1;\n');
    await assert.rejects(loadMigrations(dir), /does not export up\(tx\)/);
  });
});
