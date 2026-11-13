/**
 * The console journal on its own: one file per console session plus its
 * sidecar, the size cap per device and day, who may read a session (the
 * people who were on it, the team that held the bench during it, admins),
 * and the retention sweep
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConsoleJournal, dayOf } from '../src/modules/consoles/journal.js';
import { createStore } from '../src/lib/store.js';
import { silentLogger, tempDataDir } from './helpers/app.js';

const user = (id, role = 'student') => ({ id: `oidc:${id}`, username: id, name: id, role });

/** The sessions of a device's day: [{ name, log, meta }] */
function sessions(dir, bench, device, day) {
  const base = path.join(dir, 'journal', bench, device, day);
  return fs.readdirSync(base).filter((f) => f.endsWith('.json')).sort((x, y) => x.slice(0, -5).localeCompare(y.slice(0, -5), 'en', { numeric: true })).map((f) => {
    const name = f.slice(0, -5);
    const log = path.join(base, `${name}.log`);
    return { name, logPath: log, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', meta: JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')), metaPath: path.join(base, f) };
  });
}

function setup(extra = {}) {
  const dir = tempDataDir();
  const store = createStore(dir, { logger: silentLogger() });
  const clock = { ms: new Date(2026, 10, 13, 10, 0, 0).getTime() };
  const journal = new ConsoleJournal({ store, now: () => clock.ms, logger: silentLogger(), ...extra });
  const cleanup = async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, clock, journal, cleanup };
}

test('journal: output, markers and the people of the session, in a file and its sidecar; a device name is made safe', async () => {
  const { dir, journal, cleanup } = setup({ teamOf: (bench) => (bench === 'B4M' ? 'team-7' : null) });
  try {
    const w = journal.open({ bench: 'B4M', device: 'R1/WAN', target: '10.22.9.211:2001' });
    w.attended(user('alice'));
    w.attended(user('alice'));
    w.piloted(user('alice'));
    w.output(Buffer.from('R1>show clock\r\n*10:00:00.000 UTC Fri Nov 13 2026\r\nR1>'));
    w.mark('keyboard: alice');
    await w.close();
    const [s, ...more] = sessions(dir, 'B4M', 'R1_WAN', '2026-11-13');
    assert.equal(more.length, 0);
    assert.equal(s.name, '100000', 'named after its start');
    assert.match(s.log, /R1>show clock/);
    assert.match(s.log, /--- 2026-11-13 10:00:00 keyboard: alice ---/);
    assert.equal(s.meta.device, 'R1/WAN', 'the real name is kept inside');
    assert.deepEqual(Object.keys(s.meta.attended), ['oidc:alice']);
    assert.deepEqual(Object.keys(s.meta.pilots), ['oidc:alice']);
    assert.deepEqual(s.meta.teams, ['team-7']);
    assert.equal(s.meta.bytes, Buffer.byteLength(s.log));
    assert.equal(s.meta.started, new Date(2026, 10, 13, 10, 0, 0).toISOString());
    assert.equal(s.meta.ended, new Date(2026, 10, 13, 10, 0, 0).toISOString());
    assert.equal(fs.statSync(s.metaPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.logPath).mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});

test('journal: who may read a session', async () => {
  const { journal, cleanup } = setup();
  await cleanup();
  const meta = { attended: { 'oidc:alice': {} }, pilots: { 'oidc:bob': {} }, teams: ['team-7'] };
  const teamOf = (u) => (u.id === 'oidc:chloe' ? 'team-7' : null);
  assert.equal(journal.canRead(user('alice'), meta, teamOf), true, 'was there');
  assert.equal(journal.canRead(user('bob'), meta, teamOf), true, 'held the keyboard');
  assert.equal(journal.canRead(user('chloe'), meta, teamOf), true, 'the team that held the bench');
  assert.equal(journal.canRead(user('dan'), meta, teamOf), false, 'someone else');
  assert.equal(journal.canRead(user('root', 'admin'), meta, teamOf), true, 'an admin');
  assert.equal(journal.canRead(null, meta), false);
  assert.equal(journal.canRead(user('alice'), null), false);
});

test('journal: one device\'s day stops at its size cap, says so once, and starts again the next day', async () => {
  const { dir, clock, journal, cleanup } = setup({ maxBytesPerDay: 1000 });
  try {
    const w0 = journal.open({ bench: 'B4M', device: 'S1', target: 't' });
    w0.output(Buffer.from(`${'x'.repeat(399)}\n`));
    await w0.close();
    // A second session of the same day shares the day's cap
    clock.ms += 60_000;
    const w = journal.open({ bench: 'B4M', device: 'S1', target: 't' });
    for (let i = 0; i < 30; i++) w.output(Buffer.from(`${'x'.repeat(99)}\n`));
    await w.close();
    const day1 = sessions(dir, 'B4M', 'S1', '2026-11-13');
    assert.deepEqual(day1.map((s) => s.name), ['100000', '100100']);
    assert.equal(day1[1].log.match(/x+\n/g).join('').length, 600, 'exactly the rest of the cap');
    assert.equal(day1[1].log.match(/journal stopped: size limit/g).length, 1);
    assert.equal(day1[1].meta.truncated, true);
    assert.equal(day1[0].meta.truncated, false);

    clock.ms += 86_400_000;
    const w2 = journal.open({ bench: 'B4M', device: 'S1', target: 't' });
    w2.output(Buffer.from('S1>'));
    await w2.close();
    assert.equal(sessions(dir, 'B4M', 'S1', '2026-11-14')[0].log, 'S1>');
  } finally {
    await cleanup();
  }
});

test('journal: the daily sweep removes the days past the retention, then the empty folders', async () => {
  const { dir, clock, journal, cleanup } = setup({ retentionDays: 14 });
  try {
    for (const daysAgo of [20, 14, 13, 0]) {
      const at = clock.ms - daysAgo * 86_400_000;
      const j = new ConsoleJournal({ store: journal.store, now: () => at, logger: silentLogger() });
      const w = j.open({ bench: daysAgo === 20 ? 'B6H' : 'B4M', device: 'R1', target: 't' });
      w.attended(user('alice'));
      w.output(Buffer.from(`day -${daysAgo}`));
      await w.close();
    }
    assert.equal(journal.list().length, 4);
    assert.equal(journal.sweep(), 2, 'two days (one session each) are older than 14 days (today counts)');
    const left = journal.list().map((d) => d.day);
    assert.deepEqual(left, [dayOf(clock.ms), dayOf(clock.ms - 13 * 86_400_000)]);
    assert.equal(fs.existsSync(path.join(dir, 'journal', 'B6H')), false, 'an emptied bench folder goes too');
    assert.equal(journal.sweep(), 0);
  } finally {
    await cleanup();
  }
});

test('journal: a day or session name that is not one is refused before any path is built', async () => {
  const { journal, cleanup } = setup();
  try {
    assert.throws(() => journal.paths('B4M', 'R1', '../../etc', '100000'), { code: 'store.path' });
    assert.throws(() => journal.paths('B4M', 'R1', '2026-11-13', '../x'), { code: 'store.path' });
    assert.throws(() => journal.paths('..', 'R1', '2026-11-13', '100000'), { code: 'store.path' });
    assert.equal(journal.meta('B4M', 'R1', '2026-11-13', '100000'), null);
  } finally {
    await cleanup();
  }
});

test('journal: read rights cover one session: bob, who watched in the afternoon, cannot read alice\'s morning', async () => {
  const holder = { team: 'team-a' };
  const { dir, clock, journal, cleanup } = setup({ teamOf: () => holder.team });
  try {
    const morning = journal.open({ bench: 'B4M', device: 'R1', target: 't' });
    morning.attended(user('alice'));
    morning.piloted(user('alice'));
    morning.output(Buffer.from('R1#show running-config\r\nenable secret 5 $1$morning\r\n'));
    await morning.close();

    clock.ms = new Date(2026, 10, 13, 17, 0, 0).getTime();
    holder.team = 'team-b';
    const afternoon = journal.open({ bench: 'B4M', device: 'R1', target: 't' });
    afternoon.attended(user('bob'));
    afternoon.output(Buffer.from('R1>'));
    await afternoon.close();

    const list = journal.list();
    assert.deepEqual(list.map((d) => d.session), ['170000', '100000'], 'newest first');
    const teamOf = (u) => ({ 'oidc:alice': 'team-a', 'oidc:bob': 'team-b', 'oidc:chloe': 'team-a', 'oidc:dan': 'team-b' })[u.id] ?? null;
    const readable = (who) => list.filter((d) => journal.canRead(user(who), d.meta, teamOf)).map((d) => d.session);
    assert.deepEqual(readable('bob'), ['170000'], 'bob reads only the session he watched');
    assert.deepEqual(readable('alice'), ['100000']);
    assert.deepEqual(readable('chloe'), ['100000'], 'the team that held the bench in the morning');
    assert.deepEqual(readable('dan'), ['170000'], 'the team that held it in the afternoon');
    assert.deepEqual(readable('root').length, 0);
    assert.equal(list.filter((d) => journal.canRead(user('root', 'admin'), d.meta, teamOf)).length, 2);
    assert.doesNotMatch(sessions(dir, 'B4M', 'R1', '2026-11-13')[1].log, /morning/);
  } finally {
    await cleanup();
  }
});

test('journal: a line driven only by a job names the team; a session past midnight goes on in a new file with its people', async () => {
  const { dir, clock, journal, cleanup } = setup({ teamOf: () => 'team-7' });
  try {
    const job = journal.open({ bench: 'B4M', device: 'R2', target: 't' });
    job.mark('task backup by Lab Console');
    job.output(Buffer.from('R2#'));
    await job.close();
    assert.deepEqual(sessions(dir, 'B4M', 'R2', '2026-11-13')[0].meta.teams, ['team-7'], 'nobody attached, the team is there');

    clock.ms = new Date(2026, 10, 13, 23, 59, 0).getTime();
    const late = journal.open({ bench: 'B4M', device: 'R3', target: 't' });
    late.attended(user('alice'));
    late.output(Buffer.from('before midnight'));
    clock.ms += 120_000;
    late.output(Buffer.from('after midnight'));
    await late.close();
    const [before] = sessions(dir, 'B4M', 'R3', '2026-11-13');
    const [after] = sessions(dir, 'B4M', 'R3', '2026-11-14');
    assert.equal(before.log, 'before midnight');
    assert.equal(after.log, 'after midnight');
    assert.equal(after.name, '000100');
    assert.ok(before.meta.ended, 'the first part says when it ended');
    assert.deepEqual(Object.keys(after.meta.attended), ['oidc:alice'], 'alice is still on it after midnight');
  } finally {
    await cleanup();
  }
});

test('journal: two sessions opened in the same second get their own files', async () => {
  const { dir, journal, cleanup } = setup();
  try {
    const a = journal.open({ bench: 'B4M', device: 'R4', target: 't' });
    a.output(Buffer.from('one'));
    const b = journal.open({ bench: 'B4M', device: 'R4', target: 't' });
    b.output(Buffer.from('two'));
    await Promise.all([a.close(), b.close()]);
    assert.deepEqual(sessions(dir, 'B4M', 'R4', '2026-11-13').map((s) => [s.name, s.log]), [['100000', 'one'], ['100000-2', 'two']]);
  } finally {
    await cleanup();
  }
});
