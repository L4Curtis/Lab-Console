/**
 * The wave 2 state in the database: teams, benches, accounts and their
 * links, announcements, the diagram index, the run-time settings, and the
 * import of the JSON files those lots wrote before they had tables
 * (ARCHITECTURE §14, "Store structured state")
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../src/lib/store.js';
import { importLegacyFiles } from '../src/lib/db/index.js';
import { createCachedDocument } from '../src/lib/cachedDocument.js';
import { Teams } from '../src/modules/teams/teams.js';
import { createDirectory } from '../src/modules/accounts/directory.js';
import { createAnnouncements } from '../src/modules/admin/announcements.js';
import { memoryDatabase } from './helpers/db.js';
import { recordingLogger } from './helpers/fakes.js';
import { tempDataDir } from './helpers/app.js';
import { FAST_SCRYPT } from './helpers/accounts.js';

const alice = { id: 'oidc:alice', username: 'alice', name: 'Alice', role: 'student' };
const bob = { id: 'oidc:bob', username: 'bob', name: 'Bob', role: 'student' };

async function memory(t) {
  const m = await memoryDatabase();
  t.after(m.close);
  return m;
}

function dataDir(t) {
  const dir = tempDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
}

describe('the cached document', () => {
  test('serialized updates; a failed write changes nothing, in memory or in the database', async () => {
    const saved = [];
    let fail = false;
    const doc = createCachedDocument({
      fallback: { n: 0 },
      load: async () => ({ n: 1 }),
      save: async (next, prev) => { if (fail) throw new Error('disk full'); saved.push([prev.n, next.n]); },
    });
    assert.deepEqual(doc.get(), { n: 0 }, 'the fallback before load()');
    await assert.rejects(doc.update((d) => { d.n = 9; }), /before it was loaded/);
    await doc.load();
    await Promise.all([doc.update((d) => { d.n += 1; }), doc.update(async (d) => ({ n: d.n * 10 }))]);
    assert.deepEqual(saved, [[1, 2], [2, 20]], 'one after the other, each on what the previous one wrote');
    fail = true;
    await assert.rejects(doc.update((d) => { d.n = 99; }), /disk full/);
    assert.deepEqual(doc.get(), { n: 20 });
    const copy = doc.get();
    copy.n = 5;
    assert.equal(doc.get().n, 20, 'get() is a private copy');
  });
});

describe('teams and benches in the database', () => {
  test('a team, its members and invitations survive a restart; dissolving removes every row', async (t) => {
    const { db, repos } = await memory(t);
    const teams = new Teams({ repos });
    await teams.load();
    const team = await teams.create(alice, 'Équipe A');
    await teams.invite(team.id, 'Bob', alice);
    await assert.rejects(teams.create(bob, 'équipe a'), (err) => err.code === 'teams.name_taken');

    const again = new Teams({ repos });
    await again.load();
    assert.deepEqual(again.list(), teams.list());
    assert.equal(again.teamOf(alice).name, 'Équipe A');
    assert.deepEqual(again.invitationsFor(bob).map((i) => i.team.name), ['Équipe A']);
    await again.accept(team.id, bob);
    assert.deepEqual((await db.query('SELECT user_id FROM team_members ORDER BY position')).map((r) => r.user_id), ['oidc:alice', 'oidc:bob']);
    assert.equal((await db.query('SELECT * FROM team_invitations')).length, 0);

    await again.dissolve(team.id);
    for (const table of ['teams', 'team_members', 'team_invitations']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).length, 0, table);
    }
  });

  test('occupancy, locks and reservations round-trip through their tables', async (t) => {
    const { repos } = await memory(t);
    const occupancy = { B4M: { teamId: 't1', since: '2026-11-13T09:00:00.000Z', by: { id: 'oidc:alice', username: 'alice', name: 'Alice' }, lastActivity: '2026-11-13T09:05:00.000Z', guests: [{ id: 'oidc:bob', username: 'bob', name: 'Bob' }], requests: [] } };
    await repos.transaction((r) => r.benches.saveOccupancy(occupancy, {}));
    assert.deepEqual(await repos.benches.loadOccupancy(), occupancy);
    const locks = { B5M: { reason: 'Exam', by: { id: 'local:root', username: 'root', name: 'root' }, at: '2026-11-13T08:00:00.000Z' } };
    await repos.benches.saveLocks(locks, {});
    assert.deepEqual(await repos.benches.loadLocks(), locks);
    await repos.benches.saveLocks({}, locks);
    assert.deepEqual(await repos.benches.loadLocks(), {});
    const reservation = { id: 'r1', bench: 'B4M', teamId: 't1', start: '2026-11-14T08:00:00.000Z', end: '2026-11-14T10:00:00.000Z', by: occupancy.B4M.by, createdAt: '2026-11-13T09:00:00.000Z' };
    await repos.benches.saveReservations({ reservations: [reservation] }, { reservations: [] });
    await repos.benches.saveReservations({ reservations: [{ ...reservation, warnedAt: '2026-11-14T07:50:00.000Z' }] }, { reservations: [reservation] });
    assert.deepEqual(await repos.benches.loadReservations(), { reservations: [{ ...reservation, warnedAt: '2026-11-14T07:50:00.000Z' }] });
  });
});

describe('accounts in the database', () => {
  test('an account and its passkeys survive a restart; the hash stays a hash; a rejected account leaves no row', async (t) => {
    const { db, repos } = await memory(t);
    const directory = createDirectory({ repos, envAdminName: 'root', passwordCost: FAST_SCRYPT });
    await directory.load();
    await directory.createLocal({ username: 'Alice', name: 'Alice M', passwordHash: 'scrypt$hash', role: 'admin', state: 'active', createdBy: { id: 'local:root' }, invitation: 'inv1' });
    await directory.addPasskey('local:Alice', { id: 'cred-1', publicKey: 'pk', counter: 3, transports: ['usb'], deviceType: 'singleDevice', backedUp: false, name: 'Key' });
    await directory.admitSso({ id: 'oidc:bob', username: 'bob', name: 'Bob', email: 'bob@example.org', groups: ['students'] }, { groupRole: 'student' });
    await directory.setRole('oidc:bob', 'admin');

    const again = createDirectory({ repos, envAdminName: 'root', passwordCost: FAST_SCRYPT });
    await again.load();
    assert.deepEqual(again.get('local:Alice'), directory.get('local:Alice'));
    assert.deepEqual(again.get('oidc:bob'), directory.get('oidc:bob'));
    assert.equal(again.summary(again.get('oidc:bob')).role, 'admin', 'the forced role');
    assert.equal(again.findCredential('cred-1').account.id, 'local:Alice');
    assert.equal(again.isTaken('alice'), true, 'names compared without case');

    await again.createLocal({ username: 'carol', name: 'Carol', passwordHash: 'h', role: 'student', state: 'pending' });
    await again.reject('local:carol');
    assert.equal((await db.query('SELECT id FROM accounts WHERE id = ?', ['local:carol'])).length, 0);
    await again.clearPasskeys('local:Alice');
    assert.equal((await db.query('SELECT id FROM account_passkeys')).length, 0);
  });
});

describe('announcements in the database', () => {
  test('the banner and the last ones survive a restart; taking it down is remembered', async (t) => {
    const { repos } = await memory(t);
    const audit = { log() {} };
    const req = { user: { id: 'local:root', name: 'root' } };
    const first = createAnnouncements({ repos, audit });
    await first.load();
    await first.set({ text: 'Bench 5 is down', level: 'warning' }, req);
    await first.set({ text: 'Bench 5 is back', level: 'info' }, req);
    const second = createAnnouncements({ repos, audit });
    await second.load();
    assert.equal(second.current().text, 'Bench 5 is back');
    assert.deepEqual(second.history().map((a) => a.text), ['Bench 5 is back', 'Bench 5 is down']);
    await second.clear(req);
    const third = createAnnouncements({ repos, audit });
    await third.load();
    assert.equal(third.current(), null);
    assert.equal(third.history().length, 2);
    for (const a of [first, second, third]) a.shutdown();
  });
});

describe('the files of the wave 2 lots are imported once', () => {
  test('teams, benches, accounts, links, SSO, switches, settings, announcements and the diagram index', async (t) => {
    const dir = dataDir(t);
    const store = createStore(dir);
    const { repos } = await memory(t);
    const person = { id: 'oidc:alice', username: 'alice', name: 'Alice' };
    const at = '2026-11-12T09:00:00.000Z';
    write(dir, 'teams/teams.json', { teams: [{ id: 't1', name: 'Équipe A', createdAt: at, createdBy: person, members: [{ ...person, since: at }], invitations: [{ username: 'bob', by: person, at }] }] });
    write(dir, 'benches/occupancy.json', { B4M: { teamId: 't1', since: at, by: person, lastActivity: at, guests: [], requests: [] } });
    write(dir, 'benches/locks.json', { B6H: { reason: 'Broken', by: person, at } });
    write(dir, 'benches/reservations.json', { reservations: [{ id: 'r1', bench: 'B4M', teamId: 't1', start: at, end: '2026-11-12T10:00:00.000Z', by: person, createdAt: at }] });
    const ms = Date.parse(at);
    write(dir, 'accounts/users.json', {
      version: 1,
      accounts: {
        'local:carol': { id: 'local:carol', via: 'local', username: 'carol', usernameKey: 'carol', name: 'Carol', email: '', role: 'student', state: 'active', passwordHash: 'h', passwordChangedAt: ms, webauthnUserId: 'w', passkeys: [], createdAt: ms, createdBy: null, invitation: 'l1', lastSignInAt: null },
      },
    });
    const hash = crypto.createHash('sha256').update('token').digest('hex');
    write(dir, 'accounts/invitations.json', { version: 1, links: { l1: { id: 'l1', kind: 'invite', hash, role: 'student', maxUses: 1, uses: 1, accounts: ['local:carol'], accountId: null, note: '', createdAt: ms, expiresAt: ms + 3_600_000, createdBy: { id: 'local:root' }, revokedAt: null, revokedBy: null, lastUsedAt: ms } } });
    write(dir, 'auth/oidc.json', { version: 1, savedAt: at, settings: { issuer: 'https://idp.example', clientId: 'lab', enabled: true }, clientSecret: { clear: 's' } });
    write(dir, 'admin/switches.json', { switches: [{ id: 'core', name: 'Core', bay: '', host: '10.22.9.212', port: 2042 }], updatedAt: at, updatedBy: 'local:root' });
    write(dir, 'settings/lab.json', { version: 1, values: { 'telnet.username': 'console' }, updatedAt: at, updatedBy: 'local:root' });
    write(dir, 'admin/announcements.json', { current: null, history: [{ text: 'Old news', level: 'info', at, expiresAt: null, by: { id: 'local:root', name: 'root' } }] });
    write(dir, 'diagrams/index.json', { active: 'v1', history: [{ id: 'v1', at, by: 'system' }], versions: [{ id: 'v1', name: 'diagram.drawio', size: 10, sha256: 'x', at, by: { id: 'system', username: 'system' }, source: 'environment', labs: ['B4M'], devices: 3, warnings: 0 }] });

    const log = recordingLogger();
    const done = await importLegacyFiles({ store, repos, logger: log });
    assert.deepEqual(done.map((d) => d.path).sort(), [
      'accounts/invitations.json', 'accounts/users.json', 'admin/announcements.json', 'admin/switches.json', 'auth/oidc.json',
      'benches/locks.json', 'benches/occupancy.json', 'benches/reservations.json', 'diagrams/index.json', 'settings/lab.json', 'teams/teams.json',
    ]);
    assert.ok(done.every((d) => d.records >= 1 && d.skipped === 0), JSON.stringify(done));

    assert.equal((await repos.teams.load()).teams[0].invitations[0].username, 'bob');
    assert.equal((await repos.benches.loadOccupancy()).B4M.teamId, 't1');
    assert.equal((await repos.benches.loadLocks()).B6H.reason, 'Broken');
    assert.equal((await repos.benches.loadReservations()).reservations[0].id, 'r1');
    assert.equal((await repos.accounts.load())['local:carol'].passwordHash, 'h');
    assert.equal((await repos.accountLinks.load()).l1.hash, hash);
    assert.equal((await repos.settings.get('sso')).values.settings.issuer, 'https://idp.example');
    assert.equal((await repos.settings.get('switches')).values.switches[0].id, 'core');
    assert.deepEqual((await repos.settings.get('lab')).values, { 'telnet.username': 'console' });
    const [news] = await repos.announcements.recent();
    assert.equal(news.text, 'Old news');
    assert.ok(news.removedAt, 'it had been taken down');
    assert.equal((await repos.diagrams.load()).active, 'v1');

    assert.ok(fs.existsSync(path.join(dir, 'teams', 'teams.json.imported')));
    assert.ok(!fs.existsSync(path.join(dir, 'teams', 'teams.json')));
    // The same files again (pre-production rolled back, then upgraded): the database wins, nothing doubles
    for (const rel of ['teams/teams.json', 'admin/announcements.json']) fs.copyFileSync(path.join(dir, `${rel}.imported`), path.join(dir, rel));
    fs.writeFileSync(path.join(dir, 'teams/teams.json'), fs.readFileSync(path.join(dir, 'teams/teams.json.imported'), 'utf8').replace('Équipe A', 'Équipe B'));
    const again = await importLegacyFiles({ store, repos, logger: log });
    assert.deepEqual(again.map((d) => [d.path, d.records]), [['teams/teams.json', 0]]);
    assert.equal((await repos.teams.load()).teams[0].name, 'Équipe A', 'what the database holds wins');
    assert.equal((await repos.announcements.recent()).length, 1);
  });

  test('a file that is not what it should be is kept aside, the others are imported', async (t) => {
    const dir = dataDir(t);
    const store = createStore(dir);
    const { repos } = await memory(t);
    write(dir, 'benches/locks.json', ['not', 'an', 'object']);
    write(dir, 'accounts/users.json', { version: 2, accounts: {} });
    write(dir, 'teams/teams.json', { teams: [{ id: 't1', name: 'Fine', createdAt: '2026-11-12T09:00:00.000Z', members: [], invitations: [] }, { name: 'no id' }] });
    const log = recordingLogger();
    const done = await importLegacyFiles({ store, repos, logger: log });
    assert.deepEqual(done.map((d) => d.path), ['teams/teams.json']);
    assert.ok(fs.existsSync(path.join(dir, 'benches', 'locks.json.not-imported')));
    assert.ok(fs.existsSync(path.join(dir, 'accounts', 'users.json.not-imported')));
    assert.equal((await repos.teams.load()).teams.length, 1);
  });
});
