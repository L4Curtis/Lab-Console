/**
 * The settings service (ARCHITECTURE §6): environment values as the starting
 * point, saved values win, validation, write-only secrets, persistence in
 * data/settings/<ns>.json (600), audit without secrets, the 'change' event
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettings } from '../src/lib/settings.js';
import { createStore } from '../src/lib/store.js';
import { createAudit } from '../src/lib/audit.js';

const config = {
  ssh: { host: 'jump', port: 22, username: 'u', password: 'p', readyTimeoutMs: 15_000 },
  telnet: { username: 't', password: 'q', autoLogin: true, wakeIdleMs: 2500 },
  consoles: { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.211'], portRange: { min: 2000, max: 2099 } },
};
const actor = { id: 'local:root', username: 'root', role: 'admin', via: 'local' };

test('settings: the lab namespace mirrors the configuration', () => {
  const s = createSettings({ config });
  assert.deepEqual(s.get('lab'), { ssh: config.ssh, telnet: config.telnet, consoles: config.consoles });
  assert.deepEqual(s.namespaces(), ['lab']);
});

test('settings: callers get a copy they cannot use to change the source', () => {
  const s = createSettings({ config });
  const lab = s.get('lab');
  lab.ssh.host = 'elsewhere';
  assert.equal(s.get('lab').ssh.host, 'jump');
});

test('settings: an unknown namespace is refused', () => {
  assert.throws(() => createSettings({ config }).get('nope'), /Unknown settings namespace/);
  assert.throws(() => createSettings({ config }).describe('nope'), /Unknown settings namespace/);
});

test('settings: an SSH key read from a file (a Buffer) is handed out as text', () => {
  const s = createSettings({ config: { ...config, ssh: { ...config.ssh, privateKey: Buffer.from('-----BEGIN KEY-----') } } });
  assert.equal(s.get('lab').ssh.privateKey, '-----BEGIN KEY-----');
  assert.deepEqual(s.describe('lab').values.ssh.privateKey, { set: true });
});

describe('settings with a data directory', () => {
  let dir;
  let store;
  let audit;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
    store = createStore(dir);
    audit = createAudit({ store });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('saved values win over the environment, survive a restart, and null brings the environment back', async () => {
    const s = createSettings({ config, store, audit });
    const out = await s.update('lab', { ssh: { host: 'jump2.lab', port: '2222' }, consoles: { allowedHosts: '10.22.9.211, 10.22.9.213', portRange: '2000-2050' } }, actor);
    assert.deepEqual(out.changed.sort(), ['consoles.allowedHosts', 'consoles.portRange', 'ssh.host', 'ssh.port']);
    assert.equal(s.get('lab').ssh.host, 'jump2.lab');
    assert.equal(s.get('lab').ssh.port, 2222);
    assert.equal(s.get('lab').ssh.readyTimeoutMs, 15_000, 'fields that are not editable keep the environment\'s value');
    assert.deepEqual(s.get('lab').consoles.allowedHosts, ['10.22.9.211', '10.22.9.213']);
    await store.flush();

    const file = path.join(dir, 'settings', 'lab.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const again = createSettings({ config, store: createStore(dir), audit });
    assert.equal(again.get('lab').ssh.host, 'jump2.lab', 'read back after a restart');
    assert.deepEqual(again.describe('lab').saved.sort(), ['consoles.allowedHosts', 'consoles.portRange', 'ssh.host', 'ssh.port']);

    const reset = await again.update('lab', { ssh: { host: null } }, actor);
    assert.deepEqual(reset.reset, ['ssh.host']);
    assert.equal(again.get('lab').ssh.host, 'jump', 'back to the environment');
  });

  test('every value is validated; nothing is saved when one is wrong', async () => {
    const s = createSettings({ config, store, audit });
    const bad = (patch) => assert.rejects(s.update('lab', patch, actor), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'settings.invalid');
      return Array.isArray(err.params.problems);
    });
    await bad({ ssh: { host: 'bad host; rm -rf /' } });
    await bad({ ssh: { port: 70000 } });
    await bad({ ssh: { port: 'twenty' } });
    await bad({ ssh: { username: '' } });
    await bad({ ssh: { hostFingerprint: 'MD5:aa:bb' } });
    await bad({ ssh: { host: 'ok.example', nope: 1 } });
    await bad({ consoles: { portRange: { min: 2100, max: 2000 } } });
    await bad({ consoles: { allowedHosts: [] } });
    await bad({ telnet: { autoLogin: 'yes' } });
    await bad({ telnet: { password: 'line\nbreak' } });
    await bad({ ssh: { password: '' } }); // neither a password nor a key any more
    await bad({ ssh: { privateKey: 'not a key' } });
    await bad('nothing');
    const problems = await s.update('lab', { ssh: { port: 0, host: '' } }, actor).catch((err) => err.params.problems);
    assert.deepEqual(problems.map((p) => [p.field, p.code]).sort(), [['ssh.host', 'required'], ['ssh.port', 'out_of_range']]);
    assert.equal(s.get('lab').ssh.host, 'jump', 'nothing changed');
    assert.deepEqual(s.describe('lab').saved, []);
  });

  test('a real key is accepted; a passphrase that does not open it is refused', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
    const s = createSettings({ config, store, audit });
    await s.update('lab', { ssh: { privateKey: pem, password: '' } }, actor);
    assert.equal(s.get('lab').ssh.privateKey, pem);
    const encrypted = privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'right' });
    await assert.rejects(s.update('lab', { ssh: { privateKey: encrypted } }, actor), (err) => err.params.problems.some((p) => p.field === 'ssh.passphrase'), 'no passphrase');
    await assert.rejects(s.update('lab', { ssh: { privateKey: encrypted, passphrase: 'wrong' } }, actor), (err) => err.params.problems.some((p) => p.field === 'ssh.passphrase'));
    await s.update('lab', { ssh: { privateKey: encrypted, passphrase: 'right' } }, actor);
  });

  test('secrets are write-only: describe() and the audit trail never contain them', async () => {
    const s = createSettings({ config, store, audit });
    await s.update('lab', { ssh: { password: 'jump-S3cret!' }, telnet: { password: 'line-S3cret!', username: 'console' } }, actor);
    const described = s.describe('lab');
    assert.deepEqual(described.values.ssh.password, { set: true });
    assert.deepEqual(described.values.telnet.password, { set: true });
    assert.equal(described.values.telnet.username, 'console');
    assert.ok(!JSON.stringify(described).includes('S3cret'));
    assert.equal(s.get('lab').ssh.password, 'jump-S3cret!', 'the server itself uses it');

    await store.flush();
    const [entry] = await audit.query({ action: 'settings.update' });
    assert.equal(entry.actor.id, 'local:root');
    assert.deepEqual(entry.details.changed.sort(), ['ssh.password', 'telnet.password', 'telnet.username']);
    assert.deepEqual(entry.details.values, { 'telnet.username': 'console' }, 'new values of the other fields only');
    const trail = fs.readFileSync(path.join(dir, 'audit', fs.readdirSync(path.join(dir, 'audit'))[0]), 'utf8');
    assert.ok(!trail.includes('S3cret'), 'not in the audit file');
  });

  test('with APP_SECRET, secrets are encrypted in the file; another APP_SECRET cannot read them and the environment is used', async () => {
    const appSecret = 'a'.repeat(40);
    const s = createSettings({ config: { ...config, appSecret }, store, audit });
    await s.update('lab', { ssh: { password: 'jump-S3cret!' } }, actor);
    await store.flush();
    const raw = fs.readFileSync(path.join(dir, 'settings', 'lab.json'), 'utf8');
    assert.ok(!raw.includes('S3cret'), 'encrypted on disk');
    assert.equal(JSON.parse(raw).values['ssh.password'].alg, 'aes-256-gcm');
    assert.equal(s.describe('lab').encrypted, true);

    const other = createSettings({ config: { ...config, appSecret: 'b'.repeat(40) }, store: createStore(dir), audit });
    assert.equal(other.get('lab').ssh.password, 'p', 'the environment\'s value');
    assert.deepEqual(other.describe('lab').unreadable, ['ssh.password']);

    const clear = createSettings({ config, store: createStore(dir), audit });
    assert.deepEqual(clear.describe('lab').unreadable, ['ssh.password'], 'without APP_SECRET either');
  });

  test('without APP_SECRET, secrets are kept in clear in the 600 file', async () => {
    const s = createSettings({ config, store, audit });
    await s.update('lab', { telnet: { password: 'line-pass' } }, actor);
    await store.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings', 'lab.json'), 'utf8')).values['telnet.password'], { clear: 'line-pass' });
    assert.equal(s.describe('lab').encrypted, false);
  });

  test('"change" is emitted after a save, with the new values; not when nothing changed', async () => {
    const s = createSettings({ config, store, audit });
    const seen = [];
    const off = s.on('change', (ns, values) => seen.push([ns, values.telnet.username]));
    await s.update('lab', { telnet: { username: 'other' } }, actor);
    await s.update('lab', { telnet: { username: 'other' } }, actor);
    assert.deepEqual(seen, [['lab', 'other']]);
    off();
    await s.update('lab', { telnet: { username: 'third' } }, actor);
    assert.equal(seen.length, 1);
  });

  test('register(): another namespace, with its own fields and file', async () => {
    const s = createSettings({ config, store, audit });
    s.register('demo', { defaults: () => ({ limit: 3, token: 'env' }), fields: { limit: { type: 'int', min: 1, max: 9 }, token: { type: 'secret' } } });
    assert.throws(() => s.register('demo', { defaults: () => ({}), fields: {} }), /already registered/);
    assert.throws(() => s.register('Bad NS', { defaults: () => ({}), fields: {} }), /Invalid/);
    assert.throws(() => s.register('odd', { defaults: () => ({}), fields: { a: { type: 'blob' } } }), /unknown type/);
    await s.update('demo', { limit: 5, token: 'new' }, actor);
    assert.deepEqual(s.get('demo'), { limit: 5, token: 'new' });
    assert.deepEqual(s.describe('demo').values, { limit: 5, token: { set: true } });
    await store.flush();
    assert.ok(fs.existsSync(path.join(dir, 'settings', 'demo.json')));
  });
});
