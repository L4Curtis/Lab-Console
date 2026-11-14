/**
 * Bench checks, the pure parts: what real IOS 12.4 / 15.x / IOS XE 17 print
 * for `show cdp neighbors detail`, `show ip interface brief` and `ping`
 * (fixtures written after the real output), interface names as people write
 * them, the links a diagram draws, and the cabling verdict
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCdpNeighbors, parseIpInterfaceBrief, countRows, parsePing } from '../src/lib/drivers/ciscoIos.js';
import { canonicalPort, samePort, fullPort, shortPort } from '../src/modules/checks/ports.js';
import { diagramLinks } from '../src/modules/checks/links.js';
import { compareCabling, hostKey } from '../src/modules/checks/cabling.js';
import { parseDrawio } from '../src/modules/consoles/drawio.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/checks/${name}`, import.meta.url), 'utf8');

describe('parsing real output', () => {
  test('show cdp neighbors detail, IOS 12.4T on a 2811: a switch and a router over a serial link', () => {
    const n = parseCdpNeighbors(fixture('cdp-2811-124.txt'));
    assert.equal(n.length, 2);
    assert.deepEqual(
      { deviceId: n[0].deviceId, ip: n[0].ip, platform: n[0].platform, capabilities: n[0].capabilities, localInterface: n[0].localInterface, remoteInterface: n[0].remoteInterface, nativeVlan: n[0].nativeVlan, duplex: n[0].duplex },
      { deviceId: 'S1', ip: '192.168.1.2', platform: 'WS-C2960-24TT-L', capabilities: 'Switch IGMP', localInterface: 'FastEthernet0/0', remoteInterface: 'FastEthernet0/24', nativeVlan: 1, duplex: 'full' },
    );
    assert.match(n[0].version, /^Cisco IOS Software, C2960 Software/);
    assert.equal(n[1].deviceId, 'R2-3014');
    assert.equal(n[1].platform, '2811');
    assert.equal(n[1].localInterface, 'Serial0/0/0');
    assert.equal(n[1].remoteInterface, 'Serial0/0/1');
    assert.equal(n[1].duplex, null, 'a serial link has no duplex');
  });

  test('show cdp neighbors detail, IOS 15.0SE on a 2960: a neighbour with no address, a domain name, PoE lines', () => {
    const n = parseCdpNeighbors(fixture('cdp-2960-150.txt'));
    assert.equal(n.length, 2);
    assert.equal(n[0].deviceId, 'R1-3001');
    assert.equal(n[0].ip, null, '"Entry address(es):" with nothing under it');
    assert.equal(n[0].localInterface, 'FastEthernet0/24');
    assert.equal(n[0].remoteInterface, 'FastEthernet0/0');
    assert.equal(n[1].deviceId, 'S2.lab.local');
    assert.equal(n[1].nativeVlan, 99);
    assert.equal(hostKey(n[1].deviceId), 's2');
  });

  test('show cdp neighbors detail, IOS XE 17.3 on an ISR 4331: IPv6 lines and the total line are not neighbours', () => {
    const n = parseCdpNeighbors(fixture('cdp-isr4331-173.txt'));
    assert.deepEqual(n.map((x) => [x.deviceId, x.ip, x.platform, x.localInterface, x.remoteInterface]), [
      ['SW1-3005', '192.168.10.2', 'C9300L-24T-4G', 'GigabitEthernet0/0/2', 'GigabitEthernet1/0/24'],
      ['R2-3012', '10.0.12.2', 'ISR4331/K9', 'GigabitEthernet0/0/0', 'GigabitEthernet0/0/0'],
    ]);
  });

  test('show ip interface brief, IOS XE 17.3: a sub-interface glued to its address, shut, down, a loopback', () => {
    const i = parseIpInterfaceBrief(fixture('ipbrief-isr4331-173.txt'));
    assert.equal(i.length, 9);
    assert.deepEqual(i[0], { name: 'GigabitEthernet0/0/0', ip: '10.0.12.1', ok: true, method: 'manual', status: 'up', protocol: 'up' });
    assert.deepEqual(i[1], { name: 'GigabitEthernet0/0/1', ip: null, ok: true, method: 'unset', status: 'administratively down', protocol: 'down' });
    assert.equal(i[3].name, 'GigabitEthernet0/0/2.20');
    assert.equal(i[3].ip, '192.168.20.1');
    assert.equal(i[4].status, 'down');
    assert.equal(i[6].method, 'NVRAM');
  });

  test('show ip interface brief: a name as long as its column is glued to "unassigned" and is still read; every row is counted', () => {
    const text = fixture('ipbrief-isr4331-173.txt');
    const glued = text.split('\n').find((l) => l.includes('.100unassigned'));
    assert.ok(glued, 'the fixture has a really glued line');
    const i = parseIpInterfaceBrief(text).find((x) => x.name === 'GigabitEthernet0/0/2.100');
    assert.deepEqual(i, { name: 'GigabitEthernet0/0/2.100', ip: null, ok: true, method: 'unset', status: 'up', protocol: 'up' });
    assert.equal(countRows(text), 9);
    // A row glued to an address that ends in a digit cannot be split: it is dropped, and counted as a row nobody read
    const ambiguous = 'GigabitEthernet0/0/0.10010.0.0.1 YES manual up                    up\n';
    assert.equal(parseIpInterfaceBrief(ambiguous).length, 0);
    assert.equal(countRows(ambiguous), 1);
  });

  test('show ip interface brief, IOS 12.2SE on a 2960: SVIs, an SVI up with its protocol down, a port-channel', () => {
    const i = parseIpInterfaceBrief(fixture('ipbrief-2960-122.txt'));
    assert.equal(i.length, 7);
    assert.deepEqual(i.find((x) => x.name === 'Vlan99'), { name: 'Vlan99', ip: null, ok: true, method: 'unset', status: 'up', protocol: 'down' });
    assert.equal(i.find((x) => x.name === 'Vlan1').ip, '192.168.1.2');
    assert.ok(i.some((x) => x.name === 'Port-channel1'));
  });

  test('ping: the first echo lost to ARP, and an unreachable network', () => {
    assert.deepEqual(parsePing(fixture('ping-124.txt')), { successRate: 80, received: 4, sent: 5, marks: '.!!!!', rtt: { min: 1, avg: 2, max: 4 } });
    assert.deepEqual(parsePing(fixture('ping-xe-fail.txt')), { successRate: 0, received: 0, sent: 5, marks: 'U.U.U', rtt: null });
    assert.equal(parsePing('% Unrecognized host or address, or protocol not running.'), null);
  });
});

describe('interface names', () => {
  test('every way the diagrams and IOS write a port is the same port', () => {
    assert.ok(samePort('fa0/5', 'FastEthernet0/5'));
    assert.ok(samePort('fe0/0', 'Fa0/0'));
    assert.ok(samePort('g0/0/1', 'GigabitEthernet0/0/1'));
    assert.ok(samePort('gi1/0/24', 'Gi1/0/24'));
    assert.ok(samePort('s0/1/1', 'Serial0/1/1'));
    assert.ok(samePort('Fa 0/1', 'FastEthernet0/1'));
    assert.ok(!samePort('fa0/5', 'fa0/6'));
    assert.ok(!samePort('fa0/1', 'gi0/1'));
    assert.equal(fullPort('se0/0/0'), 'Serial0/0/0');
    assert.equal(shortPort('GigabitEthernet1/0/24'), 'Gi1/0/24');
  });

  test('what is written on a link and is not a port', () => {
    for (const text of ['VLAN 10', '192.168.1.0/24', 'S1', 'e1', 'trunk', '', 'fa0/5 trunk']) assert.equal(canonicalPort(text), null, text);
    assert.equal(canonicalPort('Vlan10'), 'vlan10');
    assert.equal(canonicalPort('Po1'), 'port-channel1');
  });
});

describe('the links of a diagram', () => {
  const page = (cells) => `<mxfile><diagram id="p" name="LAB"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="r1" value="R1&lt;br&gt;.1 - 2001" vertex="1" parent="1"><mxGeometry x="0" y="0" width="40" height="40" as="geometry"/></mxCell>
    <mxCell id="s1" value="S1&lt;br&gt;.1 - 2002" vertex="1" parent="1"><mxGeometry x="0" y="300" width="40" height="40" as="geometry"/></mxCell>
    <mxCell id="pc" value="PC" vertex="1" parent="1"><mxGeometry x="300" y="300" width="40" height="40" as="geometry"/></mxCell>
    ${cells}</root></mxGraphModel></diagram></mxfile>`;
  const edge = (id, source, target, labels) => `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>
    ${labels.map(([text, x], i) => `<mxCell id="${id}-l${i}" value="${text}" style="edgeLabel;" vertex="1" connectable="0" parent="${id}"><mxGeometry x="${x}" relative="1" as="geometry"/></mxCell>`).join('')}`;
  const links = (cells) => diagramLinks(parseDrawio(page(cells)).labs[0]);

  test('a label at each end gives each end its port', () => {
    const [l] = links(edge('e', 'r1', 's1', [['fe0/0', -0.6], ['fa0/24', 0.7]]));
    assert.deepEqual(l.a, { key: 'p:r1', name: 'R1', port: 'FastEthernet0/0', assumed: false });
    assert.deepEqual(l.b, { key: 'p:s1', name: 'S1', port: 'FastEthernet0/24', assumed: false });
  });

  test('one label in the middle is the port of both ends, marked as assumed; one near an end is that end only', () => {
    const [mid] = links(edge('e', 'r1', 's1', [['g0/1', 0]]));
    assert.equal(mid.a.port, 'GigabitEthernet0/1');
    assert.equal(mid.b.port, 'GigabitEthernet0/1');
    assert.equal(mid.a.assumed, true);
    const [near] = links(edge('e', 'r1', 's1', [['g0/1', 0.8]]));
    assert.equal(near.a.port, null);
    assert.equal(near.b.port, 'GigabitEthernet0/1');
  });

  test('no label: only the devices; a label that is no port is ignored; a link to a PC is not a link of the bench', () => {
    const all = links(edge('e1', 'r1', 's1', [['VLAN 10', 0]]) + edge('e2', 's1', 'pc', [['fa0/2', -0.8]]));
    assert.equal(all.length, 1);
    assert.equal(all[0].a.port, null);
    assert.equal(all[0].b.port, null);
  });

  test('the shipped diagram: B4M has its 19 cables between console devices', () => {
    const { labs } = parseDrawio(fs.readFileSync('diagrams/diagram.drawio', 'utf8'));
    const b4m = diagramLinks(labs.find((l) => l.name === 'B4M'));
    assert.equal(b4m.length, 19);
    const r1s1 = b4m.find((l) => l.a.name === 'R1' && l.b.name === 'S1');
    assert.equal(r1s1.a.port, 'FastEthernet0/0');
    assert.equal(r1s1.b.port, 'FastEthernet0/24');
  });
});

describe('the cabling verdict', () => {
  const link = (id, a, ap, b, bp, assumed = false) => ({ id, a: { key: a, name: a, port: ap, assumed }, b: { key: b, name: b, port: bp, assumed } });
  const nb = (deviceId, localInterface, remoteInterface) => ({ deviceId, localInterface, remoteInterface });
  const dev = (key, hostname, neighbors, extra = {}) => ({ key, name: key, state: 'done', hostname, cdp: { enabled: true, neighbors }, interfaces: [], ...extra });

  test('cabled as drawn: ok, seen from both ends once; a label-less end only needs the right device', () => {
    const r = compareCabling([link('l1', 'R1', 'FastEthernet0/0', 'S1', 'FastEthernet0/24'), link('l2', 'S1', null, 'S2', null)], [
      dev('R1', 'R1-3001', [nb('S1', 'FastEthernet0/0', 'FastEthernet0/24')]),
      dev('S1', 'S1', [nb('R1-3001', 'FastEthernet0/24', 'FastEthernet0/0'), nb('S2.lab.local', 'FastEthernet0/1', 'FastEthernet0/1')]),
      dev('S2', 'S2', [nb('S1', 'FastEthernet0/1', 'FastEthernet0/1')]),
    ]);
    assert.deepEqual(r.links.map((l) => l.status), ['ok', 'ok']);
    assert.equal(r.links[1].a.seen, 'FastEthernet0/1', 'the port CDP saw is reported for an end the diagram does not label');
    assert.deepEqual(r.unexpected, []);
    assert.deepEqual(r.summary, { ok: 2, wrong_port: 0, missing: 0, unverified: 0, unexpected: 0 });
  });

  test('plugged into another port: wrong port, with what was seen', () => {
    const r = compareCabling([link('l1', 'S1', 'FastEthernet0/1', 'S2', 'FastEthernet0/1', true)], [
      dev('S1', 'S1', [nb('S2', 'FastEthernet0/9', 'FastEthernet0/1')]),
      dev('S2', 'S2', [nb('S1', 'FastEthernet0/1', 'FastEthernet0/9')]),
    ]);
    assert.equal(r.links[0].status, 'wrong_port');
    assert.equal(r.links[0].a.seen, 'FastEthernet0/9');
    assert.equal(r.links[0].a.assumed, true);
    assert.equal(r.links[0].b.seen, 'FastEthernet0/1');
  });

  test('missing, with the interface that explains it; unexpected, to a bench device or to a stranger', () => {
    const r = compareCabling([link('l1', 'R1', 'FastEthernet0/0', 'S1', 'FastEthernet0/24')], [
      dev('R1', 'R1', [], { interfaces: [{ name: 'FastEthernet0/0', ip: null, status: 'administratively down', protocol: 'down' }] }),
      dev('S1', 'S1', [nb('S3', 'FastEthernet0/20', 'FastEthernet0/20'), nb('Phone-12', 'FastEthernet0/5', 'Port 1')]),
      dev('S3', 'S3', [nb('S1', 'FastEthernet0/20', 'FastEthernet0/20')]),
    ]);
    assert.equal(r.links[0].status, 'missing');
    assert.deepEqual(r.links[0].reason, { code: 'shutdown', params: { device: 'R1', port: 'FastEthernet0/0' } });
    assert.equal(r.unexpected.length, 2);
    assert.deepEqual(r.unexpected[0], { a: { key: 'S1', name: 'S1', port: 'FastEthernet0/20' }, b: { key: 'S3', name: 'S3', port: 'FastEthernet0/20', guessed: false } });
    assert.equal(r.unexpected[1].b.key, null);
    assert.equal(r.unexpected[1].b.name, 'Phone-12');
  });

  test('a port missing from the interfaces read is "no such port" only when every row was read', () => {
    const rows = [{ name: 'FastEthernet0/1', ip: null, status: 'up', protocol: 'up' }];
    const run = (extra) => compareCabling([link('l1', 'R1', 'FastEthernet0/0', 'S1', 'FastEthernet0/24')], [
      dev('R1', 'R1', [], { interfaces: rows, ...extra }),
      dev('S1', 'S1', []),
    ]).links[0];
    assert.deepEqual(run({}).reason, { code: 'no_such_port', params: { device: 'R1', port: 'FastEthernet0/0' } });
    assert.equal(run({ interfacesPartial: true }).status, 'missing');
    assert.equal(run({ interfacesPartial: true }).reason, null, 'a row the parser could not read may be that port');
  });

  test('unverified: the other end does not run Cisco IOS, CDP is off, nothing was read', () => {
    const r = compareCabling([
      link('l1', 'S1', 'FastEthernet0/5', 'S4', 'FastEthernet0/5'),
      link('l2', 'S2', null, 'S3', null),
      link('l3', 'R1', null, 'R2', null),
    ], [
      dev('S1', 'S1', []),
      { key: 'S4', name: 'S4', state: 'skipped', code: 'ios.not_ios' },
      { ...dev('S2', 'S2', []), cdp: { enabled: false, neighbors: [] } },
      { key: 'S3', name: 'S3', state: 'failed', code: 'ios.line_password' },
      { key: 'R1', name: 'R1', state: 'cancelled' },
      { key: 'R2', name: 'R2', state: 'failed' },
    ]);
    assert.deepEqual(r.links.map((l) => [l.status, l.reason?.code]), [['unverified', 'not_cisco'], ['unverified', 'cdp_off'], ['unverified', 'not_read']]);
  });

  test('a device that could not be read is still found by the other end, by its diagram name (guessed)', () => {
    const r = compareCabling([link('l1', 'R1', null, 'S1', 'FastEthernet0/24')], [
      { key: 'R1', name: 'R1', state: 'failed', code: 'ios.line_password' },
      dev('S1', 'S1', [nb('R1-3001', 'FastEthernet0/24', 'FastEthernet0/0')]),
    ]);
    assert.equal(r.links[0].status, 'ok');
    assert.equal(r.links[0].guessed, true);
  });

  test('two factory switches both called "Switch" are told apart by the entry each has of the other', () => {
    const r = compareCabling([link('l1', 'S1', 'FastEthernet0/1', 'S2', 'FastEthernet0/1'), link('l2', 'S1', 'FastEthernet0/2', 'S3', 'FastEthernet0/2')], [
      dev('S1', 'S1', [nb('Switch', 'FastEthernet0/1', 'FastEthernet0/1'), nb('Switch', 'FastEthernet0/2', 'FastEthernet0/2')]),
      dev('S2', 'Switch', [nb('S1', 'FastEthernet0/1', 'FastEthernet0/1')]),
      dev('S3', 'Switch', [nb('S1', 'FastEthernet0/2', 'FastEthernet0/2')]),
    ]);
    assert.deepEqual(r.links.map((l) => l.status), ['ok', 'ok']);
    assert.deepEqual(r.unexpected, []);
  });

  test('two parallel links: the labelled one takes its own cable first', () => {
    const r = compareCabling([link('plain', 'R1', null, 'R2', null), link('labelled', 'R1', 'Serial0/0/0', 'R2', 'Serial0/0/1')], [
      dev('R1', 'R1', [nb('R2', 'FastEthernet0/1', 'FastEthernet0/1'), nb('R2', 'Serial0/0/0', 'Serial0/0/1')]),
      dev('R2', 'R2', []),
    ]);
    assert.deepEqual(r.links.map((l) => [l.id, l.status]), [['plain', 'ok'], ['labelled', 'ok']]);
  });
});

test('cabled together elsewhere: the cable that keeps a drawn port goes to that link', () => {
  const link = (id, ap, bp) => ({ id, a: { key: 'S1', name: 'S1', port: ap }, b: { key: 'S2', name: 'S2', port: bp } });
  const dev = (key, neighbors) => ({ key, name: key, state: 'done', hostname: key, cdp: { enabled: true, neighbors }, interfaces: [] });
  const r = compareCabling([link('one', 'FastEthernet0/1', 'FastEthernet0/1'), link('two', 'FastEthernet0/2', 'FastEthernet0/2')], [
    dev('S1', [{ deviceId: 'S2', localInterface: 'FastEthernet0/20', remoteInterface: 'FastEthernet0/20' }, { deviceId: 'S2', localInterface: 'FastEthernet0/12', remoteInterface: 'FastEthernet0/2' }]),
    dev('S2', []),
  ]);
  assert.deepEqual(r.links.map((l) => [l.id, l.status, l.a.seen]), [['one', 'wrong_port', 'FastEthernet0/20'], ['two', 'wrong_port', 'FastEthernet0/12']]);
});
