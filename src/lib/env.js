/**
 * Environment readers shared by every configuration fragment
 *
 * A fragment (src/config.js, src/modules/<id>/config.js) calls these readers
 * and never touches process.env itself. A bad value does not throw: it is
 * pushed to the shared `errors` array and the reader returns its fallback, so
 * a misconfigured deployment gets the whole list of problems at once instead
 * of fixing them one restart at a time
 */

/** Problems found so far; src/config.js reports them and refuses to start */
export const errors = [];

/** Record a problem found by a fragment's own validation */
export function fail(message) {
  errors.push(message);
}

/** Hand the collected problems over and start a fresh list */
export function takeErrors() {
  return errors.splice(0, errors.length);
}

/**
 * Node >= 20.12 can read .env natively - no dotenv dependency needed.
 * Variables already set in the environment win over the file
 */
export function loadEnvFile() {
  try {
    process.loadEnvFile(process.env.ENV_FILE || '.env');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // a missing .env is fine (vars may come from Docker)
  }
}

export function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function required(name) {
  const v = str(name);
  if (!v) errors.push(`${name} is required`);
  return v;
}

export function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = str(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return n;
}

export function bool(name, fallback) {
  const raw = str(name).toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export function list(name, fallback = []) {
  const raw = str(name);
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

export function portRange(name, fallback) {
  const raw = str(name, fallback);
  const m = raw.match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
  if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) > 65535) {
    errors.push(`${name} must look like "${fallback}" (got "${raw}")`);
    const [a, b] = fallback.split('-').map(Number);
    return { min: a, max: b };
  }
  return { min: Number(m[1]), max: Number(m[2]) };
}

/** One value out of a closed set, case-insensitive: oneOf('AUTH_MODE', ['on', 'off'], 'on') */
export function oneOf(name, allowed, fallback) {
  const raw = str(name).toLowerCase();
  if (!raw) return fallback;
  if (!allowed.includes(raw)) {
    errors.push(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
    return fallback;
  }
  return raw;
}

/**
 * A bare origin such as "https://lab.example.org" (scheme, host, optional
 * port; no path, query or credentials). Returns '' when unset
 */
export function origin(name) {
  const raw = str(name).replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { url = null; }
  const bare = url && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (!bare || !['http:', 'https:'].includes(url.protocol)) {
    errors.push(`${name} must be an origin like https://lab.example.org, without a path (got "${raw}")`);
    return '';
  }
  return url.origin;
}
