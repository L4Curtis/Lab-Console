/**
 * Shared consoles against the mock lab: one line owned by the server, several
 * people on it. Join and replay, the keyboard changing hands (answer, timeout,
 * idle pilot, admin take-over, release, shared keyboard), spectators' keys
 * ignored, the grace period after the last one leaves, the idle timeout,
 * the refused / silent lines told apart, the journal written along
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLab } from '../dev/mock-lab.js';
import { RoomManager } from '../src/modules/consoles/roomManager.js';
import { ConsoleJournal, dayOf } from '../src/modules/consoles/journal.js';
import { SshPool } from '../src/lib/sshPool.js';
import { createStore } from '../src/lib/store.js';
import { silentLogger, tempDataDir } from './helpers/app.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const TELNET = { username: 'line', password: 'line-pass' };
const HOST = '10.22.9.211';
const user = (id, role = 'student') => ({ id: `oidc:${id}`, username: id, name: id[0].toUpperCase() + id.slice(1), role, initials: id.slice(0, 2).toUpperCase(), color: '#123456' });
const alice = user('alice');
const bob = user('bob');
const chloe = user('chloe');
const ada = user('ada', 'admin');
const device = (name, port) => ({ key: `B4M:${name}`, name, labName: 'B4M', target: { host: HOST, port } });

let lab;
let pool;
let dataDir;
let store;
const managers = [];

before(async () => {
  lab = await startMockLab({
    port: 0, ssh: SSH, telnet: TELNET,
    names: new Map([[`${HOST}:2001`, 'R1'], [`${HOST}:2002`, 'R2'], [`${HOST}:2003`, 'R3'], [`${HOST}:2004`, 'S1'], [`${HOST}:2005`, 'S2'], [`${HOST}:2006`, 'R6'], [`${HOST}:2007`, 'R7'], [`${HOST}:2008`, 'R8'], [`${HOST}:2009`, 'R9']]),
    devices: { [`${HOST}:2005`]: { start: 'silent' } },
    busyPorts: [2004],
  });
  pool = new SshPool({ channelsPerConnection: 8, idleMs: 0, logger: silentLogger() });
  dataDir = tempDataDir();
  store = createStore(dataDir, { logger: silentLogger() });
});

after(async () => {
  for (const m of managers) m.shutdown();
  pool.close();
  await lab.close();
  await store.flush();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function manager({ options = {}, limits = {}, canPilot } = {}) {
  const settings = {
    get: () => ({
      ssh: { host: '127.0.0.1', port: lab.port, ...SSH, readyTimeoutMs: 5000, keepaliveIntervalMs: 0 },
      telnet: { ...TELNET, autoLogin: true, wakeIdleMs: 150 },
      consoles: { allowedHosts: [HOST], portRange: { min: 2000, max: 2099 } },
    }),
  };
  const journal = new ConsoleJournal({ store, logger: silentLogger() });
  const m = new RoomManager({
    settings, pool, journal, canPilot,
    limits: { maxSessions: 10, maxSessionsPerClient: 5, idleTimeoutMs: 60 * 60_000, ...limits },
    options: { graceMs: 10_000, controlTimeoutMs: 10_000, pilotIdleMs: 60_000, silentMs: 600, ...options },
    logger: silentLogger(),
  });
  managers.push(m);
  return m;
}

/** A browser attached to a room: what it received, and a way to wait for it */
function browser(room, who, { readOnly = false } = {}) {
  const b = { user: who, readOnly, frames: [], text: '', closed: false };
  b.send = (f) => b.frames.push(f);
  b.sendBytes = (buf) => { b.text += buf.toString('latin1'); };
  b.close = () => { b.closed = true; };
  b.detach = room.attach(b);
  b.until = (fn, what = 'condition', ms = 6000) => until(() => fn(b), `${who.username}: ${what}`, ms);
  b.see = (re) => b.until((x) => re.test(x.text), `screen ${re}`).catch((err) => { throw new Error(`${err.message}; the screen ends with ${JSON.stringify(b.text.slice(-200))}`); });
  b.frame = (pred, what) => b.until((x) => x.frames.some(pred), what).then(() => b.frames.filter(pred).at(-1));
  b.presence = () => b.frames.filter((f) => f.type === 'presence').at(-1);
  return b;
}

async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Open the line as `who`, wait until the console server's login is done and the device answers */
async function openReady(m, d, who) {
  const room = m.open(d, who, { cols: 80, rows: 24 });
  const b = browser(room, who);
  await room.session.ready;
  room.write(who, '\r');
  await b.see(new RegExp(`${d.name}>$`));
  return { room, b };
}

test('rooms: a second person joins the same line, sees its history, and watches without a keyboard', async () => {
  const m = manager();
  const { room, b: a } = await openReady(m, device('R1', 2001), alice);
  room.write(alice, 'show clock\r');
  await a.see(/show clock[\s\S]*R1>$/);

  assert.equal(m.open(device('R1', 2001), bob), room, 'the same room');
  const b = browser(room, bob);
  const replayAt = b.frames.findIndex((f) => f.type === 'replay');
  assert.ok(replayAt >= 0 && b.frames[replayAt].bytes > 0, 'a replay frame, then the bytes');
  assert.match(b.text, /R1>show clock/, 'the history reached the newcomer');
  const p = await b.frame((f) => f.type === 'presence' && f.users.length === 2, 'presence of two');
  assert.equal(p.pilot, alice.id);
  assert.equal(p.you, bob.id);
  assert.equal(p.mayType, false);

  // A spectator's keys never reach the device
  assert.equal(room.write(bob, 'reload\r'), false);
  room.write(alice, 'show users\r');
  await a.see(/show users[\s\S]*R1>$/);
  assert.doesNotMatch(a.text, /reload/);
  assert.equal(room.summary().lastCommand, 'show users', 'the last command, rebuilt from the echo');
  assert.deepEqual(room.summary().users.map((u) => [u.name, u.pilot]), [['Alice', true], ['Bob', false]]);
  assert.equal(room.resize(bob, 100, 40), false, 'the size follows the pilot');

  room.close();
  await a.frame((f) => f.type === 'exit', 'exit');
  assert.ok(b.closed);
  assert.equal(m.get(`${HOST}:2001`), undefined);
});

test('rooms: control passes on the pilot\'s answer; a refusal keeps it; release goes to whoever asked', async () => {
  const m = manager();
  const { room, b: a } = await openReady(m, device('R2', 2002), alice);
  const b = browser(room, bob);

  assert.deepEqual(room.requestControl(bob), { ok: true, pending: true });
  const ask = await a.frame((f) => f.type === 'control' && f.event === 'request', 'the pilot is asked');
  assert.equal(ask.by.id, bob.id);
  assert.ok(Date.parse(ask.until) > Date.now());
  assert.equal(room.requestControl(chloe).code, 'consoles.control_pending', 'one request at a time');
  assert.equal(room.grantControl(bob.id, bob).code, 'consoles.control_not_pilot', 'a spectator cannot grant');

  assert.deepEqual(room.denyControl(bob.id, alice), { ok: true });
  await b.frame((f) => f.type === 'control' && f.event === 'denied', 'bob hears no');
  assert.equal(room.pilot, alice.id);

  room.requestControl(bob);
  assert.deepEqual(room.grantControl(bob.id, alice), { ok: true });
  const granted = await b.frame((f) => f.type === 'control' && f.event === 'granted', 'granted');
  assert.equal(granted.to.id, bob.id);
  assert.equal(granted.by.id, alice.id);
  assert.equal(room.pilot, bob.id);
  assert.equal(room.write(alice, 'x'), false, 'the former pilot watches now');
  assert.equal(room.write(bob, 'show version | include IOS\r'), true);
  await b.see(/show version \| include IOS/);

  // Bob lets go while Alice is asking: it goes straight to her
  room.requestControl(alice);
  room.releaseControl(bob);
  assert.equal(room.pilot, alice.id);
  room.releaseControl(alice);
  assert.equal(room.pilot, null, 'nobody asked: nobody pilots');
  assert.equal(room.write(alice, 'x'), false);
  assert.deepEqual(room.requestControl(bob), { ok: true }, 'a free keyboard is taken at once');
  assert.equal(room.pilot, bob.id);
  room.close();
});

test('rooms: no answer within the delay, or an idle pilot, and control passes anyway; an admin takes it at once', async () => {
  const m = manager({ options: { controlTimeoutMs: 200, pilotIdleMs: 400 } });
  const { room, b: a } = await openReady(m, device('R6', 2006), alice);
  const b = browser(room, bob);

  room.write(alice, '\r'); // Alice is active
  room.requestControl(bob);
  const handed = await b.frame((f) => f.type === 'control' && f.event === 'timeout', 'timeout handover');
  assert.equal(handed.to.id, bob.id);
  assert.equal(room.pilot, bob.id);
  assert.ok(a.frames.some((f) => f.type === 'control' && f.event === 'timeout'), 'the former pilot is told too');

  // Bob does not type for longer than the idle delay: Alice gets it back without waiting
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(room.requestControl(alice), { ok: true });
  assert.equal(room.pilot, alice.id);
  assert.ok(b.frames.some((f) => f.type === 'control' && f.event === 'idle'));

  // An admin, not even asking
  const d = browser(room, ada);
  room.write(alice, '\r');
  assert.equal(room.takeControl(bob).code, 'consoles.control_admin_only');
  assert.deepEqual(room.takeControl(ada), { ok: true });
  assert.equal(room.pilot, ada.id);
  await a.frame((f) => f.type === 'control' && f.event === 'takeover', 'take-over seen');
  assert.ok(d.presence());
  room.close();
});

test('rooms: a shared keyboard lets every person who may pilot type; others still only watch', async () => {
  const m = manager({ canPilot: (u) => u.id !== chloe.id });
  const { room, b: a } = await openReady(m, device('R7', 2007), alice);
  browser(room, bob);
  const c = browser(room, chloe);
  assert.equal(room.setShared(bob, true).code, 'consoles.control_not_pilot');
  assert.deepEqual(room.setShared(alice, true), { ok: true });
  assert.equal(room.write(bob, 'show ip route\r'), true);
  await a.see(/show ip route/);
  assert.equal(room.write(chloe, 'x'), false, 'chloe may watch this bench, not drive it');
  assert.equal(room.requestControl(chloe).code, 'consoles.control_not_allowed');
  const p = await c.frame((f) => f.type === 'presence' && f.shared, 'shared seen');
  assert.equal(p.canPilot, false);
  room.setShared(alice, false);
  assert.equal(room.write(bob, 'x'), false);
  room.close();
});

test('rooms: the line stays during the grace period, then hangs up; the pilot leaving frees the keyboard', async () => {
  const m = manager({ options: { graceMs: 300 } });
  const { room, b: a } = await openReady(m, device('R8', 2008), alice);
  const b = browser(room, bob);
  a.detach();
  await b.frame((f) => f.type === 'control' && f.event === 'left', 'pilot left');
  assert.equal(room.pilot, null);
  b.detach();
  assert.equal(room.closed, false, 'kept for a moment');
  const back = browser(room, bob); // a page reload within the grace period
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(room.closed, false, 'someone came back: the line stays');
  assert.equal(room.pilot, bob.id, 'an unowned line goes to the first one who may drive it');
  back.detach();
  await until(() => room.closed, 'hang-up after the grace period', 3000);
  assert.equal(m.get(`${HOST}:2008`), undefined);
  await until(() => pool.size.channels === 0 || lab.stats().channels === 0, 'the channel went back to the pool', 3000);
});

test('rooms: idle timeout; "free the line"; limits per user', async () => {
  const clock = { offset: 0 };
  const m = manager({ limits: { maxSessionsPerClient: 1, idleTimeoutMs: 60_000 } });
  const { room, b: a } = await openReady(m, device('R9', 2009), alice);
  // Alice already has one console: a second one is refused, but watching a wall tile is fine
  assert.equal(m.canOpen(device('R3', 2003), alice).code, 'consoles.client_full');
  assert.equal(m.canOpen(device('R9', 2009), alice).ok, true, 'her own room again (another tab)');
  // Nobody types for an hour: the sweep closes it
  room.now = () => Date.now() + clock.offset;
  clock.offset = 61 * 60_000;
  m.sweepIdle();
  const exit = await a.frame((f) => f.type === 'exit', 'idle exit');
  assert.equal(exit.code, 'consoles.idle_timeout');

  const again = await openReady(m, device('R9', 2009), alice);
  const watcher = browser(again.room, bob);
  assert.equal(again.room.hangUp(bob).code, 'consoles.control_not_pilot', 'a spectator cannot hang up on the pilot');
  assert.deepEqual(again.room.hangUp(alice), { ok: true });
  const freed = await watcher.frame((f) => f.type === 'exit', 'freed');
  assert.equal(freed.code, 'consoles.freed');
  assert.deepEqual(freed.params, { name: 'Alice', device: 'R9' });
});

test('rooms: a line refused by the console server, and a device that stays silent, are told apart', async () => {
  const m = manager();
  const busy = m.open(device('S1', 2004), alice);
  const b = browser(busy, alice);
  const exit = await b.frame((f) => f.type === 'exit', 'refused');
  assert.equal(exit.code, 'consoles.line_refused');
  assert.equal(exit.params.name, 'S1');
  assert.equal(exit.params.target, `${HOST}:2004`);
  assert.deepEqual(m.busyOutside(), [`${HOST}:2004`], 'shown busy outside the app');

  const silent = m.open(device('S2', 2005), alice);
  const s = browser(silent, alice);
  await silent.session.ready;
  silent.write(alice, '\r');
  const status = await s.frame((f) => f.type === 'status' && f.phase === 'silent', 'silent');
  assert.equal(status.code, 'consoles.device_silent');
  assert.deepEqual(status.params, { name: 'S2', seconds: 1 });
  assert.equal(silent.closed, false, 'the line stays open: someone may plug the cable in');
  silent.close();
});

test('rooms: the journal keeps what the device printed and who held the keyboard, never what was typed', async () => {
  const m = manager();
  const { room, b: a } = await openReady(m, device('R1', 2001), alice);
  browser(room, bob);
  room.write(alice, 'enable\r');
  await a.see(/R1#$/);
  room.requestControl(bob);
  room.grantControl(bob.id, alice);
  room.close();
  await a.frame((f) => f.type === 'exit', 'closed');
  await room.journal.close();
  await store.flush();
  const day = dayOf(Date.now());
  const log = fs.readFileSync(path.join(dataDir, 'journal', 'B4M', 'R1', `${day}.log`), 'latin1');
  assert.match(log, /R1>enable/);
  assert.match(log, /keyboard: Alice \(alice\)/);
  assert.match(log, /keyboard: Bob \(bob\)/);
  assert.doesNotMatch(log, new RegExp(TELNET.password), 'the console server password is never echoed, never journaled');
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'journal', 'B4M', 'R1', `${day}.json`), 'utf8'));
  assert.deepEqual(Object.keys(meta.attended).sort(), [alice.id, bob.id]);
  assert.deepEqual(Object.keys(meta.pilots).sort(), [alice.id, bob.id]);
  assert.equal(meta.bench, 'B4M');
  assert.equal(fs.statSync(path.join(dataDir, 'journal', 'B4M', 'R1', `${day}.log`)).mode & 0o777, 0o600);
});
