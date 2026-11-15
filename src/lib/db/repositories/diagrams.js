/**
 * Repository of the diagram index (tables diagram_versions,
 * diagram_activations, migration 009). The files stay in
 * data/diagrams/versions/<id>.drawio; src/lib/diagrams.js keeps the index in
 * memory (src/lib/cachedDocument.js) and writes what changed:
 *
 *   load()            → { active, history: [{ id, at, by }], versions: [Version] } (null when nothing was ever recorded)
 *   save(next, prev)  versions added or dropped, and the stack of activations (inside repos.transaction)
 *
 * Version: { id, name, size, sha256, at, by: { id, username }, source, labs?, devices?, warnings? }.
 * `active` is the version of the last activation (a rollback pops one)
 */
import { toIso, toJson, fromJson, newId } from '../values.js';
import { changedRecords, byId } from '../../cachedDocument.js';

export function createDiagramsRepository(db) {
  return {
    async load() {
      const versions = await db.query(`SELECT id, name, size, sha256, at, by_id, by_username, source, labs, devices, warnings
        FROM diagram_versions ORDER BY at, id`);
      const history = await db.query('SELECT version_id, at, by_id FROM diagram_activations ORDER BY position');
      if (!versions.length && !history.length) return null;
      return {
        active: history.at(-1)?.version_id ?? null,
        history: history.map((h) => ({ id: h.version_id, at: h.at, by: h.by_id })),
        versions: versions.map((v) => ({
          id: v.id, name: v.name, size: Number(v.size), sha256: v.sha256, at: v.at, by: { id: v.by_id, username: v.by_username }, source: v.source,
          ...(v.labs !== null && v.labs !== undefined ? { labs: fromJson(v.labs, []), devices: Number(v.devices), warnings: Number(v.warnings) } : {}),
        })),
      };
    },

    async save(next, prev) {
      const { upserts, removals } = changedRecords(byId(prev?.versions), byId(next?.versions));
      for (const id of removals) await db.run('DELETE FROM diagram_versions WHERE id = ?', [id]);
      for (const [, v] of upserts) {
        await db.run(
          `INSERT INTO diagram_versions (id, name, size, sha256, at, by_id, by_username, source, labs, devices, warnings)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, size = excluded.size, sha256 = excluded.sha256, at = excluded.at,
             by_id = excluded.by_id, by_username = excluded.by_username, source = excluded.source, labs = excluded.labs,
             devices = excluded.devices, warnings = excluded.warnings`,
          [String(v.id), String(v.name ?? ''), Number(v.size) || 0, String(v.sha256 ?? ''), toIso(v.at) ?? toIso(Date.now()),
            String(v.by?.id ?? 'system'), String(v.by?.username ?? 'system'), String(v.source ?? 'import'),
            Array.isArray(v.labs) ? toJson(v.labs) : null, Number.isFinite(v.devices) ? v.devices : null, Number.isFinite(v.warnings) ? v.warnings : null],
        );
      }
      // The stack is short (50 at most): written again whole when it changed
      if (JSON.stringify(prev?.history ?? []) !== JSON.stringify(next?.history ?? [])) {
        await db.run('DELETE FROM diagram_activations', []);
        let position = 0;
        for (const h of next?.history ?? []) {
          await db.run('INSERT INTO diagram_activations (id, version_id, at, by_id, position) VALUES (?, ?, ?, ?, ?)',
            [newId(Date.parse(h.at) || Date.now()), String(h.id), toIso(h.at) ?? toIso(Date.now()), String(h.by ?? 'system'), position++]);
        }
      }
    },
  };
}
