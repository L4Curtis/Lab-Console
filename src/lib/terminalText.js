/**
 * Terminal output as plain text, the way a person reads it on a screen.
 *
 * What a device prints is a stream for a terminal: colours and cursor moves
 * (ESC sequences), a carriage return that rewrites the line (IOS erases its
 * "--More--" that way), backspaces. A search over the raw bytes would miss
 * what is on the screen and find what never was. `plainLines()` replays the
 * stream on a one-line-at-a-time model: ESC sequences are dropped, `\r` goes
 * back to the start of the line, `\b` one column back, other control
 * characters vanish, a line feed ends the line. Trailing spaces are cut.
 * It does not emulate a full-screen program (no cursor addressing): the
 * consoles here are line-oriented.
 */

const MAX_LINE = 2000;

/** Index of the last character of the escape sequence that starts at `at` (an ESC) */
function escapeEnd(text, at) {
  const kind = text[at + 1];
  if (kind === '[') {
    // CSI: parameters, intermediates, one final byte 0x40-0x7e
    let i = at + 2;
    while (i < text.length && !(text[i] >= '@' && text[i] <= '~')) i += 1;
    return i;
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
    // OSC / DCS / APC / PM: up to BEL or ESC \
    let i = at + 2;
    while (i < text.length && text[i] !== '\x07' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1;
    return text[i] === '\x1b' ? i + 1 : i;
  }
  // ESC, intermediates (charset selection "ESC ( B"), one final character
  let i = at + 1;
  while (i < text.length && text[i] >= ' ' && text[i] <= '/') i += 1;
  return i;
}

/** The lines of a terminal stream (a Buffer or a string) → string[] */
export function plainLines(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const lines = [];
  let row = [];
  let col = 0;
  const endLine = () => {
    lines.push(row.join('').replace(/\s+$/, ''));
    row = [];
    col = 0;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\x1b') { i = escapeEnd(text, i); continue; }
    if (ch === '\n') { endLine(); continue; }
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\b') { col = Math.max(0, col - 1); continue; }
    if (ch === '\t') {
      do { if (col < MAX_LINE) row[col] = ' '; col += 1; } while (col % 8 !== 0);
      continue;
    }
    if (ch < ' ' || ch === '\x7f') continue;
    if (col < MAX_LINE) row[col] = ch;
    col += 1;
  }
  // What is on the last line, still being written (a prompt)
  if (row.length) endLine();
  return lines;
}

/** The same, as one text with a final line feed */
export function plainText(input) {
  const lines = plainLines(input);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * The lines containing `query` (no pattern: the text as typed, without case unless `matchCase`).
 * → { matches: [{ n, text }], total, truncated } - `n` counts from 1, `text` is cut at 300 characters
 */
export function searchLines(lines, query, { matchCase = false, limit = 200 } = {}) {
  const needle = matchCase ? query : query.toLowerCase();
  const matches = [];
  let total = 0;
  lines.forEach((line, index) => {
    if (!(matchCase ? line : line.toLowerCase()).includes(needle)) return;
    total += 1;
    if (matches.length < limit) matches.push({ n: index + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
  });
  return { matches, total, truncated: total > matches.length };
}
