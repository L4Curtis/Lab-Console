/**
 * The data directory: the only place the platform writes to (the image runs
 * read-only, see ARCHITECTURE §10). It holds the database (lab-console.db)
 * and the documents people download or diff: backed-up configurations,
 * console journals, diagram versions. Structured state (sessions, the audit
 * trail, settings, ...) goes through the repositories of src/lib/db, never
 * through this store (ARCHITECTURE §6, "database")
 *
 *   store.resolve('snapshots', bench, name)   absolute path inside DATA_DIR
 *   store.dir('journal', bench)               same, and creates the directory
 *   store.json('benches/occupancy.json', {})  { get(), set(value), update(fn) }
 *   store.jsonl('audit/2026-11.jsonl')        { append(obj), read({ limit, since, until, filter }) }
 *
 * Two guarantees the modules rely on:
 *   - a name coming from a user or from the diagram can never leave DATA_DIR
 *     (every path goes through resolve(), which refuses traversal),
 *   - a crash or a full disk never leaves a half-written document: JSON files
 *     are written to a temporary file and renamed, and concurrent updates of
 *     one file run one after the other
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

export class StoreError extends Error {
  constructor(message, code = 'store.path') {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const MAX_NAME_BYTES = 200;

/** One path component, as strict as a file name needs to be */
function checkName(name, whole) {
  const bad = (why) => new StoreError(`Unsafe path "${whole}": ${why}`);
  if (typeof name !== 'string' || name === '') throw bad('empty name');
  if (name === '.' || name === '..') throw bad('relative segment');
  if (name.startsWith('.')) throw bad('hidden name'); // also protects our own temporary files
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) throw bad('separator or control character');
  if (name !== name.trim()) throw bad('leading or trailing space');
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) throw bad('name too long');
  return name;
}

/**
 * Turn any label (bench, device, user name) into a file name that resolve()
 * accepts. Not reversible and not unique: keep the real name in the document
 */
export function safeName(text, fallback = 'unnamed') {
  const flat = String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é → e
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  return flat || fallback;
}

/** Write a whole file so that readers see either the old or the new content */
export async function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(tmp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Run async tasks strictly one after the other; a failed task does not block the next */
function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const toMillis = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

export function createStore(dataDir, { logger } = {}) {
  const root = path.resolve(dataDir);
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const documents = new Map(); // absolute path → json handle
  const logs = new Map();      // absolute path → jsonl handle
  const queues = new Set();

  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    throw new StoreError(`DATA_DIR ${root} is not a writable directory (${err.code || err.message})`, 'store.unwritable');
  }

  /**
   * Absolute path inside the data directory. The first segment may be a
   * literal relative path ('benches/occupancy.json'); every following segment
   * is ONE name, typically a variable, and may not contain a separator
   */
  function resolve(...segments) {
    if (!segments.length) throw new StoreError('Unsafe path "": no segment');
    const whole = segments.map(String).join('/');
    const names = [];
    segments.forEach((segment, i) => {
      if (typeof segment !== 'string') throw new StoreError(`Unsafe path "${whole}": segment is not a string`);
      if (i === 0) for (const part of segment.split('/')) names.push(checkName(part, whole));
      else names.push(checkName(segment, whole));
    });
    const full = path.resolve(root, ...names);
    if (full !== root && !full.startsWith(root + path.sep)) throw new StoreError(`Unsafe path "${whole}": outside the data directory`);
    return full;
  }

  function dir(...segments) {
    const full = resolve(...segments);
    fs.mkdirSync(full, { recursive: true, mode: 0o700 });
    return full;
  }

  const toPath = (relPath) => (Array.isArray(relPath) ? resolve(...relPath) : resolve(relPath));
  const newQueue = () => {
    const queue = createQueue();
    let pending = Promise.resolve();
    const tracked = (task) => {
      const run = queue(task);
      pending = run.catch(() => {});
      return run;
    };
    queues.add(() => pending);
    return tracked;
  };

  /**
   * One JSON document. get() is synchronous and returns a private copy;
   * set() and update() resolve once the new content is on disk. If the write
   * fails nothing changes: get() keeps returning what the file holds
   */
  function json(relPath, fallback = null) {
    const file = toPath(relPath);
    if (documents.has(file)) return documents.get(file);

    const enqueue = newQueue();
    let loaded = false;
    let value;

    const load = () => {
      if (loaded) return;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err; // unreadable: say so on every access, never pretend it is empty
        value = clone(fallback);
        loaded = true;
        return;
      }
      loaded = true;
      try {
        value = JSON.parse(text);
      } catch (err) {
        // Never overwrite something a human may want back: set it aside
        const aside = `${file}.corrupt-${Date.now()}`;
        try { fs.renameSync(file, aside); } catch { /* keep going with the fallback */ }
        log.error(`${path.relative(root, file)} is not valid JSON (${err.message}); moved to ${path.basename(aside)}, starting from the default`);
        value = clone(fallback);
      }
    };

    const write = async (next) => {
      if (next === undefined) throw new StoreError('A JSON document cannot be undefined', 'store.value');
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, text);
      value = JSON.parse(text); // what a restart would read: no shared references, no non-JSON values
      loaded = true;
    };

    const handle = {
      path: file,
      get() {
        load();
        return clone(value);
      },
      set(next) {
        return enqueue(() => write(next));
      },
      /**
       * fn receives a private copy of the current value and returns the new
       * one (or changes the copy in place and returns nothing). It may be
       * async; other updates of this document wait for it
       */
      update(fn) {
        return enqueue(async () => {
          load();
          const draft = clone(value);
          const result = await fn(draft);
          await write(result === undefined ? draft : result);
          return clone(value);
        });
      },
    };
    documents.set(file, handle);
    return handle;
  }

  /**
   * One append-only log, one JSON object per line. read() returns the
   * matching entries in file order; `limit` keeps the most recent ones.
   * `since` / `until` compare against each entry's `ts` (ISO date or ms)
   */
  function jsonl(relPath) {
    const file = toPath(relPath);
    if (logs.has(file)) return logs.get(file);

    const enqueue = newQueue();
    const handle = {
      path: file,
      append(entry) {
        return enqueue(async () => {
          const line = JSON.stringify(entry);
          if (line === undefined) throw new StoreError('A JSONL entry must be a JSON value', 'store.value');
          await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.promises.appendFile(file, `${line}\n`, { mode: 0o600 });
        });
      },
      read({ limit = Infinity, since, until, filter } = {}) {
        // Queued behind the appends, so a read sees every append made before it
        return enqueue(async () => {
          const from = toMillis(since);
          const to = toMillis(until);
          const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
          const out = [];
          let stream;
          try {
            await fs.promises.access(file);
            stream = fs.createReadStream(file, { encoding: 'utf8' });
          } catch (err) {
            if (err.code === 'ENOENT') return out;
            throw err;
          }
          for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; } // a torn last line after a crash
            if (from !== null || to !== null) {
              const ts = toMillis(entry?.ts);
              if (ts === null || (from !== null && ts < from) || (to !== null && ts > to)) continue;
            }
            if (filter && !filter(entry)) continue;
            out.push(entry);
            if (out.length >= max * 2 + 64) out.splice(0, out.length - max); // bounded memory on long logs
          }
          return out.length > max ? out.slice(out.length - max) : out;
        });
      },
    };
    logs.set(file, handle);
    return handle;
  }

  /** Resolves once every write requested so far has finished (shutdown, tests) */
  async function flush() {
    await Promise.all([...queues].map((pending) => pending()));
  }

  return { root, resolve, dir, json, jsonl, flush, safeName, writeFileAtomic };
}
