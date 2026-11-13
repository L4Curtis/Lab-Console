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
import { toast } from '../../core/dom.js';
import { request, live } from '../../core/api.js';
import { getLocale } from '../../core/i18n.js';
import { session } from '../../core/session.js';

let summaries = new Map(); // bench → summary
let backupOffer = false;
const listeners = new Set();

live.on('benches:state', (data) => {
  summaries = new Map((data?.benches ?? []).map((b) => [b.bench, b]));
  backupOffer = Boolean(data?.backupOffer);
  for (const fn of listeners) fn(summaries);
});

export function onBenches(fn) {
  listeners.add(fn);
  if (summaries.size) fn(summaries);
  return () => listeners.delete(fn);
}

export const benchSummary = (name) => summaries.get(name) ?? null;
export const hasBackupOffer = () => backupOffer;

/** Is the signed-in user one of the bench's occupants? */
export const isOccupant = (summary) => Boolean(summary?.occupants?.some((o) => o.id === session.user?.id));

/**
 * The same rule as services.benches.canPilot, for showing things only:
 * admins and admin switches always; else any of the device's benches that is
 * unlocked and free or occupied by me
 */
export function mayPilot(device, benchNames) {
  if (session.isAdmin || String(device?.key ?? '').startsWith('admin:')) return true;
  if (!summaries.size) return true; // state not received yet: let the server decide
  return benchNames.some((name) => {
    const s = summaries.get(name);
    return !s || (!s.lock && (!s.holder || isOccupant(s)));
  });
}

/** A JSON call; on failure shows the translated error and resolves to null */
export async function call(method, url, body, { quiet = false } = {}) {
  try {
    return await request(method, url, body);
  } catch (err) {
    if (!quiet) toast(err.message, 'error', 6000);
    return null;
  }
}

export const benchUrl = (name, rest = '') => `/api/benches/${encodeURIComponent(name)}${rest}`;
export const teamUrl = (id, rest = '') => `/api/teams/${encodeURIComponent(id)}${rest}`;

// ── Dates, in the language of the page ─────────────────────────────────────

const fmt = (options) => (value) => new Intl.DateTimeFormat(getLocale(), options).format(new Date(value));
export const fmtTime = fmt({ hour: '2-digit', minute: '2-digit' });
export const fmtDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDateTime = (value) => `${fmtDay(value)} ${fmtTime(value)}`;
export const fmtSlot = (r) => `${fmtDay(r.start)} ${fmtTime(r.start)}–${fmtTime(r.end)}`;
