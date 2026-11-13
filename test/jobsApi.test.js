/**
 * Bench jobs through the API, on the mock lab: who may run them, the
 * refusals, snapshots (read, ZIP, import, diff, search) and who sees them,
 * templates, the TP folder, and the backup offered when a bench is released
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { startJobsApp, reportOf, waitFor } from './helpers/jobs.js';

let j;
let snapshotId; // student1's backup of R1 and S1

before(async () => {
  j = await startJobsApp();
  await j.holdBench('student1');
});

after(async () => {
  await j?.close();
});

const B = '/api/jobs/benches/B4M';

test('a backup by an occupant: R1 and S1 into a snapshot of the team, with the VLANs of the switch, audited', { timeout: 30_000 }, async () => {
  j.dev('S1').configure(['vlan 30', ' name LABO', 'exit', 'interface FastEthernet0/5', ' switchport access vlan 30']);
  const r = await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('R1'), j.key('S1')], label: 'TP2 fin' });
  assert.equal(r.status, 202);
  assert.equal(r.body.job.kind, 'backup');
  const job = await j.until(r.body.job.id);
  assert.equal(job.state, 'done', JSON.stringify(job.devices));
  assert.ok(job.snapshotId);
  snapshotId = job.snapshotId;
  assert.equal(reportOf(job, 'S1').result.vlans >= 5, true);

  const list = await j.api('student1', 'GET', '/api/jobs/snapshots?bench=B4M');
  const snap = list.body.snapshots.find((s) => s.id === snapshotId);
  assert.equal(snap.label, 'TP2 fin');
  assert.equal(snap.teamName, 'team-student1');
  assert.deepEqual(snap.devices.map((d) => d.device).sort(), ['R1', 'S1']);
  assert.equal(snap.devices.find((d) => d.device === 'S1').vlans, true);

  const s1 = await j.api('student1', 'GET', `/api/jobs/snapshots/${snapshotId}/devices/S1`);
  assert.match(s1.body.config, /^hostname S1$/m);
  assert.equal(s1.body.intact, true);
  assert.ok(s1.body.vlans.some((v) => v.id === 30 && v.name === 'LABO'));

  const audit = await j.app.deps.audit.query({ bench: 'B4M', action: 'job' });
  assert.ok(audit.some((e) => e.action === 'job.backup' && e.actor.username === 'student1'));
  assert.ok(audit.some((e) => e.action === 'job.backup.end' && e.details.state === 'done'));
  // The bench history reads them
  const history = await j.api('student1', 'GET', '/api/benches/B4M/history');
  assert.ok(history.body.history.some((e) => e.action === 'job.backup'));
});

test('the snapshot is a ZIP right away: manifest and one .cfg per device; it imports back as a new snapshot', { timeout: 20_000 }, async () => {
  const z = await j.api('student1', 'GET', `/api/jobs/snapshots/${snapshotId}/zip`, undefined, { raw: true });
  assert.equal(z.status, 200);
  assert.equal(z.headers.get('content-type'), 'application/zip');
  assert.match(z.headers.get('content-disposition'), /attachment; filename="B4M-.*\.zip"/);
  const files = unzipSync(new Uint8Array(z.buffer));
  const names = Object.keys(files).map((n) => n.split('/').at(-1)).sort();
  assert.deepEqual(names, ['R1.cfg', 'S1.cfg', 'S1.vlan.txt', 'manifest.json']);
  const manifest = JSON.parse(strFromU8(files[Object.keys(files).find((n) => n.endsWith('manifest.json'))]));
  assert.equal(manifest.bench, 'B4M');

  const imp = await j.api('student1', 'POST', '/api/jobs/snapshots/import?bench=B4M&label=depuis%20chez%20moi', z.buffer);
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.snapshot.origin, 'import');
  assert.deepEqual(imp.body.snapshot.devices.map((d) => d.device).sort(), ['R1', 'S1']);
  const diff = await j.api('student1', 'GET', `/api/jobs/snapshots/${snapshotId}/diff/${imp.body.snapshot.id}`);
  assert.deepEqual(diff.body.devices.map((d) => d.status), ['same', 'same']);
  const vlans = await j.api('student1', 'GET', `/api/jobs/snapshots/${imp.body.snapshot.id}/devices/S1`);
  assert.ok(vlans.body.vlans.some((v) => v.id === 30), 'the VLANs come back with the manifest');
});

test('diff of two snapshots shows what changed, device by device; search finds a line across snapshots', { timeout: 30_000 }, async () => {
  j.dev('R1').configure(['interface FastEthernet0/0', ' description vers-S1', ' ip address 192.168.10.1 255.255.255.0']);
  const r = await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('R1')] });
  const job = await j.until(r.body.job.id);
  const diff = await j.api('student1', 'GET', `/api/jobs/snapshots/${snapshotId}/diff/${job.snapshotId}`);
  const r1 = diff.body.devices.find((d) => d.device === 'R1');
  assert.equal(r1.status, 'changed');
  assert.match(r1.patch, /^\+ ip address 192\.168\.10\.1 255\.255\.255\.0$/m);
  assert.equal(diff.body.devices.find((d) => d.device === 'S1').status, 'only-a');

  const only = await j.api('student1', 'GET', `/api/jobs/snapshots/${snapshotId}/diff/${job.snapshotId}?device=R1`);
  assert.deepEqual(only.body.devices.map((d) => d.device), ['R1']);

  const found = await j.api('student1', 'GET', '/api/jobs/snapshots/search?q=VERS-s1');
  assert.ok(found.body.hits.some((h) => h.snapshot === job.snapshotId && h.device === 'R1' && /description vers-S1/.test(h.text)));
  assert.equal((await j.api('student1', 'GET', '/api/jobs/snapshots/search?q=a')).status, 400);
  // Another team finds nothing of it
  await j.api('student2', 'POST', '/api/teams', { name: 'team-student2' });
  const other = await j.api('student2', 'GET', '/api/jobs/snapshots/search?q=VERS-s1');
  assert.deepEqual(other.body.hits, []);
});

test('snapshots belong to the team: another team gets 403, a stranger to teams 403, admins read them; nobody signed out', async () => {
  for (const path of [`/api/jobs/snapshots/${snapshotId}`, `/api/jobs/snapshots/${snapshotId}/devices/R1`, `/api/jobs/snapshots/${snapshotId}/zip`]) {
    assert.equal((await j.api('student2', 'GET', path, undefined, { raw: true })).status, 403, path);
    assert.equal((await j.api('student3', 'GET', path, undefined, { raw: true })).status, 403, path);
    assert.equal((await j.api('admin', 'GET', path, undefined, { raw: true })).status, 200, path);
    assert.equal((await j.api(null, 'GET', path, undefined, { raw: true })).status, 401, path);
  }
  assert.equal((await j.api('student2', 'GET', `/api/jobs/snapshots/${snapshotId}/diff/${snapshotId}`)).status, 403);
  assert.equal((await j.api('student2', 'DELETE', `/api/jobs/snapshots/${snapshotId}`)).status, 403);
  const theirs = await j.api('student2', 'GET', '/api/jobs/snapshots');
  assert.equal(theirs.body.snapshots.some((s) => s.id === snapshotId), false);
  assert.equal((await j.api('student1', 'GET', '/api/jobs/snapshots/20990101-000000-backup-abcdef')).status, 404);
  assert.equal((await j.api('student1', 'GET', '/api/jobs/snapshots/..%2F..%2Fetc')).status, 404);
  // Jobs too: their report is the team's
  const runs = await j.api('student2', 'GET', '/api/jobs/runs?bench=B4M');
  assert.deepEqual(runs.body.jobs, []);
  const mine = await j.api('student1', 'GET', '/api/jobs/runs?bench=B4M');
  assert.ok(mine.body.jobs.length >= 2);
  assert.equal((await j.api('student2', 'GET', `/api/jobs/runs/${mine.body.jobs[0].id}`)).status, 403);
});

test('refusals: not an occupant, a locked bench, another job running, bad devices, no confirmation, forcing an erase as a student', { timeout: 30_000 }, async () => {
  const notOccupant = await j.api('student2', 'POST', `${B}/backup`, {});
  assert.equal(notOccupant.status, 403);
  assert.equal(notOccupant.body.code, 'jobs.not_occupant');
  assert.equal((await j.api('student2', 'POST', `${B}/reset`, { confirm: 'B4M', devices: [j.key('R1')] })).body.code, 'jobs.not_occupant');
  assert.equal((await j.api(null, 'POST', `${B}/backup`, {})).status, 401);
  assert.equal((await j.api('student1', 'POST', '/api/jobs/benches/NOPE/backup', {})).status, 404);

  assert.equal((await j.api('student1', 'POST', `${B}/backup`, { devices: ['nope'] })).body.code, 'jobs.unknown_device');
  assert.equal((await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('R1', 'B4B')] })).body.code, 'jobs.unknown_device', 'a device of another bench');
  assert.equal((await j.api('student1', 'POST', `${B}/backup`, { devices: [] })).body.code, 'jobs.no_devices');
  assert.equal((await j.api('student1', 'POST', `${B}/backup`, { enablePasswords: ['a', 'b', 'c', 'd'] })).body.code, 'jobs.bad_passwords');
  assert.equal((await j.api('student1', 'POST', `${B}/reset`, { devices: [j.key('R1')], confirm: 'b4m' })).body.code, 'jobs.confirm_bench');
  const force = await j.api('student1', 'POST', `${B}/reset`, { devices: [j.key('R1')], confirm: 'B4M', forceErase: [j.key('R1')] });
  assert.equal(force.status, 403);
  assert.equal(force.body.code, 'jobs.force_admin_only');

  // Another job running: one job per bench
  const first = await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('R1')] });
  assert.equal(first.status, 202);
  const second = await j.api('student1', 'POST', `${B}/reset`, { devices: [j.key('S1')], confirm: 'B4M' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'jobs.bench_busy');
  assert.equal((await j.api('admin', 'POST', `${B}/backup`, { devices: [j.key('S1')] })).body.code, 'jobs.bench_busy', 'admins too');
  await j.until(first.body.job.id);

  // A locked bench: its occupants run nothing, admins still do
  assert.equal((await j.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'TP noté' })).status, 200);
  const locked = await j.api('student1', 'POST', `${B}/backup`, {});
  assert.equal(locked.status, 423);
  assert.equal(locked.body.code, 'jobs.locked');
  assert.equal(locked.body.params.reason, 'TP noté');
  const byAdmin = await j.api('admin', 'POST', `${B}/backup`, { devices: [j.key('R1')] });
  assert.equal(byAdmin.status, 202);
  const done = await j.until(byAdmin.body.job.id);
  assert.equal(done.state, 'done');
  assert.equal(done.teamId, j.services.benches.holder('B4M').teamId, 'the snapshot still belongs to the team holding the bench');
  assert.equal((await j.api('admin', 'DELETE', '/api/benches/B4M/lock')).status, 200);
});

test('the bench as a job sees it: shared devices marked (not chosen by default), never an admin switch, who is on each console', async () => {
  const r = await j.api('student1', 'GET', B);
  assert.equal(r.status, 200);
  assert.equal(r.body.canOperate, true);
  const s5 = r.body.devices.find((d) => d.name === 'S5');
  assert.equal(s5.shared, true, 'S5 is on the console line B4H and B5B use too');
  assert.equal(r.body.devices.find((d) => d.name === 'R1').shared, false);
  const adminTargets = j.app.deps.infra.adminSwitches.map((s) => s.key);
  assert.equal(r.body.devices.some((d) => adminTargets.includes(d.key)), false);
  assert.equal((await j.api('student2', 'GET', B)).body.canOperate, false);
});

test('preview shows each device\'s exact script; an injection whose scripts differ from the preview is refused', { timeout: 30_000 }, async () => {
  const p = await j.api('student1', 'POST', `${B}/preview`, { source: { snapshot: snapshotId }, devices: [j.key('R1'), j.key('S1'), j.key('R2')] });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.missing.map((m) => m.name), ['R2'], 'R2 is not in this snapshot');
  const s1 = p.body.devices.find((d) => d.name === 'S1');
  assert.match(s1.script, /^configure terminal\n/);
  assert.match(s1.script, /^vlan 30\n name LABO$/m);
  assert.match(s1.script, /\nend\n$/);
  assert.equal(s1.sha256.length, 64);
  assert.equal((await j.api('student2', 'POST', `${B}/preview`, { source: { snapshot: snapshotId } })).status, 403, 'another team\'s snapshot');
  assert.equal((await j.api('student1', 'POST', `${B}/preview`, { source: {} })).body.code, 'jobs.no_source');
  assert.equal((await j.api('student1', 'POST', `${B}/preview`, { source: { snapshot: snapshotId }, rsaModulus: 999 })).body.code, 'jobs.bad_rsa');

  const devices = [j.key('R1'), j.key('S1')];
  const scripts = Object.fromEntries(p.body.devices.filter((d) => devices.includes(d.key)).map((d) => [d.key, d.sha256]));
  const missing = await j.api('student1', 'POST', `${B}/inject`, { source: { snapshot: snapshotId }, devices: [j.key('R2')], scripts, mode: 'merge' });
  assert.equal(missing.body.code, 'jobs.not_in_source');
  const stale = await j.api('student1', 'POST', `${B}/inject`, { source: { snapshot: snapshotId }, devices, scripts: { ...scripts, [j.key('R1')]: '0'.repeat(64) }, mode: 'merge' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'jobs.preview_stale');
  const unconfirmed = await j.api('student1', 'POST', `${B}/inject`, { source: { snapshot: snapshotId }, devices, scripts });
  assert.equal(unconfirmed.body.code, 'jobs.confirm_bench', 'reset then inject is the default: the bench name is typed');

  // Merge: no erase, the lines are added to what runs
  j.dev('R1').configure(['hostname R1']);
  const merge = await j.api('student1', 'POST', `${B}/inject`, { source: { snapshot: snapshotId }, devices: [j.key('R1')], scripts: { [j.key('R1')]: scripts[j.key('R1')] }, mode: 'merge', save: false });
  assert.equal(merge.status, 202, JSON.stringify(merge.body));
  const done = await j.until(merge.body.job.id);
  const r1 = reportOf(done, 'R1');
  assert.equal(r1.state, 'done', JSON.stringify(r1));
  assert.equal(r1.result.sha256, scripts[j.key('R1')], 'what was sent is what the preview showed');
  assert.equal(r1.result.reset, null, 'nothing erased in merge mode');
  assert.equal(r1.result.saved, null);
  assert.ok(done.snapshotId, 'a backup was taken first');
});

test('templates: admins publish (typed or from a snapshot), set the base configuration; everyone reads; students cannot write', { timeout: 30_000 }, async () => {
  const typed = await j.api('admin', 'POST', '/api/jobs/templates', {
    name: 'Base du labo', description: 'Après chaque reset',
    configs: { '*': 'no ip domain-lookup\nline con 0\n logging synchronous\n exec-timeout 0 0\n' },
  });
  assert.equal(typed.status, 201, JSON.stringify(typed.body));
  assert.equal((await j.api('admin', 'PUT', `/api/jobs/templates/${typed.body.template.id}`, { base: true })).body.template.base, true);
  assert.equal((await j.api('admin', 'POST', '/api/jobs/templates', { name: 'base du LABO', configs: { R1: 'hostname R1\n' } })).body.code, 'jobs.template_exists');
  assert.equal((await j.api('admin', 'POST', '/api/jobs/templates', { name: 'x', configs: { '../R1': 'hostname R1\n' } })).body.code, 'jobs.bad_device_name');

  const fromSnap = await j.api('admin', 'POST', '/api/jobs/templates', { name: 'TP2 corrigé', snapshot: snapshotId, devices: ['S1'] });
  assert.equal(fromSnap.status, 201);
  assert.deepEqual(fromSnap.body.template.devices.map((d) => d.device), ['S1']);

  assert.equal((await j.api('student1', 'POST', '/api/jobs/templates', { name: 'mine', configs: { R1: 'hostname R1\n' } })).status, 403);
  assert.equal((await j.api('student1', 'PUT', `/api/jobs/templates/${typed.body.template.id}`, { base: false })).status, 403);
  assert.equal((await j.api('student1', 'DELETE', `/api/jobs/templates/${typed.body.template.id}`)).status, 403);
  const list = await j.api('student2', 'GET', '/api/jobs/templates');
  assert.deepEqual(list.body.templates.map((t) => t.name).sort(), ['Base du labo', 'TP2 corrigé']);
  const s1 = await j.api('student2', 'GET', `/api/jobs/templates/${fromSnap.body.template.id}/devices/S1`);
  assert.match(s1.body.config, /^hostname S1$/m);
  assert.equal((await j.api('student1', 'GET', B)).body.base.name, 'Base du labo');

  // A template previews for any bench device, '*' standing for every device
  const p = await j.api('student1', 'POST', `${B}/preview`, { source: { template: typed.body.template.id }, devices: [j.key('R2')] });
  assert.equal(p.body.devices[0].from, 'Base du labo (*)');
  assert.match(p.body.devices[0].script, /^ logging synchronous$/m);

  // Import from a ZIP
  const zip = zipSync({ 'R1.cfg': strToU8('hostname R1\ninterface FastEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n'), '_any.cfg': strToU8('service password-encryption\n') });
  const imp = await j.api('admin', 'POST', '/api/jobs/templates/import?name=TP3', zip);
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.template.devices.map((d) => d.device).sort(), ['*', 'R1']);
  assert.equal((await j.api('admin', 'DELETE', `/api/jobs/templates/${imp.body.template.id}`)).status, 200);
  assert.equal((await j.api('admin', 'GET', `/api/jobs/templates/${imp.body.template.id}`)).status, 404);
});

test('ZIP import attacks: a path that leaves the folder, a zip bomb, lying sizes, too large, not a ZIP, a binary file, no team', { timeout: 20_000 }, async () => {
  const imp = (who, body, query = 'bench=B4M') => j.api(who, 'POST', `/api/jobs/snapshots/import?${query}`, body);

  const traversal = zipSync({ '../../evil.cfg': strToU8('hostname R1\n'), 'R1.cfg': strToU8('hostname R1\n') });
  const t = await imp('student1', traversal);
  assert.equal(t.status, 400);
  assert.equal(t.body.code, 'jobs.zip_unsafe');
  for (const name of ['/etc/R1.cfg', 'C:/R1.cfg', 'a\\..\\R1.cfg']) {
    assert.equal((await imp('student1', zipSync({ [name]: strToU8('hostname R1\n') }))).body.code, 'jobs.zip_unsafe', name);
  }

  const bomb = zipSync({ 'R1.cfg': new Uint8Array(60 * 1024 * 1024) }, { level: 9 });
  assert.ok(bomb.length < 200 * 1024, 'small on the wire');
  const b = await imp('student1', bomb);
  assert.equal(b.status, 413);
  assert.equal(b.body.code, 'jobs.zip_too_large');

  // The same bomb, its sizes rewritten to look small: never inflated past the declared size
  const lying = Buffer.from(bomb);
  for (let i = 0; i < lying.length - 4; i++) {
    if (lying.readUInt32LE(i) === 0x04034b50) lying.writeUInt32LE(100, i + 22);
    if (lying.readUInt32LE(i) === 0x02014b50) lying.writeUInt32LE(100, i + 24);
  }
  const l = await imp('student1', lying);
  assert.equal(l.status, 400);
  assert.equal(l.body.code, 'jobs.zip_empty', 'what came out is not a configuration');

  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}.cfg`, strToU8('hostname R1\n')]));
  assert.equal((await imp('student1', zipSync(many))).body.code, 'jobs.zip_too_large');

  const huge = await imp('student1', Buffer.alloc(3 * 1024 * 1024, 7));
  assert.equal(huge.status, 413);
  assert.equal(huge.body.code, 'server.too_large');

  assert.equal((await imp('student1', Buffer.from('not a zip at all, sorry'))).body.code, 'jobs.zip_invalid');
  const binary = await imp('student1', zipSync({ 'R1.cfg': new Uint8Array([0, 1, 2, 3, 104, 111, 115, 116]) }));
  assert.equal(binary.body.code, 'jobs.zip_empty');
  const strangers = await imp('student1', zipSync({ 'ZZ9.cfg': strToU8('hostname ZZ9\n') }));
  assert.equal(strangers.body.code, 'jobs.zip_empty', 'no device of this bench in it');
  assert.equal((await imp('student3', zipSync({ 'R1.cfg': strToU8('hostname R1\n') }))).body.code, 'jobs.no_team');
  assert.equal((await imp('student1', zipSync({ 'R1.cfg': strToU8('hostname R1\n') }), 'bench=NOPE')).status, 404);
  // Unknown files are ignored, never written
  const mixed = await imp('student1', zipSync({ 'R1.cfg': strToU8('hostname R1\n'), 'run.sh': strToU8('rm -rf /'), 'notes/R2.cfg': strToU8('hostname R2\n') }));
  assert.equal(mixed.status, 201);
  assert.deepEqual(mixed.body.snapshot.devices.map((d) => d.device), ['R1']);
  assert.ok(mixed.body.ignored.includes('run.sh'));
});

test('TP folder: the configurations of a snapshot and the console journals of its day that the user may read', { timeout: 20_000 }, async () => {
  await waitFor(async () => (await j.services.consoles.journal.list()).some((d) => d.bench === 'B4M'), 5000, 'a journal of B4M');
  const z = await j.api('student1', 'GET', `${B}/folder?snapshot=${snapshotId}`, undefined, { raw: true });
  assert.equal(z.status, 200);
  const names = Object.keys(unzipSync(new Uint8Array(z.buffer)));
  assert.ok(names.some((n) => /\/configurations\/R1\.cfg$/.test(n)));
  assert.ok(names.some((n) => /\/journals\/R1\/.+\.log$/.test(n)), names.join(', '));
  assert.ok(names.some((n) => /README\.txt$/.test(n)));
  assert.equal((await j.api('student2', 'GET', `${B}/folder?snapshot=${snapshotId}`)).status, 403);
  assert.equal((await j.api('student1', 'GET', `/api/jobs/benches/B4B/folder?snapshot=${snapshotId}`)).body.code, 'jobs.other_bench');
});

test('releasing a bench offers its team a backup; a member takes it on the free bench; the offer ends when another team takes it', { timeout: 30_000 }, async () => {
  const released = await j.release('student1');
  assert.equal(released.status, 200);
  assert.deepEqual(released.body.offers, [{ kind: 'backup', bench: 'B4M', href: '#/jobs/B4M/backup' }]);
  const detail = await j.api('student1', 'GET', B);
  assert.equal(detail.body.canOperate, false);
  assert.ok(detail.body.offer);
  assert.equal((await j.api('student1', 'POST', `${B}/reset`, { confirm: 'B4M', devices: [j.key('R1')] })).body.code, 'jobs.not_occupant', 'the offer is a backup, nothing else');
  const r = await j.api('student1', 'POST', `${B}/backup`, { devices: [j.key('R1')] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await j.until(r.body.job.id);
  assert.equal(job.state, 'done');
  assert.equal(job.options.offer, true);
  const snap = await j.api('student1', 'GET', `/api/jobs/snapshots/${job.snapshotId}`);
  assert.equal(snap.body.snapshot.teamName, 'team-student1', 'the backup belongs to the team that released');

  await j.holdBench('student2', 'B4M', 'team-student2');
  assert.equal((await j.api('student1', 'GET', B)).body.offer, null);
  assert.equal((await j.api('student1', 'POST', `${B}/backup`, {})).body.code, 'jobs.not_occupant');
  await j.release('student2');
  await j.holdBench('student1');
});
