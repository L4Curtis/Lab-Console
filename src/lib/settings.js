/**
 * Run-time settings: values an administrator may change without a restart
 * (ARCHITECTURE §6, "settings")
 *
 * A namespace is registered with its fields. The environment gives the
 * starting values (`defaults()`); what an administrator saves replaces them,
 * field by field, and is kept in data/settings/<ns>.json (mode 600, like
 * every file of the store). Saving `null` for a field brings the
 * environment's value back.
 *
 *   settings.get(ns)                     current values (a private copy, secrets included: server only)
 *   settings.describe(ns)                what a page may show: secrets replaced by { set: true|false }
 *   settings.check(ns, patch)            the validation of update() alone: → { changed, reset } or the same 400, nothing saved
 *   settings.update(ns, patch, actor)    validate, save, audit, emit 'change' → describe(ns)
 *   settings.register(ns, spec)          another namespace (see below)
 *   settings.on('change', (ns, values) => …)   → a function that removes the listener
 *
 * A spec is { defaults: () => values, fields: { 'dotted.path': Field }, check?(values) → problems }.
 * A field is { type, … } with type 'string' (max, pattern, required), 'int'
 * (min, max), 'bool', 'list' (pattern, max, maxItems), 'range' ({ min, max }
 * within bounds) or 'secret' (max, check). Only listed fields can be saved;
 * every other key of the values always comes from the environment.
 *
 * Secrets are write-only: no answer contains them, the audit trail only
 * names the fields that changed. They are stored in clear in the 600 file,
 * or encrypted when APP_SECRET is set (src/lib/sealed.js); one that cannot be
 * opened any more (APP_SECRET changed) is ignored, the environment's value is
 * used, and describe() lists it in `unreadable`.
 *
 * Read settings at the moment they are used (a new SSH connection, a new
 * console), never once at start-up, so that a change applies to what opens next.
 */
import { EventEmitter } from 'node:events';
import { httpError } from './httpError.js';
import { secretKey, sealSecret, openSecret } from './sealed.js';
import { labSettings } from './labSettings.js';

const FILE_VERSION = 1;

// ── Field types: raw value from a page → { value } or { code } ─────────────
const CONTROL = /[\u0000-\u001f\u007f]/;
const TYPES = {
  string(raw, f) {
    if (typeof raw !== 'string') return { code: 'type' };
    const value = raw.trim();
    if (!value) return f.required ? { code: 'required' } : { value: '' };
    if (value.length > (f.max ?? 255)) return { code: 'too_long' };
    if (CONTROL.test(value) || (f.pattern && !f.pattern.test(value))) return { code: 'format' };
    return { value };
  },
  int(raw, f) {
    const value = typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : raw;
    if (!Number.isInteger(value)) return { code: 'type' };
    if (value < f.min || value > f.max) return { code: 'out_of_range' };
    return { value };
  },
  bool: (raw) => (typeof raw === 'boolean' ? { value: raw } : { code: 'type' }),
  list(raw, f) {
    const items = typeof raw === 'string' ? raw.split(/[\s,]+/) : raw;
    if (!Array.isArray(items) || items.some((v) => typeof v !== 'string')) return { code: 'type' };
    const value = [...new Set(items.map((v) => v.trim()).filter(Boolean))];
    if (!value.length && f.required) return { code: 'required' };
    if (value.length > (f.maxItems ?? 50)) return { code: 'too_many' };
    if (value.some((v) => v.length > (f.max ?? 255) || CONTROL.test(v) || (f.pattern && !f.pattern.test(v)))) return { code: 'format' };
    return { value };
  },
  range(raw, f) {
    if (typeof raw === 'string') {
      const m = raw.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      raw = m ? { min: Number(m[1]), max: Number(m[2]) } : null;
    }
    if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.min) || !Number.isInteger(raw.max)) return { code: 'type' };
    if (raw.min < f.min || raw.max > f.max) return { code: 'out_of_range' };
    if (raw.min > raw.max) return { code: 'range_order' };
    return { value: { min: raw.min, max: raw.max } };
  },
  secret(raw, f) {
    if (typeof raw !== 'string') return { code: 'type' };
    if (raw.length > (f.max ?? 1024)) return { code: 'too_long' };
    if (!f.multiline && CONTROL.test(raw)) return { code: 'format' };
    return { value: raw };
  },
};

const pathOf = (path) => path.split('.');
function read(obj, path) {
  let at = obj;
  for (const key of pathOf(path)) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}
function write(obj, path, value) {
  const keys = pathOf(path);
  let at = obj;
  for (const key of keys.slice(0, -1)) {
    if (at[key] === null || typeof at[key] !== 'object') at[key] = {};
    at = at[key];
  }
  at[keys.at(-1)] = value;
}

/** Leaf paths of a patch, stopping at known fields (a range is one field) */
function leaves(patch, fields, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Object.hasOwn(fields, path) || value === null || typeof value !== 'object' || Array.isArray(value)) out.push(path);
    else out.push(...leaves(value, fields, path));
  }
  return out;
}

const plain = (value) => {
  // A Buffer (an SSH key read from a file) becomes its text: settings are JSON
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * deps: config (environment values, APP_SECRET), store (persistence; without
 * it, saved values live in memory only), audit, logger
 */
export function createSettings({ config, store, audit, logger } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const emitter = new EventEmitter();
  const key = secretKey(config?.appSecret, 'settings');
  const spaces = new Map(); // ns → { spec, file, memory }

  function space(ns) {
    const found = spaces.get(ns);
    if (!found) throw new Error(`Unknown settings namespace "${ns}"`);
    return found;
  }

  /** What is saved for a namespace: { values: { path: value | sealed }, updatedAt, updatedBy } */
  function saved(s) {
    const doc = s.file ? s.file.get() : s.memory;
    return doc && typeof doc === 'object' && doc.values && typeof doc.values === 'object' ? doc : { values: {} };
  }

  /** Current values, and which saved fields apply and which cannot be read */
  function resolve(s, doc = saved(s)) {
    const values = structuredClone(plain(s.spec.defaults()));
    const applied = [];
    const unreadable = [];
    for (const [path, field] of Object.entries(s.spec.fields)) {
      if (!Object.hasOwn(doc.values, path)) continue;
      let value = doc.values[path];
      if (field.type === 'secret') {
        value = openSecret(value, key);
        if (value === null) { unreadable.push(path); continue; }
      }
      write(values, path, value);
      applied.push(path);
    }
    return { values, applied, unreadable };
  }

  function describe(ns) {
    const s = space(ns);
    const doc = saved(s);
    const { values, applied, unreadable } = resolve(s, doc);
    const fields = {};
    for (const [path, field] of Object.entries(s.spec.fields)) {
      fields[path] = { type: field.type };
      if (field.type === 'secret') write(values, path, { set: Boolean(read(values, path)) });
    }
    // Secrets that are not editable never leave the server either
    for (const path of s.spec.hidden ?? []) {
      if (read(values, path) !== undefined) write(values, path, { set: Boolean(read(values, path)) });
    }
    return {
      ns,
      values,
      fields,
      saved: applied,
      unreadable,
      updatedAt: doc.updatedAt ?? null,
      updatedBy: doc.updatedBy ?? null,
      encrypted: Boolean(key),
    };
  }

  /** Check a patch against the namespace; → { next (saved values), changed, reset } or throws a 400 */
  function apply(s, doc, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'settings.invalid', 'The settings must be an object', { problems: [] });
    const fields = s.spec.fields;
    const problems = [];
    const next = { ...doc.values };
    const changed = [];
    const reset = [];
    for (const path of leaves(patch, fields)) {
      // Own fields only: 'constructor' or '__proto__' in a patch are unknown keys, not inherited members
      const field = Object.hasOwn(fields, path) ? fields[path] : undefined;
      const raw = read(patch, path);
      if (!field) { problems.push({ field: path, code: 'unknown' }); continue; }
      if (raw === undefined) continue;
      if (raw === null) {
        if (Object.hasOwn(next, path)) { delete next[path]; reset.push(path); }
        continue;
      }
      const outcome = TYPES[field.type](raw, field);
      if (outcome.code) { problems.push({ field: path, code: outcome.code }); continue; }
      const custom = field.check?.(outcome.value, patch);
      if (custom) { problems.push({ field: path, code: custom }); continue; }
      const before = Object.hasOwn(next, path) ? (field.type === 'secret' ? openSecret(next[path], key) : next[path]) : undefined;
      if (before !== undefined && same(before, outcome.value)) continue;
      next[path] = field.type === 'secret' ? sealSecret(outcome.value, key) || '' : outcome.value;
      changed.push(path);
    }
    if (!problems.length) {
      const { values } = resolve(s, { values: next });
      problems.push(...(s.spec.check?.(values) ?? []));
    }
    if (problems.length) {
      throw httpError(400, 'settings.invalid', `Some values are not valid: ${problems.map((p) => `${p.field} (${p.code})`).join(', ')}`, { problems });
    }
    return { next, changed, reset };
  }

  /** Dry run of update(): → { changed, reset } or throws the same 400 settings.invalid; nothing is saved, audited or emitted */
  function check(ns, patch) {
    const s = space(ns);
    const { changed, reset } = apply(s, saved(s), patch);
    return { changed, reset };
  }

  async function update(ns, patch, actor = 'system') {
    const s = space(ns);
    let outcome;
    const by = actor?.user?.id ?? actor?.id ?? (typeof actor === 'string' ? actor : null);
    const commit = (doc) => {
      outcome = apply(s, doc, patch);
      return { version: FILE_VERSION, values: outcome.next, updatedAt: new Date().toISOString(), updatedBy: by };
    };
    if (s.file) await s.file.update((doc) => commit(doc && doc.values ? doc : { values: {} }));
    else s.memory = commit(saved(s));

    const { changed, reset } = outcome;
    if (changed.length || reset.length) {
      // Field names only for secrets; the other new values are worth reading in the trail
      const values = {};
      for (const path of changed) if (s.spec.fields[path].type !== 'secret') values[path] = outcome.next[path];
      audit?.log(actor, 'settings.update', { ns, changed, reset, values });
      log.info(`settings "${ns}" changed by ${by ?? 'system'}: ${[...changed, ...reset].join(', ')}`);
      const current = resolve(s).values;
      for (const fn of emitter.listeners('change')) {
        try { fn(ns, structuredClone(current)); } catch (err) { log.error(`settings change listener failed: ${err.message}`); }
      }
    }
    return { ...describe(ns), changed, reset };
  }

  function register(ns, spec) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(ns)) throw new Error(`Invalid settings namespace "${ns}"`);
    if (spaces.has(ns)) throw new Error(`Settings namespace "${ns}" is already registered`);
    if (typeof spec?.defaults !== 'function' || !spec.fields) throw new TypeError('A settings namespace needs defaults() and fields');
    for (const [path, field] of Object.entries(spec.fields)) {
      if (!TYPES[field.type]) throw new TypeError(`Settings field ${ns}.${path} has an unknown type "${field.type}"`);
    }
    const file = store ? store.json(['settings', `${ns}.json`], { values: {} }) : null;
    spaces.set(ns, { spec, file, memory: { values: {} } });
    const { unreadable } = resolve(spaces.get(ns));
    if (unreadable.length) log.warn(`settings "${ns}": ${unreadable.join(', ')} cannot be read (APP_SECRET changed?); the environment's values are used`);
  }

  if (config) register('lab', labSettings(config));

  return {
    /** Current values of a namespace (a structured copy: callers cannot mutate them) */
    get(ns) {
      return resolve(space(ns)).values;
    },
    describe,
    check,
    update,
    register,
    namespaces: () => [...spaces.keys()],
    /** 'change' (ns, values): emitted after a namespace changed */
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); },
  };
}
