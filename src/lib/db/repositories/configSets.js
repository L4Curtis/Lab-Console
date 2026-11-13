/**
 * Repositories of the configuration sets the jobs keep (migration 012):
 * snapshots (tables snapshots, snapshot_devices) and TP templates (tables
 * templates, template_devices). The files themselves stay in DATA_DIR
 * (`dir` is relative to it); a row says which file holds which device, with
 * its SHA-256, so that a backup is checked against what was written before
 * anything is erased
 *
 *   snapshots.insert(snapshot)     snapshot: { id, bench, teamId, label, origin, jobId, author, dir, createdAt, bytes, devices?: [Device] }
 *   snapshots.addDevice(id, device, bytes)   one more device (a job writes them as they come); `bytes`: the new total
 *   snapshots.get(id)              → Snapshot | null
 *   snapshots.list({ bench })      → Snapshot[] newest first (every bench without `bench`)
 *   snapshots.remove(id)
 *
 *   templates.insert(template)     template: { id, name, description, base, dir, author, createdAt, updatedAt, devices: [Device] }
 *   templates.get(id) / templates.list() / templates.remove(id)
 *   templates.update(id, { name, description, updatedAt })
 *   templates.setBase(id | null)   the base configuration (at most one)
 *
 * Device: { device, file, sha256, bytes, vlanFile, vlanSha256, facts: { hostname, model, version, family, kind, configRegister, vtp? } }
 */
import { toIso, toJson, fromJson, toFlag, fromFlag } from '../values.js';

const DEVICE_COLUMNS = 'device, file, sha256, bytes, vlan_file, vlan_sha256, facts';

const deviceView = (r) => ({
  device: r.device,
  file: r.file,
  sha256: r.sha256,
  bytes: Number(r.bytes),
  vlanFile: r.vlan_file ?? null,
  vlanSha256: r.vlan_sha256 ?? null,
  facts: fromJson(r.facts, {}),
});

const deviceParams = (d) => [String(d.device), String(d.file), String(d.sha256), Number(d.bytes) || 0, d.vlanFile ?? null, d.vlanSha256 ?? null, toJson(d.facts ?? {})];

/** Rows of a child table, grouped by their parent's id */
function grouped(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(deviceView(r));
  }
  return out;
}

const SNAPSHOT_COLUMNS = 'id, bench, team_id, label, origin, job_id, author, dir, created_at, bytes';

const snapshotView = (r, devices) => ({
  id: r.id,
  bench: r.bench,
  teamId: r.team_id ?? null,
  label: r.label,
  origin: r.origin,
  jobId: r.job_id ?? null,
  author: fromJson(r.author, {}),
  dir: r.dir,
  createdAt: r.created_at,
  bytes: Number(r.bytes),
  devices: devices ?? [],
});

export function createSnapshotsRepository(db) {
  async function withDevices(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const devs = await db.query(`SELECT snapshot_id, ${DEVICE_COLUMNS} FROM snapshot_devices WHERE snapshot_id IN (${ids.map(() => '?').join(', ')}) ORDER BY device`, ids);
    const byId = grouped(devs, 'snapshot_id');
    return rows.map((r) => snapshotView(r, byId.get(r.id)));
  }
  return {
    async insert(s) {
      return db.transaction(async (tx) => {
        await tx.run(`INSERT INTO snapshots (${SNAPSHOT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [String(s.id), String(s.bench), s.teamId ?? null, String(s.label ?? ''), String(s.origin), s.jobId ?? null,
            toJson(s.author ?? {}), String(s.dir), toIso(s.createdAt), Number(s.bytes) || 0]);
        for (const d of s.devices ?? []) {
          await tx.run(`INSERT INTO snapshot_devices (snapshot_id, ${DEVICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [String(s.id), ...deviceParams(d)]);
        }
      });
    },
    async addDevice(id, d, bytes) {
      return db.transaction(async (tx) => {
        await tx.run(`INSERT INTO snapshot_devices (snapshot_id, ${DEVICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [String(id), ...deviceParams(d)]);
        await tx.run('UPDATE snapshots SET bytes = ? WHERE id = ?', [Number(bytes) || 0, String(id)]);
      });
    },
    async get(id) {
      const row = await db.get(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE id = ?`, [String(id)]);
      return row ? (await withDevices([row]))[0] : null;
    },
    async list({ bench } = {}) {
      const rows = bench === undefined
        ? await db.query(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots ORDER BY created_at DESC, id DESC`)
        : await db.query(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE bench = ? ORDER BY created_at DESC, id DESC`, [String(bench)]);
      return withDevices(rows);
    },
    async remove(id) {
      return db.transaction(async (tx) => {
        await tx.run('DELETE FROM snapshot_devices WHERE snapshot_id = ?', [String(id)]);
        await tx.run('DELETE FROM snapshots WHERE id = ?', [String(id)]);
      });
    },
  };
}

const TEMPLATE_COLUMNS = 'id, name, description, base, dir, author, created_at, updated_at';

const templateView = (r, devices) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  base: fromFlag(r.base),
  dir: r.dir,
  author: fromJson(r.author, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  devices: devices ?? [],
});

export function createTemplatesRepository(db) {
  async function withDevices(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const devs = await db.query(`SELECT template_id, ${DEVICE_COLUMNS} FROM template_devices WHERE template_id IN (${ids.map(() => '?').join(', ')}) ORDER BY device`, ids);
    const byId = grouped(devs, 'template_id');
    return rows.map((r) => templateView(r, byId.get(r.id)));
  }
  return {
    async insert(t) {
      return db.transaction(async (tx) => {
        await tx.run(`INSERT INTO templates (${TEMPLATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [String(t.id), String(t.name), String(t.description ?? ''), toFlag(false), String(t.dir), toJson(t.author ?? {}), toIso(t.createdAt), toIso(t.updatedAt ?? t.createdAt)]);
        for (const d of t.devices ?? []) {
          await tx.run(`INSERT INTO template_devices (template_id, ${DEVICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [String(t.id), ...deviceParams(d)]);
        }
      });
    },
    async get(id) {
      const row = await db.get(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = ?`, [String(id)]);
      return row ? (await withDevices([row]))[0] : null;
    },
    async list() {
      return withDevices(await db.query(`SELECT ${TEMPLATE_COLUMNS} FROM templates ORDER BY name`));
    },
    async update(id, { name, description, updatedAt }) {
      return db.run('UPDATE templates SET name = ?, description = ?, updated_at = ? WHERE id = ?',
        [String(name), String(description ?? ''), toIso(updatedAt), String(id)]);
    },
    async setBase(id) {
      return db.transaction(async (tx) => {
        await tx.run('UPDATE templates SET base = ? WHERE base = ?', [toFlag(false), toFlag(true)]);
        if (id) await tx.run('UPDATE templates SET base = ? WHERE id = ?', [toFlag(true), String(id)]);
      });
    },
    async remove(id) {
      return db.transaction(async (tx) => {
        await tx.run('DELETE FROM template_devices WHERE template_id = ?', [String(id)]);
        await tx.run('DELETE FROM templates WHERE id = ?', [String(id)]);
      });
    },
  };
}
