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
  scanBytes: 32 * 1024 * 1024,
});

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
 */
export async function searchSessions(journal, sessions, query, { matchCase = false, limit = HISTORY_LIMITS.matches, maxBytes = HISTORY_LIMITS.scanBytes } = {}) {
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
    const found = searchLines(plainLines(raw), query, { matchCase, limit: Math.max(0, limit - matches.length) });
    total += found.total;
    for (const m of found.matches) matches.push({ id: `${s.benchDir}/${s.deviceDir}/${s.day}/${s.session}`, day: s.day, session: s.session, from: s.from, ...m });
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
