/**
 * Run-time settings (src/lib/settings.js): the environment's values, with
 * what an administrator saved in the database laid over them
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettings } from '../src/lib/settings.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger } from './helpers/fakes.js';

const config = {
  ssh: { host: 'jump', port: 22, username: 'u', password: 'p' },
  telnet: { username: 't', password: 'q', autoLogin: true },
  consoles: { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.211'], portRange: { min: 2000, max: 2099 } },
};

async function setup(t) {
  const memory = await memoryDatabase();
  t.after(memory.close);
  return memory;
}

test('settings: the lab namespace mirrors the configuration', async (t) => {
  const { repos } = await setup(t);
  const s = await createSettings({ config, repo: repos.settings });
  assert.deepEqual(s.get('lab'), { ssh: config.ssh, telnet: config.telnet, consoles: config.consoles });
  assert.deepEqual(s.namespaces(), ['lab']);
});

test('settings: callers get a copy they cannot use to change the source', async (t) => {
  const { repos } = await setup(t);
  await repos.settings.save('lab', { ssh: { host: 'saved' } });
  const s = await createSettings({ config, repo: repos.settings });
  const lab = s.get('lab');
  lab.ssh.host = 'elsewhere';
  lab.consoles.allowedHosts.push('10.22.9.99');
  assert.equal(s.get('lab').ssh.host, 'saved');
  assert.deepEqual(s.get('lab').consoles.allowedHosts, ['10.22.9.211']);
  assert.deepEqual(config.consoles.allowedHosts, ['10.22.9.211']);
});

test('settings: an unknown namespace is refused', async (t) => {
  const { repos } = await setup(t);
  const s = await createSettings({ config, repo: repos.settings });
  assert.throws(() => s.get('nope'), /Unknown settings namespace/);
});

test('settings: saved values win over the environment, key by key; lists and values are replaced whole', async (t) => {
  const { repos } = await setup(t);
  await repos.settings.save('lab', {
    ssh: { host: 'jump2.example.test', port: 2222 },
    consoles: { allowedHosts: ['10.22.9.212'], portRange: { max: 2050 } },
  }, 'oidc:admin');
  const s = await createSettings({ config, repo: repos.settings });
  assert.deepEqual(s.get('lab'), {
    ssh: { host: 'jump2.example.test', port: 2222, username: 'u', password: 'p' },
    telnet: config.telnet,
    consoles: { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.212'], portRange: { min: 2000, max: 2050 } },
  });
});

test('settings: values saved for a namespace this version does not know are ignored, with a warning', async (t) => {
  const { repos } = await setup(t);
  await repos.settings.save('retired', { x: 1 });
  const log = recordingLogger();
  const s = await createSettings({ config, repo: repos.settings, logger: log });
  assert.deepEqual(s.namespaces(), ['lab']);
  assert.match(log.lines.find((l) => l.level === 'warn').message, /"retired"/);
});

test('settings: the service needs its repository', async () => {
  await assert.rejects(createSettings({ config }), /settings repository/);
});
