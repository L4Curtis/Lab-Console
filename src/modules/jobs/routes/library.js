/**
 * /api/jobs: snapshots (list, search, read, ZIP, diff, import, delete) and
 * TP templates (everyone reads, admins write). Who sees a snapshot is the
 * library's rule (../library.js)
 */
import express from 'express';
import { jsonBody, rawBody } from '../../../lib/bodies.js';
import { httpError } from '../../../lib/httpError.js';
import { noStore } from '../../../lib/security.js';
import { templateView } from '../library.js';
import { labelOf, sendZip } from '../input.js';

export function libraryRoutes({ store, audit, access, library, importMaxKb }) {
  const router = express.Router();
  router.use(noStore);
  const json = jsonBody('64kb');
  const bigJson = jsonBody('2mb');
  const zipBody = rawBody(`${importMaxKb}kb`);
  const zipOf = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

  // ── Snapshots ─────────────────────────────────────────────────────────────

  router.get('/snapshots', async (req, res) => {
    const bench = req.query.bench === undefined ? undefined : access.benchOf(String(req.query.bench)).name;
    res.json({ snapshots: (await library.listSnapshots(req.user, { bench })).map((s) => library.view(s)) });
  });

  router.get('/snapshots/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2 || q.length > 100) throw httpError(400, 'jobs.bad_search', 'Search for 2 to 100 characters.');
    res.json(await library.search(req.user, q));
  });

  router.post('/snapshots/import', zipBody, async (req, res) => {
    const bench = access.benchOf(String(req.query.bench ?? '')).name;
    const { snapshot, ignored } = await library.importZip(req.user, bench, zipOf(req), {
      label: labelOf(req.query.label), devices: access.taskDevices(bench).map((d) => d.name), maxBytes: importMaxKb * 1024,
    });
    res.status(201).json({ snapshot: library.view(snapshot), ignored });
  });

  router.get('/snapshots/:id', async (req, res) => {
    res.json({ snapshot: library.view(await library.snapshot(req.user, req.params.id)) });
  });

  router.get('/snapshots/:id/devices/:device', async (req, res) => {
    const set = await library.snapshot(req.user, req.params.id);
    const d = await library.readDevice(set, req.params.device);
    if (!d) throw httpError(404, 'jobs.no_device', 'This device is not in the snapshot.');
    const startup = await library.readStartup(set, d.row).catch(() => null);
    res.json({ device: d.row.device, config: d.config, vlans: d.vlans, facts: d.facts, intact: d.intact, sha256: d.row.sha256, startup: startup?.text ?? null });
  });

  router.get('/snapshots/:id/zip', async (req, res) => {
    const set = await library.snapshot(req.user, req.params.id);
    const root = `${store.safeName(set.bench)}-${set.id}`;
    audit.log(req, 'job.snapshot.download', { bench: set.bench, snapshot: set.id });
    sendZip(res, await library.files.zip(set.dir, root), `${root}.zip`);
  });

  router.get('/snapshots/:a/diff/:b', async (req, res) => {
    const a = await library.snapshot(req.user, req.params.a);
    const b = await library.snapshot(req.user, req.params.b);
    const device = typeof req.query.device === 'string' ? req.query.device : undefined;
    res.json({ a: library.view(a), b: library.view(b), devices: await library.diff(a, b, { device }) });
  });

  router.delete('/snapshots/:id', async (req, res) => {
    await library.removeSnapshot(req.user, req.params.id);
    res.json({ ok: true });
  });

  // ── Templates: everyone reads, admins write ───────────────────────────────

  router.get('/templates', async (_req, res) => {
    res.json({ templates: (await library.templates()).map(templateView) });
  });

  router.get('/templates/:id', async (req, res) => {
    res.json({ template: templateView(await library.template(req.params.id)) });
  });

  router.get('/templates/:id/devices/:device', async (req, res) => {
    const t = await library.template(req.params.id);
    const d = await library.readDevice(t, req.params.device);
    if (!d) throw httpError(404, 'jobs.no_device', 'This device is not in the template.');
    res.json({ device: d.row.device, config: d.config, vlans: d.vlans, facts: d.facts, intact: d.intact });
  });

  const adminOnly = (req) => {
    if (!access.isAdmin(req.user)) throw httpError(403, 'auth.forbidden', 'Only admins publish templates.', { role: 'admin' });
  };

  router.post('/templates', bigJson, async (req, res) => {
    adminOnly(req);
    const { name, description, snapshot, devices, configs, base } = req.body ?? {};
    let entries;
    let from = null;
    if (snapshot !== undefined) {
      const set = await library.snapshot(req.user, String(snapshot));
      entries = await library.snapshotEntries(set, Array.isArray(devices) ? devices.filter((d) => typeof d === 'string') : null);
      from = set.id;
    } else {
      entries = library.typedEntries(configs);
    }
    let t = await library.publishTemplate(req.user, { name, description, entries, source: from });
    if (base === true) t = await library.updateTemplate(req.user, t.id, { base: true });
    res.status(201).json({ template: templateView(t) });
  });

  router.post('/templates/import', zipBody, async (req, res) => {
    adminOnly(req);
    const entries = library.zipEntries(zipOf(req), importMaxKb * 1024);
    const t = await library.publishTemplate(req.user, { name: req.query.name, description: typeof req.query.description === 'string' ? req.query.description : '', entries, source: 'import' });
    res.status(201).json({ template: templateView(t) });
  });

  router.put('/templates/:id', json, async (req, res) => {
    adminOnly(req);
    const { name, description, base } = req.body ?? {};
    if (base !== undefined && typeof base !== 'boolean') throw httpError(400, 'jobs.bad_template', 'base is true or false.');
    res.json({ template: templateView(await library.updateTemplate(req.user, req.params.id, { name, description, base })) });
  });

  router.delete('/templates/:id', async (req, res) => {
    adminOnly(req);
    await library.removeTemplate(req.user, req.params.id);
    res.json({ ok: true });
  });

  return router;
}
