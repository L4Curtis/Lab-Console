/**
 * Test helpers for the bench checks: the mock lab behind the diagram's bench
 * B4M, cabled as the diagram draws it (dev/mockCabling.js), the application
 * with the consoles, teams, jobs and checks modules, a JSON client per user,
 * and waiting for a check to end
 *
 *   const c = await startChecksApp();      // { lab, app, api(who, method, path, body), dev(name), key(name), until(bench), … }
 *   await c.holdBench('student1');
 *   const { body } = await c.api('student1', 'POST', '/api/checks/benches/B4M/cabling');
 *   const check = await c.until('B4M');
 */
import fs from 'node:fs';
import { startMockLab } from '../../dev/mock-lab.js';
import { cablesFromLabs } from '../../dev/mockCabling.js';
import { parseDrawio } from '../../src/modules/consoles/drawio.js';
import { createConsolesModule } from '../../src/modules/consoles/index.js';
import { createTeamsModules } from '../../src/modules/teams/index.js';
import { createJobsModule } from '../../src/modules/jobs/index.js';
import { createChecksModule } from '../../src/modules/checks/index.js';
import { startTestApp, repoRoot } from './app.js';
import { SSH, TELNET, JOB_TIMEOUTS, JOB_PACING, waitFor } from './jobs.js';

export { waitFor };

/** B4M for the checks: classic routers, three kinds of switches and one that does not run Cisco IOS */
export const CHECK_MODELS = {
  R1: { model: '2811' },
  R2: { model: '2811' },
  R3: { model: '2801' },
  R4: { model: '1841' },
  R5: { model: '2811' },
  S1: { model: '2960' },
  S2: { model: '3560' },
  S3: { model: '2960' },
  S5: { model: 'c1000' },
  S4: { model: 'aruba' },
};

export async function startChecksApp({ models = CHECK_MODELS, lab: labOptions = {}, checks = {}, cabling = true, env = {} } = {}) {
  const { labs } = parseDrawio(fs.readFileSync(`${repoRoot}/diagrams/diagram.drawio`, 'utf8'), { networkPrefix: '10.22.9' });
  const all = labs.flatMap((l) => l.devices.map((d) => ({ ...d, labName: l.name })));
  const names = new Map(all.map((d) => [`${d.target.host}:${d.target.port}`, d.name]));
  const devices = {};
  for (const d of all.filter((x) => x.labName === 'B4M')) devices[`${d.target.host}:${d.target.port}`] = { timeScale: 0.002, ...(models[d.name] ?? {}) };
  const lab = await startMockLab({
    port: 0, ssh: SSH, telnet: TELNET, names, devices, defaults: { timeScale: 0.002 },
    links: cabling ? cablesFromLabs(labs.filter((l) => l.name === 'B4M')) : [],
    ...labOptions,
  });
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
        createJobsModule(deps, { timeouts: JOB_TIMEOUTS, pacing: JOB_PACING, countdownMs: 4000 }),
        createChecksModule(deps, { timeouts: JOB_TIMEOUTS, wakeMs: 1500, probeSeconds: 1, pingRepeat: 2, linesCooldownMs: 60_000, perMinute: 100, ...checks }),
      ];
      return modules;
    },
  });
  const module = modules.find((m) => m.id === 'checks');

  async function api(who, method, path, body) {
    const h = { accept: 'application/json', ...(who ? app.as(who) : {}) };
    if (method !== 'GET') h.origin = app.url;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${app.url}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: data };
  }

  const device = (name, bench = 'B4M') => all.find((d) => d.labName === bench && d.name === name);
  const targetOf = (name) => { const d = device(name); return `${d.target.host}:${d.target.port}`; };
  return {
    lab,
    app,
    module,
    runner: module.runner,
    api,
    services: app.deps.services,
    device,
    targetOf,
    key: (name, bench) => device(name, bench).key,
    port: (name) => device(name).target.port,
    /** The simulated device behind B4M's `name` */
    dev: (name) => lab.device(targetOf(name)),
    async holdBench(who, bench = 'B4M', team = `team-${who}`) {
      const t = await api(who, 'POST', '/api/teams', { name: team });
      if (t.status !== 201 && t.status !== 409) throw new Error(`team: ${t.status} ${JSON.stringify(t.body)}`);
      const r = await api(who, 'POST', `/api/benches/${bench}/take`);
      if (r.status !== 200) throw new Error(`take: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    /** Wait until no check runs on `bench`; → the last one of `kind` as the runner keeps it */
    async until(bench, kind, timeoutMs = 40_000) {
      await waitFor(() => !module.runner.running(bench), timeoutMs, `the check of ${bench} to end`);
      return module.runner.last(bench, kind);
    },
    async close() {
      await app.close();
      await lab.close();
    },
  };
}

/** A device's entry in a result's `devices` */
export const entryOf = (check, name) => (check.result.devices ?? check.result.routers).find((d) => d.name === name);
