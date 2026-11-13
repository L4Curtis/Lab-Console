import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettings } from '../src/lib/settings.js';

const config = {
  ssh: { host: 'jump', port: 22, username: 'u', password: 'p' },
  telnet: { username: 't', password: 'q', autoLogin: true },
  consoles: { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.211'], portRange: { min: 2000, max: 2099 } },
};

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
});
