/**
 * Round trip on the simulator, switches (routers: iosRoundTrip.test.js; the
 * two files run in parallel), the path a bench reset + injection takes:
 * configure a device as a group would, capture it (running-config and VLANs),
 * erase and reload it, replay the capture on the factory device, capture it
 * again: both captures must match, line for line, apart from the volatile
 * header comments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundTrip, volatile } from './helpers/ios.js';

test('round trip: layer-3 switch (3560) with VLANs, trunks, a routed port and SVIs', { timeout: 30_000 }, async () => {
  const r = await roundTrip('3560', `configure terminal
hostname S1
ip routing
vlan 10
 name ETUDIANTS
vlan 20
 name PROFS
vlan 99
 name NATIVE
exit
spanning-tree mode rapid-pvst
interface FastEthernet0/1
 description PC etudiant 1
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
interface FastEthernet0/2
 switchport mode access
 switchport access vlan 20
 shutdown
interface FastEthernet0/24
 no switchport
 ip address 10.0.0.2 255.255.255.252
interface GigabitEthernet0/1
 switchport trunk encapsulation dot1q
 switchport mode trunk
 switchport trunk native vlan 99
 switchport trunk allowed vlan 10,20,99
interface GigabitEthernet0/2
 shutdown
interface Vlan10
 ip address 192.168.10.254 255.255.255.0
interface Vlan1
 ip address 192.168.1.2 255.255.255.0
 no shutdown
ip route 0.0.0.0 0.0.0.0 10.0.0.1
end
`);
  assert.equal(volatile(r.after.config), volatile(r.before.config));
  assert.deepEqual(r.vlansAfter, r.vlansBefore);
  assert.deepEqual(r.vlansBefore.filter((v) => v.id > 1 && v.id < 1000).map((v) => v.name), ['ETUDIANTS', 'PROFS', 'NATIVE']);
  assert.match(r.script, /^hostname S1\nvlan 10\n name ETUDIANTS\n/m);
});

test('round trip: Catalyst 9300L (IOS XE 17.6) with VLANs and a trunk', { timeout: 30_000 }, async () => {
  const r = await roundTrip('c9300l', `configure terminal
hostname SW1
vlan 10
 name ETUDIANTS
exit
interface GigabitEthernet1/0/1
 switchport mode access
 switchport access vlan 10
interface GigabitEthernet1/1/1
 switchport mode trunk
 switchport trunk allowed vlan 1,10
interface GigabitEthernet1/0/5
 shutdown
end
`);
  assert.equal(volatile(r.after.config), volatile(r.before.config));
  assert.deepEqual(r.vlansAfter, r.vlansBefore);
});

test('round trip: VTP client (12.2SE) - domain, password, version and mode come back, with suspended and shut VLANs', { timeout: 30_000 }, async () => {
  const r = await roundTrip('3560', `configure terminal
hostname S2
vtp version 2
vtp domain LAB
vtp password s3cr3t
vlan 10
 name ETUDIANTS
vlan 20
 state suspend
vlan 30
 shutdown
exit
vtp mode client
interface FastEthernet0/1
 switchport mode access
 switchport access vlan 10
end
`);
  assert.deepEqual(r.vtpBefore, { version: 2, mode: 'client', domain: 'LAB', pruning: false, password: 's3cr3t' });
  assert.deepEqual(r.vtpAfter, r.vtpBefore);
  assert.deepEqual(r.vlansAfter, r.vlansBefore);
  assert.deepEqual(r.vlansBefore.filter((v) => v.id > 1 && v.id < 1000).map((v) => [v.id, v.status]), [[10, 'active'], [20, 'suspended'], [30, 'act/lshut']]);
  assert.doesNotMatch(r.before.config, /^vtp /m, 'VTP server / client settings are not in show run');
  assert.equal(volatile(r.after.config), volatile(r.before.config));
  // The VLANs are created before "vtp mode client", which forbids it
  assert.ok(r.script.indexOf('vlan 30') < r.script.indexOf('vtp mode client'));
});

test('round trip: VTP transparent (15.0) - the config carries the VTP lines and the VLANs with their state', { timeout: 30_000 }, async () => {
  const r = await roundTrip('2960', `configure terminal
hostname S3
vtp domain LAB
vtp mode transparent
vlan 10
 name ETUDIANTS
vlan 20
 state suspend
end
`);
  assert.match(r.before.config, /^vtp domain LAB\nvtp mode transparent$/m);
  assert.match(r.before.config, /^vlan 20\n state suspend$/m);
  assert.equal(volatile(r.after.config), volatile(r.before.config));
  assert.deepEqual(r.vtpAfter, r.vtpBefore);
  assert.deepEqual(r.vlansAfter, r.vlansBefore);
  assert.equal(r.script.match(/^vtp mode /gm).length, 1, 'not sent twice');
});
