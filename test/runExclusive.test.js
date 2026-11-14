/**
 * room.runExclusive on its own: the API the bench jobs (backup, injection,
 * reset) are built on. A fake line (a real CliAutomation over a stub
 * session) so each rule is checked without a lab: the handover rule, the
 * refusals, the keyboard lock, cancellation at every stage, the line closing
 * underneath, and who holds the keyboard afterwards
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConsoleRoom } from '../src/modules/consoles/room.js';
import { CliAutomation } from '../src/lib/cliAutomation.js';

const user = (id, role = 'student') => ({ id, username: id, name: id, role });
const alice = user('alice');
const bob = user('bob');
const eve = user('eve');
const ada = user('ada', 'admin');

function fakeSession({ ready = Promise.resolve() } = {}) {
  const s = new EventEmitter();
  s.typed = [];
  s.cli = new CliAutomation({ write: (text) => s.typed.push(`[cli]${text}`) });
  s.ready = ready;
  s.phase = 'connected';
  s.lastActivity = Date.now();
  s.write = (data) => { if (s.cli.running) return false; s.typed.push(data); return true; };
  s.resize = () => {};
  s.sendBreak = () => {};
  s.close = (reason, _code, info) => { s.cli.cancel(); s.emit('close', { reason, info }); };
  return s;
}

function room({ options = {}, canPilot = (u) => u.id !== eve.id, session = fakeSession() } = {}) {
  const r = new ConsoleRoom({
    device: { key: 'B4M:R1', name: 'R1', labName: 'B4M', target: { host: '10.22.9.211', port: 2001 } },
    session,
    canPilot,
    options: { controlTimeoutMs: 5000, pilotIdleMs: 60_000, graceMs: 60_000, ...options },
  });
  return r;
}

function attach(r, who) {
  const frames = [];
  const detach = r.attach({ user: who, send: (f) => frames.push(f), sendBytes() {}, close() {} });
  return { frames, detach, event: (name) => frames.find((f) => f.type === 'control' && f.event === name) };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('runExclusive: a free line runs at once, locks every keyboard while it runs, and the person keeps the keyboard', async () => {
  const r = room();
  attach(r, bob);
  r.releaseControl(bob);
  assert.equal(r.pilot, null);
  let during;
  const result = await r.runExclusive(alice, 'export', async (cli) => {
    during = { task: r.task, bobTypes: r.write(bob, 'x'), cliRunning: cli.running };
    cli.send('show run\r');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(during.task, { label: 'export', by: { id: 'alice', name: 'alice', initials: '', color: '' }, state: 'running' });
  assert.equal(during.bobTypes, false);
  assert.equal(during.cliRunning, 'export');
  assert.ok(r.session.typed.includes('[cli]show run\r'));
  assert.equal(r.task, null);
});

test('runExclusive: the pilot is asked; yes runs it, no rejects with consoles.control_refused and nothing runs', async () => {
  const r = room();
  const a = attach(r, alice);
  attach(r, bob);
  r.write(alice, 'x'); // alice is active
  let ran = 0;
  const refused = r.runExclusive(bob, 'inject', async () => { ran++; });
  await until(() => a.event('request'));
  assert.equal(a.event('request').label, 'inject');
  assert.equal(r.write(alice, 'y'), true, 'the pilot keeps typing while she decides');
  r.denyControl(bob.id, alice);
  await assert.rejects(refused, { code: 'consoles.control_refused', params: { name: 'alice' } });
  assert.equal(ran, 0);
  assert.equal(r.pilot, alice.id);
  assert.equal(r.task, null);

  const granted = r.runExclusive(bob, 'inject', async () => { ran++; return 'ok'; });
  await until(() => a.frames.filter((f) => f.event === 'request').length === 2);
  r.grantControl(bob.id, alice);
  assert.equal(await granted, 'ok');
  assert.equal(ran, 1);
  assert.equal(r.pilot, bob.id, 'the person who asked keeps the keyboard');
});

test('runExclusive: no answer within the delay, or an idle pilot, and the task runs anyway', async () => {
  const r = room({ options: { controlTimeoutMs: 80, pilotIdleMs: 200 } });
  const a = attach(r, alice);
  r.write(alice, 'x');
  const started = Date.now();
  await r.runExclusive('system', 'backup', async () => {});
  assert.ok(Date.now() - started >= 70, 'it waited for the pilot');
  assert.ok(a.event('timeout'));
  assert.equal(r.pilot, alice.id, 'a system task gives the keyboard back');

  await new Promise((res) => setTimeout(res, 220));
  const t0 = Date.now();
  await r.runExclusive('system', 'backup', async () => {});
  assert.ok(Date.now() - t0 < 60, 'an idle pilot is not waited for');
});

test('runExclusive: spectators and a second task are refused at once; so is a closed line', async () => {
  const r = room();
  attach(r, alice);
  attach(r, eve);
  await assert.rejects(r.runExclusive(eve, 'export', async () => {}), { code: 'consoles.control_not_allowed', params: { name: 'R1' } });
  let release;
  const first = r.runExclusive(alice, 'export', () => new Promise((res) => { release = res; }));
  await until(() => r.task?.state === 'running');
  await assert.rejects(r.runExclusive(alice, 'inject', async () => {}), { code: 'consoles.task_running', params: { task: 'export' } });
  await assert.rejects(r.runExclusive('system', 'reset', async () => {}), { code: 'consoles.task_running' });
  assert.equal(r.requestControl(eve).code, 'consoles.control_not_allowed');
  release();
  await first;
  r.close('bye', { code: 'consoles.closed' });
  await assert.rejects(r.runExclusive(alice, 'export', async () => {}), { code: 'consoles.room_closed' });
});

test('runExclusive: cancelled while waiting for the pilot, while waiting for the line, and while running', async () => {
  // 1. waiting for the pilot's answer
  const r = room();
  const a = attach(r, alice);
  r.write(alice, 'x');
  const ctl = new AbortController();
  const waiting = r.runExclusive(bob, 'export', async () => assert.fail('must not run'), { signal: ctl.signal });
  await until(() => a.event('request'));
  ctl.abort();
  await assert.rejects(waiting, (err) => err.cancelled === true);
  assert.equal(r.task, null);
  assert.equal(r.presence(alice).pending, null, 'the request is withdrawn');
  assert.equal(r.pilot, alice.id);

  // 2. waiting for the line to be ready (console server login not done yet)
  let ready;
  const slow = room({ session: fakeSession({ ready: new Promise((res) => { ready = res; }) }) });
  const pending = slow.runExclusive('system', 'backup', async () => assert.fail('must not run'));
  await tick();
  assert.equal(slow.task.state, 'waiting');
  assert.equal(slow.cancelTask(bob).code, 'consoles.control_not_pilot', 'someone with nothing to do with it cannot');
  assert.deepEqual(slow.cancelTask('system'), { ok: true }, 'the job that started it can');
  await assert.rejects(pending, (err) => err.cancelled === true);
  ready();

  // 3. running: the steps reject with err.cancelled and the keyboard comes back
  const run = room();
  attach(run, alice);
  attach(run, bob);
  const running = run.runExclusive(alice, 'inject', (cli) => cli.pause(10_000));
  await until(() => run.task?.state === 'running');
  assert.equal(run.cancelTask(bob).code, 'consoles.control_not_pilot', 'a spectator cannot stop someone else\'s task');
  assert.deepEqual(run.cancelTask(ada), { ok: true }, 'an admin can');
  await assert.rejects(running, (err) => err.cancelled === true);
  assert.equal(run.task, null);
  assert.equal(run.write(alice, 'z'), true, 'the keyboard is free again');
});

test('runExclusive: the line closing underneath rejects the task; a task never queues behind a person\'s request', async () => {
  const r = room();
  const a = attach(r, alice);
  attach(r, bob);
  r.write(alice, 'x');
  const running = r.runExclusive('system', 'reset', (cli) => cli.pause(10_000), {});
  await until(() => a.event('request'));
  r.grantControl(r.presence(alice).pending.from.id, alice);
  await until(() => r.task?.state === 'running');
  r.close('Connection to the jump server closed', { code: 'consoles.ssh_closed' });
  // Not a user's Stop: the job can tell a dropped line from a cancel
  await assert.rejects(running, (err) => err.code === 'consoles.room_closed' && !err.cancelled && err.params.reason === 'consoles.ssh_closed');

  const r2 = room();
  const a2 = attach(r2, alice);
  attach(r2, bob);
  r2.write(alice, 'x');
  assert.deepEqual(r2.requestControl(bob), { ok: true, pending: true });
  const task = r2.runExclusive('system', 'backup', async () => 'done');
  await until(() => a2.event('superseded'));
  assert.equal(r2.presence(alice).pending.kind, 'task');
  r2.grantControl(r2.presence(alice).pending.from.id, alice);
  assert.equal(await task, 'done');
  assert.equal(r2.pilot, alice.id);
});

test('runExclusive: a line a job opened and nobody watches hangs up after the grace period once the job ends', async () => {
  const r = room({ options: { graceMs: 50 } });
  assert.equal(await r.runExclusive('system', 'backup', async () => 'saved'), 'saved');
  await until(() => r.closed);
});

test('runExclusive: a person\'s task stops once its actor may no longer pilot: during the wait for the pilot, for the line, and while it runs; nothing more is typed', async () => {
  // 1. the bench is locked while the pilot is asked, and the pilot does not answer
  let bobMay = true;
  const rule = (u) => u.id !== eve.id && (u.id !== bob.id || bobMay);
  const r = room({ options: { controlTimeoutMs: 80 }, canPilot: rule });
  const a = attach(r, alice);
  attach(r, bob);
  r.write(alice, 'x');
  let ran = false;
  const waiting = r.runExclusive(bob, 'inject', async (cli) => { ran = true; cli.send('conf t\r'); });
  await until(() => a.event('request'));
  bobMay = false;
  await assert.rejects(waiting, { code: 'consoles.control_not_allowed', params: { name: 'R1' } });
  assert.equal(ran, false, 'the task never ran');
  assert.ok(!r.session.typed.some((x) => x.startsWith('[cli]')), 'not a byte reached the device');
  assert.equal(r.task, null);
  assert.equal(r.pilot, alice.id, 'the pilot keeps the keyboard');

  // …and when the pilot says yes after the lock
  bobMay = true;
  const granted = r.runExclusive(bob, 'inject', async () => { ran = true; });
  await until(() => r.presence(alice).pending?.kind === 'task');
  bobMay = false;
  r.grantControl(r.presence(alice).pending.from.id, alice);
  await assert.rejects(granted, { code: 'consoles.control_not_allowed' });
  assert.equal(ran, false);

  // 2. locked while the line is still logging in
  let ready;
  bobMay = true;
  const slow = room({ session: fakeSession({ ready: new Promise((res) => { ready = res; }) }), canPilot: rule });
  attach(slow, bob);
  const pending = slow.runExclusive(bob, 'export', async () => { ran = true; });
  await tick();
  assert.equal(slow.task.state, 'waiting');
  bobMay = false;
  ready();
  await assert.rejects(pending, { code: 'consoles.control_not_allowed' });
  assert.equal(ran, false);

  // 3. locked while it runs: the next byte is not sent, the task stops
  bobMay = true;
  const run = room({ canPilot: rule });
  attach(run, bob);
  const running = run.runExclusive(bob, 'inject', async (cli) => {
    cli.send('line 1\r');
    bobMay = false;
    cli.send('line 2\r');
    cli.send('line 3\r');
  });
  await assert.rejects(running, (err) => err.code === 'consoles.control_not_allowed' && !err.cancelled);
  assert.deepEqual(run.session.typed.filter((x) => x.startsWith('[cli]')), ['[cli]line 1\r']);
  assert.equal(run.task, null);
  assert.equal(run.write(bob, 'z'), false, 'and no keyboard either');

  // A system task is not a person: the bench rule does not stop it
  const job = room({ canPilot: () => false });
  assert.equal(await job.runExclusive('system', 'backup', async (cli) => { cli.send('x'); return 'ok'; }), 'ok');
});

test('runExclusive: a pilot the bench rule turned into a spectator cannot stop the task, and the keyboard passes without asking them', async () => {
  // eve pilots a free line; then a team takes the bench and eve may no longer drive
  let eveMay = true;
  const r = room({ canPilot: (u) => u.id !== eve.id || eveMay });
  const e = attach(r, eve);
  attach(r, alice);
  assert.equal(r.pilot, 'eve');
  eveMay = false;
  assert.equal(r.pilot, 'eve', 'nothing moved the keyboard yet');

  // A system job does not wait 30 s for eve's answer, and eve cannot stop it
  let release;
  const gate = new Promise((res) => { release = res; });
  const job = r.runExclusive('system', 'job:reset', async () => gate);
  await until(() => r.task?.state === 'running');
  assert.equal(e.event('request'), undefined, 'eve is not asked');
  assert.equal(r.cancelTask(eve).code, 'consoles.control_not_pilot', 'a former pilot cannot stop the team\'s job');
  assert.equal(r.task.state, 'running');
  release('done');
  assert.equal(await job, 'done');

  // A person of the team asking for the keyboard gets it at once
  assert.deepEqual(r.requestControl(alice), { ok: true });
  assert.equal(r.pilot, 'alice');

  // A paste of alice's (her task) cannot be stopped by eve either; alice and an admin can
  const paste = r.runExclusive(alice, 'paste', (cli) => cli.pause(10_000));
  await until(() => r.task?.state === 'running');
  assert.equal(r.cancelTask(eve).code, 'consoles.control_not_pilot');
  assert.equal(r.hangUp(eve).code, 'consoles.task_running', 'nor free the line under it');
  assert.deepEqual(r.cancelTask(alice), { ok: true });
  await assert.rejects(paste, (err) => err.cancelled === true);
});

test('runExclusive: a stale pilot does not block a person\'s request nor freeing an unowned line', async () => {
  let eveMay = true;
  const r = room({ canPilot: (u) => u.id !== eve.id || eveMay });
  attach(r, eve);
  attach(r, alice);
  eveMay = false;
  assert.equal(r.releaseControl(alice).code, 'consoles.control_not_pilot');
  // eve still holds the pilot slot, but alice may free the line since nobody may drive it as pilot
  const freed = r.hangUp(alice);
  assert.deepEqual(freed, { ok: true });
  assert.equal(r.closed, true);
});

test('runExclusive: with privateOutput, what the device prints reaches only the accepted people, never the replay nor the journal', async () => {
  const marks = [];
  const outputs = [];
  const journal = { output: (b) => outputs.push(Buffer.from(b).toString()), mark: (t) => marks.push(t), attended() {}, watched() {}, piloted() {}, close() {} };
  const session = fakeSession();
  const r = new ConsoleRoom({
    device: { key: 'B4M:R1', name: 'R1', labName: 'B4M', target: { host: '10.22.9.211', port: 2001 } },
    session, journal, canPilot: () => true,
    options: { controlTimeoutMs: 5000, pilotIdleMs: 60_000, graceMs: 60_000 },
  });
  const seen = new Map();
  const join = (u) => {
    seen.set(u.id, '');
    r.attach({ user: u, send() {}, sendBytes: (b) => seen.set(u.id, seen.get(u.id) + Buffer.from(b).toString()), close() {} });
  };
  join(alice);
  join(bob);
  r.releaseControl(alice); // a free line: the job does not wait for an answer
  session.emit('data', Buffer.from('R1#\r\n'));
  await r.runExclusive('system', 'job:backup', async () => {
    session.emit('data', Buffer.from('hostname R1\r\nline con 0\r\nend\r\nR1#'));
    assert.match(r.screen(), /line con 0/, 'the driver still reads the screen');
  }, { privateOutput: (u) => u.id === 'alice' || u.role === 'admin' });
  session.emit('data', Buffer.from('\r\nR1#'));

  assert.match(seen.get('alice'), /line con 0/, 'the team sees its job');
  assert.doesNotMatch(seen.get('bob'), /line con 0/, 'an outsider does not');
  assert.match(seen.get('bob'), /R1#/, 'but still sees the line before and after');
  assert.doesNotMatch(r.scrollback.toString(), /line con 0/, 'not in the replay nor the history');
  assert.doesNotMatch(r.screen(), /line con 0/, 'nor in the screen once the task is over');
  assert.doesNotMatch(outputs.join(''), /line con 0/, 'not in the journal');
  assert.ok(marks.some((m) => /job:backup not recorded/.test(m)), 'the journal says why');
  join(eve);
  assert.doesNotMatch(seen.get('eve'), /line con 0/, 'a newcomer is not replayed it');
  r.releaseControl(eve);

  // Without the option, a task's output stays public as before
  await r.runExclusive('system', 'job:other', async () => { session.emit('data', Buffer.from('public line\r\n')); });
  assert.match(seen.get('bob'), /public line/);
  assert.match(outputs.join(''), /public line/);
});
