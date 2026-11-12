/**
 * Configuration: the env readers (src/lib/env.js) and the object assembled
 * from fragments (src/config.js). A bad value never throws on its own: it is
 * collected, and loadConfig() refuses to return a partly valid configuration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as env from '../src/lib/env.js';
import { withEnv, loadTestConfig, baseEnv, tempDataDir, repoRoot } from './helpers/app.js';

/** Run `fn` with these variables set, and hand back the problems the readers collected */
function reading(vars, fn) {
  const restore = withEnv(vars);
  env.takeErrors();
  try {
    return { value: fn(), errors: env.takeErrors() };
  } finally {
    restore();
  }
}

test('str: trims, and treats blank as unset', () => {
  assert.equal(reading({ T_X: '  hello ' }, () => env.str('T_X')).value, 'hello');
  assert.equal(reading({ T_X: '   ' }, () => env.str('T_X', 'fallback')).value, 'fallback');
  assert.equal(reading({ T_X: undefined }, () => env.str('T_X')).value, '');
});

test('required: a missing value is reported, not thrown', () => {
  const r = reading({ T_X: undefined }, () => env.required('T_X'));
  assert.equal(r.value, '');
  assert.deepEqual(r.errors, ['T_X is required']);
  assert.deepEqual(reading({ T_X: 'set' }, () => env.required('T_X')), { value: 'set', errors: [] });
});

test('int: range and format are checked, the fallback is returned on error', () => {
  assert.equal(reading({ T_N: '42' }, () => env.int('T_N', 7)).value, 42);
  assert.equal(reading({ T_N: undefined }, () => env.int('T_N', 7)).value, 7);
  for (const bad of ['4.5', 'abc', '99999', '-1']) {
    const r = reading({ T_N: bad }, () => env.int('T_N', 7, { min: 0, max: 100 }));
    assert.equal(r.value, 7, bad);
    assert.equal(r.errors.length, 1, bad);
    assert.match(r.errors[0], /T_N must be an integer between 0 and 100/);
  }
});

test('bool: usual spellings of yes, everything else is no', () => {
  for (const yes of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(reading({ T_B: yes }, () => env.bool('T_B', false)).value, true, yes);
  for (const no of ['0', 'false', 'off', 'nope']) assert.equal(reading({ T_B: no }, () => env.bool('T_B', true)).value, false, no);
  assert.equal(reading({ T_B: undefined }, () => env.bool('T_B', true)).value, true);
});

test('list: comma separated, trimmed, empty items dropped', () => {
  assert.deepEqual(reading({ T_L: ' a, b ,,c ' }, () => env.list('T_L')).value, ['a', 'b', 'c']);
  assert.deepEqual(reading({ T_L: undefined }, () => env.list('T_L', ['x'])).value, ['x']);
});

test('portRange: "min-max", refused when reversed or out of range', () => {
  assert.deepEqual(reading({ T_P: '2000 - 2099' }, () => env.portRange('T_P', '1-2')).value, { min: 2000, max: 2099 });
  for (const bad of ['2099-2000', '1-70000', 'abc']) {
    const r = reading({ T_P: bad }, () => env.portRange('T_P', '2000-2099'));
    assert.deepEqual(r.value, { min: 2000, max: 2099 }, bad);
    assert.equal(r.errors.length, 1, bad);
  }
});

test('oneOf: closed set, case-insensitive', () => {
  assert.equal(reading({ T_O: 'OFF' }, () => env.oneOf('T_O', ['on', 'off'], 'on')).value, 'off');
  const r = reading({ T_O: 'maybe' }, () => env.oneOf('T_O', ['on', 'off'], 'on'));
  assert.equal(r.value, 'on');
  assert.match(r.errors[0], /T_O must be one of on, off/);
});

test('origin: scheme and host only', () => {
  assert.equal(reading({ T_U: 'https://lab.example.org/' }, () => env.origin('T_U')).value, 'https://lab.example.org');
  assert.equal(reading({ T_U: 'http://127.0.0.1:8088' }, () => env.origin('T_U')).value, 'http://127.0.0.1:8088');
  assert.equal(reading({ T_U: undefined }, () => env.origin('T_U')).value, '');
  for (const bad of ['lab.example.org', 'https://lab.example.org/app', 'ftp://lab.example.org', 'https://user:pw@lab.example.org', 'https://lab.example.org?x=1']) {
    const r = reading({ T_U: bad }, () => env.origin('T_U'));
    assert.equal(r.value, '', bad);
    assert.equal(r.errors.length, 1, bad);
  }
});

test('fail / takeErrors: fragments add their own problems to the shared list', () => {
  env.takeErrors();
  env.fail('first');
  env.fail('second');
  assert.deepEqual(env.errors, ['first', 'second']);
  assert.deepEqual(env.takeErrors(), ['first', 'second']);
  assert.deepEqual(env.errors, []);
});

// ── The assembled configuration ─────────────────────────────────────────────

test('config: defaults of the global keys, and the upstream sections unchanged', async () => {
  const config = await loadTestConfig();
  assert.equal(config.auth.mode, 'off');
  assert.equal(config.defaultLocale, 'fr');
  assert.equal(config.server.publicUrl, '');
  assert.equal(config.server.trustProxy, false);
  assert.deepEqual(config.server.trustedProxies, []);
  assert.ok(path.isAbsolute(config.dataDir));
  assert.deepEqual(Object.keys(config).sort(),
    ['auth', 'consoles', 'dataDir', 'defaultLocale', 'diagramPath', 'infraConfigPath', 'limits', 'proxmox', 'server', 'ssh', 'telnet']);
  assert.deepEqual(config.consoles, { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.211', '10.22.9.212'], portRange: { min: 2000, max: 2099 } });
  assert.equal(config.limits.maxSessions, 40);
  assert.deepEqual(config.proxmox, { enabled: false });
});

test('config: DATA_DIR defaults to ./data and is made absolute', async () => {
  const config = await loadTestConfig({ DATA_DIR: '' });
  assert.equal(config.dataDir, path.resolve('data'));
});

test('config: the global keys are read from the environment', async () => {
  const config = await loadTestConfig({
    PUBLIC_URL: 'https://lab.example.org/', DEFAULT_LOCALE: 'EN', TRUSTED_PROXIES: '192.168.10.112, 10.0.0.0/8', TRUST_PROXY: 'true',
  });
  assert.equal(config.server.publicUrl, 'https://lab.example.org');
  assert.equal(config.defaultLocale, 'en');
  assert.deepEqual(config.server.trustedProxies, ['192.168.10.112', '10.0.0.0/8']);
  assert.equal(config.server.trustProxy, true);
});

test('config: frozen all the way down', async () => {
  const config = await loadTestConfig();
  assert.throws(() => { config.auth.mode = 'on'; }, TypeError);
  assert.throws(() => { config.server.trustedProxies.push('0.0.0.0/0'); }, TypeError);
  assert.throws(() => { config.extra = 1; }, TypeError);
});

test('config: every problem is listed at once, in a ConfigError', async () => {
  await assert.rejects(
    loadTestConfig({ SSH_HOST: '', DEFAULT_LOCALE: 'de', TRUSTED_PROXIES: '192.168.10.112,not-an-ip', PUBLIC_URL: 'lab.example.org', PORT: 'abc' }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      const text = err.problems.join('\n');
      assert.match(text, /SSH_HOST is required/);
      assert.match(text, /DEFAULT_LOCALE must be one of fr, en/);
      assert.match(text, /TRUSTED_PROXIES: "not-an-ip" is not an IP address or CIDR block/);
      assert.match(text, /PUBLIC_URL must be an origin/);
      assert.match(text, /PORT must be an integer/);
      return true;
    },
  );
  // A failed load leaves nothing behind for the next one
  assert.equal((await loadTestConfig()).auth.mode, 'off');
});

test('config: AUTH_MODE=on (the default) is refused by this build, with a message that says what to do', async () => {
  for (const mode of ['on', '']) {
    await assert.rejects(loadTestConfig({ AUTH_MODE: mode, PUBLIC_URL: 'https://lab.example.org' }), (err) => {
      assert.equal(err.problems.length, 1);
      assert.match(err.problems[0], /AUTH_MODE=on .*does not include yet/);
      assert.match(err.problems[0], /Set AUTH_MODE=off/);
      return true;
    });
  }
  await assert.rejects(loadTestConfig({ AUTH_MODE: 'on' }), /PUBLIC_URL is required when AUTH_MODE=on/);
  await assert.rejects(loadTestConfig({ AUTH_MODE: 'sometimes' }), /AUTH_MODE must be one of on, off/);
});

test('startup: `node src/server.js` with AUTH_MODE=on exits at once with the reason', () => {
  const dataDir = tempDataDir();
  try {
    const run = spawnSync(process.execPath, ['src/server.js'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, ...baseEnv(dataDir), AUTH_MODE: 'on', PUBLIC_URL: 'https://lab.example.org' },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Invalid configuration/);
    assert.match(run.stderr, /AUTH_MODE=on .*Set AUTH_MODE=off/s);
    assert.equal(run.stdout, '', 'nothing started');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('nothing but the configuration layer reads process.env', () => {
  const allowed = new Set(['src/lib/env.js', 'src/lib/logger.js']); // logger: LOG_LEVEL, upstream
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && /process\.env\b/.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(repoRoot, file));
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders.filter((f) => !allowed.has(f)), []);
});
