/**
 * The settings service (ARCHITECTURE §6): environment values as the starting
 * point, saved values win, validation, write-only secrets, persistence in
 * the database (table settings), audit without secrets, the 'change' event
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSettings } from '../src/lib/settings.js';
import { createAudit } from '../src/lib/audit.js';
import { memoryDatabase } from './helpers/db.js';

const config = {
  ssh: { host: 'jump', port: 22, username: 'u', password: 'p', readyTimeoutMs: 15_000 },
  telnet: { username: 't', password: 'q', autoLogin: true, wakeIdleMs: 2500 },
  consoles: { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.211'], portRange: { min: 2000, max: 2099 } },
};
const actor = { id: 'local:root', username: 'root', role: 'admin', via: 'local' };

/** A settings service on its own in-memory database, closed after the test */
async function fresh(t, options = {}) {
  const memory = await memoryDatabase();
  t.after(memory.close);
  return createSettings({ config, repo: memory.repos.settings, ...options });
}

test('settings: the lab namespace mirrors the configuration', async (t) => {
  const s = await fresh(t);
  assert.deepEqual(s.get('lab'), { ssh: config.ssh, telnet: config.telnet, consoles: config.consoles });
  assert.deepEqual(s.namespaces(), ['lab']);
});

test('settings: callers get a copy they cannot use to change the source', async (t) => {
  const s = await fresh(t);
  const lab = s.get('lab');
  lab.ssh.host = 'elsewhere';
  assert.equal(s.get('lab').ssh.host, 'jump');
});

test('settings: an unknown namespace is refused', async (t) => {
  const s = await fresh(t);
  assert.throws(() => s.get('nope'), /Unknown settings namespace/);
  assert.throws(() => s.describe('nope'), /Unknown settings namespace/);
});

test('settings: the service needs its repository', async () => {
  await assert.rejects(createSettings({ config }), /settings repository/);
});

test('settings: an SSH key read from a file (a Buffer) is handed out as text', async (t) => {
  const s = await fresh(t, { config: { ...config, ssh: { ...config.ssh, privateKey: Buffer.from('-----BEGIN KEY-----') } } });
  assert.equal(s.get('lab').ssh.privateKey, '-----BEGIN KEY-----');
  assert.deepEqual(s.describe('lab').values.ssh.privateKey, { set: true });
});

test('settings: names inherited from Object are unknown fields (400), never a crash, and nothing is saved', async (t) => {
  const s = await fresh(t);
  const before = JSON.stringify(s.get('lab'));
  const patches = [
    { constructor: 'x' },
    { toString: 'x' },
    { hasOwnProperty: { a: 1 } },
    JSON.parse('{"__proto__": "x"}'),
    JSON.parse('{"__proto__": {"polluted": true}}'),
    { ssh: { constructor: 'x' } },
    { ssh: JSON.parse('{"__proto__": 1}') },
  ];
  for (const patch of patches) {
    for (const run of [() => s.update('lab', patch, actor), async () => s.check('lab', patch)]) {
      await assert.rejects(Promise.resolve().then(run), (err) => err.status === 400 && err.code === 'settings.invalid'
        && err.params.problems.length === 1 && err.params.problems[0].code === 'unknown', JSON.stringify(patch));
    }
  }
  assert.equal(JSON.stringify(s.get('lab')), before);
  assert.equal({}.polluted, undefined);
});

test('settings: check() is the validation of update() alone', async (t) => {
  const s = await fresh(t);
  assert.deepEqual(s.check('lab', { ssh: { host: 'other-jump' } }), { changed: ['ssh.host'], reset: [] });
  assert.equal(s.get('lab').ssh.host, 'jump', 'nothing saved');
  assert.throws(() => s.check('lab', { ssh: { port: 99999 } }), (err) => err.code === 'settings.invalid' && err.params.problems[0].field === 'ssh.port');
  assert.throws(() => s.check('lab', null), (err) => err.code === 'settings.invalid');
});

describe('settings saved in the database', () => {
  let memory;
  let repo;
  let audit;
  beforeEach(async () => {
    memory = await memoryDatabase();
    repo = memory.repos.settings;
    audit = createAudit({ repo: memory.repos.audit });
  });
  afterEach(() => memory.close());

  test('saved values win over the environment, survive a restart, and null brings the environment back', async () => {
    const s = await createSettings({ config, repo, audit });
    const out = await s.update('lab', { ssh: { host: 'jump2.lab', port: '2222' }, consoles: { allowedHosts: '10.22.9.211, 10.22.9.213', portRange: '2000-2050' } }, actor);
    assert.deepEqual(out.changed.sort(), ['consoles.allowedHosts', 'consoles.portRange', 'ssh.host', 'ssh.port']);
    assert.equal(s.get('lab').ssh.host, 'jump2.lab');
    assert.equal(s.get('lab').ssh.port, 2222);
    assert.equal(s.get('lab').ssh.readyTimeoutMs, 15_000, 'fields that are not editable keep the environment\'s value');
    assert.deepEqual(s.get('lab').consoles.allowedHosts, ['10.22.9.211', '10.22.9.213']);
    const row = await repo.get('lab');
    assert.equal(row.updatedBy, 'local:root');
    assert.equal(row.values['ssh.port'], 2222);

    const again = await createSettings({ config, repo, audit });
    assert.equal(again.get('lab').ssh.host, 'jump2.lab', 'read back after a restart');
    assert.deepEqual(again.describe('lab').saved.sort(), ['consoles.allowedHosts', 'consoles.portRange', 'ssh.host', 'ssh.port']);

    const reset = await again.update('lab', { ssh: { host: null } }, actor);
    assert.deepEqual(reset.reset, ['ssh.host']);
    assert.equal(again.get('lab').ssh.host, 'jump', 'back to the environment');
  });

  test('every value is validated; nothing is saved when one is wrong', async () => {
    const s = await createSettings({ config, repo, audit });
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
    const s = await createSettings({ config, repo, audit });
    await s.update('lab', { ssh: { privateKey: pem, password: '' } }, actor);
    assert.equal(s.get('lab').ssh.privateKey, pem);
    const encrypted = privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'right' });
    await assert.rejects(s.update('lab', { ssh: { privateKey: encrypted } }, actor), (err) => err.params.problems.some((p) => p.field === 'ssh.passphrase'), 'no passphrase');
    await assert.rejects(s.update('lab', { ssh: { privateKey: encrypted, passphrase: 'wrong' } }, actor), (err) => err.params.problems.some((p) => p.field === 'ssh.passphrase'));
    await s.update('lab', { ssh: { privateKey: encrypted, passphrase: 'right' } }, actor);
  });

  test('secrets are write-only: describe() and the audit trail never contain them', async () => {
    const s = await createSettings({ config, repo, audit });
    await s.update('lab', { ssh: { password: 'jump-S3cret!' }, telnet: { password: 'line-S3cret!', username: 'console' } }, actor);
    const described = s.describe('lab');
    assert.deepEqual(described.values.ssh.password, { set: true });
    assert.deepEqual(described.values.telnet.password, { set: true });
    assert.equal(described.values.telnet.username, 'console');
    assert.ok(!JSON.stringify(described).includes('S3cret'));
    assert.equal(s.get('lab').ssh.password, 'jump-S3cret!', 'the server itself uses it');

    const [entry] = await audit.query({ action: 'settings.update' });
    assert.equal(entry.actor.id, 'local:root');
    assert.deepEqual(entry.details.changed.sort(), ['ssh.password', 'telnet.password', 'telnet.username']);
    assert.deepEqual(entry.details.values, { 'telnet.username': 'console' }, 'new values of the other fields only');
    const trail = JSON.stringify(await memory.db.query('SELECT * FROM audit_entries'));
    assert.ok(!trail.includes('S3cret'), 'not in the audit trail');
  });

  test('with APP_SECRET, secrets are encrypted in the database; another APP_SECRET cannot read them and the environment is used', async () => {
    const appSecret = 'a'.repeat(40);
    const s = await createSettings({ config: { ...config, appSecret }, repo, audit });
    await s.update('lab', { ssh: { password: 'jump-S3cret!' } }, actor);
    const raw = JSON.stringify(await memory.db.query('SELECT data FROM settings'));
    assert.ok(!raw.includes('S3cret'), 'encrypted in the database');
    assert.equal((await repo.get('lab')).values['ssh.password'].alg, 'aes-256-gcm');
    assert.equal(s.describe('lab').encrypted, true);

    const other = await createSettings({ config: { ...config, appSecret: 'b'.repeat(40) }, repo, audit });
    assert.equal(other.get('lab').ssh.password, 'p', 'the environment\'s value');
    assert.deepEqual(other.describe('lab').unreadable, ['ssh.password']);

    const clear = await createSettings({ config, repo, audit });
    assert.deepEqual(clear.describe('lab').unreadable, ['ssh.password'], 'without APP_SECRET either');
  });

  test('without APP_SECRET, secrets are kept in clear in the database (a file of mode 600)', async () => {
    const s = await createSettings({ config, repo, audit });
    await s.update('lab', { telnet: { password: 'line-pass' } }, actor);
    assert.deepEqual((await repo.get('lab')).values['telnet.password'], { clear: 'line-pass' });
    assert.equal(s.describe('lab').encrypted, false);
  });

  test('"change" is emitted after a save, with the new values; not when nothing changed', async () => {
    const s = await createSettings({ config, repo, audit });
    const seen = [];
    const off = s.on('change', (ns, values) => seen.push([ns, values.telnet.username]));
    await s.update('lab', { telnet: { username: 'other' } }, actor);
    await s.update('lab', { telnet: { username: 'other' } }, actor);
    assert.deepEqual(seen, [['lab', 'other']]);
    off();
    await s.update('lab', { telnet: { username: 'third' } }, actor);
    assert.equal(seen.length, 1);
  });

  test('register(): another namespace, with its own fields and row', async () => {
    const s = await createSettings({ config, repo, audit });
    s.register('demo', { defaults: () => ({ limit: 3, token: 'env' }), fields: { limit: { type: 'int', min: 1, max: 9 }, token: { type: 'secret' } } });
    assert.throws(() => s.register('demo', { defaults: () => ({}), fields: {} }), /already registered/);
    assert.throws(() => s.register('Bad NS', { defaults: () => ({}), fields: {} }), /Invalid/);
    assert.throws(() => s.register('odd', { defaults: () => ({}), fields: { a: { type: 'blob' } } }), /unknown type/);
    await s.update('demo', { limit: 5, token: 'new' }, actor);
    assert.deepEqual(s.get('demo'), { limit: 5, token: 'new' });
    assert.deepEqual(s.describe('demo').values, { limit: 5, token: { set: true } });
    assert.deepEqual((await repo.get('demo')).values.limit, 5);
    const again = await createSettings({ config, repo, audit });
    again.register('demo', { defaults: () => ({ limit: 3, token: 'env' }), fields: { limit: { type: 'int', min: 1, max: 9 }, token: { type: 'secret' } } });
    assert.deepEqual(again.get('demo'), { limit: 5, token: 'new' }, 'a namespace registered later finds what was saved');
  });
});
