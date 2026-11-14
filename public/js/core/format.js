/**
 * Dates in the language of the page, the same everywhere
 *
 *   fmtTime(iso)      14:05
 *   fmtDay(iso)       ven. 13 nov.
 *   fmtDateTime(iso)  ven. 13 nov. 14:05
 *   fmtShort(iso)     13 nov., 14:05            (a list's date column, a tooltip)
 *   fmtLong(iso)      13 nov. 2026, 14:05       ('—' for none: tables of the administration)
 */
import { getLocale } from './i18n.js';

const fmt = (options) => (value) => new Intl.DateTimeFormat(getLocale(), options).format(new Date(value));

export const fmtTime = fmt({ hour: '2-digit', minute: '2-digit' });
export const fmtDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDateTime = (value) => `${fmtDay(value)} ${fmtTime(value)}`;

const short = fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtShort = (value) => (value ? short(value) : '');

const long = fmt({ dateStyle: 'medium', timeStyle: 'short' });
export function fmtLong(value) {
  if (!value) return '—';
  return Number.isNaN(new Date(value).getTime()) ? '—' : long(value);
}
