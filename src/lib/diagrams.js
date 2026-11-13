/**
 * The lab diagram: which file is active, the versions kept, and the checks a
 * new one must pass (ARCHITECTURE §6, "diagrams"; SPEC, lot admin)
 *
 * The active diagram lives in the data directory, data/diagrams/current.drawio,
 * so that an administrator can replace it from the administration pages on a
 * read-only image. On the first start it is seeded from DIAGRAM_PATH (the file
 * shipped with the image), which becomes the first version. Every imported
 * file is kept as a version (data/diagrams/versions/<id>.drawio, described in
 * data/diagrams/index.json); importing does not change anything a student
 * sees: an administrator previews it, compares it with the active one, then
 * activates it. Each activation is remembered, so a rollback goes back to the
 * diagram that was active before, in one click.
 *
 *   diagrams.currentPath                 the file the consoles registry reads (and watches)
 *   diagrams.list()                      → { active, canRollback, versions: [...] } newest first
 *   diagrams.inspect(buffer)             → { labs, warnings, devices } or throws a 4xx (see below)
 *   diagrams.add(buffer, { name, actor }) → the new version (not active yet)
 *   diagrams.model(id)                   → the parsed labs of a version (preview)
 *   diagrams.compare(id)                 → what changes against the active one
 *   diagrams.activate(id, actor) / diagrams.rollback(actor)
 *   diagrams.fileOf(id)                  → absolute path of a version (download)
 *   diagrams.on('change', fn)            after an activation; the registry reloads
 *
 * A file is refused (400, code admin.diagram_*) when it is over 5 MB, when it
 * declares a DOCTYPE or entities (anywhere, compressed pages included: the
 * XML parser must never expand anything), when the parser rejects it, or when
 * it has no console device at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseDrawio } from '../modules/consoles/drawio.js';
import { httpError } from './httpError.js';
import { safeName } from './store.js';

export const MAX_DIAGRAM_BYTES = 5 * 1024 * 1024;
const MAX_VERSIONS = 30;
const ID = /^[0-9TZ-]{20,30}-[A-Za-z0-9._-]{1,40}-[0-9a-f]{6}$/;
const FORBIDDEN = /<!\s*(DOCTYPE|ENTITY)/i;

/** The text of every page, compressed ones decoded, so that nothing hides a DOCTYPE */
function pagesOf(text) {
  const out = [text];
  for (const m of text.matchAll(/<diagram\b[^>]*>([^<]+)<\/diagram>/g)) {
    const payload = m[1].trim();
    if (!payload) continue;
    try {
      out.push(decodeURIComponent(zlib.inflateRawSync(Buffer.from(payload, 'base64')).toString('utf8')));
    } catch {
      // parseDrawio says which page cannot be decoded
    }
  }
  return out;
}

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
export function inspectDiagram(buffer, { networkPrefix = '10.22.9' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'admin.diagram_empty_file', 'The file is empty');
  if (buffer.length > MAX_DIAGRAM_BYTES) throw httpError(413, 'admin.diagram_too_large', 'The diagram is over 5 MB', { max: MAX_DIAGRAM_BYTES });
  const text = buffer.toString('utf8');
  if (pagesOf(text).some((page) => FORBIDDEN.test(page))) {
    throw httpError(400, 'admin.diagram_doctype', 'A diagram may not declare a DOCTYPE or entities');
  }
  let parsed;
  try {
    parsed = parseDrawio(text, { networkPrefix });
  } catch (err) {
    throw httpError(400, 'admin.diagram_invalid', `Not a draw.io diagram: ${err.message}`, { detail: err.message.slice(0, 200) });
  }
  const devices = parsed.labs.reduce((n, l) => n + l.devices.length, 0);
  if (!parsed.labs.length || !devices) throw httpError(400, 'admin.diagram_no_device', 'This diagram has no console device');
  return { labs: parsed.labs, warnings: parsed.warnings, devices };
}

export function createDiagrams({ config, store, logger }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const emitter = new EventEmitter();
  const prefix = () => config.consoles?.networkPrefix ?? '10.22.9';
  const dir = store.dir('diagrams');
  const versionsDir = store.dir('diagrams', 'versions');
  const currentPath = path.join(dir, 'current.drawio');
  const indexPath = path.join(dir, 'index.json');

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
      writeSync(indexPath, JSON.stringify({
        active: id,
        history: [{ id, at, by: 'system' }],
        versions: [{ id, name: path.basename(config.diagramPath), size: data.length, sha256: sha(data), at, by: { id: 'system', username: 'system' }, source: 'environment', ...summary }],
      }, null, 2));
      log.info(`active diagram seeded from ${config.diagramPath}`);
    } catch (err) {
      log.error(`no active diagram: ${config.diagramPath} could not be read (${err.message})`);
    }
  }

  // Written above before anyone reads it: from here on, one serialized handle
  const index = store.json('diagrams/index.json', { active: null, history: [], versions: [] });

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
    const inspected = inspectDiagram(buffer, { networkPrefix: prefix() });
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
    return { version, warnings: inspected.warnings };
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
