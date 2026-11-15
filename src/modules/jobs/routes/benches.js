/**
 * /api/jobs: a bench's jobs (what the bench page shows, backup, reset,
 * preview and injection, comparison, the TP folder) and the runs (list, one
 * job, cancel). The rules are in ../permissions.js and ../../teams/access.js
 */
import fs from 'node:fs';
import express from 'express';
import { jsonBody } from '../../../lib/bodies.js';
import { httpError } from '../../../lib/httpError.js';
import { noStore } from '../../../lib/security.js';
import { targetKey } from '../../../lib/consoleTarget.js';
import { dayOf } from '../../consoles/journal.js';
import { planScript, publicJob } from '../runner.js';
import { vlanText, makeZip, ANY_DEVICE } from '../configFiles.js';
import { pickDevices, secretsOf, rsaModulusOf, labelOf, droppedCode, sendZip } from '../input.js';

const JOB_ID = /^[0-9a-f-]{36}$/;

export function benchRoutes({ services, store, audit, repos, access, perms, runner, library }) {
  const benches = () => services.benches;
  const benchName = (name) => access.benchOf(name).name;
  const pick = (bench, keys) => pickDevices(access.taskDevices(bench), keys);
  const refuse = (no) => { if (no) throw no; };

  /** Start a job, or the refusal as an HttpError */
  function start(req, res, spec) {
    // A check reads the devices of the bench one after the other: nothing writes to them meanwhile
    const check = services.checks?.running?.(spec.bench);
    if (check) throw httpError(409, 'jobs.check_running', 'A check is running on this bench: wait until it ends.', { kind: check.kind, name: check.actor.name });
    const holder = benches()?.holder?.(spec.bench);
    const offer = !holder && spec.kind === 'backup' && !benches()?.canOperate?.(req.user, spec.bench) ? perms.offerFor(req.user, spec.bench) : null;
    const { job, refused } = runner.start({
      ...spec,
      actor: req.user,
      teamId: holder?.teamId ?? offer?.teamId ?? null,
      options: { ...spec.options, ...(offer ? { offer: true } : {}) },
    });
    if (refused) throw httpError(refused.status, refused.code, refused.message, refused.params);
    res.status(202).json({ job: publicJob(job) });
  }

  // ── Sources of an injection, and the exact scripts ────────────────────────

  async function source(user, src) {
    if (src?.snapshot !== undefined) {
      const set = await library.snapshot(user, String(src.snapshot));
      return { set, kind: 'snapshot', id: set.id, name: set.label || set.id, fallback: false };
    }
    if (src?.template !== undefined) {
      const set = await library.template(String(src.template));
      return { set, kind: 'template', id: set.id, name: set.name, fallback: true };
    }
    throw httpError(400, 'jobs.no_source', 'Choose a snapshot or a template to inject.');
  }

  /** Per device: the script it will receive (what the preview shows and the job sends) */
  async function plan(user, bench, body) {
    const src = await source(user, body?.source);
    const rsaModulus = rsaModulusOf(body);
    const devices = pick(bench, body?.devices);
    const plans = new Map();
    const missing = [];
    for (const d of devices) {
      const entry = await library.readDevice(src.set, d.name, { fallback: src.fallback });
      if (!entry) { missing.push({ key: d.key, name: d.name, reason: 'absent' }); continue; }
      if (!entry.intact) { missing.push({ key: d.key, name: d.name, reason: 'damaged' }); continue; }
      const p = planScript(entry, { rsaModulus });
      plans.set(d.key, { ...p, from: entry.row.device === ANY_DEVICE ? `${src.name} (*)` : `${src.name}/${entry.row.device}`, source: { config: entry.config, vlans: entry.vlans } });
    }
    return { src, devices, plans, missing, rsaModulus };
  }

  const router = express.Router();
  router.use(noStore);
  const json = jsonBody('64kb');

  // ── Benches ───────────────────────────────────────────────────────────────

  router.get('/benches/:bench', async (req, res) => {
    const bench = benchName(req.params.bench);
    const rooms = services.consoles?.rooms;
    const running = runner.running(bench);
    const base = await library.base();
    const holder = benches()?.holder?.(bench) ?? null;
    const offer = perms.offerFor(req.user, bench);
    const team = access.teamOf(req.user);
    res.json({
      bench,
      canOperate: Boolean(benches()?.canOperate?.(req.user, bench)),
      lock: benches()?.lock?.(bench) ?? null,
      holder: holder ? { teamId: holder.teamId, teamName: library.teamName(holder.teamId) } : null,
      team: team ? { id: team.id, name: team.name } : null,
      offer: offer ? { until: new Date(offer.until).toISOString() } : null,
      devices: access.taskDevices(bench).map((d) => {
        const summary = rooms?.get(targetKey(d.target))?.summary();
        return { key: d.key, name: d.name, shared: d.shared, open: Boolean(summary), people: summary?.users?.map((u) => u.name) ?? [], pilot: summary?.pilot?.name ?? null };
      }),
      running: running ? (perms.jobFor(req.user, running) ?? runner.summary().jobs.find((j) => j.id === running.id)) : null,
      base: base ? { id: base.id, name: base.name } : null,
      countdownSeconds: Math.round(runner.countdownMs / 1000),
    });
  });

  router.post('/benches/:bench/backup', json, (req, res) => {
    const bench = benchName(req.params.bench);
    refuse(perms.refusal(req.user, bench, { offerOk: true }));
    start(req, res, { kind: 'backup', bench, devices: pick(bench, req.body?.devices), secrets: secretsOf(req.body), options: { label: labelOf(req.body?.label) } });
  });

  router.post('/benches/:bench/reset', json, async (req, res) => {
    const bench = benchName(req.params.bench);
    refuse(perms.refusal(req.user, bench));
    if (req.body?.confirm !== bench) throw httpError(400, 'jobs.confirm_bench', 'Type the name of the bench to confirm the reset.', { bench });
    const devices = pick(bench, req.body?.devices);
    refuse(access.sharedConflict(req.user, bench, devices));
    const forceErase = Array.isArray(req.body?.forceErase) ? req.body.forceErase.filter((k) => typeof k === 'string') : [];
    if (forceErase.length && !access.isAdmin(req.user)) throw httpError(403, 'jobs.force_admin_only', 'Only an admin may erase a device whose backup failed.');
    if (forceErase.some((k) => !devices.some((d) => d.key === k))) throw httpError(400, 'jobs.unknown_device', 'One of these devices is not on this bench.');
    const base = req.body?.applyBase === false ? null : await library.base();
    start(req, res, {
      kind: 'reset', bench, devices, secrets: secretsOf(req.body), countdown: true,
      options: { forceErase, base, save: req.body?.save !== false, label: 'reset' },
    });
  });

  router.post('/benches/:bench/preview', json, async (req, res) => {
    const bench = benchName(req.params.bench);
    const p = await plan(req.user, bench, req.body);
    res.json({
      source: { kind: p.src.kind, id: p.src.id, name: p.src.name },
      rsaModulus: p.rsaModulus,
      devices: p.devices.filter((d) => p.plans.has(d.key)).map((d) => {
        const x = p.plans.get(d.key);
        const dropped = x.dropped.map((r) => ({ ...r, code: droppedCode(r.reason) }));
        return { key: d.key, name: d.name, shared: d.shared, from: x.from, script: x.script, sha256: x.sha256, lines: x.script.split('\n').length - 1, dropped, vlans: x.vlans };
      }),
      missing: p.missing,
    });
  });

  router.post('/benches/:bench/inject', json, async (req, res) => {
    const bench = benchName(req.params.bench);
    refuse(perms.refusal(req.user, bench));
    const mode = req.body?.mode ?? 'reset';
    if (!['reset', 'merge'].includes(mode)) throw httpError(400, 'jobs.bad_mode', 'The mode is "reset" (then inject) or "merge".');
    if (mode === 'reset' && req.body?.confirm !== bench) throw httpError(400, 'jobs.confirm_bench', 'Type the name of the bench to confirm: its devices are erased first.', { bench });
    const p = await plan(req.user, bench, req.body);
    refuse(access.sharedConflict(req.user, bench, p.devices));
    if (p.missing.length) throw httpError(400, 'jobs.not_in_source', 'Some devices have no configuration in this source.', { devices: p.missing.map((m) => m.name).join(', ') });
    const seen = req.body?.scripts && typeof req.body.scripts === 'object' ? req.body.scripts : {};
    const stale = p.devices.filter((d) => seen[d.key] !== p.plans.get(d.key).sha256);
    if (stale.length) throw httpError(409, 'jobs.preview_stale', 'Look at the preview again: what would be sent is not what you saw.', { devices: stale.map((d) => d.name).join(', ') });
    start(req, res, {
      kind: 'inject', bench, devices: p.devices, secrets: secretsOf(req.body),
      options: { mode, save: req.body?.save !== false, plans: p.plans, rsaModulus: p.rsaModulus, source: { kind: p.src.kind, id: p.src.id, name: p.src.name }, label: `inject ${p.src.name}`.slice(0, 80) },
    });
  });

  router.post('/benches/:bench/compare', json, async (req, res) => {
    const bench = benchName(req.params.bench);
    refuse(perms.refusal(req.user, bench));
    const set = await library.snapshot(req.user, String(req.body?.snapshot ?? ''));
    start(req, res, { kind: 'compare', bench, devices: pick(bench, req.body?.devices), secrets: secretsOf(req.body), options: { compareWith: set } });
  });

  // The TP folder: the configurations of a snapshot and the console journals of its day
  router.get('/benches/:bench/folder', async (req, res) => {
    const bench = benchName(req.params.bench);
    const set = await library.snapshot(req.user, String(req.query.snapshot ?? ''));
    if (set.bench !== bench) throw httpError(400, 'jobs.other_bench', 'This snapshot is of another bench.');
    const day = dayOf(Date.parse(set.createdAt));
    const root = `TP-${store.safeName(bench)}-${day}`;
    const entries = {};
    for (const row of set.devices) {
      const d = await library.readDevice(set, row.device);
      entries[`${root}/configurations/${row.file}`] = d.config;
      if (row.vlanFile) entries[`${root}/configurations/${row.vlanFile}`] = vlanText(d.vlans ?? []);
      if (row.startupFile) {
        const startup = await library.readStartup(set, row).catch(() => null);
        if (startup) entries[`${root}/configurations/${row.startupFile}`] = startup.text;
      }
    }
    const read = await addJournals(entries, { user: req.user, bench, day, root });
    entries[`${root}/README.txt`] = `Lab Console - ${bench} - ${day}\nSnapshot ${set.id}${set.label ? ` (${set.label})` : ''}, ${set.createdAt}\n`
      + `configurations/: one running-config per device (and its startup-config when it was another)\njournals/: what the consoles printed that day (${read.length} sessions)\n`;
    audit.log(req, 'job.folder.download', { bench, snapshot: set.id, journals: read.length });
    sendZip(res, makeZip(entries), `${root}.zip`);
  });

  /** The console journals of `bench` on `day` this user may read, added to the ZIP's entries; → what was read */
  async function addJournals(entries, { user, bench, day, root }) {
    const journal = services.consoles?.journal;
    const read = [];
    if (!journal) return read;
    const teamOfUser = (u) => access.teamOf(u)?.id ?? null;
    const days = (await journal.list()).filter((j) => j.bench === bench && j.day === day);
    for (const j of days) {
      if (!journal.canReadDay(user, journal.dayMetas(j.benchDir, j.deviceDir, j.day), teamOfUser)) continue;
      const { log: file } = journal.paths(j.benchDir, j.deviceDir, j.day, j.session);
      try {
        entries[`${root}/journals/${j.deviceDir}/${j.day}-${j.session}.log`] = new Uint8Array(await fs.promises.readFile(file));
        read.push(`${j.device} ${j.session}`);
      } catch { /* swept meanwhile */ }
    }
    return read;
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  async function jobOf(user, id) {
    if (typeof id !== 'string' || !JOB_ID.test(id)) throw httpError(404, 'jobs.no_job', 'There is no such job.');
    const job = runner.get(id) ?? await repos.jobs.get(id);
    if (!job) throw httpError(404, 'jobs.no_job', 'There is no such job.');
    const view = perms.jobFor(user, job);
    if (!view) throw httpError(403, 'jobs.job_forbidden', 'This job belongs to another team.');
    return { job, view };
  }

  router.get('/runs', async (req, res) => {
    const bench = req.query.bench === undefined ? undefined : benchName(String(req.query.bench));
    const stored = await repos.jobs.list({ bench, limit: 50 });
    const live = new Map(runner.recent(bench).map((j) => [j.id, j]));
    const all = [...live.values(), ...stored.filter((j) => !live.has(j.id))].map((j) => perms.jobFor(req.user, j)).filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
    res.json({ jobs: all.map((j) => ({ ...j, devices: j.devices.map(({ lastOutput: _output, ...d }) => d) })) });
  });

  router.get('/runs/:id', async (req, res) => {
    const { view } = await jobOf(req.user, req.params.id);
    res.json({ job: view });
  });

  router.post('/runs/:id/cancel', async (req, res) => {
    const { job } = await jobOf(req.user, req.params.id);
    const live = runner.get(job.id);
    if (!live || !['pending', 'running'].includes(live.state)) throw httpError(409, 'jobs.not_running', 'This job is over.');
    if (!perms.mayCancel(req.user, live)) {
      throw httpError(403, 'jobs.cancel_forbidden', 'Only the person who started the job, the occupants of the bench and admins may stop it.');
    }
    runner.cancel(live, req.user);
    res.json({ job: perms.jobFor(req.user, live, { live: true }) });
  });

  return router;
}
