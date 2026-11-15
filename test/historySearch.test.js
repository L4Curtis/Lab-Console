/**
 * Searching the journal of a console (src/modules/consoles/history.js): a big
 * journal is replayed a piece at a time, the event loop given back in between
 * (a synchronous replay of 16 MB stalls every console for over half a second),
 * and the answers are the same as if it had been read whole
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { searchSessions } from '../src/modules/consoles/history.js';
import { plainLines, searchLines } from '../src/lib/terminalText.js';
import { tempDataDir } from './helpers/app.js';

let dir;
const session = (n) => ({ benchDir: 'B1', deviceDir: 'R1', day: '2026-11-12', session: String(n).padStart(6, '0'), from: 1000 + n });
const journal = { paths: (benchDir, deviceDir, day, name) => ({ log: path.join(dir, `${benchDir}-${deviceDir}-${day}-${name}.log`) }) };

/** What a device prints: prompts, colours, a --More-- that erases itself, a CRLF per line */
function output(lines, start = 0) {
  const out = [];
  for (let i = start; i < start + lines; i++) out.push(`R1#show thing ${i}\r\n\x1b[1mGigabitEthernet0/${i % 4}\x1b[0m is up --More--\r${" ".repeat(40)}\r${i % 50 === 0 ? 'NEEDLE here' : 'nothing'} ${i}\r\n`);
  return out.join('');
}

before(() => {
  dir = tempDataDir();
  fs.writeFileSync(journal.paths('B1', 'R1', '2026-11-12', '000001').log, output(30_000));
  fs.writeFileSync(journal.paths('B1', 'R1', '2026-11-12', '000002').log, output(2_000, 30_000));
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('a search in pieces finds the same lines, with the same numbers, as a search over the whole text', async () => {
  const sessions = [session(1), session(2)];
  const small = await searchSessions(journal, sessions, 'needle', { pieceBytes: 64 * 1024, limit: 5000 });
  const whole = await searchSessions(journal, sessions, 'needle', { pieceBytes: 1 << 30, limit: 5000 });
  assert.deepEqual(small, whole);
  assert.equal(small.total, 640, '32 000 prints, one in fifty');
  const direct = searchLines(plainLines(fs.readFileSync(journal.paths('B1', 'R1', '2026-11-12', '000001').log)), 'needle', { limit: 5000 });
  assert.deepEqual(small.matches.filter((m) => m.session === '000001').map((m) => [m.n, m.text]), direct.matches.map((m) => [m.n, m.text]), 'numbers count from the start of the session');
  assert.equal(small.matches[0].text, 'NEEDLE here 0');
  assert.equal(small.truncated, false);
});

test('the event loop is given back before each piece is replayed: other work runs during a long search', async () => {
  const real = globalThis.setImmediate;
  let yields = 0;
  globalThis.setImmediate = (fn, ...args) => { yields += 1; return real(fn, ...args); };
  let answer;
  try {
    answer = await searchSessions(journal, [session(1)], 'nothing', { pieceBytes: 32 * 1024 });
  } finally {
    globalThis.setImmediate = real;
  }
  const size = fs.statSync(journal.paths('B1', 'R1', '2026-11-12', '000001').log).size;
  assert.ok(size / (32 * 1024) > 100);
  assert.ok(yields >= Math.floor(size / (32 * 1024)), `${yields} turns given back for ${size} bytes`);
  assert.ok(answer.total > 0);
});

test('the limits still hold: matches are capped and flagged, the scan stops after maxBytes', async () => {
  const capped = await searchSessions(journal, [session(1), session(2)], 'needle', { limit: 10, pieceBytes: 64 * 1024 });
  assert.deepEqual([capped.matches.length, capped.total, capped.truncated], [10, 640, true]);
  const one = fs.statSync(journal.paths('B1', 'R1', '2026-11-12', '000001').log).size;
  const stopped = await searchSessions(journal, [session(1), session(2)], 'needle', { maxBytes: one, limit: 5000 });
  assert.deepEqual([stopped.searched, stopped.truncated], [1, true]);
  // A session swept meanwhile is skipped
  const missing = await searchSessions(journal, [session(9), session(2)], 'needle', { limit: 5000 });
  assert.equal(missing.searched, 1);
});
