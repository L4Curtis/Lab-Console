/**
 * Audit trail (src/lib/audit.js): entries are appended with who / what /
 * when, can be queried, and recording never breaks the action it records
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../src/lib/store.js';
import { createAudit } from '../src/lib/audit.js';
import { clientIp } from '../src/lib/security.js';
import { tempDataDir } from './helpers/app.js';
import { student, admin, recordingLogger, fakeRequest } from './helpers/fakes.js';

let dir;
let store;
let log;
let clock;
let audit;
beforeEach(() => {
  dir = tempDataDir();
  store = createStore(dir);
  log = recordingLogger();
  clock = new Date('2026-11-12T10:00:00.000Z');
  audit = createAudit({ store, logger: log, clientIp: (req) => clientIp(req, false), now: () => new Date(clock) });
});
afterEach(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const lines = (month) => fs.readFileSync(store.resolve('audit', `${month}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('log: appends one line per action to the month file', async () => {
  assert.equal(await audit.log(student(1), 'bench.take', { bench: 'B4M' }), true);
  assert.equal(await audit.log(admin(), 'console.control.grant', { bench: 'B4M', device: 'R1', to: 'oidc:student1' }), true);
  const [first, second] = lines('2026-11');
  assert.deepEqual(first, {
    ts: '2026-11-12T10:00:00.000Z',
    action: 'bench.take',
    actor: { id: 'oidc:student1', username: 'student1', name: 'Student 1', role: 'student', via: 'oidc' },
    details: { bench: 'B4M' },
  });
  assert.equal(second.action, 'console.control.grant');
  assert.equal(second.actor.role, 'admin');
  assert.equal(second.details.device, 'R1');
});

test('log: the actor may be a request, a user or the system', async () => {
  await audit.log(fakeRequest({ user: student(2), remoteAddress: '::ffff:192.168.10.20' }), 'console.open', { bench: 'B4M', device: 'S1' });
  await audit.log('system', 'bench.release.idle', { bench: 'B4M' });
  await audit.log(fakeRequest({ remoteAddress: '192.168.10.99' }), 'auth.login.failed', {});
  const [byRequest, bySystem, byNobody] = lines('2026-11');
  assert.equal(byRequest.actor.id, 'oidc:student2');
  assert.equal(byRequest.ip, '192.168.10.20');
  assert.equal(bySystem.actor.id, 'system');
  assert.equal(bySystem.ip, undefined);
  assert.equal(byNobody.actor.id, 'unknown', 'a request without a session is still recorded');
  assert.equal(byNobody.ip, '192.168.10.99');
});

test('log: one file per month', async () => {
  await audit.log('system', 'job.backup.start', { bench: 'B4M' });
  clock = new Date('2026-12-01T00:00:01.000Z');
  await audit.log('system', 'job.backup.start', { bench: 'B4M' });
  assert.deepEqual(fs.readdirSync(store.resolve('audit')).sort(), ['2026-11.jsonl', '2026-12.jsonl']);
});

test('log: credentials never reach the file, even when a caller passes them by mistake', async () => {
  await audit.log(student(1), 'job.reset.start', {
    bench: 'B4M', enablePassword: 'cisco', nested: { token: 'abc', list: [{ secret: 's3' }] }, totp: '123456', devices: ['R1'],
  });
  const text = fs.readFileSync(store.resolve('audit', '2026-11.jsonl'), 'utf8');
  for (const leaked of ['cisco', 'abc', 's3', '123456']) assert.equal(text.includes(leaked), false, leaked);
  assert.deepEqual(lines('2026-11')[0].details, {
    bench: 'B4M', enablePassword: '[redacted]', nested: { token: '[redacted]', list: [{ secret: '[redacted]' }] }, totp: '[redacted]', devices: ['R1'],
  });
});

test('log: oversized details are cut down, the bench and device are kept', async () => {
  await audit.log(student(1), 'job.inject.start', { bench: 'B4M', device: 'R1', script: 'x'.repeat(100_000) });
  assert.deepEqual(lines('2026-11')[0].details, { bench: 'B4M', device: 'R1', truncated: true });
});

test('log: a failing write never throws into the caller, and never rejects', async () => {
  const broken = createAudit({
    store: { jsonl: () => ({ append: () => Promise.reject(new Error('ENOSPC: no space left on device')) }) },
    logger: log,
  });
  let outcome;
  assert.doesNotThrow(() => { outcome = broken.log(student(1), 'bench.take', { bench: 'B4M' }); });
  assert.equal(await outcome, false);
  assert.match(log.lines.at(-1).message, /audit entry lost \(bench\.take by oidc:student1\): ENOSPC/);
  assert.equal(log.lines.at(-1).level, 'error');
});

test('log: nothing a caller passes can make it throw', async () => {
  const exploding = createAudit({ store: { jsonl() { throw new Error('store is gone'); } }, logger: log });
  const circular = {};
  circular.self = circular;
  const getter = { get bench() { throw new Error('boom'); } };
  for (const call of [
    () => exploding.log(student(1), 'bench.take', {}),
    () => audit.log(undefined, undefined, undefined),
    () => audit.log(student(1), 'bench.take', circular),
    () => audit.log(student(1), 'bench.take', getter),
    () => audit.log({}, 'bench.take', null),
    () => audit.log(student(1), 'bench.take', { big: 10n }),
  ]) {
    let outcome;
    assert.doesNotThrow(() => { outcome = call(); });
    assert.equal(typeof await outcome, 'boolean');
  }
  // …even when the logger itself is broken
  const mute = createAudit({ store: { jsonl() { throw new Error('x'); } }, logger: { warn() { throw new Error('y'); }, error() { throw new Error('z'); } } });
  assert.equal(await mute.log('system', 'bench.take', {}), false);
});

test('log: a badly named action is recorded anyway, with a warning for the developer', async () => {
  assert.equal(await audit.log(student(1), 'Took the bench', { bench: 'B4M' }), true);
  assert.equal(lines('2026-11').length, 1);
  assert.match(log.lines.find((l) => l.level === 'warn').message, /not module\.verb/);
});

async function seed() {
  const day = (d, h = 10) => { clock = new Date(Date.UTC(2026, 9, d, h)); }; // October 2026 onwards
  day(30); await audit.log(student(1), 'bench.take', { bench: 'B4M' });
  day(31); await audit.log(student(2), 'bench.take', { bench: 'B2M' });
  day(32); await audit.log(student(1), 'console.open', { bench: 'B4M', device: 'R1' });      // 1 November
  day(33); await audit.log(student(1), 'console.control.grant', { bench: 'B4M', device: 'R1' });
  day(34); await audit.log(admin(), 'job.reset.start', { bench: 'B4M' });
  day(35); await audit.log(student(2), 'console.open', { bench: 'B2M', device: 'S1' });
  day(62); await audit.log('system', 'bench.release.idle', { bench: 'B4M' });                // 1 December
}
const actions = (entries) => entries.map((e) => e.action);

test('query: newest first, across month files', async () => {
  await seed();
  const all = await audit.query();
  assert.deepEqual(actions(all), ['bench.release.idle', 'console.open', 'job.reset.start', 'console.control.grant', 'console.open', 'bench.take', 'bench.take']);
  assert.deepEqual(actions(await audit.query({ limit: 3 })), ['bench.release.idle', 'console.open', 'job.reset.start']);
  assert.deepEqual(await audit.query({ limit: 0 }), []);
});

test('query: filters by time, actor, action and bench', async () => {
  await seed();
  assert.deepEqual(actions(await audit.query({ since: '2026-11-03T00:00:00Z' })), ['bench.release.idle', 'console.open', 'job.reset.start']);
  assert.deepEqual(actions(await audit.query({ since: '2026-10-31T00:00:00Z', until: '2026-11-01T23:59:59Z' })), ['console.open', 'bench.take']);
  assert.deepEqual(actions(await audit.query({ actorId: 'oidc:student2' })), ['console.open', 'bench.take']);
  assert.deepEqual(actions(await audit.query({ action: 'console' })), ['console.open', 'console.control.grant', 'console.open'], 'a prefix selects the whole module');
  assert.deepEqual(actions(await audit.query({ action: 'console.open' })), ['console.open', 'console.open']);
  assert.deepEqual(actions(await audit.query({ action: ['bench.take', 'job'] })), ['job.reset.start', 'bench.take', 'bench.take']);
  assert.deepEqual(actions(await audit.query({ action: 'con' })), [], 'a prefix stops at a dot');
  assert.deepEqual(actions(await audit.query({ bench: 'B2M' })), ['console.open', 'bench.take']);
  assert.deepEqual(actions(await audit.query({ bench: 'B4M', actorId: 'oidc:student1', action: 'console', limit: 1 })), ['console.control.grant']);
  assert.deepEqual(await audit.query({ actorId: 'oidc:nobody' }), []);
});

test('query: an empty trail is an empty list', async () => {
  assert.deepEqual(await audit.query(), []);
  assert.deepEqual(await audit.query({ since: 'not a date', bench: 'B4M' }), []);
});
