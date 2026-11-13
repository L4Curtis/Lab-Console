/**
 * The console journal on its own: one file per device and day plus its
 * sidecar, the size cap, who may read a day (the people who were there, the
 * team that held the bench, admins), and the retention sweep
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConsoleJournal, dayOf } from '../src/modules/consoles/journal.js';
import { createStore } from '../src/lib/store.js';
import { silentLogger, tempDataDir } from './helpers/app.js';

const user = (id, role = 'student') => ({ id: `oidc:${id}`, username: id, name: id, role });

function setup(extra = {}) {
  const dir = tempDataDir();
  const store = createStore(dir, { logger: silentLogger() });
  const clock = { ms: new Date(2026, 10, 13, 10, 0, 0).getTime() };
  const journal = new ConsoleJournal({ store, now: () => clock.ms, logger: silentLogger(), ...extra });
  const cleanup = async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, clock, journal, cleanup };
}

test('journal: output, markers and the people of the day, in a file and its sidecar; a device name is made safe', async () => {
  const { dir, journal, cleanup } = setup({ teamOf: (bench) => (bench === 'B4M' ? 'team-7' : null) });
  try {
    const w = journal.open({ bench: 'B4M', device: 'R1/WAN', target: '10.22.9.211:2001' });
    w.attended(user('alice'));
    w.attended(user('alice'));
    w.piloted(user('alice'));
    w.output(Buffer.from('R1>show clock\r\n*10:00:00.000 UTC Fri Nov 13 2026\r\nR1>'));
    w.mark('keyboard: alice');
    await w.close();
    const base = path.join(dir, 'journal', 'B4M', 'R1_WAN');
    const log = fs.readFileSync(path.join(base, '2026-11-13.log'), 'utf8');
    assert.match(log, /R1>show clock/);
    assert.match(log, /--- 2026-11-13 10:00:00 keyboard: alice ---/);
    const meta = JSON.parse(fs.readFileSync(path.join(base, '2026-11-13.json'), 'utf8'));
    assert.equal(meta.device, 'R1/WAN', 'the real name is kept inside');
    assert.deepEqual(Object.keys(meta.attended), ['oidc:alice']);
    assert.deepEqual(Object.keys(meta.pilots), ['oidc:alice']);
    assert.deepEqual(meta.teams, ['team-7']);
    assert.equal(meta.bytes, Buffer.byteLength(log));
    assert.equal(fs.statSync(path.join(base, '2026-11-13.json')).mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});

test('journal: who may read a day', async () => {
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
    const w = journal.open({ bench: 'B4M', device: 'S1', target: 't' });
    for (let i = 0; i < 30; i++) w.output(Buffer.from(`${'x'.repeat(99)}\n`));
    await w.close();
    const day1 = fs.readFileSync(path.join(dir, 'journal', 'B4M', 'S1', '2026-11-13.log'), 'utf8');
    assert.equal(day1.match(/x+\n/g).join('').length, 1000, 'exactly the cap of output');
    assert.equal(day1.match(/journal stopped: size limit/g).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'journal', 'B4M', 'S1', '2026-11-13.json'), 'utf8')).truncated, true);

    clock.ms += 86_400_000;
    const w2 = journal.open({ bench: 'B4M', device: 'S1', target: 't' });
    w2.output(Buffer.from('S1>'));
    await w2.close();
    assert.equal(fs.readFileSync(path.join(dir, 'journal', 'B4M', 'S1', '2026-11-14.log'), 'utf8'), 'S1>');
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
    assert.equal(journal.sweep(), 2, 'two days are older than 14 days (today counts)');
    const left = journal.list().map((d) => d.day);
    assert.deepEqual(left, [dayOf(clock.ms), dayOf(clock.ms - 13 * 86_400_000)]);
    assert.equal(fs.existsSync(path.join(dir, 'journal', 'B6H')), false, 'an emptied bench folder goes too');
    assert.equal(journal.sweep(), 0);
  } finally {
    await cleanup();
  }
});

test('journal: a day name that is not a date is refused before any path is built', async () => {
  const { journal, cleanup } = setup();
  try {
    assert.throws(() => journal.paths('B4M', 'R1', '../../etc'), { code: 'store.path' });
    assert.throws(() => journal.paths('..', 'R1', '2026-11-13'), { code: 'store.path' });
    assert.equal(journal.meta('B4M', 'R1', '2026-11-13'), null);
  } finally {
    await cleanup();
  }
});
