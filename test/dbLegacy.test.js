/**
 * Import of the files version 2 kept before it had a database
 * (src/lib/db/legacy.js): sessions, the local administrator's last TOTP
 * step, the known-browser key, the audit trail. Each file is imported once,
 * then renamed <name>.imported; never deleted
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../src/lib/store.js';
import { importLegacyFiles } from '../src/lib/db/index.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger, student } from './helpers/fakes.js';
import { tempDataDir, loadTestConfig, silentLogger } from './helpers/app.js';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function dataDir(t) {
  const dir = tempDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
}

const listing = (dir, sub) => fs.readdirSync(path.join(dir, sub)).sort();

const savedUser = ({ id, username, name, email, role, groups, via }) => ({ id, username, name, email, role, groups, via });

/** The legacy files of a data directory, as the file-based version wrote them */
function legacyFiles(dir, { now = Date.now(), token = crypto.randomBytes(32).toString('base64url') } = {}) {
  write(dir, 'auth/sessions.json', {
    version: 1,
    sessions: {
      [sha(token)]: { id: 'pub-1', user: savedUser(student(1)), createdAt: now - 60_000, lastSeenAt: now - 1000, expiresAt: now + 3_600_000, ip: '192.0.2.1', userAgent: 'firefox' },
      [sha('other')]: { id: 'pub-2', user: savedUser(student(2)), createdAt: now - 60_000, lastSeenAt: now, expiresAt: now + 3_600_000, ip: '', userAgent: '', binding: 'b' },
      'not-a-hash': { id: 'pub-3', user: savedUser(student(3)), createdAt: now, lastSeenAt: now, expiresAt: now },
      [sha('no-times')]: { id: 'pub-4', user: savedUser(student(3)) },
    },
  });
  write(dir, 'auth/local-admin.json', { lastTotpStep: 59_000_000 });
  write(dir, 'auth/device-key.json', { key: crypto.randomBytes(32).toString('base64url') });
  const line = (ts, action, actor, details = {}) => JSON.stringify({ ts, action, actor, details });
  write(dir, 'audit/2026-10.jsonl', [
    line('2026-10-30T08:00:00.000Z', 'bench.take', { id: 'oidc:student1', username: 'student1', role: 'student', via: 'oidc' }, { bench: 'B4M' }),
    line('2026-10-31T08:00:00.000Z', 'bench.release.idle', { id: 'system' }, { bench: 'B4M' }),
  ].join('\n') + '\n');
  write(dir, 'audit/2026-11.jsonl', [
    line('2026-11-02T08:00:00.000Z', 'console.open', { id: 'oidc:student2', username: 'student2', role: 'student', via: 'oidc' }, { bench: 'B5', device: 'R1' }),
    '{"ts":"2026-11-02T08:00:01.000Z","action":"no.actor"}',
    '{"ts":"2026-11-02T08:00:02.000Z","action":"console.cl', // torn by a crash
  ].join('\n'));
  write(dir, 'audit/notes.txt', 'not an audit file');
  return { token };
}

describe('importLegacyFiles', () => {
  test('imports every known file once, renames it .imported, counts what it skipped', async (t) => {
    const dir = dataDir(t);
    const { token } = legacyFiles(dir);
    const { repos, close } = await memoryDatabase();
    t.after(close);
    const store = createStore(dir);
    const log = recordingLogger();

    const done = await importLegacyFiles({ store, repos, logger: log });
    assert.deepEqual(done, [
      { path: 'auth/sessions.json', records: 2, skipped: 2 },
      { path: 'auth/local-admin.json', records: 1, skipped: 0 },
      { path: 'auth/device-key.json', records: 1, skipped: 0 },
      { path: 'audit/2026-10.jsonl', records: 2, skipped: 0 },
      { path: 'audit/2026-11.jsonl', records: 1, skipped: 2 },
    ]);
    assert.deepEqual(listing(dir, 'auth'), ['device-key.json.imported', 'local-admin.json.imported', 'sessions.json.imported']);
    assert.deepEqual(listing(dir, 'audit'), ['2026-10.jsonl.imported', '2026-11.jsonl.imported', 'notes.txt']);
    assert.ok(log.lines.some((l) => l.level === 'info' && /auth\/sessions\.json imported .*2 record\(s\), 2 skipped.*sessions\.json\.imported/.test(l.message)));

    const sessions = await repos.sessions.all();
    assert.deepEqual(sessions.map((s) => [s.id, s.user.id, s.binding]), [['pub-1', 'oidc:student1', undefined], ['pub-2', 'oidc:student2', 'b']]);
    assert.equal(sessions[0].hash, sha(token));
    assert.deepEqual(await repos.authState.get('local-admin'), { lastTotpStep: 59_000_000 });
    assert.match((await repos.authState.get('device-key')).key, /^[A-Za-z0-9_-]{43}$/);
    const audit = await repos.audit.query();
    assert.deepEqual(audit.map((e) => e.action), ['console.open', 'bench.release.idle', 'bench.take']);
    assert.deepEqual(audit[0].details, { bench: 'B5', device: 'R1' });
    assert.deepEqual((await repos.audit.query({ bench: 'B4M' })).length, 2, 'the bench column is filled from the details');

    // Nothing left to import: a second run does nothing
    assert.deepEqual(await importLegacyFiles({ store, repos }), []);
    assert.equal((await repos.audit.query()).length, 3);
  });

  test('the database wins over a file for the same value; sessions already present are not duplicated', async (t) => {
    const dir = dataDir(t);
    legacyFiles(dir);
    const { repos, close } = await memoryDatabase();
    t.after(close);
    await repos.authState.set('local-admin', { lastTotpStep: 60_000_000 });
    const done = await importLegacyFiles({ store: createStore(dir), repos });
    assert.deepEqual(done.find((d) => d.path === 'auth/local-admin.json'), { path: 'auth/local-admin.json', records: 0, skipped: 1 });
    assert.deepEqual(await repos.authState.get('local-admin'), { lastTotpStep: 60_000_000 });
  });

  test('a file that cannot be read as what it should be is kept as .not-imported, with an error; the rest goes on', async (t) => {
    const dir = dataDir(t);
    write(dir, 'auth/sessions.json', '{ this is not json');
    write(dir, 'auth/local-admin.json', { lastTotpStep: 'soon' });
    write(dir, 'auth/device-key.json', { key: 'abc' });
    const { repos, close } = await memoryDatabase();
    t.after(close);
    const log = recordingLogger();
    const done = await importLegacyFiles({ store: createStore(dir), repos, logger: log });
    assert.deepEqual(done, [{ path: 'auth/device-key.json', records: 1, skipped: 0 }]);
    assert.deepEqual(listing(dir, 'auth'), ['device-key.json.imported', 'local-admin.json.not-imported', 'sessions.json.not-imported']);
    assert.equal(log.lines.filter((l) => l.level === 'error' && /could not be imported .*kept as/.test(l.message)).length, 2);
  });

  test('a file imported before but not renamed (a crash in between) is renamed, not imported twice; an existing .imported is never replaced', async (t) => {
    const dir = dataDir(t);
    write(dir, 'audit/2026-11.jsonl', `${JSON.stringify({ ts: '2026-11-02T08:00:00.000Z', action: 'bench.take', actor: { id: 'u' }, details: {} })}\n`);
    write(dir, 'audit/2026-11.jsonl.imported', 'an older copy');
    const { repos, close } = await memoryDatabase();
    t.after(close);
    const content = `${JSON.stringify({ ts: '2026-11-02T08:00:00.000Z', action: 'bench.take', actor: { id: 'u' }, details: {} })}\n`;
    await repos.legacyImports.record('audit/2026-11.jsonl', { records: 1 }, sha(content));
    const log = recordingLogger();
    assert.deepEqual(await importLegacyFiles({ store: createStore(dir), repos, logger: log }), []);
    assert.equal(await repos.audit.count(), 0);
    const names = listing(dir, 'audit');
    assert.equal(names.length, 2);
    assert.ok(names.includes('2026-11.jsonl.imported'));
    assert.ok(names.some((n) => /^2026-11\.jsonl\.imported-\d+$/.test(n)), names.join());
    assert.equal(fs.readFileSync(path.join(dir, 'audit/2026-11.jsonl.imported'), 'utf8'), 'an older copy');
    assert.ok(log.lines.some((l) => l.level === 'warn' && /interrupted start/.test(l.message)));
  });

  test('a file that comes back under an imported path with other content is imported: only what the database lacks is added', async (t) => {
    const dir = dataDir(t);
    legacyFiles(dir);
    const { repos, close } = await memoryDatabase();
    t.after(close);
    const store = createStore(dir);
    await importLegacyFiles({ store, repos });
    assert.equal(await repos.audit.count(), 3);
    const sessionsBefore = await repos.sessions.all();

    // Pre-production rolled back to a build without the database, which wrote its files again, then upgraded
    const original = fs.readFileSync(path.join(dir, 'audit/2026-10.jsonl.imported'), 'utf8');
    const extra = JSON.stringify({ ts: '2026-10-31T09:00:00.000Z', action: 'bench.take', actor: { id: 'oidc:carol', username: 'carol' }, details: { bench: 'B4M' } });
    write(dir, 'audit/2026-10.jsonl', `${original}${extra}\n`);
    // The same sessions, written again by the old build (other bytes): none is duplicated
    write(dir, 'auth/sessions.json', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'auth/sessions.json.imported'), 'utf8')), null, 2));
    const log = recordingLogger();
    const done = await importLegacyFiles({ store, repos, logger: log });
    assert.deepEqual(done, [
      { path: 'auth/sessions.json', records: 0, skipped: 4 },
      { path: 'audit/2026-10.jsonl', records: 1, skipped: 2 },
    ]);
    assert.deepEqual((await repos.audit.query({ actorId: 'oidc:carol' })).map((e) => e.ts), ['2026-10-31T09:00:00.000Z']);
    assert.equal(await repos.audit.count(), 4, 'the entries imported before are not duplicated');
    assert.deepEqual(await repos.sessions.all(), sessionsBefore);
    assert.ok(log.lines.some((l) => l.level === 'warn' && /audit\/2026-10\.jsonl was imported before and has come back with different content/.test(l.message)));
    assert.ok(!log.lines.some((l) => /interrupted start/.test(l.message)));
    const names = listing(dir, 'audit');
    assert.ok(names.includes('2026-10.jsonl.imported') && names.some((n) => /^2026-10\.jsonl\.imported-\d+$/.test(n)), names.join());
    assert.ok(!names.includes('2026-10.jsonl'));

    // The same content once more: renamed only
    write(dir, 'audit/2026-10.jsonl', `${original}${extra}\n`);
    assert.deepEqual(await importLegacyFiles({ store, repos, logger: log }), []);
    assert.equal(await repos.audit.count(), 4);
  });

  test('identical lines of one file are all imported, and only once', async (t) => {
    const dir = dataDir(t);
    const line = JSON.stringify({ ts: '2026-11-02T08:00:00.000Z', action: 'bench.take', actor: { id: 'u' }, details: { bench: 'B1' } });
    write(dir, 'audit/2026-11.jsonl', `${line}\n${line}\n`);
    const { repos, close } = await memoryDatabase();
    t.after(close);
    const store = createStore(dir);
    assert.deepEqual(await importLegacyFiles({ store, repos }), [{ path: 'audit/2026-11.jsonl', records: 2, skipped: 0 }]);
    write(dir, 'audit/2026-11.jsonl', `${line}\n${line}\n${line}\n`);
    assert.deepEqual(await importLegacyFiles({ store, repos }), [{ path: 'audit/2026-11.jsonl', records: 1, skipped: 2 }]);
    assert.equal(await repos.audit.count(), 3);
  });

  test('when the database refuses the records, the start stops and the file is left as it is', async (t) => {
    const dir = dataDir(t);
    write(dir, 'auth/local-admin.json', { lastTotpStep: 5 });
    const { repos, close } = await memoryDatabase();
    t.after(close);
    const broken = { ...repos, transaction: () => Promise.reject(new Error('disk full')) };
    await assert.rejects(importLegacyFiles({ store: createStore(dir), repos: broken }), /Importing auth\/local-admin\.json into the database failed: disk full\. The file was left as it is/);
    assert.deepEqual(listing(dir, 'auth'), ['local-admin.json']);
  });
});

test('the application imports the legacy files at its first start: a signed-in student stays signed in', async (t) => {
  const dir = dataDir(t);
  const { token } = legacyFiles(dir);
  const { createApp } = await import('../src/server.js');
  const boot = async () => {
    const app = await createApp({ config: await loadTestConfig({ PUBLIC_URL: 'http://127.0.0.1:1' }, dir), logger: silentLogger });
    const { port } = await app.listen({ port: 0 });
    return { app, url: `http://127.0.0.1:${port}` };
  };
  let run = await boot();
  try {
    assert.ok(fs.existsSync(path.join(dir, 'lab-console.db')));
    assert.equal(fs.statSync(path.join(dir, 'lab-console.db')).mode & 0o077, 0);
    assert.deepEqual(listing(dir, 'auth'), ['device-key.json.imported', 'local-admin.json.imported', 'sessions.json.imported']);
    const me = await fetch(`${run.url}/api/modules`, { headers: { cookie: `lc_sid=${token}` } });
    assert.equal(me.status, 200, 'the imported session is recognised');
    await me.arrayBuffer();
    const entries = await run.app.deps.audit.query({ action: 'bench' });
    assert.deepEqual(entries.map((e) => e.action), ['bench.release.idle', 'bench.take']);
    await run.app.close();

    // A second start finds nothing to import and keeps everything
    run = await boot();
    assert.equal((await run.app.deps.audit.query({ action: 'bench' })).length, 2);
    const again = await fetch(`${run.url}/api/modules`, { headers: { cookie: `lc_sid=${token}` } });
    assert.equal(again.status, 200);
    await again.arrayBuffer();
  } finally {
    await run.app.close();
  }
});

test('the application refuses to start on a database migrated by a newer version, with a clear message', async (t) => {
  const dir = dataDir(t);
  const { openDatabase } = await import('../src/lib/db/index.js');
  const db = await openDatabase({ file: path.join(dir, 'lab-console.db') });
  await db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', ['900', 'later', '2027-01-01T00:00:00.000Z']);
  await db.close();
  write(dir, 'auth/local-admin.json', { lastTotpStep: 1 });
  const { createApp } = await import('../src/server.js');
  const config = await loadTestConfig({ PUBLIC_URL: 'http://127.0.0.1:1' }, dir);
  await assert.rejects(createApp({ config, logger: silentLogger }), /records migration 900-later, which this version of Lab Console does not have/);
  assert.deepEqual(listing(dir, 'auth'), ['local-admin.json'], 'nothing was imported');
});
