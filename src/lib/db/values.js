/**
 * How values are stored, the same way whatever the database (ARCHITECTURE §6):
 *
 *   ids          text: a UUID (newId) or a natural key
 *   timestamps   ISO-8601 text in UTC, millisecond precision, always the same
 *                length, so that text order is time order (toIso / fromIso)
 *   booleans     integers 1 / 0 (toFlag / fromFlag)
 *   JSON         text (toJson / fromJson)
 *
 * Repositories convert at their boundary: the rest of the application keeps
 * using numbers, Dates, booleans and objects
 */
import crypto from 'node:crypto';

/** A Date, a number of milliseconds or a date string → '2026-11-13T09:00:00.000Z'; null when not a date */
export function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  const ms = date.getTime();
  // Years outside 0000-9999 would not keep the fixed length that makes text order time order
  if (!Number.isFinite(ms) || ms < -62167219200000 || ms > 253402300799999) return null;
  return date.toISOString();
}

/** The milliseconds of a stored timestamp; NaN when it is not one */
export const fromIso = (text) => (typeof text === 'string' ? Date.parse(text) : NaN);

export const toFlag = (value) => (value ? 1 : 0);
export const fromFlag = (value) => value === 1 || value === 1n;

export const toJson = (value) => JSON.stringify(value ?? null);

/** Parse a stored JSON payload; `fallback` when it is missing or damaged */
export function fromJson(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const MONOTONIC_WINDOW_MS = 1000;
let lastMs = -1;
let lastSeq = 0;

/**
 * A UUID version 7 (RFC 9562): 48 bits of milliseconds, then a counter, then
 * random bits. Ids made one after the other for the same millisecond sort in
 * creation order, so they break ties between rows that share a timestamp.
 * `ms` defaults to now; importers pass the time of the record they import
 */
export function newId(ms = Date.now()) {
  let at = Math.max(0, Math.floor(Number(ms) || 0));
  let seq = 0;
  // Same millisecond as the last id, or slightly before it (a millisecond
  // borrowed below, a clock stepping back): continue after the last id, so
  // that ids keep their creation order. A time far in the past (an import)
  // starts afresh at that time
  if (at <= lastMs && lastMs - at <= MONOTONIC_WINDOW_MS) {
    at = lastMs;
    seq = lastSeq + 1;
    if (seq > 0xfff) { at += 1; seq = 0; } // 4096 ids in one millisecond: borrow the next one
  }
  lastMs = at;
  lastSeq = seq;
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(at, 0, 6);
  bytes[6] = 0x70 | (seq >> 8);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
