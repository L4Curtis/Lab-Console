/**
 * Console journal: what each device printed, session by session, with who was there
 *
 *   data/journal/<bench>/<device>/<yyyy-mm-dd>/<hhmmss>.log    one console session's output, as
 *                                                               received, plus marker lines
 *   data/journal/<bench>/<device>/<yyyy-mm-dd>/<hhmmss>.json   its sidecar: who attached, who held the
 *                                                               keyboard, the teams that held the bench,
 *                                                               start, end, size, truncation
 *
 * One file per session (a line opened, used, closed). Reading covers the
 * whole day of a console (owner decision, 13 Nov): the people who were on
 * any session of R1 today (attached or piloting), the teams that held the
 * bench during any of them, and admins read every session of R1 today
 * (`canReadDay`). Someone who watched R1 for a minute in the afternoon thus
 * reads what another team did on R1 that morning, not the day before. A
 * session that runs past midnight goes on in a new file of the new day,
 * whose sidecar starts with the people already on it. The sidecar is the
 * permission list, small and kept next to the output, so a check never parses
 * a log and the retention sweep removes both together.
 *
 * The days that exist per device are listed in the database (table
 * journal_days, through `days` = repos.journalDays): the journal page, the
 * retention sweep and the global cap read that list instead of walking the
 * directory tree. `reconcile()` (at start-up) adds the days found on disk
 * that the table does not know, e.g. written by a version without it.
 *
 * The team is recorded when the session starts, when someone attaches or
 * takes the keyboard, and with every marker line (tasks): a line driven only
 * by a job still names the team that held the bench.
 *
 * Output only, never keystrokes: what reaches the log is what the device
 * sent back. A password typed at "Password:" is not echoed by IOS, so it is
 * never written; what the device echoes (commands) is.
 *
 * Limits: one device's day (all its sessions) is capped at `maxBytesPerDay`;
 * past it, one marker line says the journal stopped, and nothing more is
 * written that day. `sweep()` deletes the days older than `retentionDays`
 * (run daily). Every journal together is capped at `maxTotalBytes`
 * (JOURNAL_MAX_TOTAL_MB): `enforceCap()` deletes the oldest days first until
 * the total fits, never the current day (its own cap bounds it).
 *
 * Writes are batched (a quarter of a second, or 64 KB) and appended to the
 * session's file, created with mode 0600 inside DATA_DIR.
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SESSION = /^\d{6}(?:-\d{1,4})?$/;
const FLUSH_MS = 250;
const FLUSH_BYTES = 64 * 1024;

const pad = (n) => String(n).padStart(2, '0');

/** yyyy-mm-dd of a time, in the server's time zone (what the people in the room call "today") */
export function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const clockOf = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const timeOf = (ms) => {
  const d = new Date(ms);
  return `${dayOf(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const person = (u) => ({ name: u.name || u.username || u.id, username: u.username || '' });

export class ConsoleJournal {
  #claimed = new Set(); // session files handed out by this process (two openings in the same second)

  /**
   * @param store           the platform store
   * @param days            repos.journalDays: the list of days per device (without it, the directory is walked)
   * @param retentionDays   days kept (today counts as one)
   * @param maxBytesPerDay  size cap of one device's day (all its sessions)
   * @param maxTotalBytes   size cap of every journal together
   * @param now             clock (tests)
   * @param teamOf          (benchName) => teamId | null: the team holding the bench now
   */
  constructor({ store, days = null, retentionDays = 14, maxBytesPerDay = 5 * 1024 * 1024, maxTotalBytes = Infinity, now = () => Date.now(), teamOf = () => null, logger }) {
    this.store = store;
    this.days = days;
    this.retentionDays = retentionDays;
    this.maxBytesPerDay = maxBytesPerDay;
    this.maxTotalBytes = maxTotalBytes;
    this.now = now;
    this.teamOf = teamOf;
    this.log = logger ?? { warn() {}, info() {}, error() {} };
  }

  /** A writer for one console session: { output(buf), mark(text), attended(user), piloted(user), close() } */
  open({ bench, device, target }) {
    return new JournalWriter(this, { bench, device, target });
  }

  /** Where a session lives: { log, meta: ['journal', b, d, day, session.json] } (names already safe) */
  paths(benchDir, deviceDir, day, session) {
    if (!DAY.test(day) || !SESSION.test(session)) throw Object.assign(new Error('Bad journal name'), { code: 'store.path' });
    return {
      log: this.store.resolve('journal', benchDir, deviceDir, day, `${session}.log`),
      meta: ['journal', benchDir, deviceDir, day, `${session}.json`],
    };
  }

  /** The sidecar of a session (null when there is none) */
  meta(benchDir, deviceDir, day, session) {
    const { meta } = this.paths(benchDir, deviceDir, day, session);
    try {
      return JSON.parse(fs.readFileSync(this.store.resolve(...meta), 'utf8'));
    } catch {
      return null;
    }
  }

  /** May `user` read this session (its sidecar alone)? Admins, the people who were on it, the teams that held the bench during it */
  canRead(user, meta, teamOfUser = () => null) {
    if (!user || !meta) return false;
    if (user.role === 'admin') return true;
    if (meta.attended?.[user.id] || meta.pilots?.[user.id]) return true;
    const team = teamOfUser(user);
    return Boolean(team && (meta.teams ?? []).includes(team));
  }

  /**
   * May `user` read the sessions of a console's day? Read rights cover the
   * whole day (owner decision): yes when they may read any of its sessions
   */
  canReadDay(user, metas, teamOfUser = () => null) {
    return (metas ?? []).some((meta) => this.canRead(user, meta, teamOfUser));
  }

  /** The sidecars of every session of a console's day */
  dayMetas(benchDir, deviceDir, day) {
    let dir;
    try { dir = this.store.resolve('journal', benchDir, deviceDir, day); } catch { return []; }
    return readDir(dir).map((f) => /^(.+)\.json$/.exec(f)?.[1]).filter((name) => name && SESSION.test(name))
      .map((name) => this.meta(benchDir, deviceDir, day, name)).filter(Boolean);
  }

  /** The days of journal: [{ benchDir, deviceDir, day }], from the table (or the directory without one) */
  async #knownDays() {
    if (this.days) return this.days.list();
    return this.#scanDays();
  }

  /** The day folders on disk */
  #scanDays() {
    let root;
    try { root = this.store.resolve('journal'); } catch { return []; }
    const out = [];
    for (const benchDir of readDir(root)) {
      for (const deviceDir of readDir(path.join(root, benchDir))) {
        for (const day of readDir(path.join(root, benchDir, deviceDir)).filter((n) => DAY.test(n))) out.push({ benchDir, deviceDir, day });
      }
    }
    return out;
  }

  /**
   * Days on disk that the table does not list (written before it existed,
   * or while the database refused a write) are added. → how many
   */
  async reconcile() {
    if (!this.days) return 0;
    const known = new Set((await this.days.list()).map((d) => `${d.benchDir}/${d.deviceDir}/${d.day}`));
    let added = 0;
    for (const d of this.#scanDays()) {
      if (known.has(`${d.benchDir}/${d.deviceDir}/${d.day}`)) continue;
      const meta = this.dayMetas(d.benchDir, d.deviceDir, d.day)[0];
      await this.days.record({ ...d, bench: meta?.bench ?? d.benchDir, device: meta?.device ?? d.deviceDir, bytes: this.dayBytes(d.benchDir, d.deviceDir, d.day), at: meta?.started ?? this.now() });
      added += 1;
    }
    if (added) this.log.info(`journal: ${added} day(s) found on disk added to the list`);
    return added;
  }

  /** Every session, newest first: [{ benchDir, deviceDir, day, session, bench, device, from, to, bytes, truncated, meta }] */
  async list() {
    const root = this.store.resolve('journal');
    const out = [];
    for (const { benchDir, deviceDir, day } of await this.#knownDays()) {
      const dayPath = path.join(root, benchDir, deviceDir, day);
      for (const file of readDir(dayPath)) {
        const m = /^(.+)\.json$/.exec(file);
        if (!m || !SESSION.test(m[1])) continue;
        const meta = this.meta(benchDir, deviceDir, day, m[1]);
        if (!meta) continue;
        // The file itself says how big it is now (the sidecar follows every few seconds)
        let bytes = meta.bytes ?? 0;
        try { bytes = fs.statSync(path.join(dayPath, `${m[1]}.log`)).size; } catch { /* output not written yet */ }
        out.push({
          benchDir, deviceDir, day, session: m[1], bench: meta.bench, device: meta.device,
          from: meta.started ?? null, to: meta.ended ?? null, bytes, truncated: Boolean(meta.truncated), meta,
        });
      }
    }
    return out.sort((a, b) => b.day.localeCompare(a.day) || b.session.localeCompare(a.session, 'en', { numeric: true })
      || a.bench.localeCompare(b.bench) || a.device.localeCompare(b.device));
  }

  /** Remove one day of a console: its folder, its row, and the folders left empty. → the sessions removed */
  async #removeDay({ benchDir, deviceDir, day }) {
    let removed = 0;
    try {
      const full = this.store.resolve('journal', benchDir, deviceDir, day);
      removed = readDir(full).filter((f) => f.endsWith('.json')).length;
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* a name the store refuses was never written by us */ }
    await this.days?.remove(benchDir, deviceDir, day);
    this.#pruneFolders(benchDir, deviceDir);
    return removed;
  }

  #pruneFolders(benchDir, deviceDir) {
    try {
      const benchPath = this.store.resolve('journal', benchDir);
      const devicePath = path.join(benchPath, deviceDir);
      if (fs.existsSync(devicePath) && !readDir(devicePath).length) fs.rmSync(devicePath, { recursive: true, force: true });
      if (fs.existsSync(benchPath) && !readDir(benchPath).length) fs.rmSync(benchPath, { recursive: true, force: true });
    } catch { /* nothing to prune */ }
  }

  /**
   * Delete the days older than the retention (every session of them), then
   * the folders left empty. Resolves to the number of sessions removed
   */
  async sweep() {
    const oldest = dayOf(this.now() - (this.retentionDays - 1) * 86_400_000);
    let removed = 0;
    const old = this.days ? await this.days.before(oldest) : this.#scanDays().filter((d) => d.day < oldest);
    for (const d of old) removed += await this.#removeDay(d);
    // Files of the first journal format (one <day>.log per device, before sessions had their own file)
    let root = null;
    try { root = this.store.resolve('journal'); } catch { /* no journal yet */ }
    for (const benchDir of root ? readDir(root) : []) {
      for (const deviceDir of readDir(path.join(root, benchDir))) {
        for (const name of readDir(path.join(root, benchDir, deviceDir))) {
          const day = /^(\d{4}-\d{2}-\d{2})\.(?:log|json)$/.exec(name)?.[1];
          if (!day || day >= oldest) continue;
          removed += Number(name.endsWith('.json'));
          fs.rmSync(path.join(root, benchDir, deviceDir, name), { force: true });
        }
        this.#pruneFolders(benchDir, deviceDir);
      }
    }
    if (removed) this.log.info(`journal: removed ${removed} session(s) older than ${oldest}`);
    return removed;
  }

  /** What the journals weigh now: { bytes, days, maxBytes } (sizes read from the files) */
  async usage() {
    const days = await this.#knownDays();
    let bytes = 0;
    for (const d of days) bytes += this.dayBytes(d.benchDir, d.deviceDir, d.day);
    return { bytes, days: days.length, maxBytes: Number.isFinite(this.maxTotalBytes) ? this.maxTotalBytes : null };
  }

  /**
   * Keep every journal together under `maxTotalBytes`: the oldest days go
   * first, never today's. Resolves to the number of days removed
   */
  async enforceCap() {
    if (!Number.isFinite(this.maxTotalBytes)) return 0;
    const today = dayOf(this.now());
    const days = (await this.#knownDays()).map((d) => ({ ...d, bytes: this.dayBytes(d.benchDir, d.deviceDir, d.day) }));
    let total = days.reduce((sum, d) => sum + d.bytes, 0);
    if (total <= this.maxTotalBytes) return 0;
    let removed = 0;
    // Oldest day first; the same day of several consoles in name order
    const oldestFirst = days.filter((d) => d.day < today).sort((a, b) => a.day.localeCompare(b.day) || a.benchDir.localeCompare(b.benchDir) || a.deviceDir.localeCompare(b.deviceDir));
    for (const d of oldestFirst) {
      if (total <= this.maxTotalBytes) break;
      await this.#removeDay(d);
      total -= d.bytes;
      removed += 1;
    }
    this.log.info(`journal: over its global cap, ${removed} day(s) removed, oldest first (${total} bytes left)`);
    return removed;
  }

  /** Record a day of a console in the table (its size as written so far); never throws */
  noteDay({ benchDir, deviceDir, day, bench, device, bytes }) {
    if (!this.days) return;
    this.days.record({ benchDir, deviceDir, day, bench, device, bytes, at: this.now() })
      .catch((err) => this.log.warn(`journal of ${bench}/${device}: the day was not recorded (${err.message})`));
  }

  /** A session name not used yet in that day's folder: the start time, then -2, -3… */
  claimSession(benchDir, deviceDir, day, ms) {
    const dir = this.store.dir('journal', benchDir, deviceDir, day);
    const base = clockOf(ms);
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      const key = `${benchDir}/${deviceDir}/${day}/${name}`;
      if (this.#claimed.has(key) || fs.existsSync(path.join(dir, `${name}.json`)) || fs.existsSync(path.join(dir, `${name}.log`))) continue;
      this.#claimed.add(key);
      return name;
    }
  }

  /** Bytes already written by every session of a device's day (the cap is per day) */
  dayBytes(benchDir, deviceDir, day) {
    let dir;
    try { dir = this.store.resolve('journal', benchDir, deviceDir, day); } catch { return 0; }
    let total = 0;
    for (const f of readDir(dir)) {
      if (!f.endsWith('.log')) continue;
      try { total += fs.statSync(path.join(dir, f)).size; } catch { /* removed meanwhile */ }
    }
    return total;
  }
}

class JournalWriter {
  #pending = [];
  #pendingBytes = 0;
  #timer = null;
  #chain = Promise.resolve();
  #day = null;
  #session = null;     // the file of the current day
  #bytes = 0;          // bytes of the device's day, every session included
  #fileBytes = 0;      // bytes in the current file
  #stopped = false;    // the day's cap reached
  #closed = false;
  #seen = new Set();   // 'a:<id>' / 'p:<id>' already in the current sidecar
  #people = new Map(); // 'a:<id>' / 'p:<id>' → user, for the whole session (carried past midnight)
  #teams = new Set();  // teams already in the current sidecar
  #metaAt = 0;         // last time the sidecar's size was written

  constructor(journal, { bench, device, target }) {
    this.j = journal;
    this.bench = bench;
    this.device = device;
    this.target = target;
    this.benchDir = journal.store.safeName(bench, 'bench');
    this.deviceDir = journal.store.safeName(device, 'device');
  }

  /** Bytes the device sent */
  output(buf) {
    if (this.#closed || !buf?.length) return;
    this.#queue(Buffer.from(buf));
  }

  /** A line of our own in the journal: who took the keyboard, a task, the end of the session */
  mark(text) {
    if (this.#closed) return;
    this.#queue(Buffer.from(`\r\n--- ${timeOf(this.j.now())} ${text} ---\r\n`));
    this.#noteTeam();
  }

  /** Someone attached to the console (recorded once per file) */
  attended(user) { this.#remember('a', user); }

  /** Someone held the keyboard (recorded once per file) */
  piloted(user) { this.#remember('p', user); }

  /** Write what is pending and stop; resolves when it is on disk */
  close() {
    if (this.#closed) return this.#chain;
    this.#flush(true);
    if (this.#day) this.#touchMeta((m) => { m.ended = new Date(this.j.now()).toISOString(); });
    this.#closed = true;
    return this.#chain;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The current day's file: a new one at the first write and after midnight */
  #today() {
    const day = dayOf(this.j.now());
    if (day !== this.#day) {
      if (this.#day) {
        this.#flush(true);    // what was pending belongs to the previous day
        this.#touchMeta((m) => { m.ended = new Date(this.j.now()).toISOString(); });
      }
      this.#day = day;
      this.#session = this.j.claimSession(this.benchDir, this.deviceDir, day, this.j.now());
      this.#seen.clear();
      this.#teams.clear();
      this.#bytes = this.j.dayBytes(this.benchDir, this.deviceDir, day);
      this.#fileBytes = 0;
      this.#stopped = this.#bytes >= this.j.maxBytesPerDay;
      const started = new Date(this.j.now()).toISOString();
      this.#touchMeta((m) => { m.started ??= started; });
      this.#noteDay();
      // The people already on the session are on its continuation too
      for (const [key, user] of this.#people) this.#record(key, user);
      this.#noteTeam();
    }
    return day;
  }

  #queue(buf) {
    this.#today();
    if (this.#stopped) return;
    const room = this.j.maxBytesPerDay - this.#bytes - this.#pendingBytes;
    if (buf.length > room) {
      if (room > 0) this.#push(buf.subarray(0, room));
      this.#push(Buffer.from(`\r\n--- ${timeOf(this.j.now())} journal stopped: size limit for the day reached ---\r\n`), true);
      this.#stopped = true;
      this.#touchMeta((m) => { m.truncated = true; });
      return this.#flush(true);
    }
    this.#push(buf);
    if (this.#pendingBytes >= FLUSH_BYTES) return this.#flush();
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flush(), FLUSH_MS);
      this.#timer.unref?.();
    }
  }

  #push(buf, overCap = false) {
    this.#pending.push(buf);
    if (!overCap) this.#pendingBytes += buf.length;
  }

  /** Append what is pending; the sidecar's size follows every 10 s (or now, when `force`) */
  #flush(force = false) {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#pending.length || !this.#day) return this.#chain;
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#bytes += this.#pendingBytes;
    this.#fileBytes += data.length;
    this.#pendingBytes = 0;
    const { log } = this.j.paths(this.benchDir, this.deviceDir, this.#day, this.#session);
    this.#chain = this.#chain
      // The folder was made when the day started; it is made again only while the data
      // directory itself exists (a write that lands after a test's tear-down creates nothing)
      .then(() => fs.promises.appendFile(log, data, { mode: 0o600 }).catch(async (err) => {
        if (err.code !== 'ENOENT' || !fs.existsSync(this.j.store.root)) throw err;
        await fs.promises.mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(log, data, { mode: 0o600 });
      }))
      .catch((err) => this.j.log.warn(`journal of ${this.bench}/${this.device}: ${err.message}`));
    if (force || this.j.now() - this.#metaAt >= 10_000) {
      this.#metaAt = this.j.now();
      const total = this.#fileBytes;
      this.#touchMeta((m) => { m.bytes = total; });
      this.#noteDay();
    }
    return this.#chain;
  }

  /** The day's row in the table, with the size written so far */
  #noteDay() {
    this.j.noteDay({ benchDir: this.benchDir, deviceDir: this.deviceDir, day: this.#day, bench: this.bench, device: this.device, bytes: this.#bytes });
  }

  #remember(kind, user) {
    if (this.#closed || !user?.id) return;
    const key = `${kind}:${user.id}`;
    this.#people.set(key, user);
    this.#today();
    this.#record(key, user);
    this.#noteTeam();
  }

  /** Put a person in the current sidecar (once) */
  #record(key, user) {
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const at = new Date(this.j.now()).toISOString();
    this.#touchMeta((m) => {
      const list = key.startsWith('a:') ? (m.attended ??= {}) : (m.pilots ??= {});
      list[user.id] ??= { ...person(user), first: at };
    });
  }

  /** The team holding the bench now, in the current sidecar (once) */
  #noteTeam() {
    if (!this.#day) return;
    let team = null;
    try { team = this.j.teamOf(this.bench); } catch { /* the teams service failed: nothing to add */ }
    if (!team || this.#teams.has(team)) return;
    this.#teams.add(team);
    this.#touchMeta((m) => { if (!m.teams.includes(team)) m.teams.push(team); });
  }

  /** Change the current sidecar (serialized by the store) */
  #touchMeta(fn) {
    if (!this.#day) return this.#chain;
    const { meta } = this.j.paths(this.benchDir, this.deviceDir, this.#day, this.#session);
    const fresh = {
      bench: this.bench, device: this.device, target: this.target, day: this.#day, session: this.#session,
      started: null, ended: null, attended: {}, pilots: {}, teams: [], bytes: 0, truncated: false,
    };
    const written = this.j.store.json(meta, fresh).update((m) => {
      m.teams ??= [];
      fn(m);
      return m;
    }).catch((err) => this.j.log.warn(`journal of ${this.bench}/${this.device}: ${err.message}`));
    this.#chain = this.#chain.then(() => written);
    return written;
  }
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}
