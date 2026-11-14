/**
 * Dates in the language of the page, the one place that decides how they read:
 * lower-case months, no comma, the same order everywhere
 *
 *   fmtTime(iso)      14:05
 *   fmtDay(iso)       ven. 13 nov.
 *   fmtDayMonth(iso)  13 nov.
 *   fmtDate(iso)      13 nov. 2026
 *   fmtDateTime(iso)  ven. 13 nov. 14:05
 *   fmtShort(iso)     13 nov. 14:05             (a list's date column, a tooltip)
 *   fmtLong(iso)      13 nov. 2026 14:05        ('—' for none: tables of the administration)
 *   fmtCalendarDay('2026-11-13')   ven. 13 nov. (a day as the server names it: no time zone involved)
 */
import { getLocale } from './i18n.js';

const fmt = (options) => (value) => new Intl.DateTimeFormat(getLocale(), options).format(new Date(value));

export const fmtTime = fmt({ hour: '2-digit', minute: '2-digit' });
export const fmtDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDayMonth = fmt({ day: 'numeric', month: 'short' });
export const fmtDate = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
export const fmtDateTime = (value) => `${fmtDay(value)} ${fmtTime(value)}`;
export const fmtCalendarDay = (day) => fmtDay(`${day}T12:00:00`);

export const fmtShort = (value) => (value ? `${fmtDayMonth(value)} ${fmtTime(value)}` : '');

export function fmtLong(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '—';
  return `${fmtDate(value)} ${fmtTime(value)}`;
}
