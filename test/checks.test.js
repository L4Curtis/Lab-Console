/**
 * Bench checks through the API, on the mock lab cabled as the diagram draws
 * B4M: line status (free, busy outside the application, device silent, open
 * in the application), cabling with deliberate faults, ping matrix,
 * interfaces; who may run, read and stop them; one at a time per bench;
 * cancellation; results kept in the database
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startChecksApp, CHECK_MODELS, waitFor } from './helpers/checks.js';
import { openReady } from './helpers/consoleClient.js';
import { CheckRunner } from '../src/modules/checks/runner.js';

let c;
const B = '/api/checks/benches/B4M';
const by = (list, name) => list.find((d) => d.name === name);
const linkOf = (check, a, b) => check.result.links.find((l) => (l.a.name === a && l.b.name === b) || (l.a.name === b && l.b.name === a));

before(async () => {
  c = await startChecksApp({
    models: { ...CHECK_MODELS, R3: { model: '2801', start: 'silent' }, R5: { model: '2811', start: 'dialog' } },
  });
  await c.holdBench('student1');
});

after(async () => {
  await c?.close();
});

test('nobody, a student of another team, an unknown bench or check: refused', async () => {
  assert.equal((await c.api(null, 'POST', `${B}/lines`)).status, 401);
  assert.equal((await c.api(null, 'GET', `${B}`)).status, 401);
  const other = await c.api('student2', 'POST', `${B}/cabling`);
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'checks.not_occupant');
  assert.equal((await c.api('student1', 'POST', '/api/checks/benches/B9Z/lines')).body.code, 'checks.unknown_bench');
  const kind = await c.api('student1', 'POST', `${B}/traceroute`);
  assert.equal(kind.status, 404);
  assert.equal(kind.body.code, 'checks.unknown_kind');
  const cancel = await c.api('student1', 'POST', `${B}/cancel`);
  assert.equal(cancel.body.code, 'checks.not_running');
});

test('line status: free lines answer, a line held outside is busy, a dead device is silent, a line open in the app is left alone', { timeout: 30_000 }, async () => {
  c.lab.setBusy(c.port('R2'));
  const r4 = await openReady(c.app, 'student1', c.device('R4'));
  const rooms = c.services.consoles.rooms;
  assert.ok(rooms.get(c.targetOf('R4')));

  const r = await c.api('student1', 'POST', `${B}/lines`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.check.kind, 'lines');
  const again = await c.api('student1', 'POST', `${B}/lines`);
  assert.equal(again.status, 409, 'one check at a time per bench');
  assert.equal(again.body.code, 'checks.bench_busy');

  const check = await c.until('B4M', 'lines');
  assert.equal(check.state, 'done', JSON.stringify(check.devices));
  const lines = check.result.devices;
  assert.deepEqual([by(lines, 'R1').line, by(lines, 'R1').screen], ['free', 'user']);
  assert.equal(by(lines, 'R2').line, 'busy');
  assert.equal(by(lines, 'R3').line, 'silent');
  assert.equal(by(lines, 'R4').line, 'in_app');
  assert.equal(by(lines, 'S4').line, 'free');
  // The diagram's "busy outside" knows it too; the lines the check opened are free again, R4 still open
  assert.ok(rooms.busyOutside().includes(c.targetOf('R2')));
  await waitFor(() => !rooms.get(c.targetOf('R1')) && !rooms.get(c.targetOf('R3')), 5000, 'the probed lines hung up');
  assert.ok(rooms.get(c.targetOf('R4')), 'the line someone uses is still theirs');
  assert.doesNotMatch(r4.text, /check:lines/, 'nothing was typed on the open line');
  await r4.close();
  c.lab.setBusy(c.port('R2'), false);

  // Rate limit: the lines of a bench, once in a while
  const soon = await c.api('student1', 'POST', `${B}/lines`);
  assert.equal(soon.status, 429);
  assert.equal(soon.body.code, 'checks.too_soon');
  assert.ok(soon.body.params.seconds > 0);

  // Everyone may read the line status; it is audited
  const seen = await c.api('student2', 'GET', B);
  assert.equal(seen.body.results.lines.id, check.id);
  assert.equal(seen.body.canRun, false);
  const audit = await c.app.deps.audit.query({ bench: 'B4M', action: 'check' });
  assert.ok(audit.some((e) => e.action === 'check.lines' && e.actor.username === 'student1'));
  assert.ok(audit.some((e) => e.action === 'check.lines.end' && e.details.state === 'done'));
});

test('cabling: CDP on every device against the diagram, with a cable pulled out, one moved and one too many', { timeout: 40_000 }, async () => {
  const s1 = c.targetOf('S1');
  c.lab.cabling.unplug(s1, 'FastEthernet0/1');                       // S1–S2 fa0/1: missing
  c.lab.cabling.move(s1, 'FastEthernet0/2', 'FastEthernet0/12');    // S1–S2 fa0/2: on another port of S1
  c.lab.cabling.plug({ target: s1, port: 'FastEthernet0/20' }, { target: c.targetOf('S3'), port: 'FastEthernet0/20' }); // unexpected
  c.dev('R2').configure(['interface FastEthernet0/0', ' no shutdown']);  // R2–S2: up, seen

  const r = await c.api('student1', 'POST', `${B}/cabling`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const check = await c.until('B4M', 'cabling');
  assert.equal(check.state, 'partial', 'the Aruba switch is skipped, R3 is silent, R5 sits at the dialog');
  const devices = check.result.devices;
  assert.equal(by(devices, 'S4').state, 'skipped');
  assert.equal(by(devices, 'S4').code, 'ios.not_ios');
  assert.equal(by(devices, 'S1').hostname, 'S1');

  assert.equal(check.result.links.find((l) => l.a.name === 'S1' && l.b.name === 'S2' && l.a.port === 'FastEthernet0/1').status, 'missing');
  const moved = check.result.links.filter((l) => l.a.name === 'S1' && l.b.name === 'S2').find((l) => l.a.port === 'FastEthernet0/2');
  assert.equal(moved.status, 'wrong_port');
  assert.equal(moved.a.seen, 'FastEthernet0/12');
  assert.equal(linkOf(check, 'R2', 'S2').status, 'ok');
  const r1s1 = linkOf(check, 'R1', 'S1');
  assert.equal(r1s1.status, 'missing');
  assert.deepEqual(r1s1.reason, { code: 'shutdown', params: { device: 'R1', port: 'FastEthernet0/0' } });
  assert.equal(linkOf(check, 'S1', 'S4').status, 'unverified');
  assert.equal(linkOf(check, 'S1', 'S4').reason.code, 'not_cisco');
  assert.ok(check.result.unexpected.some((u) => [u.a.name, u.b.name].sort().join() === 'S1,S3' && u.a.port === 'FastEthernet0/20'));
  assert.equal(check.result.summary.unexpected, check.result.unexpected.length);

  // A device that does not run Cisco IOS got show version and nothing else
  const aruba = c.dev('S4');
  assert.ok(aruba.commandLog.length > 0);
  assert.ok(aruba.commandLog.every((cmd) => /^(terminal length \d+|show version)$/.test(cmd)), aruba.commandLog.join(' | '));
  // A device at the initial dialog was not answered
  assert.equal(by(devices, 'R5').state, 'failed');
  assert.equal(c.dev('R5').state, 'dialog');

  // Who reads it: the team and admins, not another student
  assert.equal((await c.api('student1', 'GET', B)).body.results.cabling.id, check.id);
  assert.equal((await c.api('admin', 'GET', B)).body.results.cabling.id, check.id);
  const stranger = await c.api('student2', 'GET', B);
  assert.equal(stranger.body.results.cabling, undefined);
  assert.ok(!(await c.api('student2', 'GET', '/api/checks/latest')).body.checks.some((x) => x.kind === 'cabling'));
  assert.ok((await c.api('student1', 'GET', '/api/checks/latest')).body.checks.some((x) => x.kind === 'cabling'));
});

test('ping matrix between the routers, from the addresses read on them', { timeout: 40_000 }, async () => {
  c.dev('R1').configure(['interface FastEthernet0/1', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']);
  c.dev('R2').configure(['interface FastEthernet0/1', ' ip address 10.0.12.2 255.255.255.0', ' no shutdown']);
  const r = await c.api('student1', 'POST', `${B}/ping`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body.check.devices.map((d) => d.name).sort(), ['R1', 'R2', 'R3', 'R4', 'R5'], 'routers only');
  const check = await c.until('B4M', 'ping');
  const routers = check.result.routers;
  assert.deepEqual(by(routers, 'R1').addresses, [{ interface: 'FastEthernet0/1', ip: '10.0.12.1' }]);
  const cell = (from, to) => check.result.cells.find((x) => x.from === c.key(from) && x.to === c.key(to));
  assert.ok(['ok', 'partial'].includes(cell('R1', 'R2').state), JSON.stringify(cell('R1', 'R2')));
  assert.ok(cell('R1', 'R2').received > 0);
  assert.ok(['ok', 'partial'].includes(cell('R2', 'R1').state));
  assert.equal(cell('R4', 'R1').state, 'fail', 'R4 has no address in that network');
  assert.equal(cell('R4', 'R1').received, 0);
  assert.equal(by(routers, 'R3').state, 'failed', 'R3 stays silent');
  assert.equal(cell('R3', 'R1'), undefined);
});

test('interfaces: addresses and state of every interface', { timeout: 40_000 }, async () => {
  const r = await c.api('student1', 'POST', `${B}/interfaces`);
  assert.equal(r.status, 202);
  const check = await c.until('B4M', 'interfaces');
  const r1 = by(check.result.devices, 'R1');
  assert.equal(r1.state, 'done');
  assert.equal(r1.model, '2811');
  assert.deepEqual(r1.interfaces.find((i) => i.name === 'FastEthernet0/1'), { name: 'FastEthernet0/1', ip: '10.0.12.1', status: 'up', protocol: 'up' });
  assert.equal(r1.interfaces.find((i) => i.name === 'FastEthernet0/0').status, 'administratively down');
  // Nothing in an interface with no cable: down
  const s1 = by(check.result.devices, 'S1');
  assert.equal(s1.interfaces.find((i) => i.name === 'FastEthernet0/7').status, 'down');
  assert.equal(s1.interfaces.find((i) => i.name === 'FastEthernet0/3').status, 'up');
  // The diagram's links carry what each labelled end reads: what the diagram writes on them
  const ends = check.result.links.flatMap((l) => [l.a, l.b]);
  assert.equal(ends.find((e) => e.name === 'R1' && e.port === 'FastEthernet0/0').status, 'administratively down');
  assert.equal(ends.find((e) => e.name === 'S1' && e.port === 'FastEthernet0/3').status, 'up');
  assert.equal(ends.find((e) => e.name === 'S3' && !e.port).status, null, 'an end the diagram does not label reads nothing');
});

test('cancelling: not by a stranger; by the actor, everything stops where it was', { timeout: 30_000 }, async () => {
  const r = await c.api('student1', 'POST', `${B}/cabling`);
  assert.equal(r.status, 202);
  const stranger = await c.api('student2', 'POST', `${B}/cancel`);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.code, 'checks.cancel_forbidden');
  const stop = await c.api('student1', 'POST', `${B}/cancel`);
  assert.equal(stop.status, 200);
  const check = await c.until('B4M', 'cabling');
  assert.equal(check.state, 'cancelled');
  assert.equal(check.cancelledBy.username, 'student1');
  assert.ok(check.devices.some((d) => d.state === 'cancelled'));
  const audit = await c.app.deps.audit.query({ bench: 'B4M', action: 'check.cabling.cancel' });
  assert.equal(audit.length, 1);
});

test('no check while a job runs on the bench; a locked bench is for admins only', { timeout: 30_000 }, async () => {
  const job = await c.api('student1', 'POST', '/api/jobs/benches/B4M/reset', { devices: [c.key('R1')], confirm: 'B4M' });
  assert.equal(job.status, 202, JSON.stringify(job.body));
  const refused = await c.api('student1', 'POST', `${B}/interfaces`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'checks.job_running');
  await c.api('student1', 'POST', `/api/jobs/runs/${job.body.job.id}/cancel`);
  await waitFor(() => !c.services.jobs.running('B4M'), 5000, 'the job to stop');

  assert.equal((await c.api('admin', 'PUT', '/api/benches/B4M/lock', { reason: 'maintenance' })).status, 200);
  const locked = await c.api('student1', 'POST', `${B}/interfaces`);
  assert.equal(locked.status, 423);
  assert.equal(locked.body.code, 'checks.locked');
  const admin = await c.api('admin', 'POST', `${B}/interfaces`);
  assert.equal(admin.status, 202, JSON.stringify(admin.body));
  await c.until('B4M', 'interfaces');
  assert.equal((await c.api('admin', 'DELETE', '/api/benches/B4M/lock')).status, 200);
});

test('the last result of each kind is in the database and comes back after a restart', async () => {
  const rows = await c.app.deps.repos.checks.all();
  assert.deepEqual([...new Set(rows.filter((x) => x.bench === 'B4M').map((x) => x.kind))].sort(), ['cabling', 'interfaces', 'lines', 'ping']);
  const fresh = new CheckRunner({ services: c.services, events: { publish() {} }, audit: { log() {} }, repos: c.app.deps.repos, logger: { warn() {} }, readable: () => true });
  await fresh.load();
  const cabling = fresh.last('B4M', 'cabling');
  assert.equal(cabling.state, 'cancelled');
  assert.ok(Array.isArray(cabling.devices) && cabling.devices.length === 10);
  assert.equal(cabling.cancelledBy.username, 'student1');
  const interfaces = fresh.last('B4M', 'interfaces');
  assert.ok(interfaces.result.devices.some((d) => d.name === 'R1' && d.interfaces?.length), JSON.stringify(interfaces.result.devices.map((d) => [d.name, d.state, d.code, d.params])));
  assert.equal(interfaces.result.progress, undefined, 'the row\'s bookkeeping stays inside the repository boundary');
});
