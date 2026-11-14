/**
 * Terminal output as plain text, and the search over it: what a screen
 * showed, not the escape codes and rewritten lines the device sent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainLines, plainText, searchLines } from '../src/lib/terminalText.js';

test('colours, cursor sequences and title strings vanish; text stays', () => {
  assert.deepEqual(plainLines('\x1b[1;31mred\x1b[0m text\r\n\x1b]0;title\x07next\r\n\x1b(Bdone\r\n'), ['red text', 'next', 'done']);
  assert.deepEqual(plainLines('a\x1b[2Kb\x1b[?25lc\r\n'), ['abc']);
  assert.deepEqual(plainLines('x\x1b]8;;http://example.org\x1b\\link\x1b]8;;\x1b\\\r\n'), ['xlink']);
});

test('a carriage return rewrites the line: IOS erasing its --More-- leaves only what follows', () => {
  const more = 'line 1\r\nline 2\r\n --More-- \r         \rline 3\r\n';
  assert.deepEqual(plainLines(more), ['line 1', 'line 2', 'line 3']);
  assert.deepEqual(plainLines('progress 10%\rprogress 99%\r\n'), ['progress 99%']);
});

test('a backspace goes one column back; tabs reach the next stop; other control characters are dropped', () => {
  assert.deepEqual(plainLines('R1#shw\b\b\bshow\r\n'), ['R1#show']);
  assert.deepEqual(plainLines('a\tb\r\n'), ['a       b']);
  assert.deepEqual(plainLines('ab\x07\x00c\r\n'), ['abc']);
});

test('trailing spaces are cut, empty lines are kept, the last unfinished line (a prompt) counts', () => {
  assert.deepEqual(plainLines('one  \r\n\r\ntwo\r\nR1>'), ['one', '', 'two', 'R1>']);
  assert.deepEqual(plainLines(''), []);
  assert.deepEqual(plainLines(null), []);
  assert.equal(plainText('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(plainText(''), '');
});

test('bytes and strings read the same; a sequence cut at the end of the buffer does not swallow what came before', () => {
  assert.deepEqual(plainLines(Buffer.from('R1#show clock\r\n')), ['R1#show clock']);
  assert.deepEqual(plainLines('text\x1b[3'), ['text']);
});

test('a very long line is cut, not stretched', () => {
  const [line] = plainLines(`${'x'.repeat(10_000)}\r\n`);
  assert.equal(line.length, 2000);
});

test('search: a plain text, without case unless asked; numbers count from 1; the text is cut at 300', () => {
  const lines = ['R1#show ip route', 'Gateway of last resort is not set', 'R1#SHOW CLOCK', 'x'.repeat(400)];
  assert.deepEqual(searchLines(lines, 'show').matches.map((m) => m.n), [1, 3]);
  assert.deepEqual(searchLines(lines, 'show', { matchCase: true }).matches.map((m) => m.n), [1]);
  assert.deepEqual(searchLines(lines, 'nothing'), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchLines(lines, '.*').total, 0, 'never a pattern: a dot and a star are only themselves');
  assert.equal(searchLines(lines, 'xxx').matches[0].text.length, 301);
});

test('search: only `limit` matches come back, with the real total', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} match`);
  const found = searchLines(lines, 'match', { limit: 10 });
  assert.deepEqual([found.matches.length, found.total, found.truncated], [10, 50, true]);
  assert.equal(found.matches.at(-1).n, 10);
});
