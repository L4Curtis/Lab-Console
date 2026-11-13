/**
 * The wave 2 lots together, in the real application against the mock lab:
 * the consoles ask the real bench rule (services.benches.canPilot) when a
 * line opens and at every control action, console activity keeps the bench
 * held, team invitations name accounts the directory knows, and the
 * administration's health and journaling pages read the consoles module
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';
import { startMockLab } from '../dev/mock-lab.js';
import { startTestApp, repoRoot } from './helpers/app.js';
import { FAST_SCRYPT } from './helpers/accounts.js';
import { student, admin } from './helpers/fakes.js';
import { T0, MIN } from './helpers/teams.js';
import { parseDrawio } from '../src/modules/consoles/drawio.js';
import { createConsolesModule } from '../src/modules/consoles/index.js';
import { createTeamsModules } from '../src/modules/teams/index.js';
import { createAccountsModule } from '../src/modules/accounts/index.js';
import { createAdminModule } from '../src/modules/admin/index.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const TELNET = { username: 'line', password: 'line-pass' };

let mock;
let app;
let devices;
const clock = { ms: T0 };
const byName = (bench, name) => devices.find((d) => d.labName === bench && d.name === name);

before(async () => {
  const names = new Map();
  const { labs } = parseDrawio(fs.readFileSync(`${repoRoot}/diagrams/diagram.drawio`, 'utf8'), { networkPrefix: '10.22.9' });
  devices = labs.flatMap((l) => l.devices.map((d) => ({ ...d, labName: l.name })));
  for (const d of devices) names.set(`${d.target.host}:${d.target.port}`, d.name);
  mock = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, names });
  app = await startTestApp({
    env: {
      SSH_HOST: '127.0.0.1', SSH_PORT: String(mock.port), SSH_USERNAME: SSH.username, SSH_PASSWORD: SSH.password,
      TELNET_USERNAME: TELNET.username, TELNET_PASSWORD: TELNET.password, TELNET_WAKE_IDLE_MS: '150',
    },
    modules: (deps) => [
      createConsolesModule(deps),
      ...createTeamsModules(deps, { now: () => clock.ms, tickMs: 0 }),
      createAccountsModule(deps, { passwordCost: FAST_SCRYPT }),
      createAdminModule(deps),
    ],
  });
  // The students signed in once through the provider: the directory knows them
  for (const n of [1, 2, 3]) await app.deps.services.accounts.admit(student(n), { groupRole: 'student' });
});

after(async () => {
  await app?.close();
  await mock?.close();
});

async function api(who, method, path, body) {
  const headers = { accept: 'application/json', ...(who ? app.as(who) : {}) };
  if (method !== 'GET') headers.origin = app.url;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: data };
}

async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connect(who, device, mode = '') {
  const ws = new WebSocket(`${app.wsUrl}/ws/console?device=${encodeURIComponent(device.key)}&cols=80&rows=24${mode}`, { headers: { origin: app.url, ...app.as(who) } });
  const c = { ws, frames: [], text: '', closed: false };
  ws.on('message', (raw, isBinary) => { if (isBinary) c.text += raw.toString('latin1'); else c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', () => { c.closed = true; });
  c.send = (msg) => ws.send(JSON.stringify(msg));
  c.type = (data) => c.send({ type: 'input', data });
  c.see = (re) => until(() => re.test(c.text), `${who}: screen ${re}`);
  c.frame = async (pred, what) => { await until(() => c.frames.some(pred), `${who}: ${what}`); return c.frames.filter(pred).at(-1); };
  c.close = () => new Promise((r) => { if (c.closed) return r(); ws.once('close', r); ws.close(); });
  return c;
}

async function openReady(who, device) {
  const c = connect(who, device);
  await c.see(/Password: /);
  await c.frame((f) => f.type === 'status' && f.phase === 'login', 'auto-login');
  c.type('\r');
  await c.see(new RegExp(`${device.name}>$`));
  return c;
}

test('team invitations name accounts the directory knows, in their own spelling', async () => {
  const created = await api('student1', 'POST', '/api/teams', { name: 'Équipe Une' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.team.id;
  const unknown = await api('student1', 'POST', `/api/teams/${id}/invitations`, { username: 'nobody-here' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'teams.unknown_user');
  assert.equal((await api('student1', 'POST', `/api/teams/${id}/invitations`, { username: 'bad name' })).status, 400);
  const invited = await api('student1', 'POST', `/api/teams/${id}/invitations`, { username: 'STUDENT2' });
  assert.equal(invited.status, 201);
  assert.deepEqual(invited.body.team.invitations.map((i) => i.username), ['student2'], 'the account\'s own spelling');
  assert.equal((await api('student2', 'POST', `/api/teams/${id}/accept`)).status, 200);
  assert.deepEqual(app.deps.services.teams.teamOf('oidc:student2').members.sort(), ['oidc:student1', 'oidc:student2']);
});

test('the consoles ask the real bench rule: a member pilots, an outsider watches, a lock takes the keyboard away', async () => {
  const r1 = byName('B4M', 'R1');
  const r2 = byName('B4M', 'R2');
  assert.equal((await api('student1', 'POST', '/api/benches/B4M/take')).status, 200);

  const alice = await openReady('student1', r1);
  const outsider = connect('student3', r1);
  const seen = await outsider.frame((f) => f.type === 'presence' && f.users.length === 2, 'the outsider watches');
  assert.equal(seen.canPilot, false, 'student3 is not an occupant of B4M');
  assert.equal(seen.mayType, false);
  outsider.send({ type: 'control', action: 'request' });
  const refused = await outsider.frame((f) => f.type === 'control-refused', 'request refused');
  assert.equal(refused.code, 'consoles.control_not_allowed');
  outsider.type('reload\r');

  // Opening a line nobody has open on a bench held by another team: refused
  const closedLine = connect('student3', r2);
  const error = await closedLine.frame((f) => f.type === 'error', 'opening refused');
  assert.equal(error.code, 'consoles.open_not_allowed');

  // A teammate may take the keyboard
  const bob = connect('student2', r1);
  const bobSees = await bob.frame((f) => f.type === 'presence' && f.users.length === 3, 'bob joins');
  assert.equal(bobSees.canPilot, true);

  // Activity on the console keeps the bench: lastActivity moves (one write a minute at most)
  clock.ms = T0 + 5 * MIN;
  alice.type('show clock\r');
  await alice.see(/show clock[\s\S]*R1>$/);
  await until(async () => (await app.deps.repos.benches.loadOccupancy()).B4M?.lastActivity === new Date(T0 + 5 * MIN).toISOString(), 'activity recorded in the database');

  // An admin locks the bench: the pilot watches from now on
  assert.equal((await api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'Exam' })).status, 200);
  alice.type('show users\r');
  await new Promise((r) => setTimeout(r, 300));
  assert.doesNotMatch(alice.text, /R1>show users/, 'typing is refused under a lock');
  assert.doesNotMatch(alice.text, /reload/, 'the outsider never typed either');
  alice.send({ type: 'control', action: 'share' });
  assert.equal((await alice.frame((f) => f.type === 'control-refused', 'share refused')).code, 'consoles.control_not_pilot');
  const another = connect('student1', r2);
  assert.equal((await another.frame((f) => f.type === 'error', 'locked bench')).code, 'consoles.open_not_allowed');

  assert.equal((await api('admin', 'DELETE', '/api/benches/B4M/lock')).status, 200);
  alice.type('show users\r');
  await alice.see(/R1>show users/);
  for (const c of [alice, outsider, bob, closedLine, another]) await c.close();
});

test('a task asked before a lock does not run on the locked bench: refused with consoles.control_not_allowed, nothing typed', async () => {
  // B4M is held by Équipe Une (student1, student2) since the tests above
  const r1 = byName('B4M', 'R1');
  const alice = await openReady('student1', r1);
  const bob = connect('student2', r1);
  await bob.frame((f) => f.type === 'presence' && f.users.length === 2, 'bob joins');
  alice.type('show clock\r'); // alice is an active pilot: the task must ask her
  await alice.see(/show clock[\s\S]*R1>$/);
  const room = app.deps.services.consoles.rooms.get(`${r1.target.host}:${r1.target.port}`);
  let ran = false;
  // What bob's inject frame does: room.runExclusive(user, label, fn)
  const task = room.runExclusive(student(2), 'inject', async (cli) => { ran = true; cli.sendLine('TASK-MARKER'); });
  await alice.frame((f) => f.type === 'control' && f.event === 'request', 'alice is asked');
  assert.equal((await api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'Exam' })).status, 200);
  assert.equal(app.deps.services.benches.canPilot(student(2), r1), false);
  // The answer comes after the lock (an admin hands the keyboard over)
  room.grantControl(student(2).id, admin());
  await assert.rejects(task, { code: 'consoles.control_not_allowed' });
  assert.equal(ran, false, 'the task did not run');
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(alice.text, /TASK-MARKER/, 'nothing reached the device');
  assert.equal((await api('admin', 'DELETE', '/api/benches/B4M/lock')).status, 200);
  for (const c of [alice, bob]) await c.close();
});

test('the journal: a spectator who may not drive (an outsider, a wall tile) is named but reads nothing of the day; the team reads it', async () => {
  const r1 = byName('B4M', 'R1');
  const alice = await openReady('student1', r1);
  const wall = connect('student3', r1, '&mode=wall');
  await wall.frame((f) => f.type === 'presence' && f.users.some((u) => u.id === 'oidc:student3' && u.readOnly), 'the wall tile watches');
  await wall.close();
  await alice.close();
  // The team reads the day, and sees who watched
  let sessions = [];
  await until(async () => {
    const team = await api('student2', 'GET', '/api/consoles/journal');
    sessions = team.body.sessions.filter((s) => s.bench === 'B4M' && s.device === 'R1');
    return sessions.some((s) => s.people.includes('Student 3'));
  }, 'the spectator is named among the people of a session');
  const outsider = await api('student3', 'GET', '/api/consoles/journal');
  assert.equal(outsider.status, 200);
  assert.deepEqual(outsider.body.sessions.filter((s) => s.bench === 'B4M' && s.device === 'R1'), [], 'watching gives no right to the day');
  const file = await fetch(`${app.url}/api/consoles/journal/${encodeURIComponent(sessions[0].id).replaceAll('%2F', '/')}`, { headers: app.as('student3') });
  assert.equal(file.status, 403);
});

test('the health page shows the open lines, the shared SSH connections and the journals\' total; the journaling page reads the consoles module', async () => {
  const health = await api('admin', 'GET', '/api/admin/health');
  assert.equal(health.status, 200);
  assert.ok(health.body.journal && Number.isInteger(health.body.journal.bytes));
  assert.equal(health.body.journal.maxBytes, 1024 * 1024 * 1024);
  assert.ok(health.body.consoles && Number.isInteger(health.body.consoles.open));
  assert.ok(Array.isArray(health.body.details.consoles.pool.lines), 'the connections, for admins');
  const student = await api('student1', 'GET', '/api/admin/health');
  assert.equal(student.body.details, undefined);
  assert.equal(typeof student.body.journal.bytes, 'number', 'the total is shown to everyone');

  const journaling = await api('student1', 'GET', '/api/admin/journaling');
  assert.deepEqual(journaling.body.consoleJournal, { enabled: true, retentionDays: 14, maxBytesPerDay: 5120 * 1024, maxTotalBytes: 1024 * 1024 * 1024, readAccess: 'day' });
});
