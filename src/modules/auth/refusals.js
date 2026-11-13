/**
 * Audit entries for refusals that cost the sender nothing
 *
 * A throttled sign-in attempt, or a callback that matches no sign-in in
 * progress, is answered without any work, and anyone can send millions of
 * them. Writing one audit line each would turn the cheap path into a disk
 * writer (about 1 GB an hour from a single client) and drown the entries
 * that matter. So, per window of `windowMs`:
 *
 *   - the first refusal of a given kind from a given client is audited as
 *     usual (`auth.login.failed`, with the address and the reason);
 *   - the next ones from that client, of that kind, are only counted;
 *   - at most `maxKeys` clients get their own entry; beyond that every
 *     refusal is only counted;
 *   - once the window is over, one `auth.login.suppressed` entry (actor
 *     'system') says how many were counted and from whom (the ten busiest).
 *
 * At most `maxKeys + 1` entries per window, whatever the traffic. Attempts
 * whose credentials are actually checked are not concerned: each one is
 * audited, and the limiter already bounds how many there can be
 */
const TOP = 10;

export function createRefusalAudit({ audit, now = Date.now, windowMs = 15 * 60_000, maxKeys = 100 }) {
  let windowStart = now();
  let seen = new Map(); // `${client} ${kind}` → { ip, kind, count } (count = refusals not audited one by one)
  let overflow = 0;     // refusals from clients beyond maxKeys

  /** Close the current window: one summary entry when anything was left out */
  function flush(at = now()) {
    const counted = [...seen.values()].filter((e) => e.count > 0);
    const total = counted.reduce((sum, e) => sum + e.count, 0) + overflow;
    if (total) {
      audit?.log('system', 'auth.login.suppressed', {
        count: total,
        since: new Date(windowStart).toISOString(),
        until: new Date(at).toISOString(),
        top: counted.sort((a, b) => b.count - a.count).slice(0, TOP).map(({ ip, kind, count }) => ({ ip, reason: kind, count })),
        ...(overflow ? { otherClients: overflow } : {}),
      });
    }
    windowStart = at;
    seen = new Map();
    overflow = 0;
  }

  return {
    /**
     * A refusal of `kind` for `req`, coming from `client`. `details` go into
     * the audit entry when this one is audited
     */
    record(req, client, kind, details) {
      const at = now();
      if (at - windowStart >= windowMs) flush(at);
      const key = `${client} ${kind}`;
      const entry = seen.get(key);
      if (entry) {
        entry.count += 1;
        return false;
      }
      if (seen.size >= maxKeys) {
        overflow += 1;
        return false;
      }
      seen.set(key, { ip: String(client), kind, count: 0 });
      audit?.log(req, 'auth.login.failed', details);
      return true;
    },

    /** Write the summary of the window if it is over (housekeeping), or now (shutdown) */
    flush({ force = false } = {}) {
      const at = now();
      if (force || at - windowStart >= windowMs) flush(at);
    },
  };
}
