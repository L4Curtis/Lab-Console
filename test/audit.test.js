/**
 * Audit trail (src/lib/audit.js): entries are recorded with who / what /
 * when, can be queried, and recording never breaks the action it records
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAudit } from '../src/lib/audit.js';
import { clientIp } from '../src/lib/security.js';
import { memoryDatabase } from './helpers/db.js';
import { student, admin, recordingLogger, fakeRequest } from './helpers/fakes.js';

let memory;
let log;
let clock;
let audit;
beforeEach(async () => {
  memory = await memoryDatabase();
  log = recordingLogger();
  clock = new Date('2026-11-12T10:00:00.000Z');
  audit = createAudit({ repo: memory.repos.audit, logger: log, clientIp: (req) => clientIp(req, false), now: () => new Date(clock) });
});
afterEach(() => memory.close());

/** Every stored entry, oldest first, as callers get them back */
const lines = async () => (await memory.repos.audit.query({ limit: 5000 })).reverse();
const rawRows = () => memory.db.query('SELECT * FROM audit_entries ORDER BY ts, id');

test('log: stores one entry per action', async () => {
  assert.equal(await audit.log(student(1), 'bench.take', { bench: 'B4M' }), true);
  assert.equal(await audit.log(admin(), 'console.control.grant', { bench: 'B4M', device: 'R1', to: 'oidc:student1' }), true);
  const [first, second] = await lines();
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
  const [byRequest, bySystem, byNobody] = await lines();
  assert.equal(byRequest.actor.id, 'oidc:student2');
  assert.equal(byRequest.ip, '192.168.10.20');
  assert.equal(bySystem.actor.id, 'system');
  assert.equal(bySystem.ip, undefined);
  assert.equal(byNobody.actor.id, 'unknown', 'a request without a session is still recorded');
  assert.equal(byNobody.ip, '192.168.10.99');
});

test('log: the indexed columns are filled from the entry', async () => {
  await audit.log(fakeRequest({ user: student(2), remoteAddress: '192.168.10.20' }), 'console.open', { bench: 'B4M', device: 'S1' });
  await audit.log('system', 'bench.release.idle', { bench: 42 });
  const [open, idle] = await rawRows();
  assert.equal(open.ts, '2026-11-12T10:00:00.000Z');
  assert.equal(open.action, 'console.open');
  assert.equal(open.actor_id, 'oidc:student2');
  assert.equal(open.bench, 'B4M');
  assert.equal(open.ip, '192.168.10.20');
  assert.deepEqual(JSON.parse(open.details), { bench: 'B4M', device: 'S1' });
  assert.match(open.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a UUID v7');
  assert.equal(idle.bench, null, 'only a text bench is indexed');
  assert.equal(idle.ip, null);
});

test('log: credentials never reach the file, even when a caller passes them by mistake', async () => {
  await audit.log(student(1), 'job.reset.start', {
    bench: 'B4M', enablePassword: 'cisco', nested: { token: 'abc', list: [{ secret: 's3' }] }, totp: '123456', devices: ['R1'],
  });
  const text = JSON.stringify(await rawRows());
  for (const leaked of ['cisco', 'abc', 's3', '123456']) assert.equal(text.includes(leaked), false, leaked);
  assert.deepEqual((await lines())[0].details, {
    bench: 'B4M', enablePassword: '[redacted]', nested: { token: '[redacted]', list: [{ secret: '[redacted]' }] }, totp: '[redacted]', devices: ['R1'],
  });
});

test('log: oversized details are cut down, the bench and device are kept', async () => {
  await audit.log(student(1), 'job.inject.start', { bench: 'B4M', device: 'R1', script: 'x'.repeat(100_000) });
  assert.deepEqual((await lines())[0].details, { bench: 'B4M', device: 'R1', truncated: true });
});

test('log: a failing write never throws into the caller, and never rejects', async () => {
  const broken = createAudit({
    repo: { insert: () => Promise.reject(new Error('SQLITE_FULL: database or disk is full')) },
    logger: log,
  });
  let outcome;
  assert.doesNotThrow(() => { outcome = broken.log(student(1), 'bench.take', { bench: 'B4M' }); });
  assert.equal(await outcome, false);
  assert.match(log.lines.at(-1).message, /audit entry lost \(bench\.take by oidc:student1\): SQLITE_FULL/);
  assert.equal(log.lines.at(-1).level, 'error');
});

test('log: nothing a caller passes can make it throw', async () => {
  const exploding = createAudit({ repo: { insert() { throw new Error('database is gone'); } }, logger: log });
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
  const mute = createAudit({ repo: { insert() { throw new Error('x'); } }, logger: { warn() { throw new Error('y'); }, error() { throw new Error('z'); } } });
  assert.equal(await mute.log('system', 'bench.take', {}), false);
});

test('log: a badly named action is recorded anyway, with a warning for the developer', async () => {
  assert.equal(await audit.log(student(1), 'Took the bench', { bench: 'B4M' }), true);
  assert.equal((await lines()).length, 1);
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

test('query: newest first, across months', async () => {
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

test('query: times may be Dates or milliseconds; one that is not a date is ignored; limits are bounded', async () => {
  await seed();
  assert.deepEqual(actions(await audit.query({ since: new Date(Date.UTC(2026, 10, 3)) })), ['bench.release.idle', 'console.open', 'job.reset.start']);
  assert.deepEqual(actions(await audit.query({ until: Date.UTC(2026, 9, 31, 12) })), ['bench.take', 'bench.take']);
  assert.equal((await audit.query({ since: 'not a date' })).length, 7);
  assert.equal((await audit.query({ limit: 'many' })).length, 0);
  assert.deepEqual(await audit.query({ action: [] }), [], 'an empty list of actions selects nothing');
});

test('query: entries recorded in the same millisecond come back newest first', async () => {
  for (const n of [1, 2, 3, 4, 5]) await audit.log(student(n), 'bench.take', { bench: 'B4M' });
  assert.deepEqual((await audit.query()).map((e) => e.actor.id), [5, 4, 3, 2, 1].map((n) => `oidc:student${n}`));
});

test('query: an action that looks like a pattern is matched literally', async () => {
  await audit.log(student(1), 'bench.take', {});
  await audit.log(student(1), 'benchXtake.now', {});
  assert.deepEqual(actions(await audit.query({ action: 'bench_take' })), []);
  assert.deepEqual(actions(await audit.query({ action: 'bench%' })), []);
  assert.deepEqual(actions(await audit.query({ action: 'bench' })), ['bench.take']);
});
