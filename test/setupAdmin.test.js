/**
 * `npm run setup-admin`: what it prints really configures a local
 * administrator, and it never prints the password
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { repoRoot, loadTestConfig } from './helpers/app.js';
import { verifyPassword } from '../src/modules/auth/password.js';
import { base32Decode, totp, verifyTotp } from '../src/modules/auth/totp.js';

const run = (args, input) => spawnSync(process.execPath, ['scripts/setup-admin.js', ...args], {
  cwd: repoRoot, encoding: 'utf8', input, timeout: 30_000, env: { PATH: process.env.PATH },
});

test('reads the password from standard input and prints the three lines and the otpauth URI', async () => {
  const password = 'a long enough passphrase';
  const out = run(['--username', 'curtis'], `${password}\n`);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes(password) && !out.stderr.includes(password), 'the password is never printed');

  const value = (name) => new RegExp(`^${name}=(.+)$`, 'm').exec(out.stdout)?.[1];
  const username = value('LOCAL_ADMIN_USERNAME');
  const hash = value('LOCAL_ADMIN_PASSWORD_HASH');
  const secret = value('LOCAL_ADMIN_TOTP_SECRET');
  assert.equal(username, 'curtis');
  assert.match(hash, /^scrypt:32768:8:3:[\w-]+:[\w-]+$/);
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(await verifyPassword(password, hash), true);
  const key = base32Decode(secret);
  assert.notEqual(verifyTotp(key, totp(key)), null);

  const uri = /^otpauth:\/\/totp\/.+$/m.exec(out.stdout)?.[0];
  assert.equal(uri, `otpauth://totp/Lab%20Console:curtis?secret=${secret}&issuer=Lab%20Console&algorithm=SHA1&digits=6&period=30`);

  // The lines are accepted as they are by the configuration
  const config = await loadTestConfig({ LOCAL_ADMIN_USERNAME: username, LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_ADMIN_TOTP_SECRET: secret });
  assert.equal(config.auth.localAdmin.username, 'curtis');
});

test('refuses a short password, or a user name the configuration would refuse', () => {
  const short = run(['--username', 'curtis'], 'short\n');
  assert.equal(short.status, 1);
  assert.match(short.stderr, /at least 12 characters/);
  assert.equal(short.stdout, '');
  const badName = run(['--username', 'root user'], 'a long enough passphrase\n');
  assert.equal(badName.status, 1);
  assert.match(badName.stderr, /user name must be/);
});
