/**
 * The whole chain a bench job uses, end to end on the mock lab: the app's
 * ConsoleSession (SSH to the jump server, telnet to the console port, the
 * console server's login answered by AutoLogin), then the driver on the
 * session's CliAutomation: prepare, identify, backup, erase and reload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLab } from '../dev/mock-lab.js';
import { ConsoleSession } from '../src/modules/consoles/consoleSession.js';
import { CiscoIos } from '../src/lib/drivers/ciscoIos.js';
import { FAST } from './helpers/ios.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const TELNET = { username: 'console', password: 'console-pass' };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('driver over SSH: AutoLogin answers the console server, the driver does the rest', { timeout: 30_000 }, async () => {
  const lab = await startMockLab({
    port: 0, ssh: SSH, telnet: TELNET,
    devices: { '10.0.9.4:2003': { model: '2960', hostname: 'S5', enableSecret: 'class', timeScale: 0.002 } },
  });
  const session = new ConsoleSession({
    target: { host: '10.0.9.4', port: 2003 },
    ssh: { host: '127.0.0.1', port: lab.port, ...SSH, readyTimeoutMs: 5000 },
    telnet: { autoLogin: true, ...TELNET, wakeIdleMs: 300 },
    logger: quiet,
  });
  try {
    const connected = new Promise((resolve) => session.on('status', (s) => { if (s.phase === 'login') resolve(); }));
    session.start();
    await connected; // the console server's login is behind us
    const ios = new CiscoIos(session.cli, { timeouts: { ...FAST, promptMs: 3000, observeMs: 600, quietMs: 300 } });
    const p = await ios.prepare({ enablePasswords: ['class'] });
    assert.equal(p.ok, true, p.message);
    assert.equal(p.hostname, 'S5');
    const id = await ios.identify();
    assert.deepEqual([id.model, id.version, id.configRegister], ['WS-C2960-24TT-L', '15.0(2)SE', '0xF']);
    const backup = await ios.runningConfig();
    assert.match(backup.config, /^hostname S5$/m);
    const reset = await ios.eraseAndReload({ backup: { kind: 'snapshot', snapshotId: 's', config: backup.config, hostname: 'S5' }, facts: id });
    assert.equal(reset.ok, true, `${reset.reason} at ${reset.stage}: ${reset.lastOutput}`);
    assert.equal(reset.hostname, 'Switch');
    assert.equal(lab.device('10.0.9.4:2003').cfg.hostname, 'Switch');
  } finally {
    session.close();
    await lab.close();
  }
});
