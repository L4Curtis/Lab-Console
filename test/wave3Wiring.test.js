/**
 * Wave 3 together: what only the jobs and collab lots side by side give.
 *
 *   - the end of a job is told once ('jobs:done' { bench, jobId, kind, ok, state }),
 *     to the occupants of the bench at that moment only: the browser turns it
 *     into a notification (test/e2e/wave3.e2e.js);
 *   - a device's note is not configuration: a reset of the device leaves it
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startJobsApp, waitFor } from './helpers/jobs.js';
import { createCollabModule } from '../src/modules/collab/index.js';
import { student, admin } from './helpers/fakes.js';

let j;
const done = []; // every 'jobs:done' publication: { data, audience }

before(async () => {
  j = await startJobsApp({ extra: (deps) => createCollabModule(deps) });
  const { events } = j.app.deps;
  const publish = events.publish.bind(events);
  events.publish = (topic, data, options = {}) => {
    if (topic === 'jobs:done') done.push({ data, audience: options.audience });
    return publish(topic, data, options);
  };
  await j.holdBench('student1');
});

after(async () => {
  await j?.close();
});

const B = '/api/jobs/benches/B4M';
const noteUrl = (key) => `/api/collab/notes/${encodeURIComponent(key)}`;

test('a finished backup is told once to the bench\'s occupants: { bench, jobId, kind, ok, state }', { timeout: 30_000 }, async () => {
  const r = await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('R1')] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await j.until(r.body.job.id);
  assert.equal(job.state, 'done');
  await waitFor(() => done.some((d) => d.data.jobId === job.id), 2000, 'jobs:done');
  const mine = done.filter((d) => d.data.jobId === job.id);
  assert.equal(mine.length, 1, 'once per job');
  assert.deepEqual(mine[0].data, { bench: 'B4M', jobId: job.id, kind: 'backup', ok: true, state: 'done' });
  assert.equal(mine[0].audience(student(1)), true, 'the team holding the bench');
  assert.equal(mine[0].audience(student(2)), false, 'nobody outside the bench');
  assert.equal(mine[0].audience(admin()), false, 'an admin who is not on the bench follows the jobs section, not a notification');
  assert.equal(mine[0].audience(undefined), false);
});

test('a cancelled reset is told too, as not ok; a job on a bench nobody holds is told to nobody', { timeout: 30_000 }, async () => {
  const r = await j.api('student1', 'POST', `${B}/reset`, { devices: [j.key('R1')], confirm: 'B4M' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal((await j.api('student1', 'POST', `/api/jobs/runs/${r.body.job.id}/cancel`)).status, 200);
  await j.until(r.body.job.id);
  await waitFor(() => done.some((d) => d.data.jobId === r.body.job.id), 2000, 'jobs:done');
  const cancelled = done.find((d) => d.data.jobId === r.body.job.id);
  assert.equal(cancelled.data.ok, false);
  assert.equal(cancelled.data.state, 'cancelled');
  assert.equal(cancelled.data.kind, 'reset');

  // An admin's backup of a free bench: no occupant, nothing to tell
  await j.release('student1');
  const free = await j.api('admin', 'POST', `${B}/backup`, { devices: [j.key('R1')] });
  assert.equal(free.status, 202, JSON.stringify(free.body));
  await j.until(free.body.job.id);
  assert.equal(done.some((d) => d.data.jobId === free.body.job.id), false);
  await j.holdBench('student1');
});

test('a device\'s note survives the reset of the device', { timeout: 60_000 }, async () => {
  const key = j.key('R1');
  const put = await j.api('student1', 'PUT', noteUrl(key), { text: 'Console câblée sur le port 2013', rev: 0 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const r = await j.api('student1', 'POST', `${B}/reset`, { devices: [key], confirm: 'B4M' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await j.until(r.body.job.id, 50_000);
  assert.equal(job.state, 'done', JSON.stringify(job.devices));
  const notes = (await j.api('student2', 'GET', '/api/collab/notes')).body.notes;
  const note = notes.find((n) => n.key === key);
  assert.equal(note?.text, 'Console câblée sur le port 2013');
  assert.equal(note.rev, put.body.note.rev);
});
