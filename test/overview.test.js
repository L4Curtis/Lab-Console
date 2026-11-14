/**
 * Lot overview: the screen of every bench and the personal home page
 * (SPEC "Lot overview, lot help")
 *
 * Real application, real bench rules, the mock lab behind the consoles and
 * the jobs. What is checked, for each reader (a member of the holding team,
 * a guest, a member of another team, a student without a team, an admin, and
 * nobody):
 *   - the overview of the benches tells the same to everyone but for `you`,
 *     and never carries what belongs to a team (backups, journals), the last
 *     command typed on a console, an id or a user name;
 *   - the home page lists a team's backups to that team's members only, the
 *     activity of a bench to its occupants only and only since their team
 *     took it, a team invitation to the person invited
 *   - everything it shows follows the services (a lock, a console, a job)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startJobsApp, waitFor } from './helpers/jobs.js';
import { startTestApp } from './helpers/app.js';
import { connectConsole } from './helpers/consoleClient.js';
import { student } from './helpers/fakes.js';
import { createOverviewModule } from '../src/modules/overview/index.js';
import { createAdminModule } from '../src/modules/admin/index.js';

const S = (n) => student(n);
const S5 = S(5);
/** A team of one holding a bench (student1 to 3 and admin are known by name, the others are passed as users) */
async function hold(who, bench, team) {
  const created = await j.api(who, 'POST', '/api/teams', { name: team });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const taken = await j.api(who, 'POST', `/api/benches/${bench}/take`);
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  return taken.body;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let j;
const api = (who, method, path, body) => j.api(who, method, path, body);
const benches = async (who) => (await api(who, 'GET', '/api/overview/benches')).body.benches;
const card = async (who, bench) => (await benches(who)).find((b) => b.bench === bench);
const home = async (who) => (await api(who, 'GET', '/api/overview/home')).body;

before(async () => {
  j = await startJobsApp({ countdownMs: 60_000, extra: (deps) => [createAdminModule(deps), createOverviewModule(deps)] });
});
after(async () => {
  await j?.close();
});

describe('overview: who may ask', () => {
  test('nobody signed in: 401 on both routes', async () => {
    for (const path of ['/api/overview/benches', '/api/overview/home']) {
      const res = await api(null, 'GET', path);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.code, 'auth.required');
    }
  });

  test('read only: nothing writes', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await api('student1', method, '/api/overview/benches', {})).status, 404, method);
      assert.equal((await api('student1', method, '/api/overview/home', {})).status, 404, method);
    }
  });

  test('without the modules it reads from, the overview says so', async () => {
    const alone = await startTestApp({ modules: (deps) => [createOverviewModule(deps)] });
    try {
      const res = await fetch(`${alone.url}/api/overview/benches`, { headers: alone.as('student1') });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'overview.unavailable');
    } finally {
      await alone.close();
    }
  });
});

describe('overview: the benches', () => {
  test('a free lab: every bench of the diagram, in its order, with its console lines', async () => {
    const res = await api('student1', 'GET', '/api/overview/benches');
    assert.equal(res.status, 200);
    const names = res.body.benches.map((b) => b.bench);
    const diagram = j.services.consoles.registry.model.labs.map((l) => l.name);
    assert.deepEqual(names, diagram);
    assert.equal(names.length, 8);
    const b4m = res.body.benches.find((b) => b.bench === 'B4M');
    assert.equal(b4m.state, 'free');
    assert.equal(b4m.holder, null);
    assert.deepEqual(b4m.occupants, []);
    assert.deepEqual(b4m.lines, { total: 10, open: 0, busy: 0, silent: 0, free: 0, checkedAt: null }, 'no line status of the checks: none known');
    assert.deepEqual(b4m.consoles, []);
    assert.equal(b4m.job, null);
    assert.deepEqual(b4m.slots, []);
    assert.deepEqual(b4m.you, { occupant: false, member: false, guest: false });
    assert.match(res.body.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('a team takes a bench: everyone sees the team and its people, names only; only `you` depends on the reader', async () => {
    await hold('student1', 'B4M', 'Alpha');
    await api('student3', 'POST', '/api/benches/B4M/join');
    const ok = await api('student1', 'POST', `/api/benches/B4M/requests/${encodeURIComponent(S(3).id)}/accept`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await hold(S5, 'B4H', 'Bravo');

    const readers = { member: 'student1', guest: 'student3', other: S5, outsider: S(4), admin: 'admin' };
    const seen = {};
    for (const [who, user] of Object.entries(readers)) seen[who] = await card(user, 'B4M');

    for (const [who, c] of Object.entries(seen)) {
      assert.equal(c.state, 'taken', who);
      assert.equal(c.holder.teamName, 'Alpha', who);
      assert.deepEqual(c.occupants, [{ name: 'Student 1', guest: false }, { name: 'Student 3', guest: true }], who);
    }
    assert.equal(seen.member.holder.mine, true);
    assert.equal(seen.guest.holder.mine, false, 'a guest is not in the team');
    assert.equal(seen.other.holder.mine, false);
    assert.equal(seen.admin.holder.mine, false);
    assert.deepEqual(seen.member.you, { occupant: true, member: true, guest: false });
    assert.deepEqual(seen.guest.you, { occupant: true, member: false, guest: true });
    assert.deepEqual(seen.other.you, { occupant: false, member: false, guest: false });
    assert.deepEqual(seen.outsider.you, { occupant: false, member: false, guest: false });

    // The rest is the same for everybody
    const strip = ({ you: _you, holder, slots: _slots, ...rest }) => ({ ...rest, holder: { ...holder, mine: undefined } });
    for (const who of ['guest', 'other', 'outsider', 'admin']) assert.deepEqual(strip(seen[who]), strip(seen.member), who);

    // No identifier, user name or address in the answer
    const text = JSON.stringify((await api(S5, 'GET', '/api/overview/benches')).body);
    assert.doesNotMatch(text, /oidc:|student\d|10\.22\./);
  });

  test('join requests are counted for the occupants and the admins only', async () => {
    await api(S(4), 'POST', '/api/benches/B4M/join');
    assert.equal((await card('student1', 'B4M')).requests, 1, 'the holding team');
    assert.equal((await card('student3', 'B4M')).requests, 1, 'a guest is an occupant');
    assert.equal((await card('admin', 'B4M')).requests, 1);
    assert.equal((await card(S5, 'B4M')).requests, 0, 'another team');
    assert.equal((await card(S(4), 'B4M')).requests, 0, 'the person who asked');
    await api(S(4), 'DELETE', '/api/benches/B4M/join');
    assert.equal((await card('student1', 'B4M')).requests, 0);
  });

  test('a lock: its reason and who set it, for everyone', async () => {
    const lock = await api('admin', 'PUT', '/api/benches/B5B/lock', { reason: 'Préparée pour le TP noté' });
    assert.equal(lock.status, 200, JSON.stringify(lock.body));
    for (const who of ['student1', S5, S(4), 'admin']) {
      const c = await card(who, 'B5B');
      assert.equal(c.state, 'locked');
      assert.equal(c.lock.reason, 'Préparée pour le TP noté');
      assert.equal(c.lock.by, 'Ada Admin');
    }
    await api('admin', 'DELETE', '/api/benches/B5B/lock');
    assert.equal((await card('student1', 'B5B')).state, 'free');
  });

  test('an open console: its state, its pilot and the people on it; never the last command', async () => {
    const r1 = j.device('R1');
    const pilot = connectConsole(j.app, 'student1', r1);
    try {
      await pilot.until((c) => c.frames.some((f) => f.type === 'presence' && f.mayType), 'the keyboard');
      pilot.type('show clock typed-by-the-pilot\r');
      const c = await waitFor(async () => {
        const b = await card(S5, 'B4M');
        return b.consoles.length === 1 ? b : null;
      }, 5000, 'R1 open on the overview');
      assert.equal(c.consoles[0].device, 'R1');
      assert.equal(c.consoles[0].pilot, 'Student 1');
      assert.equal(c.consoles[0].people, 1);
      assert.equal(c.consoles[0].task, false);
      assert.equal(c.lines.open, 1);

      // A spectator on the same line (the line is open: anyone signed in may watch)
      const spectator = connectConsole(j.app, S5, r1, '&mode=wall');
      try {
        await waitFor(async () => (await card('student1', 'B4M')).consoles[0]?.people === 2, 5000, 'two people');
        assert.equal((await card('student1', 'B4M')).consoles[0].pilot, 'Student 1');
      } finally {
        await spectator.close();
      }
      const text = JSON.stringify((await api(S5, 'GET', '/api/overview/benches')).body);
      assert.doesNotMatch(text, /typed-by-the-pilot|lastCommand/);
    } finally {
      await pilot.close();
    }
    // The line stays open 2 s after the last one leaves (test timings), then the bench shows it closed
    await waitFor(async () => (await card(S5, 'B4M')).consoles.length === 0, 8000, 'the line closed');
  });

  test('a line the console server refused is counted as busy outside the application', async () => {
    const b6b = j.services.consoles.registry.model.labs.find((l) => l.name === 'B6B');
    const target = `${b6b.devices[0].target.host}:${b6b.devices[0].target.port}`;
    j.services.consoles.rooms.markBusy(target);
    try {
      assert.deepEqual((await card('student1', 'B6B')).lines, { total: 7, open: 0, busy: 1, silent: 0, free: 0, checkedAt: null });
    } finally {
      j.services.consoles.rooms.markFree(target);
    }
    assert.equal((await card('student1', 'B6B')).lines.busy, 0);
  });

  test('a running job: kind, state, who and how far, for every reader', async () => {
    const started = await api('student1', 'POST', '/api/jobs/benches/B4M/reset', { devices: [j.key('R1')], confirm: 'B4M' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    try {
      for (const who of ['student1', S5, S(4), 'admin']) {
        const c = await card(who, 'B4M');
        assert.deepEqual(c.job, { kind: 'reset', state: 'pending', actor: 'Student 1', startsAt: c.job.startsAt, devices: { total: 1, finished: 0, failed: 0 } }, String(who.id ?? who));
      }
      // What the job works on is not told: no report, no configuration line
      const text = JSON.stringify((await api(S5, 'GET', '/api/overview/benches')).body);
      assert.doesNotMatch(text, /startup-config|running-config|lastOutput/);
    } finally {
      await api('student1', 'POST', `/api/jobs/runs/${started.body.job.id}/cancel`);
      await j.until(started.body.job.id);
    }
    assert.equal((await card(S5, 'B4M')).job, null);
  });

  test('the next slots: the calendar of the bench, `mine` for the booking team only', async () => {
    const quarter = 15 * 60_000;
    const start = Math.ceil(Date.now() / quarter) * quarter + 2 * 3_600_000;
    const booked = await api(S5, 'POST', '/api/benches/reservations', { bench: 'B6H', start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const mine = await card(S5, 'B6H');
    assert.deepEqual(mine.slots, [{ start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString(), teamName: 'Bravo', mine: true }]);
    for (const who of ['student1', S(4), 'admin']) {
      const c = await card(who, 'B6H');
      assert.equal(c.slots.length, 1);
      assert.equal(c.slots[0].teamName, 'Bravo');
      assert.equal(c.slots[0].mine, false);
    }
    // Four slots at most are listed per bench (three), and only those not over
    assert.ok((await card('student1', 'B6B')).slots.length === 0);
  });
});

describe('home: the personal page', () => {
  test('a student without a team: no bench, no backups, no activity, the lab in numbers', async () => {
    const h = await home(S(4));
    assert.equal(h.team, null);
    assert.deepEqual(h.invitations, []);
    assert.equal(h.bench, null);
    assert.deepEqual(h.backups, []);
    assert.deepEqual(h.activity, []);
    assert.deepEqual(h.slots, []);
    assert.equal(h.announcement, null);
    assert.deepEqual(Object.keys(h.lab).sort(), ['benches', 'consoles', 'free', 'jobs', 'locked', 'taken']);
    assert.equal(h.lab.benches, 8);
    assert.equal(h.lab.taken, 2);
    assert.equal(h.lab.free, 6);
  });

  test('an invitation reaches the person it names, and nobody else', async () => {
    const team = (await api('student1', 'GET', '/api/teams')).body.mine;
    const sent = await api('student1', 'POST', `/api/teams/${team.id}/invitations`, { username: 'student4' });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual((await home(S(4))).invitations.map((i) => ({ team: i.team, by: i.by })), [{ team: 'Alpha', by: 'Student 1' }]);
    for (const who of ['student1', 'student3', S5, 'admin']) assert.deepEqual((await home(who)).invitations, [], String(who));
    await api(S(4), 'DELETE', `/api/teams/${team.id}/invitations/student4`);
    assert.deepEqual((await home(S(4))).invitations, []);
  });

  test('a member sees the team, the bench, its slots; a guest sees the bench but not the team', async () => {
    const member = await home('student1');
    assert.equal(member.team.name, 'Alpha');
    assert.deepEqual(member.team.members, [{ name: 'Student 1', you: true }]);
    assert.equal(member.bench.bench, 'B4M');
    assert.equal(member.bench.holder.mine, true);

    const guest = await home('student3');
    assert.equal(guest.team, null, 'a guest has no team');
    assert.equal(guest.bench.bench, 'B4M', 'but works on the bench');
    assert.equal(guest.bench.you.guest, true);
    assert.deepEqual(guest.backups, []);
    assert.deepEqual(guest.slots, []);

    const other = await home(S5);
    assert.equal(other.team.name, 'Bravo');
    assert.equal(other.bench.bench, 'B4H');
    assert.equal(other.slots.length, 1);
    assert.equal(other.slots[0].bench, 'B6H');
    assert.deepEqual((await home('student1')).slots, [], 'the slots of another team are not ours');

    const adm = await home('admin');
    assert.equal(adm.team, null);
    assert.equal(adm.bench, null);
    assert.deepEqual(adm.activity, []);
  });

  test('the activity of the bench: for its occupants only, newest first', async () => {
    const mine = await home('student1');
    const actions = mine.activity.map((e) => e.action);
    assert.ok(actions.includes('bench.take'));
    assert.ok(actions.includes('bench.join.accept'));
    assert.ok(actions.some((a) => a.startsWith('job.reset')), 'the reset that was started');
    assert.ok(actions.includes('console.open'), 'a console opened');
    const times = mine.activity.map((e) => e.ts);
    assert.deepEqual(times, [...times].sort().reverse());
    const take = mine.activity.find((e) => e.action === 'bench.take');
    assert.deepEqual(take.actor, { name: 'Student 1' });
    assert.equal(take.details.team, 'Alpha');
    const open = mine.activity.find((e) => e.action === 'console.open');
    assert.equal(open.details.device, 'R1');

    // A guest is an occupant; another team's page tells its own story, not this one
    assert.deepEqual((await home('student3')).activity.map((e) => e.ts), times);
    const others = (await home(S5)).activity;
    assert.ok(others.length > 0);
    assert.ok(others.every((e) => e.details.team !== 'Alpha' && e.details.device !== 'R1'), 'nothing of the other bench');
    const text = JSON.stringify(mine.activity);
    assert.doesNotMatch(text, /oidc:|student\d|10\.22\.|"ip"/);
  });

  test('the latest backups of MY team: its members only, not a guest, another team, an admin or a stranger', async () => {
    const r = await api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [j.key('R1')], label: 'Avant le TP' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await j.until(r.body.job.id);
    assert.equal(done.state, 'done', JSON.stringify(done.devices));

    const mine = (await home('student1')).backups;
    assert.equal(mine.length, 1);
    assert.deepEqual(Object.keys(mine[0]).sort(), ['author', 'bench', 'createdAt', 'devices', 'id', 'label', 'origin']);
    assert.equal(mine[0].bench, 'B4M');
    assert.equal(mine[0].label, 'Avant le TP');
    assert.equal(mine[0].devices, 1);
    assert.equal(mine[0].author, 'Student 1');

    for (const who of ['student3', S5, S(4), 'admin']) {
      const h = await home(who);
      assert.deepEqual(h.backups, [], String(who.id ?? who));
      assert.ok(!JSON.stringify(h).includes(mine[0].id), 'the snapshot is not in their page at all');
    }
    // The overview of the benches never lists them either
    assert.ok(!JSON.stringify(await benches(S5)).includes(mine[0].id));
    assert.ok(!JSON.stringify(await benches('student1')).includes(mine[0].id));

    // The jobs API says the same thing the home page does
    assert.equal((await api('student3', 'GET', `/api/jobs/snapshots/${mine[0].id}`)).status, 403);
  });

  test('the list is capped at five and newest first', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [j.key('S1')], label: `Sauvegarde ${i}` });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await j.until(r.body.job.id);
    }
    const list = (await home('student1')).backups;
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((b) => b.createdAt), [...list.map((b) => b.createdAt)].sort().reverse());
    assert.equal(list[0].label, 'Sauvegarde 4');
  });

  test('a bench changes hands: the new team reads nothing of the old one\'s work', async () => {
    // Bravo keeps a backup of B4H, then lets the bench go
    const device = j.services.consoles.registry.model.labs.find((l) => l.name === 'B4H').devices[0].name;
    const backup = await api(S5, 'POST', '/api/jobs/benches/B4H/backup', { devices: [j.key(device, 'B4H')], label: 'Bravo avant départ' });
    assert.equal(backup.status, 202, JSON.stringify(backup.body));
    assert.equal((await j.until(backup.body.job.id)).state, 'done');
    const snapshot = (await home(S5)).backups[0].id;
    const released = await api(S5, 'POST', '/api/benches/B4H/release');
    assert.equal(released.status, 200, JSON.stringify(released.body));
    await sleep(20);
    const taken = await hold('student2', 'B4H', 'Charlie');
    assert.equal(taken.holder.teamName, 'Charlie');
    const h = await home('student2');
    assert.equal(h.bench.bench, 'B4H');
    const actions = h.activity.map((e) => [e.action, e.details.team]);
    assert.deepEqual(actions, [['bench.take', 'Charlie']], 'only what happened since Charlie took it');

    // Bravo goes on using its own backup of B4H: the downloads and the deletion are logged on the bench, and are not Charlie's to read
    const zip = await j.api(S5, 'GET', `/api/jobs/snapshots/${snapshot}/zip`, undefined, { raw: true });
    assert.equal(zip.status, 200);
    const folder = await j.api(S5, 'GET', `/api/jobs/benches/B4H/folder?snapshot=${snapshot}`, undefined, { raw: true });
    assert.equal(folder.status, 200);
    assert.equal((await j.api('student2', 'GET', `/api/jobs/snapshots/${snapshot}/zip`)).status, 403, 'Charlie cannot read it');
    const logged = (await api('admin', 'GET', '/api/admin/audit?bench=B4H&action=job')).body;
    assert.ok(JSON.stringify(logged).includes('job.snapshot.download') && JSON.stringify(logged).includes('job.folder.download'), 'the audit trail does know');
    assert.equal((await api(S5, 'DELETE', `/api/jobs/snapshots/${snapshot}`)).status, 200);
    const after = (await home('student2')).activity;
    assert.deepEqual(after.map((e) => [e.action, e.details.team]), [['bench.take', 'Charlie']], 'Bravo\'s backup and folder are not in Charlie\'s activity');
    assert.doesNotMatch(JSON.stringify(after), /snapshot|folder/);
    // …and Bravo, which gave the bench back, no longer has a bench page
    const bravo = await home(S5);
    assert.equal(bravo.bench, null);
    assert.deepEqual(bravo.activity, []);
  });

  test('the announcement: shown to everyone, as text, until it is removed', async () => {
    const put = await api('admin', 'PUT', '/api/admin/announcement', { text: 'La baie B6H est hors service ce matin <b>merci</b>', level: 'warning', hours: 2 });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    for (const who of ['student1', S5, S(4), 'admin']) {
      const a = (await home(who)).announcement;
      assert.equal(a.text, 'La baie B6H est hors service ce matin <b>merci</b>');
      assert.equal(a.level, 'warning');
      assert.equal(a.by, 'Ada Admin');
      assert.ok(a.expiresAt);
    }
    await api('admin', 'DELETE', '/api/admin/announcement');
    assert.equal((await home('student1')).announcement, null);
  });

  test('a lab in numbers: benches taken, locked, consoles open, jobs running', async () => {
    await api('admin', 'PUT', '/api/benches/B5H/lock', { reason: 'Maintenance' });
    const lab = (await home(S(4))).lab;
    assert.equal(lab.locked, 1);
    assert.equal(lab.benches, lab.free + lab.taken + lab.locked);
    // Lines a job opened stay a moment after it ended: the strip counts what the cards list
    const cards = await benches(S(4));
    assert.equal(lab.consoles, cards.reduce((n, c) => n + c.consoles.length, 0));
    assert.equal(lab.jobs, cards.filter((c) => c.job).length);
    await api('admin', 'DELETE', '/api/benches/B5H/lock');
  });
});
