/**
 * The building blocks of the sign-in, one by one: TOTP and HOTP against the
 * RFC test vectors, password hashes, cookies, return paths, the attempt
 * limiter and known browsers, aggregated refusals, sessions (expiry,
 * rotation, revocation, persistence, credential binding), account providers, roles and claims, OIDC settings
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { createStore } from '../src/lib/store.js';
import { student, admin } from './helpers/fakes.js';
import { tempDataDir, TEST_ADMIN, adminCode } from './helpers/app.js';

const clock = (ms = Date.UTC(2026, 10, 12, 9, 0, 0)) => {
  const c = { ms, now: () => c.ms, advance: (delta) => { c.ms += delta; } };
  return c;
};

function withStore(fn) {
  const dir = tempDataDir();
  const store = createStore(dir);
  return Promise.resolve(fn(store, dir)).finally(async () => {
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

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
    assert.deepEqual({ ...https }, { secure: true, session: '__Host-lc_sid', login: '__Host-lc_login', device: '__Host-lc_device', step: '__Host-lc_step' });
    assert.equal(serializeCookie(https.session, 'abc', { secure: true }), '__Host-lc_sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure');
    const http = cookieSettings('http://127.0.0.1:3000');
    assert.deepEqual({ ...http }, { secure: false, session: 'lc_sid', login: 'lc_login', device: 'lc_device', step: 'lc_step' });
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

  test('globally: past 50 failures in 15 minutes, a name that failed itself waits; a name nobody failed on still gets in', () => {
    const c = clock();
    const throttle = createLoginThrottle({ now: c.now });
    for (let i = 0; i < 50; i++) {
      assert.equal(throttle.take({ client: `10.0.${i}.1`, username: `n${i}` }).allowed, true);
      throttle.failed({ username: `n${i}` });
    }
    // A stranger's failures on names they made up never refuse an account they never tried
    const fresh = throttle.take({ client: '10.9.9.9', username: 'fresh' });
    assert.equal(fresh.allowed, true, 'a name with no failure of its own');
    throttle.succeeded({ client: '10.9.9.9', username: 'fresh' });
    // Guesses spread over many names: each one gets one try, then waits for the count to go down
    assert.equal(throttle.take({ client: '10.9.9.10', username: 'other' }).allowed, true);
    throttle.failed({ username: 'other' });
    const again = throttle.take({ client: '10.9.9.11', username: 'other' });
    assert.equal(again.scope, 'global', 'its first failure is enough while the count is full');
    assert.equal(again.retryAfterSeconds, 15 * 60);
    assert.equal(throttle.take({ client: '10.9.9.12', username: 'n3' }).scope, 'global');
    c.advance(15 * 60_000);
    assert.equal(throttle.take({ client: '10.9.9.12', username: 'n3' }).allowed, true, 'the count went down');
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
    fail('198.51.100.99', 'root'); // and fails once more on the name itself
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

  test('the key is a secret of its own in the data directory: it survives a restart and a change of the administrator\'s credentials', () => withStore(async (store, dir) => {
    const c = clock();
    const first = loadDeviceKey({ store });
    assert.equal(first.length, 32);
    await store.flush();
    const file = `${dir}/auth/device-key.json`;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved), ['key']);
    for (const secret of [TEST_ADMIN.passwordHash, TEST_ADMIN.totpSecret]) assert.ok(!fs.readFileSync(file, 'utf8').includes(secret));
    assert.notDeepEqual(first, adminDerivedKey(TEST_ADMIN, 'session binding'));

    // A restart reads the same key, whatever the administrator's credentials are now
    const value = createDeviceCookies({ key: first, now: c.now }).issue('root');
    const restarted = loadDeviceKey({ store: createStore(dir) });
    assert.deepEqual(restarted, first);
    assert.ok(createDeviceCookies({ key: restarted, now: c.now }).check(value, 'root'));

    // Deleting the file forgets every known browser; a damaged file is replaced
    fs.rmSync(file);
    const fresh = loadDeviceKey({ store: createStore(dir) });
    assert.notDeepEqual(fresh, first);
    assert.equal(createDeviceCookies({ key: fresh, now: c.now }).check(value, 'root'), null);
    const warnings = [];
    fs.writeFileSync(file, '{"key":"short"}\n');
    const replaced = loadDeviceKey({ store: createStore(dir), logger: { warn: (m) => warnings.push(m), error() {} } });
    assert.equal(replaced.length, 32);
    assert.equal(warnings.length, 1);
  }));

  test('an unreadable key file is never overwritten: a key for this run only', () => withStore(async (store, dir) => {
    fs.mkdirSync(`${dir}/auth/device-key.json`, { recursive: true }); // reading it fails with EISDIR
    const errors = [];
    const key = loadDeviceKey({ store, logger: { warn() {}, error: (m) => errors.push(m) } });
    assert.equal(key.length, 32);
    assert.equal(errors.length, 1);
    await store.flush();
    assert.ok(fs.statSync(`${dir}/auth/device-key.json`).isDirectory());
  }));
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
  test('create / find: a 256-bit token, a public id, the user back', () => withStore((store) => {
    const sessions = createSessionStore({ store });
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

  test('expiry: 8 hours idle, 24 hours at most, whatever the activity', () => withStore((store) => {
    const c = clock();
    const ended = [];
    const sessions = createSessionStore({ store, now: c.now, onEnd: (s, reason) => ended.push(reason) });
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

  test('the sweep ends expired sessions on its own and closes their sockets', () => withStore((store) => {
    const c = clock();
    const ended = [];
    const sessions = createSessionStore({ store, now: c.now, onEnd: (s, reason) => ended.push([s.user.id, reason]) });
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

  test('rotation: a new token for the same session, the old one stops working', () => withStore((store) => {
    const sessions = createSessionStore({ store });
    const { token, session } = sessions.create(student(1));
    const rotated = sessions.rotate(token);
    assert.notEqual(rotated, token);
    assert.equal(sessions.find(token), null);
    assert.equal(sessions.find(rotated).id, session.id);
    assert.equal(sessions.rotate(token), null);
    return sessions.shutdown();
  }));

  test('revocation: by id, by user, by token; sockets are destroyed; the hook is told', () => withStore((store) => {
    const ended = [];
    const sessions = createSessionStore({ store, onEnd: (s, reason) => ended.push([s.user.id, reason]) });
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

  test('a socket opened with an unknown or ended session is destroyed at once', () => withStore((store) => {
    const sessions = createSessionStore({ store });
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
    sessions.trackSocket('y'.repeat(43), socket);
    assert.equal(socket.destroyed, true);
    return sessions.shutdown();
  }));

  test('at most 10 sessions per user: the least recently used gives way', () => withStore((store) => {
    const c = clock();
    const sessions = createSessionStore({ store, now: c.now });
    const tokens = [];
    for (let i = 0; i < 11; i++) { tokens.push(sessions.create(student(1)).token); c.advance(1000); }
    assert.equal(sessions.size, 10);
    assert.equal(sessions.find(tokens[0]), null);
    assert.ok(sessions.find(tokens[10]));
    return sessions.shutdown();
  }));

  test('persistence: a restart keeps everyone signed in; the file holds hashes, never tokens', () => withStore(async (store, dir) => {
    const first = createSessionStore({ store });
    const { token, session } = first.create(student(1, { email: 's1@example.test' }), { ip: '203.0.113.9', idToken: 'header.payload.signature' });
    const revoked = first.create(student(2));
    first.revoke(revoked.session.id);
    await first.shutdown();
    await store.flush();

    const raw = fs.readFileSync(store.resolve('auth/sessions.json'), 'utf8');
    assert.ok(!raw.includes(token), 'the token is not on disk');
    assert.ok(!raw.includes('header.payload.signature'), 'nor the ID token');
    const saved = JSON.parse(raw);
    assert.deepEqual(Object.keys(saved.sessions).map((k) => /^[0-9a-f]{64}$/.test(k)), [true]);
    assert.equal((fs.statSync(store.resolve('auth/sessions.json')).mode & 0o777).toString(8), '600');

    const restarted = createSessionStore({ store: createStore(dir) });
    const found = restarted.find(token);
    assert.equal(found.id, session.id);
    assert.equal(found.user.email, 's1@example.test');
    assert.equal(Object.isFrozen(found.user), true);
    assert.equal(restarted.find(revoked.token), null);
    await restarted.shutdown();
  }));

  test('credential binding: a session opened with credentials that changed since is not restored', () => withStore(async (store, dir) => {
    const local = createUser({ id: 'local:root', username: 'root', name: 'root', role: 'admin', via: 'local' });
    const first = createSessionStore({ store, bindingOf: (u) => (u.id === 'local:root' ? 'binding-1' : undefined) });
    const kept = first.create(student(1));
    const admin1 = first.create(local);
    await first.shutdown();
    await store.flush();
    const saved = Object.values(JSON.parse(fs.readFileSync(store.resolve('auth/sessions.json'), 'utf8')).sessions);
    assert.deepEqual(saved.map((r) => [r.user.id, r.binding]).sort(), [['local:root', 'binding-1'], ['oidc:student1', undefined]]);

    const same = createSessionStore({ store: createStore(dir), bindingOf: (u) => (u.id === 'local:root' ? 'binding-1' : undefined) });
    assert.ok(same.find(admin1.token), 'same credentials: restored');
    await same.shutdown();

    const warnings = [];
    const rotated = createSessionStore({
      store: createStore(dir), logger: { warn: (m) => warnings.push(m), error() {} },
      bindingOf: (u) => (u.id === 'local:root' ? 'binding-2' : undefined),
    });
    assert.equal(rotated.find(admin1.token), null, 'rotated credentials: gone');
    assert.ok(rotated.find(kept.token), 'other people are not concerned');
    assert.match(warnings.join(), /1 saved session\(s\) not restored/);
    await rotated.shutdown();
    await store.flush();

    const renamed = createSessionStore({ store: createStore(dir), bindingOf: (u) => (u.id === 'local:admin2' ? 'binding-2' : undefined) });
    assert.equal(renamed.size, 1, 'the file was rewritten without it');
    await renamed.shutdown();
  }));

  test('a damaged sessions file signs everyone out instead of failing', () => withStore(async (store, dir) => {
    fs.mkdirSync(store.resolve('auth'), { recursive: true });
    fs.writeFileSync(store.resolve('auth/sessions.json'), JSON.stringify({ version: 1, sessions: { nothex: {}, ['a'.repeat(64)]: { id: 'x', user: { id: 'u', via: 'oidc', role: 'god' } } } }));
    const sessions = createSessionStore({ store: createStore(dir) });
    assert.equal(sessions.size, 0);
    await sessions.shutdown();
  }));
});

// ── Account providers ───────────────────────────────────────────────────────

describe('account providers', () => {
  test('the administrator of the environment: user name, password and code together', () => withStore(async (store) => {
    const c = clock();
    const provider = createEnvAdminProvider({ settings: TEST_ADMIN, store, now: c.now });
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

  test('an accepted code is dead, even after a restart', () => withStore(async (store, dir) => {
    const c = clock();
    const code = adminCode(c.ms);
    const provider = createEnvAdminProvider({ settings: TEST_ADMIN, store, now: c.now });
    assert.ok(await provider.verify({ username: 'root', password: TEST_ADMIN.password, code }));
    assert.equal(await provider.verify({ username: 'root', password: TEST_ADMIN.password, code }), null);
    await store.flush();
    const restarted = createEnvAdminProvider({ settings: TEST_ADMIN, store: createStore(dir), now: c.now });
    assert.equal(await restarted.verify({ username: 'root', password: TEST_ADMIN.password, code }), null);
  }));

  test('the registry asks every provider; exactly one must recognise the credentials', async () => {
    const asked = [];
    const provider = (id, answer) => ({ id, verify: async (cred) => { asked.push(id); return answer(cred); } });
    const one = createUser({ id: 'local:alice', username: 'alice', via: 'local' });
    const registry = createAccountProviders([provider('a', () => null)]);
    const remove = registry.add(provider('b', (cred) => (cred.username === 'alice' ? { user: one } : null)));
    assert.deepEqual(registry.ids, ['a', 'b']);
    assert.deepEqual(await registry.verify({ username: 'alice' }), { user: one, requires: [], binding: null });
    assert.deepEqual(asked, ['a', 'b']);
    asked.length = 0;
    assert.equal(await registry.verify({ username: 'bob' }), null);
    assert.deepEqual(asked, ['a', 'b'], 'every provider is asked for an unknown name too');

    const remove2 = registry.add(provider('c', () => ({ user: one })));
    assert.equal(await registry.verify({ username: 'alice' }), null, 'two providers claiming the same person: refused');
    remove();
    assert.deepEqual(registry.ids, ['a', 'c']);
    registry.add(provider('d', () => { throw new Error('disk on fire'); }));
    assert.deepEqual(await registry.verify({ username: 'alice' }), { user: one, requires: [], binding: null }, 'a broken provider counts as "no"');
    remove2();
    const removeE = registry.add(provider('e', (cred) => (cred.username === 'alice' ? { user: one, requires: ['passkey', 42] } : null)));
    assert.deepEqual(await registry.verify({ username: 'alice' }), { user: one, requires: ['passkey'], binding: null }, 'a further step travels with the user');
    removeE();
    const bound = registry.add(provider('f', (cred) => (cred.username === 'alice' ? { user: one, requires: ['passkey'], binding: { password: 'fp' } } : null)));
    assert.deepEqual((await registry.verify({ username: 'alice' })).binding, { password: 'fp' }, 'and what the provider binds it to');
    bound();
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
