/**
 * Group work (SPEC "Lot collab"): the shared note of a device and the chat of
 * a bench - who may read and write, what is refused, who hears about it over
 * SSE, and that the chat stays with the team that held the bench
 *
 * The notifications are browser work, checked in test/e2e/collab.e2e.js
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTeamsApp, waitFor, T0 } from './helpers/teams.js';
import { memoryDatabase } from './helpers/db.js';
import { student, admin } from './helpers/fakes.js';
import { createCollabModule } from '../src/modules/collab/index.js';

const S = (n) => student(n);
const ADMIN = admin();

async function makeTeam(t, name, ...people) {
  const [first, ...rest] = people;
  const { body, status } = await t.api(first, 'POST', '/api/teams', { name });
  assert.equal(status, 201, JSON.stringify(body));
  for (const p of rest) {
    await t.api(first, 'POST', `/api/teams/${body.team.id}/invitations`, { username: p.username });
    assert.equal((await t.api(p, 'POST', `/api/teams/${body.team.id}/accept`)).status, 200);
  }
  return body.team.id;
}

const deviceKey = (t, bench, name) => {
  const lab = t.services.consoles.registry.model.labs.find((l) => l.name === bench);
  return lab.devices.find((d) => d.name === name).key;
};
const noteUrl = (key) => `/api/collab/notes/${encodeURIComponent(key)}`;

/** The application with the collab module, a fake clock for the chat, and limits the tests can lower */
const startCollab = (limits = {}) => {
  let module;
  return startTeamsApp({
    extra: (deps) => {
      module = createCollabModule(deps, { now: () => clockMs.value, limits, sweepMs: 0 });
      return module;
    },
  }).then((t) => Object.assign(t, { collab: module }));
};
const clockMs = { value: T0 };

describe('repository: notes and chat in the database', () => {
  test('a note is saved against the revision it started from', async (c) => {
    const { repos, close } = await memoryDatabase();
    c.after(close);
    const base = { key: 'p1:c2', bench: 'B4M', device: 'R1', text: 'first', by: { id: 'oidc:a', name: 'Ada' }, at: T0 };
    const first = await repos.collab.saveNote(base, 0);
    assert.equal(first.rev, 1);
    assert.equal(first.text, 'first');
    assert.equal(await repos.collab.saveNote({ ...base, text: 'again from nothing' }, 0), null, 'a note exists: starting from 0 is stale');
    assert.equal(await repos.collab.saveNote({ ...base, text: 'stale' }, 5), null);
    const second = await repos.collab.saveNote({ ...base, text: 'second' }, 1);
    assert.equal(second.rev, 2);
    assert.deepEqual((await repos.collab.notes()).map((n) => [n.key, n.text, n.rev]), [['p1:c2', 'second', 2]]);
    assert.equal(await repos.collab.removeNote('p1:c2', 1), false, 'stale revision');
    assert.equal(await repos.collab.removeNote('p1:c2', 2), true);
    assert.equal(await repos.collab.note('p1:c2'), null);
  });

  test('a thread keeps its last messages, in order, and threads are separate', async (c) => {
    const { repos, close } = await memoryDatabase();
    c.after(close);
    const author = { id: 'oidc:a', name: 'Ada' };
    for (let i = 1; i <= 7; i++) await repos.collab.addMessage({ teamId: 'T1', bench: 'B4M', author, text: `m${i}`, at: T0 + i }, 5);
    await repos.collab.addMessage({ teamId: 'T2', bench: 'B4M', author, text: 'other team', at: T0 }, 5);
    await repos.collab.addMessage({ teamId: 'T1', bench: 'B4H', author, text: 'other bench', at: T0 }, 5);
    assert.deepEqual((await repos.collab.messages('T1', 'B4M', 100)).map((m) => m.text), ['m3', 'm4', 'm5', 'm6', 'm7']);
    assert.deepEqual((await repos.collab.messages('T1', 'B4M', 2)).map((m) => m.text), ['m6', 'm7'], 'the newest, oldest first');
    assert.deepEqual((await repos.collab.messages('T2', 'B4M', 100)).map((m) => m.text), ['other team']);
    assert.deepEqual(await repos.collab.threadTeams(), ['T1', 'T2']);
    await repos.collab.removeTeam('T1');
    assert.deepEqual(await repos.collab.threadTeams(), ['T2']);
  });
});

describe('notes: who reads, who writes', () => {
  let t;
  let key;
  let otherBenchKey;
  before(async () => {
    t = await startCollab();
    key = deviceKey(t, 'B4M', 'R1');
    otherBenchKey = deviceKey(t, 'B4B', 'R1');
    await makeTeam(t, 'Équipe A', S(1), S(2));
    await makeTeam(t, 'Équipe B', S(4));
    assert.equal((await t.api(S(1), 'POST', '/api/benches/B4M/take')).status, 200);
    // S3 is a guest of the bench
    assert.equal((await t.api(S(3), 'POST', '/api/benches/B4M/join')).status, 202);
    assert.equal((await t.api(S(1), 'POST', `/api/benches/B4M/requests/${encodeURIComponent(S(3).id)}/accept`)).status, 200);
  });
  after(async () => { await t.close(); });

  test('nobody signed in: 401', async () => {
    assert.equal((await t.api(null, 'GET', '/api/collab/notes')).status, 401);
    assert.equal((await t.api(null, 'PUT', noteUrl(key), { text: 'x', rev: 0 })).status, 401);
  });

  test('an occupant writes the note, everyone reads it', async () => {
    assert.deepEqual((await t.api(S(5), 'GET', '/api/collab/notes')).body.notes, []);
    const saved = await t.api(S(1), 'PUT', noteUrl(key), { text: '  R1 is the hub.\r\nSerial0/0/0 to R2  ', rev: 0 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.note.text, 'R1 is the hub.\nSerial0/0/0 to R2', 'trimmed, line ends normalised');
    assert.equal(saved.body.note.rev, 1);
    assert.deepEqual(saved.body.note.by, { id: S(1).id, name: 'Student 1' });
    for (const who of [S(1), S(2), S(3), S(4), S(5), ADMIN]) {
      const list = await t.api(who, 'GET', '/api/collab/notes');
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.notes.map((n) => [n.key, n.bench, n.device, n.text]), [[key, 'B4M', 'R1', 'R1 is the hub.\nSerial0/0/0 to R2']], who.username);
    }
    assert.equal(t.services.collab && (await t.services.collab.noteOf(key)).text, 'R1 is the hub.\nSerial0/0/0 to R2');
  });

  test('a guest of the bench writes too; a student of another team does not', async () => {
    const guest = await t.api(S(3), 'PUT', noteUrl(key), { text: 'guest was here', rev: 1 });
    assert.equal(guest.status, 200);
    assert.equal(guest.body.note.rev, 2);
    const other = await t.api(S(4), 'PUT', noteUrl(key), { text: 'vandalism', rev: 2 });
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'collab.note_forbidden');
    assert.equal((await t.api(S(5), 'PUT', noteUrl(key), { text: 'vandalism', rev: 2 })).status, 403, 'no team at all');
    assert.equal((await t.api(S(1), 'GET', '/api/collab/notes')).body.notes[0].text, 'guest was here');
  });

  test('being an occupant of one bench gives nothing on the device of another', async () => {
    const res = await t.api(S(1), 'PUT', noteUrl(otherBenchKey), { text: 'not my bench', rev: 0 });
    assert.equal(res.status, 403);
    assert.equal(res.body.params.bench, 'B4B');
  });

  test('an admin writes anywhere, a bench nobody holds included', async () => {
    const res = await t.api(ADMIN, 'PUT', noteUrl(otherBenchKey), { text: 'prepared by the instructor', rev: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.note.bench, 'B4B');
  });

  test('a device that does not exist, an admin switch: 404', async () => {
    const gone = await t.api(ADMIN, 'PUT', noteUrl('page:nothing'), { text: 'x', rev: 0 });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'collab.unknown_device');
    assert.equal((await t.api(ADMIN, 'PUT', noteUrl('admin:switch-1'), { text: 'x', rev: 0 })).status, 404);
  });

  test('bad input: revision, text type, length, forbidden characters', async () => {
    const put = (body) => t.api(S(1), 'PUT', noteUrl(key), body);
    const current = (await t.api(S(1), 'GET', '/api/collab/notes')).body.notes.find((n) => n.key === key).rev;
    for (const rev of [undefined, -1, 1.5, '2', null]) {
      const res = await put({ text: 'x', rev });
      assert.equal(res.status, 400, `rev ${rev}`);
      assert.equal(res.body.code, 'collab.bad_revision');
    }
    for (const text of [undefined, 42, null, ['a'], { a: 1 }]) {
      assert.equal((await put({ text, rev: current })).body.code, 'collab.bad_text', JSON.stringify(text));
    }
    assert.equal((await put({ text: 'bell\u0007', rev: current })).body.code, 'collab.bad_text');
    assert.equal((await put({ text: 'nul\u0000', rev: current })).body.code, 'collab.bad_text');
    assert.equal((await put({ text: 'reversed ‮ text', rev: current })).body.code, 'collab.bad_text');
    const long = await put({ text: 'x'.repeat(2001), rev: current });
    assert.equal(long.status, 400);
    assert.equal(long.body.code, 'collab.too_long');
    assert.equal(long.body.params.max, 2000);
    assert.equal((await put({ text: 'é'.repeat(2000), rev: current })).status, 200, 'characters, not bytes');
    assert.equal((await put({ text: 'tabs\tand\nlines are fine', rev: current + 1 })).status, 200);
  });

  test('markup is stored and returned as typed: nothing to strip, the browser shows text', async () => {
    const raw = '<img src=x onerror=alert(1)> & <b>bold</b>';
    const current = (await t.api(S(1), 'GET', '/api/collab/notes')).body.notes.find((n) => n.key === key).rev;
    const res = await t.api(S(1), 'PUT', noteUrl(key), { text: raw, rev: current });
    assert.equal(res.body.note.text, raw);
    const listed = (await t.api(S(2), 'GET', '/api/collab/notes')).body.notes.find((n) => n.key === key);
    assert.equal(listed.text, raw);
  });

  test('two people editing at once: the second save is refused and learns the new revision', async () => {
    const before = (await t.api(S(1), 'GET', '/api/collab/notes')).body.notes.find((n) => n.key === key);
    const first = await t.api(S(1), 'PUT', noteUrl(key), { text: 'mine', rev: before.rev });
    assert.equal(first.status, 200);
    const second = await t.api(S(2), 'PUT', noteUrl(key), { text: 'theirs', rev: before.rev });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'collab.note_conflict');
    assert.equal(second.body.params.rev, first.body.note.rev);
    assert.equal((await t.api(S(2), 'GET', '/api/collab/notes')).body.notes.find((n) => n.key === key).text, 'mine');
    // two saves racing on the same revision: exactly one wins
    const rev = first.body.note.rev;
    const race = await Promise.all([S(1), S(2), S(3)].map((who, i) => t.api(who, 'PUT', noteUrl(key), { text: `racer ${i}`, rev })));
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409, 409]);
  });

  test('an empty text deletes the note; deleting a stale or absent note is told apart', async () => {
    const note = (await t.api(S(1), 'GET', '/api/collab/notes')).body.notes.find((n) => n.key === key);
    const stale = await t.api(S(1), 'PUT', noteUrl(key), { text: '  \n ', rev: note.rev - 1 });
    assert.equal(stale.status, 409);
    const gone = await t.api(S(1), 'PUT', noteUrl(key), { text: '', rev: note.rev });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.note, null);
    assert.equal((await t.api(S(1), 'GET', '/api/collab/notes')).body.notes.some((n) => n.key === key), false);
    const nothing = await t.api(S(1), 'PUT', noteUrl(key), { text: '', rev: 0 });
    assert.equal(nothing.status, 200, 'nothing to delete and nothing expected');
    assert.equal((await t.api(S(1), 'PUT', noteUrl(key), { text: 'back', rev: 0 })).status, 200, 'a deleted note starts again from 0');
  });

  test('a note whose device left the diagram is not listed', async () => {
    await t.lab.deps.repos.collab.saveNote({ key: 'old:gone', bench: 'B4M', device: 'Old', text: 'ghost', by: { id: 'x', name: 'X' } }, 0);
    assert.equal((await t.api(S(1), 'GET', '/api/collab/notes')).body.notes.some((n) => n.key === 'old:gone'), false);
  });

  test('changes are audited without their text', async () => {
    const entries = await t.lab.deps.audit.query({ action: 'collab.note' });
    assert.ok(entries.some((e) => e.action === 'collab.note.set' && e.details.bench === 'B4M' && e.details.device === 'R1'));
    assert.ok(entries.some((e) => e.action === 'collab.note.clear'));
    assert.ok(!JSON.stringify(entries).includes('mine'));
  });

  test('a released bench is no longer written to by its former occupants', async () => {
    const released = await t.api(S(1), 'POST', '/api/benches/B4M/release');
    assert.equal(released.status, 200);
    const res = await t.api(S(2), 'PUT', noteUrl(key), { text: 'after release', rev: 1 });
    assert.equal(res.status, 403);
    assert.equal((await t.api(S(2), 'GET', '/api/collab/notes')).status, 200, 'but everyone still reads');
  });
});

describe('notes: who hears about a change, and how fast one may write', () => {
  let t;
  let key;
  before(async () => {
    t = await startCollab({ notePerWindow: 3 });
    key = deviceKey(t, 'B4M', 'S1');
    await makeTeam(t, 'Équipe A', S(1), S(2));
    await makeTeam(t, 'Équipe B', S(4));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
  });
  after(async () => { await t.close(); });

  test('every signed-in user hears about a note: it is drawn on the diagram for all', async () => {
    const streams = await Promise.all([S(1), S(2), S(4), S(5), ADMIN].map((u) => t.listen(u)));
    const saved = await t.api(S(1), 'PUT', noteUrl(key), { text: 'uplink to R1', rev: 0 });
    assert.equal(saved.status, 200);
    for (const stream of streams) {
      const event = await stream.until((e) => e.topic === 'collab:note');
      assert.equal(event.data.key, key);
      assert.equal(event.data.text, 'uplink to R1');
      assert.equal(event.data.bench, 'B4M');
    }
    const removed = await t.api(S(1), 'PUT', noteUrl(key), { text: '', rev: 1 });
    assert.equal(removed.status, 200);
    for (const stream of streams) {
      const event = await stream.until((e) => e.topic === 'collab:note' && e.data.removed);
      assert.deepEqual(event.data, { key, bench: 'B4M', rev: 0, removed: true });
    }
  });

  test('a refused save is not announced', async () => {
    const stream = await t.listen(S(5));
    const refused = await t.api(S(4), 'PUT', noteUrl(key), { text: 'nope', rev: 0 });
    assert.equal(refused.status, 403);
    await t.settle(stream);
    assert.equal(stream.events.some((e) => e.topic === 'collab:note' && e.data.text === 'nope'), false);
  });

  test('writing too fast: 429 with the wait, per person', async () => {
    // three saves per person in the window; S1 spent two above (a save and a deletion)
    assert.equal((await t.api(S(1), 'PUT', noteUrl(key), { text: 'one', rev: 0 })).status, 200);
    const refused = await t.api(S(1), 'PUT', noteUrl(key), { text: 'two', rev: 1 });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'collab.rate_limited');
    assert.ok(refused.body.params.seconds >= 1);
    assert.equal((await t.api(S(2), 'PUT', noteUrl(key), { text: 'three', rev: 1 })).status, 200, 'S2 has its own allowance');
  });
});

describe('chat: the occupants of a bench, and the team that keeps it', () => {
  let t;
  let teamA;
  let teamB;
  const post = (who, bench, text) => t.api(who, 'POST', `/api/collab/chat/${bench}`, { text });
  const read = (who, bench) => t.api(who, 'GET', `/api/collab/chat/${bench}`);
  before(async () => {
    clockMs.value = T0;
    t = await startCollab({ chatPerWindow: 4, chatHistory: 5 });
    teamA = await makeTeam(t, 'Équipe A', S(1), S(2));
    teamB = await makeTeam(t, 'Équipe B', S(4));
    assert.equal((await t.api(S(1), 'POST', '/api/benches/B4M/take')).status, 200);
    assert.equal((await t.api(S(3), 'POST', '/api/benches/B4M/join')).status, 202);
    assert.equal((await t.api(S(1), 'POST', `/api/benches/B4M/requests/${encodeURIComponent(S(3).id)}/accept`)).status, 200);
  });
  after(async () => { await t.close(); });

  test('nobody signed in: 401; an unknown bench: 404', async () => {
    assert.equal((await t.api(null, 'GET', '/api/collab/chat/B4M')).status, 401);
    assert.equal((await t.api(null, 'POST', '/api/collab/chat/B4M', { text: 'hi' })).status, 401);
    const unknown = await read(S(1), 'B9Z');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'collab.unknown_bench');
    assert.equal((await post(S(1), 'B9Z', 'hi')).status, 404);
  });

  test('students who do not work on the bench neither read nor write', async () => {
    for (const who of [S(4), S(5)]) {
      const r = await read(who, 'B4M');
      assert.equal(r.status, 403, who.username);
      assert.equal(r.body.code, 'collab.chat_forbidden');
      assert.equal((await post(who, 'B4M', 'let me in')).status, 403);
    }
    assert.equal((await post(S(1), 'B4B', 'a free bench has no chat')).status, 403, 'nobody holds B4B');
  });

  test('occupants talk: the team and the guest see the same thread', async () => {
    const hello = await post(S(1), 'B4M', '  Hello team  ');
    assert.equal(hello.status, 201, JSON.stringify(hello.body));
    assert.equal(hello.body.message.text, 'Hello team');
    assert.deepEqual(hello.body.message.author, { id: S(1).id, name: 'Student 1', initials: hello.body.message.author.initials, color: hello.body.message.author.color });
    assert.equal(hello.body.message.at, new Date(T0).toISOString());
    clockMs.value += 1000;
    assert.equal((await post(S(3), 'B4M', 'the guest here')).status, 201);
    clockMs.value += 1000;
    assert.equal((await post(S(2), 'B4M', 'line 1\nline 2')).status, 201);
    for (const who of [S(1), S(2), S(3)]) {
      const r = await read(who, 'B4M');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.messages.map((m) => m.text), ['Hello team', 'the guest here', 'line 1\nline 2'], who.username);
      assert.equal(r.body.canPost, true);
      assert.equal(r.body.limits.maxChars, 500);
    }
  });

  test('an admin reads but does not write, and moderates', async () => {
    const r = await read(ADMIN, 'B4M');
    assert.equal(r.status, 200);
    assert.equal(r.body.canPost, false);
    assert.equal(r.body.messages.length, 3);
    const refused = await post(ADMIN, 'B4M', 'I am watching');
    assert.equal(refused.status, 403);
    assert.equal((await read(ADMIN, 'B4B')).body.messages.length, 0, 'a bench nobody holds');
  });

  test('bad input: empty, not text, forbidden characters, too long, too many lines', async () => {
    clockMs.value += 60_000;
    const code = async (text) => (await post(S(1), 'B4M', text)).body.code;
    assert.equal(await code('   \n  '), 'collab.empty_message');
    assert.equal(await code(42), 'collab.bad_text');
    assert.equal(await code(undefined), 'collab.bad_text');
    assert.equal(await code('beep\u0007'), 'collab.bad_text');
    assert.equal(await code('x'.repeat(501)), 'collab.too_long');
    assert.equal(await code('1\n2\n3\n4\n5\n6\n7'), 'collab.too_many_lines');
    const noBody = await t.api(S(1), 'POST', '/api/collab/chat/B4M');
    assert.equal(noBody.status, 400);
  });

  test('refused messages cost nothing against the allowance, sent ones do', async () => {
    clockMs.value += 60_000;
    // S2: the window of 4 messages in 20 s
    for (const i of [1, 2, 3, 4]) assert.equal((await post(S(2), 'B4M', `fast ${i}`)).status, 201);
    const refused = await post(S(2), 'B4M', 'fast 5');
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'collab.rate_limited');
    assert.ok(refused.body.params.seconds >= 1 && refused.body.params.seconds <= 20);
    assert.equal((await post(S(1), 'B4M', 'S1 has its own')).status, 201, 'the allowance is per person');
    clockMs.value += 21_000;
    assert.equal((await post(S(2), 'B4M', 'later')).status, 201, 'the window moves on');
  });

  test('the history is bounded: the oldest messages go', async () => {
    const r = await read(S(1), 'B4M');
    assert.equal(r.body.messages.length, 5);
    assert.equal(r.body.messages.at(-1).text, 'later');
    const times = r.body.messages.map((m) => m.at);
    assert.deepEqual([...times].sort(), times, 'oldest first');
  });

  test('markup is kept as typed text', async () => {
    clockMs.value += 60_000;
    const raw = '<script>alert(1)</script>';
    const res = await post(S(1), 'B4M', raw);
    assert.equal(res.body.message.text, raw);
  });

  test('the chat stays with the team: released, taken by another team, taken back', async () => {
    assert.equal((await t.api(S(1), 'POST', '/api/benches/B4M/release')).status, 200);
    assert.equal((await read(S(1), 'B4M')).status, 403, 'a former occupant reads nothing of a bench it left');
    assert.equal((await read(ADMIN, 'B4M')).body.messages.length, 0, 'nobody holds it');
    assert.equal((await t.api(S(4), 'POST', '/api/benches/B4M/take')).status, 200);
    const fresh = await read(S(4), 'B4M');
    assert.deepEqual(fresh.body.messages, [], 'team B does not see the conversation of team A');
    assert.equal((await post(S(4), 'B4M', 'team B speaking')).status, 201);
    assert.deepEqual((await read(ADMIN, 'B4M')).body.messages.map((m) => m.text), ['team B speaking']);
    assert.equal((await t.api(S(4), 'POST', '/api/benches/B4M/release')).status, 200);
    assert.equal((await t.api(S(2), 'POST', '/api/benches/B4M/take')).status, 200);
    const back = await read(S(1), 'B4M');
    assert.equal(back.body.messages.length, 5, 'team A finds its conversation');
    assert.equal(back.body.messages.at(-1).text, '<script>alert(1)</script>');
    assert.equal(teamA !== teamB, true);
  });

  test('a dissolved team loses its threads', async () => {
    assert.deepEqual((await t.lab.deps.repos.collab.threadTeams()).sort(), [teamA, teamB].sort());
    assert.equal((await t.api(S(2), 'POST', '/api/benches/B4M/release')).status, 200);
    assert.equal((await t.api(ADMIN, 'DELETE', `/api/teams/${teamB}`)).status, 200);
    assert.equal(await t.collab.chat.sweep(), 1);
    assert.deepEqual(await t.lab.deps.repos.collab.threadTeams(), [teamA]);
    assert.equal(await t.collab.chat.sweep(), 0);
  });
});

describe('chat: who hears about a message, and moderation', () => {
  let t;
  before(async () => {
    clockMs.value = T0;
    t = await startCollab();
    await makeTeam(t, 'Équipe A', S(1), S(2));
    await makeTeam(t, 'Équipe B', S(4));
    await t.api(S(1), 'POST', '/api/benches/B4M/take');
  });
  after(async () => { await t.close(); });

  test('the occupants and the admins hear it; the other team and the others do not', async () => {
    const hearing = await Promise.all([S(1), S(2), ADMIN].map((u) => t.listen(u)));
    const deaf = await Promise.all([S(4), S(5)].map((u) => t.listen(u)));
    const res = await t.api(S(1), 'POST', '/api/collab/chat/B4M', { text: 'secret plan' });
    assert.equal(res.status, 201);
    for (const stream of hearing) {
      const event = await stream.until((e) => e.topic === 'collab:chat');
      assert.equal(event.data.bench, 'B4M');
      assert.equal(event.data.message.text, 'secret plan');
    }
    await t.settle(...deaf);
    for (const stream of deaf) assert.equal(stream.topics().includes('collab:chat'), false);
  });

  test('a guest hears the next one from the moment they are admitted', async () => {
    const guest = await t.listen(S(3));
    await t.api(S(3), 'POST', '/api/benches/B4M/join');
    await t.api(S(1), 'POST', `/api/benches/B4M/requests/${encodeURIComponent(S(3).id)}/accept`);
    await t.api(S(2), 'POST', '/api/collab/chat/B4M', { text: 'welcome' });
    assert.equal((await guest.until((e) => e.topic === 'collab:chat')).data.message.text, 'welcome');
  });

  test('a refused message is not announced', async () => {
    const stream = await t.listen(S(2));
    assert.equal((await t.api(S(4), 'POST', '/api/collab/chat/B4M', { text: 'intruder' })).status, 403);
    assert.equal((await t.api(S(2), 'POST', '/api/collab/chat/B4M', { text: '' })).status, 400);
    await t.settle(stream);
    assert.equal(stream.events.some((e) => e.topic === 'collab:chat' && e.data.message?.text === 'intruder'), false);
  });

  test('only an admin takes a message down; the audience hears the removal', async () => {
    const thread = (await t.api(S(1), 'GET', '/api/collab/chat/B4M')).body.messages;
    const id = thread[0].id;
    const student = await t.api(S(1), 'DELETE', `/api/collab/chat/B4M/${id}`);
    assert.equal(student.status, 403);
    assert.equal((await t.api(null, 'DELETE', `/api/collab/chat/B4M/${id}`)).status, 401);
    const stream = await t.listen(S(2));
    const done = await t.api(ADMIN, 'DELETE', `/api/collab/chat/B4M/${id}`);
    assert.equal(done.status, 200);
    assert.deepEqual((await stream.until((e) => e.topic === 'collab:chat' && e.data.removed)).data, { bench: 'B4M', removed: id });
    assert.equal((await t.api(S(1), 'GET', '/api/collab/chat/B4M')).body.messages.some((m) => m.id === id), false);
    assert.equal((await t.api(ADMIN, 'DELETE', `/api/collab/chat/B4M/${id}`)).status, 404);
    const audited = await waitFor(async () => (await t.lab.deps.audit.query({ action: 'collab.chat.delete' })).length);
    assert.equal(audited, 1);
    assert.equal((await t.api(ADMIN, 'DELETE', `/api/collab/chat/B9Z/${id}`)).status, 404);
  });
});
