/**
 * The jump server's identity (src/lib/ssh.js): the platform reaches it over
 * the Internet with a password, so whoever sits on the path and poses as it
 * would collect that password and every console. Its host key is checked
 * against a pinned fingerprint; in production (NODE_ENV=production) there is
 * no connection without one, and the lab parameters page cannot empty it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMockLab } from '../dev/mock-lab.js';
import { ConsoleSession } from '../src/modules/consoles/consoleSession.js';
import { verifyHostKey, sshErrorInfo } from '../src/lib/ssh.js';
import { labSettings } from '../src/lib/labSettings.js';
import { loadTestConfig } from './helpers/app.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const KEY = Buffer.from('a host key');
const PRINT = `SHA256:${crypto.createHash('sha256').update(KEY).digest('base64').replace(/=+$/, '')}`;
const OTHER = `SHA256:${'A'.repeat(43)}`;

test('a host key is accepted when it has the pinned fingerprint, and only then', () => {
  assert.equal(verifyHostKey(KEY, { hostFingerprint: PRINT }, quiet), true);
  assert.equal(verifyHostKey(KEY, { hostFingerprint: OTHER }, quiet), false);
  assert.equal(verifyHostKey(KEY, { hostFingerprint: OTHER, hostKeyRequired: true }, quiet), false);
});

test('nothing pinned: refused in production, accepted with a warning elsewhere', () => {
  const errors = [];
  assert.equal(verifyHostKey(KEY, { hostFingerprint: '', hostKeyRequired: true }, { ...quiet, error: (m) => errors.push(m) }), false);
  assert.match(errors[0], new RegExp(PRINT.replace(/[+/]/g, '\\$&')), 'the log shows the fingerprint to pin');
  assert.equal(verifyHostKey(KEY, { hostFingerprint: '' }, quiet), true);
});

test('the refusal is told apart from a mismatch', () => {
  const err = new Error('Handshake failed: host key verification failed');
  assert.equal(sshErrorInfo(err, { host: 'jump', hostFingerprint: '' }).code, 'consoles.ssh_unpinned');
  assert.equal(sshErrorInfo(err, { host: 'jump', hostFingerprint: OTHER }).code, 'consoles.ssh_identity');
});

test('the configuration: required under NODE_ENV=production, and a malformed fingerprint is refused at start-up', async () => {
  assert.equal((await loadTestConfig()).ssh.hostKeyRequired, false);
  assert.equal((await loadTestConfig({ NODE_ENV: 'production' })).ssh.hostKeyRequired, true);
  assert.equal((await loadTestConfig({ SSH_HOST_FINGERPRINT: PRINT })).ssh.hostFingerprint, PRINT);
  await assert.rejects(loadTestConfig({ SSH_HOST_FINGERPRINT: 'aa:bb:cc' }), /SSH_HOST_FINGERPRINT must look like SHA256:/);
});

test('the lab parameters page cannot empty the fingerprint in production', async () => {
  const config = await loadTestConfig({ NODE_ENV: 'production', SSH_HOST_FINGERPRINT: PRINT });
  const lab = labSettings(config);
  const values = lab.defaults();
  assert.deepEqual(lab.check(values), []);
  assert.deepEqual(lab.check({ ...values, ssh: { ...values.ssh, hostFingerprint: '' } }), [{ field: 'ssh.hostFingerprint', code: 'fingerprint_required' }]);
  const dev = labSettings(await loadTestConfig());
  assert.deepEqual(dev.check({ ...dev.defaults(), ssh: { ...dev.defaults().ssh, hostFingerprint: '' } }), []);
});

test('a console in production with nothing pinned never logs in to the jump server', { timeout: 15_000 }, async (t) => {
  const SSH = { username: 'jump', password: 'jump-pass' };
  const lab = await startMockLab({ port: 0, ssh: SSH, telnet: { username: 'c', password: 'c' } });
  t.after(() => lab.close());
  const session = new ConsoleSession({
    target: { host: '10.0.9.4', port: 3001 },
    ssh: { host: '127.0.0.1', port: lab.port, ...SSH, hostFingerprint: '', hostKeyRequired: true, readyTimeoutMs: 5000 },
    telnet: {},
    logger: quiet,
  });
  const closed = new Promise((resolve) => session.once('close', resolve));
  session.start();
  const { info } = await closed;
  assert.equal(info.code, 'consoles.ssh_unpinned');
  assert.equal(lab.stats().passwordsReceived, 0, 'the password was never sent');
});
