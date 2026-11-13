/**
 * eraseAndReload() against the simulator: "no backup, no erase", a router and
 * a switch (vlan.dat), IOS XE (Plug-and-Play, stack), the configuration
 * register, and boots that go wrong: stalled, ROMMON, an unknown question,
 * cancellation. Output and input go through setImmediate like a network stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackupProof } from '../src/lib/drivers/ciscoIos.js';
import { rig, BACKUP } from './helpers/ios.js';

test('eraseAndReload refuses to start without proof of a backup', async () => {
  for (const backup of [undefined, null, {}, { kind: 'snapshot', snapshotId: 'x', config: '' }, { kind: 'snapshot', config: 'hostname R1' }, { kind: 'override', by: '' }]) {
    const { ios, done, written } = rig({ model: '2811', start: 'privileged' });
    const r = await ios.eraseAndReload({ backup });
    done();
    assert.equal(r.reason, 'ios.no_backup');
    assert.equal(r.stage, 'check');
    assert.equal(written(), '', 'nothing typed');
  }
  assert.equal(checkBackupProof({ kind: 'override', by: 'admin', reason: 'backup failed, ticked by hand' }).ok, true);
});

test('eraseAndReload: the jobs\' own check and the backup\'s hostname are honoured', async () => {
  const a = rig({ model: '2811', start: 'privileged' });
  const r = await a.ios.eraseAndReload({ backup: BACKUP, verifyBackup: async () => false });
  a.done();
  assert.equal(r.reason, 'ios.no_backup');
  assert.equal(a.dev.commandLog.length, 0);

  const b = rig({ model: '2811', start: 'privileged' });
  const s = await b.ios.eraseAndReload({ backup: { ...BACKUP, hostname: 'R2' } });
  b.done();
  assert.equal(s.reason, 'ios.backup_mismatch');
  assert.deepEqual(s.params, { expected: 'R2', hostname: 'R1' });
  assert.ok(!b.dev.commandLog.some((c) => /erase|reload/.test(c)));
});

test('eraseAndReload on a router: erased, reloaded without saving, dialog answered, Router#', async () => {
  const { dev, ios, done, progress } = rig({ model: '2811', start: 'privileged' });
  dev.configure(['hostname R9', 'enable secret class', 'interface FastEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  dev.save();
  dev.configure(['interface Loopback0']); // unsaved change: IOS will ask "Save?"
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, hostname: 'R9' } });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.equal(r.hostname, 'Router');
  assert.equal(r.vlanDat, 'n/a');
  assert.deepEqual(r.answered, ['dialog']);
  assert.equal(dev.startup, null);
  assert.equal(dev.cfg.hostname, 'Router');
  assert.equal(dev.mode, '#');
  assert.ok(dev.cfg.interfaces.get('FastEthernet0/0').shutdown, 'factory interfaces are shut');
  assert.ok(dev.commandLog.includes('erase startup-config') && dev.commandLog.includes('reload'));
  assert.ok(progress.includes('ios.steps.boot') && progress.includes('ios.steps.factory_check'));
});

test('eraseAndReload on a switch: vlan.dat deleted, VLANs gone, factory Switch#', async () => {
  const { dev, ios, done } = rig({ model: '3560', start: 'privileged' });
  dev.configure(['vlan 10', 'name ETUDIANTS', 'exit', 'vlan 20', 'exit', 'hostname S1']);
  dev.save();
  assert.ok(dev.vlanFile, 'the VLANs are in flash:vlan.dat');
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, hostname: 'S1' } });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.equal(r.vlanDat, 'deleted');
  assert.deepEqual(r.answered, ['dialog', 'autoinstall']);
  assert.equal(dev.vlanFile, null);
  assert.deepEqual([...dev.vlans.keys()], [1, 1002, 1003, 1004, 1005]);
  assert.equal(r.hostname, 'Switch');
});

test('eraseAndReload: IOS XE waits for Plug-and-Play to stop, the 9300L stack question is handled', async () => {
  const { dev, ios, done } = rig({ model: 'c9300l', start: 'privileged' });
  dev.configure(['hostname SW1']);
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, config: 'hostname SW1\nend\n' } });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.register, null, 'no configuration register on a 9300L');
});

test('eraseAndReload: a router at 0x2141 is set back to 0x2102 and boots its (empty) configuration', async () => {
  const { dev, ios, done } = rig({ model: '1841', start: 'privileged', confReg: '0x2141' });
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.equal(r.register, '0x2141 -> 0x2102');
  assert.equal(dev.confReg, '0x2102');
});

test('eraseAndReload: a boot that stalls is reported with where it stopped', async () => {
  const { ios, done } = rig({ model: '2811', start: 'privileged', bootFailure: 'stall' });
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ios.boot_stalled');
  assert.equal(r.stage, 'boot');
  assert.match(r.lastOutput, /Self decompressing the image|Readonly ROMMON/);
});

test('eraseAndReload: a reload that ends in ROMMON is reported', async () => {
  const { ios, done } = rig({ model: 'isr4331', start: 'privileged', bootFailure: 'rommon' });
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(r.reason, 'ios.rommon');
  assert.equal(r.stage, 'boot');
});

test('eraseAndReload: an unknown first-boot question stops it, unanswered', async () => {
  const { dev, ios, done } = rig({ model: 'c9300l', start: 'privileged', firstBootExtra: 'Enter enable secret: ' });
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ios.unknown_question');
  assert.equal(r.params.question, 'Enter enable secret:');
  assert.equal(r.stage, 'dialog');
  assert.equal(dev.state, 'extra', 'the question was not answered');
});

test('eraseAndReload: cancellation stops it and says at which stage', async () => {
  const { cli, ios, done } = rig({ model: '2811', start: 'privileged', timeScale: 0.02 });
  const run = ios.eraseAndReload({ backup: BACKUP });
  await new Promise((r) => setTimeout(r, 900));
  cli.cancel();
  await assert.rejects(run, (e) => e.cancelled === true && e.stage === 'boot');
  done();
});

test('eraseAndReload: a "reload" that brings the prompt back without a boot is reported', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  // A device that answers the confirmation with its prompt instead of reloading
  let lastOut = '';
  const out = dev.out;
  dev.out = (text) => { lastOut = text; out(text); };
  const input = dev.input.bind(dev);
  dev.input = (text) => {
    if (text === '\r' && /Proceed with reload\? \[confirm\]/.test(lastOut)) return dev.out('\r\nR1#');
    input(text);
  };
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(r.reason, 'ios.reload_refused');
  assert.equal(r.stage, 'boot');
});

// ── refusals and checks that stop the reset ─────────────────────────────────

/** Change what the device receives when Enter ends `from` (the echo still shows what was typed) */
function rewriteLine(dev, from, to) {
  const input = dev.input.bind(dev);
  dev.input = (text) => { for (const ch of text) { if (ch === '\r' && dev.line.trim() === from) dev.line = to; input(ch); } };
}
/** After each [confirm] is answered, put back what the device should have lost (an erase that did not erase) */
function survives(dev, restore) {
  const input = dev.input.bind(dev);
  dev.input = (text) => { const confirming = dev.state === 'confirm'; input(text); if (confirming) restore(); };
}

test('eraseAndReload refuses a device in user EXEC', async () => {
  const { dev, ios, done } = rig({ model: '2811' });
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.not_privileged', 'check']);
  assert.ok(!dev.commandLog.some((c) => /erase|reload/.test(c)));
});

test('eraseAndReload leaves a device that is not IOS untouched', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  const out = dev.out;
  dev.out = (text) => out(text.replace(/Cisco IOS Software/g, 'Acme NOS Software'));
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.not_ios', 'check']);
  assert.ok(!dev.commandLog.some((c) => /erase|reload/.test(c)));
});

test('eraseAndReload stops when the erase is not confirmed, before any reload', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  dev.save();
  rewriteLine(dev, 'erase startup-config', 'erase nothing');
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.erase_failed', 'erase']);
  assert.ok(dev.startup, 'nothing erased');
  assert.ok(!dev.commandLog.includes('reload'));
});

test('eraseAndReload stops when flash:vlan.dat cannot be deleted', async () => {
  const { dev, ios, done } = rig({ model: '3560', start: 'privileged', deleteError: 'Permission denied' });
  dev.configure(['vlan 10', 'exit']);
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.vlan_delete_failed', 'vlan']);
  assert.match(r.params.detail, /%Error deleting flash:\/vlan\.dat \(Permission denied\)/);
  assert.ok(dev.vlanFile);
  assert.ok(!dev.commandLog.includes('reload'));
});

test('eraseAndReload stops when the configuration register is refused', async () => {
  const { dev, ios, done } = rig({ model: '1841', start: 'privileged', confReg: '0x2141' });
  rewriteLine(dev, 'config-register 0x2102', 'config-register 0xZZ');
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.register_failed', 'register']);
  assert.ok(!dev.commandLog.includes('reload'));
});

test('eraseAndReload: a pending register (0x2142 at next reload) is set back to 0x2102', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  dev.configure(['config-register 0x2142']);
  const facts = await ios.identify();
  assert.deepEqual([facts.configRegister, facts.nextConfigRegister, facts.registerOk], ['0x2102', '0x2142', false]);
  const r = await ios.eraseAndReload({ backup: BACKUP, facts });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.equal(r.register, '0x2142 -> 0x2102');
  assert.equal(dev.confReg, '0x2102');
});

test('eraseAndReload: a register left unusual on purpose is checked again after the boot', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  dev.configure(['config-register 0x2142']);
  const r = await ios.eraseAndReload({ backup: BACKUP, fixConfigRegister: false });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.deepEqual(r.warnings, ['register_unusual']);
  assert.equal(dev.confReg, '0x2142');
});

test('eraseAndReload: a startup-config that survives is reported (hostname kept)', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  dev.configure(['hostname R9']);
  dev.save();
  const saved = structuredClone(dev.startup);
  survives(dev, () => { dev.startup = structuredClone(saved); });
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, config: 'hostname R9\nend\n' } });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.not_factory', 'factory_check']);
  assert.match(r.params.detail, /hostname is still R9/);
});

test('eraseAndReload: a startup-config that survives is reported (enable still asks a password)', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  dev.configure(['hostname Router', 'enable secret class']);
  dev.save();
  const saved = structuredClone(dev.startup);
  survives(dev, () => { dev.startup = structuredClone(saved); });
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, config: 'hostname Router\nend\n' } });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.not_factory', 'factory_check']);
  assert.match(r.params.detail, /enable asks for a password/);
});

test('eraseAndReload: a surviving startup-config is seen even with the default hostname and no secret', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  dev.configure(['hostname Router', 'interface Loopback0']);
  dev.save();
  const saved = structuredClone(dev.startup);
  survives(dev, () => { dev.startup = structuredClone(saved); });
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, config: 'hostname Router\nend\n' } });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.not_factory', 'factory_check']);
  assert.match(r.params.detail, /startup-config is still present/);
});

test('eraseAndReload: VLANs still there after the reload are reported', async () => {
  const { dev, ios, done } = rig({ model: '3560', start: 'privileged' });
  dev.configure(['vlan 10', 'exit', 'vlan 20', 'exit']);
  const vlans = structuredClone(dev.vlanFile);
  survives(dev, () => { dev.vlanFile = structuredClone(vlans); });
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.vlans_survived', 'factory_check']);
  assert.equal(r.params.vlans, '10, 20');
});

test('eraseAndReload: without an explicit hostname, the backup\'s own "hostname" line must match the prompt', async () => {
  assert.equal(checkBackupProof({ kind: 'snapshot', snapshotId: 's', config: 'version 12.4\nhostname R2\nend\n' }).hostname, 'R2');
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  const r = await ios.eraseAndReload({ backup: { kind: 'snapshot', snapshotId: 's', config: 'version 12.4\nhostname R2\nend\n' } });
  done();
  assert.deepEqual([r.reason, r.stage], ['ios.backup_mismatch', 'check']);
  assert.ok(!dev.commandLog.some((c) => /erase|reload/.test(c)));
});

// ── classic IOS boot output ─────────────────────────────────────────────────

test('eraseAndReload on a 12.2SE switch with uptime-stamped syslog lines', async () => {
  const { dev, ios, done } = rig({ model: '3560v2', hostname: 'S5', start: 'privileged', stamps: 'uptime' });
  const seen = [];
  const out = dev.out;
  dev.out = (text) => { seen.push(text); out(text); };
  dev.configure(['vlan 10', 'exit']);
  const r = await ios.eraseAndReload({ backup: { ...BACKUP, hostname: 'S5' } });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.match(seen.join(''), /S5#\r\n\d{2}:\d{2}:\d{2}: %SYS-7-NV_BLOCK_INIT/, 'the syslog line lands after the prompt');
  assert.equal(r.hostname, 'Switch');
});

test('eraseAndReload: the multi-line %SYS-5-RESTART after "Press RETURN" does not stall the boot follow-up', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  const seen = [];
  const out = dev.out;
  dev.out = (text) => { seen.push(text); out(text); };
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
  assert.match(seen.join(''), /Press RETURN to get started![\s\S]*%SYS-5-RESTART: System restarted --\r\nCisco IOS Software[\s\S]*by prod_rel_team/);
});

test('eraseAndReload: after "Press RETURN", an unknown quiet screen gets an Enter (a dropped Enter)', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  let dropped = 0;
  const input = dev.input.bind(dev);
  dev.input = (text) => {
    if (text === '\r' && dev.state === 'pressreturn' && !dropped) { dropped++; dev.out('\r\nSome text the driver does not know'); return; }
    input(text);
  };
  const r = await ios.eraseAndReload({ backup: BACKUP });
  done();
  assert.equal(dropped, 1);
  assert.equal(r.ok, true, `${r.reason} at ${r.stage}: ${r.lastOutput}`);
});
