/**
 * Test helpers for the bench jobs: the mock lab with the four device families
 * of the real lab (and one switch that does not run Cisco IOS) behind the
 * diagram's bench B4M, the application with the consoles, teams and jobs
 * modules, a JSON client per user, and waiting for a job to end
 *
 *   const j = await startJobsApp();          // { lab, app, api(who, method, path, body), dev(name), key(name), job(id), until(id), … }
 *   const { body } = await j.api('student1', 'POST', '/api/jobs/benches/B4M/backup', { devices: [j.key('R1')] });
 *   const done = await j.until(body.job.id);
 */
import fs from 'node:fs';
import { startMockLab } from '../../dev/mock-lab.js';
import { parseDrawio } from '../../src/modules/consoles/drawio.js';
import { createConsolesModule } from '../../src/modules/consoles/index.js';
import { createTeamsModules } from '../../src/modules/teams/index.js';
import { createJobsModule } from '../../src/modules/jobs/index.js';
import { startTestApp, repoRoot } from './app.js';
import { FAST } from './ios.js';

export const SSH = { username: 'jump', password: 'jump-pass' };
export const TELNET = { username: 'line', password: 'line-pass' };

/** B4M, as the simulator dresses it: one device per family, the others ordinary */
export const B4M_MODELS = {
  R1: { model: '2811' },                                  // ISR G1, classic IOS 12.4T
  R2: { model: 'isr4331' },                               // ISR 4331, IOS XE 17.3 (PnP, chatty)
  R3: { model: '1841', confReg: '0x2141' },               // the 1841 left behind by a password recovery
  R4: { model: '2801', enableSecret: 'class' },           // an enable secret a group left
  S1: { model: '3560' },                                  // classic switch, layer 3
  S2: { model: 'c9300l' },                                // Catalyst 9300L, IOS XE 17.6, no register line
  S3: { model: 'c1000' },                                 // Catalyst 1000
  S4: { model: 'aruba' },                                 // not Cisco IOS: left untouched
};

/** Budgets for the simulator over SSH (the device clock runs 500 times faster) */
export const JOB_TIMEOUTS = { ...FAST, promptMs: 3000, observeMs: 600, quietMs: 300, commandMs: 8000, eraseMs: 4000, bootTotalMs: 20_000, bootIdleMs: 2500, pressReturnMs: 3000, wakeWaitMs: 400 };
export const JOB_PACING = { delayMs: 0, chunkBytes: 64, chunkDelayMs: 1, lineTimeoutMs: 3000 };

export async function waitFor(check, timeoutMs = 5000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what} not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function startJobsApp({ models = B4M_MODELS, countdownMs = 300, devicesAtOnce = 5, env = {}, lab: labOptions = {} } = {}) {
  const { labs } = parseDrawio(fs.readFileSync(`${repoRoot}/diagrams/diagram.drawio`, 'utf8'), { networkPrefix: '10.22.9' });
  const all = labs.flatMap((l) => l.devices.map((d) => ({ ...d, labName: l.name })));
  const names = new Map(all.map((d) => [`${d.target.host}:${d.target.port}`, d.name]));
  const b4m = all.filter((d) => d.labName === 'B4M');
  const devices = {};
  for (const d of b4m) devices[`${d.target.host}:${d.target.port}`] = { timeScale: 0.002, ...(models[d.name] ?? {}) };
  const lab = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, names, devices, defaults: { timeScale: 0.002 }, ...labOptions });
  let modules = [];
  const app = await startTestApp({
    env: {
      SSH_HOST: '127.0.0.1', SSH_PORT: String(lab.port), SSH_USERNAME: SSH.username, SSH_PASSWORD: SSH.password,
      TELNET_USERNAME: TELNET.username, TELNET_PASSWORD: TELNET.password, TELNET_WAKE_IDLE_MS: '150',
      ALLOWED_CONSOLE_HOSTS: '10.22.9.211,10.22.9.212',
      ...env,
    },
    modules: (deps) => {
      modules = [
        createConsolesModule(deps, { rooms: { graceMs: 2000, silentMs: 3000 } }),
        ...createTeamsModules(deps, { tickMs: 0 }),
        createJobsModule(deps, { timeouts: JOB_TIMEOUTS, pacing: JOB_PACING, countdownMs, devicesAtOnce }),
      ];
      return modules;
    },
  });
  const jobs = modules.find((m) => m.id === 'jobs');

  async function api(who, method, path, body, { raw = false, headers = {} } = {}) {
    const h = { accept: 'application/json', ...(who ? app.as(who) : {}), ...headers };
    if (method !== 'GET') h.origin = app.url;
    let payload;
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) { payload = body; h['content-type'] ??= 'application/zip'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(`${app.url}${path}`, { method, headers: h, body: payload });
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: data };
  }

  const device = (name, bench = 'B4M') => all.find((d) => d.labName === bench && d.name === name);
  return {
    lab,
    app,
    jobs,
    api,
    services: app.deps.services,
    device,
    key: (name, bench) => device(name, bench).key,
    /** The simulated device behind B4M's `name` */
    dev: (name, bench = 'B4M') => { const d = device(name, bench); return lab.device(`${d.target.host}:${d.target.port}`); },
    /** A team for `who` holding `bench` */
    async holdBench(who, bench = 'B4M', team = `team-${who}`) {
      const t = await api(who, 'POST', '/api/teams', { name: team });
      if (t.status !== 201 && t.status !== 409) throw new Error(`team: ${t.status} ${JSON.stringify(t.body)}`);
      const r = await api(who, 'POST', `/api/benches/${bench}/take`);
      if (r.status !== 200) throw new Error(`take: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async release(who, bench = 'B4M') {
      return api(who, 'POST', `/api/benches/${bench}/release`);
    },
    /** The job as the runner holds it (in memory) */
    job: (id) => jobs.runner.get(id),
    /** Wait until the job is over; → its public view */
    async until(id, timeoutMs = 30_000) {
      await waitFor(() => ['done', 'failed', 'cancelled', 'partial'].includes(jobs.runner.get(id)?.state), timeoutMs, `job ${id} to end`);
      return (await api('admin', 'GET', `/api/jobs/runs/${id}`)).body.job;
    },
    async close() {
      await app.close();
      await lab.close();
    },
  };
}

/** A device's report in a finished job */
export const reportOf = (job, name) => job.devices.find((d) => d.name === name);
