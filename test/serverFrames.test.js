/**
 * What the server really puts on the console sockets: the frames of the
 * refusals, the exits and the automation results are produced by the real
 * code (a running application, a RoomManager, the automation handler, a
 * ConsoleSession against a small SSH server), then rendered the way the
 * browser does (serverText) in French and in English. A misspelt parameter
 * name shows up here as a literal "{name}" in the sentence
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { startTestApp, tempDataDir, repoRoot, silentLogger } from './helpers/app.js';
import { RoomManager } from '../src/modules/consoles/roomManager.js';
import { ConsoleSession } from '../src/modules/consoles/consoleSession.js';
import { createAutomationHandler } from '../src/lib/automationProtocol.js';
import { AutomationError, CliAutomation } from '../src/lib/cliAutomation.js';
import { FakeIos } from '../dev/fakeIos.js';
import { sshErrorInfo } from '../src/lib/ssh.js';
import { LabRegistry } from '../src/modules/consoles/labRegistry.js';

// ── Rendering as the browser does ───────────────────────────────────────────

let i18n;
let serverText;
before(async () => {
  const dir = path.join(repoRoot, 'public', 'locales');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (!String(url).startsWith('/locales/')) return realFetch(url, ...rest);
    const file = path.join(dir, url.replace('/locales/', ''));
    return fs.existsSync(file) ? { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) } : { ok: false, status: 404 };
  };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  i18n = await import('../public/js/core/i18n.js');
  ({ serverText } = await import('../public/js/shared/serverText.js'));
  await i18n.initI18n({ defaultLocale: 'fr', namespaces: ['common', 'terminal'] });
  await i18n.setLocale('en', { persist: false });
  await i18n.setLocale('fr', { persist: false });
});

/** The frame in French and in English; both must be a finished sentence, in the language asked for */
async function render(frame) {
  assert.ok(frame.code || frame.parts?.length, `the frame has a code: ${JSON.stringify(frame)}`);
  const out = {};
  for (const lang of ['fr', 'en']) {
    await i18n.setLocale(lang, { persist: false });
    out[lang] = serverText(frame);
    assert.doesNotMatch(out[lang], /[{}]/, `${lang} ${frame.code}: a placeholder was left unfilled: ${out[lang]}`);
    assert.ok(out[lang].trim().length > 0 && !out[lang].startsWith('terminal.server.'), `${lang} ${frame.code}: no translation`);
  }
  await i18n.setLocale('fr', { persist: false });
  assert.notEqual(out.fr, frame.message, `${frame.code ?? 'summary'}: French differs from the English sentence`);
  return out;
}

// ── WebSocket refusals, on the running application ──────────────────────────

function open(lab, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${lab.wsUrl}/ws/console?${query}`, { headers: { origin: lab.url, ...lab.as('student1') } });
    const frames = [];
    ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    ws.on('close', () => resolve(frames));
    ws.on('error', reject);
  });
}

test('frames: a device outside the allow-list is refused with its name', async () => {
  const lab = await startTestApp({ env: { ALLOWED_CONSOLE_HOSTS: '10.9.9.9' } });
  try {
    const { labs } = await (await fetch(`${lab.url}/api/consoles/labs`, { headers: lab.as('student1') })).json();
    const device = labs.flatMap((l) => l.devices)[0];
    assert.equal(device.allowed, false);
    const [frame] = await open(lab, `device=${encodeURIComponent(device.key)}`);
    assert.deepEqual(frame, { type: 'error', message: `${device.name}'s console address is not on the platform's allow-list.`, code: 'consoles.not_allowed', params: { name: device.name } });
    const text = await render(frame);
    assert.ok(text.fr.includes(device.name) && text.en.includes(device.name));
    // The diagram notes name the same refusals, with a code of their own
    const warning = (await (await fetch(`${lab.url}/api/consoles/labs`, { headers: lab.as('student1') })).json()).warnings.find((w) => w.code === 'consoles.warn_not_allowed');
    assert.ok(warning);
    assert.match((await render(warning)).fr, /liste autorisée/);
  } finally {
    await lab.close();
  }
});

test('frames: the twenty-first console opened within a minute is rate limited', async () => {
  const lab = await startTestApp();
  try {
    let last;
    for (let i = 0; i < 21; i++) [last] = await open(lab, 'device=nope');
    assert.deepEqual(last, { type: 'error', message: 'Too many consoles opened in the last minute. Wait a moment and try again.', code: 'consoles.rate_limited', params: {} });
    await render(last);
    await render({ type: 'error', message: 'x', code: 'consoles.device_gone', params: {} });
  } finally {
    await lab.close();
  }
});

// ── Refusals and closings of the RoomManager ────────────────────────────────

const device = (name, port) => ({ key: `k${port}`, name, labName: 'B4M', target: { host: '10.22.9.211', port } });
const LAB = { ssh: { host: '127.0.0.1', port: 1, username: 'u', password: 'p' }, telnet: {}, consoles: { allowedHosts: ['10.22.9.211'], portRange: { min: 2000, max: 2099 } } };
/** Lines that stay "connecting" for ever: the pool never answers */
const stuckPool = { exec: () => new Promise(() => {}) };
const managers = [];
function manager(limits, extra = {}) {
  const m = new RoomManager({ settings: { get: () => structuredClone(LAB) }, pool: stuckPool, limits: { idleTimeoutMs: 60 * 60_000, ...limits }, logger: silentLogger(), ...extra });
  managers.push(m);
  return m;
}
const userOf = (id) => ({ id, name: id, username: id, role: 'student' });
const client = (user) => ({ user, frames: [], send(f) { this.frames.push(f); }, sendBytes() {}, close() {} });

test('frames: platform full, client full, a bench of another team and an address off the list carry their params', async () => {
  const mgr = manager({ maxSessions: 2, maxSessionsPerClient: 1 }, { canPilot: (u) => u.id !== 'eve' });
  const alice = userOf('alice');
  mgr.open(device('R1', 2001), alice).attach(client(alice));
  // Joining the line someone opened is not "busy" any more: it is the same room
  assert.equal(mgr.open(device('R1', 2001), userOf('bob')), mgr.get('10.22.9.211:2001'));

  const own = mgr.canOpen(device('R2', 2002), alice);
  assert.equal(own.code, 'consoles.client_full');
  assert.deepEqual(own.params, { max: 1 });
  assert.match((await render({ type: 'error', ...own })).fr, /1 consoles/);

  mgr.open(device('R3', 2003), userOf('carol'));
  const full = mgr.canOpen(device('R4', 2004), userOf('dave'));
  assert.equal(full.code, 'consoles.platform_full');
  await render({ type: 'error', ...full });

  const eve = mgr.canOpen(device('R1', 2001), userOf('eve'));
  assert.equal(eve.ok, true, 'anyone may join an open line, to watch');
  const closedBench = manager({ maxSessions: 5, maxSessionsPerClient: 5 }, { canPilot: () => false }).canOpen(device('R9', 2009), userOf('eve'));
  assert.equal(closedBench.code, 'consoles.open_not_allowed');
  assert.ok((await render({ type: 'error', ...closedBench })).fr.includes('R9'));

  const off = mgr.canOpen({ ...device('X', 2001), target: { host: '10.9.9.9', port: 2001 } }, alice);
  assert.equal(off.code, 'consoles.not_allowed');
  const gone = mgr.canOpen(device('R7', 2007), alice, { readOnly: true });
  assert.equal(gone.code, 'consoles.room_gone');
  assert.ok((await render({ type: 'error', ...gone })).en.includes('R7'));
});

test('frames: the idle timeout and the shutdown close a console with a code, a name and a number', async () => {
  const clock = { ms: Date.now() };
  const mgr = manager({ maxSessions: 5, maxSessionsPerClient: 5, idleTimeoutMs: 20 * 60_000 }, { now: () => clock.ms });
  const sw7 = mgr.open(device('SW7', 2007), userOf('alice'));
  const watcher = client(userOf('alice'));
  sw7.attach(watcher);
  sw7.session.lastActivity = clock.ms;
  clock.ms += 30_000;
  mgr.sweepIdle(); // not idle yet
  assert.equal(sw7.closed, false);
  clock.ms += 21 * 60_000;
  mgr.sweepIdle();
  assert.equal(sw7.closed, true);
  const exit = watcher.frames.find((f) => f.type === 'exit');
  assert.equal(exit.code, 'consoles.idle_timeout');
  assert.deepEqual(exit.params, { minutes: 20, name: 'SW7' });
  const text = await render(exit);
  assert.ok(text.fr.includes('20') && text.fr.includes('SW7'));

  const sw8 = mgr.open(device('SW8', 2008), userOf('alice'));
  const other = client(userOf('alice'));
  sw8.attach(other);
  mgr.shutdown('Platform is restarting', { code: 'consoles.restarting' });
  assert.equal(other.frames.at(-1).code, 'consoles.restarting');
  await render(other.frames.at(-1));
});

// ── Automation refusals and results ─────────────────────────────────────────

function automation({ canExport = true, cli = {} } = {}) {
  const frames = [];
  const fakeCli = { running: null, cancel() {}, readRunningConfig: async () => ({}), sendScript: async () => ({}), ...cli };
  fakeCli.perform = (_label, fn) => fn(fakeCli);
  const handle = createAutomationHandler({ cli: fakeCli, send: (f) => frames.push(f), canExport, log: silentLogger(), label: 'test' });
  return { handle, frames };
}
const settle = () => new Promise((r) => setImmediate(r));

test('frames: the automation refusals', async () => {
  const cases = [
    [{ cli: { running: 'inject' } }, { type: 'inject', script: 'a' }, 'automation.busy', {}],
    [{ canExport: false }, { type: 'export-config' }, 'automation.export_unsupported', {}],
    [{}, { type: 'inject', script: '   ' }, 'automation.script_empty', {}],
    [{}, { type: 'inject', script: 'x'.repeat(256 * 1024 + 1) }, 'automation.script_too_large', {}],
    [{}, { type: 'inject', script: 'a\n'.repeat(5001) }, 'automation.script_too_long', { max: 5000 }],
  ];
  for (const [setup, msg, code, params] of cases) {
    const { handle, frames } = automation(setup);
    assert.equal(handle(msg), true);
    assert.equal(frames.length, 1, code);
    assert.equal(frames[0].state, 'error');
    assert.equal(frames[0].code, code);
    assert.deepEqual(frames[0].params, params);
    await render(frames[0]);
  }
});

test('frames: a task that fails reports the code and params of its error', async () => {
  const { handle, frames } = automation({ cli: { readRunningConfig: async () => { throw new AutomationError('S1 is in user mode', 'automation.user_mode', { host: 'S1' }); } } });
  handle({ type: 'export-config' });
  await settle();
  assert.equal(frames.at(-1).code, 'automation.user_mode');
  assert.match((await render(frames.at(-1))).fr, /S1>/);
});

test('frames: the summary of a script that stopped early agrees with the total, not with the number sent', async () => {
  const result = { sent: 1, total: 5, errors: [{ line: 1 }], slow: [2, 3], waitingFor: 'Proceed? [confirm]', stoppedOnError: true };
  const { handle, frames } = automation({ cli: { sendScript: async () => result } });
  handle({ type: 'inject', script: 'a\nb\nc\nd\ne' });
  await settle();
  const frame = frames.find((f) => f.state === 'warning');
  assert.deepEqual(frame.parts.map((p) => p.code), ['automation.sent', 'automation.device_errors', 'automation.no_prompt_after', 'automation.stopped_on_error', 'automation.waiting_for']);
  await i18n.setLocale('fr', { persist: false });
  const fr = serverText(frame);
  assert.ok(fr.startsWith('Lignes envoyées : 1 sur 5. 1 erreur de l’équipement (ligne 1). Pas de prompt après les lignes 2, 3.'), fr);
  assert.doesNotMatch(fr, /[{}]/);
  await i18n.setLocale('en', { persist: false });
  assert.ok(serverText(frame).startsWith('Sent 1 of 5 lines. 1 device error (line 1).'));
  await i18n.setLocale('fr', { persist: false });
  for (const p of frame.parts) await render({ ...p, message: 'x' });
});

test('frames: progress and results of an export and of a script', async () => {
  const { handle, frames } = automation({
    cli: {
      readRunningConfig: async (progress) => { progress('Reading', { code: 'automation.reading_config' }); return { hostname: 'S1', config: 'a\nb\n', pagingFallback: true }; },
      sendScript: async (_s, _o, progress) => { progress('Sending line 2 of 3', { done: 1, total: 3, code: 'automation.sending_line', params: { line: 2, total: 3 } }); return { sent: 3, total: 3, errors: [], slow: [], waitingFor: null }; },
    },
  });
  handle({ type: 'export-config' });
  handle({ type: 'inject', script: 'a\nb\nc' });
  await settle();
  for (const f of frames.filter((x) => x.type === 'automation')) await render(f);
  assert.equal(frames.find((f) => f.code === 'automation.exported_paging').params.count, 2);
  assert.deepEqual(frames.find((f) => f.code === 'automation.sending_line').params, { line: 2, total: 3 });
});

// ── A ConsoleSession against a small SSH server ─────────────────────────────

function startJump(onExec) {
  const server = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acceptPty) => acceptPty());
      session.once('exec', (acceptExec) => onExec(acceptExec()));
    }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
const sshCfg = (port) => ({ host: '127.0.0.1', port, username: 'u', password: 'p', readyTimeoutMs: 5000, keepaliveIntervalMs: 0 });

function runSession(port) {
  const session = new ConsoleSession({ target: { host: '10.22.9.211', port: 2001 }, ssh: sshCfg(port), telnet: {}, logger: silentLogger() });
  const statuses = [];
  session.on('status', (s) => statuses.push(s));
  const closing = new Promise((resolve) => session.on('close', resolve));
  session.start();
  return { statuses, closing };
}

test('frames: a jump server that refuses the connection', async () => {
  const { statuses, closing } = runSession(1);
  const { reason, info } = await closing;
  assert.equal(info.code, 'consoles.ssh_refused');
  assert.deepEqual(info.params, { host: '127.0.0.1', port: 1 });
  assert.equal(statuses[0].code, 'consoles.status_ssh');
  await render(statuses[0]);
  assert.match((await render({ type: 'exit', message: reason, ...info })).fr, /127\.0\.0\.1:1/);
});

test('frames: a telnet that exits with a code, one that simply ends, and a channel lost with its connection', async () => {
  for (const [exit, code, params] of [[3, 'consoles.closed_exit', { code: 3 }], [0, 'consoles.closed', {}], [null, 'consoles.ssh_closed', {}]]) {
    const jump = await startJump((stream) => { if (exit !== null) stream.exit(exit); stream.end(); });
    try {
      const { statuses, closing } = runSession(jump.port);
      const { reason, info } = await closing;
      assert.deepEqual(statuses.map((s) => s.code), ['consoles.status_ssh', 'consoles.status_telnet']);
      assert.deepEqual(statuses[1].params, { target: '10.22.9.211:2001' });
      for (const s of statuses) await render(s);
      assert.equal(info.code, code);
      assert.deepEqual(info.params, params);
      const text = await render({ type: 'exit', message: reason, ...info });
      if (exit) assert.ok(text.fr.includes(String(exit)));
    } finally {
      jump.server.close();
    }
  }
});

test('frames: a refused target keeps the detail, a host key mismatch has its own sentence', async () => {
  assert.throws(() => new ConsoleSession({ target: { host: 'bad host;', port: 2001 }, ssh: {}, telnet: {}, logger: silentLogger() }), /Invalid console host/);
  const err = new Error('Host denied (verification failed)');
  const info = sshErrorInfo(err, { host: 'jump', port: 22 });
  assert.equal(info.code, 'consoles.ssh_identity');
  assert.match((await render({ type: 'exit', message: info.message, ...info })).fr, /SSH_HOST_FINGERPRINT/);
  const detail = 'Invalid console port';
  const text = await render({ type: 'error', message: detail, code: 'consoles.invalid_target', params: { detail } });
  assert.ok(text.fr.includes(detail) && text.en.includes(detail));
});

test('frames: the steps of an export carry their codes', async () => {
  let cli;
  const ios = new FakeIos({ hostname: 'S1', out: (s) => setImmediate(() => cli.feed(s)), username: 'u', password: 'p' });
  cli = new CliAutomation({ write: (s) => setImmediate(() => ios.input(s)) });
  ios.state = 'exec';
  ios.mode = 'config-if';
  const steps = [];
  try {
    await cli.exportRunningConfig((message, p) => steps.push({ message, ...p }));
  } finally {
    ios.stop();
  }
  assert.deepEqual(steps.map((s) => s.code), ['automation.looking_for_prompt', 'automation.leaving_config', 'automation.paging_off', 'automation.reading_config', 'automation.restoring_paging']);
  for (const s of steps) await render(s);
  assert.deepEqual(steps.at(-1).params, { length: 24 });
});

// ── The diagram ─────────────────────────────────────────────────────────────

test('frames: a diagram that cannot be read is reported with a code, and its notes are translated', async () => {
  const dir = tempDataDir();
  try {
    const file = path.join(dir, 'broken.drawio');
    fs.writeFileSync(file, '<mxfile><diagram>not a diagram</diagram>');
    const registry = new LabRegistry({ diagramPath: file, networkPrefix: '10.22.', isTargetAllowed: () => true, logger: silentLogger() });
    registry.load();
    const { error } = registry.model;
    assert.equal(error.code, 'consoles.diagram_load_failed');
    assert.equal(error.params.detail, error.message.replace('Diagram could not be loaded: ', ''));
    const text = await render(error);
    assert.ok(text.fr.startsWith('Le schéma n’a pas pu être chargé') && text.en.startsWith('Diagram could not be loaded'));

    const real = new LabRegistry({ diagramPath: path.join(repoRoot, 'diagrams', 'diagram.drawio'), networkPrefix: '10.22.', isTargetAllowed: () => true, logger: silentLogger() });
    real.load();
    const notes = real.model.warnings;
    assert.ok(notes.length > 0);
    for (const w of notes) await render(w);
    assert.ok(notes.some((w) => w.code === 'consoles.warn_different_devices'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => { mock.timers.reset(); for (const m of managers) m.shutdown(); });

test('pane names read as noun groups in both languages', async () => {
  const label = async (lang, kind) => {
    await i18n.setLocale(lang, { persist: false });
    return i18n.t('terminal.pane.label', { subtitle: i18n.t(`terminal.session.${kind}`), title: 'web1' });
  };
  assert.equal(await label('fr', 'serial'), 'Console série de web1');
  assert.equal(await label('fr', 'screen'), 'Écran de web1');
  assert.equal(await label('en', 'serial'), 'Serial console of web1');
  await i18n.setLocale('fr', { persist: false });
});
