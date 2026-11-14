/**
 * The history of a console: the recent output its room still holds (what a
 * newcomer is replayed) and, for the days a person may read, the journal
 * (journal.js). Both are searched and downloaded as plain text
 * (src/lib/terminalText.js): what the screen showed, not the escape codes
 * the device sent.
 *
 * Who may read what is decided by the caller: the room's output by being
 * attached to it (what one is replayed on arrival anyway), a journal day by
 * `journal.canReadDay` (the people who were on the console that day, their
 * team, the admins). This file only does the reading
 */
import fs from 'node:fs';
import { plainLines, plainText, searchLines } from '../../lib/terminalText.js';

export const HISTORY_LIMITS = Object.freeze({
  query: 200,
  matches: 200,
  // The journal text one search reads at most (a day is capped at 5 MB by default)
  scanBytes: 16 * 1024 * 1024,
  // Replayed as plain text this much at a time, the server doing its other work between two pieces
  pieceBytes: 1024 * 1024,
});

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** `raw` in pieces of about `size` bytes, each ending at a line feed (the plain-text replay starts a line afresh) */
function* pieces(raw, size) {
  for (let from = 0; from < raw.length;) {
    let to = Math.min(raw.length, from + size);
    if (to < raw.length) {
      const feed = raw.indexOf(0x0a, to - 1);
      to = feed === -1 ? raw.length : feed + 1;
    }
    yield raw.subarray(from, to);
    from = to;
  }
}

const dayKey = (d) => `${d.benchDir}/${d.deviceDir}/${d.day}`;

/** The journal sessions `user` may read: those of a day any of whose sessions they may read (journal.js) */
export function readableSessions(journal, sessions, user, teamOfUser) {
  const metasOf = new Map();
  for (const d of sessions) metasOf.set(dayKey(d), [...(metasOf.get(dayKey(d)) ?? []), d.meta]);
  return sessions.filter((d) => journal.canReadDay(user, metasOf.get(dayKey(d)), teamOfUser));
}

/** The sessions (journal.list() entries) of one console line: by its address, or by names for a session that did not record it */
export function sessionsOfConsole(sessions, { target, bench, device }) {
  return sessions.filter((d) => (d.meta?.target ? d.meta.target === target : d.bench === bench && d.device === device));
}

/** → [{ day, sessions, bytes }] newest day first */
export function daysOf(sessions) {
  const days = new Map();
  for (const s of sessions) {
    const d = days.get(s.day) ?? { day: s.day, sessions: 0, bytes: 0 };
    d.sessions += 1;
    d.bytes += s.bytes;
    days.set(s.day, d);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

const logFile = (journal, s) => journal.paths(s.benchDir, s.deviceDir, s.day, s.session).log;

/**
 * Search the sessions (newest first) for `query`.
 * → { matches: [{ id, day, session, from, n, text }], total, truncated, searched }
 * `id` is the session's path in the journal API (bench/device/day/session)
 * The replay of a session is synchronous and slow (about 40 ms a MB): it is done a piece at a time with
 * the event loop given back in between, or a search over a big journal would stall every console
 */
export async function searchSessions(journal, sessions, query, {
  matchCase = false, limit = HISTORY_LIMITS.matches, maxBytes = HISTORY_LIMITS.scanBytes, pieceBytes = HISTORY_LIMITS.pieceBytes,
} = {}) {
  const matches = [];
  let total = 0;
  let scanned = 0;
  let searched = 0;
  let truncated = false;
  for (const s of sessions) {
    if (scanned >= maxBytes) { truncated = true; break; }
    let raw;
    try {
      raw = await fs.promises.readFile(logFile(journal, s));
    } catch {
      continue; // swept meanwhile
    }
    scanned += raw.length;
    searched += 1;
    let lineOffset = 0;
    for (const piece of pieces(raw, pieceBytes)) {
      await yieldToLoop();
      const lines = plainLines(piece);
      const found = searchLines(lines, query, { matchCase, limit: Math.max(0, limit - matches.length) });
      total += found.total;
      for (const m of found.matches) matches.push({ id: `${s.benchDir}/${s.deviceDir}/${s.day}/${s.session}`, day: s.day, session: s.session, from: s.from, ...m, n: m.n + lineOffset });
      lineOffset += lines.length;
    }
  }
  return { matches, total, truncated: truncated || total > matches.length, searched };
}

/** Every session of a day, oldest first, as one plain text with a header line before each */
export async function dayText(journal, sessions) {
  const parts = [];
  for (const s of [...sessions].sort((a, b) => a.session.localeCompare(b.session, 'en', { numeric: true }))) {
    let raw;
    try {
      raw = await fs.promises.readFile(logFile(journal, s));
    } catch {
      continue;
    }
    parts.push(`===== ${s.bench} / ${s.device} - ${s.day} - session ${s.session} =====\n${plainText(raw)}`);
  }
  return parts.join('\n');
}
