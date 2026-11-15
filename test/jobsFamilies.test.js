/**
 * The four device families of the real lab, end to end through the jobs:
 * backup, reset then inject (with the preview's exact scripts), and the
 * round trip compared with the live devices. One more device does not run
 * Cisco IOS: it is detected and left untouched. The 1841 found at register
 * 0x2141 comes back at 0x2102.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startJobsApp, reportOf } from './helpers/jobs.js';

let j;
const FAMILY = ['R1', 'R2', 'R3', 'S1', 'S2'];   // 2811, ISR 4331, 1841 (0x2141), 3560, 9300L
const B = '/api/jobs/benches/B4M';

before(async () => {
  j = await startJobsApp();
  await j.holdBench('student1');
  // What a group leaves behind at the end of a TP
  j.dev('R1').configure(['interface FastEthernet0/0', ' description vers-S1', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 192.168.1.254', 'banner motd #Acces reserve au groupe 3#', 'enable secret TP3secret']);
  j.dev('R2').configure(['interface GigabitEthernet0/0/1', ' ip address 10.1.1.1 255.255.255.252', ' no shutdown', 'exit', 'ip route 10.2.0.0 255.255.0.0 10.1.1.2']);
  j.dev('R3').configure(['interface FastEthernet0/1', ' ip address 172.16.0.1 255.255.0.0', ' no shutdown']);
  j.dev('S1').configure(['vlan 10', ' name ADMIN', 'vlan 20', ' name ELEVES', 'exit', 'ip routing', 'interface Vlan10', ' ip address 10.10.10.1 255.255.255.0', 'exit',
    'interface FastEthernet0/1', ' switchport access vlan 10', 'exit', 'interface FastEthernet0/2', ' switchport access vlan 20']);
  j.dev('S2').configure(['vlan 99', ' name GESTION', 'exit', 'interface GigabitEthernet1/0/5', ' switchport access vlan 99']);
});

after(async () => {
  await j?.close();
});

test('four families: backup, reset then inject the previewed scripts, the devices read back as they were; the Aruba switch is untouched', { timeout: 120_000 }, async () => {
  const backup = await j.api('student1', 'POST', `${B}/backup`, { devices: [...FAMILY, 'S4'].map((n) => j.key(n)), enablePasswords: ['TP3secret'] });
  assert.equal(backup.status, 202);
  const b = await j.until(backup.body.job.id, 60_000);
  assert.equal(b.state, 'done', JSON.stringify(b.devices.filter((d) => d.state !== 'done')));
  assert.equal(reportOf(b, 'S4').state, 'skipped');
  assert.equal(reportOf(b, 'S4').code, 'ios.not_ios');
  assert.deepEqual(FAMILY.map((n) => reportOf(b, n).result.facts.family), ['ios', 'iosxe', 'ios', 'ios', 'iosxe']);
  const snapshot = b.snapshotId;

  // Something else happens on the bench meanwhile
  j.dev('R1').configure(['hostname R1-casse', 'no ip route 0.0.0.0 0.0.0.0 192.168.1.254']);
  j.dev('S1').configure(['no vlan 20']);

  const preview = await j.api('student1', 'POST', `${B}/preview`, { source: { snapshot }, devices: FAMILY.map((n) => j.key(n)) });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.missing, []);
  const r1 = preview.body.devices.find((d) => d.name === 'R1');
  assert.match(r1.script, /^banner motd #Acces reserve au groupe 3#$/m, 'the ^C banner is re-delimited');
  assert.match(r1.script, /^interface FastEthernet0\/0\n description vers-S1\n ip address 192\.168\.1\.1 255\.255\.255\.0\n(?: .+\n)* no shutdown$/m, 'an interface that was up is brought up');
  assert.doesNotMatch(preview.body.devices.find((d) => d.name === 'R2').script, /^license udi/m, 'IOS XE licence lines are not replayed');
  assert.match(preview.body.devices.find((d) => d.name === 'S1').script, /^vlan 20\n name ELEVES$/m, 'VLANs recreated from the backup');

  const scripts = Object.fromEntries(preview.body.devices.map((d) => [d.key, d.sha256]));
  const inject = await j.api('student1', 'POST', `${B}/inject`, {
    source: { snapshot }, devices: FAMILY.map((n) => j.key(n)), scripts, confirm: 'B4M', enablePasswords: ['TP3secret'],
  });
  assert.equal(inject.status, 202, JSON.stringify(inject.body));
  const done = await j.until(inject.body.job.id, 100_000);
  for (const name of FAMILY) {
    const d = reportOf(done, name);
    assert.equal(d.state, 'done', `${name}: ${d.code} at ${d.stage}: ${d.message}`);
    assert.equal(d.result.sha256, scripts[d.key], `${name}: the previewed script was sent`);
    assert.deepEqual(d.result.errors, [], `${name}: no line refused`);
    assert.equal(d.result.saved, true, `${name}: copy run start`);
    assert.match(d.result.reset.hostname, /^(Router|Switch)$/, `${name}: erased first`);
    assert.equal(d.result.check.status, 'same', `${name}: reads back as the snapshot\n${d.result.check.patch}`);
  }
  assert.equal(reportOf(done, 'R3').result.reset.register, '0x2141 -> 0x2102', 'the 1841 boots its configuration again');
  assert.equal(j.dev('R3').confReg, '0x2102');
  assert.equal(j.dev('R1').cfg.hostname, 'R1');
  assert.ok(j.dev('S1').startup, 'saved to the startup-config');
  assert.ok(done.snapshotId && done.snapshotId !== snapshot, 'what each device held before was backed up first');

  // Round trip: the snapshot against the live devices
  const compare = await j.api('student1', 'POST', `${B}/compare`, { snapshot, devices: [...FAMILY, 'S4'].map((n) => j.key(n)), enablePasswords: ['TP3secret'] });
  const c = await j.until(compare.body.job.id, 60_000);
  for (const name of FAMILY) assert.equal(reportOf(c, name).result.check.status, 'same', `${name}: ${reportOf(c, name).result?.check?.patch}`);
  assert.equal(reportOf(c, 'S4').state, 'skipped');
  assert.deepEqual(j.dev('S4').commandLog.filter((cmd) => /erase|reload|delete|write|copy|conf/.test(cmd)), [], 'nothing but show commands reached the Aruba switch');

  // A change on the live device shows in the next comparison
  j.dev('R2').configure(['interface GigabitEthernet0/0/1', ' description changed-live']);
  const again = await j.api('student1', 'POST', `${B}/compare`, { snapshot, devices: [j.key('R2')] });
  const c2 = await j.until(again.body.job.id, 30_000);
  const r2 = reportOf(c2, 'R2').result.check;
  assert.equal(r2.status, 'changed');
  assert.match(r2.patch, /^\+ description changed-live$/m);
});
