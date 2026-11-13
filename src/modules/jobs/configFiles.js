/**
 * The configuration files the jobs keep: snapshots and TP templates
 *
 *   data/snapshots/<bench>/<id>/manifest.json      what the set holds (devices, facts, VLANs, VTP)
 *   data/snapshots/<bench>/<id>/<device>.cfg       one running-config per device
 *   data/snapshots/<bench>/<id>/<device>.vlan.txt  its VLANs as `show vlan brief` prints them (switches)
 *   data/templates/<id>/...                        the same layout; device '*' (file _any.cfg) is for every device
 *
 * They stay files because people download and diff them; the database
 * (repos.snapshots, repos.templates) is their index, with the SHA-256 of
 * every file. `verify()` reads a device's file back and checks it against
 * that index: a reset erases a device only once its backup passed it.
 *
 * Also here: what goes into and comes out of a ZIP (download, import), with
 * the import's defences (size, number of entries, declared sizes against a
 * zip bomb, names that would leave the folder).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { writeFileAtomic } from '../../lib/store.js';
import { parseVlanBrief } from '../../lib/drivers/ciscoIos.js';

export const ANY_DEVICE = '*';
export const MANIFEST = 'manifest.json';
export const MANIFEST_FORMAT = 'lab-console-configs/1';

const MAX_CONFIG_BYTES = 512 * 1024;
const ZIP_MAX_ENTRIES = 200;
const ZIP_MAX_TOTAL = 20 * 1024 * 1024;
const VLAN_STATES = /^(active|suspended|act\/lshut|sus\/lshut|act\/ishut|sus\/ishut|act\/unsup)$/;
const SET_ID = /^\d{8}-\d{6}-[a-z]{2,12}-[0-9a-f]{6}$/;

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** An error with the code the browser translates (jobs.*) */
export class ConfigError extends Error {
  constructor(status, code, message, params = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/** A set id: when, what, and six random hex digits ('20261113-091502-backup-3fa0c1') */
export function newSetId(origin, ms = Date.now()) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${origin}-${crypto.randomBytes(3).toString('hex')}`;
}
export const isSetId = (id) => typeof id === 'string' && SET_ID.test(id);

/** `show vlan brief` as IOS prints it, from the parsed list (parseVlanBrief reads it back) */
export function vlanText(vlans) {
  const head = ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  return `${[...head, ...vlans.map((v) => `${String(v.id).padEnd(4)} ${String(v.name).padEnd(32)} ${String(v.status).padEnd(9)} ${(v.ports ?? []).join(', ')}`.trimEnd())].join('\n')}\n`;
}

/** Facts worth keeping about a device (identify()), nothing else */
export function factsOf(id = {}) {
  const s = (v, max = 80) => (typeof v === 'string' && v.length <= max ? v : null);
  return {
    hostname: s(id.hostname, 63),
    model: s(id.model),
    version: s(id.version),
    family: ['ios', 'iosxe'].includes(id.family) ? id.family : null,
    kind: ['router', 'switch'].includes(id.kind) ? id.kind : null,
    configRegister: s(id.configRegister, 12),
  };
}

/** VLANs from an untrusted manifest: [{ id, name, status, ports }] or null */
export function cleanVlans(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const v of list.slice(0, 4094)) {
    const id = Number(v?.id);
    if (!Number.isInteger(id) || id < 1 || id > 4094) continue;
    const name = typeof v.name === 'string' && /^[\x21-\x7e]{1,32}$/.test(v.name) ? v.name : `VLAN${String(id).padStart(4, '0')}`;
    const status = typeof v.status === 'string' && VLAN_STATES.test(v.status) ? v.status : 'active';
    const ports = Array.isArray(v.ports) ? v.ports.filter((p) => typeof p === 'string' && /^[\w/.-]{1,40}$/.test(p)).slice(0, 512) : [];
    out.push({ id, name, status, ports });
  }
  return out;
}

/** VTP settings from an untrusted manifest, or null */
export function cleanVtp(v) {
  if (!v || typeof v !== 'object') return null;
  const word = (x) => (typeof x === 'string' && /^[\x21-\x7e]{1,64}$/.test(x) ? x : null);
  return {
    version: [1, 2, 3].includes(Number(v.version)) ? Number(v.version) : 1,
    mode: ['server', 'client', 'transparent', 'off'].includes(v.mode) ? v.mode : 'server',
    domain: word(v.domain) ?? '',
    password: word(v.password),
    pruning: v.pruning === true,
  };
}

/** Does this text look like a configuration a device printed (or someone wrote)? */
export function checkConfigText(text, { strict = true } = {}) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return 'too_large';
  // Printable text only: a binary file renamed .cfg is refused
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text.replace(/\x03/g, ''))) return 'binary';
  if (strict && !/^(hostname|version) \S/m.test(text)) return 'not_a_config';
  return null;
}

export class ConfigFiles {
  #store;
  #manifests = new Map(); // set dir → { manifest, queue } while a job adds devices to it

  constructor({ store }) {
    this.#store = store;
  }

  /** Absolute folder of a set (`dir` is relative to DATA_DIR, as the index keeps it) */
  abs(dir) {
    const [top, ...rest] = String(dir).split('/');
    return this.#store.resolve(top, ...rest);
  }

  snapshotDir(bench, id) {
    return `snapshots/${this.#store.safeName(bench, 'bench')}/${id}`;
  }

  templateDir(id) {
    return `templates/${id}`;
  }

  /** Create the folder and its first manifest */
  async create(dir, manifest) {
    const abs = this.abs(dir);
    await fs.promises.mkdir(abs, { recursive: true, mode: 0o700 });
    const state = { manifest: { format: MANIFEST_FORMAT, ...manifest, devices: [] }, queue: Promise.resolve(), files: new Set() };
    this.#manifests.set(dir, state);
    await writeFileAtomic(path.join(abs, MANIFEST), `${JSON.stringify(state.manifest, null, 2)}\n`);
  }

  /**
   * Write one device of a set: its .cfg, its VLAN listing, the manifest again.
   * → the index row { device, file, sha256, bytes, vlanFile, vlanSha256, facts }
   */
  async addDevice(dir, { device, config, vlans = null, vtp = null, facts = {} }) {
    const state = this.#manifests.get(dir);
    if (!state) throw new Error(`set ${dir} is not open`);
    const run = state.queue.then(async () => {
      const abs = this.abs(dir);
      const taken = new Set([...state.files]);
      let base = device === ANY_DEVICE ? '_any' : this.#store.safeName(device, 'device');
      for (let n = 2, b = base; taken.has(base.toLowerCase()); n++) base = `${b}-${n}`;
      state.files.add(base.toLowerCase());
      const file = `${base}.cfg`;
      await writeFileAtomic(path.join(abs, file), config);
      let vlanFile = null;
      let vlanSha = null;
      if (Array.isArray(vlans)) {
        const text = vlanText(vlans);
        vlanFile = `${base}.vlan.txt`;
        vlanSha = sha256(text);
        await writeFileAtomic(path.join(abs, vlanFile), text);
      }
      const row = { device, file, sha256: sha256(config), bytes: Buffer.byteLength(config), vlanFile, vlanSha256: vlanSha, facts: factsOf(facts) };
      state.manifest.devices.push({ ...row, vlans: vlans ?? null, vtp: vtp ?? null });
      await writeFileAtomic(path.join(abs, MANIFEST), `${JSON.stringify(state.manifest, null, 2)}\n`);
      return row;
    });
    state.queue = run.catch(() => {});
    return run;
  }

  /** The set is complete: forget its in-memory manifest */
  close(dir) {
    this.#manifests.delete(dir);
  }

  /** The manifest of a set as written (null when missing or unreadable) */
  async manifest(dir) {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(this.abs(dir), MANIFEST), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * One device of a set, read from disk and checked against its index row
   * → { config, vlans, vtp, facts, intact } (intact: the file still has the recorded SHA-256)
   */
  async readDevice(set, row) {
    const abs = this.abs(set.dir);
    const config = await fs.promises.readFile(path.join(abs, row.file), 'utf8');
    const intact = sha256(config) === row.sha256;
    const manifest = await this.manifest(set.dir);
    const entry = manifest?.devices?.find?.((d) => d?.device === row.device) ?? null;
    let vlans = cleanVlans(entry?.vlans);
    if (!vlans && row.vlanFile) {
      try { vlans = parseVlanBrief(await fs.promises.readFile(path.join(abs, row.vlanFile), 'utf8')); } catch { vlans = null; }
    }
    return { config, vlans, vtp: cleanVtp(entry?.vtp), facts: row.facts ?? {}, intact };
  }

  /** The proof a reset waits for: the file on disk is the configuration just read, as recorded */
  async verify(set, row, config) {
    try {
      const onDisk = await fs.promises.readFile(path.join(this.abs(set.dir), row.file), 'utf8');
      return onDisk === config && sha256(onDisk) === row.sha256;
    } catch {
      return false;
    }
  }

  async remove(dir) {
    this.#manifests.delete(dir);
    await fs.promises.rm(this.abs(dir), { recursive: true, force: true });
  }

  /** A ZIP of the set's folder: `${root}/manifest.json`, `${root}/<device>.cfg`… */
  async zip(dir, root) {
    const abs = this.abs(dir);
    const files = {};
    for (const name of await fs.promises.readdir(abs)) {
      if (name.startsWith('.')) continue;
      files[`${root}/${name}`] = new Uint8Array(await fs.promises.readFile(path.join(abs, name)));
    }
    return zipSync(files, { level: 6 });
  }
}

/** Build a ZIP from { 'path/in/zip': string | Uint8Array } */
export function makeZip(entries) {
  const files = {};
  for (const [name, data] of Object.entries(entries)) files[name] = typeof data === 'string' ? strToU8(data) : data;
  return zipSync(files, { level: 6 });
}

/**
 * Read an uploaded ZIP without trusting it. Refused (ConfigError):
 *   - not a ZIP, or one that cannot be read                       jobs.zip_invalid
 *   - an entry whose name leaves the folder (../, /abs, C:\, \)   jobs.zip_unsafe
 *   - more than 200 entries, a file declared over its limit, or
 *     more than 20 MB once inflated (declared sizes are checked
 *     before anything is inflated; fflate never writes past them) jobs.zip_too_large
 * Folders, hidden files and macOS metadata are skipped. One leading folder
 * is allowed (the ZIP a download gives): names are returned without it.
 * → Map(name → text)
 */
export function readZip(buffer, { maxFileBytes = MAX_CONFIG_BYTES, maxEntries = ZIP_MAX_ENTRIES, maxTotal = ZIP_MAX_TOTAL } = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? []);
  if (data.length < 22 || data[0] !== 0x50 || data[1] !== 0x4b) throw new ConfigError(400, 'jobs.zip_invalid', 'This file is not a ZIP archive.');
  let count = 0;
  let total = 0;
  let unsafe = null;
  let tooLarge = null;
  let files;
  try {
    files = unzipSync(data, {
      filter(f) {
        const name = f.name;
        if (name.endsWith('/')) return false;
        if (++count > maxEntries) { tooLarge ??= { entries: count }; return false; }
        if (!safeEntry(name)) { unsafe ??= name; return false; }
        if (skipped(name)) return false;
        total += f.originalSize;
        if (f.originalSize > maxFileBytes || total > maxTotal) { tooLarge ??= { name }; return false; }
        return true;
      },
    });
  } catch {
    throw new ConfigError(400, 'jobs.zip_invalid', 'This ZIP archive cannot be read.');
  }
  if (unsafe !== null) throw new ConfigError(400, 'jobs.zip_unsafe', 'The archive holds a file whose name leaves its folder: nothing was imported.', { name: String(unsafe).slice(0, 120) });
  if (tooLarge) throw new ConfigError(413, 'jobs.zip_too_large', 'The archive is too large once unpacked: nothing was imported.', { max: Math.round(maxTotal / 1024 / 1024) });
  const names = Object.keys(files);
  const tops = new Set(names.map((n) => (n.includes('/') ? n.split('/')[0] : '')));
  const strip = tops.size === 1 && !tops.has('') ? (n) => n.slice(n.indexOf('/') + 1) : (n) => n;
  const out = new Map();
  for (const n of names) {
    const flat = strip(n);
    if (flat.includes('/')) continue; // deeper folders are not part of a snapshot
    out.set(flat, strFromU8(files[n]));
  }
  return out;
}

function safeEntry(name) {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((part) => part !== '..' && part !== '.');
}

function skipped(name) {
  const base = name.split('/').at(-1);
  return name.startsWith('__MACOSX/') || base.startsWith('.') || !base;
}
