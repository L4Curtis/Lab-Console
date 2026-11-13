/**
 * The SQLite adapter of the data-access interface (ARCHITECTURE §6), on the
 * SQLite built into Node (node:sqlite, no flag since Node 22.13)
 *
 *   const db = openSqlite('/data/lab-console.db')   // or ':memory:' (tests)
 *   await db.query(sql, params)   → rows (plain objects)
 *   await db.get(sql, params)     → the first row, or undefined
 *   await db.run(sql, params)     → { changes }
 *   await db.transaction(async (tx) => { … })   tx has the same five methods
 *   await db.close()
 *
 * The interface is asynchronous although SQLite is not: the PostgreSQL
 * adapter that may replace this one will be, and callers must not notice the
 * switch. One connection, used by one statement or one transaction at a
 * time: everything goes through a queue, in call order, so a transaction
 * never sees another caller's statements in the middle of its own, and
 * statements issued one after the other are applied in that order even when
 * nobody awaits them (a sign-in then a sign-out).
 *
 * Inside a transaction, use `tx`, never `db`: a call on `db` waits for the
 * transaction to end, so awaiting it from inside the transaction would wait
 * forever. Not awaiting it is fine (an audit entry recorded on the way): it
 * runs right after the transaction.
 *
 * Every statement is checked for portability (portable.js) and its
 * parameters for type and count before it reaches SQLite.
 *
 * The file: WAL journal (readers do not block the writer, a crash loses
 * nothing that was committed), foreign keys on, a busy timeout in case
 * another process (a backup) holds the lock, temporary data in memory (the
 * container's root file system is read-only), and mode 0600 like every
 * other file of the data directory: it holds session hashes and keys
 */
import fs from 'node:fs';
import { DatabaseError, assertPortable, checkParams } from './portable.js';

// node:sqlite says it is experimental once per process, on stderr. That
// warning is about the module's API, which this adapter pins down with its
// own tests; keep it out of the service log. Every other warning goes through
async function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return undefined;
    return original.call(this, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } catch (err) {
    throw new DatabaseError(`This Node.js (${process.version}) has no built-in SQLite: Node 22.13 or later is required`, 'db.unavailable', { cause: err });
  } finally {
    process.emitWarning = original;
  }
}
const { DatabaseSync } = await loadSqlite();

const BUSY_TIMEOUT_MS = 5000;
const MAX_CACHED_STATEMENTS = 256;

/** Run tasks strictly one after the other; a failed task does not block the next */
function createQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  const enqueue = (task) => {
    pending += 1;
    const run = tail.then(task).finally(() => { pending -= 1; });
    tail = run.catch(() => {});
    return run;
  };
  enqueue.idle = () => tail;
  enqueue.size = () => pending;
  return enqueue;
}

/** Copy SQLite's null-prototype rows into plain objects */
const plain = (row) => (row === undefined ? undefined : { ...row });

export function openSqlite(file, { busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const memory = file === ':memory:';
  if (!memory) {
    // Created here with the right mode; SQLite gives its -wal and -shm files the same one
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
  }
  let conn;
  try {
    conn = new DatabaseSync(file);
    conn.exec('PRAGMA foreign_keys = ON');
    conn.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    conn.exec('PRAGMA temp_store = MEMORY');
    if (!memory) {
      const { journal_mode: mode } = conn.prepare('PRAGMA journal_mode = WAL').get();
      if (String(mode).toLowerCase() !== 'wal') throw new Error(`the journal could not be switched to WAL (${mode})`);
    }
  } catch (err) {
    try { conn?.close(); } catch { /* already unusable */ }
    throw new DatabaseError(`The database ${file} could not be opened: ${err.message}`, 'db.open', { cause: err });
  }

  const statements = new Map(); // sql → StatementSync, checked once
  const enqueue = createQueue();
  let closed = false;
  let savepoints = 0;

  function prepare(sql) {
    let statement = statements.get(sql);
    if (statement) {
      statements.delete(sql); // most recently used last
    } else {
      assertPortable(sql);
      statement = conn.prepare(sql);
      if (statements.size >= MAX_CACHED_STATEMENTS) statements.delete(statements.keys().next().value);
    }
    statements.set(sql, statement);
    return statement;
  }

  /** Execute one statement now (the caller holds the connection) */
  function execute(kind, sql, params = []) {
    checkParams(sql, params);
    try {
      const statement = prepare(sql);
      if (kind === 'query') return statement.all(...params).map(plain);
      if (kind === 'get') return plain(statement.get(...params));
      const { changes } = statement.run(...params);
      return { changes: Number(changes) };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw new DatabaseError(`${err.message} (in: ${sql.replace(/\s+/g, ' ').trim().slice(0, 160)})`, err.code === 'ERR_SQLITE_ERROR' ? constraintCode(err) : 'db.error', { cause: err });
    }
  }

  const guardOpen = () => {
    if (closed) throw new DatabaseError('The database is closed', 'db.closed');
  };

  /**
   * The executor handed to a transaction's callback: same interface as the
   * database, statements run at once on the held connection, and it refuses
   * to work once its transaction is over
   */
  function transactionExecutor() {
    let active = true;
    const now = (kind) => (sql, params) => {
      try {
        if (!active) throw new DatabaseError('This transaction is already over: use the database, or start another transaction', 'db.tx_over');
        return Promise.resolve(execute(kind, sql, params));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const tx = {
      dialect: 'sqlite',
      query: now('query'),
      get: now('get'),
      run: now('run'),
      /** Nested: a savepoint, rolled back alone when its callback fails */
      async transaction(fn) {
        if (!active) throw new DatabaseError('This transaction is already over', 'db.tx_over');
        const name = `sp_${++savepoints}`;
        conn.exec(`SAVEPOINT ${name}`);
        const inner = transactionExecutor();
        try {
          const result = await fn(inner.tx);
          conn.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          conn.exec(`ROLLBACK TO ${name}`);
          conn.exec(`RELEASE ${name}`);
          throw err;
        } finally {
          inner.end();
        }
      },
      close() { return Promise.reject(new DatabaseError('A transaction cannot close the database', 'db.tx_close')); },
    };
    return { tx, end: () => { active = false; } };
  }

  const queued = (kind) => (sql, params) => {
    try {
      guardOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    return enqueue(() => execute(kind, sql, params));
  };

  return {
    dialect: 'sqlite',
    file,
    query: queued('query'),
    get: queued('get'),
    run: queued('run'),

    /**
     * Run `fn(tx)` in a transaction: committed when it resolves, rolled back
     * when it throws (the error is passed on). Transactions run one at a time
     */
    transaction(fn) {
      try {
        guardOpen();
      } catch (err) {
        return Promise.reject(err);
      }
      return enqueue(async () => {
        conn.exec('BEGIN IMMEDIATE');
        const { tx, end } = transactionExecutor();
        try {
          const result = await fn(tx);
          end();
          conn.exec('COMMIT');
          return result;
        } catch (err) {
          end();
          try { conn.exec('ROLLBACK'); } catch { /* SQLite already rolled back (a failed COMMIT) */ }
          throw err;
        }
      });
    },

    /** Statements waiting for the connection (health page, tests) */
    get pending() { return enqueue.size(); },

    /** Waits for what is queued, then closes; later calls are refused */
    async close() {
      if (closed) return;
      closed = true;
      await enqueue.idle();
      statements.clear();
      conn.close();
    },
  };
}

/** A stable code for the errors callers may want to tell apart */
function constraintCode(err) {
  const message = String(err.message);
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) return 'db.unique';
  if (/FOREIGN KEY constraint failed/i.test(message)) return 'db.foreign_key';
  if (/NOT NULL constraint failed|CHECK constraint failed/i.test(message)) return 'db.constraint';
  return 'db.error';
}
