/**
 * Config export and Feature 3 paced injection against simulated
 * IOS device; Output and input go through setImmediate to behave
 * like a network stream (chunks arrive asynchronously)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIos } from '../dev/fakeIos.js';
import { CliAutomation, cleanRunningConfig, parseScript } from '../src/lib/cliAutomation.js';

function rig({ hostname = 'S1', mode = '#', ...opts } = {}) {
  let cli;
  const ios = new FakeIos({ hostname, out: (s) => setImmediate(() => cli.feed(s)), username: 'u', password: 'p', ...opts });
  cli = new CliAutomation({ write: (s) => setImmediate(() => ios.input(s)) });
  ios.state = 'exec';
  ios.mode = mode;
  return { ios, cli, done: () => ios.stop() };
}

describe('the automation engine', { concurrency: 8 }, () => {
  // ── Config export ───────────────────────────────────────────────────────────

  test('export: paging disabled, full multi-page config captured, terminal length restored', async () => {
    const { ios, cli, done } = rig();
    const { hostname, config, pagingFallback } = await cli.exportRunningConfig();
    done();
    assert.equal(hostname, 'S1');
    assert.equal(pagingFallback, false);
    assert.match(config, /^Current configuration/);
    assert.match(config, /^hostname S1$/m);
    assert.match(config, /^interface FastEthernet0\/24$/m);
    assert.match(config, /\nend\n$/);
    assert.doesNotMatch(config, /--More--|Building configuration|S1#/);
    assert.ok(config.split('\n').length > 60, 'longer than several pages of 24 lines');
    assert.deepEqual(ios.commandLog.slice(-3), ['terminal length 0', 'show running-config', 'terminal length 24']);
    assert.equal(ios.termLength, 24);
  });

  test('export: if "terminal length" is refused, every --More-- is answered and nothing is lost', async () => {
    const a = rig();
    const reference = (await a.cli.exportRunningConfig()).config;
    a.done();
    const b = rig({ termLengthSupported: false });
    const { config, pagingFallback } = await b.cli.exportRunningConfig();
    b.done();
    assert.equal(pagingFallback, true);
    assert.equal(config, reference);
  });

  test('export: from configuration mode it leaves with "end" first', async () => {
    const { ios, cli, done } = rig({ mode: 'config-if' });
    const { config } = await cli.exportRunningConfig();
    done();
    assert.match(config, /^hostname S1$/m);
    assert.ok(ios.commandLog.map((c) => c.trim()).includes('end'));
    assert.equal(ios.mode, '#');
  });

  test('export: user mode (>) is refused with a clear hint', async () => {
    const { cli, done } = rig({ mode: '>' });
    await assert.rejects(cli.exportRunningConfig(), /user mode \(S1>\).*enable/);
    done();
  });

  test('export: not logged in gives a clear error', async () => {
    const { ios, cli, done } = rig();
    ios.state = 'user';
    await assert.rejects(cli.exportRunningConfig(), /No Cisco prompt/);
    done();
  });

  test('cleanRunningConfig drops syslog lines, the echo and the prompt', () => {
    const captured = 'show running-config\nBuilding configuration...\n\nCurrent configuration : 10 bytes\n!\n*Mar  1 00:12:01.123: %LINK-3-UPDOWN: Interface Fa0/1, changed state to up\nhostname R1\n%SYS-5-CONFIG_I: Configured from console\nend\nR1#';
    assert.equal(cleanRunningConfig(captured, /(?:^|\n)R1# ?$/), 'Current configuration : 10 bytes\n!\nhostname R1\nend\n');
  });

  // ── Config import ───────────────────────────────────────────────────────────

  const SCRIPT = `! lab 3 addressing
configure terminal
hostname R7
interface g0/0/0
 description Link to S1 (fa0/24) - lab 3
 ip address 192.168.10.1 255.255.255.0
 no shutdown
interfce g0/0/1
interface g0/0/1
 ip address 192.168.20.1 255.255.255.0
 no shutdown
end`;

  test('inject: line by line, waits for each prompt, reports device errors with line numbers', async () => {
    const { ios, cli, done } = rig({ hostname: 'R1' });
    const progress = [];
    const r = await cli.injectScript(SCRIPT, {}, (msg, p) => progress.push(p?.done));
    assert.equal(r.total, 11, 'the "!" comment line is skipped');
    assert.equal(r.sent, 11);
    assert.deepEqual(r.errors.map((e) => [e.line, e.command]), [[8, 'interfce g0/0/1']]);
    assert.deepEqual(r.slow, []);
    assert.ok(progress.length >= 11);
    const { config } = await cli.exportRunningConfig();
    done();
    assert.match(config, /^hostname R7$/m);
    assert.match(config, /interface GigabitEthernet0\/0\/0\n description Link to S1 \(fa0\/24\) - lab 3\n ip address 192\.168\.10\.1 255\.255\.255\.0/);
    assert.match(config, /interface GigabitEthernet0\/0\/1\n ip address 192\.168\.20\.1/);
  });

  test('inject: stop at the first error', async () => {
    const { cli, done } = rig({ hostname: 'R1' });
    const r = await cli.injectScript(SCRIPT, { stopOnError: true });
    done();
    assert.equal(r.sent, 7, 'stops right after the bad line');
    assert.equal(r.stoppedOnError, true);
  });

  /** 30 interface blocks with long descriptions: ~3 KB of commands */
  function bigScript() {
    const lines = ['configure terminal'];
    for (let i = 1; i <= 15; i++) {
      lines.push(`interface FastEthernet0/${i}`, ` description Student group ${i} uplink towards the distribution switch of bay 5 (port ${i})`, ' switchport mode access', ` switchport access vlan ${100 + i}`);
    }
    lines.push('end');
    return lines.join('\n');
  }
  const configured = (ios) => [...ios.cfg.interfaces].filter(([, i]) => i.lines.some((l) => l.startsWith('description Student group'))).length;

  test('slow old device: dumping the script at once loses characters…', async () => {
    const ios = new FakeIos({ hostname: 'S1', out: () => {}, slowConsole: { bufferBytes: 64, commandMs: 40 } });
    ios.state = 'exec'; ios.mode = '#';
    ios.input(bigScript().replace(/\n/g, '\r') + '\r'); // what a plain paste does
    await new Promise((r) => setTimeout(r, 2500));
    ios.stop();
    assert.ok(ios.dropped > 1000, `dropped ${ios.dropped} bytes`);
    assert.ok(configured(ios) < 15, `only ${configured(ios)} of 15 interfaces got their description`);
  });

  test('…while paced injection gets every line through intact', { timeout: 60_000 }, async () => {
    const { ios, cli, done } = rig({ slowConsole: { bufferBytes: 64, commandMs: 40 } });
    const r = await cli.injectScript(bigScript());
    done();
    assert.equal(ios.dropped, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(configured(ios), 15);
    assert.ok(ios.cfg.interfaces.get('FastEthernet0/15').lines.includes('description Student group 15 uplink towards the distribution switch of bay 5 (port 15)'));
  });

  test('inject: multi-line banner (no prompt until the delimiter) does not stall', async () => {
    const { ios, cli, done } = rig({ hostname: 'R1' });
    const t0 = Date.now();
    const r = await cli.injectScript('configure terminal\nbanner motd #\nAuthorized students only\nLab 3 - bay 5\n#\nhostname R9\nend');
    done();
    assert.deepEqual(r.slow, []);
    assert.ok(Date.now() - t0 < 3000, 'no per-line timeouts');
    assert.equal(ios.cfg.hostname, 'R9');
    assert.ok(ios.cfg.global.some((l) => l.includes('Authorized students only')));
  });

  test('inject: banner typed from interface mode works like on IOS (sub-mode is left)', async () => {
    const { ios, cli, done } = rig({ hostname: 'R1' });
    const r = await cli.injectScript('configure terminal\ninterface g0/0/1\n no shutdown\nbanner motd #\nAuthorized students only\n#\nend');
    done();
    assert.deepEqual(r.errors, []);
    assert.ok(ios.cfg.global.some((l) => l.includes('Authorized students only')));
  });

  test('inject: questions such as "Destination filename [startup-config]?" are answered by the next line', async () => {
    const { ios, cli, done } = rig({ hostname: 'R1' });
    const r = await cli.injectScript('copy running-config startup-config\n\nshow version', { skipComments: true });
    done();
    assert.deepEqual(r.slow, []);
    assert.equal(r.sent, 3, 'the blank line is sent: it accepts the default filename');
    assert.ok(ios.commandLog.includes('show version'), 'show version ran as a command, not as a filename');
  });

  test('inject: a question left unanswered after the last line is reported', async () => {
    const { cli, done } = rig({ hostname: 'R1' });
    const r = await cli.injectScript('copy running-config startup-config\n');
    done();
    assert.equal(r.waitingFor, 'Destination filename [startup-config]?');
  });

  test('inject: can be stopped mid-way; keys are held back only while it runs', async () => {
    const { cli, done } = rig({ slowConsole: { bufferBytes: 64, commandMs: 40 } });
    const run = cli.injectScript(bigScript());
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(cli.running, 'inject');
    cli.cancel();
    await assert.rejects(run, (e) => e.cancelled === true);
    assert.equal(cli.running, null);
    done();
  });

  test('parseScript keeps line numbers and blank lines (bare Enter), skips "!" comments; the final newline is not a line', () => {
    assert.deepEqual(parseScript('! c\r\nconf t\r\n\r\n  hostname X  \r\n'), [{ n: 2, text: 'conf t' }, { n: 3, text: '' }, { n: 4, text: '  hostname X' }]);
    assert.deepEqual(parseScript('copy run start\n\n').map((l) => l.text), ['copy run start', ''], 'a real blank line at the end is kept');
  });
});
