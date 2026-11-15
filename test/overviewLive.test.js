/**
 * The browser side of the overview that can be checked without a browser:
 * how the pages stay live (public/js/modules/overview/live.js). Read the API
 * once for a burst of events, not while the section is hidden, again when
 * something moved during a read, and ignore the events that move nothing on
 * screen (a command typed on a console)
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const sources = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = new Map(); sources.push(this); }
  addEventListener(topic, fn) { this.listeners.set(topic, fn); }
  close() { this.closed = true; }
}
let reads = [];
let release = null; // when set, a read waits until it is called
globalThis.EventSource = FakeEventSource;
globalThis.fetch = async (url) => {
  reads.push(url);
  if (release) await new Promise((resolve) => { release = resolve; });
  return { ok: true, json: async () => ({ n: reads.length }) };
};
const { followApi, roomsSignature } = await import('../public/js/modules/overview/live.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Deliver an SSE event to the stream that is open */
const emit = (topic, data) => sources.filter((s) => !s.closed).at(-1).listeners.get(topic)({ data: JSON.stringify(data) });
const settle = () => sleep(400); // the pause is 250 ms

let seq = 0;
const topic = (name) => `test:${name}-${seq += 1}`;
beforeEach(() => { reads = []; release = null; });
after(() => { delete globalThis.EventSource; });

function follow(topics, extra = {}) {
  const got = [];
  const feed = followApi('/api/x', { topics, onData: (d) => got.push(d), ...extra });
  return { feed, got };
}

test('a section that is not on screen reads nothing, and catches up when it is shown', async () => {
  const a = topic('a');
  const { feed, got } = follow([a]);
  await sleep(20);
  emit(a, {});
  await settle();
  assert.equal(reads.length, 0, 'hidden: no read');
  feed.show();
  await sleep(50);
  assert.equal(reads.length, 1, 'shown: the read that was owed');
  assert.deepEqual(got, [{ n: 1 }]);
  feed.hide();
  emit(a, {});
  await settle();
  assert.equal(reads.length, 1, 'hidden again: nothing');
  feed.show();
  await sleep(50);
  assert.equal(reads.length, 2, 'moved while hidden: read on show');
});

test('a burst of events is one read, and a quiet section is not read again', async () => {
  const a = topic('burst');
  const { feed } = follow([a]);
  feed.show();
  await sleep(50);
  const first = reads.length;
  for (let i = 0; i < 20; i += 1) emit(a, { i });
  await settle();
  assert.equal(reads.length - first, 1);
  await settle();
  assert.equal(reads.length - first, 1, 'nothing moved since');
  feed.hide();
});

test('an event during a read is followed by one more read', async () => {
  const a = topic('during');
  const { feed, got } = follow([a]);
  feed.show();
  await sleep(50);
  reads = []; got.length = 0;
  release = () => {};
  emit(a, {});
  await sleep(300); // the read starts and waits
  assert.equal(reads.length, 1);
  emit(a, {}); // something moves while it is under way
  await sleep(300);
  release();
  await sleep(50);
  release = null;
  await settle();
  assert.equal(reads.length, 2, 'one more read, not two');
  feed.hide();
});

test('an event whose signature did not change moves nothing', async () => {
  const a = topic('sig');
  const { feed } = follow([a], { changed: { [a]: (data) => data.shown } });
  feed.show();
  await sleep(50);
  const first = reads.length;
  emit(a, { shown: 'x', typed: 'show clock' });
  await settle();
  const afterFirst = reads.length;
  assert.equal(afterFirst - first, 1, 'a new signature is read');
  emit(a, { shown: 'x', typed: 'show version' });
  await settle();
  assert.equal(reads.length, afterFirst, 'same signature, another command: not read');
  emit(a, { shown: 'y' });
  await settle();
  assert.equal(reads.length, afterFirst + 1);
  feed.hide();
});

test('a failed read is reported, and refresh() tries again', async () => {
  const a = topic('error');
  const errors = [];
  const feed = followApi('/api/x', { topics: [a], onData() {}, onError: (e) => errors.push(e) });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  feed.show();
  await sleep(100);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 500);
  globalThis.fetch = real;
  feed.refresh();
  await sleep(100);
  assert.equal(reads.length, 1, 'read again');
  feed.hide();
});

test('what the overview shows of the consoles: line, state, pilot, people, task, shared keyboard', () => {
  const room = (extra = {}) => ({ target: '10.0.0.1:2001', state: 'connected', pilot: { id: 'u1' }, shared: false, task: null, users: [{ id: 'u1' }, { id: 'u2' }], lastCommand: 'show clock', lastActivity: 'a', ...extra });
  const base = roomsSignature([room()]);
  assert.equal(roomsSignature([room({ lastCommand: 'show version', lastActivity: 'b' })]), base, 'a command moves nothing');
  assert.equal(roomsSignature([room({ users: [{ id: 'u2' }, { id: 'u1' }] })]), base, 'order of people does not matter');
  for (const change of [{ state: 'silent' }, { pilot: { id: 'u2' } }, { pilot: null }, { shared: true }, { task: { label: 'job:backup' } }, { users: [{ id: 'u1' }] }, { target: '10.0.0.1:2002' }]) {
    assert.notEqual(roomsSignature([room(change)]), base, JSON.stringify(change));
  }
  assert.notEqual(roomsSignature([room(), room({ target: 'b' })]), base, 'another line open');
  assert.equal(roomsSignature(undefined), '');
  assert.equal(roomsSignature([]), '');
});
