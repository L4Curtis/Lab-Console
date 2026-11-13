/**
 * Run-time settings: values an administrator may change without a restart
 * (lab connection parameters today; more namespaces later)
 *
 * The environment gives the starting values; what an administrator saves in
 * the administration pages replaces them. This first version only exposes the
 * environment's values, so every module can already read its settings through
 * this service instead of the frozen config: the admin lot adds persistence,
 * validation, write-only secrets and the 'change' event without touching the
 * callers (ARCHITECTURE §6, "settings").
 *
 * Read settings at the moment they are used (a new SSH connection, a new
 * console), never once at start-up, so that a change applies to what opens next.
 */
import { EventEmitter } from 'node:events';

export function createSettings({ config }) {
  const emitter = new EventEmitter();
  const sources = {
    // Same shapes as config.ssh / config.telnet / config.consoles
    lab: () => ({ ssh: config.ssh, telnet: config.telnet, consoles: config.consoles }),
  };

  return {
    /** Current values of a namespace (a structured copy: callers cannot mutate them) */
    get(ns) {
      const source = sources[ns];
      if (!source) throw new Error(`Unknown settings namespace "${ns}"`);
      return structuredClone(source());
    },
    namespaces: () => Object.keys(sources),
    /** 'change' (ns, values): emitted after a namespace changed (admin lot) */
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); },
    // The admin lot adds: describe(ns), update(ns, patch, actor), register(ns, spec)
  };
}
