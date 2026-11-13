/**
 * The portability rules of every SQL statement the application runs
 * (ARCHITECTURE §6, "database"). The schema and the queries are written once
 * for SQLite today and PostgreSQL tomorrow: switching must only mean writing
 * another adapter, never rewriting a repository or a migration
 *
 *   portabilityProblems(sql)   → string[]: what in this statement would not run, or not run the same, elsewhere
 *   assertPortable(sql)        throws a DatabaseError listing them
 *   placeholderCount(sql)      the '?' outside string literals and comments
 *   checkParams(sql, params)   throws unless params is an array of portable values, one per '?'
 *
 * Every statement goes through these checks in the adapter, so a SQLite-only
 * construct fails in the first test that runs it, not on the day of the move.
 * The checks are deliberately simple: a scanner removes string literals and
 * comments, then a list of patterns names what is known to differ. It is a
 * safety net, not a parser - the rules in ARCHITECTURE are the contract
 */

export class DatabaseError extends Error {
  constructor(message, code = 'db.error', { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

/**
 * The statement with every string literal replaced by '' and every comment
 * by a space, so that the patterns below only see SQL. Quoted identifiers
 * ("x", `x`, [x]) are reported: names are lowercase snake_case, unquoted
 */
function scan(sql) {
  const problems = [];
  let text = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '\'') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) { problems.push('unterminated string literal'); break; }
        if (sql[j] === '\'') {
          if (sql[j + 1] === '\'') { j += 2; continue; }
          break;
        }
        j += 1;
      }
      text += '\'\'';
      i = j + 1;
    } else if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      text += ' ';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      text += ' ';
    } else if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      const end = sql.indexOf(close, i + 1);
      problems.push(`quoted identifier ${sql.slice(i, end === -1 ? undefined : end + 1)}: use an unquoted lowercase snake_case name that is not a reserved word`);
      i = end === -1 ? sql.length : end + 1;
      text += ' x ';
    } else {
      text += ch;
      i += 1;
    }
  }
  return { text, problems };
}

/** [pattern, explanation]; tested against the statement without literals and comments */
const RULES = [
  [/\bAUTOINCREMENT\b/i, 'AUTOINCREMENT is SQLite-only: ids are text (a UUID or a natural key)'],
  [/\bINTEGER\s+PRIMARY\s+KEY\b/i, 'INTEGER PRIMARY KEY is a SQLite rowid alias: ids are text (a UUID or a natural key)'],
  [/\b(?:_rowid_|rowid|oid)\b/i, 'rowid / oid are SQLite-only: use the table\'s own key'],
  [/\bWITHOUT\s+ROWID\b/i, 'WITHOUT ROWID is SQLite-only'],
  [/\)\s*STRICT\b/i, 'STRICT tables are SQLite-only'],
  [/\b(?:INSERT|UPDATE)\s+OR\s+[a-z]+/i, 'INSERT OR … / UPDATE OR … is SQLite-only: use INSERT … ON CONFLICT (…) DO UPDATE / DO NOTHING'],
  [/\bREPLACE\s+INTO\b|^\s*REPLACE\b/i, 'REPLACE INTO is SQLite-only: use INSERT … ON CONFLICT (…) DO UPDATE'],
  [/\bON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\b/i, 'a conflict clause on a constraint is SQLite-only'],
  [/\bON\s+CONFLICT\s+DO\s+UPDATE\b/i, 'ON CONFLICT DO UPDATE needs a conflict target: ON CONFLICT (column) DO UPDATE'],
  [/\b(?:PRAGMA|ATTACH|DETACH|VACUUM)\b/i, 'PRAGMA / ATTACH / DETACH / VACUUM belong to the adapter, not to a query or a migration'],
  [/\b(?:GLOB|REGEXP)\b/i, 'GLOB / REGEXP are SQLite-only'],
  [/\bCOLLATE\b/i, 'collations differ between databases: compare lower(x) when case must not matter'],
  [/\b(?:INDEXED\s+BY|NOT\s+INDEXED)\b/i, 'index hints are SQLite-only'],
  [/\b(?:datetime|date|time|julianday|strftime|unixepoch|timediff|ifnull|iif|instr|printf|group_concat|total|randomblob|zeroblob|hex|unhex|unicode|likelihood|likely|unlikely|last_insert_rowid|changes|total_changes|typeof|quote|soundex|sqlite_[a-z_]+|json[a-z_]*|jsonb[a-z_]*)\s*\(/i,
    'SQLite-only function: compute it in JavaScript, or use a standard one (coalesce, substr, lower, length…)'],
  [/\b(?:min|max)\s*\([^()]*,/i, 'min(a, b) / max(a, b) with several arguments are SQLite-only: use a CASE expression'],
  [/\b(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP)\b|\bnow\s*\(/i, 'timestamps come from the application, as ISO-8601 text in UTC (new Date().toISOString())'],
  [/\b(?:TRUE|FALSE)\b/i, 'booleans are integers 0 / 1'],
  [/\b(?:BLOB|CLOB|DATETIME|TIMESTAMP|BOOLEAN|BOOL|TINYINT|MEDIUMINT|UNSIGNED|NVARCHAR|NCHAR|JSONB?|ANY)\b/i,
    'column types are TEXT, INTEGER, BIGINT or REAL: timestamps and JSON as TEXT, booleans as INTEGER 0 / 1'],
  [/\bLIMIT\s+[^\s,]+\s*,/i, 'LIMIT a, b is not portable: LIMIT ? OFFSET ?'],
  [/\bLIMIT\s+-/i, 'a negative LIMIT is SQLite-only: leave LIMIT out'],
  [/\bIS\s+(?!NOT\b|NULL\b|DISTINCT\b)[\w?(']|\bIS\s+NOT\s+(?!NULL\b|DISTINCT\b)[\w?(']/i,'IS / IS NOT only compare with NULL: use = or IS [NOT] DISTINCT FROM'],
  [/::/, 'the :: cast is PostgreSQL-only: use CAST(x AS type)'],
  [/\$\d|\$[a-z_]|\?\d|[:@][a-z_]/i, 'placeholders are a plain ? (the PostgreSQL adapter numbers them)'],
  [/\$\$/, 'dollar quoting is PostgreSQL-only'],
];

/** Everything in `sql` that would not run, or not run the same, on another database */
export function portabilityProblems(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return ['a statement is a non-empty string'];
  const { text, problems } = scan(sql);
  if (/;\s*\S/.test(text)) problems.push('one statement per call (no ";" between statements)');
  for (const [pattern, why] of RULES) if (pattern.test(text)) problems.push(why);
  return problems;
}

export function assertPortable(sql) {
  const problems = portabilityProblems(sql);
  if (problems.length) {
    throw new DatabaseError(`Non-portable SQL (${problems.join('; ')}): ${sql.replace(/\s+/g, ' ').trim().slice(0, 200)}`, 'db.not_portable');
  }
}

/** Number of '?' placeholders outside string literals and comments */
export function placeholderCount(sql) {
  return (scan(sql).text.match(/\?/g) ?? []).length;
}

/**
 * Parameters are an array of portable values, exactly one per '?': text,
 * finite numbers, bigints, null, or bytes. Everything else is refused with
 * the rule it breaks, instead of being converted in a way that would differ
 * between drivers
 */
export function checkParams(sql, params) {
  if (!Array.isArray(params)) throw new DatabaseError('Parameters are an array, one value per "?"', 'db.params');
  const expected = placeholderCount(sql);
  if (params.length !== expected) {
    throw new DatabaseError(`${expected} placeholder(s) but ${params.length} parameter(s): ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`, 'db.params');
  }
  params.forEach((value, i) => {
    const at = `parameter ${i + 1}`;
    if (value === null || typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new DatabaseError(`${at} is not a finite number`, 'db.params');
      return;
    }
    if (typeof value === 'boolean') throw new DatabaseError(`${at} is a boolean: store booleans as 1 / 0`, 'db.params');
    if (value === undefined) throw new DatabaseError(`${at} is undefined: pass null for "no value"`, 'db.params');
    if (value instanceof Date) throw new DatabaseError(`${at} is a Date: store timestamps as ISO-8601 text (toISOString())`, 'db.params');
    throw new DatabaseError(`${at} is an object: store JSON payloads as text (JSON.stringify)`, 'db.params');
  });
}
