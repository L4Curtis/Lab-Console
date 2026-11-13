/**
 * The Cisco IOS driver against the simulator: every starting state of
 * prepare(), the enable secret, reads through a pager, the slow console.
 * Erase and reload are in iosReset.test.js.
 * Output and input go through setImmediate to behave like a network stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyScreen, parseShowVersion, REASONS, reasonText } from '../src/lib/drivers/ciscoIos.js';
import { isSyslogLine, patterns } from '../src/lib/cliAutomation.js';
import { repoRoot } from './helpers/app.js';
import { rig } from './helpers/ios.js';

// ── prepare(): starting states ──────────────────────────────────────────────

test('prepare: user EXEC → enable → privileged', async () => {
  const { dev, ios, done } = rig({ model: '2811' });
  const r = await ios.prepare();
  done();
  assert.equal(r.ok, true);
  assert.equal(r.hostname, 'R1');
  assert.equal(r.startState, 'user');
  assert.deepEqual(r.steps, ['wake', 'enable']);
  assert.equal(dev.mode, '#');
  assert.equal(ios.hostname, 'R1');
});

test('prepare: already privileged, or in configuration mode (left with "end")', async () => {
  const a = rig({ model: 'isr4331', start: 'privileged' });
  const r = await a.ios.prepare();
  a.done();
  assert.deepEqual([r.ok, r.startState, r.steps], [true, 'privileged', ['wake']]);

  const b = rig({ model: '2960', start: 'privileged' });
  b.dev.mode = 'config';
  const c = await b.ios.prepare();
  b.done();
  assert.equal(c.ok, true);
  assert.equal(c.startState, 'config');
  assert.deepEqual(c.steps, ['wake', 'end']);
});

test('prepare: exec not started ("Press RETURN" long ago) wakes with one Enter', async () => {
  const { ios, done } = rig({ model: 'c1000', start: 'idle' });
  const r = await ios.prepare();
  done();
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps, ['wake', 'enable']);
});

test('prepare: a pager left on screen is quit with q, without pressing Enter first', async () => {
  const { dev, ios, done, written } = rig({ model: '2960', start: 'privileged' });
  dev.input('show running-config\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dev.state, 'more');
  const r = await ios.prepare({ screen: 'S1#show running-config\nBuilding configuration...\n!\n --More-- ' });
  done();
  assert.equal(r.ok, true);
  assert.equal(r.startState, 'more');
  assert.equal(r.steps[0], 'quit-pager');
  assert.equal(written()[0], 'q');
});

test('prepare: classic switch at the initial configuration dialog → no, autoinstall default, Router prompt', async () => {
  const { dev, ios, done } = rig({ model: '2960', start: 'dialog' });
  const r = await ios.prepare();
  done();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.hostname, 'Switch');
  assert.equal(r.startState, 'dialog');
  // The wake Enter makes IOS ask again ("% Please answer 'yes' or 'no'."), then "no", then autoinstall
  assert.deepEqual(r.steps, ['wake', 'dialog-no', 'autoinstall-default', 'return', 'enable']);
  assert.equal(dev.startup, null, 'nothing was saved');
});

test('prepare: IOS XE dialog with Plug-and-Play lines printed under the question', async () => {
  const { ios, done } = rig({ model: 'c9300l', start: 'dialog', pnpEveryMs: 60 });
  const r = await ios.prepare();
  done();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.hostname, 'Switch');
  assert.ok(r.steps.includes('dialog-no'));
});

test('prepare: a console line password from the candidates, never more than three tries', async () => {
  const right = rig({ model: '2811', start: 'linepass', linePassword: 'cisco' });
  const r = await right.ios.prepare({ linePasswords: ['cisco'] });
  right.done();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.startState, 'password');
  assert.ok(r.steps.includes('line-password'));
  assert.ok(!right.written().includes('cisco\rcisco'), 'the password is not typed twice');

  const wrong = rig({ model: '2811', start: 'linepass', linePassword: 'cisco' });
  const w = await wrong.ios.prepare({ linePasswords: ['a', 'b', 'c', 'd', 'e'] });
  wrong.done();
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'ios.line_password');
  assert.equal(w.steps.filter((s) => s === 'line-password').length, 3);
  assert.ok(!wrong.written().includes('d\r'), 'the fourth candidate is never typed');

  const none = rig({ model: 'isr4331', start: 'linepass', linePassword: 'secret' });
  const n = await none.ios.prepare();
  none.done();
  assert.equal(n.reason, 'ios.line_password');
  assert.deepEqual(n.steps, ['wake'], 'nothing but the wake-up Enter was typed');
  assert.match(n.message, /on site/);
});

test('prepare: a device asking for a username is reported, not guessed', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'idle' });
  dev.configure(['username admin secret s3cret', 'line con 0', 'login local']);
  const r = await ios.prepare({ enablePasswords: ['s3cret'], linePasswords: ['s3cret'] });
  done();
  assert.equal(r.reason, 'ios.login_required');
});

test('prepare: ROMMON and the boot loader are reported without typing into them', async () => {
  const a = rig({ model: '2811', start: 'rommon' });
  const r = await a.ios.prepare({ screen: 'System Bootstrap, Version 12.4(13r)T\n\nrommon 1 > ' });
  a.done();
  assert.equal(r.reason, 'ios.rommon');
  assert.equal(a.written(), '', 'nothing typed when the screen already shows ROMMON');

  const b = rig({ model: '2960', start: 'rommon' });
  const s = await b.ios.prepare();
  b.done();
  assert.equal(s.reason, 'ios.boot_loader');
  assert.equal(b.written(), '\r', 'only the wake-up Enter, before anything was known');
  assert.match(s.lastOutput, /switch: $/);
});

test('prepare: a booting device is left alone', async () => {
  // Boot lines every ~350 ms: never quiet for a second
  const a = rig({ model: '2811', start: 'booting', timeScale: 0.05, timeouts: { quietMs: 1000, observeMs: 2000 } });
  const r = await a.ios.prepare();
  a.done();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ios.booting');
  assert.equal(a.written(), '');
  assert.match(r.lastOutput, /System Bootstrap/);

  // Quiet for a moment, but the screen shows a boot in progress
  const b = rig({ model: '2811', start: 'booting', timeScale: 1 });
  const s = await b.ios.prepare({ screen: 'Readonly ROMMON initialized\nprogram load complete, entry point: 0x8000f000, size: 0xcb80\nSelf decompressing the image : #####' });
  b.done();
  assert.equal(s.reason, 'ios.booting');
  assert.equal(b.written(), '');
});

test('prepare: a silent device gets three Enters, then "check power and cable"', async () => {
  const { ios, done, written } = rig({ model: '2811', start: 'silent' });
  const r = await ios.prepare();
  done();
  assert.equal(r.reason, 'ios.silent');
  assert.equal(written(), '\r\r\r');
  assert.match(r.message, /power and its console cable/);
});

test('prepare: a pending reload left on screen is cancelled, never confirmed', async () => {
  const { dev, ios, done } = rig({ model: '2960', start: 'privileged' });
  dev.configure(['hostname S7']);
  dev.input('reload\r');
  await new Promise((r) => setTimeout(r, 30));
  const r = await ios.prepare({ screen: 'S7#reload\nSystem configuration has been modified. Save? [yes/no]: ' });
  done();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.steps, ['save-no', 'confirm-cancel']);
  assert.equal(dev.state, 'exec', 'the device did not reload');
  assert.equal(dev.startup.hostname, 'R1', 'and nothing was saved');
});

test('prepare: an unknown question is reported with its text', async () => {
  const { ios, done } = rig({ model: '2811', start: 'privileged' });
  const r = await ios.prepare({ screen: 'R1#copy tftp: flash:\nAddress or name of remote host []? ' });
  done();
  assert.equal(r.reason, 'ios.unknown_question');
  assert.equal(r.params.question, 'Address or name of remote host []?');
});

// ── prepare(): enable ───────────────────────────────────────────────────────

test('enable: the right secret, after a wrong one', async () => {
  const { dev, ios, done } = rig({ model: 'isr4331', enableSecret: 'class' });
  const r = await ios.prepare({ enablePasswords: ['nope', 'class'] });
  done();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.steps, ['wake', 'enable', 'enable-password', 'enable-password']);
  assert.equal(dev.mode, '#');
});

test('enable: wrong secrets stop after three attempts ("% Bad secrets"), back at user EXEC', async () => {
  const { dev, ios, done, written } = rig({ model: '2811', enableSecret: 'class' });
  const r = await ios.prepare({ enablePasswords: ['a1', 'b2', 'c3', 'd4'] });
  done();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ios.enable_refused');
  assert.equal(r.params.attempts, 3);
  assert.equal(dev.mode, '>');
  assert.ok(!written().includes('d4'), 'the fourth candidate is never typed');
});

test('enable: no secret supplied → reported, the prompt is cleared without guessing', async () => {
  const { dev, ios, done, written } = rig({ model: '2960', enableSecret: 'class' });
  const r = await ios.prepare();
  done();
  assert.equal(r.reason, 'ios.enable_password_required');
  assert.equal(dev.mode, '>');
  assert.equal(dev.state, 'exec', 'left at the user prompt, not at "Password:"');
  assert.equal(written(), '\renable\r\r\r\r', 'three empty answers, no password');
});

test('enable: one wrong candidate only → refused after IOS gives up', async () => {
  const { ios, done } = rig({ model: '2960', enableSecret: 'class' });
  const r = await ios.prepare({ enablePasswords: ['wrong'] });
  done();
  assert.equal(r.reason, 'ios.enable_refused');
  assert.equal(r.params.attempts, 1);
});

// ── reading ─────────────────────────────────────────────────────────────────

test('identify: each family, model, software and configuration register', async () => {
  const expected = {
    2811: { family: 'ios', kind: 'router', model: '2811', version: '12.4(22)T', configRegister: '0x2102' },
    isr4331: { family: 'iosxe', kind: 'router', model: 'ISR4331/K9', version: '17.03.04a', configRegister: '0x2102' },
    3560: { family: 'ios', kind: 'switch', model: 'WS-C3560-24PS', version: '12.2(55)SE6', configRegister: '0xF' },
    c1000: { family: 'ios', kind: 'switch', model: 'C1000-24T-4G-L', version: '15.2(7)E6', configRegister: '0xF' },
    c9300l: { family: 'iosxe', kind: 'switch', model: 'C9300L-24T-4G', version: '17.06.04', configRegister: null },
  };
  for (const [model, want] of Object.entries(expected)) {
    const { ios, done } = rig({ model, start: 'privileged' });
    const r = await ios.identify();
    done();
    assert.equal(r.ok, true, `${model}: ${r.message}`);
    for (const [k, v] of Object.entries(want)) assert.equal(r[k], v, `${model}.${k}`);
    assert.equal(r.registerOk, true);
  }
});

test('identify: an 1841 left at 0x2141 is reported', async () => {
  const { ios, done } = rig({ model: '1841', start: 'privileged', confReg: '0x2141' });
  const r = await ios.identify();
  done();
  assert.equal(r.configRegister, '0x2141');
  assert.equal(r.registerOk, false);
  assert.deepEqual(r.warnings, ['register_unusual']);
});

test('identify: something that is not IOS is left untouched', () => {
  assert.equal(parseShowVersion('Linux router 6.1.0 #1 SMP x86_64 GNU/Linux').family, null);
  const asa = parseShowVersion('Cisco Adaptive Security Appliance Software Version 9.8(4)\nHardware:   ASA5506');
  assert.equal(asa.family, null);
});

test('runningConfig through a pager that cannot be turned off, on IOS XE with syslog after --More--', async () => {
  const ref = rig({ model: 'c9300l', start: 'privileged' });
  const a = await ref.ios.runningConfig();
  ref.done();
  assert.equal(a.ok, true, a.message);
  assert.equal(a.pagingFallback, false);

  const paged = rig({ model: 'c9300l', start: 'privileged', termLengthSupported: false });
  const b = await paged.ios.runningConfig();
  paged.done();
  assert.equal(b.ok, true, b.message);
  assert.equal(b.pagingFallback, true);
  const strip = (c) => c.replace(/^Current configuration.*\n/m, '');
  assert.equal(strip(b.config), strip(a.config), 'every line is there, none glued to a syslog line');
  assert.doesNotMatch(b.config, /--More--|%LINEPROTO/);
});

test('runningConfig in user EXEC is refused with a reason', async () => {
  const { ios, done } = rig({ model: '2811' });
  const r = await ios.runningConfig();
  done();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ios.export_failed');
  assert.match(r.params.detail, /user mode/);
});

test('vlans, interfaces, cdp neighbors and ping on the simulator', async () => {
  const cdp = [{ deviceId: 'R1', ip: '192.168.1.1', platform: 'Cisco 2811', capabilities: 'Router Switch IGMP', localInterface: 'FastEthernet0/24', remoteInterface: 'FastEthernet0/0' }];
  const { dev, ios, done } = rig({ model: '2960', start: 'privileged', cdp });
  dev.configure(['vlan 10', 'name ETUDIANTS', 'exit', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'interface Vlan1', 'ip address 192.168.1.2 255.255.255.0', 'no shutdown']);
  const v = await ios.vlans();
  assert.equal(v.ok, true, v.message);
  assert.deepEqual(v.vlans.filter((x) => x.id < 1000).map((x) => [x.id, x.name, x.ports.length]), [[1, 'default', 25], [10, 'ETUDIANTS', 1]]);
  const i = await ios.interfaces();
  assert.equal(i.interfaces.find((x) => x.name === 'Vlan1').ip, '192.168.1.2');
  assert.equal(i.interfaces.find((x) => x.name === 'Vlan1').status, 'up');
  const c = await ios.cdpNeighbors();
  assert.deepEqual(c.neighbors.map((n) => [n.deviceId, n.ip, n.platform, n.localInterface, n.remoteInterface]), [['R1', '192.168.1.1', 'Cisco 2811', 'FastEthernet0/24', 'FastEthernet0/0']]);
  const p = await ios.ping('192.168.1.2');
  assert.deepEqual([p.ok, p.successRate, p.sent], [true, 100, 5]);
  const q = await ios.ping('10.9.9.9', { repeat: 2 });
  assert.deepEqual([q.ok, q.successRate, q.marks], [true, 0, '..']);
  assert.equal((await ios.ping('10.0.0.1; reload')).reason, 'ios.bad_target');
  done();
});

test('vlans on a router: not supported, not an error; cdp off is reported as such', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'privileged' });
  const v = await ios.vlans();
  dev.configure(['no cdp run']);
  const c = await ios.cdpNeighbors();
  done();
  assert.deepEqual([v.ok, v.supported], [true, false]);
  assert.deepEqual([c.ok, c.enabled], [true, false]);
});

test('the driver runs inside a task that already holds the console (a job)', async () => {
  const { cli, ios, done } = rig({ model: '2960' });
  const r = await cli.perform('job:backup', async () => {
    const p = await ios.prepare();
    const id = await ios.identify();
    const run = await ios.runningConfig();
    return { p, id, run, task: cli.running };
  });
  done();
  assert.equal(r.task, 'job:backup');
  assert.equal(r.p.ok && r.id.ok && r.run.ok, true);
  assert.match(r.run.config, /^hostname R1$/m);
});

// ── slow console ────────────────────────────────────────────────────────────

test('slow console (9600 baud, 64-byte buffer): prepare and a backup lose nothing', { timeout: 30_000 }, async () => {
  const { dev, ios, done } = rig({ model: '2960', enableSecret: 'class', slowConsole: { bufferBytes: 64, commandMs: 40 }, timeouts: { promptMs: 4000 } });
  const p = await ios.prepare({ enablePasswords: ['class'] });
  assert.equal(p.ok, true, p.message);
  const r = await ios.runningConfig();
  done();
  assert.equal(r.ok, true, r.message);
  assert.equal(dev.dropped, 0);
  assert.match(r.config, /^interface GigabitEthernet0\/2$/m);
});

// ── screen classification ───────────────────────────────────────────────────

test('classifyScreen reads the end of the console, past syslog lines', () => {
  const cases = [
    ['R1>', 'user'], ['R1#', 'privileged'], ['SW1(config-if)#', 'config'], ['rommon 3 > ', 'rommon'], ['switch: ', 'bootLoader'],
    ['Would you like to enter the initial configuration dialog? [yes/no]: ', 'dialog'], ['Would you like to terminate autoinstall? [yes]: ', 'autoinstall'],
    ['\nUser Access Verification\n\nPassword: ', 'password'], ['Username: ', 'username'], ['Press RETURN to get started!\n\n\n', 'pressReturn'],
    ['Proceed with reload? [confirm]', 'confirm'], ['System configuration has been modified. Save? [yes/no]: ', 'save'], [' --More-- ', 'more'],
    ['Router>\n*Nov 12 22:23:19.054: %SYS-5-CONFIG_P: Configured programmatically by process PnP Agent Discovery from console as vty0', 'user'],
    ['Would you like to enter the initial configuration dialog? [yes/no]: \n*Nov 12 22:23:19.054: %PNP-6-PNP_SUDI_UPDATE: Device SUDI [PID:C9300L-24T-4G,SN:FOC1] identified', 'dialog'],
    ['Self decompressing the image : ######', 'booting'], ['', 'empty'], ['root@vm:~# ', 'unknown'],
  ];
  for (const [text, state] of cases) assert.equal(classifyScreen(text).state, state, JSON.stringify(text));
  assert.equal(classifyScreen('Initializing Hardware ...\nEnter enable secret: ').state, 'booting');
  assert.equal(classifyScreen('Initializing Hardware ...\nEnter enable secret: ', { bootMarks: false }).state, 'question');
});

test('every reason and step of the driver has its French and English text', () => {
  const dict = (lang) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'public', 'locales', lang, 'ios.json'), 'utf8'));
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'drivers', 'ciscoIos.js'), 'utf8');
  const steps = new Set([...source.matchAll(/#say\('[^']*', '([a-z_]+)'/g), ...source.matchAll(/ios\.steps\.([a-z_]+)/g)].map((m) => m[1]));
  const warnings = new Set([...source.matchAll(/warnings\.push\('([a-z_]+)'\)/g)].map((m) => m[1]));
  for (const lang of ['fr', 'en']) {
    const d = dict(lang);
    for (const r of REASONS) assert.ok(d.errors[r], `${lang}: errors.${r}`);
    for (const s of steps) assert.ok(d.steps[s], `${lang}: steps.${s}`);
    for (const w of warnings) assert.ok(d.warnings[w], `${lang}: warnings.${w}`);
  }
  for (const r of REASONS) assert.equal(dict('en').errors[r], reasonText(r), `en.errors.${r} matches the driver's sentence`);
});

test('prepare: a prompt seen only in the old screen is checked on the device first', async () => {
  const { dev, ios, done, written } = rig({ model: '2960', start: 'silent' });
  const r = await ios.prepare({ screen: 'S1#' });
  done();
  assert.equal(r.ok, false, 'the device no longer answers');
  assert.equal(r.reason, 'ios.silent');
  assert.equal(written(), '\r\r\r');
  assert.equal(dev.state, 'silent');
});

test('prepare: a setup dialog left half-way is aborted with Ctrl+C, as IOS offers', async () => {
  const { dev, ios, done } = rig({ model: '2811', start: 'dialog' });
  dev.input('yes\r');
  await new Promise((r) => setTimeout(r, 30));
  const r = await ios.prepare({ screen: "Use ctrl-c to abort configuration dialog at any prompt.\nWould you like to enter basic management setup? [yes/no]: " });
  done();
  assert.equal(r.ok, true, r.message);
  assert.ok(r.steps.includes('setup-abort'));
  assert.equal(r.hostname, 'Router');
});

// ── prepare(): a "Password:" seen only in the caller's old screen ───────────

test('prepare: a stale enable "Password:" in the old screen is never answered with the secret', async () => {
  // The device sits at R1> (IOS's password timeout ran while nobody watched)
  const { dev, ios, done, written } = rig({ model: '2811', enableSecret: 'Sup3rSecret' });
  const r = await ios.prepare({ enablePasswords: ['Sup3rSecret'], screen: 'R1>enable\nPassword: ' });
  done();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.steps, ['wake', 'enable', 'enable-password']);
  assert.equal(written().indexOf('\r'), 0, 'a bare Enter first');
  assert.ok(written().indexOf('enable\r') < written().indexOf('Sup3rSecret'), 'the secret only after the device asked for it');
  assert.ok(!dev.commandLog.includes('Sup3rSecret'), 'the secret was never typed at the exec prompt');
});

test('prepare: a stale line "Password:" in the old screen is never answered with the line password', async () => {
  const { dev, ios, done, written } = rig({ model: '2811' });
  const r = await ios.prepare({ linePasswords: ['L1nePass'], screen: '\nUser Access Verification\n\nPassword: ' });
  done();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.steps, ['wake', 'enable']);
  assert.ok(!written().includes('L1nePass'));
  assert.ok(!dev.commandLog.includes('L1nePass'));
});

test('prepare: an enable "Password:" still live behind the old screen is answered after the device shows it', async () => {
  const { dev, ios, done } = rig({ model: '2811', enableSecret: 'class' });
  dev.input('enable\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dev.state, 'enablepass');
  const r = await ios.prepare({ enablePasswords: ['class'], screen: 'R1>enable\nPassword: ' });
  done();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.steps, ['wake', 'enable-password']);
  assert.equal(dev.mode, '#');
});

test('prepare: a line password still live behind the old screen is answered after the device shows it', async () => {
  const { ios, done } = rig({ model: '2811', start: 'linepass', linePassword: 'cisco' });
  const r = await ios.prepare({ linePasswords: ['cisco'], screen: '\nUser Access Verification\n\nPassword: ' });
  done();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.steps.slice(0, 2), ['wake', 'line-password']);
});

test('prepare: candidate passwords are masked in what a failure reports', async () => {
  const { ios, done } = rig({ model: '2811', start: 'privileged' });
  const r = await ios.prepare({
    enablePasswords: ['Sup3rSecret'], linePasswords: ['cisco'],
    screen: 'R1>Sup3rSecret\nTranslating "Sup3rSecret"...domain server (255.255.255.255)\nR1>cisco\nAddress or name of remote host [cisco]? ',
  });
  done();
  assert.equal(r.reason, 'ios.unknown_question');
  assert.ok(!/Sup3rSecret|cisco/.test(JSON.stringify(r)), JSON.stringify(r));
  assert.match(r.lastOutput, /Translating "\*{8}"/);
});

// ── syslog lines stamped with the uptime (12.2SE switch) ────────────────────

test('uptime-stamped syslog lines ("00:00:42: %…") are recognised by prepare and the backup', async () => {
  // A switch that keeps printing them while prepare() looks: chatter, not a boot
  const a = rig({ model: '3560v2', hostname: 'S5', stamps: 'uptime', chatterMs: 30 });
  const seen = [];
  const out = a.dev.out;
  a.dev.out = (text) => { seen.push(text); out(text); };
  const p = await a.ios.prepare();
  a.done();
  assert.equal(p.ok, true, `${p.reason}: ${p.lastOutput}`);
  assert.match(seen.join(''), /\n\d{2}:\d{2}:\d{2}: %SMART_LIC-6-AGENT_READY/, 'the device does print uptime stamps');

  // Syslog lines inside the captured configuration (after --More--): none left in the backup
  const b = rig({ model: '3560v2', hostname: 'S5', start: 'privileged', stamps: 'uptime', termLengthSupported: false, syslogOnMore: 2 });
  const r = await b.ios.runningConfig();
  b.done();
  assert.equal(r.ok, true, r.message);
  assert.match(r.config, /^service timestamps log uptime$/m);
  assert.doesNotMatch(r.config, /%LINEPROTO|^\d{2}:\d{2}:\d{2}:/m);
});

test('syslog stamps: dates, uptimes, sequence numbers; %SYS-5-RESTART with its continuation lines', () => {
  for (const l of ['*Nov 12 22:23:19.054: %SYS-5-CONFIG_I: Configured from console by console', '000045: Mar  1 00:00:52 UTC: %LINK-3-UPDOWN: x',
    '00:00:42: %LINK-3-UPDOWN: Interface FastEthernet0/1, changed state to up', '1d02h: %SYS-5-CONFIG_I: x', '2w3d: %LINEPROTO-5-UPDOWN: x',
    '.00:00:42: %LINK-3-UPDOWN: x', '000012: 00:00:42.123: %SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram', '%PNP-6-PNP_DISCOVERY_STOPPED: x']) {
    assert.equal(isSyslogLine(l), true, l);
  }
  for (const l of ['S5#', 'hostname R1', ' ip address 10.0.0.1 255.255.255.0', '00:00:42 is not a message']) assert.equal(isSyslogLine(l), false, l);
  const restart = '*Mar  1 00:00:05.123: %SYS-5-RESTART: System restarted --\nCisco IOS Software, 2800 Software (C2800NM-ADVENTERPRISEK9-M), Version 12.4(22)T, RELEASE SOFTWARE (fc1)\n'
    + 'Technical Support: http://www.cisco.com/techsupport\nCopyright (c) 1986-2008 by Cisco Systems, Inc.\nCompiled Fri 10-Oct-08 10:10 by prod_rel_team\n';
  assert.equal(classifyScreen(`\nPress RETURN to get started!\n\n${restart}`).state, 'pressReturn');
  assert.equal(classifyScreen(`\nRouter>\n${restart}00:00:06: %LINK-5-CHANGED: x\n`).state, 'user');
  assert.equal(classifyScreen('Cisco IOS Software, 2800 Software\nCompiled Fri 10-Oct-08 10:10 by prod_rel_team').state, 'unknown', 'not without the message head');
});

test('device errors: real IOS errors count, informational "%" lines do not', () => {
  const { DEVICE_ERROR } = patterns;
  for (const l of ['% Invalid input detected at \'^\' marker.', '% Incomplete command.', '% Ambiguous command:  "sh"', '%Error deleting flash:/vlan.dat (Permission denied)',
    'Command rejected: An interface whose trunk encapsulation is "Auto" can not be configured to "trunk" mode.', 'VTP VLAN configuration not allowed when device is in CLIENT mode.']) {
    assert.ok(DEVICE_ERROR.test(l), l);
  }
  for (const l of ['% The key modulus size is 1024 bits', '% Generating 1024 bit RSA keys, keys will be non-exportable...', '% Access VLAN does not exist. Creating vlan 10']) {
    assert.ok(!DEVICE_ERROR.test(l), l);
  }
});

// ── VTP ─────────────────────────────────────────────────────────────────────

test('vlans() reads the VTP settings that live in vlan.dat, on both show vtp layouts', async () => {
  for (const model of ['3560', '2960', 'c9300l']) {
    const { dev, ios, done } = rig({ model, start: 'privileged' });
    dev.configure(['vlan 10', 'exit', 'vtp version 2', 'vtp domain LAB', 'vtp password s3cr3t', 'vtp mode client']);
    const v = await ios.vlans();
    done();
    assert.equal(v.ok, true, v.message);
    assert.deepEqual(v.vtp, { version: 2, mode: 'client', domain: 'LAB', pruning: false, password: 's3cr3t' }, model);
  }
  const { ios, done } = rig({ model: '2960', start: 'privileged' });
  const d = await ios.vlans();
  const run = await ios.runningConfig();
  done();
  assert.deepEqual(d.vtp, { version: 1, mode: 'server', domain: '', pruning: false, password: null });
  assert.doesNotMatch(run.config, /^vtp /m, 'server mode: nothing in show run');
  const r = rig({ model: '2811', start: 'privileged' });
  const none = await r.ios.vlans();
  r.done();
  assert.equal(none.vtp, null);
});
