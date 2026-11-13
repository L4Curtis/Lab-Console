/**
 * Attempt limiter for the local sign-in form
 *
 * The form is reachable from the whole Internet, so three limits apply at
 * once, all checked and counted in one synchronous step (`take`) before any
 * password is looked at - parallel requests cannot slip past them:
 *
 *   - per client (its real address, see clientIp): at most `perClient`
 *     attempts in `windowMs`, successful or not;
 *   - per user name: after `freeFailures` failures in a row, each new attempt
 *     waits twice as long as the previous one (1 s, 2 s, 4 s… up to
 *     `maxBackoffMs`), and only one attempt per name is in flight at a time.
 *     This is what stops a guessing campaign spread over many addresses;
 *   - globally: at most `global` failed attempts in `windowMs`, whatever
 *     their origin, as a last resort.
 *
 * The last two are shared by everyone, so on their own they would let any
 * stranger keep the administrator out for good: one wrong guess on the name
 * each time its backoff expires, or fifty random failures every quarter of an
 * hour. Hence known browsers (the "device cookie" of the OWASP guidance on
 * lockouts, see devices.js): a browser that already signed in with this name
 * presents a signed cookie, and its attempts are counted on that browser
 * alone - `perClient` attempts per window and its own backoff - instead of
 * on its address, the name and the global count. Nobody else can obtain such
 * a cookie without the full credentials, so the shared refusals no longer
 * reach the person who owns them
 *
 * The user name is the one typed, whether or not such an account exists:
 * the answers and the delays are the same for both, so the limiter tells an
 * attacker nothing about which names are real. Nobody is signed in yet here,
 * so the address is the only per-client key there is (ARCHITECTURE §13)
 *
 * Only the local form is limited this way; people signing in through the
 * identity provider never meet these limits
 */
const MAX_ENTRIES = 10_000;

export const THROTTLE_DEFAULTS = Object.freeze({
  perClient: 5,
  global: 50,
  windowMs: 15 * 60_000,
  freeFailures: 2,
  baseBackoffMs: 1000,
  maxBackoffMs: 15 * 60_000,
});

/** User names are compared the way a person would type them */
export const nameKey = (username) => (typeof username === 'string' ? username.trim().toLowerCase().slice(0, 128) : '');

export function createLoginThrottle(options = {}) {
  const { perClient, global, windowMs, freeFailures, baseBackoffMs, maxBackoffMs } = { ...THROTTLE_DEFAULTS, ...options };
  const now = options.now ?? Date.now;
  const clients = new Map(); // address → timestamps of its attempts (oldest first)
  const names = new Map();   // user name → { failures, lastFailureAt, inFlight }
  const devices = new Map(); // known browser → { stamps, failures, lastFailureAt, inFlight }
  let failures = [];         // timestamps of failed attempts, everyone together

  const recent = (stamps, at) => stamps.filter((t) => at - t < windowMs);
  const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));
  const backoffOf = (entry) => (entry.failures < freeFailures ? 0
    : Math.min(maxBackoffMs, baseBackoffMs * 2 ** (entry.failures - freeFailures)));

  const quietLongEnough = (entry, at) => at - entry.lastFailureAt >= backoffOf(entry) + windowMs;

  /** Forget what no longer limits anybody; when still full, the oldest entries give way */
  function sweep(at = now()) {
    failures = recent(failures, at);
    for (const [key, stamps] of clients) {
      const kept = recent(stamps, at);
      if (kept.length) clients.set(key, kept);
      else clients.delete(key);
    }
    for (const [key, entry] of names) {
      if (!entry.inFlight && quietLongEnough(entry, at)) names.delete(key);
    }
    for (const [key, entry] of devices) {
      entry.stamps = recent(entry.stamps, at);
      if (!entry.inFlight && !entry.stamps.length && quietLongEnough(entry, at)) devices.delete(key);
    }
    // Maps keep insertion order: the first keys are the oldest
    for (const map of [clients, names, devices]) {
      for (const key of map.keys()) {
        if (map.size <= MAX_ENTRIES) break;
        map.delete(key);
      }
    }
  }

  const refuse = (scope, retryMs) => ({ allowed: false, scope, retryAfterSeconds: seconds(retryMs) });

  /** A known browser: its own window and its own backoff, nothing shared */
  function takeDevice(key, at) {
    const entry = devices.get(key) ?? { stamps: [], failures: 0, lastFailureAt: 0, inFlight: false };
    entry.stamps = recent(entry.stamps, at);
    if (entry.inFlight) return refuse('device', baseBackoffMs);
    if (entry.stamps.length >= perClient) return refuse('device', entry.stamps[0] + windowMs - at);
    const wait = entry.lastFailureAt + backoffOf(entry) - at;
    if (wait > 0) return refuse('device', wait);
    if (devices.size >= MAX_ENTRIES) sweep(at);
    entry.stamps.push(at);
    entry.inFlight = true;
    devices.delete(key);
    devices.set(key, entry);
    return { allowed: true };
  }

  return {
    /**
     * Ask for one attempt by `client` for `username`; `device` is the id of a
     * known browser for that name (devices.js), when it presented one.
     * → { allowed: true } (the attempt is counted; call failed() or succeeded()
     *   with the same arguments once it is decided)
     *   or { allowed: false, scope: 'client' | 'name' | 'global' | 'device', retryAfterSeconds }
     */
    take({ client, username, device }) {
      const at = now();
      if (device) return takeDevice(String(device), at);
      const clientKey = String(client ?? 'unknown');
      const userKey = nameKey(username);

      failures = recent(failures, at);
      if (failures.length >= global) return refuse('global', failures[0] + windowMs - at);

      const mine = recent(clients.get(clientKey) ?? [], at);
      if (mine.length >= perClient) {
        clients.set(clientKey, mine);
        return refuse('client', mine[0] + windowMs - at);
      }

      let entry = names.get(userKey);
      // A name left alone for a whole window after its backoff starts again from zero failures
      if (entry && !entry.inFlight && quietLongEnough(entry, at)) {
        names.delete(userKey);
        entry = undefined;
      }
      if (entry?.inFlight) return refuse('name', baseBackoffMs);
      if (entry) {
        const wait = entry.lastFailureAt + backoffOf(entry) - at;
        if (wait > 0) return refuse('name', wait);
      }

      if (clients.size >= MAX_ENTRIES || names.size >= MAX_ENTRIES) sweep(at);
      mine.push(at);
      clients.delete(clientKey); // re-inserted last: the map stays ordered by activity
      clients.set(clientKey, mine);
      const next = entry ?? { failures: 0, lastFailureAt: 0, inFlight: false };
      next.inFlight = true;
      names.delete(userKey);
      names.set(userKey, next);
      return { allowed: true };
    },

    /** The attempt taken for `username` failed */
    failed({ username, device }) {
      const at = now();
      if (device) {
        const entry = devices.get(String(device));
        if (entry) {
          entry.failures += 1;
          entry.lastFailureAt = at;
          entry.inFlight = false;
        }
        return;
      }
      failures.push(at);
      const entry = names.get(nameKey(username)) ?? { failures: 0, lastFailureAt: 0, inFlight: false };
      entry.failures += 1;
      entry.lastFailureAt = at;
      entry.inFlight = false;
      names.set(nameKey(username), entry);
    },

    /** The attempt succeeded: that client and that name start again from zero */
    succeeded({ client, username, device }) {
      // A known browser starts again from zero; what strangers did to the
      // name and to the global count stays, or they would get fresh tries
      if (device) return void devices.delete(String(device));
      clients.delete(String(client ?? 'unknown'));
      names.delete(nameKey(username));
    },

    sweep: () => sweep(),

    get size() { return { clients: clients.size, names: names.size, devices: devices.size, failures: failures.length }; },
  };
}
