/**
 * Snapshots and TP templates: who sees what, and what can be done with them
 * (SPEC "Lot jobs")
 *
 * A snapshot is a set of configurations of one bench, owned by the team that
 * held the bench when it was taken (or imported). Its members and the admins
 * see it; nobody else, not even the guests of the bench. A snapshot with no
 * team (an admin's backup of a free bench) is for admins. A TP template is a
 * set published by an admin, that anyone may preview and inject on a bench
 * they work on; one template may be marked as the base configuration, applied
 * after a reset.
 *
 *   library.canSee(user, snapshot)
 *   library.listSnapshots(user, { bench })        → visible snapshots, newest first
 *   library.snapshot(user, id)                    → the snapshot, or 404 / 403
 *   library.open({ bench, teamId, label, origin, jobId, author })   a new snapshot a job fills
 *   library.add(set, { device, config, vlans, vtp, facts })        → its index row
 *   library.readDevice(set, name) / library.verify(set, row, config, { startup })
 *   library.importZip(user, bench, buffer, { label, devices })   → snapshot
 *   library.diff(a, b, { device })                → [{ device, status, patch, added, removed }]
 *   library.search(user, text)                    → [{ snapshot, bench, device, line, text }]
 *   library.templates() / template(id) / publishTemplate(...) / updateTemplate(...) / removeTemplate(...)
 *   library.base()                                → the base configuration template, or null
 */
import { createTwoFilesPatch, diffLines } from 'diff';
import { comparableConfig } from '../../lib/drivers/ciscoIos.js';
import { httpError } from '../../lib/httpError.js';
import {
  ConfigFiles, ConfigError, ANY_DEVICE, MANIFEST, newSetId, isSetId, readZip, checkConfigText, cleanVlans, cleanVtp, factsOf,
} from './configFiles.js';

const SEARCH_HITS = 200;
const DEVICE_NAME = /^(?!.*\.\.)\w[\w.\-/ ]{0,63}$/;

const personOf = (u) => ({ id: u?.id ?? 'system', username: u?.username ?? '', name: u?.name || u?.username || u?.id || '' });
const isAdmin = (u) => u?.role === 'admin';
const rethrow = (err) => {
  if (err instanceof ConfigError) throw httpError(err.status, err.code, err.message, err.params);
  throw err;
};

/** What a browser gets of a snapshot: no paths */
export function snapshotView(s, { teamName = null } = {}) {
  return {
    id: s.id,
    bench: s.bench,
    teamId: s.teamId,
    teamName,
    label: s.label,
    origin: s.origin,
    jobId: s.jobId,
    author: { name: s.author?.name ?? '', username: s.author?.username ?? '' },
    createdAt: s.createdAt,
    bytes: s.bytes,
    devices: s.devices.map((d) => ({ device: d.device, bytes: d.bytes, sha256: d.sha256, vlans: Boolean(d.vlanFile), startup: Boolean(d.startupFile), facts: d.facts })),
  };
}

export function templateView(t) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    base: t.base,
    author: { name: t.author?.name ?? '', username: t.author?.username ?? '' },
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    devices: t.devices.map((d) => ({ device: d.device, bytes: d.bytes, sha256: d.sha256, vlans: Boolean(d.vlanFile), facts: d.facts })),
  };
}

export class Library {
  #repos;
  #services;
  #audit;
  #now;

  constructor({ store, repos, services, audit, now = () => Date.now() }) {
    this.files = new ConfigFiles({ store });
    this.store = store;
    this.#repos = repos;
    this.#services = services;
    this.#audit = audit;
    this.#now = now;
  }

  // ── Who sees what ─────────────────────────────────────────────────────────

  /** The team's members and the admins */
  canSee(user, set) {
    if (!user?.id) return false;
    if (isAdmin(user)) return true;
    if (!set?.teamId) return false;
    return Boolean(this.#services.teams?.get?.(set.teamId)?.members?.includes(user.id));
  }

  teamName(teamId) {
    return teamId ? this.#services.teams?.get?.(teamId)?.name ?? null : null;
  }

  view(s) {
    return snapshotView(s, { teamName: this.teamName(s.teamId) });
  }

  async listSnapshots(user, { bench } = {}) {
    const all = await this.#repos.snapshots.list(bench === undefined ? {} : { bench });
    return all.filter((s) => this.canSee(user, s));
  }

  /** The snapshot `id` as `user` may see it: 404 when unknown, 403 when it is another team's */
  async snapshot(user, id) {
    if (!isSetId(id)) throw httpError(404, 'jobs.no_snapshot', 'There is no such snapshot.');
    const s = await this.#repos.snapshots.get(id);
    if (!s) throw httpError(404, 'jobs.no_snapshot', 'There is no such snapshot.');
    if (!this.canSee(user, s)) throw httpError(403, 'jobs.snapshot_forbidden', 'This snapshot belongs to another team.');
    return s;
  }

  // ── Writing a snapshot ────────────────────────────────────────────────────

  /** A new, empty snapshot (index row and folder); a job adds its devices as they come */
  async open({ bench, teamId = null, label = '', origin, jobId = null, author }) {
    const createdAt = this.#now();
    const id = newSetId(origin, createdAt);
    const dir = this.files.snapshotDir(bench, id);
    const set = { id, bench, teamId, label, origin, jobId, author: personOf(author), dir, createdAt: new Date(createdAt).toISOString(), bytes: 0, devices: [] };
    await this.files.create(dir, { id, bench, label, origin, createdAt: set.createdAt, author: set.author, team: teamId ? { id: teamId, name: this.teamName(teamId) } : null });
    await this.#repos.snapshots.insert(set);
    return set;
  }

  /** One device into an open snapshot: files first, then the index */
  async add(set, data) {
    const row = await this.files.addDevice(set.dir, data);
    set.devices.push(row);
    set.bytes += row.bytes;
    await this.#repos.snapshots.addDevice(set.id, row, set.bytes);
    return row;
  }

  close(set) {
    this.files.close(set.dir);
  }

  /** A device of a set (snapshot or template) by name; templates fall back to their '*' entry */
  async readDevice(set, name, { fallback = false } = {}) {
    const row = set.devices.find((d) => d.device === name) ?? (fallback ? set.devices.find((d) => d.device === ANY_DEVICE) : null);
    if (!row) return null;
    return { row, ...(await this.files.readDevice(set, row)) };
  }

  verify(set, row, config, options) {
    return this.files.verify(set, row, config, options);
  }

  /** A device's startup-config kept in a snapshot, or null */
  readStartup(set, row) {
    return this.files.readStartup(set, row);
  }

  async removeSnapshot(user, id) {
    const s = await this.snapshot(user, id);
    await this.#repos.snapshots.remove(s.id);
    await this.files.remove(s.dir);
    this.#audit.log(user, 'job.snapshot.delete', { bench: s.bench, snapshot: s.id });
  }

  // ── ZIP import ────────────────────────────────────────────────────────────

  /**
   * A ZIP of configurations → a new snapshot of `bench`, owned by the
   * importer's team (an admin without a team: admins only). Files are matched
   * to the bench's devices by name (`R1.cfg`, or the names a manifest gives);
   * anything else in the archive is listed as ignored, never written
   */
  async importZip(user, bench, buffer, { label = '', devices, maxBytes }) {
    const team = this.#services.teams?.teamOf?.(user) ?? null;
    if (!team && !isAdmin(user)) throw httpError(409, 'jobs.no_team', 'You need a team to keep snapshots.');
    let entries;
    try { entries = readZip(buffer, { maxTotal: maxBytes * 8 }); } catch (err) { rethrow(err); }
    const { found, ignored } = this.#match(entries, devices, { strict: true });
    if (!found.length) throw httpError(400, 'jobs.zip_empty', 'No configuration of this bench\'s devices was found in the archive.', { ignored: ignored.slice(0, 20).join(', ') });
    const set = await this.open({ bench, teamId: team?.id ?? null, label: label || 'import', origin: 'import', author: user });
    try {
      for (const d of found) await this.add(set, d);
    } finally {
      this.close(set);
    }
    this.#audit.log(user, 'job.snapshot.import', { bench, snapshot: set.id, device: found.map((d) => d.device).join(', ') });
    return { snapshot: set, ignored };
  }

  /**
   * Entries of an archive → [{ device, config, vlans, vtp, facts }] for the
   * device names allowed (`devices`: a list, or null for any well-formed name).
   * A manifest (ours) gives real names, VLANs and VTP; otherwise `<name>.cfg`
   */
  #match(entries, devices, { strict }) {
    let manifest = null;
    if (entries.has(MANIFEST)) {
      try { manifest = JSON.parse(entries.get(MANIFEST)); } catch { manifest = null; }
    }
    const allowed = (name) => typeof name === 'string' && DEVICE_NAME.test(name) || name === ANY_DEVICE;
    const known = (name) => (devices ? devices.includes(name) : allowed(name));
    const found = [];
    const ignored = [];
    const used = new Set();
    const take = (name, file, extra = {}) => {
      if (used.has(name)) return;
      const config = entries.get(file);
      const problem = checkConfigText(config, { strict: strict && name !== ANY_DEVICE });
      if (problem) { ignored.push(`${file} (${problem})`); return; }
      used.add(name);
      const vlanFile = file.replace(/\.cfg$/, '.vlan.txt');
      const vlans = cleanVlans(extra.vlans) ?? (entries.has(vlanFile) ? cleanVlans(parseVlanList(entries.get(vlanFile))) : null);
      found.push({ device: name, config: config.replace(/\r\n?/g, '\n'), vlans, vtp: cleanVtp(extra.vtp), facts: factsOf(extra.facts ?? {}) });
    };
    if (Array.isArray(manifest?.devices)) {
      for (const d of manifest.devices.slice(0, 200)) {
        if (!d || typeof d.file !== 'string' || !entries.has(d.file) || !/\.cfg$/.test(d.file)) continue;
        if (!known(d.device)) { ignored.push(String(d.file)); continue; }
        take(d.device, d.file, d);
      }
    }
    for (const file of entries.keys()) {
      if (file === MANIFEST || /\.vlan\.txt$/.test(file) || /\.startup\.cfg$/.test(file)) continue;
      const name = file === '_any.cfg' ? ANY_DEVICE : file.replace(/\.cfg$/, '');
      if (!/\.cfg$/.test(file) || !known(name)) { if (!found.some((f) => f.device === name)) ignored.push(file); continue; }
      take(name, file);
    }
    return { found, ignored };
  }

  // ── Comparing and searching ───────────────────────────────────────────────

  /**
   * Two sets device by device, on what a replay reproduces (comparableConfig:
   * no header, no volatile lines), VLANs included
   * → [{ device, status: 'same' | 'changed' | 'only-a' | 'only-b', patch, added, removed }]
   */
  async diff(a, b, { device } = {}) {
    const names = [...new Set([...a.devices, ...b.devices].map((d) => d.device))].filter((n) => !device || n === device).sort();
    const out = [];
    for (const name of names) {
      const x = await this.readDevice(a, name);
      const y = await this.readDevice(b, name);
      if (!x || !y) { out.push({ device: name, status: x ? 'only-a' : 'only-b', patch: '', added: 0, removed: 0 }); continue; }
      out.push({ device: name, ...compareConfigs(comparable(x), comparable(y), { from: `${a.id}/${name}`, to: `${b.id}/${name}` }) });
    }
    return out;
  }

  /** `text` (plain, not a pattern) in the configurations of the snapshots `user` sees */
  async search(user, text) {
    const needle = String(text).toLowerCase();
    const hits = [];
    for (const s of await this.listSnapshots(user)) {
      for (const row of s.devices) {
        let config;
        try { ({ config } = await this.files.readDevice(s, row)); } catch { continue; }
        const lines = config.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          hits.push({ snapshot: s.id, bench: s.bench, label: s.label, createdAt: s.createdAt, device: row.device, line: i + 1, text: lines[i].slice(0, 200) });
          if (hits.length >= SEARCH_HITS) return { hits, truncated: true };
        }
      }
    }
    return { hits, truncated: false };
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  templates() {
    return this.#repos.templates.list();
  }

  async template(id) {
    if (!isSetId(id)) throw httpError(404, 'jobs.no_template', 'There is no such template.');
    const t = await this.#repos.templates.get(id);
    if (!t) throw httpError(404, 'jobs.no_template', 'There is no such template.');
    return t;
  }

  async base() {
    return (await this.#repos.templates.list()).find((t) => t.base) ?? null;
  }

  /**
   * A new template, from configurations typed or taken from a snapshot:
   * `entries` = [{ device, config, vlans?, vtp?, facts? }] (device '*' = every device)
   */
  async publishTemplate(user, { name, description = '', entries, source }) {
    const clean = String(name ?? '').trim();
    if (!clean || clean.length > 80) throw httpError(400, 'jobs.bad_template', 'A template needs a name (80 characters at most).');
    if ((await this.#repos.templates.list()).some((t) => t.name.toLowerCase() === clean.toLowerCase())) {
      throw httpError(409, 'jobs.template_exists', 'A template already has this name.', { name: clean });
    }
    if (!entries.length) throw httpError(400, 'jobs.bad_template', 'A template needs at least one configuration.');
    const createdAt = this.#now();
    const id = newSetId('template', createdAt);
    const dir = this.files.templateDir(id);
    const author = personOf(user);
    await this.files.create(dir, { id, name: clean, description: String(description).slice(0, 500), createdAt: new Date(createdAt).toISOString(), author, source: source ?? null });
    const rows = [];
    try {
      for (const e of entries) rows.push(await this.files.addDevice(dir, e));
    } finally {
      this.files.close(dir);
    }
    const t = { id, name: clean, description: String(description).slice(0, 500), dir, author, createdAt, updatedAt: createdAt, devices: rows };
    await this.#repos.templates.insert(t);
    this.#audit.log(user, 'job.template.publish', { template: id, name: clean, source: source ?? null });
    return this.template(id);
  }

  /** Configurations typed in the page → template entries (checked like an import) */
  typedEntries(configs) {
    if (!configs || typeof configs !== 'object' || Array.isArray(configs)) throw httpError(400, 'jobs.bad_template', 'Configurations are expected per device.');
    const out = [];
    for (const [device, text] of Object.entries(configs).slice(0, 50)) {
      if (!(DEVICE_NAME.test(device) || device === ANY_DEVICE)) throw httpError(400, 'jobs.bad_device_name', 'A device name may hold letters, digits, spaces and . - _ / only.', { name: device.slice(0, 64) });
      const problem = checkConfigText(text, { strict: false });
      if (problem) throw httpError(400, `jobs.config_${problem}`, 'This configuration cannot be used.', { device });
      out.push({ device, config: String(text).replace(/\r\n?/g, '\n').replace(/\n?$/, '\n') });
    }
    return out;
  }

  /** A template's entries from a ZIP (any device name, '*' as _any.cfg) */
  zipEntries(buffer, maxBytes) {
    let entries;
    try { entries = readZip(buffer, { maxTotal: maxBytes * 8 }); } catch (err) { rethrow(err); }
    const { found, ignored } = this.#match(entries, null, { strict: false });
    if (!found.length) throw httpError(400, 'jobs.zip_empty', 'No configuration was found in the archive.', { ignored: ignored.slice(0, 20).join(', ') });
    return found;
  }

  /** A snapshot's devices → template entries (VLANs and VTP kept) */
  async snapshotEntries(set, devices) {
    const out = [];
    for (const row of set.devices) {
      if (devices && !devices.includes(row.device)) continue;
      const d = await this.readDevice(set, row.device);
      out.push({ device: row.device, config: d.config, vlans: d.vlans, vtp: d.vtp, facts: d.facts });
    }
    return out;
  }

  async updateTemplate(user, id, { name, description, base }) {
    const t = await this.template(id);
    if (name !== undefined || description !== undefined) {
      const clean = name === undefined ? t.name : String(name).trim();
      if (!clean || clean.length > 80) throw httpError(400, 'jobs.bad_template', 'A template needs a name (80 characters at most).');
      if ((await this.#repos.templates.list()).some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) {
        throw httpError(409, 'jobs.template_exists', 'A template already has this name.', { name: clean });
      }
      await this.#repos.templates.update(id, { name: clean, description: description === undefined ? t.description : String(description).slice(0, 500), updatedAt: this.#now() });
    }
    if (base === true) await this.#repos.templates.setBase(id);
    if (base === false && t.base) await this.#repos.templates.setBase(null);
    this.#audit.log(user, 'job.template.update', { template: id, name: name ?? t.name, base: base ?? null });
    return this.template(id);
  }

  async removeTemplate(user, id) {
    const t = await this.template(id);
    await this.#repos.templates.remove(id);
    await this.files.remove(t.dir);
    this.#audit.log(user, 'job.template.delete', { template: id, name: t.name });
  }
}

/** A device's configuration and VLANs as lines a replay reproduces */
export function comparable({ config, vlans }) {
  const v = Array.isArray(vlans) && vlans.length
    ? `${vlans.filter((x) => x.id !== 1 && !(x.id >= 1002 && x.id <= 1005)).map((x) => `vlan ${x.id} ${x.name} ${x.status}`).join('\n')}\n`
    : '';
  return comparableConfig(config) + v;
}

/** Two comparable texts → { status, patch, added, removed } */
export function compareConfigs(a, b, { from = 'a', to = 'b' } = {}) {
  if (a === b) return { status: 'same', patch: '', added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const part of diffLines(a, b)) {
    if (part.added) added += part.count;
    if (part.removed) removed += part.count;
  }
  return { status: 'changed', patch: createTwoFilesPatch(from, to, a, b, '', '', { context: 3 }), added, removed };
}

/** `show vlan brief` text → VLANs (parseVlanBrief, kept apart so that a ZIP's file is read the same way) */
function parseVlanList(text) {
  return text.split('\n').map((l) => l.match(/^(\d{1,4})\s+(\S+)\s+(\S+)\s*(.*)$/)).filter(Boolean)
    .map((m) => ({ id: Number(m[1]), name: m[2], status: m[3], ports: m[4].split(',').map((p) => p.trim()).filter(Boolean) }));
}
