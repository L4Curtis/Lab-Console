/**
 * Console journal: what each device printed, session by session, with who was there
 *
 *   data/journal/<bench>/<device>/<yyyy-mm-dd>/<hhmmss>.log    one console session's output, as
 *                                                               received, plus marker lines
 *   data/journal/<bench>/<device>/<yyyy-mm-dd>/<hhmmss>.json   its sidecar: who attached, who held the
 *                                                               keyboard, the teams that held the bench,
 *                                                               start, end, size, truncation
 *
 * One file per session (a line opened, used, closed), not per day: reading a
 * journal is allowed to the people who were on that session (attached or
 * piloting), to the teams that held the bench during it, and to admins (SPEC
 * "Lot rooms"). Someone who watched R1 for a minute in the afternoon reads
 * that afternoon's session, not what another team did on R1 in the morning.
 * A session that runs past midnight goes on in a new file of the new day,
 * whose sidecar starts with the people already on it. The sidecar is the
 * permission list, small and kept next to the output, so a check never parses
 * a log and the retention sweep removes both together.
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
 * (run daily).
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
   * @param retentionDays   days kept (today counts as one)
   * @param maxBytesPerDay  size cap of one device's day (all its sessions)
   * @param now             clock (tests)
   * @param teamOf          (benchName) => teamId | null: the team holding the bench now
   */
  constructor({ store, retentionDays = 14, maxBytesPerDay = 5 * 1024 * 1024, now = () => Date.now(), teamOf = () => null, logger }) {
    this.store = store;
    this.retentionDays = retentionDays;
    this.maxBytesPerDay = maxBytesPerDay;
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

  /** May `user` read this session? Admins, the people who were on it, the teams that held the bench during it */
  canRead(user, meta, teamOfUser = () => null) {
    if (!user || !meta) return false;
    if (user.role === 'admin') return true;
    if (meta.attended?.[user.id] || meta.pilots?.[user.id]) return true;
    const team = teamOfUser(user);
    return Boolean(team && (meta.teams ?? []).includes(team));
  }

  /** Every session, newest first: [{ benchDir, deviceDir, day, session, bench, device, from, to, bytes, truncated, meta }] */
  list() {
    const root = this.store.resolve('journal');
    const out = [];
    for (const benchDir of readDir(root)) {
      for (const deviceDir of readDir(path.join(root, benchDir))) {
        for (const day of readDir(path.join(root, benchDir, deviceDir)).filter((n) => DAY.test(n))) {
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
      }
    }
    return out.sort((a, b) => b.day.localeCompare(a.day) || b.session.localeCompare(a.session, 'en', { numeric: true })
      || a.bench.localeCompare(b.bench) || a.device.localeCompare(b.device));
  }

  /**
   * Delete the days older than the retention (every session of them), then
   * the folders left empty. Returns the number of sessions removed
   */
  sweep() {
    const oldest = dayOf(this.now() - (this.retentionDays - 1) * 86_400_000);
    let root;
    try { root = this.store.resolve('journal'); } catch { return 0; }
    let removed = 0;
    for (const benchDir of readDir(root)) {
      const benchPath = path.join(root, benchDir);
      for (const deviceDir of readDir(benchPath)) {
        const devicePath = path.join(benchPath, deviceDir);
        for (const name of readDir(devicePath)) {
          const day = /^(\d{4}-\d{2}-\d{2})(?:\.(?:log|json))?$/.exec(name)?.[1];
          if (!day || day >= oldest) continue;
          const full = path.join(devicePath, name);
          removed += name === day ? readDir(full).filter((f) => f.endsWith('.json')).length : Number(name.endsWith('.json'));
          fs.rmSync(full, { recursive: true, force: true });
        }
        if (!readDir(devicePath).length) fs.rmSync(devicePath, { recursive: true, force: true });
      }
      if (!readDir(benchPath).length) fs.rmSync(benchPath, { recursive: true, force: true });
    }
    if (removed) this.log.info(`journal: removed ${removed} session(s) older than ${oldest}`);
    return removed;
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
    }
    return this.#chain;
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
