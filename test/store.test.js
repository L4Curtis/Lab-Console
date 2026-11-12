/**
 * The data directory (src/lib/store.js): paths that cannot escape it, JSON
 * documents that are never half-written, updates that never overlap
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStore, StoreError, safeName, writeFileAtomic } from '../src/lib/store.js';
import { tempDataDir } from './helpers/app.js';

let dir;
let store;
beforeEach(() => { dir = tempDataDir(); store = createStore(dir); });
afterEach(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const unsafe = (fn) => assert.throws(fn, (err) => err instanceof StoreError && err.code === 'store.path');

test('resolve: stays inside the data directory', () => {
  assert.equal(store.resolve('snapshots', 'B4M', '2026-11-12-tp3'), path.join(dir, 'snapshots', 'B4M', '2026-11-12-tp3'));
  assert.equal(store.resolve('benches/occupancy.json'), path.join(dir, 'benches', 'occupancy.json'));
  assert.equal(store.resolve('journal', 'Baie 4 (étage)'), path.join(dir, 'journal', 'Baie 4 (étage)'));
});

test('resolve: path traversal is refused, whatever the disguise', () => {
  for (const bad of ['..', '../etc', '../../etc/passwd', 'a/../../b', '/etc/passwd', 'a//b', './a', 'a/./b', '']) unsafe(() => store.resolve(bad));
  // A variable segment is ONE name: it may not smuggle a separator
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '.', '', '.hidden', 'x\0y', 'line\nbreak', ' padded ', 'x'.repeat(300)]) {
    unsafe(() => store.resolve('snapshots', bad));
    unsafe(() => store.dir('snapshots', bad));
    unsafe(() => store.json(['snapshots', bad]));
    unsafe(() => store.jsonl(['snapshots', bad]));
  }
  unsafe(() => store.resolve());
  unsafe(() => store.resolve('snapshots', 42));
  unsafe(() => store.resolve('snapshots', null));
  assert.deepEqual(fs.readdirSync(dir), [], 'a refused path creates nothing');
});

test('dir: creates the directory and returns its path', () => {
  const made = store.dir('journal', 'B4M', 'R1');
  assert.equal(made, path.join(dir, 'journal', 'B4M', 'R1'));
  assert.ok(fs.statSync(made).isDirectory());
  assert.equal(store.dir('journal', 'B4M', 'R1'), made, 'idempotent');
});

test('safeName: any label becomes a name resolve() accepts', () => {
  assert.equal(safeName('Baie 4 (étage)'), 'Baie_4_etage');
  assert.equal(safeName('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeName('  '), 'unnamed');
  assert.equal(safeName('...'), 'unnamed');
  assert.equal(safeName(null, 'device'), 'device');
  for (const label of ['../../x', 'a/b\\c', '.env', 'R1 (2911) / S0/0/0', 'é'.repeat(500), '\0']) {
    assert.doesNotThrow(() => store.resolve('journal', safeName(label)), label);
  }
});

test('json: fallback, set, get, and a private copy on every read', async () => {
  const doc = store.json('benches/occupancy.json', { benches: {} });
  assert.deepEqual(doc.get(), { benches: {} });
  assert.equal(fs.existsSync(doc.path), false, 'reading does not create the file');

  await doc.set({ benches: { B4M: ['oidc:1'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(doc.path, 'utf8')), { benches: { B4M: ['oidc:1'] } });

  const copy = doc.get();
  copy.benches.B4M.push('oidc:2');
  assert.deepEqual(doc.get(), { benches: { B4M: ['oidc:1'] } }, 'changing what get() returned changes nothing');
  assert.equal(store.json('benches/occupancy.json'), doc, 'one handle per file, so updates are serialized across modules');
});

test('json: a new store reads what the previous one wrote', async () => {
  await store.json('admin/announcements.json', []).set([{ text: 'TP at 14:00' }]);
  const again = createStore(dir);
  assert.deepEqual(again.json('admin/announcements.json', []).get(), [{ text: 'TP at 14:00' }]);
});

test('json: the write is atomic - a reader never sees a partial file, no temporary file is left', async () => {
  const doc = store.json('big.json', {});
  const big = { rows: Array.from({ length: 20_000 }, (_, i) => ({ i, text: 'x'.repeat(40) })) };
  await doc.set({ rows: [] });

  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const parsed = JSON.parse(fs.readFileSync(doc.path, 'utf8')); // throws on a half-written file
      assert.ok(parsed.rows.length === 0 || parsed.rows.length === 20_000);
      reads += 1;
      await sleep(0);
    }
  })();
  for (let i = 0; i < 5; i++) { await doc.set(big); await doc.set({ rows: [] }); }
  stop = true;
  await reader;
  assert.ok(reads > 0);
  assert.deepEqual(fs.readdirSync(dir), ['big.json']);
});

test('json: a failed write changes nothing, on disk or in memory', async () => {
  const doc = store.json('state.json', { n: 0 });
  await doc.set({ n: 1 });
  const circular = {};
  circular.self = circular;
  await assert.rejects(doc.set(circular));
  await assert.rejects(doc.set(undefined), (err) => err.code === 'store.value');
  await assert.rejects(doc.update(() => { throw new Error('changed my mind'); }), /changed my mind/);
  assert.deepEqual(doc.get(), { n: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(doc.path, 'utf8')), { n: 1 });
  await doc.set({ n: 2 }); // and the queue is not stuck
  assert.deepEqual(doc.get(), { n: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('json: concurrent updates are serialized - none is lost', async () => {
  const doc = store.json('counter.json', { n: 0, order: [] });
  let running = 0;
  let overlap = false;
  const bump = (i) => doc.update(async (draft) => {
    running += 1;
    if (running > 1) overlap = true;
    await sleep(i % 3); // an async update keeps the document for itself
    draft.n += 1;
    draft.order.push(i);
    running -= 1;
  });
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => bump(i)));
  assert.equal(overlap, false);
  assert.equal(doc.get().n, 40);
  assert.deepEqual(doc.get().order, Array.from({ length: 40 }, (_, i) => i), 'in the order they were asked');
  assert.equal(results[39].n, 40, 'update resolves with the stored value');
  assert.equal(JSON.parse(fs.readFileSync(doc.path, 'utf8')).n, 40);
});

test('json: update may return a new value instead of changing the draft', async () => {
  const doc = store.json('list.json', []);
  await doc.update((list) => [...list, 'a']);
  await doc.update((list) => [...list, 'b']);
  assert.deepEqual(doc.get(), ['a', 'b']);
});

test('json: a corrupt file is set aside, not overwritten silently', async () => {
  fs.mkdirSync(path.join(dir, 'collab'));
  fs.writeFileSync(path.join(dir, 'collab', 'notes.json'), '{ "half": ');
  const errors = [];
  const noisy = createStore(dir, { logger: { info() {}, warn() {}, error: (m) => errors.push(m) } });
  const doc = noisy.json('collab/notes.json', {});
  assert.deepEqual(doc.get(), {});
  assert.equal(errors.length, 1);
  const kept = fs.readdirSync(path.join(dir, 'collab')).filter((f) => f.startsWith('notes.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'collab', kept[0]), 'utf8'), '{ "half": ');
});

test('jsonl: append then read, in order', async () => {
  const log = store.jsonl('collab/chat/B4M.jsonl');
  assert.deepEqual(await log.read(), [], 'a log that does not exist yet is empty');
  await Promise.all([1, 2, 3, 4, 5].map((n) => log.append({ n })));
  assert.deepEqual((await log.read()).map((e) => e.n), [1, 2, 3, 4, 5]);
  assert.equal(fs.readFileSync(log.path, 'utf8').split('\n').length, 6, 'one line per entry');
  assert.equal(store.jsonl('collab/chat/B4M.jsonl'), log);
});

test('jsonl: limit keeps the most recent, since / until / filter select', async () => {
  const log = store.jsonl('audit/2026-11.jsonl');
  for (let day = 1; day <= 9; day++) await log.append({ ts: `2026-11-0${day}T10:00:00.000Z`, day, even: day % 2 === 0 });
  assert.deepEqual((await log.read({ limit: 3 })).map((e) => e.day), [7, 8, 9]);
  assert.deepEqual((await log.read({ since: '2026-11-07T00:00:00Z' })).map((e) => e.day), [7, 8, 9]);
  assert.deepEqual((await log.read({ since: new Date('2026-11-03T00:00:00Z'), until: Date.parse('2026-11-05T23:00:00Z') })).map((e) => e.day), [3, 4, 5]);
  assert.deepEqual((await log.read({ filter: (e) => e.even, limit: 2 })).map((e) => e.day), [6, 8]);
  assert.deepEqual(await log.read({ limit: 0 }), []);
});

test('jsonl: a torn line (crash in the middle of a write) is skipped, the rest is read', async () => {
  const log = store.jsonl('journal.jsonl');
  await log.append({ n: 1 });
  fs.appendFileSync(log.path, '{"n": 2, "tor');
  fs.appendFileSync(log.path, '\n');
  await log.append({ n: 3 });
  assert.deepEqual((await log.read()).map((e) => e.n), [1, 3]);
});

test('writeFileAtomic: replaces the content, cleans up when it fails', async () => {
  const file = store.resolve('diagrams', 'current.drawio');
  store.dir('diagrams');
  await writeFileAtomic(file, '<v1/>');
  await writeFileAtomic(file, '<v2/>');
  assert.equal(fs.readFileSync(file, 'utf8'), '<v2/>');
  await assert.rejects(writeFileAtomic(path.join(dir, 'missing-dir', 'x'), 'data'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'diagrams')), ['current.drawio']);
});

test('createStore: an unusable DATA_DIR fails at start-up, with its path', () => {
  const file = path.join(dir, 'not-a-directory');
  fs.writeFileSync(file, '');
  assert.throws(() => createStore(path.join(file, 'data')), (err) => err.code === 'store.unwritable' && err.message.includes(file));
});

test('files are private to the service account', async () => {
  await store.json('auth/sessions.json', {}).set({ a: 1 });
  await store.jsonl('audit/2026-11.jsonl').append({ a: 1 });
  assert.equal(fs.statSync(store.resolve('auth/sessions.json')).mode & 0o077, 0);
  assert.equal(fs.statSync(store.resolve('audit/2026-11.jsonl')).mode & 0o077, 0);
  assert.equal(fs.statSync(store.resolve('auth')).mode & 0o077, 0);
});
