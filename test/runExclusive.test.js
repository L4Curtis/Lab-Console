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
