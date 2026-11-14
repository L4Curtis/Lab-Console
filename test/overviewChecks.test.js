/**
 * The overview's bench cards and the checks lot's line status, together
 * (wave 4 as integrated): a line status run by a team shows on every card of
 * that bench, for every reader, as long as it is fresh; what the application
 * knows now (a console open, a line refused) wins over it; nothing of the
 * check but the counts and its time reaches the card (no console address)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startChecksApp, CHECK_MODELS, waitFor } from './helpers/checks.js';
import { openReady } from './helpers/consoleClient.js';
import { createOverviewModule } from '../src/modules/overview/index.js';
import { LINES_FRESH_MS } from '../src/modules/checks/index.js';

let c;
let offset = 0; // the checks module's clock, moved forward to make a line status stale
const card = async (who, bench = 'B4M') => {
  const res = await c.api(who, 'GET', '/api/overview/benches');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.benches.find((b) => b.bench === bench);
};

before(async () => {
  c = await startChecksApp({
    models: { ...CHECK_MODELS, R3: { model: '2801', start: 'silent' } },
    checks: { now: () => Date.now() + offset },
    extra: (deps) => createOverviewModule(deps),
  });
  await c.holdBench('student1');
});
after(async () => {
  await c?.close();
});

test('before any check: the card knows only what the application knows', async () => {
  const lines = (await card('student2')).lines;
  assert.deepEqual({ ...lines, total: undefined }, { total: undefined, open: 0, busy: 0, silent: 0, free: 0, checkedAt: null });
  assert.equal(c.services.checks.lines('B4M'), null);
});

test('a line status of the team shows on the card for everyone: free, busy, silent and when; an open console still wins', { timeout: 40_000 }, async () => {
  c.lab.setBusy(c.port('R2'));
  const r4 = await openReady(c.app, 'student1', c.device('R4'));
  try {
    const started = await c.api('student1', 'POST', '/api/checks/benches/B4M/lines');
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const check = await c.until('B4M', 'lines');
    const by = new Map(check.result.devices.map((d) => [d.name, d.line]));
    assert.equal(by.get('R2'), 'busy');
    assert.equal(by.get('R3'), 'silent');
    assert.equal(by.get('R4'), 'in_app');
    await waitFor(() => !c.services.consoles.rooms.get(c.targetOf('R3')), 5000, 'the probed lines hung up');

    const free = [...by.values()].filter((l) => l === 'free').length;
    assert.ok(free >= 5, `free lines found: ${free}`);
    for (const who of ['student1', 'student2', 'admin']) { // an occupant, a student of no team on it, an admin
      const lines = (await card(who)).lines;
      assert.equal(lines.checkedAt, check.endedAt, who);
      assert.equal(lines.open, 1, `${who}: R4 is open in the application`);
      assert.equal(lines.busy, 1, `${who}: R2, refused`);
      assert.equal(lines.silent, 1, `${who}: R3 answered nothing`);
      assert.equal(lines.free, free, who);
    }
    const raw = JSON.stringify(await card('student2'));
    assert.doesNotMatch(raw, /10\.22\.|:20\d\d/, 'no console address on a card');

    // A line the check found free and that someone opens since: open, no longer free
    const r1 = await openReady(c.app, 'student1', c.device('R1'));
    const after = (await card('student2')).lines;
    assert.equal(after.open, 2);
    assert.equal(after.free, free - 1);
    await r1.close();
  } finally {
    await r4.close();
    c.lab.setBusy(c.port('R2'), false);
  }
});

test('a stale line status is no longer shown: the lines move', async () => {
  assert.ok(c.services.checks.lines('B4M'));
  offset = LINES_FRESH_MS + 60_000;
  try {
    assert.equal(c.services.checks.lines('B4M'), null);
    const lines = (await card('student2')).lines;
    assert.equal(lines.checkedAt, null);
    assert.equal(lines.free, 0);
  } finally {
    offset = 0;
  }
});
