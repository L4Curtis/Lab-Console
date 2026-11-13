/**
 * The repositories (src/lib/db/repositories), one by one, on an in-memory
 * database: what they store, in which portable shape, and what they give back
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, createRepositories } from '../src/lib/db/index.js';
import { memoryDatabase } from './helpers/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function setup(t, options) {
  const memory = await memoryDatabase(options);
  t.after(memory.close);
  return memory;
}

const HASH = 'a'.repeat(64);
const session = (extra = {}) => ({
  id: 'sess-1',
  hash: HASH,
  user: { id: 'oidc:student1', username: 'student1', name: 'Student 1', email: '', role: 'student', groups: ['students'], via: 'oidc', initials: 'S1', color: 'x' },
  createdAt: Date.UTC(2026, 10, 13, 8),
  lastSeenAt: Date.UTC(2026, 10, 13, 9),
  expiresAt: Date.UTC(2026, 10, 14, 8),
  ip: '192.0.2.1',
  userAgent: 'test',
  ...extra,
});

describe('sessions repository', () => {
  test('insert / all: times as ISO text, the user as JSON, only the fields a user is rebuilt from', async (t) => {
    const { db, repos } = await setup(t);
    await repos.sessions.insert(session());
    await repos.sessions.insert(session({ id: 'sess-2', hash: 'b'.repeat(64), binding: 'bind', createdAt: Date.UTC(2026, 10, 13, 10) }));
    const raw = await db.get('SELECT token_hash, user_id, user_data, created_at, last_seen_at, expires_at, binding FROM auth_sessions WHERE id = ?', ['sess-1']);
    assert.deepEqual(raw, {
      token_hash: HASH,
      user_id: 'oidc:student1',
      user_data: JSON.stringify({ id: 'oidc:student1', username: 'student1', name: 'Student 1', email: '', role: 'student', groups: ['students'], via: 'oidc' }),
      created_at: '2026-11-13T08:00:00.000Z',
      last_seen_at: '2026-11-13T09:00:00.000Z',
      expires_at: '2026-11-14T08:00:00.000Z',
      binding: null,
    });
    const all = await repos.sessions.all();
    assert.deepEqual(all.map((s) => s.id), ['sess-1', 'sess-2'], 'oldest first');
    const { initials, color, ...stored } = session().user;
    assert.ok(initials && color);
    assert.deepEqual(all[0], { ...session(), user: stored, binding: undefined });
    assert.equal(all[1].binding, 'bind');
  });

  test('refusals: a duplicate id or token hash, a session without valid times', async (t) => {
    const { repos } = await setup(t);
    await repos.sessions.insert(session());
    await assert.rejects(repos.sessions.insert(session({ hash: 'c'.repeat(64) })), { code: 'db.unique' });
    await assert.rejects(repos.sessions.insert(session({ id: 'other' })), { code: 'db.unique' });
    assert.throws(() => repos.sessions.insert(session({ id: 'x', hash: 'd'.repeat(64), expiresAt: NaN })), /valid creation, activity and expiry times/);
    assert.deepEqual(await repos.sessions.insertIfAbsent(session({ hash: 'c'.repeat(64) })), { changes: 0 }, 'imports skip what exists');
    assert.deepEqual(await repos.sessions.insertIfAbsent(session({ id: 'new', hash: 'e'.repeat(64) })), { changes: 1 });
  });

  test('rehash, touch, touchAll, remove', async (t) => {
    const { repos } = await setup(t);
    await repos.sessions.insert(session());
    await repos.sessions.insert(session({ id: 'sess-2', hash: 'b'.repeat(64) }));
    await repos.sessions.rehash('sess-1', 'f'.repeat(64));
    await repos.sessions.touch('sess-1', Date.UTC(2026, 10, 13, 11));
    await repos.sessions.touchAll([['sess-1', Date.UTC(2026, 10, 13, 12)], ['sess-2', Date.UTC(2026, 10, 13, 13)], ['gone', Date.UTC(2026, 10, 13, 14)]]);
    const [one, two] = await repos.sessions.all();
    assert.equal(one.hash, 'f'.repeat(64));
    assert.equal(one.lastSeenAt, Date.UTC(2026, 10, 13, 12));
    assert.equal(two.lastSeenAt, Date.UTC(2026, 10, 13, 13));
    assert.deepEqual(await repos.sessions.remove('sess-1'), { changes: 1 });
    assert.deepEqual(await repos.sessions.remove('sess-1'), { changes: 0 });
    assert.deepEqual((await repos.sessions.all()).map((s) => s.id), ['sess-2']);
  });
});

describe('auth state repository', () => {
  test('get / set / setIfAbsent: one JSON value per name', async (t) => {
    let clock = Date.UTC(2026, 10, 13, 9);
    const { db, repos } = await setup(t, { now: () => new Date(clock) });
    assert.equal(await repos.authState.get('local-admin'), undefined);
    await repos.authState.set('local-admin', { lastTotpStep: 10 });
    clock += 60_000;
    await repos.authState.set('local-admin', { lastTotpStep: 12 });
    assert.deepEqual(await repos.authState.get('local-admin'), { lastTotpStep: 12 });
    assert.deepEqual(await db.get('SELECT updated_at FROM auth_state WHERE name = ?', ['local-admin']), { updated_at: '2026-11-13T09:01:00.000Z' });
    assert.deepEqual(await repos.authState.setIfAbsent('local-admin', { lastTotpStep: 1 }), { changes: 0 });
    assert.deepEqual(await repos.authState.get('local-admin'), { lastTotpStep: 12 }, 'the database wins');
    assert.deepEqual(await repos.authState.setIfAbsent('device-key', { key: 'k' }), { changes: 1 });
    assert.deepEqual(await repos.authState.get('device-key'), { key: 'k' });
    assert.deepEqual(await repos.authState.remove('device-key'), { changes: 1 });
    assert.equal(await repos.authState.get('device-key'), undefined);
    assert.deepEqual(await repos.authState.remove('device-key'), { changes: 0 });
  });

  test('npm run forget-browsers removes the known-browser key of DATA_DIR, and only it', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-console-db-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'lab-console.db');
    const db = await openDatabase({ file });
    const repos = createRepositories(db);
    await repos.authState.set('device-key', { key: 'k' });
    await repos.authState.set('local-admin', { lastTotpStep: 3 });
    await db.close();
    const script = path.join(root, 'scripts/forget-browsers.js');
    const run = () => execFileSync(process.execPath, [script], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
    assert.match(run(), /Known browsers forgotten/);
    assert.match(run(), /nothing to forget/);
    const after = await openDatabase({ file });
    t.after(() => after.close());
    const r = createRepositories(after);
    assert.equal(await r.authState.get('device-key'), undefined);
    assert.deepEqual(await r.authState.get('local-admin'), { lastTotpStep: 3 });
  });

  test('a damaged value is an error, not "nothing"', async (t) => {
    const { db, repos } = await setup(t);
    await db.run('INSERT INTO auth_state (name, data, updated_at) VALUES (?, ?, ?)', ['device-key', '{broken', '2026-11-13T09:00:00.000Z']);
    await assert.rejects(repos.authState.get('device-key'), SyntaxError);
  });
});

describe('audit repository', () => {
  const entry = (ts, action, actorId, details = {}, extra = {}) => ({
    ts, action, actor: { id: actorId, username: actorId, name: actorId.toUpperCase(), role: 'student', via: 'oidc' }, details, ...extra,
  });

  test('insert: filter columns of their own, the rest as JSON; entries come back in the shape they were given', async (t) => {
    const { db, repos } = await setup(t);
    const given = entry('2026-11-13T09:00:00.000Z', 'console.open', 'oidc:s1', { bench: 'B4M', device: 'R1' }, { ip: '192.0.2.9' });
    await repos.audit.insert(given);
    const raw = await db.get('SELECT ts, action, actor_id, actor_role, ip, bench, details FROM audit_entries');
    assert.deepEqual(raw, { ts: given.ts, action: 'console.open', actor_id: 'oidc:s1', actor_role: 'student', ip: '192.0.2.9', bench: 'B4M', details: '{"bench":"B4M","device":"R1"}' });
    assert.deepEqual(await repos.audit.query(), [given]);
    // A system actor with no name or role; no ip, no bench
    await repos.audit.insert({ ts: '2026-11-13T09:00:01.000Z', action: 'bench.release.idle', actor: { id: 'system' }, details: {} });
    assert.deepEqual((await repos.audit.query({ limit: 1 }))[0], { ts: '2026-11-13T09:00:01.000Z', action: 'bench.release.idle', actor: { id: 'system' }, details: {} });
    assert.equal(await repos.audit.count(), 2);
    await assert.rejects(repos.audit.insert({ ...given, ts: 'not a time' }), /valid time/);
  });

  test('query: newest first, ties in insertion order reversed; since / until inclusive; actor, bench, actions with dotted prefixes; limit', async (t) => {
    const { repos } = await setup(t);
    await repos.audit.insert(entry('2026-11-13T09:00:00.000Z', 'console.open', 'oidc:s1', { bench: 'B4M' }));
    await repos.audit.insert(entry('2026-11-13T09:00:00.000Z', 'console.control.grant', 'oidc:s2', { bench: 'B4M' }));
    await repos.audit.insert(entry('2026-11-13T10:00:00.000Z', 'consolex.thing', 'oidc:s1', { bench: 'B5' }));
    await repos.audit.insert(entry('2026-11-13T11:00:00.000Z', 'bench.take', 'oidc:s2', { bench: 'B5' }));
    const acts = async (criteria) => (await repos.audit.query(criteria)).map((e) => e.action);
    assert.deepEqual(await acts(), ['bench.take', 'consolex.thing', 'console.control.grant', 'console.open']);
    assert.deepEqual(await acts({ since: '2026-11-13T10:00:00.000Z' }), ['bench.take', 'consolex.thing']);
    assert.deepEqual(await acts({ until: '2026-11-13T10:00:00.000Z' }), ['consolex.thing', 'console.control.grant', 'console.open']);
    assert.deepEqual(await acts({ actorId: 'oidc:s1' }), ['consolex.thing', 'console.open']);
    assert.deepEqual(await acts({ bench: 'B5' }), ['bench.take', 'consolex.thing']);
    assert.deepEqual(await acts({ actions: ['console'] }), ['console.control.grant', 'console.open'], 'never consolex');
    assert.deepEqual(await acts({ actions: ['console.control', 'bench.take'] }), ['bench.take', 'console.control.grant']);
    assert.deepEqual(await acts({ actions: [] }), []);
    assert.deepEqual(await acts({ limit: 2 }), ['bench.take', 'consolex.thing']);
    assert.deepEqual(await acts({ actorId: 'oidc:s2', bench: 'B4M', actions: ['console'] }), ['console.control.grant']);
  });

  test('the filters have their indexes', async (t) => {
    const { db } = await setup(t);
    // Asked through the portable interface: creating them again fails because migration 003 made them
    for (const name of ['audit_entries_ts', 'audit_entries_actor', 'audit_entries_action', 'audit_entries_bench']) {
      await assert.rejects(db.run(`CREATE INDEX ${name} ON audit_entries (ts)`), /already exists/, name);
    }
  });
});

describe('settings repository', () => {
  test('all / get / save / remove, with who saved and when', async (t) => {
    const { db, repos } = await setup(t, { now: () => new Date('2026-11-13T09:00:00Z') });
    assert.deepEqual(await repos.settings.all(), {});
    assert.equal(await repos.settings.get('lab'), undefined);
    await repos.settings.save('lab', { ssh: { port: 2222 } }, 'local:root');
    await repos.settings.save('lab', { ssh: { port: 2200 } }, 'local:root');
    await repos.settings.save('mail', { from: 'x@example.org' });
    assert.deepEqual(await repos.settings.all(), { lab: { ssh: { port: 2200 } }, mail: { from: 'x@example.org' } });
    assert.deepEqual(await repos.settings.get('lab'), { ssh: { port: 2200 } });
    assert.deepEqual(await db.query('SELECT namespace, updated_at, updated_by FROM settings ORDER BY namespace'), [
      { namespace: 'lab', updated_at: '2026-11-13T09:00:00.000Z', updated_by: 'local:root' },
      { namespace: 'mail', updated_at: '2026-11-13T09:00:00.000Z', updated_by: null },
    ]);
    assert.deepEqual(await repos.settings.remove('lab'), { changes: 1 });
    assert.deepEqual(Object.keys(await repos.settings.all()), ['mail']);
  });
});

describe('legacy imports repository, and repositories in a transaction', () => {
  test('has / record', async (t) => {
    const { repos } = await setup(t);
    assert.equal(await repos.legacyImports.has('auth/sessions.json'), false);
    await repos.legacyImports.record('auth/sessions.json', { records: 3, skipped: 1 });
    assert.equal(await repos.legacyImports.has('auth/sessions.json'), true);
    await assert.rejects(repos.legacyImports.record('auth/sessions.json', {}), { code: 'db.unique' });
  });

  test('repos.transaction: every repository inside works on the transaction, rolled back together', async (t) => {
    const { repos } = await setup(t);
    await assert.rejects(repos.transaction(async (r) => {
      await r.settings.save('lab', { a: 1 });
      await r.authState.set('local-admin', { lastTotpStep: 1 });
      await r.sessions.insert(session());
      throw new Error('undo');
    }), /undo/);
    assert.deepEqual(await repos.settings.all(), {});
    assert.equal(await repos.authState.get('local-admin'), undefined);
    assert.deepEqual(await repos.sessions.all(), []);
    await repos.transaction(async (r) => {
      await r.sessions.insert(session());
      await r.sessions.touchAll([['sess-1', Date.UTC(2026, 10, 13, 12)]]); // nested: a savepoint
    });
    assert.equal((await repos.sessions.all())[0].lastSeenAt, Date.UTC(2026, 10, 13, 12));
  });
});
