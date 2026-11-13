/**
 * The lab diagram: which file is active, the versions kept, and the checks a
 * new one must pass (ARCHITECTURE §6, "diagrams"; SPEC, lot admin)
 *
 * The active diagram lives in the data directory, data/diagrams/current.drawio,
 * so that an administrator can replace it from the administration pages on a
 * read-only image. On the first start it is seeded from DIAGRAM_PATH (the file
 * shipped with the image), which becomes the first version. Every imported
 * file is kept as a version (data/diagrams/versions/<id>.drawio, described in
 * the database: tables diagram_versions and diagram_activations, through
 * repos.diagrams); importing does not change anything a student
 * sees: an administrator previews it, compares it with the active one, then
 * activates it. Each activation is remembered, so a rollback goes back to the
 * diagram that was active before, in one click.
 *
 *   diagrams.currentPath                 the file the consoles registry reads (and watches)
 *   diagrams.list()                      → { active, canRollback, versions: [...] } newest first
 *   diagrams.inspect(buffer)             → { labs, warnings, devices } or throws a 4xx (see below)
 *   diagrams.add(buffer, { name, actor }) → { version, warnings, labs } (the new version, not active yet)
 *   diagrams.model(id)                   → the parsed labs of a version (preview)
 *   diagrams.compare(id)                 → what changes against the active one
 *   diagrams.activate(id, actor) / diagrams.rollback(actor)
 *   diagrams.fileOf(id)                  → absolute path of a version (download)
 *   diagrams.on('change', fn)            after an activation; the registry reloads
 *
 * A file is refused (400, code admin.diagram_*) when it is over 5 MB, when its
 * pages inflate to more than 4 times that, when it declares a DOCTYPE or
 * entities (anywhere, compressed pages included: the check is made by the
 * parser itself, on every document it builds, so no way of writing a page
 * hides one), when the parser rejects it, or when it has no console device at
 * all. An import or an activation is also refused while the linter finds two
 * different devices on one console line (what `npm run check-diagram` fails
 * on): admin.diagram_lint. Rolling back is never refused for that: it goes
 * back to what was active.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseDrawio, DrawioRefusal } from '../modules/consoles/drawio.js';
import { httpError } from './httpError.js';
import { safeName } from './store.js';
import { createCachedDocument } from './cachedDocument.js';

export const MAX_DIAGRAM_BYTES = 5 * 1024 * 1024;
/** What the pages of one file may inflate to, in all */
export const MAX_INFLATED_BYTES = 4 * MAX_DIAGRAM_BYTES;
const MAX_VERSIONS = 30;
const ID = /^[0-9TZ-]{20,30}-[A-Za-z0-9._-]{1,40}-[0-9a-f]{6}$/;
/** Warnings that make `npm run check-diagram` fail: two different devices on one console line */
const BLOCKING_WARNING = 'consoles.warn_different_devices';

/** Device keys → target, per lab, for a comparison */
function devicesOf(labs) {
  const map = new Map();
  for (const lab of labs) for (const d of lab.devices) map.set(`${lab.name}/${d.name}`, { lab: lab.name, name: d.name, target: `${d.target.host}:${d.target.port}` });
  return map;
}

/**
 * Check a candidate file; → { labs, warnings, devices }. Throws a 400 with a
 * code the page translates. `networkPrefix` is the one the registry uses
 */
export function inspectDiagram(buffer, { networkPrefix = '10.22.9', strict = false } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'admin.diagram_empty_file', 'The file is empty');
  if (buffer.length > MAX_DIAGRAM_BYTES) throw httpError(413, 'admin.diagram_too_large', 'The diagram is over 5 MB', { max: MAX_DIAGRAM_BYTES });
  let parsed;
  try {
    parsed = parseDrawio(buffer.toString('utf8'), { networkPrefix, maxInflatedBytes: MAX_INFLATED_BYTES });
  } catch (err) {
    if (err instanceof DrawioRefusal) {
      if (err.code === 'doctype') throw httpError(400, 'admin.diagram_doctype', 'A diagram may not declare a DOCTYPE or entities');
      throw httpError(413, 'admin.diagram_too_large', 'The diagram inflates to more than 20 MB', { max: MAX_DIAGRAM_BYTES });
    }
    throw httpError(400, 'admin.diagram_invalid', `Not a draw.io diagram: ${err.message}`, { detail: err.message.slice(0, 200) });
  }
  const devices = parsed.labs.reduce((n, l) => n + l.devices.length, 0);
  if (!parsed.labs.length || !devices) throw httpError(400, 'admin.diagram_no_device', 'This diagram has no console device');
  const blocking = parsed.warnings.filter((w) => w.code === BLOCKING_WARNING);
  if (strict && blocking.length) {
    throw httpError(400, 'admin.diagram_lint', `The linter found ${blocking.length} console line(s) shared by different devices`, {
      count: blocking.length,
      lines: blocking.slice(0, 5).map((w) => w.params.target).join(', '),
      problems: blocking.slice(0, 20).map(({ code, params, message }) => ({ code, params, message })),
    });
  }
  return { labs: parsed.labs, warnings: parsed.warnings, devices };
}

/**
 * deps: config, store (the files: current.drawio, versions/), repos (the
 * index: repos.diagrams), logger. Resolves once the index is read and, on
 * the very first start, the shipped diagram installed
 */
export async function createDiagrams({ config, store, repos, logger }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const emitter = new EventEmitter();
  const prefix = () => config.consoles?.networkPrefix ?? '10.22.9';
  const dir = store.dir('diagrams');
  const versionsDir = store.dir('diagrams', 'versions');
  const currentPath = path.join(dir, 'current.drawio');
  // The index (which version is which, the stack of activations) lives in the database
  const index = createCachedDocument({
    name: 'the diagram index',
    fallback: { active: null, history: [], versions: [] },
    load: () => repos.diagrams.load(),
    save: (next, prev) => repos.transaction((r) => r.diagrams.save(next, prev)),
  });
  await index.load();

  const fileOf = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    return store.resolve('diagrams', 'versions', `${id}.drawio`);
  };
  const newId = (actor) => {
    const who = safeName(actor?.username ?? actor?.user?.username ?? 'system').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'system';
    return `${new Date().toISOString().replace(/[:.]/g, '-')}-${who}-${crypto.randomBytes(3).toString('hex')}`;
  };
  const summaryOf = ({ labs, warnings, devices }) => ({ labs: labs.map((l) => l.name), devices, warnings: warnings.length });

  /** Write a file whole or not at all, synchronously (start-up only) */
  function writeSync(file, data) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ── First start: the shipped diagram becomes the active one, and version 1 ──
  if (!fs.existsSync(currentPath)) {
    try {
      const data = fs.readFileSync(config.diagramPath);
      const id = newId({ username: 'environment' });
      writeSync(path.join(versionsDir, `${id}.drawio`), data);
      writeSync(currentPath, data);
      let summary = null;
      try { summary = summaryOf(inspectDiagram(data, { networkPrefix: prefix() })); } catch { /* the registry reports it */ }
      const at = new Date().toISOString();
      await index.update((doc) => ({
        active: id,
        history: [...doc.history, { id, at, by: 'system' }],
        versions: [...doc.versions, { id, name: path.basename(config.diagramPath), size: data.length, sha256: sha(data), at, by: { id: 'system', username: 'system' }, source: 'environment', ...summary }],
      }));
      log.info(`active diagram seeded from ${config.diagramPath}`);
    } catch (err) {
      log.error(`no active diagram: ${config.diagramPath} could not be read (${err.message})`);
    }
  }

  function sha(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  function list() {
    const { active, history, versions } = index.get();
    return {
      active,
      canRollback: history.length > 1,
      previous: history.length > 1 ? history.at(-2).id : null,
      versions: [...versions].reverse().map((v) => ({ ...v, active: v.id === active })),
    };
  }

  const find = (id) => index.get().versions.find((v) => v.id === id) ?? null;
  function mustFind(id) {
    const version = fileOf(id) ? find(id) : null;
    if (!version) throw httpError(404, 'admin.diagram_unknown', 'No such diagram version', { id: String(id).slice(0, 80) });
    return version;
  }

  async function add(buffer, { name, actor } = {}) {
    const inspected = inspectDiagram(buffer, { networkPrefix: prefix(), strict: true });
    const id = newId(actor?.user ?? actor);
    const who = actor?.user ?? actor ?? {};
    await store.writeFileAtomic(fileOf(id), buffer);
    const version = {
      id,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : 'diagram.drawio',
      size: buffer.length,
      sha256: sha(buffer),
      at: new Date().toISOString(),
      by: { id: who.id ?? 'system', username: who.username ?? 'system' },
      source: 'import',
      ...summaryOf(inspected),
    };
    const dropped = [];
    await index.update((doc) => {
      doc.versions.push(version);
      // Keep the most recent ones; never the active one, nor one a rollback may need
      const keep = new Set([doc.active, ...doc.history.slice(-5).map((h) => h.id)]);
      while (doc.versions.length > MAX_VERSIONS) {
        const at = doc.versions.findIndex((v) => !keep.has(v.id));
        if (at === -1) break;
        dropped.push(doc.versions.splice(at, 1)[0].id);
      }
      doc.history = doc.history.filter((h) => !dropped.includes(h.id));
      return doc;
    });
    for (const old of dropped) await fs.promises.rm(fileOf(old), { force: true }).catch(() => {});
    return { version, warnings: inspected.warnings, labs: inspected.labs };
  }

  async function readVersion(id) {
    mustFind(id);
    return fs.promises.readFile(fileOf(id));
  }

  async function model(id) {
    return inspectDiagram(await readVersion(id), { networkPrefix: prefix() });
  }

  /** What activating `id` would change, against the active diagram */
  async function compare(id) {
    const candidate = await model(id);
    let current = { labs: [] };
    try { current = inspectDiagram(await fs.promises.readFile(currentPath), { networkPrefix: prefix() }); } catch { /* nothing active, or broken */ }
    const before = devicesOf(current.labs);
    const after = devicesOf(candidate.labs);
    const labsBefore = new Set(current.labs.map((l) => l.name));
    const labsAfter = new Set(candidate.labs.map((l) => l.name));
    return {
      labs: {
        added: [...labsAfter].filter((n) => !labsBefore.has(n)),
        removed: [...labsBefore].filter((n) => !labsAfter.has(n)),
      },
      devices: {
        added: [...after.values()].filter((d) => !before.has(`${d.lab}/${d.name}`)),
        removed: [...before.values()].filter((d) => !after.has(`${d.lab}/${d.name}`)),
        moved: [...after.values()].filter((d) => before.has(`${d.lab}/${d.name}`) && before.get(`${d.lab}/${d.name}`).target !== d.target)
          .map((d) => ({ ...d, from: before.get(`${d.lab}/${d.name}`).target })),
      },
      warnings: candidate.warnings,
      same: sha(await readVersion(id)) === (await fs.promises.readFile(currentPath).then(sha, () => null)),
    };
  }

  /** Make `id` the active file; `history`: 'push' (an activation) or 'pop' (a rollback) */
  async function install(id, history, actor) {
    const data = await readVersion(id);
    inspectDiagram(data, { networkPrefix: prefix() }); // still a valid diagram (the file was not touched)
    await store.writeFileAtomic(currentPath, data);
    const who = actor?.user ?? actor ?? {};
    await index.update((doc) => {
      doc.active = id;
      if (history === 'push') doc.history.push({ id, at: new Date().toISOString(), by: who.id ?? 'system' });
      else doc.history.pop();
      doc.history = doc.history.slice(-50);
      return doc;
    });
    log.info(`diagram ${id} is now active`);
    for (const fn of emitter.listeners('change')) {
      try { fn({ active: id }); } catch (err) { log.error(`diagram change listener failed: ${err.message}`); }
    }
    return list();
  }

  async function activate(id, actor) {
    mustFind(id);
    if (index.get().active === id) throw httpError(409, 'admin.diagram_already_active', 'This version is already the active diagram');
    inspectDiagram(await readVersion(id), { networkPrefix: prefix(), strict: true });
    return install(id, 'push', actor);
  }

  async function rollback(actor) {
    const { history } = index.get();
    if (history.length < 2) throw httpError(409, 'admin.diagram_no_previous', 'There is no previous diagram to go back to');
    const previous = history.at(-2).id;
    mustFind(previous);
    return { rolledBackTo: previous, ...(await install(previous, 'pop', actor)) };
  }

  return {
    currentPath,
    list,
    inspect: (buffer) => inspectDiagram(buffer, { networkPrefix: prefix() }),
    add,
    model,
    compare,
    activate,
    rollback,
    fileOf: (id) => (mustFind(id), fileOf(id)),
    find,
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); },
  };
}
