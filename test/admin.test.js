/**
 * Administration pages (SPEC, lot admin), through the real pipeline: lab
 * parameters and their confirmation, diagram import / activation / rollback
 * reaching the consoles registry, admin switches, sessions, audit viewer,
 * announcement banner, health, and admin-only access on every route
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { startTestApp, TEST_ADMIN, adminCode } from './helpers/app.js';
import { call, testClock, createLocalAccount, FAST_SCRYPT } from './helpers/accounts.js';
import { TestBrowser, signInWithOidc } from './helpers/browser.js';
import { SoftAuthenticator } from './helpers/webauthn.js';
import { createUser } from '../src/modules/auth/index.js';
import { createConsolesModule } from '../src/modules/consoles/index.js';
import { createAccountsModule } from '../src/modules/accounts/index.js';
import { createAdminModule } from '../src/modules/admin/index.js';
import { startMockLab } from '../dev/mock-lab.js';
import { startMockOidc } from '../dev/mock-oidc.js';
import { createHealth, probe } from '../src/modules/admin/health.js';
import { TICKET_TTL_MS } from '../src/modules/admin/confirm.js';
import { MAX_DIAGRAM_BYTES } from '../src/lib/diagrams.js';

const envAdmin = createUser({ id: `local:${TEST_ADMIN.username}`, username: TEST_ADMIN.username, name: TEST_ADMIN.username, role: 'admin', via: 'local' });
const modules = (deps) => [createConsolesModule(deps), createAccountsModule(deps, { passwordCost: FAST_SCRYPT }), createAdminModule(deps)];
/** The same, with the administration module on a clock the test moves (ticket lifetimes) */
const modulesAt = (clock) => (deps) => [createConsolesModule(deps), createAccountsModule(deps, { passwordCost: FAST_SCRYPT }), createAdminModule(deps, { now: clock.now })];

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
    ['GET', '/api/admin/lab'], ['PUT', '/api/admin/lab', {}], ['POST', '/api/admin/lab/confirm-sso', {}], ['GET', '/api/admin/confirm'], ['POST', '/api/admin/confirm/options', {}],
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

describe('lab parameters: values are checked before the confirmation is spent', () => {
  let lab;
  let clock;
  before(async () => {
    clock = testClock();
    lab = await startTestApp({ modules, now: clock.now });
  });
  after(() => lab.close());

  test('a typo in a port is told at once and the same confirmation still works for the corrected value', async () => {
    const ticket = await confirmAsEnvAdmin(lab, clock);
    const typo = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { port: 'twenty-two' } }, confirmation: ticket });
    assert.equal(typo.status, 400);
    assert.equal(typo.body.code, 'settings.invalid');
    assert.deepEqual(typo.body.params.problems, [{ field: 'ssh.port', code: 'type' }]);
    assert.equal(lab.deps.settings.get('lab').ssh.port, 1, 'nothing saved');

    const fixed = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { port: 2222 } }, confirmation: ticket });
    assert.equal(fixed.status, 200, 'the ticket was not used up by the 400');
    assert.equal(lab.deps.settings.get('lab').ssh.port, 2222);
    const again = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { port: 2223 } }, confirmation: ticket });
    assert.equal(again.status, 403, 'and it is good once');
  });

  test('a wrong ticket is refused before the values are looked at, and is spent', async () => {
    const ticket = await confirmAsEnvAdmin(lab, clock);
    const other = await call(lab, 'admin', 'PUT', '/api/admin/lab', { values: { ssh: { port: 'x' } }, confirmation: ticket });
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'admin.confirm_required');
    const owner = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { ssh: { port: 2224 } }, confirmation: ticket });
    assert.equal(owner.status, 403, 'someone else tried it: it is spent');
  });

  test('keys such as constructor, toString or __proto__ are unknown fields: 400, not 500, and the ticket stays good', async () => {
    const ticket = await confirmAsEnvAdmin(lab, clock);
    for (const raw of ['{"values":{"constructor":"x"}}', '{"values":{"toString":"x"}}', '{"values":{"__proto__":"x"}}', '{"values":{"ssh":{"__proto__":{"a":1}}}}']) {
      const res = await fetch(`${lab.url}/api/admin/lab`, {
        method: 'PUT',
        headers: { origin: lab.url, 'content-type': 'application/json', ...lab.as(envAdmin) },
        body: raw.replace(/\}$/, `,"confirmation":"${ticket}"}`),
      });
      const body = await res.json();
      assert.equal(res.status, 400, raw);
      assert.equal(body.code, 'settings.invalid', raw);
      assert.equal(body.params.problems[0].code, 'unknown', raw);
    }
    const ok = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { telnet: { username: 'after-the-typos' } }, confirmation: ticket });
    assert.equal(ok.status, 200);
  });
});

describe('confirmation: lifetime of a ticket and number of attempts', () => {
  let lab;
  let clock;
  before(async () => {
    clock = testClock();
    lab = await startTestApp({ modules: modulesAt(clock), now: clock.now });
  });
  after(() => lab.close());

  test('a ticket older than two minutes is refused, and so is a change that waited for it', async () => {
    const ticket = await confirmAsEnvAdmin(lab, clock);
    clock.advance(TICKET_TTL_MS + 1000);
    const late = await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { telnet: { username: 'too-late' } }, confirmation: ticket });
    assert.equal(late.status, 403);
    assert.equal(late.body.code, 'admin.confirm_required');
    assert.notEqual(lab.deps.settings.get('lab').telnet.username, 'too-late');

    const fresh = await confirmAsEnvAdmin(lab, clock);
    clock.advance(TICKET_TTL_MS - 5000); // the confirmation step moved the clock too; stay inside the window
    assert.equal((await call(lab, envAdmin, 'PUT', '/api/admin/lab', { values: { telnet: { username: 'in-time' } }, confirmation: fresh })).status, 200);
  });
});

describe('confirmation: the attempt limit', () => {
  let lab;
  let clock;
  before(async () => {
    clock = testClock();
    lab = await startTestApp({ modules, now: clock.now });
  });
  after(() => lab.close());

  test('ten failed attempts, then 429 admin.confirm_throttled for the right password and code too; the code stays good', async () => {
    for (let i = 0; i < 10; i++) {
      const wrong = await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: 'nope', code: '000000' });
      assert.equal(wrong.status, 401, `attempt ${i + 1}`);
      assert.equal(wrong.body.code, 'admin.confirm_failed');
    }
    clock.advance(30_000);
    const code = adminCode(clock.ms);
    const blocked = await call(lab, envAdmin, 'POST', '/api/admin/confirm', { password: TEST_ADMIN.password, code });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'admin.confirm_throttled');
    assert.equal(blocked.body.ticket, undefined);
    assert.equal(await lab.deps.auth.reauthenticate(envAdmin, { password: TEST_ADMIN.password, code }), true, 'the refused attempt did not burn the code');
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

describe('confirmation by an SSO administrator: signing in again at the identity provider', () => {
  let idp;
  let lab;
  let ada;
  before(async () => {
    idp = await startMockOidc({ port: 0 });
    lab = await startTestApp({
      modules,
      env: { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'lab-console', OIDC_CLIENT_SECRET: 'mock-secret', OIDC_ADMIN_GROUPS: 'admins', OIDC_SCOPES: 'openid profile email groups', OIDC_GROUPS_CLAIM: 'groups' },
    });
  });
  beforeEach(async () => {
    idp.misbehave();
    ada = (await signInWithOidc(lab, 'admin')).browser;
  });
  after(async () => {
    await lab.close();
    await idp.close();
  });

  /** Follow the browser through the provider as `username`; → where it lands in the application */
  async function atProvider(browser, url, username) {
    const picker = await (await browser.fetch(url)).text();
    const request = /\/authorize\/pick\?req=([\w-]+)/.exec(picker)[1];
    const { url: landed } = await browser.go(`${idp.issuer}/authorize/pick?req=${request}&user=${username}`);
    return landed;
  }
  const start = (browser, values) => call(lab, browser, 'POST', '/api/admin/lab/confirm-sso', { values });
  const outcome = async (browser) => (await call(lab, browser, 'GET', '/api/admin/lab')).body.ssoOutcome;

  test('the way to confirm is the provider, for an administrator who has no password or passkey here', async () => {
    assert.equal((await call(lab, ada, 'GET', '/api/admin/confirm')).body.method, 'sso');
    assert.equal((await call(lab, ada, 'GET', '/api/admin/lab')).body.confirm.method, 'sso');
    const options = await call(lab, ada, 'POST', '/api/admin/confirm', { password: 'x', code: '123456' });
    assert.equal(options.status, 403, 'the password form is not for them');
    assert.equal((await call(lab, envAdmin, 'POST', '/api/admin/lab/confirm-sso', { values: { telnet: { username: 'x' } } })).body.code, 'admin.confirm_unavailable', 'nor is the trip for the environment administrator');
  });

  test('a fresh sign-in at the provider applies the change on return; its outcome is read once', async () => {
    const started = await start(ada, { telnet: { username: 'sso-confirmed' } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const url = new URL(started.body.url);
    assert.equal(url.origin + url.pathname, `${idp.issuer}/authorize`);
    assert.equal(url.searchParams.get('prompt'), 'login', 'a fresh sign-in is asked for');
    assert.equal(url.searchParams.get('max_age'), '0');
    assert.notEqual(lab.deps.settings.get('lab').telnet.username, 'sso-confirmed', 'nothing yet');
    const sessions = lab.deps.auth.sessions.list().length;

    assert.equal(await atProvider(ada, started.body.url, 'admin'), `${lab.url}/#/admin/lab`);
    assert.equal(lab.deps.settings.get('lab').telnet.username, 'sso-confirmed');
    assert.equal(lab.deps.auth.sessions.list().length, sessions, 'no session was opened or replaced by the trip');
    const back = await outcome(ada);
    assert.equal(back.ok, true);
    assert.deepEqual(back.changed, ['telnet.username']);
    assert.equal(await outcome(ada), null, 'read once');
    const [entry] = await lab.deps.audit.query({ action: 'settings.update' });
    assert.equal(entry.actor.id, 'oidc:mock-admin');
  });

  test('values that are wrong are refused before the trip, and nothing is waiting afterwards', async () => {
    const bad = await start(ada, { ssh: { port: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'settings.invalid');
    assert.ok(!bad.res.headers.getSetCookie().some((c) => c.startsWith('lc_login=')), 'no sign-in started');
    assert.equal((await start(ada, { constructor: 'x' })).status, 400);
    assert.equal(await outcome(ada), null);
  });

  test('another person signing in at the provider changes nothing: it must be the same administrator', async () => {
    const started = await start(ada, { telnet: { username: 'someone-else' } });
    await atProvider(ada, started.body.url, 'student1');
    assert.notEqual(lab.deps.settings.get('lab').telnet.username, 'someone-else');
    assert.equal((await outcome(ada)).code, 'admin.sso_confirm_mismatch');

    // A different administrator is not the same person either
    const other = await start(ada, { telnet: { username: 'someone-else' } });
    await atProvider(ada, other.body.url, 'student2');
    assert.equal((await outcome(ada)).code, 'admin.sso_confirm_mismatch');
    assert.notEqual(lab.deps.settings.get('lab').telnet.username, 'someone-else');
  });

  test('a provider that hands back an old sign-in instead of a fresh one is refused', async () => {
    idp.misbehave({ staleSignIn: true });
    const started = await start(ada, { telnet: { username: 'stale' } });
    await atProvider(ada, started.body.url, 'admin');
    assert.notEqual(lab.deps.settings.get('lab').telnet.username, 'stale');
    assert.equal((await outcome(ada)).code, 'admin.sso_confirm_failed');
  });

  test('a session that ended while its owner was at the provider applies nothing', async () => {
    const started = await start(ada, { telnet: { username: 'gone' } });
    const mine = lab.deps.auth.sessions.list().find((s) => s.user.id === 'oidc:mock-admin');
    lab.deps.auth.sessions.revoke(mine.id);
    await atProvider(ada, started.body.url, 'admin');
    assert.notEqual(lab.deps.settings.get('lab').telnet.username, 'gone');
  });

  test('the number of trips is limited like the other confirmations', async () => {
    const results = [];
    for (let i = 0; i < 11; i++) results.push((await start(ada, { telnet: { username: `try-${i}` } })).status);
    assert.equal(results.at(-1), 429);
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

  const MODEL = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="x" value="S9&lt;br&gt;.211 - 2060" style="shape=mxgraph.cisco.switches.workgroup_switch;" vertex="1" parent="1"><mxGeometry width="40" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
  const packOf = (xml) => zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString('base64');
  const file = (body) => `<mxfile><diagram name="X" id="x">${body}</diagram></mxfile>`;

  test('a DOCTYPE in a compressed page is refused whether the page is plain, in CDATA, split by a comment or started by a character reference', async () => {
    const packed = packOf(`<!DOCTYPE m [<!ENTITY a "boom"><!ENTITY b "&a;&a;&a;">]>${MODEL}`);
    const forms = {
      plain: packed,
      cdata: `<![CDATA[${packed}]]>`,
      comment: `${packed.slice(0, 20)}<!-- x -->${packed.slice(20)}`,
      charref: `&#${packed.charCodeAt(0)};${packed.slice(1)}`,
    };
    for (const [form, body] of Object.entries(forms)) {
      const res = await upload(lab, 'admin', file(body));
      assert.equal(res.status, 400, form);
      assert.equal(res.body.code, 'admin.diagram_doctype', form);
    }
    // The same wrappers around an honest page are fine
    const honest = packOf(MODEL);
    for (const body of [`<![CDATA[${honest}]]>`, `${honest.slice(0, 20)}<!-- x -->${honest.slice(20)}`, `&#${honest.charCodeAt(0)};${honest.slice(1)}`]) {
      assert.equal((await upload(lab, 'admin', file(body))).status, 200);
    }
  });

  test('a small file that inflates to hundreds of megabytes is refused without being inflated', async () => {
    const page = (n) => packOf(`<mxGraphModel><root><mxCell id="0" value="${'a'.repeat(n)}"/></root></mxGraphModel>`);
    const bomb = file(page(60 * 1024 * 1024));
    assert.ok(bomb.length < 200 * 1024, `${bomb.length} bytes on the wire`);
    const started = process.hrtime.bigint();
    const rss = process.memoryUsage().rss;
    const res = await upload(lab, 'admin', bomb);
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'admin.diagram_too_large');
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 3000, 'refused quickly');
    assert.ok(process.memoryUsage().rss - rss < 120 * 1024 * 1024, 'and without the memory a 60 MB inflate would take');

    // Several pages, each under the limit, together over it
    const four = `<mxfile>${[1, 2, 3, 4].map((i) => `<diagram name="P${i}" id="p${i}">${page(6 * 1024 * 1024)}</diagram>`).join('')}</mxfile>`;
    const many = await upload(lab, 'admin', four);
    assert.equal(many.status, 413);
    assert.equal(many.body.code, 'admin.diagram_too_large');
  });

  test('two different devices on one console line are refused at import (what check-diagram fails on); one device on two pages is fine', async () => {
    const before = (await call(lab, 'admin', 'GET', '/api/admin/diagrams')).body.versions.length;
    const clash = await upload(lab, 'admin', drawio([['R9', '.211 - 2050'], ['S9', '.211 - 2050']]));
    assert.equal(clash.status, 400);
    assert.equal(clash.body.code, 'admin.diagram_lint');
    assert.equal(clash.body.params.count, 1);
    assert.equal(clash.body.params.lines, '10.22.9.211:2050');
    assert.equal(clash.body.params.problems[0].params.target, '10.22.9.211:2050');
    assert.equal((await call(lab, 'admin', 'GET', '/api/admin/diagrams')).body.versions.length, before, 'nothing kept');
    const [refusal] = await lab.deps.audit.query({ action: 'admin.diagram.refuse' });
    assert.equal(refusal.details.reason, 'admin.diagram_lint');

    const twoPages = `<mxfile>${['A', 'B'].map((p) => drawio([['R9', '.211 - 2051']], { page: p }).replace(/<\/?mxfile>/g, '')).join('')}</mxfile>`;
    const shared = await upload(lab, 'admin', twoPages);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.warnings.length, 1, 'a warning, not a refusal');
  });

  test('the preview names the devices whose console is outside the allow-list', async () => {
    const imported = await upload(lab, 'admin', drawio([['R9', '.211 - 2052'], ['R8', '.215 - 2052'], ['R7', '.211 - 2500']]), 'outside.drawio');
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const expected = [{ lab: 'T1', name: 'R8', target: '10.22.9.215:2052' }, { lab: 'T1', name: 'R7', target: '10.22.9.211:2500' }];
    assert.deepEqual(imported.body.outsideAllowList, expected);
    const preview = await call(lab, 'admin', 'GET', `/api/admin/diagrams/${imported.body.version.id}/preview`);
    assert.deepEqual(preview.body.outsideAllowList, expected);
    const inside = await upload(lab, 'admin', drawio([['R9', '.211 - 2053']]));
    assert.deepEqual(inside.body.outsideAllowList, []);
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

describe('diagram activation and the linter', () => {
  let lab;
  before(async () => { lab = await startTestApp({ modules }); });
  after(() => lab.close());

  test('a version the linter does not accept cannot be activated; going back to it with a rollback is allowed', async () => {
    // The diagram shipped with the image has a typo the linter reports (B5H)
    const seeded = (await call(lab, 'admin', 'GET', '/api/admin/diagrams')).body.versions[0];
    assert.ok(seeded.warnings > 0);
    const first = (await upload(lab, 'admin', drawio([['R1', '.211 - 2070']], { page: 'ONE' }))).body.version;
    const second = (await upload(lab, 'admin', drawio([['R1', '.211 - 2071']], { page: 'TWO' }))).body.version;
    assert.equal((await call(lab, 'admin', 'POST', `/api/admin/diagrams/${first.id}/activate`, {})).status, 200);
    assert.equal((await call(lab, 'admin', 'POST', `/api/admin/diagrams/${second.id}/activate`, {})).status, 200);

    const refused = await call(lab, 'admin', 'POST', `/api/admin/diagrams/${seeded.id}/activate`, {});
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'admin.diagram_lint');
    assert.equal((await call(lab, 'admin', 'GET', '/api/admin/diagrams')).body.active, second.id, 'still the active one');

    assert.equal((await call(lab, 'admin', 'POST', '/api/admin/diagrams/rollback', {})).body.rolledBackTo, first.id);
    const back = await call(lab, 'admin', 'POST', '/api/admin/diagrams/rollback', {});
    assert.equal(back.status, 200);
    assert.equal(back.body.rolledBackTo, seeded.id, 'a rollback returns to what was active, linter or not');
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
    for (const id of ['no-such-session', 'a'.repeat(64), '..%2F..%2Fetc']) {
      const unknown = await call(lab, 'admin', 'DELETE', `/api/admin/sessions/${id}`);
      assert.equal(unknown.status, 404, id);
      assert.equal(unknown.body.code, 'admin.session_unknown', id);
    }
    assert.equal((await lab.deps.audit.query({ action: 'admin.session.revoke' })).length, 1, 'nothing audited for an unknown session');

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

  test('a console server counts as up when it answers, even by refusing; Proxmox must accept; silence is down', async () => {
    const said = (code, text) => ({
      exec(_command, cb) {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        setImmediate(() => { if (text) stream.stderr.emit('data', Buffer.from(text)); stream.emit('exit', code); });
      },
    });
    const refused = 'nc: connect to 10.22.9.211 port 23 (tcp) failed: Connection refused\n';
    assert.deepEqual(await probe(said(0, ''), '10.22.9.211', 23, { answers: true }), { state: 'ok' });
    assert.deepEqual(await probe(said(1, refused), '10.22.9.211', 23, { answers: true }), { state: 'ok', note: 'refused' }, 'a reset comes from the host');
    assert.equal((await probe(said(1, refused), '10.22.9.71', 8006)).state, 'down', 'the Proxmox API port must accept');
    assert.equal((await probe(said(1, 'nc: connect to 10.22.9.211 port 23 (tcp) timed out: Operation now in progress\n'), '10.22.9.211', 23, { answers: true })).state, 'down', 'silence');
    assert.equal((await probe(said(1, ''), '10.22.9.211', 23, { answers: true })).state, 'down');
    assert.equal((await probe(said(0, ''), 'bad host;rm', 23)).state, 'down', 'nothing odd reaches the shell');
  });

  test('the Proxmox tunnel state comes from the Proxmox module when it publishes one', async () => {
    const config = { ...lab.config, proxmox: { enabled: true, url: 'https://10.22.9.71:8006' } };
    const services = {};
    const health = createHealth({ settings: lab.deps.settings, config, services });
    const before = await health.check({ fresh: true });
    assert.equal(before.proxmox.tunnel, null, 'the module says nothing yet');

    services.proxmox = { tunnel: () => ({ connected: true, transport: 'forward', connections: 1, openChannels: 3 }) };
    health.forget();
    const connected = await health.check({ fresh: true });
    assert.deepEqual(connected.proxmox.tunnel, { state: 'connected', transport: 'forward', connections: 1, openChannels: 3 });
    assert.equal(connected.jump.state, 'ok');

    services.proxmox = { tunnel: () => ({ connected: false, transport: 'auto', connections: 0, openChannels: 0 }) };
    health.forget();
    assert.equal((await health.check({ fresh: true })).proxmox.tunnel.state, 'idle', 'it connects on first use: idle is normal');
    services.proxmox = { tunnel: () => { throw new Error('boom'); } };
    health.forget();
    assert.equal((await health.check({ fresh: true })).proxmox.tunnel, null, 'a module that fails does not fail the page');
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
