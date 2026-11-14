/**
 * A Cisco IOS / IOS XE imitation for the mock lab and the tests
 *
 * The device driver (src/lib/drivers/ciscoIos.js) is written without access
 * to the real lab, so this simulator copies what the driver depends on:
 *   - the console: character echo, the console-line password ("User Access
 *     Verification" / "Password:", three tries then "% Bad passwords"), the
 *     enable secret (three tries then "% Bad secrets"), user (>) and
 *     privileged (#) EXEC, configuration modes and their prompts
 *   - IOS parsing: abbreviations, "% Invalid input detected at '^' marker."
 *     with the caret under the faulty word, "% Ambiguous command", "%
 *     Incomplete command.", unknown words taken for a host name ("Translating
 *     …"), privileged commands invisible in user EXEC
 *   - a configuration model: running vs startup config, show running-config
 *     in IOS order with the family's factory lines (IOS XE: license udi,
 *     platform, crypto pki certificate chains, redundancy…), banners shown
 *     with ^C, interfaces shut or not by default (routers vs switches),
 *     flash:vlan.dat on switches (VLANs survive an erase, not a delete),
 *     `show vlan brief`, `show version`, `show cdp neighbors detail`, `show ip
 *     interface brief`, `ping`
 *   - the destructive path: `erase startup-config` / `write erase`, `delete
 *     flash:vlan.dat`, `reload` with "System configuration has been
 *     modified. Save? [yes/no]:" and "Proceed with reload? [confirm]", a boot
 *     sequence per family (length and chatter), the initial configuration
 *     dialog of a factory-fresh device, IOS XE Plug-and-Play discovery,
 *     "Press RETURN to get started!" and its slow first answer
 *   - console syslog lines that land anywhere (after a prompt, after a
 *     --More-- marker), stamped with a date or with the uptime (`stamps`),
 *     the multi-line %SYS-5-RESTART message after "Press RETURN", ROMMON
 *     (`rommon 1 >`), the boot loader (`switch:`), a boot that stalls, a silent line
 *   - password recovery (lot recovery): power off and on (`powerCycle()`, with
 *     the Mode button held on a switch), BREAK during the boot into ROMMON,
 *     `confreg`, the classic switches' boot loader (`flash_init`, `dir flash:`,
 *     `rename flash:config.text …`, `boot`) where the startup-config is the file
 *     flash:config.text, the Catalyst 9300L's `SWITCH_IGNORE_STARTUP_CFG=1` and
 *     `no system ignore startupconfig switch all` (read back with `show romvar`),
 *     IOS `rename`; a switch whose
 *     password recovery is disabled asks to reset itself to factory defaults
 *   - VTP as classic IOS keeps it: version, domain, password and mode live in
 *     flash:vlan.dat with the VLANs (`show vtp status`, `show vtp password`), and
 *     show running-config lists them only in transparent mode
 *
 * Models (MODELS) cover the four families of the lab: classic IOS routers
 * (1841, 2801, 2811 on 12.4T), IOS XE routers (ISR 4331, 17.3), classic
 * switches (2960, 3560, 3560V2 on 12.2SE / 15.0SE), Catalyst 1000 (15.2E)
 * and Catalyst 9300L (IOS XE 17.6). `new FakeIos({ hostname })` without a
 * model gives the permissive "generic" device the engine tests were written
 * against (any interface name accepted, no VLAN or layer-3 checks).
 *
 * Timing: boot lengths and delays are real durations multiplied by
 * `timeScale` (default 0.001: a 4331 boots in about half a second).
 *
 * Optional `slowConsole` models an old device behind a 9600-baud console:
 * about 1 character/ms, a small input buffer (64 bytes) and a processing time
 * per command, during which input queues up; bytes beyond the buffer are
 * DROPPED, which is exactly what corrupts naively pasted scripts.
 *
 * What could not be checked on the real equipment is listed in the ios lot's
 * report (first-boot questions of IOS XE after an erase, among others).
 */
import crypto from 'node:crypto';

const SECOND = 1000;
const range = (prefix, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${prefix}${a + i}`);

// ── Device families ─────────────────────────────────────────────────────────

const LINES_ROUTER = [['line con 0', []], ['line aux 0', []], ['line vty 0 4', ['login']]];
const LINES_SWITCH = [['line con 0', []], ['line vty 0 4', ['login']], ['line vty 5 15', ['login']]];
const LINES_XE_ROUTER = [['line con 0', ['transport input none', 'stopbits 1']], ['line aux 0', ['stopbits 1']], ['line vty 0 4', ['login']]];
const LINES_XE_SWITCH = [['line con 0', ['stopbits 1']], ['line vty 0 4', ['login']], ['line vty 5 15', ['login']]];

const classicRouterGlobal = ['service timestamps debug datetime msec', 'service timestamps log datetime msec', 'no service password-encryption',
  'no aaa new-model', 'ip cef', 'no ipv6 cef', 'multilink bundle-name authenticated', 'ip forward-protocol nd', 'no ip http server', 'no ip http secure-server', 'scheduler allocate 20000 1000'];
const classicSwitchGlobal = ['no service pad', 'service timestamps debug datetime msec', 'service timestamps log datetime msec', 'no service password-encryption',
  'no aaa new-model', 'system mtu routing 1500', 'spanning-tree mode pvst', 'spanning-tree extend system-id', 'vlan internal allocation policy ascending', 'ip http server', 'ip http secure-server'];

/** A self-signed certificate chain as IOS XE prints it (hex, then an indented tab + quit) */
function certChain(name, kind, seed) {
  const hex = crypto.createHash('sha512').update(seed).digest('hex').toUpperCase();
  const words = Array.from({ length: 24 }, (_, i) => hex.slice((i * 8) % 120, (i * 8) % 120 + 8));
  const rows = Array.from({ length: 3 }, (_, r) => `  ${words.slice(r * 8, r * 8 + 8).join(' ')}`);
  return { head: `crypto pki certificate chain ${name}`, lines: [`certificate ${kind} 01`, ...rows.map((l) => l.slice(1)), ' \tquit'] };
}

function xeBlocks(dev, { mgmtVrf, redundancy, extra = [] }) {
  const tp = `TP-self-signed-${dev.serialNumber}`;
  return [
    { head: `vrf definition ${mgmtVrf}`, lines: ['!', 'address-family ipv4', 'exit-address-family', '!', 'address-family ipv6', 'exit-address-family'] },
    { head: `crypto pki trustpoint ${tp}`, lines: ['enrollment selfsigned', `subject-name cn=IOS-Self-Signed-Certificate-${dev.serialNumber}`, 'revocation-check none', `rsakeypair ${tp}`] },
    { head: 'crypto pki trustpoint SLA-TrustPoint', lines: ['enrollment pkcs12', 'revocation-check crl'] },
    certChain(tp, 'self-signed', `${dev.serial}-tp`),
    certChain('SLA-TrustPoint', 'ca', 'sla'),
    { head: 'redundancy', lines: redundancy },
    ...extra,
    { head: 'control-plane', lines: [] },
  ];
}

export const MODELS = {
  // ISR G1, classic IOS 12.4T: FastEthernet, serial WICs, 2 to 4 minutes at 9600 baud.
  1841: classicRouter({ pid: '1841', image: 'c1841-adventerprisek9-mz.124-24.T7.bin', version: '12.4(24)T7', fc: 'fc2', ios: '1841 Software (C1841-ADVENTERPRISEK9-M)',
    hw: 'Cisco 1841 (revision 7.0) with 236544K/25600K bytes of memory.', interfaces: ['FastEthernet0/0', 'FastEthernet0/1', 'Serial0/0/0', 'Serial0/0/1'], bootS: 140 }),
  2801: classicRouter({ pid: '2801', image: 'c2801-advipservicesk9-mz.124-24.T8.bin', version: '12.4(24)T8', fc: 'fc1', ios: '2801 Software (C2801-ADVIPSERVICESK9-M)',
    hw: 'Cisco 2801 (revision 7.0) with 236544K/25600K bytes of memory.', interfaces: ['FastEthernet0/0', 'FastEthernet0/1', 'Serial0/1/0', 'Serial0/1/1'], bootS: 160 }),
  2811: classicRouter({ pid: '2811', image: 'c2800nm-adventerprisek9-mz.124-22.T.bin', version: '12.4(22)T', fc: 'fc1', ios: '2800 Software (C2800NM-ADVENTERPRISEK9-M)',
    hw: 'Cisco 2811 (revision 53.51) with 251904K/10240K bytes of memory.', interfaces: ['FastEthernet0/0', 'FastEthernet0/1', 'Serial0/0/0', 'Serial0/0/1'], bootS: 180 }),
  // ISR 4331, IOS XE 17.3: long, chatty boot; PnP discovery with no configuration.
  isr4331: {
    family: 'iosxe', kind: 'router', pid: 'ISR4331/K9', confReg: '0x2102', version: '17.03.04a', runVersion: '17.3', bootS: 420, readyS: 3,
    train: 'Amsterdam', iosLine: 'ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.3.4a, RELEASE SOFTWARE (fc3)', image: 'bootflash:isr4300-universalk9.17.03.04a.SPA.bin',
    rom: ['ROM: 16.12(2r)'], hw: 'cisco ISR4331/K9 (1RU) processor with 1795999K/6147K bytes of memory.',
    interfaces: [...range('GigabitEthernet0/0/', 0, 2).map((n) => [n, true, ['no ip address', 'negotiation auto']]), ['Serial0/1/0', true, ['no ip address']], ['Serial0/1/1', true, ['no ip address']],
      ['GigabitEthernet0', true, ['vrf forwarding Mgmt-intf', 'no ip address', 'negotiation auto']]],
    global: (dev) => ['service timestamps debug datetime msec', 'service timestamps log datetime msec', 'platform qfp utilization monitor load 80', 'platform punt-keepalive disable-kernel-core',
      'no aaa new-model', 'login on-success log', 'subscriber templating', 'multilink bundle-name authenticated', `license udi pid ISR4331/K9 sn ${dev.serial}`,
      'memory free low-watermark processor 69574', 'diagnostic bootup level minimal', 'spanning-tree extend system-id', 'ip forward-protocol nd', 'ip http server',
      'ip http authentication local', 'ip http secure-server', 'ip ssh bulk-mode 131072'],
    blocks: (dev) => xeBlocks(dev, { mgmtVrf: 'Mgmt-intf', redundancy: ['mode none'] }),
    lines: LINES_XE_ROUTER, firstBoot: ['dialog'], pnp: true, syslogOnMore: 0,
    counts: ['3 Gigabit Ethernet interfaces', '2 Serial interfaces', '32768K bytes of non-volatile configuration memory.', '4194304K bytes of physical memory.', '3207167K bytes of flash memory at bootflash:.'],
  },
  // Catalyst 2960 / 3560 / 3560V2, classic IOS 12.2SE / 15.0SE. Register 0xF is normal.
  2960: classicSwitch({ pid: 'WS-C2960-24TT-L', version: '15.0(2)SE', runVersion: '15.0', ios: 'C2960 Software (C2960-LANBASEK9-M)', image: 'flash:/c2960-lanbasek9-mz.150-2.SE/c2960-lanbasek9-mz.150-2.SE.bin',
    boot: 'C2960', cpu: 'PowerPC405', mem: '65536K', rev: 'R0', ports: [...range('FastEthernet0/', 1, 24), 'GigabitEthernet0/1', 'GigabitEthernet0/2'], bootS: 90 }),
  3560: classicSwitch({ pid: 'WS-C3560-24PS', version: '12.2(55)SE6', runVersion: '12.2', ios: 'C3560 Software (C3560-IPSERVICESK9-M)', image: 'flash:c3560-ipservicesk9-mz.122-55.SE6.bin',
    boot: 'C3560', cpu: 'PowerPC405', mem: '131072K', rev: 'K0', ports: [...range('FastEthernet0/', 1, 24), 'GigabitEthernet0/1', 'GigabitEthernet0/2'], layer3: true, bootS: 110 }),
  '3560v2': classicSwitch({ pid: 'WS-C3560V2-24PS', version: '12.2(50)SE5', runVersion: '12.2', ios: 'C3560 Software (C3560-IPSERVICESK9-M)', image: 'flash:c3560-ipservicesk9-mz.122-50.SE5.bin',
    boot: 'C3560', cpu: 'PowerPC405', mem: '131072K', rev: 'W0', ports: [...range('FastEthernet0/', 1, 24), 'GigabitEthernet0/1', 'GigabitEthernet0/2'], layer3: true, bootS: 110 }),
  // Catalyst 1000, IOS 15.2(7)E: Gigabit ports 1/0/x, layer 2.
  c1000: classicSwitch({ pid: 'C1000-24T-4G-L', version: '15.2(7)E6', runVersion: '15.2', ios: 'C1000 Software (C1000-UNIVERSALK9-M)', image: 'flash:/c1000-universalk9-mz.152-7.E6/c1000-universalk9-mz.152-7.E6.bin',
    boot: 'C1000', cpu: 'ARMv7', mem: '524288K', rev: 'V01', ports: range('GigabitEthernet1/0/', 1, 28), bootS: 120 }),
  // Catalyst 9300L, IOS XE 17.6: stackable, slow and chatty, NO configuration register line.
  c9300l: {
    family: 'iosxe', kind: 'switch', layer3: true, pid: 'C9300L-24T-4G', confReg: null, version: '17.06.04', runVersion: '17.6', bootS: 540, readyS: 3,
    train: 'Bengaluru', iosLine: 'Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.6.4, RELEASE SOFTWARE (fc1)', image: 'flash:packages.conf',
    rom: ['ROM: IOS-XE ROMMON', 'BOOTLDR: System Bootstrap, Version 17.8.1r[FC2], RELEASE SOFTWARE (P)'], hw: 'cisco C9300L-24T-4G (X86) processor with 1324350K/6147K bytes of memory.',
    interfaces: [['GigabitEthernet0/0', false, ['vrf forwarding Mgmt-vrf', 'no ip address', 'negotiation auto']], ...range('GigabitEthernet1/0/', 1, 24).map((n) => [n, false, []]),
      ...range('GigabitEthernet1/1/', 1, 4).map((n) => [n, false, []]), ['Vlan1', true, ['no ip address']]],
    global: () => ['service timestamps debug datetime msec', 'service timestamps log datetime msec', 'service call-home', 'platform punt-keepalive disable-kernel-core',
      'no aaa new-model', 'switch 1 provision c9300l-24t-4g', 'login on-success log', 'license boot level network-advantage addon dna-advantage', 'diagnostic bootup level minimal',
      'spanning-tree mode rapid-pvst', 'spanning-tree extend system-id', 'memory free low-watermark processor 131689', 'ip forward-protocol nd', 'ip http server',
      'ip http authentication local', 'ip http secure-server'],
    blocks: (dev) => xeBlocks(dev, { mgmtVrf: 'Mgmt-vrf', redundancy: ['mode sso'], extra: [{ head: 'transceiver type all', lines: ['monitoring'] }] }),
    lines: LINES_XE_SWITCH, firstBoot: ['dialog'], pnp: true, syslogOnMore: 3, stack: true,
    counts: ['1 Virtual Ethernet interface', '28 Gigabit Ethernet interfaces', '2048K bytes of non-volatile configuration memory.', '8388608K bytes of physical memory.', '1638400K bytes of Crash Files at crashinfo:.', '11264000K bytes of Flash at flash:.'],
    switchTable: (p) => [`*    1 30    ${p.pid.padEnd(18)} 17.06.04          CAT9K_IOSXE           INSTALL`],
  },
};

function classicRouter({ pid, image, version, fc, ios, hw, interfaces, bootS }) {
  return {
    family: 'ios', kind: 'router', pid, confReg: '0x2102', version, runVersion: '12.4', bootS, readyS: 9,
    iosLine: `${ios}, Version ${version}, RELEASE SOFTWARE (${fc})`, image: `flash:${image}`, rom: ['ROM: System Bootstrap, Version 12.4(13r)T, RELEASE SOFTWARE (fc1)'], hw,
    interfaces: interfaces.map((n) => [n, true, n.startsWith('Serial') ? ['no ip address'] : ['no ip address', 'duplex auto', 'speed auto']]),
    global: () => classicRouterGlobal, blocks: () => [{ head: 'control-plane', lines: [] }], lines: LINES_ROUTER, firstBoot: ['dialog'], pnp: false, syslogOnMore: 0,
    counts: ['2 FastEthernet interfaces', '2 Serial(sync/async) interfaces', 'DRAM configuration is 64 bits wide with parity disabled.', '191K bytes of NVRAM.', '62720K bytes of ATA CompactFlash (Read/Write)'],
  };
}

function classicSwitch({ pid, version, runVersion, ios, image, boot, cpu, mem, rev, ports, layer3 = false, bootS }) {
  return {
    family: 'ios', kind: 'switch', layer3, pid, confReg: '0xF', version, runVersion, bootS, readyS: 2,
    iosLine: `${ios}, Version ${version}, RELEASE SOFTWARE (fc1)`, image,
    rom: [`ROM: Bootstrap program is ${boot} boot loader`, `BOOTLDR: ${boot} Boot Loader (${boot}-HBOOT-M) Version 12.2(44)SE5, RELEASE SOFTWARE (fc1)`],
    hw: `cisco ${pid} (${cpu}) processor (revision ${rev}) with ${mem} bytes of memory.`,
    interfaces: [...ports.map((n) => [n, false, []]), ['Vlan1', true, ['no ip address']]],
    global: () => classicSwitchGlobal, blocks: () => [], lines: LINES_SWITCH, firstBoot: ['dialog', 'autoinstall'], pnp: false, syslogOnMore: 0,
    counts: ['1 Virtual Ethernet interface', `${ports.filter((p) => p.startsWith('Fast')).length || ports.length} ${ports[0].startsWith('Fast') ? 'FastEthernet' : 'Gigabit Ethernet'} interfaces`,
      ...(ports[0].startsWith('Fast') ? [`${ports.filter((p) => p.startsWith('Gigabit')).length} Gigabit Ethernet interfaces`] : []), 'The password-recovery mechanism is enabled.', '', '512K bytes of flash-simulated non-volatile configuration memory.'],
    switchTable: (p) => [`*    1 ${String(ports.length).padEnd(5)} ${p.pid.padEnd(18)} ${p.version.padEnd(21)} ${ios.match(/\((.+)\)/)[1]}`],
  };
}

/** The permissive device the engine tests were written against (no model given) */
function genericProfile(hostname) {
  const router = /^R/i.test(hostname);
  return {
    family: 'ios', kind: router ? 'router' : 'switch', pid: router ? 'CISCO2911/K9' : 'WS-C2960-24TT-L', confReg: router ? '0x2102' : '0xF', version: '15.2(7)E', runVersion: '15.2',
    bootS: 60, readyS: 1, iosLine: `${router ? 'C2900 Software (C2900-UNIVERSALK9-M)' : 'C2960 Software (C2960-LANBASEK9-M)'}, Version 15.2(7)E, RELEASE SOFTWARE (fc1)`,
    image: 'flash:mock.bin', rom: ['ROM: System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)'], hw: `cisco ${router ? 'CISCO2911/K9' : 'WS-C2960-24TT-L'} (mock) processor with 524288K bytes of memory.`,
    interfaces: router ? ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'Serial0/1/0', 'Serial0/1/1'].map((n) => [n, true, []])
      : [...range('FastEthernet0/', 1, 24).map((n) => [n, false, []]), ['Vlan1', true, []]],
    global: () => ['service timestamps debug datetime msec', 'no ip domain-lookup'], blocks: () => [],
    lines: [['line con 0', ['logging synchronous']], ['line vty 0 4', ['login']]], firstBoot: ['dialog'], pnp: false, syslogOnMore: 0, counts: [],
    generic: true,
  };
}

// ── Command grammar (abbreviations and the caret of "% Invalid input") ─────
// A node maps keywords to sub-nodes; `null` means "free arguments follow".
// `{}` is a keyword that takes nothing more.

const W = null;
const SHOW = {
  'running-config': { interface: W }, 'startup-config': {}, version: {}, vlan: { brief: {} }, vtp: { status: {}, password: {}, counters: {} }, cdp: { neighbors: { detail: {} } },
  ip: { interface: { brief: {} }, route: W }, interfaces: W, flash: W, clock: {}, history: {}, users: {}, inventory: {}, boot: {}, license: W, romvar: {},
};
const EXEC = {
  show: SHOW, enable: W, disable: {}, configure: { terminal: {} }, copy: W, write: { memory: {}, erase: {}, terminal: {} }, erase: W, delete: W,
  reload: W, ping: W, traceroute: W, terminal: { length: W, no: { length: {} }, monitor: {} }, exit: {}, logout: {}, dir: W, clear: W, debug: W, undebug: W,
  ssh: W, send: W, setup: {}, systat: W, telnet: W, more: W, quit: {}, rename: W,
};
const PRIVILEGED_ONLY = new Set(['configure', 'copy', 'write', 'erase', 'delete', 'reload', 'debug', 'undebug', 'clear', 'more', 'setup', 'rename']);
const IF_WORDS = {
  description: W, shutdown: {}, duplex: { auto: {}, full: {}, half: {} }, speed: W, negotiation: { auto: {} }, bandwidth: W, mtu: W, 'load-interval': W, keepalive: W,
  ip: { address: W, 'helper-address': W, nat: { inside: {}, outside: {} }, ospf: W, 'access-group': W, 'route-cache': W, 'proxy-arp': {}, redirects: {}, unreachables: {}, mtu: W, dhcp: W, 'virtual-reassembly': W, pim: W },
  ipv6: W, switchport: {
    mode: { access: {}, trunk: {}, dynamic: { auto: {}, desirable: {} } }, access: { vlan: W }, nonegotiate: {}, 'port-security': W, voice: { vlan: W },
    trunk: { encapsulation: { dot1q: {}, isl: {}, negotiate: {} }, native: { vlan: W }, allowed: { vlan: W } },
  },
  encapsulation: { dot1q: W, ppp: {}, hdlc: {} }, clock: { rate: W }, 'spanning-tree': W, 'channel-group': W, cdp: { enable: {} }, standby: W, vrf: { forwarding: W },
  'service-policy': W, 'storm-control': W, mdix: { auto: {} }, power: W, 'no': null,
};
IF_WORDS.no = IF_WORDS;
const LINE_WORDS = { password: W, login: W, logging: { synchronous: {} }, 'exec-timeout': W, transport: W, privilege: W, history: W, stopbits: W, length: W, speed: W, 'access-class': W, 'session-timeout': W, exec: {}, motd: W };
LINE_WORDS.no = LINE_WORDS;
const ROUTER_WORDS = { network: W, 'router-id': W, 'passive-interface': W, 'default-information': W, redistribute: W, 'auto-summary': {}, area: W, version: W, 'maximum-paths': W, 'log-adjacency-changes': W, distance: W, timers: W, neighbor: W, bgp: W, eigrp: W };
ROUTER_WORDS.no = ROUTER_WORDS;
const GLOBAL = {
  hostname: W, interface: W, vlan: W, line: W, router: W, banner: W, enable: { secret: W, password: W }, username: W, service: W,
  ip: {
    routing: {}, route: W, 'domain-name': W, domain: { name: W, lookup: {} }, 'domain-lookup': {}, 'default-gateway': W, dhcp: W, 'access-list': W, http: W, ssh: W,
    cef: {}, 'forward-protocol': W, 'name-server': W, nat: W, classless: {}, 'subnet-zero': {}, 'source-route': {}, host: W, ftp: W, tftp: W, scp: W, 'multicast-routing': W, arp: W,
  },
  ipv6: W, 'spanning-tree': W, 'access-list': W, logging: W, clock: W, cdp: W, lldp: W, 'snmp-server': W, ntp: W, crypto: W, vtp: W, aaa: W, boot: W,
  'control-plane': {}, license: W, platform: W, memory: W, diagnostic: W, redundancy: {}, transceiver: W, login: W, subscriber: W, multilink: W, switch: W, system: W,
  vrf: W, 'config-register': W, errdisable: W, mac: W, scheduler: W, 'call-home': {}, archive: {}, do: W, end: {}, exit: {}, default: W, 'no': null,
};
GLOBAL.no = GLOBAL;
const SUB_MODES = { 'config-if': IF_WORDS, 'config-subif': IF_WORDS, 'config-line': LINE_WORDS, 'config-router': ROUTER_WORDS };
/** The other blocks: their own commands stay in the block, anything else is tried as a global command */
const withNo = (words) => { const g = { ...words }; g.no = g; return g; };
const BLOCK_WORDS = {
  'config-vrf': withNo({ 'address-family': W, 'exit-address-family': {}, rd: W, 'route-target': W, description: W }),
  'dhcp-config': withNo({ network: W, 'default-router': W, 'dns-server': W, 'domain-name': W, lease: W, option: W, 'netbios-name-server': W }),
  'config-std-nacl': withNo({ permit: W, deny: W, remark: W }),
  'config-ext-nacl': withNo({ permit: W, deny: W, remark: W, evaluate: W }),
  'config-cp': withNo({ 'service-policy': W }),
  'config-red': withNo({ mode: W, 'main-cpu': W }),
  'config-xcvr-type': withNo({ monitoring: W }),
  'config-archive': withNo({ log: W, path: W, 'write-memory': {}, maximum: W, hidekeys: {} }),
  'cfg-call-home': withNo({ 'contact-email-addr': W, profile: W, active: {}, destination: W }),
  'ca-trustpoint': withNo({ enrollment: W, 'subject-name': W, 'revocation-check': W, rsakeypair: W, certificate: W, quit: {} }),
};

/**
 * Expand abbreviations against a grammar. Returns { words } with the full
 * keywords (free arguments kept as typed), or { error: 'invalid'|'ambiguous', at }
 * where `at` is the index of the faulty word. A keyword left without the
 * words it needs is reported by the command itself ("% Incomplete command.").
 */
function expand(words, node) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (node === null) { out.push(...words.slice(i)); return { words: out }; }
    const w = words[i].toLowerCase();
    const keys = Object.keys(node);
    const exact = keys.find((k) => k === w);
    const hits = exact ? [exact] : keys.filter((k) => k.startsWith(w));
    if (hits.length === 0) return { error: 'invalid', at: i };
    if (hits.length > 1) return { error: 'ambiguous', at: i };
    out.push(hits[0]);
    node = node[hits[0]];
  }
  if (node !== null && out.length === 1 && out[0] === 'no') return { error: 'incomplete', at: 1 };
  return { words: out };
}

// ── show running-config order ───────────────────────────────────────────────
// IOS order, roughly: version, service, hostname, boot markers, vrf, enable,
// aaa, other globals, crypto pki, license, username, spanning-tree, vlans
// (VTP transparent only), interfaces, routing, ip http / routes / access
// lists, control-plane, banners, lines, end.

function globalRank(line) {
  const l = line.replace(/^no /, '');
  const table = [
    [/^service /, 10], [/^platform /, 11], [/^boot /, 21], [/^enable /, 26], [/^aaa /, 28], [/^(switch \d+ provision|system mtu)/, 29], [/^ip routing/, 30],
    [/^(ip (domain|dhcp|cef|name-server|host|source-route|subnet-zero)|ipv6 (cef|unicast))/, 31], [/^(login |subscriber |multilink )/, 33], [/^license /, 38],
    [/^(memory |diagnostic )/, 39], [/^username /, 41], [/^(spanning-tree|vtp|vlan internal|errdisable|mac )/, 42],
    [/^ip (forward-protocol|http|route|ssh|nat|access-list|classless|scp|ftp|tftp)/, 70], [/^access-list /, 72], [/^(logging|snmp-server|cdp|lldp)/, 74],
    [/^banner /, 78], [/^(scheduler|ntp )/, 85],
  ];
  return table.find(([re]) => re.test(l))?.[1] ?? 32;
}
function blockRank(head) {
  const table = [
    [/^vrf definition/, 24], [/^ip dhcp pool/, 31], [/^crypto pki trustpoint/, 35], [/^crypto pki certificate chain/, 36], [/^(redundancy|transceiver)/, 44],
    [/^router /, 60], [/^ip access-list/, 71], [/^control-plane/, 75], [/^line /, 80], [/^(call-home|archive)/, 86],
  ];
  return table.find(([re]) => re.test(head))?.[1] ?? 40;
}
const IF_ORDER = ['description', 'switchport access', 'switchport trunk encapsulation', 'switchport trunk native', 'switchport trunk allowed', 'switchport mode', 'switchport nonegotiate',
  'switchport voice', 'switchport port-security', 'no switchport', 'encapsulation', 'vrf', 'ip address', 'no ip address', 'ip', 'no ip', 'shutdown', 'duplex', 'speed', 'negotiation',
  'clock', 'spanning-tree', 'channel-group'];
function ifLineRank(line) {
  const i = IF_ORDER.findIndex((o) => line === o || line.startsWith(`${o} `));
  return i < 0 ? IF_ORDER.indexOf('shutdown') - 0.5 : i;
}

// ── IOS helpers ─────────────────────────────────────────────────────────────

const IFACE_ABBR = [
  [/^gi?g?a?b?i?t?e?t?h?e?r?n?e?t?\s*(\d[\d/.]*)$/i, 'GigabitEthernet'],
  [/^te?n?g?i?g?a?b?i?t?e?t?h?e?r?n?e?t?\s*(\d[\d/.]*)$/i, 'TenGigabitEthernet'],
  [/^fa?s?t?e?t?h?e?r?n?e?t?\s*(\d[\d/.]*)$/i, 'FastEthernet'],
  [/^se?r?i?a?l?\s*(\d[\d/.:]*)$/i, 'Serial'],
  [/^vl?a?n?\s*(\d+)$/i, 'Vlan'],
  [/^lo?o?p?b?a?c?k?\s*(\d+)$/i, 'Loopback'],
  [/^tu?n?n?e?l?\s*(\d+)$/i, 'Tunnel'],
  [/^po?r?t?-?c?h?a?n?n?e?l?\s*(\d+)$/i, 'Port-channel'],
];
function normalizeIface(s) {
  for (const [re, full] of IFACE_ABBR) { const m = s.match(re); if (m) return `${full}${m[1]}`; }
  return null;
}
const isIp = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s || '') && s.split('.').every((n) => Number(n) <= 255);
const ipToInt = (s) => s.split('.').reduce((a, n) => a * 256 + Number(n), 0);
const shortIf = (n) => n.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^TenGigabitEthernet/, 'Te').replace(/^Serial/, 'Se');

/** IOS type 7 ("password 7 …"): a reversible XOR with a fixed key */
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
export function encrypt7(text, seed = 2) {
  return String(seed).padStart(2, '0') + [...text].map((ch, i) => (ch.charCodeAt(0) ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0')).join('');
}
export function decrypt7(hex) {
  const seed = Number(hex.slice(0, 2));
  let out = '';
  for (let i = 2, j = 0; i < hex.length; i += 2, j++) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + j) % XLAT.length));
  return out;
}
/** Looks like a type 5 (MD5-crypt) or type 9 (scrypt) secret; deterministic, so a replayed hash still matches */
function secretHash(type, secret) {
  if (type === 9) return `$9$${crypto.createHash('sha256').update(`s9${secret}`).digest('base64url').slice(0, 14)}$${crypto.createHash('sha256').update(secret).digest('base64url').slice(0, 43)}`;
  return `$1$${crypto.createHash('md5').update(`s5${secret}`).digest('base64url').slice(0, 4)}$${crypto.createHash('md5').update(secret).digest('base64url').slice(0, 22)}`;
}

const defaultVtp = () => ({ version: 1, mode: 'server', domain: '', password: null, pruning: false, revision: 0 });

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

// ── The device ──────────────────────────────────────────────────────────────

export class FakeIos {
  /**
   * @param model         a key of MODELS, or nothing for the generic device
   * @param start         'exec' (user EXEC, default), 'privileged', 'idle' (exec not started),
   *                      'linepass' (console password asked; needs linePassword),
   *                      'dialog' (factory-fresh, initial dialog on screen), 'booting',
   *                      'rommon', 'bootloader', 'silent'
   * @param enableSecret  enable secret of the running (and saved) configuration
   * @param linePassword  console-line password (`line con 0` / `password …` / `login`)
   * @param bootFailure   null, 'rommon' (no valid image: ROMMON / switch:), 'stall' (output stops)
   * @param firstBootExtra a question the first boot asks after the initial dialog (to model an
   *                      unknown IOS XE question), e.g. 'Enter enable secret: '
   * @param chatterMs     emit a syslog line this often while idle in EXEC (IOS XE), null = never
   * @param timeScale     real durations × timeScale
   * @param out           (text) => void, the console output; replaceable (the mock lab attaches sessions)
   * @param username / password   a device login for the 'user' / 'pass' states (engine tests)
   * @param termLengthSupported   false: `terminal length` is refused, the pager stays on
   * @param slowConsole   { bufferBytes, commandMs }: 9600-baud-like input
   * @param cdp           neighbours for `show cdp neighbors detail`
   * @param confReg       configuration register (routers), e.g. '0x2141'
   * @param serial        board serial number (derived from the model and hostname by default)
   * @param pnpEveryMs    IOS XE first boot: how often Plug-and-Play lines are printed (real ms)
   * @param syslogOnMore  syslog lines printed right after the first --More-- of a command
   * @param stamps        'datetime' (default: "*Mar  1 00:01:02.345: %…") or 'uptime' ("00:01:02: %…",
   *                      `service timestamps log uptime`, as on many classic switches)
   * @param deleteError   `delete flash:vlan.dat` fails with this reason, e.g. 'Permission denied'
   * @param passwordRecovery  false: `no service password-recovery` (switches: the Mode button
   *                      only offers a reset to factory defaults)
   * @param ignoreFlagSticks  9300L: `no system ignore startupconfig switch all` is accepted but
   *                      SWITCH_IGNORE_STARTUP_CFG stays at 1 (what `show romvar` then shows)
   */
  constructor({
    hostname, out = () => {}, username, password, model = null, start = 'exec',
    termLengthSupported = true, slowConsole = null, enableSecret = null, linePassword = null,
    bootFailure = null, firstBootExtra = null, chatterMs = null, timeScale = 0.001, syslogOnMore = null,
    cdp = [], serial = null, confReg = null, pnpEveryMs = 5000, stamps = 'datetime', deleteError = null,
    passwordRecovery = true, ignoreFlagSticks = false,
  } = {}) {
    this.profile = model ? MODELS[model] : genericProfile(hostname || 'Router');
    if (!this.profile) throw new Error(`Unknown fake model "${model}"`);
    Object.assign(this, { out, username, password, termLengthSupported, slowConsole, bootFailure, firstBootExtra, timeScale, cdp, pnpEveryMs, stamps, deleteError, passwordRecovery, ignoreFlagSticks });
    this.model = model || 'generic';
    const prefix = this.profile.kind === 'switch' ? 'FOC' : this.profile.family === 'iosxe' ? 'FDO' : 'FTX';
    this.serial = serial || `${prefix}${crypto.createHash('md5').update(`${model}-${hostname}`).digest('hex').slice(0, 8).toUpperCase()}`;
    this.serialNumber = String(parseInt(this.serial.slice(3, 11), 16)).slice(0, 10);
    this.syslogOnMore = syslogOnMore ?? this.profile.syslogOnMore;
    this.confReg = confReg || this.profile.confReg;
    this.nextConfReg = null;
    this.timers = new Set();
    this.line = '';
    this.mode = '>';
    this.termLength = 24;
    this.dropped = 0;
    this.commandLog = [];
    this.bootedAt = Date.now();
    this.vlanFile = null;   // contents of flash:vlan.dat (null: no file)
    this.startup = null;    // saved configuration (structured), null: nvram erased (a classic switch: flash:config.text)
    this.parked = null;     // a classic switch's config.text renamed in the boot loader: { name, cfg }
    this.romvars = {};      // boot loader variables (SWITCH_IGNORE_STARTUP_CFG on the 9300L)
    this.flashReady = true; // the boot loader's flash_init was run (or not needed)
    this.powerCycles = 0;
    this.breaks = 0;        // BREAKs received while booting
    this.intervals = new Set();

    const factoryName = this.profile.kind === 'router' ? 'Router' : 'Switch';
    this.cfg = this.#factoryConfig(start === 'dialog' ? factoryName : hostname || factoryName);
    this.vlans = this.#defaultVlans();
    this.vtp = defaultVtp();
    this.vtpFile = null;    // the VTP settings saved in flash:vlan.dat with the VLANs
    if (start !== 'dialog') {
      if (enableSecret) this.#setEnableSecret(enableSecret);
      if (linePassword) this.#block('line con 0').lines.push(`password ${linePassword}`, 'login');
      this.startup = structuredClone(this.cfg);
    }
    this.dirty = false;
    this.changedAt = null;
    this.savedAt = null;

    if (slowConsole) {
      this.queue = [];
      this.busy = false;
      this.timer = setInterval(() => this.#pump(), 1);
    }
    this.#begin(start);
    if (chatterMs) this.#every(chatterMs, () => { if (this.state === 'exec' && !this.line) this.#syslog(this.#chatterLine()); });
  }

  /** Stop every timer (the tests and the mock lab call it) */
  stop() {
    clearInterval(this.timer);
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
  }

  /** The kind of device, for the mock lab and the tests */
  get kind() { return this.profile.kind; }
  get family() { return this.profile.family; }

  /** Apply configuration lines at once, as if typed in `configure terminal` (no output) */
  configure(lines) {
    const { out, mode, state } = this;
    this.out = () => {};
    this.state = 'exec';
    this.mode = 'config';
    for (const l of (Array.isArray(lines) ? lines : String(lines).split('\n'))) if (l.trim() && !l.trim().startsWith('!')) this.#exec(l.trim(), l);
    this.mode = mode; this.state = state; this.out = out;
    this.dirty = true; this.changedAt = Date.now();
  }

  /** Save the running configuration (like `write memory`), without output */
  save() { this.#save(); }

  /** BREAK on the serial line: drops a booting device into ROMMON, ignored otherwise (register 0x2102) */
  sendBreak() {
    if (this.state !== 'booting' || !this.inBoot) return;
    this.breaks++;
    this.#clearBoot();
    this.#toRommon('\r\n\r\nmonitor: command "boot" aborted due to user interrupt');
  }

  /**
   * The person on site switches the device off, then on again (what nobody can
   * do from the application). With `modeButton` held, a switch stops at its
   * boot loader (`switch:`): a classic one before its flash is initialised, a
   * 9300L at once. Routers have no such button: they boot, and a BREAK sent
   * during the boot drops them into ROMMON. What was not saved is lost.
   */
  powerCycle({ modeButton = false } = {}) {
    for (const t of this.timers) { if (!this.intervals.has(t)) { clearTimeout(t); this.timers.delete(t); } }
    this.bootTimers = [];
    this.inBoot = false;
    Object.assign(this, { state: 'off', line: '', mode: '>', pnpRunning: false, extraAsked: false, enterPending: false, onAnswer: null, onConfirm: null });
    if (this.queue) this.queue = [];
    this.powerCycles++;
    this.#later(2 * SECOND, () => this.#powerOn(modeButton));
  }

  #powerOn(modeButton) {
    const p = this.profile;
    this.bootedAt = Date.now();
    if (!modeButton || p.kind !== 'switch') return this.#boot();
    this.state = 'blbusy';
    if (p.family === 'iosxe') {
      // Catalyst 9300L: its ROMMON is the boot loader, nothing to initialise
      const lines = ['Initializing Hardware ...', '', 'System Bootstrap, Version 17.8.1r[FC2], RELEASE SOFTWARE (P)', 'Copyright (c) 1994-2022  by cisco Systems, Inc.', '',
        'Current image running: Boot ROM1', 'Last reset cause: PowerOn', `${p.pid} platform with 8388608 Kbytes of main memory`, ''];
      return this.#later(20 * SECOND, () => { this.flashReady = true; this.out(lines.map((l) => `\r\n${l}`).join('')); this.state = 'bootloader'; this.out('\r\nswitch: '); });
    }
    const head = ['Using driver version 1 for media type 1', 'Base ethernet MAC Address: 00:1a:2b:3c:4d:00', 'Xmodem file system is available.'];
    if (!this.passwordRecovery) {
      return this.#later(15 * SECOND, () => {
        this.out([...head, 'The password-recovery mechanism has been triggered, but', 'is currently disabled.  Access to the boot loader prompt',
          'through the password-recovery mechanism is disallowed at', 'this point.  However, if you agree to let the system be',
          'reset back to the default system configuration, access', 'to the boot loader prompt can still be allowed.', '',
          'Would you like to reset the system back to the default configuration (y/n)?'].map((l) => `\r\n${l}`).join(''));
        this.state = 'question';
        this.onAnswer = (a) => {
          if (/^y/i.test(a)) { this.startup = null; this.parked = null; this.vlanFile = null; this.vtpFile = null; this.flashReady = false; this.state = 'bootloader'; this.out('\r\n\r\nswitch: '); return; }
          this.#boot();
        };
      });
    }
    return this.#later(15 * SECOND, () => {
      this.flashReady = false;
      this.out([...head, 'The password-recovery mechanism is enabled.', '', 'The system has been interrupted prior to initializing the',
        'flash filesystem.  The following commands will initialize', 'the flash filesystem, and finish loading the operating', 'system software:', '',
        '    flash_init', '    load_helper', '    boot', ''].map((l) => `\r\n${l}`).join(''));
      this.state = 'bootloader';
      this.out('\r\nswitch: ');
    });
  }

  /** Bytes from the terminal server (the student's keystrokes) */
  input(data) {
    if (!this.slowConsole) { for (const ch of data) this.#char(ch); return; }
    for (const ch of data) {
      if (this.queue.length >= this.slowConsole.bufferBytes) this.dropped++;
      else this.queue.push(ch);
    }
  }

  // ── slow console: ~1 char/ms, nothing processed while a command runs ──────
  #pump() {
    if (this.busy) return;
    const ch = this.queue.shift();
    if (ch !== undefined) this.#char(ch);
  }

  // ── timers ────────────────────────────────────────────────────────────────
  #later(realMs, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, Math.max(0, realMs * this.timeScale));
    this.timers.add(t);
    return t;
  }
  #every(ms, fn) { const t = setInterval(fn, ms); t.unref?.(); this.timers.add(t); this.intervals.add(t); }

  // ── starting states ───────────────────────────────────────────────────────
  #begin(start) {
    const states = {
      exec: () => { this.state = 'exec'; this.mode = '>'; },
      privileged: () => { this.state = 'exec'; this.mode = '#'; },
      idle: () => { this.state = 'idle'; },
      linepass: () => { this.state = 'linepass'; this.attempts = 0; },
      dialog: () => { this.state = 'dialog'; this.firstBoot = [...this.profile.firstBoot]; this.firstBoot.shift(); if (this.profile.pnp) this.#startPnp(); },
      booting: () => this.#boot(),
      rommon: () => { this.state = this.profile.kind === 'switch' ? 'bootloader' : 'rommon'; this.rommonN = 1; },
      bootloader: () => { this.state = 'bootloader'; },
      silent: () => { this.state = 'silent'; },
    };
    if (!states[start]) throw new Error(`Unknown fake start state "${start}"`);
    states[start]();
  }

  // ── keystrokes ────────────────────────────────────────────────────────────
  #char(ch) {
    switch (this.state) {
      case 'silent': case 'booting': case 'off': case 'blbusy': return; // a dead line; input during boot is ignored
      case 'rommon': case 'bootloader': return this.#monitorKey(ch);
      case 'more': return this.#moreKey(ch);
      case 'confirm': return this.#confirmKey(ch);
      case 'idle': case 'pressreturn': if (ch === '\r') this.#startExec(); return;
      default:
    }
    if (ch === '\n') return;
    if (ch === '\r') return this.#enter();
    if (ch === '\x7f' || ch === '\b') {
      if (this.line) { this.line = this.line.slice(0, -1); if (!this.#hidden()) this.out('\b \b'); }
      return;
    }
    if (ch === '\x03' || ch === '\x1a') return this.#interrupt(ch);
    if (ch < ' ') return;
    this.line += ch;
    if (!this.#hidden()) this.out(ch);
  }

  #hidden() { return this.state === 'pass' || this.state === 'linepass' || this.state === 'enablepass'; }

  #interrupt(ch) {
    this.line = '';
    if (this.state === 'dialog' || this.state === 'autoinstall') return this.#dialogDone('\r\nConfiguration aborted, no changes made.\r\n');
    if (this.state !== 'exec') return;
    if (this.#inConfig()) { this.out(ch === '\x1a' ? '^Z' : '^C'); this.#leaveConfig(); return; }
    this.out('^C'); this.#prompt();
  }

  #enter() {
    const line = this.line; this.line = '';
    switch (this.state) {
      case 'user': return this.#username(line);
      case 'pass': return this.#loginPassword(line);
      case 'linepass': return this.#linePassword(line);
      case 'enablepass': return this.#enablePassword(line);
      case 'dialog': return this.#dialogAnswer(line);
      case 'autoinstall': return this.#autoinstallAnswer(line);
      case 'extra': return this.#extraAnswer(line);
      case 'setup': return this.#dialogDone('\r\n% The setup dialog is not simulated.\r\nConfiguration aborted, no changes made.\r\n');
      case 'question': { const fn = this.onAnswer; this.state = 'exec'; return fn(line.trim()); }
      case 'banner': return this.#bannerLine(line);
      default:
    }
    this.commandLog.push(line);
    const run = () => this.#exec(line.trim(), line);
    if (this.slowConsole && line.trim()) {
      this.busy = true; // the device is busy applying the command; input piles up
      setTimeout(() => { this.busy = false; run(); }, this.slowConsole.commandMs);
    } else run();
  }

  // ── output helpers ────────────────────────────────────────────────────────
  #inConfig() { return this.mode !== '>' && this.mode !== '#'; }
  #promptText() {
    const sub = this.#inConfig() ? `(${this.mode})#` : this.mode;
    return `${this.cfg.hostname}${sub}`;
  }
  #prompt() {
    if (this.returnMode && this.state === 'exec') { this.mode = this.returnMode; this.returnMode = null; } // end of a `do` command
    this.out(`\r\n${this.#promptText()}`);
  }
  #say(text) { this.out(`\r\n${String(text).replace(/\n/g, '\r\n')}`); }

  /** A console syslog line: printed where the cursor is, prompt reprinted with `logging synchronous` */
  #syslog(msg) {
    if (this.#lineConHas('logging console') === false) return;
    this.out(`\r\n${this.#stamp()}: ${msg}`);
    if (this.state === 'exec' && this.#lineConHas('logging synchronous')) this.out(`\r\n${this.#promptText()}${this.line}`);
  }
  #lineConHas(prefix) {
    if (prefix === 'logging console') return !this.cfg.global.includes('no logging console');
    return (this.#findBlock('line con 0')?.lines || []).some((l) => l.startsWith(prefix));
  }
  #stamp() {
    if (this.stamps === 'uptime') {
      const s = Math.floor((Date.now() - this.bootedAt) / SECOND);
      const d = Math.floor(s / 86400);
      if (d >= 7) return `${Math.floor(d / 7)}w${d % 7}d`;
      if (d >= 1) return `${d}d${two(Math.floor((s % 86400) / 3600))}h`;
      return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
    }
    const d = this.#clock();
    return `*${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
  }
  /** Classic IOS without NTP starts at 1 March 1993; IOS XE keeps a calendar */
  #clock(at = Date.now()) {
    const up = at - this.bootedAt;
    return new Date((this.profile.family === 'iosxe' ? Date.UTC(2026, 10, 12, 21, 0, 0) : Date.UTC(1993, 2, 1)) + up);
  }
  #clockText(d) {
    return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
  }

  #invalid(raw, wordIndex) {
    const words = raw.trim().split(/\s+/);
    const lead = raw.length - raw.trimStart().length;
    let at = lead;
    for (let i = 0, pos = lead; i < words.length; i++) {
      pos = raw.indexOf(words[i], pos);
      if (i === wordIndex) { at = pos; break; }
      pos += words[i].length;
      at = pos + 1;
    }
    this.out(`\r\n${' '.repeat(this.#promptText().length + at)}^\r\n% Invalid input detected at '^' marker.\r\n`);
    this.#prompt();
  }
  #parseError(raw, r) {
    if (r.error === 'ambiguous') { this.#say(`% Ambiguous command:  "${raw.trim()}"`); return this.#prompt(); }
    if (r.error === 'incomplete') { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
    return this.#invalid(raw, r.at);
  }

  // ── login, console line password, enable ─────────────────────────────────
  #startExec() {
    if (this.state === 'pressreturn' && Date.now() < this.readyAt) { this.enterPending = true; return; }
    const con = this.#findBlock('line con 0')?.lines || [];
    if (con.includes('login local')) {
      this.state = 'user'; this.out('\r\n\r\nUser Access Verification\r\n\r\nUsername: '); return;
    }
    if (con.includes('login') && con.some((l) => l.startsWith('password '))) {
      this.state = 'linepass'; this.attempts = 0; this.out('\r\n\r\nUser Access Verification\r\n\r\nPassword: '); return;
    }
    this.state = 'exec'; this.mode = '>'; this.out('\r\n'); this.#prompt();
  }
  #username(line) {
    this.user = line.trim();
    this.state = 'pass';
    this.out('\r\nPassword: ');
  }
  #loginPassword(line) {
    const local = this.cfg.global.find((l) => l.startsWith(`username ${this.user} `));
    const ok = (this.user === this.username && line === this.password) || (local && this.#matchesSecret(local.split(' ').slice(2).join(' '), line));
    if (ok) { this.state = 'exec'; this.mode = '>'; this.out('\r\n'); return this.#prompt(); }
    this.state = 'user';
    this.out('\r\n% Login invalid\r\n\r\nUsername: ');
  }
  #linePassword(line) {
    const stored = (this.#findBlock('line con 0')?.lines || []).find((l) => l.startsWith('password ')).slice(9);
    const expected = stored.startsWith('7 ') ? decrypt7(stored.slice(2)) : stored;
    if (line === expected) { this.attempts = 0; this.state = 'exec'; this.mode = '>'; this.out('\r\n'); return this.#prompt(); }
    if (++this.attempts < 3) return this.out('\r\nPassword: ');
    // Third failure: the exec ends, the console is offered again
    this.attempts = 0;
    this.out('\r\n% Bad passwords\r\n');
    this.#execEnded();
  }
  #enablePassword(line) {
    if (this.#enableOk(line)) { this.state = 'exec'; this.mode = '#'; this.out('\r\n'); return this.#prompt(); }
    if (++this.attempts < 3) return this.out('\r\nPassword: ');
    this.state = 'exec';
    this.out('\r\n% Bad secrets\r\n');
    this.#prompt();
  }
  #enableOk(text) {
    const secret = this.cfg.global.find((l) => l.startsWith('enable secret '));
    if (secret) return this.#matchesSecret(secret.slice(7), text);
    const pw = this.cfg.global.find((l) => l.startsWith('enable password '));
    if (pw) return this.#matchesSecret(pw.slice(7), text);
    return true;
  }
  /** "secret 5 $1$…", "secret 9 $9$…", "password 7 0822…", "password cisco" */
  #matchesSecret(spec, text) {
    const m = spec.replace(/^privilege \d+ /, '').match(/^(secret|password) (?:([0579]) )?(.+)$/);
    if (!m) return false;
    const [, , type, value] = m;
    if (type === '5' || type === '9') return secretHash(Number(type), text) === value;
    if (type === '7') return decrypt7(value) === text;
    return value === text;
  }
  #execEnded() {
    this.mode = '>';
    this.state = 'idle';
    this.out(`\r\n\r\n${this.cfg.hostname} con0 is now available\r\n\r\n\r\n\r\n\r\n\r\nPress RETURN to get started.\r\n`);
  }
  #setEnableSecret(secret) {
    const type = this.profile.family === 'iosxe' ? 9 : 5;
    this.cfg.global = this.cfg.global.filter((l) => !l.startsWith('enable secret '));
    this.cfg.global.push(`enable secret ${type} ${secretHash(type, secret)}`);
  }

  // ── the command line ──────────────────────────────────────────────────────
  #exec(line, raw = line) {
    if (!line) return this.#prompt();
    if (this.#inConfig()) return this.#configLine(line, raw);
    const words = line.split(/\s+/);
    const r = expand(words, EXEC);
    if (r.error === 'invalid' && r.at === 0) return this.#unknownWord(words[0]);
    // In user EXEC the privileged commands do not exist: IOS takes the word for a host name
    if (this.mode === '>' && (r.error ? r.at > 0 : true) && PRIVILEGED_ONLY.has(expand([words[0]], EXEC).words?.[0])) return this.#unknownWord(words[0]);
    if (r.error) return this.#parseError(raw, r);
    const w = r.words;
    const [c] = w;
    if (c === 'enable') {
      if (this.mode === '#') return this.#prompt();
      if (this.cfg.global.some((l) => /^enable (secret|password) /.test(l))) { this.state = 'enablepass'; this.attempts = 0; return this.out('\r\nPassword: '); }
      this.mode = '#'; return this.#prompt();
    }
    if (c === 'disable') { this.mode = '>'; return this.#prompt(); }
    if (c === 'exit' || c === 'logout' || c === 'quit') return this.#execEnded();
    if (c === 'terminal') {
      if (!this.termLengthSupported) return this.#invalid(raw, 0);
      if (w[1] === 'length' && /^\d+$/.test(w[2] || '')) { this.termLength = Number(w[2]); return this.#prompt(); }
      if (w[1] === 'no' && w[2] === 'length') { this.termLength = 24; return this.#prompt(); }
      if (w[1] === 'monitor') return this.#prompt();
      this.#say('% Incomplete command.\r\n'); return this.#prompt();
    }
    if (c === 'show') return this.#show(w.slice(1), raw);
    if (c === 'configure') {
      this.#say('Enter configuration commands, one per line.  End with CNTL/Z.');
      this.mode = 'config'; this.configTouched = false; return this.#prompt();
    }
    if (c === 'copy') return this.#copy(w.slice(1), raw);
    if (c === 'write') {
      if (w[1] === 'erase') return this.#eraseNvram();
      if (w[1] === 'terminal') return this.#page(this.#runningConfig());
      this.#say('Building configuration...\n[OK]'); this.#save(); return this.#prompt();
    }
    if (c === 'erase') {
      if (/^(startup-config|nvram:?)$/i.test(w[1] || '') || /^star/i.test(w[1] || '')) return this.#eraseNvram();
      if (!w[1]) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
      return this.#invalid(raw, 1);
    }
    if (c === 'delete') return this.#delete(w.slice(1).join(' '));
    if (c === 'reload') return this.#reload();
    if (c === 'ping') return this.#ping(w.slice(1), raw);
    if (c === 'dir') return this.#dir();
    if (c === 'rename') return this.#rename(w.slice(1));
    if (c === 'setup') { this.state = 'dialog'; this.firstBoot = []; return this.#askDialog(); }
    this.#say('% Incomplete command.\r\n');
    return this.#prompt();
  }

  #unknownWord(word) {
    if (this.profile.generic) { this.#say('% Unknown command or computer name, or unable to find computer address'); return this.#prompt(); }
    const lookup = !this.cfg.global.includes('no ip domain-lookup') && !this.cfg.global.includes('no ip domain lookup');
    if (!lookup) { this.#say(`Translating "${word}"\r\n% Unknown command or computer name, or unable to find computer address`); return this.#prompt(); }
    this.#say(`Translating "${word}"...domain server (255.255.255.255)`);
    this.state = 'booting'; // swallows keys like the real lookup does
    this.#later(5 * SECOND, () => { this.state = 'exec'; this.#say('% Unknown command or computer name, or unable to find computer address'); this.#prompt(); });
  }

  // ── configuration mode ────────────────────────────────────────────────────
  #configLine(line, raw) {
    if (line.startsWith('!')) return this.#prompt(); // a comment
    const words = line.split(/\s+/);
    const first = words[0].toLowerCase();
    if (words.length === 1 && first.length >= 2 && 'end'.startsWith(first)) return this.#leaveConfig();
    if (words.length === 1 && first.length >= 2 && 'exit'.startsWith(first)) {
      if (this.mode === 'config') return this.#leaveConfig();
      this.#toGlobal(); return this.#prompt();
    }
    if (first === 'do' && words.length > 1) {
      this.returnMode = this.mode; // restored by the prompt that ends the command
      this.mode = '#';
      return this.#exec(words.slice(1).join(' '));
    }
    if (this.mode === 'config-vlan') return this.#vlanLine(words, raw);
    const sub = SUB_MODES[this.mode];
    if (sub) {
      const r = expand(words, sub);
      if (!r.error) return this.#subLine(r.words, raw);
      // Like IOS: a global command typed in a sub-mode leaves the sub-mode and runs globally
      const g = expand(words, GLOBAL);
      if (!g.error && g.words[0] !== 'no') { this.#toGlobal(); return this.#globalLine(g.words, raw); }
      return this.#parseError(raw, r);
    }
    if (this.block) {
      // Inside another block (dhcp pool, access list, vrf, control-plane…): its own commands stay in it
      const own = BLOCK_WORDS[this.mode] ? expand(words, BLOCK_WORDS[this.mode]) : { error: 'invalid', at: 0 };
      if (!own.error) {
        this.#touch();
        this.#addOnce(this.block.lines, line.replace(/\s+/g, ' '));
        return this.#prompt();
      }
      const g = expand(words, GLOBAL);
      if (!g.error) { this.#toGlobal(); return this.#globalLine(g.words, raw); }
      return this.#parseError(raw, BLOCK_WORDS[this.mode] ? own : g);
    }
    const g = expand(words, GLOBAL);
    if (g.error) return this.#parseError(raw, g);
    return this.#globalLine(g.words, raw);
  }

  #toGlobal() { this.mode = 'config'; this.block = null; this.ifaceName = null; }

  #leaveConfig() {
    this.mode = '#';
    this.block = null;
    this.#prompt();
    this.#syslog('%SYS-5-CONFIG_I: Configured from console by console');
  }
  #touch() { this.dirty = true; this.changedAt = Date.now(); }

  #globalLine(w, raw) {
    const p = this.profile;
    const text = w.join(' ');
    const [c] = w;
    if (c === 'no') return this.#globalNo(w.slice(1), raw);
    if (c === 'hostname') {
      if (!w[1]) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
      this.#touch(); this.cfg.hostname = w[1]; return this.#prompt();
    }
    if (c === 'interface') return this.#enterInterface(w.slice(1).join(''), raw);
    if (c === 'vlan' && w[1] !== 'internal') {
      if (p.kind !== 'switch' || !/^\d+$/.test(w[1] || '')) return this.#invalid(raw, w[1] ? 1 : 0);
      if (this.vtp.mode === 'client') { this.#say('VTP VLAN configuration not allowed when device is in CLIENT mode.'); return this.#prompt(); }
      const id = Number(w[1]);
      if (id < 1 || id > 4094) return this.#invalid(raw, 1);
      if (id >= 1002 && id <= 1005) { this.#say(`Default VLAN ${id} may not have its name changed.`); this.mode = 'config-vlan'; this.vlanId = id; return this.#prompt(); }
      this.#touch();
      if (!this.vlans.has(id)) { this.vlans.set(id, { name: `VLAN${String(id).padStart(4, '0')}`, status: 'active' }); this.#vlanChanged(); }
      this.vlanId = id; this.mode = 'config-vlan'; return this.#prompt();
    }
    if (c === 'line') {
      const m = text.match(/^line (con|console|aux|vty) (\d+)(?: (\d+))?$/);
      if (!m) return this.#invalid(raw, 1);
      const kind = m[1].startsWith('con') ? 'con' : m[1];
      const head = kind === 'vty' ? `line vty ${m[2]} ${m[3] ?? m[2]}` : `line ${kind} 0`;
      if (kind === 'aux' && p.kind === 'switch') return this.#invalid(raw, 1);
      this.block = this.#block(head); this.mode = 'config-line'; return this.#prompt();
    }
    if (c === 'router') {
      if (p.kind === 'switch' && !p.layer3 && !p.generic) return this.#invalid(raw, 0);
      if (!w[1]) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
      this.#touch(); this.block = this.#block(text); this.mode = 'config-router'; return this.#prompt();
    }
    if (c === 'banner') return this.#banner(raw);
    if (c === 'enable') {
      const m = text.match(/^enable (secret|password) (?:(0|5|7|8|9) )?(\S+)$/);
      if (!m) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
      this.#touch();
      if (m[1] === 'secret' && (!m[2] || m[2] === '0')) this.#setEnableSecret(m[3]);
      else { this.cfg.global = this.cfg.global.filter((l) => !l.startsWith(`enable ${m[1]} `)); this.cfg.global.push(`enable ${m[1]} ${m[2] ? `${m[2]} ` : ''}${m[3]}`); }
      return this.#prompt();
    }
    if (c === 'username') {
      const m = raw.trim().match(/^\S+ (\S+)(?: privilege (\d+))? (secret|password) (?:(0|5|7|8|9) )?(\S+)$/);
      if (!m) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
      this.#touch();
      const type = this.profile.family === 'iosxe' ? 9 : 5;
      const value = m[3] === 'secret' && (!m[4] || m[4] === '0') ? `${type} ${secretHash(type, m[5])}` : `${m[4] ? `${m[4]} ` : ''}${m[5]}`;
      this.cfg.global = this.cfg.global.filter((l) => !l.startsWith(`username ${m[1]} `));
      this.cfg.global.push(`username ${m[1]}${m[2] ? ` privilege ${m[2]}` : ''} ${m[3]} ${value}`);
      return this.#prompt();
    }
    if (c === 'system' && w.slice(1).join(' ') === 'ignore startupconfig switch all') {
      if (p.family !== 'iosxe' || p.kind !== 'switch') return this.#invalid(raw, 1);
      this.romvars.SWITCH_IGNORE_STARTUP_CFG = '1'; return this.#prompt();
    }
    if (c === 'config-register') {
      if (p.kind !== 'router' || !/^0x[0-9a-f]{1,4}$/i.test(w[1] || '')) return this.#invalid(raw, 1);
      this.nextConfReg = `0x${w[1].slice(2).toUpperCase().replace(/^0+(?=.)/, '')}`.replace('0X', '0x');
      this.#touch(); return this.#prompt();
    }
    if (c === 'ip' && w[1] === 'route' && !(isIp(w[2]) && isIp(w[3]))) return this.#invalid(raw, isIp(w[2]) ? 3 : 2);
    if (c === 'ip' && w[1] === 'routing' && p.kind === 'switch' && !p.layer3 && !p.generic) return this.#invalid(raw, 1);
    if (c === 'ip' && w[1] === 'dhcp' && w[2] === 'pool' && w[3]) { this.#touch(); this.block = this.#block(`ip dhcp pool ${w[3]}`); this.mode = 'dhcp-config'; return this.#prompt(); }
    if (c === 'ip' && w[1] === 'access-list' && /^(standard|extended)$/.test(w[2] || '') && w[3]) {
      this.#touch(); this.block = this.#block(text); this.mode = w[2] === 'standard' ? 'config-std-nacl' : 'config-ext-nacl'; return this.#prompt();
    }
    if (c === 'ip' && w[1] === 'domain' && w[2] === 'name' && w[3]) return this.#keyed(['ip domain name ', 'ip domain-name '], `ip domain name ${w[3]}`);
    if (c === 'ip' && w[1] === 'domain-name' && w[2]) return this.#keyed(['ip domain name ', 'ip domain-name '], `ip domain-name ${w[2]}`);
    if (c === 'ip' && w[1] === 'default-gateway' && isIp(w[2])) return this.#keyed(['ip default-gateway '], text);
    if (c === 'crypto') return this.#crypto(raw);
    const blockHeads = { 'control-plane': 'config-cp', redundancy: 'config-red', vrf: 'config-vrf', transceiver: 'config-xcvr-type', 'call-home': 'cfg-call-home', archive: 'config-archive' };
    if (blockHeads[c]) { this.#touch(); this.block = this.#block(text); this.mode = blockHeads[c]; return this.#prompt(); }
    if (c === 'spanning-tree' && w[1] === 'mode') return this.#keyed(['spanning-tree mode '], text);
    if (c === 'vtp') return this.#vtpLine(w, raw);
    if (c === 'default' && w[1] === 'interface') {
      const name = normalizeIface(w.slice(2).join(''));
      const ifc = name && this.cfg.interfaces.get(name);
      if (!ifc) return this.#invalid(raw, 2);
      const def = p.interfaces.find(([n]) => n === name);
      Object.assign(ifc, { lines: def ? [...def[2]] : [], shutdown: def ? def[1] : false });
      this.#touch(); this.#say(`Interface ${name} set to default configuration`); return this.#prompt();
    }
    if (c === 'do' || c === 'default') return this.#prompt();
    if (text === 'service password-encryption') this.#encryptPasswords();
    this.#touch();
    this.cfg.global = this.cfg.global.filter((l) => l !== `no ${text}`);
    if (!this.cfg.global.includes(text)) this.cfg.global.push(text);
    return this.#prompt();
  }
  /** `service password-encryption` turns every clear-text password into type 7 at once */
  #encryptPasswords() {
    for (const b of this.cfg.blocks) b.lines = b.lines.map((l) => (/^password (?!7 )/.test(l) ? `password 7 ${encrypt7(l.slice(9))}` : l));
    this.cfg.global = this.cfg.global.map((l) => l.replace(/^(enable password|username \S+(?: privilege \d+)? password) (?![57] )(\S+)$/, (_, head, pw) => `${head} 7 ${encrypt7(pw)}`));
  }

  /** A setting with one value: replaced where it stands, like IOS shows it */
  #keyed(prefixes, text) {
    this.#touch();
    const at = this.cfg.global.findIndex((l) => prefixes.some((p) => l.startsWith(p)));
    this.cfg.global = this.cfg.global.filter((l, i) => i === at || !prefixes.some((p) => l.startsWith(p)));
    if (at >= 0) this.cfg.global[this.cfg.global.findIndex((l) => prefixes.some((p) => l.startsWith(p)))] = text;
    else this.cfg.global.push(text);
    return this.#prompt();
  }

  #globalNo(w, raw) {
    const text = w.join(' ');
    this.#touch();
    if (w[0] === 'vlan' && /^\d+$/.test(w[1] || '')) { this.vlans.delete(Number(w[1])); this.#vlanChanged(); return this.#prompt(); }
    if (w[0] === 'vtp' && this.profile.kind === 'switch') {
      if (w[1] === 'password') { this.vtp.password = null; this.#say('Clearing device VLAN database password.'); }
      if (w[1] === 'mode') { this.vtp.mode = 'server'; this.#say('Setting device to VTP SERVER mode.'); }
      this.#vlanChanged(); return this.#prompt();
    }
    if (w[0] === 'interface') {
      const name = normalizeIface(w.slice(1).join(''));
      if (!name || !this.cfg.interfaces.has(name) || this.cfg.interfaces.get(name).physical) return this.#invalid(raw, 1);
      this.cfg.interfaces.delete(name); return this.#prompt();
    }
    if (w[0] === 'banner') { this.cfg.global = this.cfg.global.filter((l) => !l.startsWith(`banner ${w[1]} `)); return this.#prompt(); }
    if (w[0] === 'enable') { this.cfg.global = this.cfg.global.filter((l) => !l.startsWith(`enable ${w[1]} `)); return this.#prompt(); }
    if (w[0] === 'username') { this.cfg.global = this.cfg.global.filter((l) => !l.startsWith(`username ${w[1]} `)); return this.#prompt(); }
    if (w[0] === 'router' || (w[0] === 'ip' && /^(dhcp|access-list)$/.test(w[1]))) { this.cfg.blocks = this.cfg.blocks.filter((b) => !b.head.startsWith(text)); return this.#prompt(); }
    if (w[0] === 'system' && w.slice(1).join(' ') === 'ignore startupconfig switch all' && this.profile.family === 'iosxe' && this.profile.kind === 'switch') {
      if (!this.ignoreFlagSticks) this.romvars.SWITCH_IGNORE_STARTUP_CFG = '0';
      return this.#prompt();
    }
    if (w[0] === 'hostname') { this.cfg.hostname = this.profile.kind === 'router' ? 'Router' : 'Switch'; return this.#prompt(); }
    if (this.cfg.global.includes(text)) { this.cfg.global = this.cfg.global.filter((l) => l !== text); return this.#prompt(); }
    if (!this.cfg.global.includes(`no ${text}`)) this.cfg.global.push(`no ${text}`);
    return this.#prompt();
  }

  #vlanLine(words, raw) {
    const r = expand(words, { name: W, state: W, shutdown: {}, no: { name: {}, shutdown: {}, state: {} } });
    if (r.error) {
      const g = expand(words, GLOBAL);
      if (!g.error && g.words[0] !== 'no') { this.mode = 'config'; return this.#globalLine(g.words, raw); }
      return this.#parseError(raw, r);
    }
    const v = this.vlans.get(this.vlanId);
    if (r.words[0] === 'name' && r.words[1] && v) { v.name = r.words[1].slice(0, 32); this.#touch(); this.#vlanChanged(); }
    if (r.words[0] === 'no' && r.words[1] === 'name' && v) { v.name = `VLAN${String(this.vlanId).padStart(4, '0')}`; this.#vlanChanged(); }
    // Suspended and locally shut VLANs, as show vlan brief prints them
    const shut = v && /\/lshut$/.test(v.status);
    const susp = v && /^sus/.test(v.status);
    const status = (s, l) => (l ? `${s ? 'sus' : 'act'}/lshut` : s ? 'suspended' : 'active');
    if (v && r.words[0] === 'state') {
      if (!/^(active|suspend)$/.test(r.words[1] || '')) return this.#invalid(raw, 1);
      v.status = status(r.words[1] === 'suspend', shut); this.#touch(); this.#vlanChanged();
    }
    if (v && r.words[0] === 'shutdown') { v.status = status(susp, true); this.#touch(); this.#vlanChanged(); }
    if (v && r.words[0] === 'no' && r.words[1] === 'shutdown') { v.status = status(susp, false); this.#vlanChanged(); }
    if (v && r.words[0] === 'no' && r.words[1] === 'state') { v.status = status(false, shut); this.#vlanChanged(); }
    return this.#prompt();
  }
  #vlanChanged() { this.vtp.revision++; this.vlanFile = structuredClone([...this.vlans]); this.vtpFile = { ...this.vtp }; }

  /** vtp version | domain | password | mode | pruning: kept in vlan.dat, as classic IOS does */
  #vtpLine(w, raw) {
    if (this.profile.kind !== 'switch') return this.#invalid(raw, 0);
    const v = this.vtp;
    const arg = raw.trim().split(/\s+/)[2];
    if (!arg && w[1] !== 'pruning') { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
    if (w[1] === 'mode') {
      const mode = ['server', 'client', 'transparent', 'off'].find((m) => m.startsWith(arg.toLowerCase()));
      if (!mode) return this.#invalid(raw, 2);
      this.#say(v.mode === mode ? `Device mode already VTP ${mode.toUpperCase()}.` : `Setting device to VTP ${mode.toUpperCase()} mode.`);
      v.mode = mode;
    } else if (w[1] === 'domain') {
      this.#say(v.domain === arg ? `Domain name already set to ${arg}.` : `Changing VTP domain name from ${v.domain || 'NULL'} to ${arg}`);
      v.domain = arg.slice(0, 32);
    } else if (w[1] === 'password') {
      v.password = arg.slice(0, 64);
      this.#say(`Setting device VLAN database password to ${v.password}`);
    } else if (w[1] === 'version') {
      if (!/^[123]$/.test(arg)) return this.#invalid(raw, 2);
      if (v.mode === 'client') { this.#say('Cannot modify version in VTP client mode unless the system is in VTP version 3'); return this.#prompt(); }
      v.version = Number(arg);
    } else if (w[1] === 'pruning') {
      v.pruning = true;
    } else return this.#invalid(raw, 1);
    this.#vlanChanged();
    return this.#prompt();
  }
  #defaultVlans() {
    if (this.profile.kind !== 'switch') return new Map();
    const base = [[1, { name: 'default', status: 'active' }]];
    if (this.profile.family === 'ios') base.push([1002, { name: 'fddi-default', status: 'act/unsup' }], [1003, { name: 'token-ring-default', status: 'act/unsup' }], [1004, { name: 'fddinet-default', status: 'act/unsup' }], [1005, { name: 'trnet-default', status: 'act/unsup' }]);
    else base.push([1002, { name: 'fddi-default', status: 'act/unsup' }], [1003, { name: 'token-ring-default', status: 'act/unsup' }], [1004, { name: 'fddinet-default', status: 'act/unsup' }], [1005, { name: 'trnet-default', status: 'act/unsup' }]);
    return new Map(base);
  }

  // ── interfaces ────────────────────────────────────────────────────────────
  #enterInterface(spec, raw) {
    const name = normalizeIface(spec);
    if (!name) return this.#invalid(raw, 1);
    const p = this.profile;
    if (!this.cfg.interfaces.has(name)) {
      const parent = name.includes('.') ? name.split('.')[0] : null;
      const virtual = /^(Loopback|Tunnel|Port-channel)/.test(name) || (name.startsWith('Vlan') && p.kind === 'switch');
      const sub = parent && this.cfg.interfaces.get(parent)?.physical && p.kind === 'router';
      if (!p.generic && !virtual && !sub) return this.#invalid(raw, 1);
      if (name.startsWith('Vlan') && p.kind === 'switch') {
        const id = Number(name.slice(4));
        if (id < 1 || id > 4094) return this.#invalid(raw, 1);
      }
      this.#touch();
      this.cfg.interfaces.set(name, { lines: name.startsWith('Vlan') || sub ? [] : [], shutdown: false, physical: false });
      if (p.family === 'ios' && !p.generic) this.#later(1500, () => this.#syslog(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to ${name.startsWith('Loopback') ? 'up' : 'down'}`));
    }
    this.ifaceName = name;
    this.mode = name.includes('.') ? 'config-subif' : 'config-if';
    return this.#prompt();
  }

  #subLine(w, raw) {
    if (this.mode === 'config-line') return this.#lineLine(w, raw);
    if (this.mode === 'config-router') {
      this.#touch();
      const b = this.block;
      if (w[0] === 'no') {
        const rest = w.slice(1).join(' ');
        if (b.lines.includes(rest)) b.lines = b.lines.filter((l) => l !== rest);
        else this.#addOnce(b.lines, w.join(' '));
      } else {
        b.lines = b.lines.filter((l) => l !== `no ${w.join(' ')}`);
        this.#addOnce(b.lines, w.join(' '));
      }
      return this.#prompt();
    }
    return this.#interfaceLine(w, raw);
  }
  #addOnce(arr, s) { if (!arr.includes(s)) arr.push(s); }

  /** `line con 0` / `line vty 0 4`: one value per setting */
  #lineLine(w, raw) {
    this.#touch();
    const b = this.block;
    const neg = w[0] === 'no';
    const k = neg ? w.slice(1) : w;
    const key = ['transport', 'privilege', 'history'].includes(k[0]) ? k.slice(0, 2).join(' ') : ['logging', 'access-class'].includes(k[0]) ? k.join(' ') : k[0];
    b.lines = b.lines.filter((l) => !(l === key || l.startsWith(`${key} `) || l === `no ${key}`));
    if (neg) { if (key === 'login' && b.head.startsWith('line vty')) b.lines.push('no login'); return this.#prompt(); }
    if (k[0] === 'password') {
      const value = raw.trim().split(/\s+/).slice(1).join(' ');
      b.lines.push(`password ${this.cfg.global.includes('service password-encryption') && !/^7 /.test(value) ? `7 ${encrypt7(value)}` : value}`);
      return this.#prompt();
    }
    b.lines.push(k.join(' '));
    return this.#prompt();
  }

  #interfaceLine(w, raw) {
    const p = this.profile;
    const name = this.ifaceName;
    const ifc = this.cfg.interfaces.get(name);
    const physicalSwitchPort = p.kind === 'switch' && ifc.physical && !name.startsWith('Vlan') && name !== 'GigabitEthernet0/0';
    const routed = ifc.lines.includes('no switchport');
    const neg = w[0] === 'no';
    const k = neg ? w.slice(1) : w;
    const at = neg ? 1 : 0; // index of the keyword in what was typed
    const drop = (key) => { ifc.lines = ifc.lines.filter((l) => !(l === key || l.startsWith(`${key} `))); };
    this.#touch();

    if (k[0] === 'shutdown') {
      if (ifc.shutdown !== !neg) {
        ifc.shutdown = !neg;
        if (!p.generic) {
          this.#later(800, () => this.#syslog(`%LINK-${neg ? 3 : 5}-${neg ? 'UPDOWN' : 'CHANGED'}: Interface ${name}, changed state to ${neg ? 'up' : 'administratively down'}`));
          if (neg) this.#later(1800, () => this.#syslog(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to up`));
        }
      }
      return this.#prompt();
    }
    if (k[0] === 'description') {
      drop('description');
      if (!neg) ifc.lines.push(`description ${raw.trim().replace(/^\S+\s+/, '')}`);
      return this.#prompt();
    }
    if (k[0] === 'switchport') {
      if (!p.generic && (p.kind !== 'switch' || name.startsWith('Vlan'))) return this.#invalid(raw, at);
      if (k.length === 1) { // "no switchport": a routed port (layer-3 switches only)
        if (!p.layer3 && !p.generic) return this.#invalid(raw, at);
        ifc.lines = ifc.lines.filter((l) => l !== 'no switchport' && !l.startsWith('ip address') && l !== 'no ip address');
        if (neg) ifc.lines.push('no switchport', 'no ip address');
        return this.#prompt();
      }
      if (routed && !neg) return this.#invalid(raw, at);
      if (k[1] === 'mode' && k[2] === 'trunk' && !neg && p.layer3 && p.family === 'ios' && !ifc.lines.some((l) => l.startsWith('switchport trunk encapsulation'))) {
        this.#say('Command rejected: An interface whose trunk encapsulation is "Auto" can not be configured to "trunk" mode.');
        return this.#prompt();
      }
      if (k[1] === 'trunk' && k[2] === 'encapsulation' && !p.generic && (!p.layer3 || p.family === 'iosxe')) return this.#invalid(raw, at + 2);
      if (k[1] === 'access' && k[2] === 'vlan') {
        const id = Number(k[3]);
        if (!neg && !(id >= 1 && id <= 4094)) return this.#invalid(raw, at + 3);
        if (!neg && !this.vlans.has(id) && !p.generic) {
          this.#say(`% Access VLAN does not exist. Creating vlan ${id}`);
          this.vlans.set(id, { name: `VLAN${String(id).padStart(4, '0')}`, status: 'active' }); this.#vlanChanged();
        }
        drop('switchport access vlan');
        if (!neg && id !== 1) ifc.lines.push(`switchport access vlan ${id}`);
        return this.#prompt();
      }
      drop(k[1] === 'trunk' ? k.slice(0, 3).join(' ') : k[1] === 'port-security' ? k.join(' ') : k.slice(0, 2).join(' '));
      if (!neg) ifc.lines.push(k.join(' '));
      return this.#prompt();
    }
    if (k[0] === 'ip' && k[1] === 'address') {
      if (physicalSwitchPort && !routed && !p.generic) return this.#invalid(raw, at);
      if (neg) { drop('ip address'); if (!p.generic) this.#addOnce(ifc.lines, 'no ip address'); return this.#prompt(); }
      const [, , ip, mask, extra] = k;
      if (!isIp(ip)) return this.#invalid(raw, 2);
      if (!isIp(mask)) return mask ? this.#invalid(raw, 3) : (this.#say('% Incomplete command.\r\n'), this.#prompt());
      const secondary = extra === 'secondary';
      ifc.lines = ifc.lines.filter((l) => l !== 'no ip address' && (secondary || !/^ip address \S+ \S+$/.test(l)));
      ifc.lines.push(`ip address ${ip} ${mask}${secondary ? ' secondary' : ''}`);
      return this.#prompt();
    }
    if (k[0] === 'encapsulation' && k[1] === 'dot1q') {
      if (!/^\d+$/.test(k[2] || '')) return this.#invalid(raw, at + 2);
      drop('encapsulation');
      if (!neg) ifc.lines.push(`encapsulation dot1Q ${k.slice(2).join(' ')}`);
      return this.#prompt();
    }
    // Everything else: one value per setting, shown with full keywords
    const kw = k.slice(0, ['ip', 'clock', 'cdp', 'vrf', 'negotiation'].includes(k[0]) ? 2 : 1).join(' ');
    ifc.lines = ifc.lines.filter((l) => !(l === kw || l.startsWith(`${kw} `) || l === `no ${kw}` || l.startsWith(`no ${kw} `)));
    const defaults = { duplex: 'duplex auto', speed: 'speed auto', 'negotiation auto': 'negotiation auto' };
    if (neg) {
      if (kw === 'cdp enable') ifc.lines.push('no cdp enable');
      else if (defaults[kw] && this.#isDefaultLine(name, defaults[kw])) ifc.lines.push(defaults[kw]);
    } else if (kw !== 'cdp enable') ifc.lines.push(k.join(' '));
    return this.#prompt();
  }
  #isDefaultLine(name, line) {
    const def = this.profile.interfaces.find(([n]) => n === name);
    return def ? def[2].includes(line) : false;
  }

  // ── banners ───────────────────────────────────────────────────────────────
  #banner(raw) {
    const m = raw.trim().match(/^\S+\s+(motd|login|exec|incoming)\s+(.*)$/i);
    if (!m || !m[2]) return this.#invalid(raw, 1);
    this.mode = 'config';
    const kind = m[1].toLowerCase();
    const body = m[2];
    const delim = body[0];
    const close = body.indexOf(delim, 1);
    if (close > 0) { this.#setBanner(kind, body.slice(1, close)); return this.#prompt(); }
    this.state = 'banner';
    this.bannerKind = kind; this.bannerDelim = delim; this.bannerText = body.slice(1);
    this.out(`\r\nEnter TEXT message.  End with the character '${delim}'.\r\n`);
  }
  #bannerLine(line) {
    const at = line.indexOf(this.bannerDelim);
    if (at < 0) { this.bannerText += `\n${line}`; this.out('\r\n'); return; }
    this.bannerText += `\n${line.slice(0, at)}`;
    this.state = 'exec';
    this.#setBanner(this.bannerKind, this.bannerText);
    this.#prompt();
  }
  /** Stored as IOS shows it: banner motd ^C<text>^C (text may span lines) */
  #setBanner(kind, text) {
    this.#touch();
    this.cfg.global = this.cfg.global.filter((l) => !l.startsWith(`banner ${kind} `));
    this.cfg.global.push(`banner ${kind} ^C${text}^C`);
  }

  // ── crypto (only what a lab replays: key generation) ─────────────────────
  #crypto(raw) {
    if (/^crypto key generate rsa\b/i.test(raw.trim())) {
      const m = raw.match(/modulus (\d+)/);
      if (!m) { this.state = 'question'; this.onAnswer = () => { this.#say('% Key generation simulated'); this.#prompt(); }; return this.out('\r\nHow many bits in the modulus [512]: '); }
      this.#say(`The name for the keys will be: ${this.cfg.hostname}.lab\r\n\r\n% The key modulus size is ${m[1]} bits\r\n% Generating ${m[1]} bit RSA keys, keys will be non-exportable...\r\n[OK] (elapsed time was 1 seconds)`);
      this.rsaKeys = Number(m[1]);
      return this.#prompt();
    }
    if (/^crypto pki/i.test(raw.trim())) { this.#touch(); this.block = this.#block(raw.trim().replace(/\s+/g, ' ')); this.mode = 'ca-trustpoint'; return this.#prompt(); }
    return this.#invalid(raw, 1);
  }

  // ── blocks ────────────────────────────────────────────────────────────────
  #findBlock(head) { return this.cfg.blocks.find((b) => b.head === head); }
  #block(head) {
    let b = this.#findBlock(head);
    if (!b) { b = { head, lines: [] }; this.cfg.blocks.push(b); }
    return b;
  }

  // ── show ──────────────────────────────────────────────────────────────────
  #show(w, raw) {
    const what = w.join(' ');
    const p = this.profile;
    if (what.startsWith('running-config')) {
      if (this.mode !== '#') return this.#invalid(raw, 1);
      return this.#page(this.#runningConfig());
    }
    if (what === 'startup-config') {
      if (this.mode !== '#') return this.#invalid(raw, 1);
      if (!this.startup) { this.#say('startup-config is not present'); return this.#prompt(); }
      const lines = this.#renderConfig(this.startup, { header: false });
      return this.#page([`Using ${lines.join('\n').length} out of ${p.family === 'iosxe' ? 33554432 : 245752} bytes`, ...lines]);
    }
    if (what === 'version') return this.#page(this.#showVersion());
    if (what === 'romvar') {
      // IOS XE switches only (the 9300L): the ROMMON variables
      if (p.family !== 'iosxe' || p.kind !== 'switch') return this.#invalid(raw, 1);
      return this.#page(['ROMMON variables:', ' MAC_ADDR="00:1A:2B:3C:4D:00"', ' MODEL_NUM="C9300L-24T-4G"', ` BOOT="${p.image}"`,
        ...Object.entries(this.romvars).map(([k, v]) => ` ${k}="${v}"`)]);
    }
    if (what.startsWith('vlan')) {
      if (p.kind !== 'switch') return this.#invalid(raw, 1);
      return this.#page(this.#showVlanBrief());
    }
    if (what.startsWith('vtp')) {
      if (p.kind !== 'switch') return this.#invalid(raw, 1);
      if (what === 'vtp password') {
        this.#say(this.vtp.password ? `VTP Password: ${this.vtp.password}` : 'The VTP password is not configured.');
        return this.#prompt();
      }
      if (what === 'vtp status') return this.#page(this.#showVtpStatus());
      this.#say('% Incomplete command.\r\n'); return this.#prompt();
    }
    if (what.startsWith('cdp')) {
      if (this.cfg.global.includes('no cdp run')) { this.#say('% CDP is not enabled'); return this.#prompt(); }
      return this.#page(this.#showCdp());
    }
    if (what === 'ip interface brief') return this.#page(this.#showIpIntBrief());
    if (what === 'clock') { this.#say(this.#stamp().replace(/^\*/, '*') + ' UTC'); return this.#prompt(); }
    if (what.startsWith('flash')) return this.#dir();
    this.#say('% Incomplete command.\r\n');
    return this.#prompt();
  }

  #uptime() {
    const s = Math.floor((Date.now() - this.bootedAt) / SECOND) + 4 * 60;
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return `${h ? `${h} hour${h > 1 ? 's' : ''}, ` : ''}${m} minute${m === 1 ? '' : 's'}`;
  }

  #showVersion() {
    const p = this.profile;
    const host = this.cfg.hostname;
    const reg = this.confReg && `Configuration register is ${this.confReg}${this.nextConfReg && this.nextConfReg !== this.confReg ? ` (will be ${this.nextConfReg} at next reload)` : ''}`;
    const out = [];
    if (p.family === 'iosxe') {
      out.push(`Cisco IOS XE Software, Version ${p.version}`, `Cisco IOS Software [${p.train}], ${p.iosLine}`, 'Technical Support: http://www.cisco.com/techsupport',
        'Copyright (c) 1986-2022 by Cisco Systems, Inc.', 'Compiled Sun 14-Aug-22 08:57 by mcpre', '', '',
        'Cisco IOS-XE software, Copyright (c) 2005-2022 by cisco Systems, Inc.', 'All rights reserved.  Certain components of Cisco IOS-XE software are',
        'licensed under the GNU General Public License ("GPL") Version 2.0.  The', 'software code licensed under GPL Version 2.0 is free software that comes',
        'with ABSOLUTELY NO WARRANTY.  You can redistribute and/or modify such', 'GPL code under the terms of GPL Version 2.0.  For more details, see the',
        'documentation or "License Notice" file accompanying the IOS-XE software,', 'or the applicable URL provided on the flyer accompanying the IOS-XE', 'software.', '', '',
        ...p.rom, '', `${host} uptime is ${this.#uptime()}`, `Uptime for this control processor is ${this.#uptime()}`, 'System returned to ROM by Reload Command',
        `System image file is "${p.image}"`, 'Last reload reason: Reload Command', '', '',
        'This product contains cryptographic features and is subject to United', 'States and local country laws governing import, export, transfer and', 'use. Delivery of Cisco cryptographic products does not imply', '', '',
        p.hw, `Processor board ID ${this.serial}`, ...(p.kind === 'router' ? ['Router operating mode: Autonomous'] : []), ...p.counts, '');
      if (p.switchTable) {
        out.push(`Base Ethernet MAC Address          : 70:18:a7:12:34:00`, `Model Number                       : ${p.pid}`, `System Serial Number               : ${this.serial}`, '',
          'Switch Ports Model              SW Version        SW Image              Mode   ', '------ ----- -----              ----------        ----------            ----   ', ...p.switchTable(p), '');
      }
    } else {
      out.push(`Cisco IOS Software, ${p.iosLine}`, 'Technical Support: http://www.cisco.com/techsupport', 'Copyright (c) 1986-2012 by Cisco Systems, Inc.', 'Compiled Sat 28-Jul-12 00:29 by prod_rel_team', '',
        ...p.rom, '', `${host} uptime is ${this.#uptime()}`, 'System returned to ROM by power-on', `System image file is "${p.image}"`, '', '',
        'This product contains cryptographic features and is subject to United', 'States and local country laws governing import, export, transfer and', 'use. Delivery of Cisco cryptographic products does not imply', '', '',
        p.hw, `Processor board ID ${this.serial}`, ...p.counts);
      if (p.switchTable) {
        out.push('Base ethernet MAC Address       : 00:1A:2B:3C:4D:00', 'Motherboard assembly number     : 73-10390-03', `Model number                    : ${p.pid}`, `System serial number            : ${this.serial}`, '',
          'Switch Ports Model              SW Version            SW Image                 ', '------ ----- -----              ----------            ----------               ', ...p.switchTable(p));
      }
      out.push('');
    }
    if (reg) out.push('', reg);
    return out;
  }

  #showVlanBrief() {
    const head = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
    const ports = new Map();
    for (const [n, i] of this.cfg.interfaces) {
      if (!i.physical || n.startsWith('Vlan') || n === 'GigabitEthernet0/0') continue;
      if (i.lines.includes('no switchport') || i.lines.includes('switchport mode trunk')) continue;
      const id = Number((i.lines.find((l) => l.startsWith('switchport access vlan ')) || 'x x x 1').split(' ')[3]);
      if (!ports.has(id)) ports.set(id, []);
      ports.get(id).push(shortIf(n));
    }
    const rows = [];
    for (const [id, v] of [...this.vlans].sort((a, b) => a[0] - b[0])) {
      const list = ports.get(id) || [];
      const chunks = [];
      for (let i = 0; i < list.length; i += 4) chunks.push(list.slice(i, i + 4).join(', '));
      rows.push(`${String(id).padEnd(5)}${v.name.padEnd(33)}${v.status.padEnd(10)}${chunks[0] || ''}`.trimEnd());
      for (const c of chunks.slice(1)) rows.push(`${' '.repeat(48)}${c}`);
    }
    return [...head, ...rows];
  }

  /** 12.2SE layout, or the 15.x / IOS XE one (VTP version 3 capable) */
  #showVtpStatus() {
    const v = this.vtp;
    const p = this.profile;
    const on = (b) => (b ? 'Enabled' : 'Disabled');
    const mode = v.mode[0].toUpperCase() + v.mode.slice(1);
    const pad = (k, n = 32) => `${k.padEnd(n)}: `;
    if (p.family === 'ios' && /^12\./.test(p.version)) {
      return [`${pad('VTP Version')}running VTP${v.version} (VTP2 capable)`, `${pad('Configuration Revision')}${v.mode === 'transparent' ? 0 : v.revision}`,
        `${pad('Maximum VLANs supported locally')}1005`, `${pad('Number of existing VLANs')}${this.vlans.size}`, `${pad('VTP Operating Mode')}${mode}`,
        `${pad('VTP Domain Name')}${v.domain}`, `${pad('VTP Pruning Mode')}${on(v.pruning)}`, `${pad('VTP V2 Mode')}${on(v.version >= 2)}`, `${pad('VTP Traps Generation')}Disabled`,
        `${pad('MD5 digest')}0x57 0xCD 0x40 0x65 0x63 0x59 0x47 0xBD`, 'Configuration last modified by 0.0.0.0 at 0-0-00 00:00:00', 'Local updater ID is 0.0.0.0 (no valid interface found)'];
    }
    return [`${pad('VTP Version capable')}1 to 3`, `${pad('VTP version running')}${v.version}`, `${pad('VTP Domain Name')}${v.domain}`, `${pad('VTP Pruning Mode')}${on(v.pruning)}`,
      `${pad('VTP Traps Generation')}Disabled`, `${pad('Device ID')}001a.2b3c.4d00`, 'Configuration last modified by 0.0.0.0 at 0-0-00 00:00:00',
      'Local updater ID is 0.0.0.0 (no valid interface found)', '', 'Feature VLAN:', '--------------', `${pad('VTP Operating Mode', 34)}${mode}`,
      `${pad('Maximum VLANs supported locally', 34)}1005`, `${pad('Number of existing VLANs', 34)}${this.vlans.size}`, `${pad('Configuration Revision', 34)}${v.mode === 'transparent' ? 0 : v.revision}`,
      `${pad('MD5 digest', 34)}0x57 0xCD 0x40 0x65 0x63 0x59 0x47 0xBD`];
  }

  #showCdp() {
    const xe = this.profile.family === 'iosxe';
    const out = [];
    for (const n of this.cdp) {
      out.push('-------------------------', `Device ID: ${n.deviceId}`, 'Entry address(es): ', `  IP address: ${n.ip}`, `Platform: cisco ${n.platform},  Capabilities: ${n.capabilities || 'Router Switch IGMP'} `,
        `Interface: ${n.localInterface},  Port ID (outgoing port): ${n.remoteInterface}`, 'Holdtime : 152 sec', '', 'Version :', ...(n.version || 'Cisco IOS Software').split('\n'), '',
        'advertisement version: 2', 'VTP Management Domain: \'\'', `Native VLAN: ${n.nativeVlan ?? 1}`, 'Duplex: full', 'Management address(es): ', `  IP address: ${n.ip}`, '');
    }
    if (xe) out.push('', `Total cdp entries displayed : ${this.cdp.length}`);
    return out;
  }

  #showIpIntBrief() {
    const rows = ['Interface              IP-Address      OK? Method Status                Protocol'];
    for (const [n, i] of this.cfg.interfaces) {
      const ip = (i.lines.find((l) => l.startsWith('ip address ')) || '').split(' ')[2] || 'unassigned';
      const status = i.shutdown ? 'administratively down' : 'up';
      rows.push(`${n.padEnd(23)}${ip.padEnd(16)}YES ${ip === 'unassigned' ? 'unset ' : 'manual'} ${status.padEnd(22)}${i.shutdown ? 'down' : 'up'}`);
    }
    return rows;
  }

  #dir() {
    const p = this.profile;
    const rows = [`Directory of ${p.family === 'iosxe' && p.kind === 'router' ? 'bootflash' : 'flash'}:/`, ''];
    rows.push(`    1  -rwx    33591768   Mar 1 1993 00:02:11 +00:00  ${p.image.split(/[:/]/).at(-1)}`);
    if (this.vlanFile) rows.push('    2  -rwx         736   Mar 1 1993 00:05:42 +00:00  vlan.dat');
    for (const name of this.#configFiles()) rows.push(`    3  -rwx        1919   Mar 1 1993 00:07:12 +00:00  ${name}`);
    rows.push('', '32514048 bytes total (11552256 bytes free)');
    this.#page(rows);
  }

  /** The startup-config of a classic switch is the file flash:config.text: its name, and a renamed one */
  #configFiles() {
    if (!this.#configInFlash()) return [];
    return [...(this.startup ? ['config.text'] : []), ...(this.parked ? [this.parked.name] : [])];
  }
  #configInFlash() { return this.profile.kind === 'switch' && this.profile.family === 'ios' && !this.profile.generic; }

  /** rename flash:<from> flash:<to>, of the configuration files only (in IOS and in the boot loader) → an error text or null */
  #renameFile(from, to) {
    const name = (s) => (s || '').replace(/^flash:\/?/i, '');
    const [a, b] = [name(from), name(to)];
    if (!a || !b || !/^[\w.-]+$/.test(a) || !/^[\w.-]+$/.test(b) || !this.#configInFlash()) return 'No such file or directory';
    if (this.#configFiles().includes(b) || b === 'vlan.dat') return 'File exists';
    if (a === 'config.text' && this.startup) { this.parked = { name: b, cfg: this.startup }; this.startup = null; return null; }
    if (this.parked && a === this.parked.name && b === 'config.text') { this.startup = this.parked.cfg; this.parked = null; return null; }
    return 'No such file or directory';
  }
  #rename(args) {
    if (args.length < 2) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
    const to = args[1].replace(/^flash:\/?/i, '');
    this.state = 'question';
    this.onAnswer = (answer) => {
      const err = this.#renameFile(args[0], answer || to);
      if (err) this.#say(`%Error renaming ${args[0]} (${err})`);
      this.#prompt();
    };
    this.out(`\r\nDestination filename [${to}]? `);
  }

  #ping(args, raw) {
    const target = args[0];
    if (!target) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
    if (!isIp(target)) { this.#say('% Unrecognized host or address, or protocol not running.\r\n'); return this.#prompt(); }
    const repeat = Math.min(Number(args[args.indexOf('repeat') + 1]) || 5, 100);
    if (args.includes('repeat') && !/^\d+$/.test(args[args.indexOf('repeat') + 1] || '')) return this.#invalid(raw, args.indexOf('repeat') + 2);
    const mine = [...this.cfg.interfaces.values()].filter((i) => !i.shutdown).map((i) => (i.lines.find((l) => /^ip address \S+ \S+$/.test(l)) || '').split(' ').slice(2)).filter((a) => a.length === 2);
    const own = mine.some(([ip]) => ip === target);
    const connected = mine.some(([ip, mask]) => ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(target) & ipToInt(mask)) >>> 0));
    const reachable = own || (connected && (this.reachable ? this.reachable(target) : true));
    const marks = reachable ? (own ? '!'.repeat(repeat) : `.${'!'.repeat(repeat - 1)}`) : '.'.repeat(repeat);
    const ok = [...marks].filter((c) => c === '!').length;
    this.#say(`Type escape sequence to abort.\nSending ${repeat}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`);
    this.state = 'booting';
    this.#later(reachable ? 400 : repeat * 2 * SECOND, () => {
      this.state = 'exec';
      this.out(`\r\n${marks}\r\nSuccess rate is ${Math.floor((ok * 100) / repeat)} percent (${ok}/${repeat})${ok ? ', round-trip min/avg/max = 1/2/4 ms' : ''}`);
      this.#prompt();
    });
  }

  // ── running-config ────────────────────────────────────────────────────────
  #factoryConfig(hostname) {
    const p = this.profile;
    const cfg = {
      hostname,
      global: p.global(this).map((l) => (this.stamps === 'uptime' ? l.replace(/^service timestamps (debug|log) datetime msec$/, 'service timestamps $1 uptime') : l)),
      blocks: [...p.blocks(this), ...p.lines.map(([head, lines]) => ({ head, lines: [...lines] }))],
      interfaces: new Map(p.interfaces.map(([n, shut, defaults]) => [n, { lines: [...defaults], shutdown: shut, physical: true }])),
    };
    return structuredClone(cfg);
  }

  #runningConfig() { return this.#renderConfig(this.cfg, { header: true }); }

  /**
   * IOS order: version, service, hostname, boot markers, vrf, enable, aaa,
   * other globals, crypto pki, license, username, spanning-tree, vlans (VTP
   * transparent only), interfaces, routing, ip http / routes / access lists,
   * control-plane, banners, lines, end. "!" separates the groups.
   */
  #renderConfig(cfg, { header }) {
    const p = this.profile;
    const items = [];
    const add = (rank, lines, own = false) => items.push({ rank, lines, own, n: items.length });
    for (const l of cfg.global) add(globalRank(l), l.split('\n'));
    for (const b of cfg.blocks) add(blockRank(b.head), [b.head, ...b.lines.map((l) => ` ${l}`)], !/^(line |crypto pki certificate)/.test(b.head));
    // VTP settings and VLANs are in vlan.dat; show run lists them only in transparent (or off) mode
    if (p.kind === 'switch' && (this.vtp.mode === 'transparent' || this.vtp.mode === 'off')) {
      add(42, [...(this.vtp.domain ? [`vtp domain ${this.vtp.domain}`] : []), `vtp mode ${this.vtp.mode}`]);
      for (const [id, v] of this.vlans) {
        if (id === 1 || (id >= 1002 && id <= 1005)) continue;
        add(46, [`vlan ${id}`, ...(v.name === `VLAN${String(id).padStart(4, '0')}` ? [] : [` name ${v.name}`]), ...(/^sus/.test(v.status) ? [' state suspend'] : []),
          ...(/\/lshut$/.test(v.status) ? [' shutdown'] : [])], true);
      }
    }
    for (const [name, i] of [...cfg.interfaces].sort(([a], [b]) => this.#ifOrder(a) - this.#ifOrder(b))) {
      const lines = [...i.lines];
      if (i.shutdown) lines.push('shutdown');
      lines.sort((a, b) => ifLineRank(a) - ifLineRank(b));
      add(50, [`interface ${name}`, ...lines.map((l) => ` ${l}`)], true);
    }
    items.sort((a, b) => a.rank - b.rank || a.n - b.n);

    // One section per rank (blocks and interfaces on their own), "!" between sections
    const sections = [];
    for (const it of items) {
      const prev = sections.at(-1);
      if (prev && !it.own && !prev.own && prev.rank === it.rank) prev.lines.push(...it.lines);
      else sections.push({ rank: it.rank, own: it.own, lines: [...it.lines] });
    }
    const head = sections.filter((s) => s.rank < 20);
    const body = sections.filter((s) => s.rank >= 20 && s.rank !== 21);
    const boot = sections.filter((s) => s.rank === 21).flatMap((s) => s.lines);
    const out = [`version ${p.runVersion}`, ...head.flatMap((s) => s.lines), '!', `hostname ${cfg.hostname}`, '!', 'boot-start-marker', ...boot, 'boot-end-marker', '!'];
    for (const s of body) out.push(...s.lines, '!');
    out.push('end');
    if (!header) return out;
    const comments = [];
    if (this.changedAt) comments.push(`! Last configuration change at ${this.#clockText(this.#clock(this.changedAt))}`);
    if (this.savedAt) comments.push(`! NVRAM config last updated at ${this.#clockText(this.#clock(this.savedAt))}`);
    const text = [...(comments.length ? [...comments, '!'] : []), ...out];
    const bytes = text.join('\n').length + 1;
    return ['Building configuration...', '', `Current configuration : ${bytes} bytes`, '!', ...text];
  }

  /** IOS lists Loopback, Tunnel and Port-channel first, sub-interfaces after their parent, SVIs last */
  #ifOrder(name) {
    const types = ['Loopback', 'Tunnel', 'Port-channel'];
    const t = types.findIndex((x) => name.startsWith(x));
    const num = (s) => s.match(/\d+/g).reduce((a, n) => a * 1000 + Number(n), 0) / 1e12;
    if (t >= 0) return t + num(name);
    if (name.startsWith('Vlan')) return 1e6 + Number(name.slice(4));
    const [parent, sub] = name.split('.');
    const at = this.profile.interfaces.findIndex(([n]) => n === parent);
    return 10 + (at < 0 ? 5e5 : at) + (sub ? Number(sub) / 1e5 : 0);
  }

  // ── copy / save / erase / delete ──────────────────────────────────────────
  #copy(args, raw) {
    const [from, to] = args.map((a) => a.toLowerCase());
    const isRun = (s) => /^(running-config|run|system:running-config)/.test(s || '') || /^ru/.test(s || '');
    const isStart = (s) => /^(startup-config|start|nvram:startup-config)/.test(s || '') || /^sta/.test(s || '');
    if (isRun(from) && isStart(to)) {
      this.state = 'question';
      this.onAnswer = () => { this.#say('Building configuration...\r\n[OK]'); this.#save(); this.#prompt(); };
      return this.out('\r\nDestination filename [startup-config]? ');
    }
    if (isStart(from) && isRun(to)) {
      this.state = 'question';
      this.onAnswer = () => { if (this.startup) this.#merge(this.startup); this.#say(`${this.startup ? '1234' : '0'} bytes copied in 0.123 secs`); this.#prompt(); };
      return this.out('\r\nDestination filename [running-config]? ');
    }
    if (!from || !to) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
    return this.#invalid(raw, 1);
  }
  #save() {
    this.startup = structuredClone(this.cfg);
    this.dirty = false;
    this.savedAt = Date.now();
  }
  #merge(saved) {
    for (const l of saved.global) if (!this.cfg.global.includes(l)) this.cfg.global.push(l);
  }
  #eraseNvram() {
    this.#confirm('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', (ok) => {
      if (ok) {
        this.startup = null; this.savedAt = null; this.dirty = true;
        this.out('\r\n[OK]\r\nErase of nvram: complete');
        this.#prompt();
        this.#syslog('%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram');
        return;
      }
      this.#prompt();
    });
  }
  #delete(spec) {
    const m = spec.match(/^(?:\/force\s+)?(?:(flash|bootflash):\/?)?(\S+)$/i);
    if (!m) { this.#say('% Incomplete command.\r\n'); return this.#prompt(); }
    const dev = (m[1] || 'flash').toLowerCase();
    const file = m[2];
    const remove = (name) => {
      if (name === 'vlan.dat' && this.vlanFile && this.profile.kind === 'switch') {
        if (this.deleteError) { this.#say(`%Error deleting ${dev}:/${name} (${this.deleteError})`); return this.#prompt(); }
        this.vlanFile = null; this.vtpFile = null; return this.#prompt();
      }
      this.#say(`%Error deleting ${dev}:/${name} (No such file or directory)`);
      this.#prompt();
    };
    if (/^\/force\b/.test(spec)) return remove(file);
    this.state = 'question';
    this.onAnswer = (answer) => {
      const name = answer || file;
      this.#confirm(`Delete ${dev}:/${name}? [confirm]`, (ok) => (ok ? remove(name) : this.#prompt()));
    };
    this.out(`\r\nDelete filename [${file}]? `);
  }

  /** "[confirm]" reads ONE key: Enter or y confirms, anything else cancels */
  #confirm(text, then) {
    this.state = 'confirm';
    this.onConfirm = then;
    this.out(`\r\n${text}`);
  }
  #confirmKey(ch) {
    if (ch === '\n') return;
    this.state = 'exec';
    const ok = ch === '\r' || ch === 'y' || ch === 'Y';
    const fn = this.onConfirm;
    this.onConfirm = null;
    fn(ok);
  }

  // ── reload and boot ───────────────────────────────────────────────────────
  #reload() {
    const proceed = () => {
      if (this.profile.stack) this.out('\r\nReload command is being issued on Active unit, this will reload the whole stack');
      this.#confirm('Proceed with reload? [confirm]', (ok) => {
        if (!ok) return this.#prompt();
        this.out('\r\n');
        this.#syslog('%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.');
        this.#boot();
      });
    };
    if (!this.dirty) return proceed();
    const ask = () => {
      this.state = 'question';
      this.onAnswer = (a) => {
        if (/^y(es?)?$/i.test(a)) { this.#say('Building configuration...\r\n[OK]'); this.#save(); return proceed(); }
        if (/^no?$/i.test(a)) return proceed();
        this.out("\r\n% Please answer 'yes' or 'no'.");
        ask();
      };
      this.out('\r\nSystem configuration has been modified. Save? [yes/no]: ');
    };
    ask();
  }

  #clearBoot() { for (const t of this.bootTimers || []) { clearTimeout(t); this.timers.delete(t); } this.bootTimers = []; this.inBoot = false; }

  #boot() {
    this.#clearBoot();
    this.inBoot = true;
    this.state = 'booting';
    this.mode = '>';
    this.line = '';
    this.termLength = 24;
    const lines = this.#bootChatter();
    const total = this.profile.bootS * SECOND;
    const stallAt = Math.floor(lines.length * 0.6);
    lines.forEach((text, i) => {
      if (this.bootFailure === 'stall' && i >= stallAt) return;
      this.bootTimers.push(this.#later((total * (i + 1)) / (lines.length + 1), () => this.out(`\r\n${text}`)));
    });
    if (this.bootFailure === 'stall') return;
    this.bootTimers.push(this.#later(total, () => this.#booted()));
  }

  #booted() {
    this.inBoot = false;
    this.bootedAt = Date.now();
    if (this.nextConfReg) { this.confReg = this.nextConfReg; this.nextConfReg = null; }
    if (this.bootFailure === 'rommon') return this.#toRommon('\r\n\r\nboot: cannot determine first file name on device "flash:"');
    const p = this.profile;
    this.vlans = this.vlanFile ? new Map(structuredClone(this.vlanFile)) : this.#defaultVlans();
    this.vtp = this.vtpFile ? { ...this.vtpFile } : defaultVtp();
    const ignoreStartup = this.confReg === '0x2141' || this.confReg === '0x2142' || this.romvars.SWITCH_IGNORE_STARTUP_CFG === '1';
    if (this.startup && !ignoreStartup) {
      this.cfg = structuredClone(this.startup);
      this.dirty = false; this.changedAt = null;
      this.out('\r\n\r\n\r\nPress RETURN to get started!\r\n\r\n');
      this.state = 'pressreturn'; this.readyAt = Date.now() + p.readyS * SECOND * this.timeScale;
      this.#later(p.readyS * SECOND, () => { this.#syslog(this.#restartMessage()); this.#bootReady(); });
      return;
    }
    this.cfg = this.#factoryConfig(p.kind === 'router' ? 'Router' : 'Switch');
    if (p.kind === 'switch' && !this.vlanFile) this.vlans = this.#defaultVlans();
    this.dirty = false; this.changedAt = null; this.savedAt = null;
    this.firstBoot = [...p.firstBoot];
    if (p.pnp) {
      this.out('\r\n\r\n%PNP-6-PNP_DISCOVERY_STARTED: PnP Discovery started\r\nAutoinstall will terminate if any input was detected on console');
      this.#startPnp();
    }
    this.firstBoot.shift();
    this.state = 'dialog';
    this.#askDialog();
  }
  #bootReady() {
    if (this.state !== 'pressreturn') return;
    if (this.enterPending) { this.enterPending = false; this.readyAt = 0; this.#startExec(); }
  }
  #toRommon(msg) {
    this.state = this.profile.kind === 'switch' ? 'bootloader' : 'rommon';
    this.rommonN = 1;
    this.out(msg);
    this.out(this.state === 'rommon' ? '\r\n\r\nrommon 1 > ' : '\r\n\r\nswitch: ');
  }
  #monitorKey(ch) {
    if (ch !== '\r') { if (ch >= ' ') { this.line += ch; this.out(ch); } return; }
    const cmd = this.line.trim(); this.line = '';
    if (this.state === 'bootloader') return this.#bootLoaderCommand(cmd);
    if (/^(boot|reset)$/.test(cmd)) return this.#boot();
    const m = cmd.match(/^confreg (0x[0-9a-f]+)$/i);
    if (m) { this.nextConfReg = m[1]; this.out('\r\n\r\nYou must reset or power cycle for new config to take effect'); }
    else if (cmd) this.out(`\r\nmonitor: command "${cmd.split(' ')[0]}" not found`);
    this.rommonN++; this.out(`\r\nrommon ${this.rommonN} > `);
  }

  /** switch: — the boot loader of a Catalyst */
  #bootLoaderCommand(cmd) {
    const prompt = () => { this.state = 'bootloader'; this.out('\r\nswitch: '); };
    const classic = this.profile.family === 'ios';
    if (/^(boot|reset)(\s|$)/.test(cmd)) { this.flashReady = true; return this.#boot(); }
    if (cmd === 'flash_init') {
      if (!classic) { this.out(`\r\nunknown cmd: ${cmd}`); return prompt(); }
      if (this.flashReady) { this.out('\r\nflash is already initialized'); return prompt(); }
      this.state = 'blbusy';
      this.out('\r\nInitializing Flash...');
      return this.#later(10 * SECOND, () => {
        this.flashReady = true;
        this.out('\r\nflashfs[0]: 600 files, 19 directories\r\nflashfs[0]: 0 orphaned files, 0 orphaned directories\r\nflashfs[0]: Total bytes: 32514048\r\nflashfs[0]: Bytes used: 20961792\r\nflashfs[0]: Bytes available: 11552256\r\nflashfs[0]: flashfs fsck took 10 seconds.\r\n...done Initializing Flash.');
        prompt();
      });
    }
    if (cmd === 'load_helper') return prompt();
    const dir = cmd.match(/^dir\s+flash:\/?$/i);
    if (dir) {
      if (!this.flashReady) { this.out('\r\nThe flash filesystem is not initialized: run flash_init first'); return prompt(); }
      const rows = ['Directory of flash:/', '', `    2  -rwx  33591768  <date>               ${this.profile.image.split(/[:/]/).at(-1)}`];
      if (this.vlanFile) rows.push('    3  -rwx  736       <date>               vlan.dat');
      for (const name of this.#configFiles()) rows.push(`    4  -rwx  1919      <date>               ${name}`);
      rows.push('', '11552256 bytes available (20961792 bytes used)');
      this.out(rows.map((l) => `\r\n${l}`).join(''));
      return prompt();
    }
    const ren = cmd.match(/^rename\s+(\S+)\s+(\S+)$/i);
    if (ren) {
      if (!this.flashReady) { this.out('\r\nThe flash filesystem is not initialized: run flash_init first'); return prompt(); }
      const err = this.#renameFile(ren[1], ren[2]);
      if (err) this.out(`\r\nUnable to rename ${ren[1]} to ${ren[2]}: ${err}`);
      return prompt();
    }
    const v = cmd.match(/^(?:set\s+)?(SWITCH_IGNORE_STARTUP_CFG)(?:=|\s+)([01])$/);
    if (v && !classic) { this.romvars[v[1]] = v[2]; return prompt(); }
    if (cmd === 'set') { this.out(Object.entries({ BOOT: this.profile.image, ...this.romvars }).map(([k, x]) => `\r\n${k}=${x}`).join('')); return prompt(); }
    if (cmd) this.out(`\r\nunknown cmd: ${cmd.split(' ')[0]}`);
    return prompt();
  }

  // ── first boot: initial configuration dialog, autoinstall, PnP ───────────
  #askDialog() {
    this.out('\r\n\r\n         --- System Configuration Dialog ---\r\n\r\nWould you like to enter the initial configuration dialog? [yes/no]: ');
  }
  #dialogAnswer(line) {
    const a = line.trim().toLowerCase();
    if (a === 'yes' || a === 'y') {
      this.out("\r\n\r\nAt any point you may enter a question mark '?' for help.\r\nUse ctrl-c to abort configuration dialog at any prompt.\r\nDefault settings are in square brackets '[]'.\r\n\r\n");
      this.out('Basic management setup configures only enough connectivity\r\nfor management of the system, extended setup will ask you\r\nto configure each interface on the system\r\n\r\nWould you like to enter basic management setup? [yes/no]: ');
      this.state = 'setup';
      return;
    }
    if (a !== 'no' && a !== 'n') { this.out("\r\n% Please answer 'yes' or 'no'.\r\nWould you like to enter the initial configuration dialog? [yes/no]: "); return; }
    this.#dialogDone();
  }
  #dialogDone(prefix = '') {
    if (prefix) this.out(prefix);
    const next = this.firstBoot?.shift();
    if (next === 'autoinstall') { this.state = 'autoinstall'; this.out('\r\n\r\nWould you like to terminate autoinstall? [yes]: '); return; }
    if (this.firstBootExtra && !this.extraAsked) { this.extraAsked = true; this.state = 'extra'; this.out(`\r\n\r\n${this.firstBootExtra}`); return; }
    if (this.pnpRunning) {
      this.pnpRunning = false;
      this.#later(2 * SECOND, () => this.#syslog('%PNP-6-PNP_TECH_SUMMARY_SAVED_OK: PnP tech summary (pnp-tech-discovery-summary) saved successfully (elapsed time: 12 seconds).'));
      this.#later(3 * SECOND, () => this.#syslog('%PNP-6-PNP_DISCOVERY_STOPPED: PnP Discovery stopped (Config Wizard)'));
    }
    this.state = 'pressreturn';
    this.readyAt = Date.now() + this.profile.readyS * SECOND * this.timeScale;
    this.out('\r\n\r\n\r\nPress RETURN to get started!\r\n\r\n\r\n');
    this.#later(this.profile.readyS * SECOND, () => this.#bootReady());
    // Classic IOS: the restart message, on several lines, lands a moment later (after the prompt if Enter was pressed)
    if (this.profile.family === 'ios' && !this.profile.generic) this.#later(this.profile.readyS * SECOND * 1.2, () => this.#syslog(this.#restartMessage()));
  }

  /** %SYS-5-RESTART and the lines that belong to it, as classic IOS prints them */
  #restartMessage() {
    const p = this.profile;
    if (p.family !== 'ios' || p.generic) return '%SYS-5-RESTART: System restarted --';
    return ['%SYS-5-RESTART: System restarted --', `Cisco IOS Software, ${p.iosLine}`, 'Technical Support: http://www.cisco.com/techsupport',
      'Copyright (c) 1986-2012 by Cisco Systems, Inc.', 'Compiled Sat 28-Jul-12 00:29 by prod_rel_team'].join('\r\n');
  }
  #autoinstallAnswer(line) {
    const a = line.trim().toLowerCase();
    if (a !== '' && !/^(y|yes|n|no)$/.test(a)) { this.out("\r\n% Please answer 'yes' or 'no'.\r\nWould you like to terminate autoinstall? [yes]: "); return; }
    this.#dialogDone();
  }
  #extraAnswer() { this.#dialogDone(); }
  #startPnp() {
    this.pnpRunning = true;
    const pnpLines = [
      '%SYS-5-CONFIG_P: Configured programmatically by process PnP Agent Discovery from console as vty0',
      `%PNP-6-PNP_SUDI_UPDATE: Device SUDI [PID:${this.profile.pid},SN:${this.serial}] identified`,
    ];
    // Right after the question (the real C9300L printed them below it), then periodically
    setImmediate(() => { if (this.pnpRunning) for (const l of pnpLines) this.#rawSyslog(l); });
    let i = 0;
    const t = setInterval(() => {
      if (!this.pnpRunning) { clearInterval(t); this.timers.delete(t); return; }
      if (this.state === 'dialog' || this.state === 'autoinstall') this.#rawSyslog(pnpLines[i++ % pnpLines.length]);
    }, this.pnpEveryMs);
    t.unref?.();
    this.timers.add(t);
  }
  #rawSyslog(msg) { this.out(`\r\n${this.#stamp()}: ${msg}`); }

  #bootChatter() {
    const p = this.profile;
    if (p.family === 'iosxe') {
      return [
        'Initializing Hardware ...', '', 'System integrity status: 0x610', 'Rom image verified correctly', '',
        p.kind === 'router' ? 'System Bootstrap, Version 16.12(2r), RELEASE SOFTWARE' : 'System Bootstrap, Version 17.8.1r[FC2], RELEASE SOFTWARE (P)',
        'Copyright (c) 1994-2022  by cisco Systems, Inc.', '', `Current image running: Boot ROM1`, `Last reset cause: LocalSoft`, `${p.pid} platform with 8388608 Kbytes of main memory`, '',
        `boot: attempting to boot from [${p.image}]`, `boot: reading file ${p.image.split(':')[1]}`, '#'.repeat(78), '#'.repeat(78), '',
        '%IOSXEBOOT-4-BOOT_ACTIVITY_LONG_TIME: (local/local): load_modules took: 2 seconds, expected max time 2 seconds', '',
        '              Restricted Rights Legend', '', 'Use, duplication, or disclosure by the Government is', 'subject to restrictions as set forth in subparagraph', '',
        `Cisco IOS XE Software, Version ${p.version}`, `Cisco IOS Software [${p.train}], ${p.iosLine}`, '', p.hw, `Processor board ID ${this.serial}`, ...p.counts, '',
        '%IOSXE-5-PLATFORM: R0/0: udev: disk0: has been inserted',
        '%SPANTREE-5-EXTENDED_SYSID: Extended SysId enabled for type vlan',
        '%SYS-5-RESTART: System restarted --', `Cisco IOS Software [${p.train}], ${p.iosLine}`,
      ];
    }
    if (p.kind === 'router') {
      return [
        'System Bootstrap, Version 12.4(13r)T, RELEASE SOFTWARE (fc1)', 'Technical Support: http://www.cisco.com/techsupport', 'Copyright (c) 2006 by cisco Systems, Inc.',
        `c${p.pid} platform with 262144 Kbytes of main memory`, 'Main memory is configured to 64 bit mode with parity disabled', '', 'Readonly ROMMON initialized',
        'program load complete, entry point: 0x8000f000, size: 0xcb80', '', 'program load complete, entry point: 0x8000f000, size: 0x2bb1c58',
        `Self decompressing the image : ${'#'.repeat(60)}`, `${'#'.repeat(40)} [OK]`, '', '              Restricted Rights Legend', '',
        'Use, duplication, or disclosure by the Government is', 'subject to restrictions as set forth in subparagraph', '',
        `Cisco IOS Software, ${p.iosLine}`, 'Technical Support: http://www.cisco.com/techsupport', '', p.hw, `Processor board ID ${this.serial}`, ...p.counts, '',
      ];
    }
    return [
      'Using driver version 1 for media type 1', 'Base ethernet MAC Address: 00:1a:2b:3c:4d:00', 'Xmodem file system is available.', 'The password-recovery mechanism is enabled.',
      'Initializing Flash...', 'flashfs[0]: 600 files, 19 directories', 'flashfs[0]: 0 orphaned files, 0 orphaned directories', 'done.', 'Loading "' + p.image + '"...' + '@'.repeat(50),
      `File "${p.image}" uncompressed and installed, entry point: 0x3000`, 'executing...', '', '              Restricted Rights Legend', '',
      'POST: CPU MIC register Tests : Begin', 'POST: CPU MIC register Tests : End, Status Passed', 'POST: PortASIC Memory Tests : Begin', 'POST: PortASIC Memory Tests : End, Status Passed',
      'Waiting for Port download...Complete', '', `Cisco IOS Software, ${p.iosLine}`, '', p.hw, ...p.counts, '',
    ];
  }

  #chatterLine() {
    const n = this.chatterN = (this.chatterN || 0) + 1;
    return n % 2 ? '%SMART_LIC-6-AGENT_READY: Smart Agent for Licensing is initialized' : '%PKI-6-CERT_RENEW_AUTO: Auto renewing router certificate';
  }

  // ── pager ─────────────────────────────────────────────────────────────────
  /** Prints lines, pausing on " --More-- " every (terminal length - 1) lines */
  #page(lines) {
    this.pending = [...lines];
    this.pagedOnce = false;
    this.#flushPage(this.termLength > 0 ? this.termLength - 1 : Infinity);
  }
  #flushPage(n, continuation = false) {
    const chunk = this.pending.splice(0, n);
    // After " --More-- " is erased, IOS writes the next line right where the marker was
    this.out(chunk.map((l, i) => (i === 0 && continuation ? l : `\r\n${l}`)).join(''));
    if (this.pending.length) {
      this.state = 'more';
      this.out('\r\n --More-- ');
      // The C9300L was seen printing syslog lines right after the marker
      if (!this.pagedOnce && this.syslogOnMore) for (let i = 0; i < this.syslogOnMore; i++) this.#rawSyslog(`%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/${i + 1}, changed state to down`);
      this.pagedOnce = true;
    } else { this.state = 'exec'; this.#prompt(); }
  }
  #moreKey(ch) {
    this.out('\b'.repeat(10) + ' '.repeat(10) + '\b'.repeat(10)); // IOS erases the marker in place
    if (ch === ' ') return this.#flushPage(this.termLength - 1, true);
    if (ch === '\r') return this.#flushPage(1, true);
    this.pending = []; this.state = 'exec'; this.#prompt();
  }
}
