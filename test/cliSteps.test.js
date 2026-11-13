/**
 * The composable step API that drivers build on: perform(), command(), wait(),
 * expect(), waitQuiet(), answer(), pause(), findPrompt() and cancellation,
 * against the fake IOS or fed by hand. Output and input go through
 * setImmediate to behave like a network stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIos } from '../dev/fakeIos.js';
import { CliAutomation, screenTail, isSyslogLine } from '../src/lib/cliAutomation.js';

function rig({ hostname = 'R1', mode = '#', state = 'exec', ...opts } = {}) {
  let cli;
  const ios = new FakeIos({ hostname, out: (s) => setImmediate(() => cli.feed(s)), timeScale: 0.002, ...opts });
  cli = new CliAutomation({ write: (s) => setImmediate(() => ios.input(s)) });
  if (!opts.model) { ios.state = state; ios.mode = mode; }
  return { ios, cli, done: () => ios.stop() };
}

/** An engine fed by hand: `writes` records what it sends */
function manual() {
  const writes = [];
  const cli = new CliAutomation({ write: (s) => writes.push(s) });
  return { cli, writes };
}

test('perform() locks the task and command() captures output up to the prompt', async () => {
  const { cli, done } = rig();
  const out = await cli.perform('probe', async (c) => {
    const { output, complete } = await c.command('show version', { until: /(?:^|\n)R1# ?$/, timeout: 6000, idle: 2000, settle: 120 });
    assert.equal(complete, true);
    return output;
  });
  done();
  assert.match(out, /Cisco IOS Software/);
  assert.equal(cli.running, null, 'task released after perform resolves');
});

test('expect() reports which of several patterns appeared first, or why none did', async () => {
  const { cli, done } = rig();
  const seen = await cli.perform('classify', async (c) => {
    c.reset(); c.sendLine('');
    const hit = await c.expect({ config: /\(config\)# ?$/, prompt: /(?:^|\n)R1# ?$/, rommon: /rommon \d+ >/ }, { timeout: 4000, settle: 120 });
    const none = await c.expect({ never: (b) => b.includes('never') }, { timeout: 300, idle: 100 });
    return { hit, none };
  });
  done();
  assert.equal(seen.hit.name, 'prompt');
  assert.equal(seen.hit.outcome, 'match');
  assert.deepEqual([seen.none.name, seen.none.outcome], [null, 'idle']);
});

test('wait() throws on timeout but resolves null when optional', async () => {
  const { cli, done } = rig();
  await cli.perform('t', async (c) => {
    await assert.rejects(c.wait(/never-this-text/, { timeout: 300 }), (e) => e.code === 'automation.timeout');
    assert.equal(await c.wait(/never-this-text/, { timeout: 300, optional: true }), null);
  });
  done();
});

test('waitQuiet() tells a quiet line from one that keeps printing', async () => {
  const { cli } = manual();
  await cli.perform('t', async (c) => {
    assert.equal(await c.waitQuiet(60, { timeout: 500 }), true);
    const talk = setInterval(() => c.feed('Self decompressing the image : #'), 20);
    assert.equal(await c.waitQuiet(100, { timeout: 400 }), false);
    clearInterval(talk);
  });
});

test('answer() replies to a device question (copy run start)', async () => {
  const { ios, cli, done } = rig();
  await cli.perform('save', async (c) => {
    c.reset(); c.sendLine('copy running-config startup-config');
    const q = await c.wait(/Destination filename \[startup-config\]\? ?$/, { timeout: 4000, settle: 120 });
    assert.ok(q);
    await c.answer('');
    await c.wait(/(?:^|\n)R1# ?$/, { timeout: 4000, settle: 120 });
  });
  done();
  assert.ok(ios.commandLog.includes('copy running-config startup-config'));
  assert.ok(ios.startup, 'the configuration was saved');
});

test('a second perform() is refused while one runs', async () => {
  const { cli, done } = rig();
  const first = cli.perform('one', async (c) => { await c.pause(200); });
  await assert.rejects(cli.perform('two', async () => {}), /Another task \(one\)/);
  await first;
  done();
});

test('cancel() stops a running perform() with a cancelled error', async () => {
  const { cli, done } = rig();
  const run = cli.perform('long', async (c) => { await c.pause(5000); });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cli.running, 'long');
  cli.cancel();
  await assert.rejects(run, (e) => e.cancelled === true && e.code === 'automation.stopped');
  assert.equal(cli.running, null);
  done();
});

test('steps outside perform() are refused: nothing would be captured', async () => {
  const { cli, writes } = manual();
  assert.throws(() => cli.sendLine('reload'), (e) => e.code === 'automation.no_task');
  await assert.rejects(cli.wait(/x/), (e) => e.code === 'automation.no_task');
  await assert.rejects(cli.command('show version'), (e) => e.code === 'automation.no_task');
  assert.deepEqual(writes, []);
});

// ── pager ───────────────────────────────────────────────────────────────────

test('pager: a --More-- followed by syslog lines is still answered, and the next page is not glued to them', async () => {
  const { cli, writes } = manual();
  const out = await cli.perform('t', async (c) => {
    const run = c.command('show running-config', { until: /R1#$/, timeout: 1000, idle: 500, settle: 20 });
    c.feed('show running-config\r\nline 1\r\n --More-- ');
    c.feed('\r\n*Nov 12 22:23:19.054: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/3, changed state to down');
    // IOS erases the marker where the cursor is (here: on the syslog line), then prints the next page
    c.feed(`${'\b'.repeat(9)}${' '.repeat(9)}${'\b'.repeat(9)}line 2\r\n --More-- `);
    c.feed(`${'\b'.repeat(10)}${' '.repeat(10)}${'\b'.repeat(10)} line 3 indented\r\nR1#`); // 9 or 10: the engine does not depend on it
    return (await run).output;
  });
  assert.deepEqual(writes, ['show running-config\r', ' ', ' ']);
  const lines = out.split('\n').filter((l) => !isSyslogLine(l));
  assert.deepEqual(lines, ['show running-config', 'line 1', 'line 2', ' line 3 indented', 'R1#']);
});

test('pager: a marker split across two chunks is answered once', async () => {
  const { cli, writes } = manual();
  await cli.perform('t', async (c) => {
    const run = c.command('show version', { until: /R1#$/, timeout: 1000, idle: 500, settle: 20 });
    c.feed('show version\r\nCisco IOS Software\r\n --Mo');
    c.feed('re-- ');
    c.feed(`${'\b'.repeat(10)}${' '.repeat(10)}${'\b'.repeat(10)}last line\r\nR1#`);
    await run;
  });
  assert.deepEqual(writes, ['show version\r', ' ']);
});

// ── prompts ─────────────────────────────────────────────────────────────────

test('findPrompt() reads every configuration sub-mode and ignores syslog lines after the prompt', async () => {
  for (const [screen, want] of [
    ['R1(config-if)#', { host: 'R1', configMode: true, mark: '#' }],
    ['R1(dhcp-config)#', { host: 'R1', configMode: true, mark: '#' }],
    ['SW1(config-vlan)#', { host: 'SW1', configMode: true, mark: '#' }],
    ['Router>\r\n*Nov 12 22:23:19.054: %SYS-5-CONFIG_P: Configured programmatically by process PnP Agent Discovery from console as vty0', { host: 'Router', configMode: false, mark: '>' }],
  ]) {
    const { cli } = manual();
    const p = await cli.perform('t', async (c) => {
      const found = c.findPrompt({ nudge: false, timeout: 500 });
      c.feed(screen);
      return found;
    });
    assert.deepEqual(p, want, screen);
  }
  assert.equal(screenTail('R1#\n*Mar  1 00:05:12.345: %SYS-5-CONFIG_I: Configured from console by console\n'), 'R1#');
  assert.equal(screenTail('000045: Mar  1 00:00:52 UTC: %LINK-3-UPDOWN: x\nR1>'), '000045: Mar  1 00:00:52 UTC: %LINK-3-UPDOWN: x\nR1>');
});

test('sendScript() inside a driver task: syslog lines after each prompt (IOS XE) do not make lines "slow"', async () => {
  const { ios, cli, done } = rig({ model: 'isr4331', start: 'privileged' });
  const r = await cli.perform('job:inject', (c) => c.sendScript('configure terminal\ninterface GigabitEthernet0/0/1\n no shutdown\ninterface Loopback1\nend', { delayMs: 0, chunkDelayMs: 1 }));
  done();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.slow, []);
  assert.equal(ios.cfg.interfaces.get('GigabitEthernet0/0/1').shutdown, false);
  assert.ok(ios.cfg.interfaces.has('Loopback1'));
});
