/**
 * Run-time settings: values an administrator may change without a restart
 * (lab connection parameters today; more namespaces later)
 *
 * The environment gives the starting values; what an administrator saved
 * replaces them. Saved values live in the database (repositories/settings.js,
 * one JSON document per namespace) and are read once at start-up, so that
 * get() stays synchronous: every module can read its settings through this
 * service instead of the frozen config. The admin lot adds validation,
 * write-only secrets, `describe`, `update` (which saves through the same
 * repository and refreshes the cache) and the 'change' event without
 * touching the callers (ARCHITECTURE §6, "settings").
 *
 * How saved values combine with the environment's: objects are merged key
 * by key, at every depth; anything else (a string, a number, a list) saved
 * for a key replaces the environment's value for that key.
 *
 * Read settings at the moment they are used (a new SSH connection, a new
 * console), never once at start-up, so that a change applies to what opens next.
 */
import { EventEmitter } from 'node:events';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `base` with `saved` laid over it; both are copies already */
function overlay(base, saved) {
  if (!isPlainObject(base) || !isPlainObject(saved)) return saved === undefined ? base : saved;
  const out = { ...base };
  for (const [key, value] of Object.entries(saved)) out[key] = overlay(base[key], value);
  return out;
}

/**
 * config: the frozen configuration (the environment's values); repo: the
 * settings repository (createRepositories(db).settings). Resolves once the
 * saved values are loaded; a database that cannot be read stops the start
 */
export async function createSettings({ config, repo, logger }) {
  if (!repo) throw new TypeError('createSettings needs the settings repository');
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const emitter = new EventEmitter();
  const sources = {
    // Same shapes as config.ssh / config.telnet / config.consoles
    lab: () => ({ ssh: config.ssh, telnet: config.telnet, consoles: config.consoles }),
  };
  const saved = new Map(Object.entries(await repo.all()));
  for (const ns of saved.keys()) {
    if (!sources[ns]) log.warn(`saved settings for "${ns}", a namespace this version does not know: ignored`);
  }

  return {
    /** Current values of a namespace (a structured copy: callers cannot mutate them) */
    get(ns) {
      const source = sources[ns];
      if (!source) throw new Error(`Unknown settings namespace "${ns}"`);
      return overlay(structuredClone(source()), structuredClone(saved.get(ns)));
    },
    namespaces: () => Object.keys(sources),
    /** 'change' (ns, values): emitted after a namespace changed (admin lot) */
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); },
    // The admin lot adds: describe(ns), update(ns, patch, actor) (repo.save, then saved.set and 'change'), register(ns, spec)
  };
}
