/**
 * What the home page's "latest backups" relies on from the jobs module:
 *   - the repository lists a team's snapshots newest first, capped, in SQL
 *     (services.jobs.snapshots no longer reads the whole lab);
 *   - the list moving (a backup finished, a ZIP imported, a snapshot deleted)
 *     is told on SSE 'jobs:snapshots' { teamId } to the team's members and the
 *     admins only, and carries nothing else
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { startJobsApp, waitFor } from './helpers/jobs.js';
import { memoryDatabase } from './helpers/db.js';
import { student, admin } from './helpers/fakes.js';
import { newSetId } from '../src/modules/jobs/configFiles.js';

test('snapshots.list filters by team and caps the answer, newest first', async (t) => {
  const { repos, close } = await memoryDatabase();
  t.after(close);
  const at = (n) => Date.parse('2026-11-13T09:00:00Z') + n * 60_000;
  for (const [n, teamId, bench] of [[1, 't1', 'B4M'], [2, 't2', 'B4M'], [3, 't1', 'B4H'], [4, 't1', 'B4M'], [5, null, 'B4M']]) {
    await repos.snapshots.insert({ id: newSetId('backup', at(n)), bench, teamId, label: `s${n}`, origin: 'backup', jobId: null, author: {}, dir: `snapshots/${bench}/s${n}`, createdAt: at(n), bytes: 0 });
  }
  const labels = async (filter) => (await repos.snapshots.list(filter)).map((s) => s.label);
  assert.deepEqual(await labels({}), ['s5', 's4', 's3', 's2', 's1']);
  assert.deepEqual(await labels({ teamId: 't1' }), ['s4', 's3', 's1']);
  assert.deepEqual(await labels({ teamId: 't1', limit: 2 }), ['s4', 's3']);
  assert.deepEqual(await labels({ teamId: 't1', bench: 'B4H' }), ['s3']);
  assert.deepEqual(await labels({ teamId: 'nobody' }), []);
  assert.deepEqual(await labels({ bench: 'B4M', limit: 1 }), ['s5']);
});

let j;
const told = []; // every 'jobs:snapshots' publication: { data, audience }

before(async () => {
  j = await startJobsApp({ countdownMs: 60_000 });
  const { events } = j.app.deps;
  const publish = events.publish.bind(events);
  events.publish = (topic, data, options = {}) => {
    if (topic === 'jobs:snapshots') told.push({ data, audience: options.audience });
    return publish(topic, data, options);
  };
  await j.holdBench('student1', 'B4M', 'Alpha');
});
after(async () => {
  await j?.close();
});

test('a backup, an import and a deletion are told to the team and the admins, as { teamId } and nothing else', { timeout: 30_000 }, async () => {
  const teamId = j.services.teams.teamOf(student(1)).id;
  const r = await j.api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [j.key('R1')], label: 'un' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await j.until(r.body.job.id);
  await waitFor(() => told.length >= 1, 2000, 'a backup finished');
  assert.deepEqual(told.at(-1).data, { teamId });
  const { audience } = told.at(-1);
  assert.equal(audience(student(1)), true, 'a member');
  assert.equal(audience(admin()), true, 'an admin');
  assert.equal(audience(student(2)), false, 'another team');
  assert.equal(audience(student(4)), false, 'someone with no team');
  assert.equal(audience(undefined), false);

  const before = told.length;
  const zip = zipSync({ 'R1.cfg': strToU8('hostname R1\ninterface FastEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n') });
  const imp = await j.api('student1', 'POST', '/api/jobs/snapshots/import?bench=B4M&label=deux', zip);
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(told.length, before + 1, 'the import');
  assert.deepEqual(told.at(-1).data, { teamId });

  assert.equal((await j.api('student1', 'DELETE', `/api/jobs/snapshots/${imp.body.snapshot.id}`)).status, 200);
  assert.equal(told.length, before + 2, 'the deletion');
  assert.deepEqual(told.at(-1).data, { teamId });

  // A refused deletion changes nothing and says nothing
  const [kept] = await j.services.jobs.snapshots(student(1), { teamId });
  assert.equal((await j.api('student2', 'DELETE', `/api/jobs/snapshots/${kept.id}`)).status, 403);
  assert.equal(told.length, before + 2);
});

test('services.jobs.snapshots: a team\'s, capped, for its members and admins; none without a team id', async () => {
  const team = j.services.teams.teamOf(student(1));
  const mine = await j.services.jobs.snapshots(student(1), { teamId: team.id, limit: 1 });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].teamId, team.id);
  assert.deepEqual(await j.services.jobs.snapshots(student(2), { teamId: team.id }), [], 'not a member');
  assert.deepEqual(await j.services.jobs.snapshots(student(1), { teamId: null }), []);
  assert.deepEqual(await j.services.jobs.snapshots(student(1), {}), []);
});
