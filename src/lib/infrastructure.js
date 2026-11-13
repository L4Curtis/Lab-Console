/**
 * The admin switches: console devices outside the lab diagrams, reached
 * through the same jump server → telnet chain
 *
 * The list shipped with the image (INFRA_CONFIG_PATH, config/infrastructure.json)
 * is the starting point; once an administrator edits it from the
 * administration pages, the edited list lives in data/admin/switches.json and
 * wins. `infra.adminSwitches` is always the current list: read it when a
 * console is opened, never once at start-up.
 *
 *   infra.adminSwitches            [{ id, key: 'admin:<id>', name, bay, labName, target: { host, port } }]
 *   infra.describe()               { switches: [{ id, name, bay, host, port }], source: 'environment' | 'saved' }
 *   infra.replace(list, actor)     validate, save, audit, emit 'change' → describe()
 *   infra.on('change', fn)
 */
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { httpError } from './httpError.js';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/;
const TEXT = /^[^\u0000-\u001f\u007f<>]*$/;
const MAX_SWITCHES = 100;

/** Raw entries → { switches, problems: [{ index, field, code }] } */
export function checkSwitches(raw) {
  const problems = [];
  if (!Array.isArray(raw)) return { switches: [], problems: [{ index: -1, field: 'list', code: 'type' }] };
  if (raw.length > MAX_SWITCHES) problems.push({ index: -1, field: 'list', code: 'too_many' });
  const seen = new Set();
  const switches = [];
  raw.slice(0, MAX_SWITCHES).forEach((s, index) => {
    const bad = (field, code) => problems.push({ index, field, code });
    if (!s || typeof s !== 'object') return bad('entry', 'type');
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const bay = typeof s.bay === 'string' ? s.bay.trim() : '';
    const host = typeof s.host === 'string' ? s.host.trim() : '';
    const port = typeof s.port === 'string' && /^\d+$/.test(s.port.trim()) ? Number(s.port) : s.port;
    if (!ID.test(id)) bad('id', 'format');
    else if (seen.has(id)) bad('id', 'duplicate');
    seen.add(id);
    if (!name || name.length > 60 || !TEXT.test(name)) bad('name', name ? 'format' : 'required');
    if (bay.length > 40 || !TEXT.test(bay)) bad('bay', 'format');
    if (!HOST.test(host) && net.isIP(host) === 0) bad('host', host ? 'format' : 'required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) bad('port', 'out_of_range');
    switches.push({ id, name, bay, host, port });
  });
  return { switches, problems };
}

const expand = (s) => ({
  id: s.id,
  key: `admin:${s.id}`,      // the device key the browser sends; host/port stay server-side
  name: s.name,
  bay: s.bay || '',
  labName: [s.bay, s.name].filter(Boolean).join(' '),
  target: { host: String(s.host), port: s.port },
});

/** The shipped file; a broken entry is skipped with a warning, as before */
function readShipped(file, logger) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`No infrastructure file at ${file} (${err.code || err.message}); no admin switches listed`);
    return [];
  }
  const list = [];
  (raw.adminSwitches || []).forEach((s, i) => {
    const { switches, problems } = checkSwitches([s]);
    if (problems.length) logger.warn(`infrastructure.json: adminSwitches[${i}] needs id (a-z0-9-), name, host and integer port`);
    else list.push(switches[0]);
  });
  return list;
}

/**
 * deps: file (INFRA_CONFIG_PATH), store (without it, edits live in memory),
 * audit, logger
 */
export function createInfrastructure({ file, store, audit, logger }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const emitter = new EventEmitter();
  const shipped = readShipped(file, log);
  const saved = store ? store.json('admin/switches.json', null) : null;
  let memory = null;

  const current = () => {
    const doc = saved ? saved.get() : memory;
    if (doc && Array.isArray(doc.switches)) {
      const { switches, problems } = checkSwitches(doc.switches);
      if (!problems.length) return { switches, source: 'saved', updatedAt: doc.updatedAt ?? null, updatedBy: doc.updatedBy ?? null };
      log.warn('data/admin/switches.json is not valid: the shipped list is used');
    }
    return { switches: shipped, source: 'environment', updatedAt: null, updatedBy: null };
  };

  return {
    get adminSwitches() { return current().switches.map(expand); },
    describe: () => current(),
    async replace(list, actor) {
      const { switches, problems } = checkSwitches(list);
      if (problems.length) throw httpError(400, 'admin.switches_invalid', 'Some admin switches are not valid', { problems });
      const before = current().switches;
      const by = actor?.user?.id ?? actor?.id ?? 'system';
      const doc = { switches, updatedAt: new Date().toISOString(), updatedBy: by };
      if (saved) await saved.set(doc);
      else memory = doc;
      const ids = (l) => new Set(l.map((s) => s.id));
      const was = ids(before);
      const now = ids(switches);
      audit?.log(actor, 'admin.switches.update', {
        added: [...now].filter((id) => !was.has(id)),
        removed: [...was].filter((id) => !now.has(id)),
        count: switches.length,
      });
      for (const fn of emitter.listeners('change')) {
        try { fn(switches.map(expand)); } catch (err) { log.error(`switches change listener failed: ${err.message}`); }
      }
      return current();
    },
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); },
  };
}

/** The list as the shipped file gives it (tests, tools); the platform uses createInfrastructure */
export function loadInfrastructure(file, logger) {
  return { adminSwitches: readShipped(file, logger ?? { warn() {} }).map(expand) };
}
