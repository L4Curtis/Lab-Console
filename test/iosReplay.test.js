/**
 * toReplayScript() and comparableConfig() on running-configs written from
 * real IOS output (test/fixtures/ios/), not from what the simulator prints:
 * a classic router with ^C banners and mixed shut / no-shut interfaces, a
 * layer-3 switch with VLANs and trunks, an IOS XE router and a Catalyst 9300L
 * with certificate chains, licence and factory blocks
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toReplayScript, comparableConfig, parseVlanBrief } from '../src/lib/drivers/ciscoIos.js';
import { parseScript } from '../src/lib/cliAutomation.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ios');
const fixture = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const lines = (script) => script.trimEnd().split('\n');

/** The block of `head` in a script: the head and its indented lines */
function block(script, head) {
  const l = lines(script);
  const at = l.indexOf(head);
  assert.ok(at >= 0, `"${head}" is in the script`);
  const out = [head];
  for (let i = at + 1; i < l.length && /^\s/.test(l[i]); i++) out.push(l[i]);
  return out;
}

test('replay: a classic router - wrapped, header and markers dropped, ^C banners re-delimited', () => {
  const { script, dropped } = toReplayScript(fixture('router-2811.txt'), { facts: { kind: 'router', family: 'ios' } });
  const l = lines(script);
  assert.equal(l[0], 'configure terminal');
  assert.equal(l.at(-1), 'end');
  assert.equal(l.filter((x) => x === 'end').length, 1, 'the config\'s own "end" is not sent twice');
  for (const gone of [/^Building configuration/, /^Current configuration/, /^version /, /^boot-(start|end)-marker/, /^!\s*$/, /^! (Last|NVRAM)/, /^ntp clock-period/]) {
    assert.ok(!l.some((x) => gone.test(x)), `${gone} is not sent`);
  }
  assert.ok(l.includes('ntp server 10.1.1.2'), 'the rest of ntp stays');
  assert.deepEqual(dropped.map((d) => d.reason).sort(), ['boot marker', 'boot marker', 'computed by the device', 'set by the software image']);

  // One-line banner, then a multi-line one whose text has a line starting with "!"
  assert.ok(l.includes('banner login #Acces reserve aux etudiants#'));
  const motd = l.indexOf('banner motd #');
  assert.ok(motd > 0);
  assert.deepEqual(l.slice(motd, motd + 6), ['banner motd #', '*****************************************', '*  Labo A - R1 - TP OSPF                *',
    '! Ne pas modifier sans prevenir !', '*****************************************', '#']);
  assert.ok(!script.includes('^C'));
  // Sent with skipComments: false, the "!" line of the banner survives
  assert.ok(parseScript(script, false).some((x) => x.text === '! Ne pas modifier sans prevenir !'));
});

test('replay: interfaces that were up get "no shutdown", shut ones stay shut', () => {
  const { script } = toReplayScript(fixture('router-2811.txt'), { facts: { kind: 'router' } });
  assert.deepEqual(block(script, 'interface FastEthernet0/0'), ['interface FastEthernet0/0', ' no ip address', ' duplex auto', ' speed auto', ' no shutdown']);
  assert.deepEqual(block(script, 'interface FastEthernet0/0.10'), ['interface FastEthernet0/0.10', ' description VLAN 10 - etudiants', ' encapsulation dot1Q 10', ' ip address 192.168.10.1 255.255.255.0', ' no shutdown']);
  assert.deepEqual(block(script, 'interface FastEthernet0/1'), ['interface FastEthernet0/1', ' ip address 10.0.0.1 255.255.255.252', ' shutdown', ' duplex auto', ' speed auto']);
  assert.ok(block(script, 'interface Serial0/0/0').includes(' no shutdown'));
  assert.ok(!block(script, 'interface Serial0/0/1').includes(' no shutdown'));
  assert.ok(block(script, 'interface Loopback0').includes(' no shutdown'));
  // Secrets keep their type: IOS takes the hash back as it is
  assert.ok(lines(script).includes('enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0'));
  assert.ok(block(script, 'line con 0').includes(' password 7 0822455D0A16'));
  // Nested blocks and their indentation are kept
  assert.deepEqual(block(script, 'archive'), ['archive', ' log config', '  hidekeys']);
  assert.deepEqual(block(script, 'ip dhcp pool LAN10'), ['ip dhcp pool LAN10', '   network 192.168.10.0 255.255.255.0', '   default-router 192.168.10.1', '   dns-server 8.8.8.8']);
});

test('replay: a switch - VLANs from show vlan brief come first, trunks and routed ports as they were', () => {
  const vlans = parseVlanBrief(fixture('switch-3560.vlan.txt'));
  assert.deepEqual(vlans.map((v) => [v.id, v.name, v.status]), [[1, 'default', 'active'], [10, 'ETUDIANTS', 'active'], [20, 'PROFS', 'active'], [99, 'NATIVE', 'active'],
    [1002, 'fddi-default', 'act/unsup'], [1003, 'token-ring-default', 'act/unsup'], [1004, 'fddinet-default', 'act/unsup'], [1005, 'trnet-default', 'act/unsup']]);
  assert.equal(vlans[0].ports.length, 22);
  assert.deepEqual(vlans[1].ports, ['Fa0/1']);

  const { script, vlans: created } = toReplayScript(fixture('switch-3560.txt'), { vlans, facts: { kind: 'switch', family: 'ios' } });
  const l = lines(script);
  assert.deepEqual(created, [10, 20, 99]);
  const host = l.indexOf('hostname S1');
  assert.deepEqual(l.slice(host + 1, host + 8), ['vlan 10', ' name ETUDIANTS', 'vlan 20', ' name PROFS', 'vlan 99', ' name NATIVE', 'exit']);
  assert.ok(l.indexOf('vlan 10') < l.indexOf('interface FastEthernet0/1'), 'VLANs exist before ports join them');
  assert.deepEqual(block(script, 'interface GigabitEthernet0/1'), ['interface GigabitEthernet0/1', ' description Trunk vers S2', ' switchport trunk encapsulation dot1q',
    ' switchport trunk native vlan 99', ' switchport trunk allowed vlan 10,20,99', ' switchport mode trunk', ' no shutdown']);
  assert.deepEqual(block(script, 'interface FastEthernet0/2'), ['interface FastEthernet0/2', ' switchport access vlan 20', ' switchport mode access', ' shutdown']);
  assert.deepEqual(block(script, 'interface FastEthernet0/24'), ['interface FastEthernet0/24', ' no switchport', ' ip address 10.0.0.2 255.255.255.252', ' no shutdown']);
  assert.deepEqual(block(script, 'interface Vlan1'), ['interface Vlan1', ' no ip address', ' shutdown']);
  assert.ok(block(script, 'interface Vlan10').includes(' no shutdown'));
  assert.ok(l.includes('ip routing'));
});

test('replay: VLANs as raw show vlan brief text work too; routers get none; default VLANs never', () => {
  const raw = fixture('switch-3560.vlan.txt');
  assert.deepEqual(toReplayScript(fixture('switch-3560.txt'), { vlans: raw, facts: { kind: 'switch' } }).vlans, [10, 20, 99]);
  assert.deepEqual(toReplayScript(fixture('router-2811.txt'), { vlans: raw, facts: { kind: 'router' } }).vlans, []);
  const { script } = toReplayScript('hostname S9\nend\n', { vlans: [{ id: 1, name: 'default' }, { id: 1002, name: 'fddi-default' }, { id: 30, name: 'VLAN0030' }, { id: 31, name: 'bad name;rm' }] });
  assert.deepEqual(lines(script), ['configure terminal', 'hostname S9', 'vlan 30', 'vlan 31', 'exit', 'end'], 'default names and unsafe names are not sent');
});

test('replay: IOS XE - certificate chains, licence, platform and factory blocks dropped, the rest kept', () => {
  const { script, dropped } = toReplayScript(fixture('router-isr4331.txt'), { facts: { kind: 'router', family: 'iosxe' } });
  const l = lines(script);
  for (const gone of [/^crypto pki/, /^ ?certificate /, /^\s+[0-9A-F]{8} /, /quit/, /^license /, /^platform /, /^diagnostic /, /^redundancy/, /^ mode none/]) {
    assert.ok(!l.some((x) => gone.test(x)), `${gone} is not sent`);
  }
  const reasons = Object.fromEntries(dropped.map((d) => [d.text, d.reason]));
  assert.equal(reasons['crypto pki certificate chain TP-self-signed-2138794470'], 'certificate: generated by the device itself');
  assert.equal(reasons['license udi pid ISR4331/K9 sn FDO21230ABC'], 'licence: tied to the chassis, not replayable');
  assert.equal(dropped.find((d) => d.text.startsWith('crypto pki certificate chain SLA')).lines, 7, 'the whole chain, quit included');
  // Kept: boot system (between the markers), vrf definition, secrets, ssh, routing
  for (const kept of ['boot system bootflash:isr4300-universalk9.17.03.04a.SPA.bin', 'vrf definition Mgmt-intf', ' address-family ipv4', ' exit-address-family',
    'enable secret 9 $9$3Pz1oWZcKqVkUE$Lw7c3W.jxwUuSA1r0eGbn2Tgg9w2eHq5iQ0bS7mF0Xo', 'ip ssh version 2', 'router ospf 1', 'login on-success log']) {
    assert.ok(l.includes(kept), `${kept} is sent`);
  }
  // A banner that contains "#" gets another delimiter
  assert.ok(l.includes('banner motd %R1 : routeur du labo # TP OSPF%'));
  assert.deepEqual(block(script, 'interface GigabitEthernet0/0/2'), ['interface GigabitEthernet0/0/2', ' ip address 10.0.12.1 255.255.255.252', ' shutdown', ' negotiation auto']);
  assert.ok(block(script, 'interface Serial0/1/0').includes(' no shutdown'));
});

test('replay: Catalyst 9300L - VLANs defined in the config (VTP transparent) are not doubled; call-home and system policies dropped', () => {
  const vlans = [{ id: 1, name: 'default' }, { id: 10, name: 'ETUDIANTS' }, { id: 20, name: 'PROFS' }, { id: 99, name: 'NATIVE' }, { id: 30, name: 'INVITES' }];
  const { script, vlans: created, dropped } = toReplayScript(fixture('switch-c9300l.txt'), { vlans, facts: { kind: 'switch', family: 'iosxe' } });
  const l = lines(script);
  assert.deepEqual(created, [30], 'only the VLAN missing from the config is added');
  assert.equal(l.filter((x) => x === 'vlan 10').length, 1);
  for (const gone of [/^call-home/, /contact-email-addr/, /^class-map .*system-cpp/, /^policy-map system-cpp/, /^license boot/, /^redundancy/]) {
    assert.ok(!l.some((x) => gone.test(x)), `${gone} is not sent`);
  }
  assert.ok(dropped.some((d) => d.text === 'call-home' && d.lines === 7));
  for (const kept of ['switch 1 provision c9300l-24t-4g', 'vtp mode transparent', 'transceiver type all', ' monitoring', 'control-plane', ' service-policy input system-cpp-policy']) {
    assert.ok(l.includes(kept), `${kept} is sent`);
  }
  assert.ok(block(script, 'interface GigabitEthernet1/1/1').includes(' no shutdown'));
  assert.ok(block(script, 'interface GigabitEthernet1/0/2').includes(' shutdown'));
});

test('replay: optional RSA keys are generated right after the domain name', () => {
  const { script } = toReplayScript(fixture('router-isr4331.txt'), { rsaModulus: 2048 });
  const l = lines(script);
  assert.equal(l[l.indexOf('ip domain name tp.lab') + 1], 'crypto key generate rsa general-keys modulus 2048');
  assert.ok(!toReplayScript(fixture('switch-3560.txt'), { rsaModulus: 2048 }).script.includes('crypto key'), 'no domain name: no keys');
  assert.ok(!toReplayScript(fixture('router-isr4331.txt'), { rsaModulus: 1234 }).script.includes('crypto key'), 'odd modulus refused');
});

test('comparableConfig ignores the header, comments, volatile and non-replayable lines', () => {
  const a = fixture('router-isr4331.txt');
  const b = a.replace('Current configuration : 6412 bytes', 'Current configuration : 6399 bytes')
    .replace('! Last configuration change at 22:31:07 UTC Thu Nov 12 2026', '! Last configuration change at 09:00:00 UTC Fri Nov 13 2026')
    .replace(/D4B0A6E7 4F2C9B1A 77E0C8F3 1E66B0E2 9A/, 'AAAAAAAA BBBBBBBB')
    .replace('license udi pid ISR4331/K9 sn FDO21230ABC', 'license udi pid ISR4331/K9 sn FDO99999XYZ');
  assert.equal(comparableConfig(a), comparableConfig(b));
  assert.notEqual(comparableConfig(a), comparableConfig(a.replace('router-id 2.2.2.2', 'router-id 2.2.2.3')));
  assert.match(comparableConfig(a), /^banner motd \^CR1 : routeur du labo # TP OSPF\^C$/m);
});
