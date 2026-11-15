/**
 * Structured state kept in memory and written through a repository
 *
 * The wave 2 modules (teams, benches, accounts, invitations, the diagram
 * index) keep small state that they read synchronously on every request
 * (who holds a bench, which team a user is in). Their records live in tables
 * of the database (ARCHITECTURE §14, "Store structured state"); this handle
 * keeps a copy in memory, loaded once in the module's start(), and writes
 * every change through the repository before the copy changes:
 *
 *   const doc = createCachedDocument({
 *     fallback: { teams: [] },
 *     load: () => repos.teams.load(),                                         // → the value
 *     save: (next, prev) => repos.transaction((r) => r.teams.save(next, prev)),   // writes what changed
 *   });
 *   await doc.load();          // in start()
 *   doc.get()                  // synchronous, a private copy (the fallback before load())
 *   await doc.update((value) => { … })   // serialized; fn may be async, may return a new value
 *   await doc.set(value)
 *
 * The same contract as store.json() (ARCHITECTURE §6), which these modules
 * used before: updates run one after the other, and when `fn` throws or the
 * database refuses the write, nothing changes, in the database or in memory.
 * `save(next, prev)` receives both values so the repository writes only the
 * records that changed, in one transaction
 */
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function createCachedDocument({ fallback = null, load, save, name = 'document' }) {
  if (typeof load !== 'function' || typeof save !== 'function') throw new TypeError('A cached document needs load() and save()');
  let value;
  let loaded = false;
  let queue = Promise.resolve();

  const enqueue = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  return {
    get loaded() { return loaded; },
    /** Read the records from the repository (again); waits for the updates in progress */
    load() {
      return enqueue(async () => {
        const read = await load();
        value = read === undefined || read === null ? clone(fallback) : read;
        loaded = true;
        return clone(value);
      });
    },
    get() {
      return clone(loaded ? value : fallback);
    },
    update(fn) {
      return enqueue(async () => {
        if (!loaded) throw new Error(`${name} is used before it was loaded (the module's start() loads it)`);
        const prev = clone(value);
        const draft = clone(value);
        const result = await fn(draft);
        const next = result === undefined ? draft : result;
        await save(clone(next), prev);
        value = next;
        return clone(value);
      });
    },
    set(next) {
      return this.update(() => clone(next));
    },
  };
}

/**
 * What changed between two maps of records (objects keyed by id), for a
 * repository's save(): → { upserts: [[key, record]], removals: [key] }.
 * A record counts as changed when its JSON differs
 */
export function changedRecords(prev = {}, next = {}) {
  const before = prev ?? {};
  const after = next ?? {};
  const upserts = [];
  const removals = [];
  for (const [key, record] of Object.entries(after)) {
    if (!Object.hasOwn(before, key) || JSON.stringify(before[key]) !== JSON.stringify(record)) upserts.push([key, record]);
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) removals.push(key);
  return { upserts, removals };
}

/** The same for arrays of records with an id field */
export const byId = (list, field = 'id') => Object.fromEntries((Array.isArray(list) ? list : []).map((r) => [String(r[field]), r]));
