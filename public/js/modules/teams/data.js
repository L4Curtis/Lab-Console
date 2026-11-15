/**
 * What the team section and the bench bar share: the live state of every
 * bench (SSE 'benches:state'), small API wrappers and date formatting
 *
 *   onBenches((byName) => …)     every bench's summary, now and after each change
 *   benchSummary('B4M')          the last summary received, or null
 *   call('POST', '/api/benches/B4M/take')   → JSON, or a toast with the translated error and null
 *
 * The server decides every permission again; what is computed here only
 * hides buttons
 */
import { live } from '../../core/api.js';
import { t, has } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { h } from '../../core/dom.js';
import { fmtDay, fmtTime } from '../../core/format.js';

let summaries = new Map(); // bench → summary
const listeners = new Set();

live.on('benches:state', (data) => {
  summaries = new Map((data?.benches ?? []).map((b) => [b.bench, b]));
  for (const fn of listeners) fn(summaries);
});

export function onBenches(fn) {
  listeners.add(fn);
  if (summaries.size) fn(summaries);
  return () => listeners.delete(fn);
}

export const benchSummary = (name) => summaries.get(name) ?? null;

/** Is the signed-in user one of the bench's occupants? */
export const isOccupant = (summary) => Boolean(summary?.occupants?.some((o) => o.id === session.user?.id));

/**
 * The same rule as services.benches.canPilot, for showing things only:
 * admins and admin switches always; never when any of the device's benches
 * is locked (a shared console line included); else any of them that is free
 * or occupied by me
 */
export function mayPilot(device, benchNames) {
  if (session.isAdmin || String(device?.key ?? '').startsWith('admin:')) return true;
  if (!summaries.size) return true; // state not received yet: let the server decide
  if (benchNames.some((name) => summaries.get(name)?.lock)) return false;
  return benchNames.some((name) => {
    const s = summaries.get(name);
    return !s || !s.holder || isOccupant(s);
  });
}

export const benchUrl = (name, rest = '') => `/api/benches/${encodeURIComponent(name)}${rest}`;
export const teamUrl = (id, rest = '') => `/api/teams/${encodeURIComponent(id)}${rest}`;

// ── Dates, in the language of the page ─────────────────────────────────────

export const fmtSlot = (r) => `${fmtDay(r.start)} ${fmtTime(r.start)}–${fmtTime(r.end)}`;

// ── The story of a bench, from its audit trail ─────────────────────────────

/** Bench history lines: audit action → sentence */
const HISTORY_KEYS = {
  'bench.take': 'benches.history.take',
  'bench.release': 'benches.history.release',
  'bench.release.idle': 'benches.history.releaseIdle',
  'bench.assign': 'benches.history.assign',
  'bench.join.request': 'benches.history.joinRequest',
  'bench.join.accept': 'benches.history.joinAccept',
  'bench.join.refuse': 'benches.history.joinRefuse',
  'bench.leave': 'benches.history.leave',
  'bench.guest.remove': 'benches.history.guestRemove',
  'bench.lock': 'benches.history.lock',
  'bench.unlock': 'benches.history.unlock',
  'bench.reserve': 'benches.history.reserve',
  'bench.reservation.cancel': 'benches.history.reservationCancel',
};

/**
 * One entry of a bench's history or activity, as a sentence: { action, actor: { name }, details: { team, guest, device } }.
 * Bench jobs speak through the jobs dictionary (loaded at start-up for the diagram layer)
 */
export function historyText(e) {
  const params = { who: e.actor.name, team: e.details.team ?? '', guest: e.details.guest ?? '', device: e.details.device ?? '' };
  const known = HISTORY_KEYS[e.action];
  if (known) return t(known, params);
  const job = `jobs.audit.${e.action.slice(4).replace(/\./g, '_')}`;
  if (e.action.startsWith('job.') && has(job)) return t(job, params);
  if (e.action.startsWith('job.')) return t('benches.history.job', { ...params, action: e.action.slice(4) });
  return `${e.actor.name} · ${e.action}`;
}

// ── People ──────────────────────────────────────────────────────────────────

/** "Ada Lovelace" → "AL", "curtis" → "CU" (the same rule as the server's badges) */
export function initialsOf(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join('').toUpperCase();
}

/** A hue from the id, dark enough for white initials: the same person keeps the same colour on these screens */
const colorOf = (key) => {
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 28%)`;
};

/** A round badge for a person of a team or a bench: { id, name, guest? } */
export function personAvatar(person, cls = '') {
  const el = h(`span.avatar${cls}`, { title: person.name, 'aria-hidden': 'true' }, initialsOf(person.name));
  el.style.setProperty('--avatar', person.color ?? colorOf(person.id ?? person.username ?? person.name));
  return el;
}

/** At most `max` badges, then "+n"; the names are in the accessible name of the group */
export function avatarStack(people, { max = 3 } = {}) {
  const list = people ?? [];
  const more = list.length - max;
  return h('span.avatar-stack', { role: 'img', 'aria-label': list.map((p) => p.name).join(', ') },
    list.slice(0, max).map((p) => personAvatar(p)),
    more > 0 ? h('span.avatar-more', { 'aria-hidden': 'true' }, `+${more}`) : null);
}
