/**
 * The jobs' building blocks without a lab: the repositories of jobs,
 * snapshots and templates; the files of a set and their check; what a ZIP
 * import accepts; the driver budgets scaled; the exact script of a device
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { memoryDatabase } from './helpers/db.js';
import { tempDataDir, silentLogger } from './helpers/app.js';
import { createStore } from '../src/lib/store.js';
import { parseVlanBrief, TIMEOUTS } from '../src/lib/drivers/ciscoIos.js';
import { ConfigFiles, readZip, vlanText, checkConfigText, newSetId, isSetId, cleanVlans, cleanVtp } from '../src/modules/jobs/configFiles.js';
import { Library, compareConfigs, comparable } from '../src/modules/jobs/library.js';
import { scaledTimeouts, planScript } from '../src/modules/jobs/runner.js';

const CONFIG = 'version 15.0\nhostname S1\n!\ninterface FastEthernet0/1\n switchport access vlan 10\n!\nend\n';
const VLANS = [{ id: 1, name: 'default', status: 'active', ports: ['Fa0/2', 'Fa0/3'] }, { id: 10, name: 'ADMIN', status: 'active', ports: ['Fa0/1'] }, { id: 20, name: 'OFF', status: 'act/lshut', ports: [] }];

test('the jobs repository keeps a job and its report; the unfinished ones are found again', async (t) => {
  const { repos, close } = await memoryDatabase();
  t.after(close);
  const job = { id: '01a1d689-d3d6-7000-81bb-b2538eed6b4b', bench: 'B4M', kind: 'reset', state: 'running', teamId: 't1', actor: { id: 'oidc:a', username: 'a', name: 'A' }, options: { forceErase: [] }, devices: [{ name: 'R1', state: 'running' }], createdAt: '2026-11-13T09:00:00.000Z' };
  await repos.jobs.save(job);
  assert.deepEqual((await repos.jobs.unfinished()).map((j) => j.id), [job.id]);
  await repos.jobs.save({ ...job, state: 'done', devices: [{ name: 'R1', state: 'done' }], endedAt: '2026-11-13T09:05:00.000Z' });
  const back = await repos.jobs.get(job.id);
  assert.equal(back.state, 'done');
  assert.deepEqual(back.devices, [{ name: 'R1', state: 'done' }]);
  assert.deepEqual(await repos.jobs.unfinished(), []);
  assert.equal((await repos.jobs.list({ bench: 'B4M' })).length, 1);
  assert.equal((await repos.jobs.list({ bench: 'B4H' })).length, 0);
});

test('snapshots and templates: the index of the files, devices added one by one, one base configuration at most', async (t) => {
  const { repos, close } = await memoryDatabase();
  t.after(close);
  const s = { id: newSetId('backup'), bench: 'B4M', teamId: 't1', label: 'x', origin: 'backup', jobId: null, author: { id: 'a' }, dir: 'snapshots/B4M/x', createdAt: Date.now(), bytes: 0 };
  await repos.snapshots.insert(s);
  await repos.snapshots.addDevice(s.id, { device: 'R1', file: 'R1.cfg', sha256: 'a'.repeat(64), bytes: 10, facts: { kind: 'router' } }, 10);
  await repos.snapshots.addDevice(s.id, { device: 'S1', file: 'S1.cfg', sha256: 'b'.repeat(64), bytes: 20, vlanFile: 'S1.vlan.txt', vlanSha256: 'c'.repeat(64), facts: {} }, 30);
  const got = await repos.snapshots.get(s.id);
  assert.equal(got.bytes, 30);
  assert.deepEqual(got.devices.map((d) => [d.device, d.vlanFile]), [['R1', null], ['S1', 'S1.vlan.txt']]);
  assert.equal((await repos.snapshots.list({ bench: 'B4M' })).length, 1);
  await repos.snapshots.remove(s.id);
  assert.equal(await repos.snapshots.get(s.id), null);

  for (const name of ['A', 'B']) {
    await repos.templates.insert({ id: newSetId('template'), name, description: '', dir: `templates/${name}`, author: {}, createdAt: Date.now(), devices: [{ device: '*', file: '_any.cfg', sha256: 'd'.repeat(64), bytes: 3, facts: {} }] });
  }
  const [a, b] = await repos.templates.list();
  await repos.templates.setBase(a.id);
  await repos.templates.setBase(b.id);
  assert.deepEqual((await repos.templates.list()).map((x) => x.base), [false, true]);
  await repos.templates.setBase(null);
  assert.deepEqual((await repos.templates.list()).map((x) => x.base), [false, false]);
});

test('a set\'s files: written, indexed with their hash, read back and checked; a changed file no longer passes', async (t) => {
  const dir = tempDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { repos, close } = await memoryDatabase();
  t.after(close);
  const store = createStore(dir, { logger: silentLogger() });
  const library = new Library({ store, repos, services: {}, audit: { log() {} } });
  const set = await library.open({ bench: 'B4M', teamId: 't1', origin: 'backup', author: { id: 'oidc:a', username: 'a', name: 'A' } });
  assert.ok(isSetId(set.id));
  const row = await library.add(set, { device: 'S1', config: CONFIG, vlans: VLANS, vtp: { version: 2, mode: 'server', domain: 'LAB', password: 'vtp', pruning: false }, facts: { kind: 'switch', hostname: 'S1', extra: 'dropped' } });
  library.close(set);
  assert.equal(row.facts.extra, undefined);
  assert.equal(await library.verify(set, row, CONFIG), true);
  assert.equal(await library.verify(set, row, `${CONFIG}!`), false, 'not what was read from the device');
  const back = await library.readDevice(set, 'S1');
  assert.equal(back.intact, true);
  assert.deepEqual(back.vlans, VLANS);
  assert.equal(back.vtp.domain, 'LAB');
  fs.appendFileSync(path.join(library.files.abs(set.dir), row.file), 'tampered\n');
  assert.equal((await library.readDevice(set, 'S1')).intact, false);
  assert.equal(await library.verify(set, row, CONFIG), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(library.files.abs(set.dir), 'manifest.json'), 'utf8'));
  assert.equal(manifest.devices[0].device, 'S1');
  assert.equal((fs.statSync(path.join(library.files.abs(set.dir), row.file)).mode & 0o777), 0o600);
});

test('VLAN listings are written as IOS prints them and read back the same', () => {
  assert.deepEqual(parseVlanBrief(vlanText(VLANS)), VLANS);
  assert.deepEqual(cleanVlans([{ id: 5000 }, { id: 7, name: 'a b', status: 'weird', ports: ['Fa0/1', '; rm'] }]), [{ id: 7, name: 'VLAN0007', status: 'active', ports: ['Fa0/1'] }]);
  assert.equal(cleanVtp({ version: 9, mode: 'evil', domain: 'x'.repeat(100) }).mode, 'server');
});

test('what a configuration file must look like', () => {
  assert.equal(checkConfigText(CONFIG), null);
  assert.equal(checkConfigText(''), 'empty');
  assert.equal(checkConfigText('just text\n'), 'not_a_config');
  assert.equal(checkConfigText('just text\n', { strict: false }), null);
  assert.equal(checkConfigText('hostname R1\n\u0001\u0002'), 'binary');
  assert.equal(checkConfigText(`hostname R1\n${'x'.repeat(600 * 1024)}`), 'too_large');
});

test('a ZIP: one top folder is dropped, deeper ones and hidden files skipped, unsafe names refused', () => {
  const files = readZip(zipSync({ 'B4M-x/R1.cfg': strToU8('hostname R1\n'), 'B4M-x/.DS_Store': strToU8('x'), 'B4M-x/sub/R2.cfg': strToU8('hostname R2\n') }));
  assert.deepEqual([...files.keys()], ['R1.cfg']);
  assert.throws(() => readZip(zipSync({ '../R1.cfg': strToU8('x') })), { code: 'jobs.zip_unsafe' });
  assert.throws(() => readZip(zipSync({ 'a/../../R1.cfg': strToU8('x') })), { code: 'jobs.zip_unsafe' });
  assert.throws(() => readZip(Buffer.from('PK nothing')), { code: 'jobs.zip_invalid' });
  assert.throws(() => readZip(zipSync({ 'R1.cfg': new Uint8Array(2 * 1024 * 1024) })), { code: 'jobs.zip_too_large' });
});

test('budgets scaled for the simulator keep the number of wake-ups; the script of a device is the same each time it is computed', () => {
  const fast = scaledTimeouts(0.01);
  assert.equal(fast.wakes, TIMEOUTS.wakes);
  assert.equal(fast.bootTotalMs, Math.round(TIMEOUTS.bootTotalMs * 0.01));
  assert.deepEqual(scaledTimeouts(1), { ...TIMEOUTS });
  const a = planScript({ config: CONFIG, vlans: VLANS, facts: { kind: 'switch' } });
  const b = planScript({ config: CONFIG, vlans: VLANS, facts: { kind: 'switch' } });
  assert.equal(a.sha256, b.sha256);
  assert.match(a.script, /^vlan 10\n name ADMIN\nvlan 20\n name OFF\n shutdown$/m);
  const withDomain = { config: CONFIG.replace('hostname S1\n', 'hostname S1\nip domain name lab.local\n'), vlans: VLANS, facts: { kind: 'switch' } };
  assert.match(planScript(withDomain, { rsaModulus: 1024 }).script, /^crypto key generate rsa general-keys modulus 1024$/m);
  assert.notEqual(planScript(withDomain, { rsaModulus: 1024 }).sha256, planScript(withDomain).sha256, 'an option changes the fingerprint');
});

test('two configurations compared on what a replay reproduces', () => {
  assert.equal(compareConfigs(comparable({ config: CONFIG }), comparable({ config: `Current configuration : 99 bytes\n${CONFIG}` })).status, 'same');
  const c = compareConfigs(comparable({ config: CONFIG, vlans: VLANS }), comparable({ config: CONFIG.replace('vlan 10', 'vlan 30'), vlans: VLANS }));
  assert.equal(c.status, 'changed');
  assert.equal(c.added, 1);
  assert.equal(c.removed, 1);
  assert.match(c.patch, /^- switchport access vlan 10$/m);
});

test('a set folder never leaves the data directory', async (t) => {
  const dir = tempDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = new ConfigFiles({ store: createStore(dir, { logger: silentLogger() }) });
  assert.throws(() => files.abs('snapshots/../../etc'), { code: 'store.path' });
  assert.match(files.snapshotDir('B4M/../x', 'id'), /^snapshots\/B4M_.._x\/id$|^snapshots\/[^/]+\/id$/);
});

test('a job the server left running when it stopped is closed at start-up, its devices marked interrupted', async (t) => {
  const dir = tempDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { repos, close } = await memoryDatabase();
  t.after(close);
  const { createJobsModule } = await import('../src/modules/jobs/index.js');
  const published = [];
  const mod = createJobsModule({
    config: { jobs: { devicesAtOnce: 5, countdownSeconds: 10, importMaxKb: 2048, timeScale: 1 } }, logger: silentLogger(),
    events: { publish: (topic, data) => published.push([topic, data]) }, store: createStore(dir, { logger: silentLogger() }), repos,
    audit: { log() {} }, infra: { adminSwitches: [] }, services: {},
  });
  await repos.jobs.save({ id: '01a1d689-d3d6-7000-81bb-b2538eed6b4c', bench: 'B4M', kind: 'reset', state: 'running', actor: { id: 'a' }, options: {}, createdAt: '2026-11-13T09:00:00.000Z',
    devices: [{ name: 'R1', state: 'done' }, { name: 'R2', state: 'running', step: 'ios.steps.boot' }, { name: 'S1', state: 'queued' }] });
  await mod.start();
  const job = await repos.jobs.get('01a1d689-d3d6-7000-81bb-b2538eed6b4c');
  assert.equal(job.state, 'failed');
  assert.deepEqual(job.devices.map((d) => [d.name, d.state, d.code ?? null]), [['R1', 'done', null], ['R2', 'failed', 'jobs.interrupted'], ['S1', 'failed', 'jobs.interrupted']]);
  assert.deepEqual(published.find(([topic]) => topic === 'jobs:running')[1], { jobs: [] });
  mod.shutdown();
});
