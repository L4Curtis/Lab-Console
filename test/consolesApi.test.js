/**
 * The consoles module in the real application, against the mock lab: two
 * students on one console over the WebSocket (join, replay, presence, the
 * keyboard handed over by message), spectators refused for automation when
 * the bench rule says so, the live summaries, the journal API with its
 * permissions, and "tell me when it is free"
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';
import { startMockLab } from '../dev/mock-lab.js';
import { startTestApp, repoRoot } from './helpers/app.js';
import { parseDrawio } from '../src/modules/consoles/drawio.js';
import { createConsolesModule } from '../src/modules/consoles/index.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const TELNET = { username: 'line', password: 'line-pass' };

let lab;
let app;
let devices;
const byName = (bench, name) => devices.find((d) => d.labName === bench && d.name === name);

before(async () => {
  const names = new Map();
  const { labs } = parseDrawio(fs.readFileSync(`${repoRoot}/diagrams/diagram.drawio`, 'utf8'), { networkPrefix: '10.22.9' });
  devices = labs.flatMap((l) => l.devices.map((d) => ({ ...d, labName: l.name })));
  for (const d of devices) names.set(`${d.target.host}:${d.target.port}`, d.name);
  lab = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, names, busyPorts: [2016] });
  app = await startTestApp({
    env: {
      SSH_HOST: '127.0.0.1', SSH_PORT: String(lab.port), SSH_USERNAME: SSH.username, SSH_PASSWORD: SSH.password,
      TELNET_USERNAME: TELNET.username, TELNET_PASSWORD: TELNET.password, TELNET_WAKE_IDLE_MS: '150',
    },
    modules: (deps) => [createConsolesModule(deps, { watchRetryMs: 150, watchMaxMs: 5000, rooms: { controlTimeoutMs: 10_000 } })],
  });
});

after(async () => {
  await app?.close();
  await lab?.close();
});

function connect(who, device, extra = '') {
  const ws = new WebSocket(`${app.wsUrl}/ws/console?device=${encodeURIComponent(device.key)}&cols=80&rows=24${extra}`, { headers: { origin: app.url, ...app.as(who) } });
  const c = { ws, frames: [], text: '', closed: false };
  ws.on('message', (raw, isBinary) => { if (isBinary) c.text += raw.toString('latin1'); else c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', () => { c.closed = true; });
  c.send = (msg) => ws.send(JSON.stringify(msg));
  c.type = (data) => c.send({ type: 'input', data });
  c.until = (fn, what, ms = 6000) => until(() => fn(c), `${who}: ${what}`, ms);
  c.see = (re) => c.until((x) => re.test(x.text), `screen ${re}`);
  c.frame = async (pred, what) => { await c.until((x) => x.frames.some(pred), what); return c.frames.filter(pred).at(-1); };
  c.close = () => new Promise((r) => { if (c.closed) return r(); ws.once('close', r); ws.close(); });
  return c;
}

async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const get = (who, path) => fetch(`${app.url}${path}`, { headers: who ? app.as(who) : {} });
const notify = (who, device) => fetch(`${app.url}/api/consoles/notify`, {
  method: 'POST', headers: { ...app.as(who), origin: app.url, 'content-type': 'application/json' }, body: JSON.stringify({ device }),
});

/** The console server's login is done once "Password:" was answered */
async function openReady(who, device) {
  const c = connect(who, device);
  await c.see(/Password: /);
  await c.until((x) => x.frames.some((f) => f.type === 'status' && f.phase === 'login'), 'auto-login');
  c.type('\r');
  await c.see(new RegExp(`${device.name}>$`));
  return c;
}

test('consoles over the WebSocket: bob joins alice\'s line, sees its history, asks for the keyboard and types', async () => {
  const r1 = byName('B4M', 'R1');
  const alice = await openReady('student1', r1);
  alice.type('show clock\r');
  await alice.see(/show clock[\s\S]*R1>$/);

  const bob = connect('student2', r1);
  await bob.frame((f) => f.type === 'replay', 'replay');
  await bob.see(/R1>show clock/);
  const presence = await bob.frame((f) => f.type === 'presence' && f.users.length === 2, 'two people');
  assert.equal(presence.pilot, 'oidc:student1');
  assert.equal(presence.mayType, false);

  bob.type('reload\r'); // ignored: bob watches
  bob.send({ type: 'control', action: 'request' });
  const ask = await alice.frame((f) => f.type === 'control' && f.event === 'request', 'request');
  assert.equal(ask.by.id, 'oidc:student2');
  alice.send({ type: 'control', action: 'grant' });
  await bob.frame((f) => f.type === 'presence' && f.mayType, 'bob may type');
  bob.type('show users\r');
  await alice.see(/R1>show users/);
  assert.doesNotMatch(alice.text, /reload/, 'the spectator\'s keys never reached the device');

  // A refused action comes back with its code
  alice.send({ type: 'control', action: 'take' });
  const refused = await alice.frame((f) => f.type === 'control-refused', 'take refused');
  assert.equal(refused.code, 'consoles.control_admin_only');

  // The live summary, as other modules and the SSE stream see it
  const { rooms } = await (await get('student3', '/api/consoles/rooms')).json();
  const mine = rooms.find((r) => r.device === 'R1' && r.bench === 'B4M');
  assert.equal(mine.pilot.id, 'oidc:student2');
  assert.deepEqual(mine.users.map((u) => u.id).sort(), ['oidc:student1', 'oidc:student2']);
  assert.equal(mine.lastCommand, 'show users');
  const { activity } = await (await get('student3', '/api/consoles/activity')).json();
  assert.ok(activity.some((a) => a.kind === 'join' && a.user.id === 'oidc:student2'));

  // The audit trail has the opening, the joining and the handover, never keystrokes
  const entries = await app.deps.audit.query({ action: 'console' });
  assert.ok(entries.some((e) => e.action === 'console.open' && e.actor.id === 'oidc:student1' && e.details.device === 'R1'));
  assert.ok(entries.some((e) => e.action === 'console.control.granted' && e.actor.id === 'oidc:student2'));
  assert.doesNotMatch(JSON.stringify(entries), /show users|reload/);

  // The pilot frees the line: everyone gets the reason
  bob.send({ type: 'control', action: 'hangup' });
  const exit = await alice.frame((f) => f.type === 'exit', 'freed');
  assert.equal(exit.code, 'consoles.freed');
  await alice.close();
  await bob.close();
});

test('consoles: on a bench of another team you watch: no opening, no export, no keyboard', async () => {
  const s4 = byName('B4M', 'S4');
  app.deps.services.benches = { canPilot: (user) => user.id !== 'oidc:student3' };
  try {
    const refused = connect('student3', s4);
    const error = await refused.frame((f) => f.type === 'error', 'refused');
    assert.equal(error.code, 'consoles.open_not_allowed');

    const alice = await openReady('student1', s4);
    const eve = connect('student3', s4);
    await eve.frame((f) => f.type === 'presence' && f.users.length === 2, 'joined to watch');
    eve.send({ type: 'export-config' });
    const answer = await eve.frame((f) => f.type === 'automation', 'export refused');
    assert.equal(answer.code, 'consoles.control_not_allowed');
    assert.equal(alice.frames.some((f) => f.type === 'automation'), false, 'only the asker hears the refusal');
    eve.send({ type: 'control', action: 'request' });
    assert.equal((await eve.frame((f) => f.type === 'control-refused', 'request refused')).code, 'consoles.control_not_allowed');

    // The pilot exports: the task runs on her keyboard, everyone sees it, the file goes to her
    alice.type('enable\r');
    await alice.see(/S4#$/);
    alice.send({ type: 'export-config' });
    const file = await alice.frame((f) => f.type === 'export-result', 'export result');
    assert.match(file.content, /hostname S4/);
    await eve.frame((f) => f.type === 'automation' && f.state === 'done', 'the spectator sees the task end');
    assert.equal(eve.frames.some((f) => f.type === 'export-result'), false, 'the file is not sent to spectators');
    await eve.close();
    await alice.close();
  } finally {
    delete app.deps.services.benches;
  }
});

test('consoles: a wall tile only watches an open line and is refused on a closed one', async () => {
  const s1 = byName('B4M', 'S2');
  const wallFirst = connect('student2', s1, '&mode=wall');
  assert.equal((await wallFirst.frame((f) => f.type === 'error', 'no room')).code, 'consoles.room_gone');
  const alice = await openReady('student1', s1);
  const wall = connect('student2', s1, '&mode=wall');
  const p = await wall.frame((f) => f.type === 'presence' && f.users.length === 2, 'watching');
  assert.equal(p.mayType, false);
  // The keyboard is shared and then left free: a wall socket still has no keys, no control, no automation
  alice.send({ type: 'control', action: 'share' });
  await wall.frame((f) => f.type === 'presence' && f.shared, 'shared');
  wall.type('show wallhack\r');
  wall.send({ type: 'break' });
  wall.send({ type: 'export-config' });
  for (const action of ['request', 'hangup', 'take']) wall.send({ type: 'control', action });
  const refused = await wall.until((x) => x.frames.filter((f) => f.type === 'control-refused').length === 3, 'three refusals')
    .then(() => wall.frames.filter((f) => f.type === 'control-refused'));
  assert.deepEqual(refused.map((f) => [f.action, f.code]), [['request', 'consoles.wall_read_only'], ['hangup', 'consoles.wall_read_only'], ['take', 'consoles.wall_read_only']]);
  alice.send({ type: 'control', action: 'release' });
  await wall.frame((f) => f.type === 'presence' && f.pilot === null, 'the line is free');
  wall.send({ type: 'control', action: 'request' });
  await wall.until((x) => x.frames.filter((f) => f.type === 'control-refused').length === 4, 'refused on a free line too');
  // Alice types after all that: what reaches the device is hers alone
  alice.send({ type: 'control', action: 'request' });
  await alice.frame((f) => f.type === 'presence' && f.mayType, 'alice has it back');
  alice.type('show users\r');
  await alice.see(/S2>show users/);
  assert.doesNotMatch(alice.text, /wallhack/, 'the wall socket\'s keys never reached the device');
  assert.equal(wall.frames.some((f) => f.type === 'presence' && f.mayType), false);
  assert.equal(alice.frames.some((f) => f.type === 'control' && f.event === 'request'), false, 'the pilot was never asked');
  assert.equal(wall.frames.some((f) => f.type === 'automation'), false, 'automation is not offered on a wall tile');
  assert.equal(wall.closed, false, 'the line is still open');
  await wall.close();
  await alice.close();
});

test('consoles: a busy line is refused with its own message; "tell me when it is free" tells only that user', async () => {
  const busy = byName('B4M', 'S1'); // port 2016: held outside the application
  const alice = connect('student1', busy);
  const exit = await alice.frame((f) => f.type === 'exit', 'refused line');
  assert.equal(exit.code, 'consoles.line_refused');
  const { busy: outside } = await (await get('student1', '/api/consoles/rooms')).json();
  assert.ok(outside.includes(`${busy.target.host}:${busy.target.port}`));

  // Subscribe to the event streams of alice and bob
  const streams = await Promise.all(['student1', 'student2'].map(async (who) => {
    const ctl = new AbortController();
    const res = await fetch(`${app.url}/api/events`, { headers: app.as(who), signal: ctl.signal });
    const s = { text: '', ctl };
    (async () => { try { for await (const chunk of res.body) s.text += Buffer.from(chunk).toString(); } catch { /* aborted */ } })();
    return s;
  }));
  try {
    const post = await fetch(`${app.url}/api/consoles/notify`, {
      method: 'POST', headers: { ...app.as('student1'), origin: app.url, 'content-type': 'application/json' }, body: JSON.stringify({ device: busy.key }),
    });
    assert.equal(post.status, 200);
    assert.ok(Date.parse((await post.json()).until) > Date.now());
    assert.equal((await (await get('student1', '/api/consoles/notify')).json()).watches.length, 1);
    lab.setBusy(2016, false); // the person outside lets go
    await until(() => /event: consoles:free/.test(streams[0].text), 'alice is told', 5000);
    assert.match(streams[0].text, /"state":"free"/);
    assert.doesNotMatch(streams[1].text, /consoles:free/, 'bob is not');
    await until(() => !/2016/.test(JSON.stringify(app.deps.services.consoles.rooms.busyOutside())), 'no longer busy outside');

    // Refusals: an unknown device, a missing session, someone else's watch
    const unknown = await fetch(`${app.url}/api/consoles/notify`, {
      method: 'POST', headers: { ...app.as('student1'), origin: app.url, 'content-type': 'application/json' }, body: JSON.stringify({ device: 'nope' }),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'consoles.device_gone');
    assert.equal((await fetch(`${app.url}/api/consoles/notify`, { method: 'POST', headers: { origin: app.url } })).status, 401);
    // A device whose console address is outside the allow-list of the lab settings
    const { settings } = app.deps;
    const realGet = settings.get;
    settings.get = (ns) => {
      const value = realGet.call(settings, ns);
      return ns === 'lab' ? { ...value, consoles: { ...value.consoles, allowedHosts: ['192.0.2.1'] } } : value;
    };
    try {
      const res = await notify('student1', byName('B4M', 'R5').key);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 'consoles.not_allowed');
    } finally {
      settings.get = realGet;
    }
    // At most 10 lines waited for per user; the same line again is not one more
    assert.equal((await (await get('student1', '/api/consoles/notify')).json()).watches.length, 0, 'the line freed: nothing waited for');
    const lines = [...new Map(devices.filter((d) => d !== busy).map((d) => [`${d.target.host}:${d.target.port}`, d])).values()];
    const others = lines.slice(0, 10);
    for (const d of others) assert.equal((await notify('student1', d.key)).status, 200, d.name);
    assert.equal((await (await get('student1', '/api/consoles/notify')).json()).watches.length, 10);
    const eleventh = await notify('student1', lines[10].key);
    assert.equal(eleventh.status, 429);
    assert.deepEqual(await eleventh.json().then(({ code, params }) => ({ code, params })), { code: 'consoles.too_many_watches', params: { max: 10 } });
    assert.equal((await notify('student1', others[0].key)).status, 200, 'a line already waited for is fine');
    for (const d of others) await fetch(`${app.url}/api/consoles/notify/${encodeURIComponent(`${d.target.host}:${d.target.port}`)}`, { method: 'DELETE', headers: { ...app.as('student1'), origin: app.url } });
    const del = await fetch(`${app.url}/api/consoles/notify/${encodeURIComponent('10.22.9.211:2016')}`, { method: 'DELETE', headers: { ...app.as('student2'), origin: app.url } });
    assert.equal(del.status, 404);
  } finally {
    for (const s of streams) s.ctl.abort();
  }
});

test('consoles: the journal is listed and downloaded by those who were there that day, their team and admins only', async () => {
  const r2 = byName('B4M', 'R2');
  // B4M is held by team-x while the console is open (the teams lot's services, read lazily)
  app.deps.services.benches = { holder: (bench) => (bench === 'B4M' ? { teamId: 'team-x', since: new Date().toISOString() } : null) };
  const alice = await openReady('student1', r2);
  delete app.deps.services.benches;
  alice.type('show ip interface brief\r');
  await alice.see(/show ip interface brief[\s\S]*R2>$/);
  alice.send({ type: 'control', action: 'hangup' });
  await alice.frame((f) => f.type === 'exit', 'closed');
  await alice.close();
  await app.deps.store.flush();
  await new Promise((r) => setTimeout(r, 50));

  const list = async (who) => (await (await get(who, '/api/consoles/journal')).json()).sessions;
  const mine = (await list('student1')).find((d) => d.bench === 'B4M' && d.device === 'R2');
  assert.ok(mine, 'alice sees the session she was on');
  assert.match(mine.id, /^B4M\/R2\/\d{4}-\d{2}-\d{2}\/\d{6}(-\d+)?$/);
  assert.ok(mine.from && mine.to, 'when it started and ended');
  assert.deepEqual(mine.people, ['Student 1']);
  assert.equal((await list('student2')).some((d) => d.device === 'R2' && d.bench === 'B4M'), false, 'bob was not there');
  assert.ok((await list('admin')).some((d) => d.id === mine.id), 'an admin sees everything');

  const download = await get('student1', `/api/consoles/journal/${mine.id}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="journal_B4M_R2_\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.log"$/);
  const body = await download.text();
  assert.match(body, /R2>show ip interface brief/);
  assert.doesNotMatch(body, new RegExp(TELNET.password));
  assert.equal((await get('student2', `/api/consoles/journal/${mine.id}`)).status, 403);
  assert.equal((await (await get('student2', `/api/consoles/journal/${mine.id}`)).json()).code, 'consoles.journal_forbidden');
  assert.equal((await get('admin', `/api/consoles/journal/${mine.id}`)).status, 200);
  assert.equal((await get(null, `/api/consoles/journal/${mine.id}`)).status, 401);
  assert.equal((await get('student1', '/api/consoles/journal/B4M/R2/2001-01-01/100000')).status, 404);
  assert.equal((await get('student1', '/api/consoles/journal/B4M/R2/yesterday/100000')).status, 400);
  assert.equal((await get('student1', `/api/consoles/journal/B4M/R2/${mine.day}/..%2F..%2Fauth`)).status, 400);
  assert.equal((await get('student1', '/api/consoles/journal/..%2F..%2Fauth/R2/2026-11-13/100000')).status, 400);
  assert.equal((await get('student1', `/api/consoles/journal/B4M/R2/${mine.day}`)).status, 404, 'a whole day is not served any more');

  // The team that held the bench reads it too: chloe is in team-x, bob is not
  const meta = JSON.parse(fs.readFileSync(`${app.dataDir}/journal/${mine.id}.json`, 'utf8'));
  assert.deepEqual(meta.teams, ['team-x']);
  app.deps.services.teams = { teamOf: (u) => (u.id === 'oidc:student3' ? { id: 'team-x' } : null) };
  try {
    assert.equal((await get('student3', `/api/consoles/journal/${mine.id}`)).status, 200);
    assert.ok((await list('student3')).some((d) => d.id === mine.id));
    assert.equal((await get('student2', `/api/consoles/journal/${mine.id}`)).status, 403);
  } finally {
    delete app.deps.services.teams;
  }

  // Later the same day bob watches R2 for a moment: read rights cover the whole day of R2 (owner decision), alice's morning included
  const later = await openReady('student1', r2);
  const bob = connect('student2', r2);
  await bob.frame((f) => f.type === 'presence' && f.users.length === 2, 'bob watches');
  await bob.close();
  later.send({ type: 'control', action: 'hangup' });
  await later.frame((f) => f.type === 'exit', 'closed again');
  await later.close();
  await app.deps.store.flush();
  const bobs = (await list('student2')).filter((d) => d.bench === 'B4M' && d.device === 'R2');
  assert.equal(bobs.length, 2, 'both sessions of that day for bob');
  const his = bobs.find((d) => d.id !== mine.id);
  assert.equal(his.day, mine.day, 'the same device, the same day');
  assert.equal((await get('student2', `/api/consoles/journal/${his.id}`)).status, 200);
  assert.equal((await get('student2', `/api/consoles/journal/${mine.id}`)).status, 200, 'the morning too: the whole day of R2');

  const downloads = await app.deps.audit.query({ action: 'console.journal.download' });
  assert.ok(downloads.length >= 4, 'every download is audited');
  assert.ok(downloads.some((d) => d.details.session === mine.id.split('/')[3]));
});
