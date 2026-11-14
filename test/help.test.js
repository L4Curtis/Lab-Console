/**
 * Lot help: what the guided tour remembers about a person (GET / PUT
 * /api/help/tour), the repository behind it, and that the help text exists
 * for every section the page draws, in both languages
 *
 * The tour and the page themselves are browser work: test/e2e/help.e2e.js
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, repoRoot } from './helpers/app.js';
import { memoryDatabase } from './helpers/db.js';
import { createHelpModule } from '../src/modules/help/index.js';

describe('repository', () => {
  test('nothing is known of someone who never saw the tour; the last ending wins; people are separate', async (c) => {
    const { repos, close } = await memoryDatabase({ now: () => new Date('2026-11-14T08:00:00Z') });
    c.after(close);
    assert.equal(await repos.tour.get('oidc:a'), null);
    await repos.tour.set('oidc:a', 'skipped');
    assert.equal(await repos.tour.get('oidc:a'), 'skipped');
    await repos.tour.set('oidc:a', 'done');
    assert.equal(await repos.tour.get('oidc:a'), 'done');
    assert.equal(await repos.tour.get('oidc:b'), null);
    assert.equal((await repos.tour.get(undefined)), null, 'no user id is not an error');
  });

  test('an unknown ending is refused, never stored', async (c) => {
    const { repos, close } = await memoryDatabase();
    c.after(close);
    await assert.rejects(() => repos.tour.set('oidc:a', 'maybe'), TypeError);
    assert.equal(await repos.tour.get('oidc:a'), null);
  });
});

describe('/api/help/tour', () => {
  let lab;
  before(async () => { lab = await startTestApp({ modules: (deps) => [createHelpModule(deps)] }); });
  after(async () => { await lab?.close(); });

  const call = async (who, method, body) => {
    const headers = { accept: 'application/json', ...(who ? lab.as(who) : {}) };
    if (method !== 'GET') headers.origin = lab.url;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${lab.url}/api/help/tour`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  test('a new person has not seen it; finishing or skipping is remembered for that person only', async () => {
    assert.deepEqual((await call('student1', 'GET')).body, { state: null });
    assert.deepEqual((await call('student1', 'PUT', { state: 'skipped' })).body, { state: 'skipped' });
    assert.deepEqual((await call('student1', 'GET')).body, { state: 'skipped' });
    assert.deepEqual((await call('student2', 'GET')).body, { state: null }, 'another person is not affected');
    assert.equal((await call('student1', 'PUT', { state: 'done' })).status, 200);
    assert.deepEqual((await call('student1', 'GET')).body, { state: 'done' });
    // A replay that is skipped does not undo a tour that was finished
    assert.deepEqual((await call('student1', 'PUT', { state: 'skipped' })).body, { state: 'done' });
    assert.deepEqual((await call('student1', 'GET')).body, { state: 'done' });
    assert.deepEqual((await call('admin', 'GET')).body, { state: null }, 'an administrator has a tour of their own');
  });

  test('refusals: nobody signed in, an unknown ending, a missing body', async () => {
    assert.equal((await call(null, 'GET')).status, 401);
    assert.equal((await call(null, 'PUT', { state: 'done' })).status, 401);
    const bad = await call('student3', 'PUT', { state: 'maybe' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'help.bad_state');
    assert.equal((await call('student3', 'PUT', {})).status, 400);
    assert.equal((await call('student3', 'PUT', { state: ['done'] })).status, 400);
    assert.deepEqual((await call('student3', 'GET')).body, { state: null }, 'a refused call stores nothing');
  });

  test('the user is the session\'s, never one named in the request', async () => {
    const res = await fetch(`${lab.url}/api/help/tour?user=${encodeURIComponent('local:root')}`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: lab.url, ...lab.as('student2') },
      body: JSON.stringify({ state: 'done', user: 'local:root', userId: 'local:root' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await call('admin', 'GET')).body, { state: null });
    assert.deepEqual((await call('student2', 'GET')).body, { state: 'done' });
  });
});

describe('the help text', () => {
  const read = (lang) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'public', 'locales', lang, 'help.json'), 'utf8'));
  const page = fs.readFileSync(path.join(repoRoot, 'public', 'js', 'modules', 'help', 'index.js'), 'utf8');
  const tour = fs.readFileSync(path.join(repoRoot, 'public', 'js', 'modules', 'help', 'tour.js'), 'utf8');

  test('every key a section lists exists in French and in English, and nothing is left out of the page', () => {
    // { id: 'team', blocks: [ … ] } → the keys quoted inside each block list
    const sections = [...page.matchAll(/\{ id: '(\w+)', blocks: \[([\s\S]*?)\n {2}\] \}/g)];
    assert.ok(sections.length >= 8, 'the page has its sections');
    for (const lang of ['fr', 'en']) {
      const dict = read(lang).s;
      for (const [, id, source] of sections) {
        assert.ok(dict[id]?.title, `${lang}: title of ${id}`);
        const keys = [...source.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]).filter((k) => !['p', 'ul', 'ol', 'h', 'note', 'link', 'keys', 'key'].includes(k));
        for (const key of keys) {
          assert.ok(dict[id][key] !== undefined, `${lang}: help.s.${id}.${key}`);
          if (typeof dict[id][key] === 'object') assert.ok(dict[id][key].keys && dict[id][key].what, `${lang}: help.s.${id}.${key}`);
        }
        // …and the other way round: a sentence nobody lists is a sentence nobody reads
        for (const key of Object.keys(dict[id]).filter((k) => !['title', 'col'].includes(k))) {
          assert.ok(keys.includes(key), `${lang}: help.s.${id}.${key} is in no block of the page`);
        }
      }
    }
  });

  test('the tour has a title and a body for each step, in both languages', () => {
    const steps = [...tour.matchAll(/\{ id: '(\w+)', route/g)].map((m) => m[1]);
    assert.equal(steps.length, 5);
    for (const lang of ['fr', 'en']) {
      for (const id of steps) {
        assert.ok(read(lang).tour.steps[id]?.title && read(lang).tour.steps[id]?.body, `${lang}: ${id}`);
      }
    }
  });

  test('the sentences that matter are there: the server is not a backup, the ZIP, the countdown, the bench name', () => {
    const fr = JSON.stringify(read('fr').s);
    const en = JSON.stringify(read('en').s);
    for (const word of [/n’est pas une sauvegarde/, /ZIP/, /compte à rebours/, /nom de la baie/, /Prendre la baie/, /Demander la main/]) assert.match(fr, word);
    for (const word of [/not a backup/, /ZIP/, /countdown/, /bench's name/, /Take the bench/, /Ask for the keyboard/]) assert.match(en, word);
  });
  test('the privacy lines say that echoed commands are journaled, and no fixed figure that an administrator can change', () => {
    for (const lang of ['fr', 'en']) {
      const j = JSON.stringify(read(lang).s);
      assert.doesNotMatch(j, /60 (minutes|min)\b/);
      assert.doesNotMatch(j, /10 second/);
    }
    assert.match(read('fr').s.journal.never, /sans écho/);
    assert.match(read('en').s.journal.never, /without echo/);
  });
});
