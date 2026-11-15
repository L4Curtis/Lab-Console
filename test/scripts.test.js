/**
 * The script library (SPEC "Lot terminal"): lists of console commands that a
 * person keeps (personal), a team shares (team), or an administrator
 * publishes for everybody. The repository on its own, then the API in the
 * real application: who sees what, who changes what, and the refusals -
 * another team's script, a student publishing, bad input, the shelves' limits
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { memoryDatabase } from './helpers/db.js';
import { LIMITS } from '../src/modules/scripts/library.js';
import { createConsolesModule } from '../src/modules/consoles/index.js';
import { createTeamsModules } from '../src/modules/teams/index.js';
import { createScriptsModule } from '../src/modules/scripts/index.js';

const BODY = 'configure terminal\ninterface g0/0\n ip address 10.0.0.1 255.255.255.0\n no shutdown\nend\n';

describe('scripts repository', () => {
  const script = (id, extra = {}) => ({
    id, scope: 'personal', shelf: 'p:u1', teamId: null, ownerId: 'u1', ownerName: 'U One', title: `Script ${id}`, description: '', body: 'show clock\n', lines: 1, ...extra,
  });

  test('what a person sees: their shelf, their team\'s, the published ones; an administrator sees every team', async (t) => {
    const { repos, close } = await memoryDatabase();
    t.after(close);
    await repos.scripts.insert(script('a'));
    await repos.scripts.insert(script('b', { shelf: 'p:u2', ownerId: 'u2', title: 'Other person\'s' }));
    await repos.scripts.insert(script('c', { scope: 'team', shelf: 't:red', teamId: 'red', title: 'Red team' }));
    await repos.scripts.insert(script('d', { scope: 'team', shelf: 't:blue', teamId: 'blue', title: 'Blue team' }));
    await repos.scripts.insert(script('e', { scope: 'published', shelf: 'pub', title: 'For all' }));
    const ids = async (query) => (await repos.scripts.visibleTo(query)).map((s) => s.id).sort();
    assert.deepEqual(await ids({ userId: 'u1', teamId: 'red' }), ['a', 'c', 'e']);
    assert.deepEqual(await ids({ userId: 'u1' }), ['a', 'e']);
    assert.deepEqual(await ids({ userId: 'u3', teamId: 'blue' }), ['d', 'e']);
    assert.deepEqual(await ids({ userId: 'admin', allTeams: true }), ['c', 'd', 'e'], 'every team, no personal shelf but their own');
    assert.equal((await repos.scripts.visibleTo({ userId: 'u1' }))[0].body, undefined, 'a listing carries no text');
  });

  test('get returns the text; a title is unique on its shelf without case; update, remove and counts', async (t) => {
    const { repos, close } = await memoryDatabase();
    t.after(close);
    await repos.scripts.insert(script('a', { body: 'show clock\nshow version\n', lines: 2 }));
    assert.equal((await repos.scripts.get('a')).body, 'show clock\nshow version\n');
    assert.equal(await repos.scripts.get('nope'), null);
    await assert.rejects(repos.scripts.insert(script('a2', { title: 'SCRIPT A' })), { code: 'db.unique' });
    await repos.scripts.insert(script('x', { shelf: 'p:u2', ownerId: 'u2', title: 'Script a' }));
    assert.equal(await repos.scripts.countOn('p:u1'), 1);
    assert.equal(await repos.scripts.update('a', { title: 'Renamed', description: 'd', body: 'show ip route\n', lines: 1, updatedBy: 'Ada', updatedAt: Date.UTC(2026, 10, 14) }), true);
    const after = await repos.scripts.get('a');
    assert.deepEqual([after.title, after.body, after.updatedBy, after.updatedAt], ['Renamed', 'show ip route\n', 'Ada', '2026-11-14T00:00:00.000Z']);
    assert.equal(await repos.scripts.remove('a'), true);
    assert.equal(await repos.scripts.remove('a'), false);
  });
});

describe('script library API', () => {
  let app;
  before(async () => {
    // Without the accounts module a team invitation takes the user name as typed (the directory is another lot's)
    app = await startTestApp({ modules: (deps) => [createConsolesModule(deps), ...createTeamsModules(deps), createScriptsModule(deps)] });
  });
  after(async () => { await app.close(); });

  async function api(who, method, path, body) {
    const headers = { accept: 'application/json', ...(who ? app.as(who) : {}) };
    if (method !== 'GET') headers.origin = app.url;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${app.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: data };
  }
  const create = (who, scope, title, extra = {}) => api(who, 'POST', '/api/scripts', { scope, title, body: BODY, ...extra });
  const titles = async (who) => (await api(who, 'GET', '/api/scripts')).body.scripts.map((s) => s.title).sort();

  test('nobody signed in: 401 on every route', async () => {
    for (const [method, path] of [['GET', '/api/scripts'], ['GET', '/api/scripts/x'], ['POST', '/api/scripts'], ['PATCH', '/api/scripts/x'], ['DELETE', '/api/scripts/x']]) {
      const { status, body } = await api(null, method, path, method === 'GET' ? undefined : {});
      assert.equal(status, 401, `${method} ${path}`);
      assert.equal(body.code, 'auth.required');
    }
  });

  let mine;
  test('a student keeps a personal script: it lists without its text and reads with it', async () => {
    const made = await create('student1', 'personal', '  Adresse   sur G0/0 ', { description: 'Pour le TP 3' });
    assert.equal(made.status, 201);
    mine = made.body.script;
    assert.equal(mine.title, 'Adresse sur G0/0', 'spaces are tidied');
    assert.equal(mine.lines, 5, 'the final line break is not a line');
    assert.deepEqual([mine.scope, mine.mine, mine.canEdit, mine.author.id], ['personal', true, true, 'oidc:student1']);
    const list = (await api('student1', 'GET', '/api/scripts')).body;
    assert.deepEqual(list.scripts.map((s) => s.id), [mine.id]);
    assert.equal(list.scripts[0].body, undefined);
    assert.equal(list.team, null);
    assert.equal(list.canPublish, false);
    assert.equal((await api('student1', 'GET', `/api/scripts/${mine.id}`)).body.script.body, BODY);
  });

  test('refusal: another person\'s personal script does not exist for them - not in the list, not to read, change or delete', async () => {
    assert.deepEqual(await titles('student2'), []);
    for (const [method, body] of [['GET'], ['PATCH', { title: 'Mine now' }], ['DELETE']]) {
      const res = await api('student2', method, `/api/scripts/${mine.id}`, body);
      assert.equal(res.status, 404, method);
      assert.equal(res.body.code, 'scripts.unknown');
    }
    // Not even an administrator reads a personal script: it may hold a password
    assert.deepEqual(await titles('admin'), []);
    assert.equal((await api('admin', 'GET', `/api/scripts/${mine.id}`)).status, 404);
    assert.equal((await api('student1', 'GET', `/api/scripts/${mine.id}`)).status, 200, 'the owner still reads it');
  });

  let teamScript;
  let redTeam;
  test('a team shares a script among its members only; a script for a team needs a team', async () => {
    const noTeam = await create('student1', 'team', 'Pour l\'équipe');
    assert.equal(noTeam.status, 409);
    assert.equal(noTeam.body.code, 'scripts.no_team');

    redTeam = (await api('student1', 'POST', '/api/teams', { name: 'Les rouges' })).body.team;
    const blue = (await api('student3', 'POST', '/api/teams', { name: 'Les bleus' })).body.team;
    assert.ok(blue.id);
    teamScript = (await create('student1', 'team', 'VLAN 10 et 20')).body.script;
    assert.deepEqual([teamScript.scope, teamScript.team.name], ['team', 'Les rouges']);

    // student2 is not in the team yet: it does not exist for them. Neither for another team's member
    assert.equal((await api('student2', 'GET', `/api/scripts/${teamScript.id}`)).status, 404);
    assert.equal((await api('student3', 'GET', `/api/scripts/${teamScript.id}`)).status, 404);
    assert.deepEqual(await titles('student3'), []);
    for (const [method, body] of [['PATCH', { body: 'erase startup-config\n' }], ['DELETE']]) {
      assert.equal((await api('student3', method, `/api/scripts/${teamScript.id}`, body)).status, 404, `another team's script: ${method}`);
    }
    assert.equal((await api('student1', 'GET', `/api/scripts/${teamScript.id}`)).body.script.body, BODY, 'nothing was changed');

    // student2 joins the team: they read it, and change it
    assert.equal((await api('student1', 'POST', `/api/teams/${redTeam.id}/invitations`, { username: 'student2' })).status, 201);
    assert.equal((await api('student2', 'POST', `/api/teams/${redTeam.id}/accept`)).status, 200);
    assert.deepEqual(await titles('student2'), ['VLAN 10 et 20']);
    const edited = await api('student2', 'PATCH', `/api/scripts/${teamScript.id}`, { description: 'Corrigé par Student 2', body: 'show vlan brief\n' });
    assert.equal(edited.status, 200);
    assert.deepEqual([edited.body.script.updatedBy, edited.body.script.author.name, edited.body.script.lines], ['Student 2', 'Student 1', 1]);
    assert.equal((await api('student2', 'DELETE', `/api/scripts/${teamScript.id}`)).status, 200);
    assert.deepEqual(await titles('student1'), ['Adresse sur G0/0']);
  });

  test('an administrator sees every team\'s scripts to tidy up, also those of a team that no longer exists', async () => {
    const kept = (await create('student1', 'team', 'Ancien script')).body.script;
    assert.deepEqual(await titles('admin'), ['Ancien script']);
    assert.equal((await api('admin', 'GET', `/api/scripts/${kept.id}`)).status, 200);
    // Both members leave: the team is dissolved
    await api('student2', 'POST', `/api/teams/${redTeam.id}/leave`);
    await api('student1', 'POST', `/api/teams/${redTeam.id}/leave`);
    assert.equal(app.deps.services.teams.get(redTeam.id), null);
    assert.equal((await api('student1', 'GET', `/api/scripts/${kept.id}`)).status, 404, 'nobody is left to read it');
    const seen = (await api('admin', 'GET', '/api/scripts')).body.scripts.find((s) => s.id === kept.id);
    assert.equal(seen.team.name, null, 'its team is gone');
    assert.equal((await api('admin', 'DELETE', `/api/scripts/${kept.id}`)).status, 200);
  });

  let published;
  test('refusal: only an administrator publishes; everybody reads what is published, nobody else changes it', async () => {
    const attempt = await create('student1', 'published', 'Pour tout le monde');
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.code, 'scripts.admin_only');
    published = (await create('admin', 'published', 'Configuration de base', { description: 'Hostname et banner' })).body.script;
    assert.equal(published.scope, 'published');
    const seen = (await api('student2', 'GET', '/api/scripts')).body;
    assert.deepEqual(seen.scripts.map((s) => [s.title, s.canEdit]), [['Configuration de base', false]]);
    assert.equal((await api('student2', 'GET', `/api/scripts/${published.id}`)).body.script.body, BODY);
    for (const [method, body] of [['PATCH', { body: 'reload\n' }], ['DELETE']]) {
      const res = await api('student2', method, `/api/scripts/${published.id}`, body);
      assert.equal(res.status, 403, method);
      assert.equal(res.body.code, 'scripts.forbidden');
    }
    assert.equal((await api('admin', 'GET', '/api/scripts')).body.canPublish, true);
    assert.equal((await api('admin', 'PATCH', `/api/scripts/${published.id}`, { title: 'Base' })).status, 200);
  });

  test('bad input: scope, title, text, size, line breaks, control characters', async () => {
    const refuse = async (input, status, code) => {
      const res = await api('student2', 'POST', '/api/scripts', { scope: 'personal', title: 'T', body: BODY, ...input });
      assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(input).slice(0, 80));
    };
    await refuse({ scope: 'everyone' }, 400, 'scripts.bad_scope');
    await refuse({ title: '' }, 400, 'scripts.bad_title');
    await refuse({ title: '   ' }, 400, 'scripts.bad_title');
    await refuse({ title: 42 }, 400, 'scripts.bad_title');
    await refuse({ title: 'x'.repeat(LIMITS.title + 1) }, 400, 'scripts.bad_title');
    await refuse({ title: 'bell\u0007' }, 400, 'scripts.bad_title');
    await refuse({ description: 'y'.repeat(LIMITS.description + 1) }, 400, 'scripts.bad_description');
    await refuse({ description: 12 }, 400, 'scripts.bad_description');
    await refuse({ body: '' }, 400, 'scripts.bad_body');
    await refuse({ body: ' \n \n' }, 400, 'scripts.bad_body');
    await refuse({ body: undefined }, 400, 'scripts.bad_body');
    await refuse({ body: { not: 'text' } }, 400, 'scripts.bad_body');
    await refuse({ body: 'show clock\u001b[31m\n' }, 400, 'scripts.bad_body');
    await refuse({ body: 'a'.repeat(LIMITS.bodyBytes + 1) }, 413, 'scripts.body_too_large');
    const big = await api('student2', 'POST', '/api/scripts', { scope: 'personal', title: 'Limite', body: `${'a'.repeat(LIMITS.bodyBytes - 1)}\n` });
    assert.equal(big.status, 201, 'exactly the limit is fine');

    // Windows line breaks and trailing spaces are tidied the way the injection reads them
    const crlf = await api('student2', 'POST', '/api/scripts', { scope: 'personal', title: 'CRLF', body: 'show clock  \r\nshow version\r\n' });
    assert.equal(crlf.status, 201);
    assert.deepEqual([crlf.body.script.lines, (await api('student2', 'GET', `/api/scripts/${crlf.body.script.id}`)).body.script.body], [2, 'show clock\nshow version\n']);
    assert.equal((await api('student2', 'PATCH', `/api/scripts/${crlf.body.script.id}`, { body: '' })).status, 400, 'a change is checked too');
    assert.equal((await api('student2', 'PATCH', '/api/scripts/missing', { title: 'x' })).status, 404);
  });

  test('a title is unique on its shelf; two people may use the same title on theirs', async () => {
    const first = await create('student3', 'personal', 'Mon script');
    assert.equal(first.status, 201);
    const twin = await create('student3', 'personal', 'MON SCRIPT');
    assert.equal(twin.status, 409);
    assert.equal(twin.body.code, 'scripts.duplicate_title');
    assert.equal((await create('student1', 'personal', 'Mon script')).status, 201, 'on another person\'s shelf');
    const other = (await create('student3', 'personal', 'Autre')).body.script;
    const rename = await api('student3', 'PATCH', `/api/scripts/${other.id}`, { title: 'mon script' });
    assert.equal(rename.status, 409);
    assert.equal(rename.body.code, 'scripts.duplicate_title');
  });

  test('two people editing a team script: the second save is told that it changed', async () => {
    // student1 and student3 are in no team any more; a published script is edited by administrators only, one at a time
    const s = (await create('admin', 'published', 'Partagé')).body.script;
    const first = await api('admin', 'PATCH', `/api/scripts/${s.id}`, { body: 'show clock\n', updatedAt: s.updatedAt });
    assert.equal(first.status, 200);
    // The second editor still holds the version before
    await app.deps.repos.scripts.update(s.id, { title: 'Partagé', description: '', body: 'x\n', lines: 1, updatedBy: 'Someone', updatedAt: Date.UTC(2030, 0, 1) });
    const late = await api('admin', 'PATCH', `/api/scripts/${s.id}`, { body: 'show version\n', updatedAt: first.body.script.updatedAt });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'scripts.conflict');
    assert.equal((await api('admin', 'GET', `/api/scripts/${s.id}`)).body.script.body, 'x\n', 'the other editor\'s text was kept');
  });

  test('a shelf holds a limited number of scripts', async () => {
    const shelf = 'p:oidc:student2';
    const have = await app.deps.repos.scripts.countOn(shelf);
    for (let i = have; i < LIMITS.perShelf.personal; i++) {
      await app.deps.repos.scripts.insert({ id: `fill-${i}`, scope: 'personal', shelf, teamId: null, ownerId: 'oidc:student2', ownerName: 'S2', title: `Rempli ${i}`, description: '', body: 'x\n', lines: 1 });
    }
    const res = await create('student2', 'personal', 'Une de trop');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'scripts.shelf_full');
    assert.equal(res.body.params.max, LIMITS.perShelf.personal);
  });

  test('every change is audited with the title and the shelf, never the text', async () => {
    const entries = await app.deps.audit.query({ action: 'script', limit: 1000 });
    const actions = new Set(entries.map((e) => e.action));
    for (const action of ['script.create', 'script.update', 'script.delete']) assert.ok(actions.has(action), action);
    const made = entries.find((e) => e.action === 'script.create' && e.details.title === 'Configuration de base');
    assert.deepEqual([made.details.scope, made.actor.id], ['published', 'oidc:admin']);
    assert.doesNotMatch(JSON.stringify(entries), /configure terminal|no shutdown/);
  });
});
