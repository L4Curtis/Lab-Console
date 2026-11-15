/**
 * The telnet escape (Ctrl+]) opens telnet's command mode on the jump server,
 * where `open <host> <port>` reaches past the allow-list and `!` starts a
 * shell. Only ConsoleSession.sendBreak() may write it. These tests drive a
 * real ConsoleSession on the mock lab, whose telnet answers the escape with
 * "telnet> " and closes the line on "close", like the real one:
 *   - every automated path (a paste or an injection through the session's
 *     CliAutomation, a job's enable password typed by the driver, the console
 *     server login) drops the escape;
 *   - keys typed right after a BREAK wait until telnet is back in the session.
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
const TARGET = '10.0.9.4:3001';

/** A connected session on R1 (user EXEC), and everything it printed */
async function open(t, { telnet = { autoLogin: true, ...TELNET, wakeIdleMs: 300 }, device = {} } = {}) {
  const lab = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, devices: { [TARGET]: { model: '2811', hostname: 'R1', ...device } } });
  const session = new ConsoleSession({
    target: { host: '10.0.9.4', port: 3001 },
    ssh: { host: '127.0.0.1', port: lab.port, ...SSH, readyTimeoutMs: 5000 },
    telnet,
    logger: quiet,
  });
  let output = '';
  const closed = [];
  session.on('data', (b) => { output += b.toString('latin1'); });
  session.on('close', (c) => closed.push(c));
  t.after(async () => { session.close(); await lab.close(); });
  session.start();
  return { lab, session, closed, get output() { return output; } };
}

const until = (s, re, ms = 4000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (re.test(s.output)) return resolve();
    if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${re}; got ${JSON.stringify(s.output.slice(-300))}`));
    setTimeout(tick, 20);
  };
  tick();
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function atPrompt(t, opts) {
  const s = await open(t, opts);
  await s.session.ready;
  s.session.write('\r');
  await until(s, /R1>\s*$/);
  return s;
}

test('a paste or an injection carrying Ctrl+] never reaches telnet>', { timeout: 20_000 }, async (t) => {
  const s = await atPrompt(t);
  await s.session.cli.perform('paste', (c) => c.sendScript('show clock\n\x1dclose\n', { waitForPrompt: true, delayMs: 10, skipComments: false }));
  await s.session.cli.perform('inject', async (c) => { c.send('\x1d'); c.sendLine('\x1dclose'); await c.waitQuiet(200, { timeout: 2000 }); });
  await pause(200);
  assert.doesNotMatch(s.output, /telnet>/);
  assert.doesNotMatch(s.output, /Connection closed by foreign host/);
  assert.equal(s.closed.length, 0, 'the line is still open');
  assert.equal(s.session.write('\x1d'), false, 'a lone escape typed at the keyboard is not taken');
});

test("a job's enable password carrying Ctrl+] never reaches telnet>", { timeout: 20_000 }, async (t) => {
  const s = await atPrompt(t, { device: { enableSecret: 'class' } });
  const ios = new CiscoIos(s.session.cli, { timeouts: { ...FAST, promptMs: 3000, observeMs: 600, quietMs: 300 } });
  await ios.prepare({ enablePasswords: ['\x1dclose', 'class'] });
  assert.doesNotMatch(s.output, /telnet>/);
  assert.equal(s.closed.length, 0, 'the line is still open');
});

test('the console server login never types Ctrl+] either', { timeout: 20_000 }, async (t) => {
  const s = await open(t, { telnet: { autoLogin: true, username: `${TELNET.username}\x1d`, password: `\x1dclose${TELNET.password}`, wakeIdleMs: 300 } });
  await until(s, /Username: /);
  await pause(800);
  assert.doesNotMatch(s.output, /telnet>/);
  assert.equal(s.closed.length, 0);
});

test('keys typed right after a BREAK wait until telnet is back in the session', { timeout: 20_000 }, async (t) => {
  const s = await atPrompt(t);
  s.session.sendBreak();
  assert.equal(s.session.write('close\r'), true, 'held, not refused');
  s.session.cli.perform('inject', (c) => c.send('show clock\r')).catch(() => {});
  await until(s, /send brk/);
  await pause(600);
  assert.doesNotMatch(s.output, /Connection closed by foreign host/);
  assert.equal(s.closed.length, 0, 'telnet did not run "close"');
  const after = s.output.slice(s.output.indexOf('send brk') + 'send brk'.length);
  assert.match(after, /close/, 'the keys reached the device, after the BREAK');
  assert.match(after, /R1>\s*$/);
});

test('a second BREAK while one is on its way is ignored; the line works after both', { timeout: 20_000 }, async (t) => {
  const s = await atPrompt(t);
  s.session.sendBreak();
  s.session.sendBreak();
  await pause(500);
  assert.equal(s.output.match(/telnet>/g)?.length, 1);
  s.session.write('\r');
  await until(s, /send brk[\s\S]*R1>\s*$/);
  assert.equal(s.closed.length, 0);
});
