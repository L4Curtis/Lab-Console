/**
 * A recovery that does not finish puts its device back: stopped after
 * confreg, park_config or boot, abandoned, a step refused by the device,
 * server shutdown; what could not be put back is said, kept, and put back by
 * the next one; a put-back without booting is remembered
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRecoveryApp, bootOwn, bootedOwn } from './helpers/recovery.js';
import { waitFor } from './helpers/http.js';
let j;
let recovery;
let live;
let awaiting;
let ended;
let confirm;
let start;
let walk;
before(async () => {
  ({ j, recovery, live, awaiting, ended, confirm, start, walk } = await startRecoveryApp());
});
after(() => j?.close());

test('stopped after confreg: confreg 0x2102 and reset; the router boots its own startup-config, nothing left', async () => {
  const r4 = j.dev('R4');
  const s = await start('student1', 'R4', 'isr_g1');
  const id = s.body.recovery.id;
  await walk(id, r4, ['power_cycle', 'confreg'], 'boot');
  assert.equal(r4.nextConfReg, '0x2142');
  assert.equal(live(id).bypassed, 'register');
  assert.equal((await j.app.deps.repos.recoveries.get(id)).bypassed, 'register', 'saved as soon as it is in place');
  const stop = await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  assert.equal(stop.status, 200);
  const again = await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  assert.ok(again.status === 409 && ['recovery.putting_back', 'recovery.over'].includes(again.body.code), JSON.stringify(again.body));
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.deepEqual(rec.putBack, { ok: true, booted: true, at: rec.putBack.at });
  assert.equal(rec.bypassed, null);
  assert.equal(r4.confReg, '0x2102');
  assert.ok(bootedOwn(r4, 'R4-3009'), `${r4.state} ${r4.cfg.hostname}`);
  const stored = await j.app.deps.repos.recoveries.get(id);
  assert.equal(stored.state, 'cancelled');
  assert.equal(stored.bypassed, null);
  assert.equal((await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('R4'))}`)).body.left, null);
});

test('stopped after park_config: config.text renamed back at switch:, the switch boots its own startup-config', async () => {
  const s1 = j.dev('S1');
  await bootOwn(s1);
  const s = await start('student1', 'S1', 'catalyst');
  const id = s.body.recovery.id;
  await walk(id, s1, ['power_cycle', 'flash_init', 'park_config'], 'boot', { mode: true });
  assert.equal(s1.startup, null);
  assert.ok(s1.parked);
  assert.equal(live(id).bypassed, 'parked');
  assert.equal((await j.api('admin', 'POST', `/api/recovery/runs/${id}/cancel`)).status, 200, 'an admin may stop it');
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.equal(rec.cancelledBy.username, 'admin');
  assert.equal(rec.putBack.ok, true);
  assert.equal(s1.parked, null);
  assert.ok(s1.startup, 'flash:config.text is back');
  assert.ok(bootedOwn(s1, s1.startup.hostname), `${s1.state} ${s1.cfg.hostname}`);
});

test('abandoned after park_config: put back all the same', async () => {
  const s3 = j.dev('S3');
  const s = await start('student1', 'S3', 'catalyst');
  const id = s.body.recovery.id;
  const before = recovery.runner.timeouts.confirmMs;
  try {
    await walk(id, s3, ['power_cycle', 'flash_init'], 'park_config', { mode: true });
    recovery.runner.timeouts = { ...recovery.runner.timeouts, confirmMs: 300 };
    await confirm('student1', id, 'park_config');
    const rec = await ended(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.code, 'recovery.abandoned');
    assert.equal(rec.putBack.ok, true, JSON.stringify(rec.putBack));
    assert.equal(rec.bypassed, null);
  } finally {
    recovery.runner.timeouts = { ...recovery.runner.timeouts, confirmMs: before };
  }
  assert.equal(s3.parked, null);
  assert.equal(s3.startup.hostname, 'S3-3010');
  assert.ok(bootedOwn(s3, 'S3-3010'), `${s3.state} ${s3.cfg.hostname}`);
});

test('park_config refused (config.text.recovery next to config.text): nothing set aside, nothing to put back, the switch booted back', async () => {
  const s3 = j.dev('S3'); // booted with its own startup-config by the test above
  s3.parked = { name: 'config.text.recovery', cfg: { ...structuredClone(s3.startup), hostname: 'OLD' } };
  try {
    const s = await start('student1', 'S3', 'catalyst');
    const id = s.body.recovery.id;
    await walk(id, s3, ['power_cycle', 'flash_init'], 'park_config', { mode: true });
    await confirm('student1', id, 'park_config');
    const rec = await ended(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.code, 'recovery.parked_exists', JSON.stringify(rec.error));
    assert.equal(rec.bypassed, null, 'nothing was renamed: no bypass');
    assert.equal(rec.cause, null);
    assert.deepEqual({ ok: rec.putBack.ok, booted: rec.putBack.booted, nothing: rec.putBack.nothing }, { ok: true, booted: true, nothing: true });
    assert.ok(bootedOwn(s3, 'S3-3010'), `${s3.state} ${s3.cfg.hostname}`);
    assert.equal(s3.startup.hostname, 'S3-3010', 'config.text untouched');
    assert.equal(s3.parked.cfg.hostname, 'OLD', 'the parked file untouched');
    const row = await j.app.deps.repos.recoveries.get(id);
    assert.equal(row.bypassed, null);
    assert.equal(row.code, 'recovery.parked_exists');
    assert.deepEqual(row.putBack, { ok: true, booted: true, at: 'password', code: null }, 'locked again by its own line password, as found');
    const info = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('S3'))}`);
    assert.equal(info.body.left, null);
    assert.equal(info.body.halted, null);
  } finally {
    s3.parked = null;
  }
});

test('stopped from the console tile after boot: put back (0x2102 for the next boot), said to be stopped from the console', async () => {
  const r1 = j.dev('R1');
  await bootOwn(r1);
  const s = await start('student1', 'R1', 'isr_g1');
  const id = s.body.recovery.id;
  await walk(id, r1, ['power_cycle', 'confreg', 'boot'], 'restore_register');
  assert.equal(r1.cfg.hostname, 'Router');
  assert.equal(r1.confReg, '0x2142');
  const room = j.services.consoles.rooms.get(`${j.device('R1').target.host}:${j.device('R1').target.port}`);
  assert.equal(room.cancelTask('system').ok, true);
  const rec = await ended(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.equal(rec.cancelledBy, null);
  assert.equal(rec.stoppedFrom, 'console');
  assert.equal(rec.putBack.ok, true, JSON.stringify(rec.putBack));
  assert.equal(r1.nextConfReg, '0x2102');
  assert.ok(r1.startup.blocks.find((b) => b.head === 'line con 0').lines.includes('password left-by-a-group'));
  await waitFor(async () => (await j.app.deps.repos.audit.query({ actions: ['recovery'], limit: 200 })).some((e) => e.action === 'recovery.cancel' && e.details?.recovery === id && e.details?.from === 'console'), { ms: 5000, what: 'the stop from the console audited' });
});

test('what cannot be put back is said and kept; the next recovery puts it back from the factory prompt, no power cycle', async () => {
  const s2 = j.dev('S2');
  s2.ignoreFlagSticks = true;
  const s = await start('student1', 'S2', 'c9300l');
  const id = s.body.recovery.id;
  await walk(id, s2, ['power_cycle', 'ignore_startup', 'boot'], 'restore_startup', { mode: true });
  await j.api('student1', 'POST', `/api/recovery/runs/${id}/cancel`);
  const rec = await ended(id);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.code, 'recovery.left_ignore');
  assert.equal(rec.cause.code, 'recovery.cancelled');
  assert.equal(rec.bypassed, 'ignore');
  assert.equal(rec.putBack.ok, false);
  assert.equal((await j.app.deps.repos.recoveries.get(id)).bypassed, 'ignore');
  const info = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('S2'))}`);
  assert.equal(info.body.left, 'ignore');

  // Fixed on site; the next recovery reads Switch> and only puts the flag back
  s2.ignoreFlagSticks = false;
  const cycles = s2.powerCycles;
  const next = await start('student1', 'S2', 'c9300l');
  const nid = next.body.recovery.id;
  await awaiting(nid, 'restore_startup');
  assert.deepEqual(live(nid).steps.filter((x) => x.state === 'skipped').map((x) => x.id), ['power_cycle', 'ignore_startup', 'boot']);
  await confirm('student1', nid, 'restore_startup');
  const done = await ended(nid);
  assert.equal(done.state, 'done', JSON.stringify(done.error));
  assert.equal(done.bypassed, null);
  assert.equal(s2.romvars.SWITCH_IGNORE_STARTUP_CFG, '0');
  assert.equal(s2.powerCycles, cycles);
  assert.equal((await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('S2'))}`)).body.left, null);
});

test('a put-back without booting is kept in the row: the next start says where the device was left', async () => {
  const repos = j.app.deps.repos;
  const id = '0190a000-0000-7000-8000-0000000000aa';
  await repos.recoveries.save({
    id, bench: 'B4M', device: { key: j.key('R5'), name: 'R5' }, family: 'isr_g1', actor: { id: 'u1', name: 'A' }, teamId: null,
    state: 'cancelled', steps: [], code: 'recovery.cancelled', bypassed: null, putBack: { ok: true, booted: false, at: 'rommon', code: null },
    createdAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  });
  assert.deepEqual((await repos.recoveries.get(id)).putBack, { ok: true, booted: false, at: 'rommon', code: null });
  const info = await j.api('student1', 'GET', `/api/recovery/devices/${encodeURIComponent(j.key('R5'))}`);
  assert.equal(info.body.halted, 'rommon');
  assert.equal(info.body.left, null);
});

// Last: it closes the whole application, as a stopping server does (every module, in the same call)
test('server shutdown after confreg: the whole app closes, the register is put back first, without booting, the row saved', async () => {
  const r4 = j.dev('R4');
  const s = await start('student1', 'R4', 'isr_g1');
  const id = s.body.recovery.id;
  await walk(id, r4, ['power_cycle', 'confreg'], 'boot');
  assert.equal(r4.nextConfReg, '0x2142');
  // The database closes with the app: keep what was last saved
  const repo = j.app.deps.repos.recoveries;
  const save = repo.save;
  let stored = null;
  repo.save = (rec) => { if (rec.id === id) stored = structuredClone(rec); return save.call(repo, rec); };
  const app = j;
  j = null;
  await app.close();
  const rec = live(id);
  assert.equal(rec.state, 'cancelled', JSON.stringify(rec.error));
  assert.deepEqual({ ok: rec.putBack.ok, booted: rec.putBack.booted, at: rec.putBack.at }, { ok: true, booted: false, at: 'rommon' });
  assert.equal(r4.state, 'rommon', 'not booted: the server is stopping');
  assert.equal(r4.nextConfReg, '0x2102');
  assert.equal(stored.state, 'cancelled');
  assert.equal(stored.bypassed, null);
  assert.deepEqual(stored.putBack, { ok: true, booted: false, at: 'rommon', code: null });
});
