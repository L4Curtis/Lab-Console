/**
 * The terminal tools of a console (SPEC "Lot terminal"), over the real
 * WebSocket and the HTTP API, against a simulated lab whose devices are slow
 * (a 9600-baud console: a small input buffer that drops what arrives too
 * fast):
 *   - a multi-line paste goes through the room, paced like an injection, and
 *     only for whoever may type; a spectator's paste is refused;
 *   - the same lines sent to several consoles are run only where the person
 *     is the pilot, each console answering for itself;
 *   - the history of a console: searched and downloaded as plain text, the
 *     room's output by the people on it, the journal by those who may read it
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMockLab } from '../dev/mock-lab.js';
import { startTestApp, repoRoot } from './helpers/app.js';
import { student } from './helpers/fakes.js';
import { connectConsole, openReady, until } from './helpers/consoleClient.js';
import { parseDrawio } from '../src/modules/consoles/drawio.js';
import { createConsolesModule } from '../src/modules/consoles/index.js';
import { dayOf } from '../src/modules/consoles/journal.js';
import { createAutomationHandler } from '../src/lib/automationProtocol.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const TELNET = { username: 'line', password: 'line-pass' };

let lab;
let app;
let devices;
const bench = (name) => devices.filter((d) => d.labName === name);
const targetOf = (d) => `${d.target.host}:${d.target.port}`;
const sim = (d) => lab.device(targetOf(d));

before(async () => {
  const names = new Map();
  const { labs } = parseDrawio(fs.readFileSync(`${repoRoot}/diagrams/diagram.drawio`, 'utf8'), { networkPrefix: '10.22.9' });
  devices = labs.flatMap((l) => l.devices.map((d) => ({ ...d, labName: l.name })));
  for (const d of devices) names.set(targetOf(d), d.name);
  lab = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, names, slowConsole: true });
  app = await startTestApp({
    env: {
      SSH_HOST: '127.0.0.1', SSH_PORT: String(lab.port), SSH_USERNAME: SSH.username, SSH_PASSWORD: SSH.password,
      TELNET_USERNAME: TELNET.username, TELNET_PASSWORD: TELNET.password, TELNET_WAKE_IDLE_MS: '150',
    },
    modules: (deps) => [createConsolesModule(deps, { rooms: { controlTimeoutMs: 10_000 } })],
  });
});

after(async () => {
  await app?.close();
  await lab?.close();
});

const open = (who, device) => openReady(app, who, device);
const connect = (who, device, extra) => connectConsole(app, who, device, extra);
const idle = (device) => until(() => sim(device).queue.length === 0 && !sim(device).busy, `${device.name} idle`);

const CONFIG = [
  'enable', 'configure terminal', 'hostname PASTED', 'interface loopback 10', ' description pasted', ' ip address 10.10.10.1 255.255.255.255',
  ' no shutdown', 'exit', 'interface loopback 11', ' description second', ' ip address 10.10.11.1 255.255.255.255', ' no shutdown', 'end',
].join('\n');

describe('paste', () => {
  test('a multi-line paste is paced like an injection: the device gets every line, where the same text typed as keystrokes overruns its input buffer', async () => {
    const [first, second] = bench('B4M');
    const paced = await open('student1', first);
    paced.send({ type: 'paste', script: `${CONFIG}\n` });
    const done = await paced.outcome('paste');
    assert.equal(done.state, 'done', done.message);
    assert.deepEqual([done.result.sent, done.result.total, done.result.errors.length], [13, 13, 0]);
    assert.equal(sim(first).cfg.hostname, 'PASTED');
    assert.deepEqual(sim(first).cfg.interfaces.get('Loopback11')?.lines, ['description second', 'ip address 10.10.11.1 255.255.255.255'], 'the last interface made it');
    assert.equal(sim(first).dropped, 0);
    await paced.see(/PASTED#/);

    // The same text as keystrokes arrives faster than the device reads it
    const raw = await open('student1', second);
    raw.type(`${CONFIG.replaceAll('\n', '\r')}\r`);
    await until(() => sim(second).dropped > 0, 'the device dropped bytes');
    await idle(second);
    assert.ok(!sim(second).cfg.interfaces.has('Loopback11'), 'the unpaced paste lost its end');
    await paced.close();
    await raw.close();
  });

  test('a paste sends the lines as copied, comments and blank lines included, where an injection skips the comments', async () => {
    const device = bench('B4M')[2];
    const c = await open('student1', device);
    const script = '! a note\nshow clock\n\n! another\n';
    c.send({ type: 'paste', script });
    assert.deepEqual([(await c.outcome('paste')).result.total], [4]);
    c.send({ type: 'inject', script });
    assert.deepEqual([(await c.outcome('inject')).result.total], [2]);
    await c.close();
  });

  test('refusal: someone who does not hold the keyboard cannot paste - nothing reaches the device', async () => {
    const device = bench('B4M')[3];
    const pilot = await open('student1', device);
    const watcher = connect('student2', device);
    await watcher.frame((f) => f.type === 'presence' && f.users.length === 2, 'two people');
    watcher.send({ type: 'paste', script: 'hostname WATCHER\nshow clock\n' });
    const refused = await watcher.outcome('paste');
    assert.equal(refused.state, 'error');
    assert.equal(refused.code, 'consoles.paste_not_allowed');
    assert.deepEqual(refused.params, { name: device.name });
    assert.equal(sim(device).cfg.hostname, device.name, 'untouched');
    assert.ok(!pilot.frames.some((f) => f.type === 'automation'), 'the pilot was not bothered: the refusal is for the asker alone');
    // The pilot, meanwhile, can
    pilot.send({ type: 'paste', script: 'show clock\nshow ip interface brief\n' });
    assert.equal((await pilot.outcome('paste')).state, 'done');
    await pilot.close();
    await watcher.close();
  });

  test('refusal: someone who may not pilot the bench watches and cannot paste, even once the line has no pilot', async () => {
    const device = bench('B4M')[4];
    const before = app.deps.services.benches;
    app.deps.services.benches = { canPilot: (user) => user.id !== 'oidc:student3' };
    try {
      const pilot = await open('student1', device);
      const outsider = connect('student3', device);
      await outsider.frame((f) => f.type === 'presence' && f.canPilot === false, 'a spectator');
      outsider.send({ type: 'paste', script: 'hostname OUTSIDER\nshow clock\n' });
      assert.equal((await outsider.outcome('paste')).code, 'consoles.paste_not_allowed');
      await pilot.close();
      outsider.send({ type: 'paste', script: 'hostname OUTSIDER\nshow clock\n' });
      await outsider.until((x) => x.frames.filter((f) => f.type === 'automation' && f.task === 'paste').length >= 2 || x.closed, 'a second answer');
      assert.notEqual(sim(device).cfg.hostname, 'OUTSIDER');
      await outsider.close();
    } finally {
      app.deps.services.benches = before;
    }
  });

  test('refusal: a wall tile only watches; a paste on it is ignored; another task running refuses the paste', async () => {
    const device = bench('B4M')[5];
    const pilot = await open('student1', device);
    const wall = connect('student1', device, '&mode=wall');
    await wall.frame((f) => f.type === 'replay', 'attached');
    wall.send({ type: 'paste', script: 'hostname WALL\nshow clock\n' });
    wall.send({ type: 'broadcast', batch: 'wall', script: 'hostname WALL\n' });
    // Whatever the wall tile sent was dropped, the pilot's paste still runs next
    pilot.send({ type: 'inject', script: Array.from({ length: 6 }, () => 'show clock').join('\n') });
    await pilot.frame((f) => f.type === 'automation' && f.task === 'inject' && f.state === 'running', 'inject running');
    pilot.send({ type: 'paste', script: 'show ip interface brief\nshow clock\n' });
    const busy = await pilot.frame((f) => f.type === 'automation' && f.task === 'paste' && f.state === 'error', 'busy');
    assert.equal(busy.code, 'automation.busy');
    await pilot.outcome('inject');
    assert.ok(!wall.frames.some((f) => f.type === 'automation' && f.state === 'error' && f.code?.startsWith('consoles.')), 'the wall tile got no answer: its frames are dropped');
    assert.notEqual(sim(device).cfg.hostname, 'WALL');
    await wall.close();
    await pilot.close();
  });

  test('bad input: an empty paste, too many lines, too large a text - answered, the socket stays open', async () => {
    const device = bench('B4M')[6];
    const c = await open('student1', device);
    c.send({ type: 'paste', script: '  \n\n' });
    assert.equal((await c.outcome('paste')).code, 'automation.script_empty');
    c.send({ type: 'paste', script: 'x\n'.repeat(5001) });
    const long = await c.frame((f) => f.task === 'paste' && f.code === 'automation.script_too_long', 'too long');
    assert.equal(long.params.max, 5000);
    // 260 KB is over the limit of the automation but under what the socket takes: it is answered, not cut off
    c.send({ type: 'paste', script: 'a'.repeat(260 * 1024) });
    await c.frame((f) => f.task === 'paste' && f.code === 'automation.script_too_large', 'too large');
    c.send({ type: 'paste' });
    c.send({ type: 'paste', script: 42 });
    assert.equal(c.closed, false);
    c.send({ type: 'paste', script: 'show clock\n' });
    assert.equal((await c.frame((f) => f.task === 'paste' && f.state === 'done', 'still works')).state, 'done');
    await c.close();
  });

  test('a console that does not offer paste or broadcast (a Proxmox serial console) ignores both frames', () => {
    const handle = createAutomationHandler({ cli: { running: false }, send() { throw new Error('nothing to send'); }, canExport: false, log: { info() {} }, label: 'vm' });
    assert.equal(handle({ type: 'paste', script: 'show clock\n' }), false);
    assert.equal(handle({ type: 'broadcast', script: 'show clock\n', batch: 'x' }), false);
    assert.equal(handle({ type: 'unknown' }), false);
  });
});

describe('broadcast', () => {
  test('the same lines run on every console the person pilots; each answers for itself, with the batch it was sent in', async () => {
    const [a, b] = bench('B4B').filter((d) => d.name.startsWith('R')); // routers: their output lists serial interfaces
    const one = await open('student1', a);
    const two = await open('student1', b);
    for (const c of [one, two]) c.send({ type: 'broadcast', batch: 'run-1', script: 'show clock\nshow ip interface brief\n' });
    const [x, y] = await Promise.all([one.outcome('broadcast', undefined, 'run-1'), two.outcome('broadcast', undefined, 'run-1')]);
    for (const [c, outcome] of [[one, x], [two, y]]) {
      assert.equal(outcome.state, 'done', outcome.message);
      assert.deepEqual([outcome.result.sent, outcome.result.total, outcome.batch], [2, 2, 'run-1']);
      await c.see(/show ip interface brief[\s\S]*Serial0\/0\/1/);
    }
    assert.ok(one.frames.some((f) => f.task === 'broadcast' && f.state === 'running' && f.batch === 'run-1'), 'progress carries the batch too');
    await one.close();
    await two.close();
  });

  test('refusal: a console the person does not pilot is refused and left alone, while the others run', async () => {
    const [mine, theirs, sharedKeyboard] = bench('B4H');
    const own = await open('student1', mine);
    const owner = await open('student2', theirs);
    const watching = connect('student1', theirs);
    await watching.frame((f) => f.type === 'presence' && f.users.length === 2 && f.mayType === false, 'watching');
    const typist = await open('student2', sharedKeyboard);
    const guest = connect('student1', sharedKeyboard);
    await guest.frame((f) => f.type === 'presence' && f.users.length === 2, 'guest');
    typist.send({ type: 'control', action: 'share' });
    await guest.frame((f) => f.type === 'presence' && f.shared && f.mayType, 'the keyboard is shared: student1 may type');

    const marker = 'show clock';
    for (const c of [own, watching, guest]) c.send({ type: 'broadcast', batch: 'mixed', script: `${marker}\n` });
    assert.equal((await own.outcome('broadcast', undefined, 'mixed')).state, 'done');
    for (const c of [watching, guest]) {
      const refused = await c.outcome('broadcast', undefined, 'mixed');
      assert.deepEqual([refused.state, refused.code], ['error', 'consoles.broadcast_not_pilot'], c.device.name);
    }
    assert.deepEqual(watching.frames.find((f) => f.code === 'consoles.broadcast_not_pilot').params, { name: theirs.name });
    // Typing on a shared keyboard is not piloting: not even this person's own text got through
    assert.doesNotMatch(owner.text, new RegExp(marker), 'the other pilot\'s console saw nothing');
    assert.doesNotMatch(typist.text, new RegExp(marker));
    for (const c of [own, owner, watching, typist, guest]) await c.close();
  });

  test('a person\'s own console that another task holds, too many lines, an empty text: answered per console', async () => {
    const [a] = bench('B5B');
    const c = await open('student1', a);
    c.send({ type: 'broadcast', batch: 'long', script: 'show clock\n'.repeat(51) });
    const long = await c.outcome('broadcast', undefined, 'long');
    assert.deepEqual([long.code, long.params.max], ['automation.script_too_long', 50]);
    c.send({ type: 'broadcast', batch: 'empty', script: '\n' });
    assert.equal((await c.outcome('broadcast', undefined, 'empty')).code, 'automation.script_empty');
    c.send({ type: 'inject', script: Array.from({ length: 5 }, () => 'show clock').join('\n') });
    await c.frame((f) => f.task === 'inject' && f.state === 'running', 'inject running');
    c.send({ type: 'broadcast', batch: 'busy', script: 'show clock\n' });
    assert.equal((await c.outcome('broadcast', undefined, 'busy')).code, 'automation.busy');
    await c.outcome('inject');

    // A batch name that is not a plain token is not echoed (it is only a label)
    c.send({ type: 'broadcast', batch: '<b>x</b>', script: 'show clock\n' });
    const odd = await c.frame((f) => f.task === 'broadcast' && f.state === 'done' && f.batch === undefined, 'untagged');
    assert.equal(odd.batch, undefined);
    await c.close();
  });

  test('the audit trail names the task, never the lines', async () => {
    const entries = await app.deps.audit.query({ action: 'console.task', limit: 1000 });
    const tasks = new Set(entries.map((e) => e.details.task));
    assert.ok(tasks.has('paste') && tasks.has('broadcast'), [...tasks].join(','));
    assert.doesNotMatch(JSON.stringify(entries), /hostname PASTED|show ip interface/);
  });
});

describe('history of a console', () => {
  const get = (who, path) => fetch(`${app.url}${path}`, { headers: who ? app.as(who) : {} });
  const history = async (who, device, query = '') => (await get(who, `/api/consoles/history?device=${encodeURIComponent(device.key)}${query}`)).json();
  let device;
  let pilot;

  before(async () => {
    device = bench('B6B')[0];
    pilot = await open('student1', device);
    pilot.type('show clock\r');
    await pilot.see(/show clock[\s\S]*>$/);
    pilot.type('show users\r');
    await pilot.see(/show users[\s\S]*>$/);
  });
  after(async () => { await pilot.close(); });

  test('the people on the console search what it shows, as text: no case unless asked, never a pattern', async () => {
    const found = await history('student1', device, '&q=SHOW%20clock');
    assert.deepEqual([found.live.attached, found.live.open], [true, true]);
    assert.ok(found.live.total >= 1);
    assert.match(found.live.matches[0].text, new RegExp(`^${device.name}>show clock$`));
    assert.equal(found.live.matches[0].n >= 1, true);
    assert.equal((await history('student1', device, '&q=SHOW%20clock&case=1')).live.total, 0);
    assert.equal((await history('student1', device, '&q=.*')).live.total, 0);
    const overview = await history('student1', device);
    assert.equal(overview.live.matches, undefined, 'no search, no matches');
    assert.ok(overview.live.lines > 5);
    assert.deepEqual(overview.device, { bench: 'B6B', name: device.name });
  });

  test('refusal: someone not on the console cannot read what it shows', async () => {
    const outsider = await history('student3', device, '&q=show');
    assert.deepEqual([outsider.live.attached, outsider.live.open, outsider.live.lines], [false, true, 0]);
    assert.equal(outsider.live.matches, undefined);
    const download = await get('student3', `/api/consoles/history/download?device=${encodeURIComponent(device.key)}`);
    assert.equal(download.status, 403);
    assert.equal((await download.json()).code, 'consoles.history_forbidden');
  });

  test('the journal answers to its own rule: those who were on the console that day, not a spectator who may not drive', async () => {
    let mine;
    for (let i = 0; i < 100; i++) {
      mine = await history('student1', device, '&q=show%20users');
      if (mine.journal?.total > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual([mine.journal.exists, mine.journal.allowed], [true, true]);
    assert.ok(mine.journal.total >= 1, 'found in the journal');
    assert.match(mine.journal.matches[0].text, /show users$/);
    assert.deepEqual([mine.journal.matches[0].day, mine.journal.days.map((d) => d.day)], [dayOf(Date.now()), [dayOf(Date.now())]]);
    assert.match(mine.journal.matches[0].id, /^B6B\/.+\/\d{4}-\d{2}-\d{2}\/\d{6}/);

    const admin = await history('admin', device, '&q=show%20users');
    assert.equal(admin.journal.allowed, true, 'admins read every journal');

    // A person who never was on it
    const stranger = await history('student3', device, '&q=show%20users');
    assert.deepEqual([stranger.journal.exists, stranger.journal.allowed, stranger.journal.days, stranger.journal.matches], [true, false, [], undefined]);

    // A spectator who may not drive sees the room's output while attached, and still reads no journal
    const before = app.deps.services.benches;
    app.deps.services.benches = { canPilot: (user) => user.id !== 'oidc:student2' };
    const watcher = connect('student2', device);
    try {
      await watcher.frame((f) => f.type === 'presence' && f.canPilot === false, 'a spectator');
      const seen = await history('student2', device, '&q=show%20users');
      assert.equal(seen.live.attached, true);
      assert.ok(seen.live.total >= 1, 'the output of the room, which they were replayed anyway');
      assert.deepEqual([seen.journal.allowed, seen.journal.matches], [false, undefined]);
    } finally {
      await watcher.close();
      app.deps.services.benches = before;
    }
  });

  test('download: the room\'s output as a text file, a day of the journal as one text file; each audited', async () => {
    const screen = await get('student1', `/api/consoles/history/download?device=${encodeURIComponent(device.key)}`);
    assert.equal(screen.status, 200);
    assert.match(screen.headers.get('content-type'), /^text\/plain/);
    assert.match(screen.headers.get('content-disposition'), /^attachment; filename="history_B6B_[\w.-]+_\d{8}_\d{4}\.txt"$/);
    const text = await screen.text();
    assert.match(text, new RegExp(`^${device.name}>show clock$`, 'm'));
    assert.doesNotMatch(text, /\x1b|\r/, 'plain text');

    const day = dayOf(Date.now());
    const journal = await get('student1', `/api/consoles/history/download?device=${encodeURIComponent(device.key)}&day=${day}`);
    assert.equal(journal.status, 200);
    assert.match(journal.headers.get('content-disposition'), new RegExp(`filename="journal_B6B_[\\w.-]+_${day}\\.txt"`));
    const body = await journal.text();
    assert.match(body, new RegExp(`^===== B6B / ${device.name} - ${day} - session \\d{6}`, 'm'));
    assert.match(body, /show users/);

    const refused = await get('student3', `/api/consoles/history/download?device=${encodeURIComponent(device.key)}&day=${day}`);
    assert.deepEqual([refused.status, (await refused.json()).code], [403, 'consoles.journal_forbidden']);
    const none = await get('student1', `/api/consoles/history/download?device=${encodeURIComponent(device.key)}&day=2001-01-01`);
    assert.deepEqual([none.status, (await none.json()).code], [404, 'consoles.no_journal']);
    const bad = await get('student1', `/api/consoles/history/download?device=${encodeURIComponent(device.key)}&day=../etc`);
    assert.deepEqual([bad.status, (await bad.json()).code], [400, 'consoles.bad_journal']);
    const closed = await get('student1', `/api/consoles/history/download?device=${encodeURIComponent(bench('B6H')[0].key)}`);
    assert.deepEqual([closed.status, (await closed.json()).code], [404, 'consoles.room_gone']);

    const entries = await app.deps.audit.query({ action: 'console', limit: 1000 });
    assert.ok(entries.some((e) => e.action === 'console.history.download' && e.details.source === 'screen' && e.actor.id === 'oidc:student1'));
    assert.ok(entries.some((e) => e.action === 'console.journal.download' && e.details.day === day && e.details.session === 'all'));
    assert.ok(!entries.some((e) => e.actor.id === 'oidc:student3' && /download/.test(e.action)), 'a refused download leaves no download entry');
  });

  test('bad requests: no session, unknown device, empty or too long a search', async () => {
    assert.equal((await get(null, `/api/consoles/history?device=${encodeURIComponent(device.key)}`)).status, 401);
    assert.equal((await get(null, `/api/consoles/history/download?device=${encodeURIComponent(device.key)}`)).status, 401);
    const gone = await get('student1', '/api/consoles/history?device=nope');
    assert.deepEqual([gone.status, (await gone.json()).code], [404, 'consoles.device_gone']);
    const none = await get('student1', '/api/consoles/history');
    assert.equal(none.status, 404);
    const blank = await get('student1', `/api/consoles/history?device=${encodeURIComponent(device.key)}&q=%20%20`);
    assert.deepEqual([blank.status, (await blank.json()).code], [400, 'consoles.bad_query']);
    const long = await get('student1', `/api/consoles/history?device=${encodeURIComponent(device.key)}&q=${'x'.repeat(201)}`);
    const body = await long.json();
    assert.deepEqual([long.status, body.code, body.params.max], [400, 'consoles.bad_query', 200]);
  });

  test('a person may search 30 times a minute', async () => {
    const who = student(7);
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await get(who, `/api/consoles/history?device=${encodeURIComponent(device.key)}`)).status);
    assert.deepEqual([codes.slice(0, 30).every((c) => c === 200), codes[30]], [true, 429]);
    const refused = await (await get(who, `/api/consoles/history?device=${encodeURIComponent(device.key)}`)).json();
    assert.equal(refused.code, 'consoles.too_many_searches');
  });
});
