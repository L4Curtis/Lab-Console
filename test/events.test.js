/**
 * SSE hub (src/lib/events.js): an event with an audience only reaches the
 * streams whose user passes the filter - live, and when a sticky topic is
 * replayed to a tab that connects later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/lib/events.js';
import { student, admin, recordingLogger, fakeRequest, fakeResponse, sseEvents } from './helpers/fakes.js';

/** Open a stream as `user`; returns { req, res, events(), close() } */
function connect(hub, user) {
  const req = fakeRequest({ url: '/api/events', user });
  const res = fakeResponse();
  hub.handler(req, res);
  return { req, res, events: () => sseEvents(res), close: () => req.emit('close') };
}
const topics = (tab) => tab.events().map((e) => e.topic);
const isAdmin = (user) => user.role === 'admin';

test('stream: SSE headers, then events as "event: topic / data: json"', () => {
  const hub = new EventHub();
  const tab = connect(hub, student(1));
  assert.equal(tab.res.statusCode, 200);
  assert.equal(tab.res.headers['content-type'], 'text/event-stream');
  assert.equal(tab.res.chunks[0], 'retry: 3000\n\n');
  hub.publish('labs:version', { version: 3 });
  assert.equal(tab.res.chunks.at(-1), 'event: labs:version\ndata: {"version":3}\n\n');
  hub.close();
});

test('publish without audience: every tab receives it (upstream behaviour)', () => {
  const hub = new EventHub();
  const tabs = [connect(hub, student(1)), connect(hub, student(2)), connect(hub, admin())];
  hub.publish('consoles:busy', ['10.22.9.211:2001']);
  for (const tab of tabs) assert.deepEqual(tab.events(), [{ topic: 'consoles:busy', data: ['10.22.9.211:2001'] }]);
  hub.close();
});

test('publish with an audience: only the users who pass the filter receive it', () => {
  const hub = new EventHub();
  const alice = connect(hub, student(1));
  const bob = connect(hub, student(2));
  const root = connect(hub, admin());
  const occupants = new Set(['oidc:student1']);

  hub.publish('collab:chat', { bench: 'B4M', text: 'hello' }, { audience: (user) => occupants.has(user.id) || isAdmin(user) });
  assert.deepEqual(topics(alice), ['collab:chat']);
  assert.deepEqual(topics(bob), [], 'not on that bench: nothing, not even an empty event');
  assert.deepEqual(topics(root), ['collab:chat']);
  assert.equal(bob.res.chunks.join('').includes('hello'), false);
  hub.close();
});

test('the filter sees the user of each stream, several tabs included', () => {
  const hub = new EventHub();
  const seen = [];
  const tabs = [connect(hub, student(1)), connect(hub, student(1)), connect(hub, student(2))];
  hub.publish('x:y', 1, { audience: (user) => { seen.push(user.id); return user.id === 'oidc:student1'; } });
  assert.deepEqual(seen, ['oidc:student1', 'oidc:student1', 'oidc:student2']);
  assert.deepEqual(tabs.map((tab) => tab.events().length), [1, 1, 0]);
  hub.close();
});

test('toUser: every tab of that user, nobody else', () => {
  const hub = new EventHub();
  const phone = connect(hub, student(1));
  const laptop = connect(hub, student(1));
  const other = connect(hub, student(2));
  const root = connect(hub, admin());
  hub.toUser('oidc:student1', 'consoles:control', { device: 'R1', event: 'request', by: 'oidc:student2' });
  assert.deepEqual(phone.events(), [{ topic: 'consoles:control', data: { device: 'R1', event: 'request', by: 'oidc:student2' } }]);
  assert.deepEqual(laptop.events(), phone.events());
  assert.deepEqual(other.events(), []);
  assert.deepEqual(root.events(), [], 'being admin does not make a personal event yours');
  hub.toUser('oidc:nobody', 'consoles:control', {});
  assert.equal(phone.events().length, 1);
  hub.close();
});

test('sticky: the last payload is replayed to a tab that connects later', () => {
  const hub = new EventHub();
  hub.publish('consoles:busy', ['a'], { sticky: true });
  hub.publish('consoles:busy', ['a', 'b'], { sticky: true });
  hub.publish('labs:version', { version: 1 }, { sticky: true });
  hub.publish('proxmox:changed', { at: 1 }); // not sticky: gone
  const late = connect(hub, student(1));
  assert.deepEqual(late.events(), [
    { topic: 'consoles:busy', data: ['a', 'b'] },
    { topic: 'labs:version', data: { version: 1 } },
  ]);
  hub.close();
});

test('sticky replay goes through the audience filter', () => {
  const hub = new EventHub();
  hub.publish('admin:sessions', [{ user: 'oidc:student1' }], { sticky: true, audience: isAdmin });
  hub.publish('consoles:rooms', [], { sticky: true });

  const pupil = connect(hub, student(1));
  const root = connect(hub, admin());
  assert.deepEqual(topics(pupil), ['consoles:rooms'], 'the admin-only snapshot is not replayed to a student');
  assert.deepEqual(topics(root), ['admin:sessions', 'consoles:rooms']);
  assert.equal(pupil.res.chunks.join('').includes('oidc:student1'), false);

  // The audience is stored with the snapshot: a later publish replaces both
  hub.publish('admin:sessions', [], { sticky: true, audience: (user) => user.id === 'oidc:student2' });
  assert.deepEqual(topics(connect(hub, admin())), ['consoles:rooms']);
  assert.deepEqual(topics(connect(hub, student(2))), ['admin:sessions', 'consoles:rooms']);
  hub.close();
});

test('sticky replay evaluates the filter at connection time', () => {
  const hub = new EventHub();
  const occupants = new Set();
  hub.publish('benches:mine', { bench: 'B4M' }, { sticky: true, audience: (user) => occupants.has(user.id) });
  assert.deepEqual(topics(connect(hub, student(1))), []);
  occupants.add('oidc:student1');
  assert.deepEqual(topics(connect(hub, student(1))), ['benches:mine']);
  hub.close();
});

test('clear: a sticky topic is forgotten', () => {
  const hub = new EventHub();
  hub.publish('jobs:B4M', { step: 2 }, { sticky: true });
  hub.clear('jobs:B4M');
  assert.deepEqual(connect(hub, student(1)).events(), []);
  hub.close();
});

test('a stream without a user only gets unfiltered events', () => {
  const hub = new EventHub();
  hub.publish('secret:topic', 'for admins', { sticky: true, audience: () => true });
  const ghost = connect(hub, undefined);
  hub.publish('secret:topic', 'again', { audience: () => true });
  hub.toUser(undefined, 'secret:topic', 'to nobody');
  hub.publish('labs:version', { version: 1 });
  assert.deepEqual(topics(ghost), ['labs:version']);
  hub.close();
});

test('an audience that throws means "no", for that stream only, and the publisher carries on', () => {
  const log = recordingLogger();
  const hub = new EventHub({ logger: log });
  const alice = connect(hub, student(1));
  const bob = connect(hub, student(2));
  assert.doesNotThrow(() => hub.publish('x:y', 1, {
    audience: (user) => { if (user.id === 'oidc:student1') throw new Error('bench lookup failed'); return true; },
  }));
  assert.deepEqual(topics(alice), []);
  assert.deepEqual(topics(bob), ['x:y']);
  assert.match(log.lines[0].message, /audience filter of x:y failed: bench lookup failed/);
  assert.throws(() => hub.publish('x:y', 1, { audience: 'admins' }), TypeError);
  hub.close();
});

test('a closed tab receives nothing more; count() follows', () => {
  const hub = new EventHub();
  const tab = connect(hub, student(1));
  const other = connect(hub, student(2));
  assert.equal(hub.count(), 2);
  assert.equal(hub.count('oidc:student1'), 1);
  tab.close();
  hub.publish('x:y', 1);
  assert.deepEqual(tab.events(), []);
  assert.equal(other.events().length, 1);
  assert.equal(hub.count(), 1);
  assert.equal(hub.count('oidc:student1'), 0);
  hub.close();
});

test('disconnect: ends the streams of the matching users (session revoked)', () => {
  const hub = new EventHub();
  const alice = connect(hub, student(1));
  const bob = connect(hub, student(2));
  assert.equal(hub.disconnect((user) => user?.id === 'oidc:student1'), 1);
  assert.equal(alice.res.ended, true);
  assert.equal(bob.res.ended, false);
  hub.publish('x:y', 1);
  assert.deepEqual(topics(alice), []);
  assert.deepEqual(topics(bob), ['x:y']);
  hub.close();
  assert.equal(bob.res.ended, true);
  assert.equal(hub.count(), 0);
});
