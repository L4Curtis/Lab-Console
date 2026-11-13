/**
 * Administration pages (SPEC, lot admin), through the real pipeline: lab
 * parameters and their confirmation, diagram import / activation / rollback
 * reaching the consoles registry, admin switches, sessions, audit viewer,
 * announcement banner, health, and admin-only access on every route
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { startTestApp, TEST_ADMIN, adminCode } from './helpers/app.js';
import { call, testClock, createLocalAccount, FAST_SCRYPT } from './helpers/accounts.js';
import { TestBrowser } from './helpers/browser.js';
import { SoftAuthenticator } from './helpers/webauthn.js';
import { createUser } from '../src/modules/auth/index.js';
import { createConsolesModule } from '../src/modules/consoles/index.js';
import { createAccountsModule } from '../src/modules/accounts/index.js';
import { createAdminModule } from '../src/modules/admin/index.js';
import { startMockLab } from '../dev/mock-lab.js';
import { MAX_DIAGRAM_BYTES } from '../src/lib/diagrams.js';

const envAdmin = createUser({ id: `local:${TEST_ADMIN.username}`, username: TEST_ADMIN.username, name: TEST_ADMIN.username, role: 'admin', via: 'local' });
const modules = (deps) => [createConsolesModule(deps), createAccountsModule(deps, { passwordCost: FAST_SCRYPT }), createAdminModule(deps)];

/** A one-page diagram with the given devices: [[name, '.211 - 2050'], …] */
function drawio(devices, { page = 'T1', compressed = false } = {}) {
  const cells = devices.map(([name, target], i) => `<mxCell id="d${i}" value="${name}&lt;br&gt;${target}" style="shape=mxgraph.cisco.routers.router;" vertex="1" parent="1"><mxGeometry x="${10 + i * 80}" y="10" width="50" height="50" as="geometry"/></mxCell>`).join('');
  const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
  const body = compressed ? zlib.deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64') : model;
  return `<mxfile><diagram name="${page}" id="p-${page}">${body}</diagram></mxfile>`;
}

/** Upload raw bytes as the diagram endpoint expects */
async function upload(lab, who, data, name = 'test.drawio') {
  const res = await fetch(`${lab.url}/api/admin/diagrams?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { origin: lab.url, 'content-type': 'application/octet-stream', ...(who ? lab.as(who) : {}) },
    body: data,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A confirmation ticket for the environment's administrator */
async function confirmAsEnvAdmin(lab, clock) {
  clock.advance(30_000); // a fresh TOTP step: an accepted code is burnt
  const res = await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: TEST_ADMIN.password, code: adminCode(clock.ms) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.ticket;
}

describe('administration: who may call what', () => {
  let lab;
  before(async () => { lab = await startTestApp({ modules }); });
  after(() => lab.close());

  const ADMIN_ONLY = [
    ['GET', '/api/admin/lab'], ['PUT', '/api/admin/lab', {}], ['GET', '/api/admin/confirm'], ['POST', '/api/admin/confirm/options', {}],
    ['POST', '/api/admin/confirm', {}], ['GET', '/api/admin/diagrams'], ['POST', '/api/admin/diagrams', {}], ['GET', '/api/admin/diagrams/x/preview'],
    ['GET', '/api/admin/diagrams/x/download'], ['POST', '/api/admin/diagrams/x/activate', {}], ['POST', '/api/admin/diagrams/rollback', {}],
    ['GET', '/api/admin/switches'], ['PUT', '/api/admin/switches', {}], ['GET', '/api/admin/sessions'], ['DELETE', '/api/admin/sessions/x'],
    ['POST', '/api/admin/sessions/revoke-user', {}], ['GET', '/api/admin/audit'], ['PUT', '/api/admin/announcement', {}], ['DELETE', '/api/admin/announcement'],
  ];

  test('every administration route: 401 without a session, 403 for a student', async () => {
    for (const [method, url, body] of ADMIN_ONLY) {
      const nobody = await call(lab, null, method, url, body);
      assert.equal(nobody.status, 401, `${method} ${url} without a session`);
      const student = await call(lab, 'student1', method, url, body);
      assert.equal(student.status, 403, `${method} ${url} as a student`);
      assert.equal(student.body.code, 'auth.forbidden');
    }
  });

  test('the banner, the health summary and the journaling page are for everyone signed in, and nobody else', async () => {
    for (const url of ['/api/admin/announcement', '/api/admin/health', '/api/admin/journaling']) {
      assert.equal((await call(lab, null, 'GET', url)).status, 401, url);
      assert.equal((await call(lab, 'student1', 'GET', url)).status, 200, url);
    }
  });

  test('a write from another site is refused before anything', async () => {
    const res = await fetch(`${lab.url}/api/admin/announcement`, { method: 'PUT', headers: { origin: 'https://evil.example', 'content-type': 'application/json', ...lab.as('admin') }, body: '{"text":"x"}' });
    assert.equal(res.status, 403);
    assert.equal((await call(lab, 'admin', 'GET', '/api/admin/announcement')).body.announcement, null);
  });
});

describe('lab parameters and their confirmation', () => {
  let lab;
  let clock;
  before(async () => {
    clock = testClock();
    lab = await startTestApp({ modules, now: clock.now, env: { TELNET_USERNAME: 'line', TELNET_PASSWORD: 'line-secret-env' } });
  });
  after(() => lab.close());

  test('the page shows the values, never the secrets, and how this administrator confirms', async () => {
    const res = await call(lab, envAdmin, 'GET', '/api/admin/lab');
    assert.equal(res.status, 200);
    const { values } = res.body.settings;
    assert.equal(values.ssh.host, '127.0.0.1');
    assert.deepEqual(values.ssh.password, { set: true });
    assert.deepEqual(values.telnet.password, { set: true });
    assert.ok(!JSON.stringify(res.body).includes('line-secret-env'));
    assert.equal(res.body.confirm.method, 'totp');
    assert.equal(res.body.proxmox.enabled, false);
    assert.equal((await call(lab, 'admin', 'GET', '/api/admin/confirm')).body.method, null, 'an SSO administrator has no way to confirm here');
  });

  test('saving without a confirmation, with someone else\'s, or twice with the same one is refused', async () => {
    const none = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { host: 'jump.example' } } });
    assert.equal(none.status, 403);
    assert.equal(none.body.code, 'admin.confirm_required');

    const ticket = await confirmAsEnvAdmin(lab, clock);
    const other = await call(lab, 'admin', 'PUT', '/api/admin/lab', { values: { ssh: { host: 'jump.example' } }, confirmation: ticket });
    assert.equal(other.status, 403, 'a ticket belongs to the session that confirmed');
    const stale = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { host: 'jump.example' } }, confirmation: ticket });
    assert.equal(stale.status, 403, 'and was spent by the refused attempt');
    assert.equal(lab.deps.settings.get('lab').ssh.host, '127.0.0.1');
  });

  test('a wrong password or code is refused, the SSO administrator cannot confirm, and a code is used once', async () => {
    clock.advance(30_000);
    const wrong = await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: 'nope', code: adminCode(clock.ms) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'admin.confirm_failed');
    const good = await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: TEST_ADMIN.password, code: adminCode(clock.ms) });
    assert.equal(good.status, 200);
    const replay = await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: TEST_ADMIN.password, code: adminCode(clock.ms) });
    assert.equal(replay.status, 401, 'the same code twice');
    const sso = await call(lab, 'admin', 'POST', '/api/admin/confirm', { password: 'x', code: '123456' });
    assert.equal(sso.status, 403);
    assert.equal(sso.body.code, 'admin.confirm_unavailable');
    const audit = await lab.deps.audit.query({ action: 'admin.confirm.fail' });
    assert.ok(audit.length >= 1, 'failed confirmations are audited');
  });

  test('a confirmed save applies at once, is audited without secrets, and invalid values are refused field by field', async () => {
    const bad = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { port: 99999 } }, confirmation: await confirmAsEnvAdmin(lab, clock) });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.params.problems, [{ field: 'ssh.port', code: 'out_of_range' }]);

    const ok = await call(lab, envAdmin, 'PUT', '/api/admin/lab', {
      values: { telnet: { password: 'line-S3cret-new' }, consoles: { portRange: { min: 2000, max: 2010 } } },
      confirmation: await confirmAsEnvAdmin(lab, clock),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.changed.sort(), ['consoles.portRange', 'telnet.password']);
    assert.ok(!JSON.stringify(ok.body).includes('S3cret'));
    assert.equal(lab.deps.settings.get('lab').telnet.password, 'line-S3cret-new');

    const [entry] = await lab.deps.audit.query({ action: 'settings.update' });
    assert.equal(entry.actor.id, envAdmin.id);
    assert.ok(!JSON.stringify(entry).includes('S3cret'));

    // The allow-list moved: the registry re-evaluated its devices (B4M R1 is on port 2013)
    const labs = await call(lab, 'student1', 'GET', '/api/consoles/labs');
    const r1 = labs.body.labs.find((l) => l.name === 'B4M').devices.find((d) => d.name === 'R1');
    assert.equal(r1.allowed, false, 'outside the new port range');
    await store(lab);
    assert.equal(fs.statSync(path.join(lab.dataDir, 'settings', 'lab.json')).mode & 0o777, 0o600);
  });
});

const store = (lab) => lab.deps.store.flush();

describe('passkey confirmation (a local account promoted to administrator)', () => {
  let lab;
  let key;
  let browser;
  before(async () => {
    lab = await startTestApp({ modules, publicHost: 'localhost' });
    key = new SoftAuthenticator({ origin: lab.url });
    const { id } = await createLocalAccount(lab, 'nora');
    assert.equal((await call(lab, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent(id)}`, { role: 'admin' })).status, 200);
    browser = new TestBrowser();
    await call(lab, browser, 'POST', '/auth/local', { username: 'nora', password: 'correct horse battery' });
    const options = await call(lab, browser, 'POST', '/auth/passkey/step/options', {});
    assert.equal((await call(lab, browser, 'POST', '/auth/passkey/step/verify', { response: key.register(options.body.options) })).status, 200);
  });
  after(() => lab.close());

  test('the administrator confirms with its passkey and saves', async () => {
    assert.equal((await call(lab, browser, 'GET', '/api/admin/confirm')).body.method, 'passkey');
    const options = await call(lab, browser, 'POST', '/api/admin/confirm/options', {});
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.allowCredentials.map((c) => c.id), [key.credentials[0].id]);
    const confirmed = await call(lab, browser, 'POST', '/api/admin/confirm', { response: key.authenticate(options.body) });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const saved = await call(lab, browser, 'PUT', '/api/admin/lab', { values: { telnet: { username: 'console2' } }, confirmation: confirmed.body.ticket });
    assert.equal(saved.status, 200);
    assert.equal(lab.deps.settings.get('lab').telnet.username, 'console2');
  });

  test('a response from another site, or without a challenge, is refused', async () => {
    const options = await call(lab, browser, 'POST', '/api/admin/confirm/options', {});
    const phished = await call(lab, browser, 'POST', '/api/admin/confirm', { response: key.authenticate(options.body, { origin: 'https://evil.example' }) });
    assert.equal(phished.status, 401);
    const again = await call(lab, browser, 'POST', '/api/admin/confirm', { response: key.authenticate(options.body) });
    assert.equal(again.status, 401, 'the challenge was single use');
  });
});

describe('diagram import, activation and rollback', () => {
  let lab;
  before(async () => { lab = await startTestApp({ modules }); });
  after(() => lab.close());

  test('the active diagram was seeded in the data directory from DIAGRAM_PATH, as the first version', async () => {
    const current = path.join(lab.dataDir, 'diagrams', 'current.drawio');
    assert.equal(lab.deps.diagrams.currentPath, current);
    assert.deepEqual(fs.readFileSync(current), fs.readFileSync(lab.config.diagramPath));
    const list = (await call(lab, 'admin', 'GET', '/api/admin/diagrams')).body;
    assert.equal(list.versions.length, 1);
    assert.equal(list.versions[0].active, true);
    assert.equal(list.versions[0].source, 'environment');
    assert.equal(list.canRollback, false);
  });

  test('refused: too large, DOCTYPE or entities (compressed pages included), not a diagram, no device', async () => {
    const big = await upload(lab, 'admin', Buffer.alloc(MAX_DIAGRAM_BYTES + 1, 'a'));
    assert.equal(big.status, 413);
    assert.equal(big.body.code, 'admin.diagram_too_large');
    const huge = await upload(lab, 'admin', Buffer.alloc(MAX_DIAGRAM_BYTES + 200 * 1024, 'a'));
    assert.equal(huge.status, 413, 'over the body limit itself');
    assert.equal(huge.body.code, 'admin.diagram_too_large');

    const doctype = `<?xml version="1.0"?><!DOCTYPE mxfile [<!ENTITY x "boom">]>${drawio([['R9', '.211 - 2050']])}`;
    assert.equal((await upload(lab, 'admin', doctype)).body.code, 'admin.diagram_doctype');
    const entityOnly = drawio([['R9', '.211 - 2050']]).replace('<mxfile>', '<mxfile><!ENTITY y SYSTEM "file:///etc/passwd">');
    assert.equal((await upload(lab, 'admin', entityOnly)).body.code, 'admin.diagram_doctype');
    const hidden = drawio([['R9', '.211 - 2050']], { compressed: true }).replace('</diagram>', '</diagram>');
    assert.equal((await upload(lab, 'admin', hidden)).status, 200, 'a compressed page is fine');
    const hiddenDoctype = `<mxfile><diagram name="X" id="x">${zlib.deflateRawSync(Buffer.from(encodeURIComponent('<!DOCTYPE m [<!ENTITY a "b">]><mxGraphModel><root/></mxGraphModel>'))).toString('base64')}</diagram></mxfile>`;
    assert.equal((await upload(lab, 'admin', hiddenDoctype)).body.code, 'admin.diagram_doctype', 'inside a compressed page');

    assert.equal((await upload(lab, 'admin', 'just text')).body.code, 'admin.diagram_invalid');
    assert.equal((await upload(lab, 'admin', '<html><body/></html>')).body.code, 'admin.diagram_invalid');
    assert.equal((await upload(lab, 'admin', drawio([['Cloud', 'no console here']]))).body.code, 'admin.diagram_no_device');
    assert.equal((await upload(lab, 'admin', '')).status, 400);

    const refusals = await lab.deps.audit.query({ action: 'admin.diagram.refuse' });
    assert.ok(refusals.length >= 6, 'refusals are audited');
  });

  test('import shows a preview and the difference; activation reaches the consoles registry; rollback brings it back', async () => {
    const registry = lab.deps.services.consoles.registry;
    const before = registry.model.labs.map((l) => l.name);
    assert.ok(before.includes('B4M'));

    const imported = await upload(lab, 'admin', drawio([['R9', '.211 - 2050'], ['S9', '.211 - 2051']], { page: 'NEW' }), 'new lab.drawio');
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const { version, diff } = imported.body;
    assert.equal(version.name, 'new lab.drawio');
    assert.equal(version.devices, 2);
    assert.deepEqual(diff.labs.added, ['NEW']);
    assert.ok(diff.labs.removed.includes('B4M'));
    assert.deepEqual(diff.devices.added.map((d) => `${d.lab}/${d.name}@${d.target}`), ['NEW/R9@10.22.9.211:2050', 'NEW/S9@10.22.9.211:2051']);
    assert.ok(registry.model.labs.some((l) => l.name === 'B4M'), 'importing changes nothing yet');

    const preview = await call(lab, 'admin', 'GET', `/api/admin/diagrams/${version.id}/preview`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.labs.map((l) => l.name), ['NEW']);
    assert.equal(preview.body.labs[0].devices.length, 2);

    const download = await fetch(`${lab.url}/api/admin/diagrams/${version.id}/download`, { headers: lab.as('admin') });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment; filename="new_lab.drawio"/);
    assert.match(await download.text(), /name="NEW"/);

    const activated = await call(lab, 'admin', 'POST', `/api/admin/diagrams/${version.id}/activate`, {});
    assert.equal(activated.status, 200);
    assert.deepEqual(registry.model.labs.map((l) => l.name), ['NEW'], 'the registry follows at once');
    const labs = await call(lab, 'student1', 'GET', '/api/consoles/labs');
    assert.deepEqual(labs.body.labs.map((l) => l.name), ['NEW']);
    assert.ok(registry.getDevice(`p-NEW:d0`), 'its devices can be opened');
    assert.equal((await call(lab, 'admin', 'POST', `/api/admin/diagrams/${version.id}/activate`, {})).status, 409, 'already active');

    const rolled = await call(lab, 'admin', 'POST', '/api/admin/diagrams/rollback', {});
    assert.equal(rolled.status, 200);
    assert.deepEqual(registry.model.labs.map((l) => l.name), before, 'back to the previous diagram');
    assert.equal(rolled.body.canRollback, false);
    assert.equal((await call(lab, 'admin', 'POST', '/api/admin/diagrams/rollback', {})).status, 409, 'nothing older');
    assert.deepEqual(fs.readFileSync(lab.deps.diagrams.currentPath), fs.readFileSync(lab.config.diagramPath));

    const trail = (await lab.deps.audit.query({ action: 'admin.diagram' })).map((e) => e.action);
    assert.ok(trail.includes('admin.diagram.import') && trail.includes('admin.diagram.activate') && trail.includes('admin.diagram.rollback'));
  });

  test('unknown or malformed version ids are a 404, never a path', async () => {
    for (const id of ['nope', '..%2F..%2Fetc%2Fpasswd', '2026-11-13T00-00-00-000Z-x-zzzzzz']) {
      assert.equal((await call(lab, 'admin', 'GET', `/api/admin/diagrams/${id}/preview`)).status, 404, id);
      assert.equal((await call(lab, 'admin', 'POST', `/api/admin/diagrams/${id}/activate`, {})).status, 404, id);
    }
  });
});

describe('admin switches, sessions, audit viewer, announcement, journaling', () => {
  let lab;
  before(async () => { lab = await startTestApp({ modules }); });
  after(() => lab.close());

  test('the admin switches list is edited and the consoles use it at once', async () => {
    const start = await call(lab, 'admin', 'GET', '/api/admin/switches');
    assert.equal(start.body.source, 'environment');
    assert.ok(start.body.switches.length >= 1);
    const bad = await call(lab, 'admin', 'PUT', '/api/admin/switches', { switches: [{ id: 'Bad Id', name: '', host: 'x y', port: 0 }, { id: 'a', name: 'A', host: '10.22.9.212', port: 2040 }, { id: 'a', name: 'B', host: '10.22.9.212', port: 2041 }] });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.params.problems.map((p) => `${p.index}.${p.field}`).sort(), ['0.host', '0.id', '0.name', '0.port', '2.id']);

    const ok = await call(lab, 'admin', 'PUT', '/api/admin/switches', { switches: [{ id: 'core-1', name: 'Core switch', bay: 'Bay 7', host: '10.22.9.212', port: '2042' }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.source, 'saved');
    const seen = await call(lab, 'student1', 'GET', '/api/consoles/admin-switches');
    assert.deepEqual(seen.body.switches.map((s) => [s.key, s.labName, s.allowed]), [['admin:core-1', 'Bay 7 Core switch', true]]);
    await lab.deps.store.flush();
    assert.ok(fs.existsSync(path.join(lab.dataDir, 'admin', 'switches.json')));
    const [entry] = await lab.deps.audit.query({ action: 'admin.switches.update' });
    assert.deepEqual(entry.details.added, ['core-1']);
  });

  test('sessions are listed and one is ended: its user is signed out', async () => {
    const victim = lab.signIn('student2');
    assert.equal((await call(lab, victim, 'GET', '/api/admin/announcement')).status, 200);
    const list = await call(lab, 'admin', 'GET', '/api/admin/sessions');
    const row = list.body.sessions.find((s) => s.id === victim.id);
    assert.equal(row.user.id, 'oidc:student2');
    assert.ok(!('token' in row) && !('hash' in row));
    assert.equal(list.body.sessions.filter((s) => s.current).length, 1);

    assert.equal((await call(lab, 'admin', 'DELETE', `/api/admin/sessions/${victim.id}`)).status, 200);
    assert.equal((await call(lab, victim, 'GET', '/api/admin/announcement')).status, 401);
    assert.equal((await call(lab, 'admin', 'DELETE', `/api/admin/sessions/${victim.id}`)).status, 404);

    const a = lab.signIn('student3');
    const b = lab.signIn('student3');
    const all = await call(lab, 'admin', 'POST', '/api/admin/sessions/revoke-user', { userId: 'oidc:student3' });
    assert.equal(all.body.count, 2);
    assert.equal((await call(lab, a, 'GET', '/api/admin/journaling')).status, 401);
    assert.equal((await call(lab, b, 'GET', '/api/admin/journaling')).status, 401);
    const [entry] = await lab.deps.audit.query({ action: 'admin.session.revoke' });
    assert.equal(entry.details.user, 'oidc:student2');
  });

  test('the audit viewer filters by action, actor, bench and dates, and refuses bad filters', async () => {
    const student = { headers: {}, socket: {}, user: createUser({ id: 'oidc:student1', username: 'student1', role: 'student', via: 'oidc' }) };
    await lab.deps.audit.log(student, 'console.open', { bench: 'B4M', device: 'R1' });
    await lab.deps.audit.log(student, 'console.open', { bench: 'B5H', device: 'R1' });
    const byBench = await call(lab, 'admin', 'GET', '/api/admin/audit?action=console&bench=B4M');
    assert.equal(byBench.status, 200);
    assert.deepEqual(byBench.body.entries.map((e) => e.details.bench), ['B4M']);
    const byActor = await call(lab, 'admin', 'GET', '/api/admin/audit?actor=oidc%3Astudent1&limit=1');
    assert.equal(byActor.body.entries.length, 1);
    assert.equal(byActor.body.entries[0].details.bench, 'B5H', 'newest first');
    const future = await call(lab, 'admin', 'GET', `/api/admin/audit?since=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`);
    assert.deepEqual(future.body.entries, []);
    for (const q of ['since=yesterday', 'limit=0', 'limit=5000', 'action=DROP%20TABLE']) {
      const res = await call(lab, 'admin', 'GET', `/api/admin/audit?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.code, 'admin.audit_bad_filter');
    }
  });

  test('an announcement reaches everyone through the live stream, as text, and goes away', async () => {
    const bad = await call(lab, 'admin', 'PUT', '/api/admin/announcement', { text: '   ' });
    assert.equal(bad.body.code, 'admin.announcement_empty');
    assert.equal((await call(lab, 'admin', 'PUT', '/api/admin/announcement', { text: 'x'.repeat(501) })).body.code, 'admin.announcement_invalid');
    assert.equal((await call(lab, 'admin', 'PUT', '/api/admin/announcement', { text: 'ok', level: 'panic' })).status, 400);

    const put = await call(lab, 'admin', 'PUT', '/api/admin/announcement', { text: 'Baie 5 en panne <b>ce matin</b>', level: 'warning', hours: 2 });
    assert.equal(put.status, 200);
    const got = await call(lab, 'student1', 'GET', '/api/admin/announcement');
    assert.equal(got.body.announcement.text, 'Baie 5 en panne <b>ce matin</b>', 'kept as typed: the page shows it as text');
    assert.equal(got.body.announcement.level, 'warning');
    assert.ok(Date.parse(got.body.announcement.expiresAt) > Date.now());

    const res = await fetch(`${lab.url}/api/events`, { headers: lab.as('student1') });
    const text = await readUntil(res, 'admin:announcement');
    assert.match(text, /Baie 5 en panne/);

    assert.equal((await call(lab, 'admin', 'DELETE', '/api/admin/announcement')).status, 200);
    assert.equal((await call(lab, 'student1', 'GET', '/api/admin/announcement')).body.announcement, null);
    const trail = (await lab.deps.audit.query({ action: 'admin.announcement' })).map((e) => e.action).sort();
    assert.deepEqual(trail, ['admin.announcement.publish', 'admin.announcement.remove']);
  });

  test('the journaling page says what is kept', async () => {
    const res = await call(lab, 'student1', 'GET', '/api/admin/journaling');
    assert.equal(res.body.sessions.idleHours, 8);
    assert.equal(res.body.audit.retentionDays, null);
  });
});

/** Read an SSE stream until a topic shows up; → the raw text read */
async function readUntil(res, topic, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  try {
    while (!new RegExp(`event: ${topic}\\ndata: [^\\n]+\\n`).test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return text;
}

describe('with the simulated lab: health, and lab parameters used by the next console', () => {
  const SSH = { username: 'jump', password: 'jump-pass' };
  const TELNET = { username: 'line', password: 'line-pass' };
  let mock;
  let lab;
  let clock;
  before(async () => {
    mock = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, names: new Map([['10.22.9.211:2013', 'R1']]) });
    clock = testClock();
    lab = await startTestApp({
      modules,
      now: clock.now,
      env: {
        SSH_HOST: '127.0.0.1', SSH_PORT: String(mock.port), SSH_USERNAME: SSH.username, SSH_PASSWORD: SSH.password,
        TELNET_USERNAME: TELNET.username, TELNET_PASSWORD: TELNET.password, TELNET_WAKE_IDLE_MS: '200',
        ALLOWED_CONSOLE_HOSTS: '10.22.9.211,10.22.9.212',
      },
    });
  });
  after(async () => {
    await lab.close();
    await mock.close();
  });

  test('health: students see states, administrators the details', async () => {
    const student = await call(lab, 'student1', 'GET', '/api/admin/health');
    assert.equal(student.status, 200);
    assert.equal(student.body.jump.state, 'ok');
    assert.deepEqual(student.body.consoleServers, { ok: 2, total: 2 });
    assert.equal(student.body.proxmox.state, 'off');
    assert.equal(student.body.details, undefined);
    assert.ok(!JSON.stringify(student.body).includes('10.22.9'), 'no address for students');

    const admin = await call(lab, 'admin', 'GET', '/api/admin/health?fresh=1');
    assert.deepEqual(admin.body.details.consoleServers.map((s) => [s.host, s.state]), [['10.22.9.211', 'ok'], ['10.22.9.212', 'ok']]);
    assert.equal(admin.body.details.jump.host, `127.0.0.1:${mock.port}`);
  });

  test('a new console line uses the lab parameters saved a moment before', async () => {
    const device = lab.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M').devices.find((d) => d.name === 'R1');
    const first = await consoleOutput(lab, device.key, /R1>/);
    assert.match(first, /R1>/, 'the environment\'s console login works');

    clock.advance(30_000);
    const ticket = (await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: TEST_ADMIN.password, code: adminCode(clock.ms) })).body.ticket;
    const saved = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { telnet: { password: 'wrong-pass' } }, confirmation: ticket });
    assert.equal(saved.status, 200);
    const second = await consoleOutput(lab, device.key, /Login invalid/);
    assert.match(second, /% Login invalid/, 'the next line answered with the new password');

    const health = await call(lab, 'admin', 'GET', '/api/admin/health?fresh=1');
    assert.equal(health.body.jump.state, 'ok');
  });
});

/** Open a console line as student1 and read until `until` shows up */
function consoleOutput(lab, key, until, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${lab.wsUrl}/ws/console?device=${encodeURIComponent(key)}&cols=80&rows=24`, { headers: { origin: lab.url, ...lab.as('student1') } });
    let text = '';
    let woken = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`console never showed ${until}: ${JSON.stringify(text)}`)); }, timeoutMs);
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) return;
      text += raw.toString('utf8');
      // Once the console server's login is answered, the device wakes up on Enter
      if (!woken && /Password: \r\n/.test(text)) {
        woken = true;
        ws.send(JSON.stringify({ type: 'input', data: '\r' }));
      }
      if (until.test(text)) {
        clearTimeout(timer);
        ws.close();
        resolve(text);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
