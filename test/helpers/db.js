/**
 * Test helper: a database in memory, migrated like the real one, and the
 * repositories on it. Every test that needs state gets its own, so tests
 * never share rows and leave nothing on disk
 *
 *   const { db, repos, close } = await memoryDatabase();
 *   t.after(close);
 *
 * `now` gives the repositories a clock (the times they stamp: updated_at…)
 */
import { openDatabase, createRepositories } from '../../src/lib/db/index.js';

export async function memoryDatabase({ now } = {}) {
  const db = await openDatabase({ file: ':memory:' });
  return { db, repos: createRepositories(db, now ? { now } : {}), close: () => db.close() };
}

/** Run fn({ db, repos }) with a fresh in-memory database, closed afterwards */
export async function withMemoryDatabase(fn, options) {
  const memory = await memoryDatabase(options);
  try {
    return await fn(memory);
  } finally {
    await memory.close();
  }
}
