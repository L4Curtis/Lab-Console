/**
 * The building blocks of the sign-in, one by one: TOTP and HOTP against the
 * RFC test vectors, password hashes, cookies, return paths, the attempt
 * limiter and known browsers, aggregated refusals, sessions (expiry,
 * rotation, revocation, persistence, credential binding), account providers, roles and claims, OIDC settings
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, stepAt, generateSecret, otpauthUri } from '../src/modules/auth/totp.js';
import { hashPassword, verifyPassword, parseHash, safeEqual } from '../src/modules/auth/password.js';
import { cookieSettings, readCookie, serializeCookie, clearCookie } from '../src/modules/auth/cookies.js';
import { createPendingLogins, safeReturnPath } from '../src/modules/auth/pendingLogins.js';
import { createLoginThrottle } from '../src/modules/auth/throttle.js';
import { createSessionStore, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from '../src/modules/auth/sessions.js';
import { createAccountProviders } from '../src/modules/auth/accounts.js';
import { createEnvAdminProvider, adminDerivedKey } from '../src/modules/auth/envAdmin.js';
import { createDeviceCookies, loadDeviceKey, DEVICE_MAX_AGE_MS } from '../src/modules/auth/devices.js';
import { createRefusalAudit } from '../src/modules/auth/refusals.js';
import { resolveRole, isAllowed } from '../src/modules/auth/roles.js';
import { readClaim, toGroups, groupsFrom, userFromClaims, needsUserinfo } from '../src/modules/auth/claims.js';
import { normalizeOidcSettings } from '../src/modules/auth/oidcSettings.js';
import { createUser, hasRole, initialsOf, colorOf, ROLES } from '../src/modules/auth/user.js';
import { student, admin } from './helpers/fakes.js';
import { TEST_ADMIN, adminCode } from './helpers/app.js';
import { withMemoryDatabase } from './helpers/db.js';

const clock = (ms = Date.UTC(2026, 10, 12, 9, 0, 0)) => {
  const c = { ms, now: () => c.ms, advance: (delta) => { c.ms += delta; } };
  return c;
};

/** fn({ db, repos }) with a database of its own; "a restart" is a new service on the same database */
const withDb = (fn) => withMemoryDatabase(fn);

// ── TOTP / HOTP ─────────────────────────────────────────────────────────────

describe('one-time codes', () => {
  const ascii = (text) => Buffer.from(text, 'ascii');

  test('HOTP: the ten values of RFC 4226 appendix D', () => {
    const key = ascii('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    assert.deepEqual(expected.map((_, counter) => hotp(key, counter)), expected);
  });

  test('TOTP: every vector of RFC 6238 appendix B (SHA-1, SHA-256, SHA-512, 8 digits)', () => {
    const keys = {
      sha1: ascii('12345678901234567890'),
      sha256: ascii('12345678901234567890123456789012'),
      sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
    };
    const vectors = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [seconds, sha1, sha256, sha512] of vectors) {
      const at = seconds * 1000;
      assert.equal(totp(keys.sha1, at, { digits: 8 }), sha1, `SHA-1 at ${seconds}`);
      assert.equal(totp(keys.sha256, at, { digits: 8, algorithm: 'sha256' }), sha256, `SHA-256 at ${seconds}`);
      assert.equal(totp(keys.sha512, at, { digits: 8, algorithm: 'sha512' }), sha512, `SHA-512 at ${seconds}`);
    }
  });

  test('base32 round-trips, tolerates spaces and lower case, refuses anything else', () => {
    assert.equal(base32Encode(ascii('12345678901234567890')), TEST_ADMIN.totpSecret);
    assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezdgnbvgy3tqojq'), ascii('12345678901234567890'));
    for (const bad of ['', 'ABC1', 'ABC!', null]) assert.throws(() => base32Decode(bad), TypeError);
    const secret = generateSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(base32Decode(secret).length, 20);
  });

  test('verifyTotp: ±1 step of drift, nothing further, and malformed input never matches', () => {
    const key = base32Decode(TEST_ADMIN.totpSecret);
    const at = Date.UTC(2026, 10, 12, 9, 0, 10);
    const step = stepAt(at);
    assert.equal(verifyTotp(key, totp(key, at), { timeMs: at }), step);
    assert.equal(verifyTotp(key, totp(key, at - 30_000), { timeMs: at }), step - 1);
    assert.equal(verifyTotp(key, totp(key, at + 30_000), { timeMs: at }), step + 1);
    assert.equal(verifyTotp(key, totp(key, at - 60_000), { timeMs: at }), null);
    assert.equal(verifyTotp(key, totp(key, at + 60_000), { timeMs: at }), null);
    assert.equal(verifyTotp(key, ` ${totp(key, at).slice(0, 3)} ${totp(key, at).slice(3)} `, { timeMs: at }), step, 'spaces are tolerated');
    for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456, '000000x']) assert.equal(verifyTotp(key, bad, { timeMs: at }), null, String(bad));
  });

  test('verifyTotp: a step that was used, or an older one, is refused (no replay)', () => {
    const key = base32Decode(TEST_ADMIN.totpSecret);
    const at = Date.UTC(2026, 10, 12, 9, 0, 10);
    const step = stepAt(at);
    assert.equal(verifyTotp(key, totp(key, at), { timeMs: at, after: step }), null);
    assert.equal(verifyTotp(key, totp(key, at - 30_000), { timeMs: at, after: step }), null);
    assert.equal(verifyTotp(key, totp(key, at + 30_000), { timeMs: at, after: step }), step + 1);
  });

  test('otpauth URI: what authenticator apps expect', () => {
    const uri = otpauthUri({ secret: TEST_ADMIN.totpSecret, account: 'root', issuer: 'Lab Console' });
    assert.equal(uri, `otpauth://totp/Lab%20Console:root?secret=${TEST_ADMIN.totpSecret}&issuer=Lab%20Console&algorithm=SHA1&digits=6&period=30`);
  });
});

// ── Passwords ───────────────────────────────────────────────────────────────

describe('password hashes', () => {
  test('hash then verify; a wrong, empty or oversized password is refused', async () => {
    const hash = await hashPassword('correct horse battery', { N: 16384, r: 8, p: 1 });
    assert.match(hash, /^scrypt:16384:8:1:[\w-]+:[\w-]+$/);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('correct horse batterz', hash), false);
    assert.equal(await verifyPassword('', hash), false);
    assert.equal(await verifyPassword(undefined, hash), false);
    assert.equal(await verifyPassword('x'.repeat(5000), hash), false);
    assert.notEqual(await hashPassword('correct horse battery', { N: 16384, r: 8, p: 1 }), hash, 'a new salt every time');
  });

  test('the test administrator\'s hash is really the hash of its password', async () => {
    assert.equal(await verifyPassword(TEST_ADMIN.password, TEST_ADMIN.passwordHash), true);
  });

  test('parseHash refuses what is not ours, or too cheap to be safe', () => {
    for (const bad of ['', 'secret', '$2b$10$abcdefghijklmnopqrstuv', 'scrypt:1024:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA',
      'scrypt:16385:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA', 'scrypt:16384:8:1:AA:AAAAAAAAAAAAAAAAAAAAAA', 'scrypt:16384:8:1:A$A:B']) {
      assert.equal(parseHash(bad), null, bad);
    }
    assert.ok(parseHash(TEST_ADMIN.passwordHash));
  });

  test('safeEqual compares strings of any length', () => {
    assert.equal(safeEqual('root', 'root'), true);
    assert.equal(safeEqual('root', 'roots'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual(undefined, ''), false);
  });
});

// ── Cookies and return paths ────────────────────────────────────────────────

describe('cookies', () => {
  test('names and flags: __Host- and Secure over https, plain names over http', () => {
    const https = cookieSettings('https://lab.example.org');
    assert.deepEqual({ ...https }, { secure: true, session: '__Host-lc_sid', login: '__Host-lc_login', device: '__Host-lc_device' });
    assert.equal(serializeCookie(https.session, 'abc', { secure: true }), '__Host-lc_sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure');
    const http = cookieSettings('http://127.0.0.1:3000');
    assert.deepEqual({ ...http }, { secure: false, session: 'lc_sid', login: 'lc_login', device: 'lc_device' });
    assert.equal(serializeCookie(http.session, 'abc', {}), 'lc_sid=abc; Path=/; HttpOnly; SameSite=Lax');
    assert.equal(clearCookie('lc_sid', {}), 'lc_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    assert.throws(() => serializeCookie('lc_sid', 'a;b'), TypeError);
  });

  test('readCookie: only the exact name matches', () => {
    const req = { headers: { cookie: 'xlc_sid=nope; lc_sid=yes; other=1' } };
    assert.equal(readCookie(req, 'lc_sid'), 'yes');
    assert.equal(readCookie(req, 'sid'), null);
    assert.equal(readCookie({ headers: {} }, 'lc_sid'), null);
    assert.equal(readCookie({ headers: { cookie: `lc_sid=${'a'.repeat(9000)}` } }, 'lc_sid'), null);
  });
});

describe('return paths: same-origin relative paths only (no open redirect)', () => {
  test('kept', () => {
    for (const ok of ['/', '/#/consoles', '/index.html?x=1', '/#/infra/vm/12']) assert.equal(safeReturnPath(ok), ok, ok);
  });
  test('anything that could leave the site, or loop, becomes "/"', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil', 'evil.example', 'javascript:alert(1)',
      '/%0d%0aSet-Cookie:x', '/\u0000', ' /x', '/login', '/login?next=/', '/auth/callback?code=x', null, undefined, 42, `/${'a'.repeat(600)}`]) {
      const kept = safeReturnPath(bad);
      assert.ok(kept === '/' || (kept.startsWith('/') && !kept.startsWith('//')), String(bad));
      if (typeof bad !== 'string' || !bad.startsWith('/%0d')) assert.equal(kept, '/', String(bad));
    }
  });
});

describe('pending sign-ins', () => {
  test('single use, short-lived, bounded', () => {
    const c = clock();
    const pending = createPendingLogins({ ttlMs: 10_000, max: 3, now: c.now });
    const id = pending.put({ state: 's' });
    assert.match(id, /^[\w-]{43}$/);
    assert.deepEqual(pending.take(id), { state: 's' });
    assert.equal(pending.take(id), null, 'taken once');
    const late = pending.put({ state: 'late' });
    c.advance(10_001);
    assert.equal(pending.take(late), null, 'expired');
    for (let i = 0; i < 10; i++) pending.put({ i });
    assert.ok(pending.size <= 3);
    assert.equal(pending.take('not-an-id'), null);
  });

  test('one client starting sign-ins in a loop only pushes out its own', () => {
    const c = clock();
    const pending = createPendingLogins({ max: 100, perOwner: 10, now: c.now });
    const real = pending.put({ who: 'student' }, { owner: '192.0.2.1' });
    const ids = [];
    for (let i = 0; i < 1000; i++) ids.push(pending.put({ i }, { owner: '203.0.113.66' }));
    assert.equal(pending.size, 11, 'ten for the noisy client, one for the student');
    assert.deepEqual(pending.take(real), { who: 'student' }, 'the real sign-in is still there');
    assert.equal(pending.take(ids[0]), null, 'the noisy client lost its oldest');
    assert.deepEqual(pending.take(ids.at(-1)), { i: 999 });
    // Many clients together are still bounded by max, the oldest giving way
    for (let i = 0; i < 300; i++) pending.put({ i }, { owner: `198.51.100.${i}` });
    assert.equal(pending.size, 100);
  });
});

// ── Attempt limiter ─────────────────────────────────────────────────────────

describe('login throttle', () => {
  test('per client: at most 5 attempts in 15 minutes, successful or not', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    for (let i = 0; i < 5; i++) {
      assert.equal(throttle.take({ client: '203.0.113.1', username: `u${i}` }).allowed, true);
      throttle.failed({ username: `u${i}` });
    }
    const refused = throttle.take({ client: '203.0.113.1', username: 'u9' });
    assert.deepEqual(refused, { allowed: false, scope: 'client', retryAfterSeconds: 900 });
    assert.equal(throttle.take({ client: '203.0.113.2', username: 'u9' }).allowed, true, 'another client is not affected');
    c.advance(15 * 60_000);
    assert.equal(throttle.take({ client: '203.0.113.1', username: 'u8' }).allowed, true, 'the window slides');
  });

  test('per user name: exponential backoff after two failures, from any address', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    const attempt = (n) => {
      const slot = throttle.take({ client: `198.51.100.${n}`, username: 'Root ' });
      if (slot.allowed) throttle.failed({ username: 'root' });
      return slot;
    };
    assert.equal(attempt(1).allowed, true);
    assert.equal(attempt(2).allowed, true);
    const waits = [];
    for (let n = 3; n < 9; n++) {
      const refused = attempt(n);
      assert.equal(refused.scope, 'name');
      waits.push(refused.retryAfterSeconds);
      c.advance(refused.retryAfterSeconds * 1000);
      assert.equal(attempt(n + 100).allowed, true);
    }
    assert.deepEqual(waits, [1, 2, 4, 8, 16, 32], 'doubles each time');
    // Keep failing as soon as allowed: the wait grows until it reaches the cap, and stays there
    let last = 0;
    for (let n = 0; n < 20; n++) {
      const refused = attempt(200 + n);
      assert.equal(refused.allowed, false);
      last = refused.retryAfterSeconds;
      c.advance(last * 1000);
      assert.equal(attempt(300 + n).allowed, true);
    }
    assert.equal(last, 15 * 60, 'capped at 15 minutes, and not reset by waiting it out');
    c.advance(15 * 60_000 + 15 * 60_000);
    assert.equal(attempt(999).allowed, true, 'quiet for a window after the backoff: it starts again');
    assert.equal(attempt(998).allowed, true);
    assert.equal(attempt(997).allowed, false);
  });

  test('per user name: one attempt in flight at a time; success starts again from zero', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    assert.equal(throttle.take({ client: 'a', username: 'root' }).allowed, true);
    assert.equal(throttle.take({ client: 'b', username: 'root' }).scope, 'name', 'parallel guess refused');
    throttle.failed({ username: 'root' });
    throttle.take({ client: 'c', username: 'root' });
    throttle.failed({ username: 'root' });
    assert.equal(throttle.take({ client: 'd', username: 'root' }).allowed, false);
    c.advance(1000);
    assert.equal(throttle.take({ client: 'd', username: 'root' }).allowed, true);
    throttle.succeeded({ client: 'd', username: 'root' });
    assert.equal(throttle.take({ client: 'e', username: 'root' }).allowed, true);
  });

  test('unknown and existing user names are limited exactly alike', () => {
    const run = (username) => {
      const c = clock();
      const throttle = createLoginThrottle({ now: c.now });
      const out = [];
      for (let i = 0; i < 6; i++) {
        const slot = throttle.take({ client: `c${i}`, username });
        out.push(slot);
        if (slot.allowed) throttle.failed({ username });
      }
      return out;
    };
    assert.deepEqual(run('root'), run('nobody-has-this-name'));
  });

  test('globally: at most 50 failures in 15 minutes, whatever the address and the name', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    for (let i = 0; i < 50; i++) {
      assert.equal(throttle.take({ client: `10.0.${i}.1`, username: `n${i}` }).allowed, true);
      throttle.failed({ username: `n${i}` });
    }
    assert.equal(throttle.take({ client: '10.9.9.9', username: 'fresh' }).scope, 'global');
    c.advance(15 * 60_000);
    assert.equal(throttle.take({ client: '10.9.9.9', username: 'fresh' }).allowed, true);
  });

  test('a known browser is neither refused by the name\'s backoff nor by the global count', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    const fail = (client, username) => {
      const slot = throttle.take({ client, username });
      if (slot.allowed) throttle.failed({ client, username });
      return slot;
    };
    // A stranger keeps the name at its longest backoff, and fills the global count
    for (let i = 0; i < 12; i++) { fail(`198.51.100.${i}`, 'root'); c.advance(16 * 60_000); }
    for (let i = 0; i < 50; i++) fail(`10.1.${i}.1`, `n${i}`);
    assert.equal(throttle.take({ client: '192.0.2.1', username: 'root' }).allowed, false, 'a new browser is kept out');

    const slot = throttle.take({ client: '192.0.2.1', username: 'root', device: 'browser-a' });
    assert.equal(slot.allowed, true, 'the known browser gets in');
    throttle.succeeded({ client: '192.0.2.1', username: 'root', device: 'browser-a' });
    assert.equal(throttle.take({ client: '192.0.2.9', username: 'root' }).allowed, false, 'its success gives strangers no fresh tries');
  });

  test('a known browser is still limited on its own: backoff, one in flight, 5 per window', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    const device = 'browser-a';
    const at = (n) => ({ client: `192.0.2.${n}`, username: 'root', device });
    assert.equal(throttle.take(at(1)).allowed, true);
    assert.deepEqual(throttle.take(at(2)), { allowed: false, scope: 'device', retryAfterSeconds: 1 }, 'one in flight');
    throttle.failed(at(1));
    assert.equal(throttle.take(at(1)).allowed, true);
    throttle.failed(at(1));
    assert.deepEqual(throttle.take(at(3)), { allowed: false, scope: 'device', retryAfterSeconds: 1 }, 'backoff, whatever the address');
    assert.equal(throttle.take({ client: '192.0.2.4', username: 'root' }).allowed, true, 'its failures are not the name\'s');
    throttle.failed({ client: '192.0.2.4', username: 'root' });
    c.advance(1000);
    assert.equal(throttle.take(at(1)).allowed, true);
    throttle.succeeded(at(1));
    assert.equal(throttle.take(at(1)).allowed, true);
    throttle.succeeded(at(1));
    for (let i = 0; i < 5; i++) { assert.equal(throttle.take(at(1)).allowed, true); throttle.succeeded(at(1)); }
    assert.equal(throttle.take({ client: '192.0.2.1', username: 'root', device: 'browser-b' }).allowed, true, 'another browser has its own count');
  });
});

// ── Known browsers ──────────────────────────────────────────────────────────

describe('known-browser cookies', () => {
  const key = Buffer.alloc(32, 7);

  test('valid for the name it was issued for, and nothing else', () => {
    const c = clock();
    const devices = createDeviceCookies({ key, now: c.now });
    const value = devices.issue('root');
    assert.match(value, /^[\w-]{71}$/);
    assert.ok(!Buffer.from(value, 'base64url').includes('root'), 'the name is not in the cookie');
    const id = devices.check(value, 'root');
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(devices.check(value, ' ROOT '), id, 'the name as a person types it');
    assert.notEqual(devices.check(devices.issue('root'), 'root'), id, 'one id per issue');
    assert.equal(devices.check(value, 'admin'), null, 'another name');
    assert.equal(devices.check(value, ''), null);
    for (const bad of [undefined, '', 'x'.repeat(71), value.slice(0, -1), `${value}A`]) assert.equal(devices.check(bad, 'root'), null, String(bad));
    const raw = Buffer.from(value, 'base64url');
    raw[3] ^= 1; // a later issue date
    assert.equal(devices.check(raw.toString('base64url'), 'root'), null, 'tampered');
  });

  test('expires after 180 days, and only counts with the key it was signed with', () => {
    const c = clock();
    const devices = createDeviceCookies({ key, now: c.now });
    const value = devices.issue('root');
    c.advance(DEVICE_MAX_AGE_MS - 1000);
    assert.ok(devices.check(value, 'root'));
    c.advance(1000);
    assert.equal(devices.check(value, 'root'), null, '180 days');
    const fresh = devices.issue('root');
    assert.equal(createDeviceCookies({ key: Buffer.alloc(32, 8), now: c.now }).check(fresh, 'root'), null, 'another key');
  });

  test('the key is a secret of its own in the database: it survives a restart and a change of the administrator\'s credentials', () => withDb(async ({ db, repos }) => {
    const c = clock();
    const first = await loadDeviceKey({ state: repos.authState });
    assert.equal(first.length, 32);
    const rows = await db.query('SELECT name, data FROM auth_state');
    assert.deepEqual(rows.map((r) => r.name), ['device-key']);
    assert.deepEqual(Object.keys(JSON.parse(rows[0].data)), ['key']);
    for (const secret of [TEST_ADMIN.passwordHash, TEST_ADMIN.totpSecret]) assert.ok(!rows[0].data.includes(secret));
    assert.notDeepEqual(first, adminDerivedKey(TEST_ADMIN, 'session binding'));

    // A restart reads the same key, whatever the administrator's credentials are now
    const value = createDeviceCookies({ key: first, now: c.now }).issue('root');
    const restarted = await loadDeviceKey({ state: repos.authState });
    assert.deepEqual(restarted, first);
    assert.ok(createDeviceCookies({ key: restarted, now: c.now }).check(value, 'root'));

    // Deleting the value forgets every known browser; a damaged value is replaced
    await db.run('DELETE FROM auth_state WHERE name = ?', ['device-key']);
    const fresh = await loadDeviceKey({ state: repos.authState });
    assert.notDeepEqual(fresh, first);
    assert.equal(createDeviceCookies({ key: fresh, now: c.now }).check(value, 'root'), null);
    const warnings = [];
    await repos.authState.set('device-key', { key: 'short' });
    const replaced = await loadDeviceKey({ state: repos.authState, logger: { warn: (m) => warnings.push(m), error() {} } });
    assert.equal(replaced.length, 32);
    assert.equal(warnings.length, 1);
    assert.deepEqual(await loadDeviceKey({ state: repos.authState }), replaced, 'and the replacement is saved');
  }));

  test('an unreadable key is never overwritten: a key for this run only', () => withDb(async ({ db, repos }) => {
    await db.run('INSERT INTO auth_state (name, data, updated_at) VALUES (?, ?, ?)', ['device-key', '{not json', '2026-11-12T09:00:00.000Z']);
    const errors = [];
    const key = await loadDeviceKey({ state: repos.authState, logger: { warn() {}, error: (m) => errors.push(m) } });
    assert.equal(key.length, 32);
    assert.equal(errors.length, 1);
    assert.equal((await db.get('SELECT data FROM auth_state WHERE name = ?', ['device-key'])).data, '{not json');
  }));

  test('a key that cannot be saved still works for this run, and says so', async () => {
    const errors = [];
    const state = { get: async () => undefined, set: async () => { throw new Error('disk full'); } };
    const key = await loadDeviceKey({ state, logger: { warn() {}, error: (m) => errors.push(m) } });
    assert.equal(key.length, 32);
    assert.match(errors.join(), /could not be saved \(disk full\)/);
  });
});

// ── Refusals anyone can send for free ───────────────────────────────────────

describe('aggregated refusals', () => {
  const recorder = () => {
    const entries = [];
    return { entries, audit: { log: (actor, action, details) => { entries.push({ actor, action, details }); return Promise.resolve(true); } } };
  };

  test('one entry per client and kind per window, then one summary', () => {
    const c = clock();
    const { entries, audit } = recorder();
    const refusals = createRefusalAudit({ audit, now: c.now });
    for (let i = 0; i < 2000; i++) refusals.record({}, '203.0.113.5', 'no_pending_login', { reason: 'no_pending_login' });
    for (let i = 0; i < 500; i++) refusals.record({}, '203.0.113.5', 'throttled:client', { reason: 'throttled' });
    refusals.record({}, '198.51.100.1', 'no_pending_login', { reason: 'no_pending_login' });
    assert.deepEqual(entries.map((e) => [e.action, e.details.reason]), [
      ['auth.login.failed', 'no_pending_login'], ['auth.login.failed', 'throttled'], ['auth.login.failed', 'no_pending_login'],
    ]);
    refusals.flush();
    assert.equal(entries.length, 3, 'nothing more inside the window');
    c.advance(15 * 60_000);
    refusals.flush();
    const summary = entries.at(-1);
    assert.equal(summary.actor, 'system');
    assert.equal(summary.action, 'auth.login.suppressed');
    assert.equal(summary.details.count, 1999 + 499);
    assert.deepEqual(summary.details.top, [
      { ip: '203.0.113.5', reason: 'no_pending_login', count: 1999 }, { ip: '203.0.113.5', reason: 'throttled:client', count: 499 },
    ]);
    refusals.record({}, '203.0.113.5', 'no_pending_login', {});
    assert.equal(entries.at(-1).action, 'auth.login.failed', 'a new window audits that client again');
  });

  test('a crowd of addresses is bounded too', () => {
    const c = clock();
    const { entries, audit } = recorder();
    const refusals = createRefusalAudit({ audit, now: c.now, maxKeys: 100 });
    for (let i = 0; i < 5000; i++) refusals.record({}, `2001:db8::${i.toString(16)}`, 'throttled:global', {});
    assert.equal(entries.length, 100);
    refusals.flush({ force: true });
    assert.equal(entries.length, 101);
    assert.equal(entries.at(-1).details.otherClients, 4900);
    assert.equal(entries.at(-1).details.count, 4900);
    refusals.flush({ force: true });
    assert.equal(entries.length, 101, 'an empty window writes nothing');
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

describe('sessions', () => {
  test('create / find: a 256-bit token, a public id, the user back', () => withDb(async ({ repos }) => {
    const sessions = await createSessionStore({ repo: repos.sessions });
    const { token, session } = sessions.create(student(1), { ip: '203.0.113.5', userAgent: 'Firefox' });
    assert.match(token, /^[\w-]{43}$/);
    assert.notEqual(session.id, token);
    assert.equal(sessions.find(token).user.id, 'oidc:student1');
    assert.equal(sessions.find('x'.repeat(43)), null);
    assert.equal(sessions.find(undefined), null);
    const [listed] = sessions.list();
    assert.deepEqual(Object.keys(listed).sort(), ['connections', 'createdAt', 'expiresAt', 'id', 'ip', 'lastSeenAt', 'user', 'userAgent']);
    assert.ok(!JSON.stringify(listed).includes(token), 'a listing never shows a token');
    return sessions.shutdown();
  }));

  test('expiry: 8 hours idle, 24 hours at most, whatever the activity', () => withDb(async ({ repos }) => {
    const c = clock();
    const ended = [];
    const sessions = await createSessionStore({ repo: repos.sessions, now: c.now, onEnd: (s, reason) => ended.push(reason) });
    assert.equal(SESSION_IDLE_MS, 8 * 3600_000);
    assert.equal(SESSION_ABSOLUTE_MS, 24 * 3600_000);

    const idle = sessions.create(student(1)).token;
    c.advance(SESSION_IDLE_MS - 1000);
    assert.ok(sessions.find(idle), 'still alive just before the idle limit, and refreshed');
    c.advance(SESSION_IDLE_MS - 1000);
    assert.ok(sessions.find(idle), 'activity postpones the idle limit');
    c.advance(SESSION_IDLE_MS);
    assert.equal(sessions.find(idle), null, 'idle for 8 hours: gone');

    const busy = sessions.create(student(2)).token;
    for (let h = 0; h < 23; h++) { c.advance(3600_000); assert.ok(sessions.find(busy), `hour ${h + 1}`); }
    c.advance(3600_000);
    assert.equal(sessions.find(busy), null, 'used every hour, still ends after 24 hours');
    assert.deepEqual(ended, ['expired', 'expired']);

    const peeked = sessions.create(student(3)).token;
    c.advance(SESSION_IDLE_MS - 1000);
    assert.ok(sessions.peek(peeked));
    c.advance(2000);
    assert.equal(sessions.peek(peeked), null, 'peek does not count as activity');
    return sessions.shutdown();
  }));

  test('the sweep ends expired sessions on its own and closes their sockets', () => withDb(async ({ repos }) => {
    const c = clock();
    const ended = [];
    const sessions = await createSessionStore({ repo: repos.sessions, now: c.now, onEnd: (s, reason) => ended.push([s.user.id, reason]) });
    const { token } = sessions.create(student(1));
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); } });
    sessions.trackSocket(token, socket);
    c.advance(SESSION_IDLE_MS + 1);
    assert.equal(sessions.sweep(), 0, 'an open console is activity');
    assert.equal(socket.destroyed, false);
    c.advance(SESSION_ABSOLUTE_MS);
    assert.equal(sessions.sweep(), 1, 'but never past the absolute limit');
    assert.equal(socket.destroyed, true);
    assert.deepEqual(ended, [['oidc:student1', 'expired']]);
    return sessions.shutdown();
  }));

  test('rotation: a new token for the same session, the old one stops working', () => withDb(async ({ repos }) => {
    const sessions = await createSessionStore({ repo: repos.sessions });
    const { token, session } = sessions.create(student(1));
    const rotated = sessions.rotate(token);
    assert.notEqual(rotated, token);
    assert.equal(sessions.find(token), null);
    assert.equal(sessions.find(rotated).id, session.id);
    assert.equal(sessions.rotate(token), null);
    return sessions.shutdown();
  }));

  test('revocation: by id, by user, by token; sockets are destroyed; the hook is told', () => withDb(async ({ repos }) => {
    const ended = [];
    const sessions = await createSessionStore({ repo: repos.sessions, onEnd: (s, reason) => ended.push([s.user.id, reason]) });
    const a = sessions.create(student(1));
    const b = sessions.create(student(1));
    const c = sessions.create(student(2));
    const d = sessions.create(admin());
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); } });
    sessions.trackSocket(c.token, socket);

    assert.equal(sessions.revoke(c.session.id), true);
    assert.equal(socket.destroyed, true);
    assert.equal(sessions.find(c.token), null);
    assert.equal(sessions.revoke(c.session.id), false);
    assert.equal(sessions.revokeUser('oidc:student1'), 2);
    assert.equal(sessions.find(a.token), null);
    assert.equal(sessions.find(b.token), null);
    assert.equal(sessions.end(d.token), true);
    assert.equal(sessions.size, 0);
    assert.deepEqual(ended, [['oidc:student2', 'revoked'], ['oidc:student1', 'revoked'], ['oidc:student1', 'revoked'], ['oidc:admin', 'logout']]);
    return sessions.shutdown();
  }));

  test('a socket opened with an unknown or ended session is destroyed at once', () => withDb(async ({ repos }) => {
    const sessions = await createSessionStore({ repo: repos.sessions });
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
    sessions.trackSocket('y'.repeat(43), socket);
    assert.equal(socket.destroyed, true);
    return sessions.shutdown();
  }));

  test('at most 10 sessions per user: the least recently used gives way', () => withDb(async ({ repos }) => {
    const c = clock();
    const sessions = await createSessionStore({ repo: repos.sessions, now: c.now });
    const tokens = [];
    for (let i = 0; i < 11; i++) { tokens.push(sessions.create(student(1)).token); c.advance(1000); }
    assert.equal(sessions.size, 10);
    assert.equal(sessions.find(tokens[0]), null);
    assert.ok(sessions.find(tokens[10]));
    return sessions.shutdown();
  }));

  test('persistence: a restart keeps everyone signed in; the database holds hashes, never tokens', () => withDb(async ({ db, repos }) => {
    const first = await createSessionStore({ repo: repos.sessions });
    const { token, session } = first.create(student(1, { email: 's1@example.test' }), { ip: '203.0.113.9', idToken: 'header.payload.signature' });
    const revoked = first.create(student(2));
    first.revoke(revoked.session.id);
    assert.equal(await first.shutdown(), true);

    const rows = await db.query('SELECT * FROM auth_sessions');
    const raw = JSON.stringify(rows);
    assert.ok(!raw.includes(token), 'the token is not stored');
    assert.ok(!raw.includes('header.payload.signature'), 'nor the ID token');
    assert.equal(rows.length, 1);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].created_at, new Date(session.createdAt).toISOString(), 'times are ISO-8601 text');
    assert.deepEqual(JSON.parse(rows[0].user_data), { id: 'oidc:student1', username: 'student1', name: 'Student 1', email: 's1@example.test', role: 'student', groups: ['students'], via: 'oidc' });

    const restarted = await createSessionStore({ repo: repos.sessions });
    const found = restarted.find(token);
    assert.equal(found.id, session.id);
    assert.equal(found.user.email, 's1@example.test');
    assert.equal(Object.isFrozen(found.user), true);
    assert.equal(restarted.find(revoked.token), null);
    await restarted.shutdown();
  }));

  test('persistence: a rotation, an expiry and the last activity are written too', () => withDb(async ({ db, repos }) => {
    const c = clock();
    const first = await createSessionStore({ repo: repos.sessions, now: c.now });
    const rotatedFrom = first.create(student(1)).token;
    const rotated = first.rotate(rotatedFrom);
    const stale = first.create(student(2)).token;
    c.advance(SESSION_IDLE_MS / 2);
    assert.ok(first.find(rotated), 'activity');
    c.advance(SESSION_IDLE_MS / 2 + 1);
    assert.equal(first.sweep(), 1, 'the untouched one expired');
    assert.equal(stale.length, 43);
    await first.shutdown();
    const [row] = await db.query('SELECT last_seen_at FROM auth_sessions');
    assert.equal(row.last_seen_at, new Date(c.ms - SESSION_IDLE_MS / 2 - 1).toISOString(), 'the activity was saved at shutdown');

    const restarted = await createSessionStore({ repo: repos.sessions, now: c.now });
    assert.ok(restarted.find(rotated));
    assert.equal(restarted.find(rotatedFrom), null);
    assert.equal(restarted.size, 1);
    await restarted.shutdown();
  }));

  test('persistence: sessions that expired while the service was stopped are not restored, and are removed', () => withDb(async ({ db, repos }) => {
    const c = clock();
    const first = await createSessionStore({ repo: repos.sessions, now: c.now });
    const { token } = first.create(student(1));
    await first.shutdown();
    c.advance(SESSION_IDLE_MS);
    const restarted = await createSessionStore({ repo: repos.sessions, now: c.now });
    assert.equal(restarted.find(token), null);
    await restarted.shutdown();
    assert.equal((await db.query('SELECT id FROM auth_sessions')).length, 0);
  }));

  test('credential binding: a session opened with credentials that changed since is not restored', () => withDb(async ({ db, repos }) => {
    const local = createUser({ id: 'local:root', username: 'root', name: 'root', role: 'admin', via: 'local' });
    const first = await createSessionStore({ repo: repos.sessions, bindingOf: (u) => (u.id === 'local:root' ? 'binding-1' : undefined) });
    const kept = first.create(student(1));
    const admin1 = first.create(local);
    await first.shutdown();
    const saved = await db.query('SELECT user_id, binding FROM auth_sessions ORDER BY user_id');
    assert.deepEqual(saved.map((r) => [r.user_id, r.binding]), [['local:root', 'binding-1'], ['oidc:student1', null]]);

    const same = await createSessionStore({ repo: repos.sessions, bindingOf: (u) => (u.id === 'local:root' ? 'binding-1' : undefined) });
    assert.ok(same.find(admin1.token), 'same credentials: restored');
    await same.shutdown();

    const warnings = [];
    const rotated = await createSessionStore({
      repo: repos.sessions, logger: { warn: (m) => warnings.push(m), error() {} },
      bindingOf: (u) => (u.id === 'local:root' ? 'binding-2' : undefined),
    });
    assert.equal(rotated.find(admin1.token), null, 'rotated credentials: gone');
    assert.ok(rotated.find(kept.token), 'other people are not concerned');
    assert.match(warnings.join(), /1 saved session\(s\) not restored/);
    await rotated.shutdown();

    const renamed = await createSessionStore({ repo: repos.sessions, bindingOf: (u) => (u.id === 'local:admin2' ? 'binding-2' : undefined) });
    assert.equal(renamed.size, 1, 'the row was removed');
    assert.equal((await db.query('SELECT id FROM auth_sessions')).length, 1);
    await renamed.shutdown();
  }));

  test('a damaged session record signs that session out instead of failing', () => withDb(async ({ db, repos }) => {
    const at = '2026-11-12T09:00:00.000Z';
    const later = '2099-01-01T00:00:00.000Z';
    const insert = (id, hash, userData, created = at) => db.run(
      'INSERT INTO auth_sessions (id, token_hash, user_id, user_data, created_at, last_seen_at, expires_at, ip, user_agent, binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, hash, 'u', userData, created, '2099-01-01T00:00:00.000Z', later, '', '', null],
    );
    await insert('bad-role', 'a'.repeat(64), JSON.stringify({ id: 'u', via: 'oidc', role: 'god' }));
    await insert('bad-json', 'b'.repeat(64), '{not json');
    await insert('bad-hash', 'nothex', JSON.stringify({ id: 'u', via: 'oidc', role: 'student' }));
    await insert('bad-time', 'c'.repeat(64), JSON.stringify({ id: 'u', via: 'oidc', role: 'student' }), 'yesterday');
    const sessions = await createSessionStore({ repo: repos.sessions });
    assert.equal(sessions.size, 0);
    await sessions.shutdown();
    assert.equal((await db.query('SELECT id FROM auth_sessions')).length, 0, 'and the records are gone');
  }));

  test('a database that refuses writes never breaks a sign-in, and says so', async () => {
    const errors = [];
    const failing = () => Promise.reject(new Error('SQLITE_FULL'));
    const repo = { all: async () => [], insert: failing, remove: failing, rehash: failing, touchAll: failing };
    const sessions = await createSessionStore({ repo, logger: { warn() {}, error: (m) => errors.push(m) } });
    const { token } = sessions.create(student(1));
    assert.ok(sessions.find(token));
    assert.ok(sessions.rotate(token));
    assert.equal(sessions.revokeUser('oidc:student1'), 1);
    assert.equal(await sessions.shutdown(), false);
    assert.deepEqual(errors.map((m) => m.match(/\(([a-z-]+)\)/)[1]), ['sign-in', 'rotation', 'end']);
  });

  test('an unreadable sessions table signs everyone out instead of failing', async () => {
    const errors = [];
    const sessions = await createSessionStore({ repo: { all: () => Promise.reject(new Error('locked')) }, logger: { warn() {}, error: (m) => errors.push(m) } });
    assert.equal(sessions.size, 0);
    assert.match(errors.join(), /everyone has to sign in again/);
    await sessions.shutdown();
  });

  test('the store needs its repository', async () => {
    await assert.rejects(createSessionStore({}), /sessions repository/);
  });
});

// ── Account providers ───────────────────────────────────────────────────────

describe('account providers', () => {
  test('the administrator of the environment: user name, password and code together', () => withDb(async ({ repos }) => {
    const c = clock();
    const provider = await createEnvAdminProvider({ settings: TEST_ADMIN, state: repos.authState, now: c.now });
    assert.equal(provider.id, 'env-admin');
    const ok = await provider.verify({ username: 'root', password: TEST_ADMIN.password, code: adminCode(c.ms) });
    assert.equal(ok.user.id, 'local:root');
    assert.equal(ok.user.role, 'admin');
    assert.equal(ok.user.via, 'local');
    c.advance(30_000);
    assert.equal(await provider.verify({ username: 'Root', password: TEST_ADMIN.password, code: adminCode(c.ms) }), null, 'the name is exact');
    assert.equal(await provider.verify({ username: 'root', password: 'wrong-password', code: adminCode(c.ms) }), null);
    assert.equal(await provider.verify({ username: 'root', password: TEST_ADMIN.password, code: '000000' }), null);
    assert.equal(await provider.verify({ username: 'root', password: TEST_ADMIN.password }), null);
    assert.ok(await provider.verify({ username: 'root', password: TEST_ADMIN.password, code: adminCode(c.ms) }), 'failures burn nothing');
  }));

  test('an accepted code is dead, even after a restart', () => withDb(async ({ repos }) => {
    const c = clock();
    const code = adminCode(c.ms);
    const provider = await createEnvAdminProvider({ settings: TEST_ADMIN, state: repos.authState, now: c.now });
    assert.ok(await provider.verify({ username: 'root', password: TEST_ADMIN.password, code }));
    assert.equal(await provider.verify({ username: 'root', password: TEST_ADMIN.password, code }), null);
    assert.deepEqual(await repos.authState.get('local-admin'), { lastTotpStep: Math.floor(c.ms / 30_000) });
    const restarted = await createEnvAdminProvider({ settings: TEST_ADMIN, state: repos.authState, now: c.now });
    assert.equal(await restarted.verify({ username: 'root', password: TEST_ADMIN.password, code }), null);
  }));

  test('the registry asks every provider; exactly one must recognise the credentials', async () => {
    const asked = [];
    const provider = (id, answer) => ({ id, verify: async (cred) => { asked.push(id); return answer(cred); } });
    const one = createUser({ id: 'local:alice', username: 'alice', via: 'local' });
    const registry = createAccountProviders([provider('a', () => null)]);
    const remove = registry.add(provider('b', (cred) => (cred.username === 'alice' ? { user: one } : null)));
    assert.deepEqual(registry.ids, ['a', 'b']);
    assert.equal(await registry.verify({ username: 'alice' }), one);
    assert.deepEqual(asked, ['a', 'b']);
    asked.length = 0;
    assert.equal(await registry.verify({ username: 'bob' }), null);
    assert.deepEqual(asked, ['a', 'b'], 'every provider is asked for an unknown name too');

    registry.add(provider('c', () => ({ user: one })));
    assert.equal(await registry.verify({ username: 'alice' }), null, 'two providers claiming the same person: refused');
    remove();
    assert.deepEqual(registry.ids, ['a', 'c']);
    registry.add(provider('d', () => { throw new Error('disk on fire'); }));
    assert.equal(await registry.verify({ username: 'alice' }), one, 'a broken provider counts as "no"');
    registry.add(provider('e', () => ({ user: one, requires: ['passkey'] })));
    assert.equal(await registry.verify({ username: 'alice' }), null, 'a further step this build cannot offer is a refusal');
    assert.throws(() => registry.add(provider('a', () => null)), /already registered/);
    assert.throws(() => registry.add({ id: 'x' }), TypeError);
  });
});

// ── Users, roles, claims ────────────────────────────────────────────────────

describe('users and roles', () => {
  test('createUser builds the frozen User of ARCHITECTURE §5', () => {
    const user = createUser({ id: 'oidc:abc', username: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', role: 'admin', groups: ['g'], via: 'oidc' });
    assert.deepEqual(Object.keys(user).sort(), ['color', 'email', 'groups', 'id', 'initials', 'name', 'role', 'username', 'via']);
    assert.equal(user.initials, 'AL');
    assert.equal(user.color, colorOf('oidc:abc'));
    assert.ok(Object.isFrozen(user) && Object.isFrozen(user.groups));
    assert.throws(() => createUser({ id: 'x', via: 'oidc', role: 'root' }), TypeError);
    assert.throws(() => createUser({ id: 'x' }), TypeError);
    assert.equal(initialsOf('curtis'), 'CU');
    assert.equal(initialsOf(''), '?');
    assert.deepEqual(ROLES, ['student', 'admin']);
    assert.equal(hasRole(admin(), 'student'), true);
    assert.equal(hasRole(student(1), 'admin'), false);
    assert.equal(hasRole(null, 'student'), false);
    assert.equal(hasRole(student(1), 'nope'), false);
  });

  test('resolveRole: admin groups, else student; a stored role wins', () => {
    assert.equal(resolveRole({ groups: ['students'], adminGroups: ['admins'] }), 'student');
    assert.equal(resolveRole({ groups: ['students', 'admins'], adminGroups: ['admins'] }), 'admin');
    assert.equal(resolveRole({ groups: ['Admins'], adminGroups: ['admins'] }), 'student', 'case-sensitive');
    assert.equal(resolveRole({ groups: [], adminGroups: [] }), 'student');
    assert.equal(resolveRole({ groups: ['admins'], adminGroups: ['admins'], storedRole: 'student' }), 'student');
    assert.equal(resolveRole({ groups: [], adminGroups: [], storedRole: 'admin' }), 'admin');
    assert.equal(resolveRole({ groups: [], adminGroups: [], storedRole: 'root' }), 'student', 'an unknown stored role is ignored');
  });

  test('isAllowed: everybody without a list; else a listed group or an admin group', () => {
    assert.equal(isAllowed({ groups: [], allowedGroups: [] }), true);
    assert.equal(isAllowed({ groups: ['students'], allowedGroups: ['rt1'] }), false);
    assert.equal(isAllowed({ groups: ['rt1'], allowedGroups: ['rt1'] }), true);
    assert.equal(isAllowed({ groups: ['admins'], allowedGroups: ['rt1'], adminGroups: ['admins'] }), true);
  });
});

describe('claims', () => {
  const settings = { groupsClaim: 'groups', adminGroups: ['admins'], allowedGroups: [] };

  test('readClaim: a literal name first, then a dotted path', () => {
    const claims = { 'https://x/groups': ['a'], realm_access: { roles: ['r'] }, 'a.b': 1, a: { b: 2 } };
    assert.deepEqual(readClaim(claims, 'https://x/groups'), ['a']);
    assert.deepEqual(readClaim(claims, 'realm_access.roles'), ['r']);
    assert.equal(readClaim(claims, 'a.b'), 1);
    assert.equal(readClaim(claims, 'realm_access.nope'), undefined);
    assert.equal(readClaim(claims, '__proto__.polluted'), undefined);
    assert.equal(readClaim(null, 'x'), undefined);
  });

  test('toGroups: arrays, a single string, a comma list; null when absent', () => {
    assert.deepEqual(toGroups(['a', ' b ', 'a', 3, '']), ['a', 'b']);
    assert.deepEqual(toGroups('admins'), ['admins']);
    assert.deepEqual(toGroups('students,admins'), ['students', 'admins']);
    assert.equal(toGroups(undefined), null);
    assert.deepEqual(toGroups({ x: 1 }), []);
    assert.equal(toGroups(Array.from({ length: 500 }, (_, i) => `g${i}`)).length, 200);
  });

  test('groupsFrom: the ID token first, userinfo as a fallback', () => {
    assert.deepEqual(groupsFrom({ groups: ['a'] }, { groups: ['b'] }, 'groups'), ['a']);
    assert.deepEqual(groupsFrom({}, { groups: ['b'] }, 'groups'), ['b']);
    assert.deepEqual(groupsFrom({}, null, 'groups'), []);
  });

  test('userFromClaims: who, which role, allowed or not', () => {
    const idClaims = { sub: 'abc', preferred_username: 'alice', name: 'Alice Martin', email: 'alice@example.test', groups: ['students', 'admins'] };
    const { allowed, user } = userFromClaims({ idClaims, settings });
    assert.equal(allowed, true);
    assert.deepEqual({ id: user.id, username: user.username, name: user.name, role: user.role, via: user.via, groups: [...user.groups] },
      { id: 'oidc:abc', username: 'alice', name: 'Alice Martin', role: 'admin', via: 'oidc', groups: ['students', 'admins'] });
    assert.equal(userFromClaims({ idClaims: { sub: 'x', email: 'e@x' }, settings }).user.username, 'e@x');
    assert.equal(userFromClaims({ idClaims: { sub: 'x', given_name: 'Ada', family_name: 'L' }, settings }).user.name, 'Ada L');
    assert.deepEqual(userFromClaims({ idClaims: { sub: 'x', groups: ['b'] }, settings: { ...settings, allowedGroups: ['a'] } }), { allowed: false, username: 'x', groups: ['b'] });
    assert.throws(() => userFromClaims({ idClaims: {}, settings }), TypeError);
  });

  test('needsUserinfo: when the ID token has no groups claim or no name at all', () => {
    assert.equal(needsUserinfo({ sub: 'x', name: 'n', groups: [] }, 'groups'), false);
    assert.equal(needsUserinfo({ sub: 'x', name: 'n' }, 'groups'), true);
    assert.equal(needsUserinfo({ sub: 'x', groups: ['a'] }, 'groups'), true);
  });
});

// ── OIDC settings ───────────────────────────────────────────────────────────

describe('OIDC settings', () => {
  test('defaults; disabled without an issuer', () => {
    const { settings, problems } = normalizeOidcSettings({});
    assert.deepEqual(problems, []);
    assert.equal(settings.enabled, false);
    assert.deepEqual(settings.scopes, ['openid', 'profile', 'email', 'groups']);
    assert.equal(settings.groupsClaim, 'groups');
    assert.equal(settings.providerName, 'SSO');
    assert.equal(settings.clientAuthMethod, 'client_secret_basic');
  });

  test('a complete provider', () => {
    const { settings, problems } = normalizeOidcSettings({
      issuer: 'https://id.example.org/realms/lab/', clientId: 'lab', clientSecret: 's', scopes: 'openid,profile  email',
      groupsClaim: 'realm_access.roles', adminGroups: 'admins, teachers', allowedGroups: ['rt1'], providerName: 'Keycloak',
    });
    assert.deepEqual(problems, []);
    assert.equal(settings.issuer, 'https://id.example.org/realms/lab/', 'kept as given: issuers are compared exactly');
    assert.deepEqual(settings.scopes, ['openid', 'profile', 'email']);
    assert.deepEqual(settings.adminGroups, ['admins', 'teachers']);
    assert.deepEqual(settings.allowedGroups, ['rt1']);
  });

  test('refusals', () => {
    const problemsOf = (raw) => normalizeOidcSettings(raw).problems.join('\n');
    assert.match(problemsOf({ clientId: 'x' }), /OIDC_ISSUER is empty/);
    assert.match(problemsOf({ issuer: 'id.example.org', clientId: 'x' }), /must be the provider's issuer URL/);
    assert.match(problemsOf({ issuer: 'http://id.example.org', clientId: 'x' }), /must use https/);
    assert.equal(problemsOf({ issuer: 'http://id.example.org', clientId: 'x', allowInsecure: true }), '');
    assert.equal(problemsOf({ issuer: 'http://127.0.0.1:9100', clientId: 'x' }), '', 'loopback: the mock provider');
    assert.match(problemsOf({ issuer: 'https://id.example.org' }), /OIDC_CLIENT_ID is required/);
    assert.match(problemsOf({ issuer: 'https://id.example.org', clientId: 'x', scopes: 'profile email' }), /must include "openid"/);
    assert.match(problemsOf({ issuer: 'https://id.example.org', clientId: 'x', providerName: 'x'.repeat(41) }), /40 characters/);
    assert.match(problemsOf({ issuer: 'https://id.example.org', clientId: 'x', clientAuthMethod: 'private_key_jwt' }), /OIDC_CLIENT_AUTH_METHOD/);
    assert.match(problemsOf({ issuer: 'https://id.example.org', clientId: 'x', groupsClaim: 'a b' }), /OIDC_GROUPS_CLAIM/);
  });
});
