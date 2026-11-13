/**
 * Audit trail: who did what, when, on which bench - one JSON line per action
 * in data/audit/<yyyy-mm>.jsonl
 *
 *   audit.log(req, 'console.open', { bench: 'B4M', device: 'R1' })
 *   audit.log(user, 'bench.take', { bench })      audit.log('system', 'bench.release.idle', { bench })
 *   audit.query({ since, until, actorId, action, bench, limit })
 *
 * Recording must never get in the way of the action being recorded: log()
 * does not throw and does not reject, even when the disk is full. It only
 * tells the server log that an entry was lost
 *
 * Never put secrets, passwords, tokens or typed keystrokes in `details`.
 * Keys that look like credentials are blanked anyway, as a safety net
 */
import fs from 'node:fs';

const ACTION = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|cookie|authorization|credential|totp|otp$|keystroke/i;
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_QUERY = 5000;
const UNKNOWN = Object.freeze({ id: 'unknown', username: 'unknown', role: 'none', via: 'none' });
const SYSTEM = Object.freeze({ id: 'system', username: 'system', name: 'System', role: 'system', via: 'system' });

/** Deep copy of `details` with credential-looking keys blanked */
function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (depth > 6) return '[nested]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
  return out;
}

const isRequest = (x) => x !== null && typeof x === 'object' && typeof x.headers === 'object' && 'socket' in x;

export function createAudit({ store, logger, clientIp = () => undefined, now = () => new Date() }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };

  function describeActor(actor) {
    if (actor === 'system' || actor === undefined || actor === null) return { who: SYSTEM };
    if (isRequest(actor)) return { who: actor.user ?? UNKNOWN, ip: clientIp(actor) };
    if (typeof actor === 'string') return { who: { id: actor, username: actor, role: 'none', via: 'none' } };
    if (typeof actor !== 'object' || actor.id === undefined || actor.id === null) return { who: UNKNOWN };
    return { who: actor };
  }

  /**
   * Record one action. Returns a promise that resolves to true when the entry
   * is on disk and to false when it was lost - callers normally ignore it
   */
  function record(actor, action, details = {}) {
    try {
      if (typeof action !== 'string' || !ACTION.test(action)) log.warn(`audit action "${action}" is not module.verb[.detail]`);
      const { who, ip } = describeActor(actor);
      const at = now();
      let safe = scrub(details ?? {});
      if (Buffer.byteLength(JSON.stringify(safe)) > MAX_DETAILS_BYTES) {
        safe = { bench: safe.bench, device: safe.device, truncated: true };
      }
      const entry = {
        ts: at.toISOString(),
        action: String(action),
        actor: { id: String(who.id), username: who.username, name: who.name, role: who.role, via: who.via },
        ...(ip ? { ip } : {}),
        details: safe,
      };
      const file = store.jsonl(['audit', `${entry.ts.slice(0, 7)}.jsonl`]);
      return file.append(entry).then(() => true, (err) => {
        log.error(`audit entry lost (${entry.action} by ${entry.actor.id}): ${err.message}`);
        return false;
      });
    } catch (err) {
      try { log.error(`audit entry lost (${String(action)}): ${err.message}`); } catch { /* nothing left to do */ }
      return Promise.resolve(false);
    }
  }

  /** 'console' matches console.open and console.control.grant; 'console.open' matches itself and console.open.* */
  const actionMatches = (wanted, actual) =>
    [].concat(wanted).some((w) => actual === w || String(actual).startsWith(`${w}.`));

  /** Entries, newest first. Every criterion is optional; `limit` defaults to 200 */
  async function query({ since, until, actorId, action, bench, limit = 200 } = {}) {
    const max = Math.min(Math.max(0, Math.floor(Number(limit)) || 0), MAX_QUERY);
    const month = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
    };
    const first = month(since);
    const last = month(until);

    let files;
    try {
      files = (await fs.promises.readdir(store.resolve('audit')))
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .filter((f) => (!first || f.slice(0, 7) >= first) && (!last || f.slice(0, 7) <= last))
        .sort()
        .reverse();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const filter = (e) =>
      (!actorId || e.actor?.id === actorId)
      && (!action || actionMatches(action, e.action))
      && (!bench || e.details?.bench === bench);

    const out = [];
    for (const name of files) { // newest month first, stop as soon as the page is full
      if (out.length >= max) break;
      const entries = await store.jsonl(['audit', name]).read({ since, until, filter, limit: max - out.length });
      out.push(...entries.reverse());
    }
    return out;
  }

  return { log: record, query };
}
