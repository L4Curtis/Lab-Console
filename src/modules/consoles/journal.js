/**
 * Console journal: what each device printed, day by day, with who was there
 *
 *   data/journal/<bench>/<device>/<yyyy-mm-dd>.log    device output, as received, plus marker lines
 *   data/journal/<bench>/<device>/<yyyy-mm-dd>.json   the sidecar: who attached, who held the keyboard,
 *                                                     the team that held the bench, size, truncation
 *
 * Why a sidecar: reading a journal is allowed to the people who were on the
 * console that day (attached or piloting), to the team that held the bench
 * while it was written, and to admins (SPEC "Lot rooms"). The sidecar is that
 * list, small and kept next to the output, so a permission check never
 * parses a log and the retention sweep removes both together.
 *
 * Output only, never keystrokes: what reaches the log is what the device
 * sent back. A password typed at "Password:" is not echoed by IOS, so it is
 * never written; what the device echoes (commands) is.
 *
 * Limits: one day of one device is capped at `maxBytesPerDay`; past it, one
 * marker line says the journal stopped, and nothing more is written that day.
 * `sweep()` deletes the days older than `retentionDays` (run daily).
 *
 * Writes are batched (a quarter of a second, or 64 KB) and appended to the
 * day's file, created with mode 0600 inside DATA_DIR.
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FLUSH_MS = 250;
const FLUSH_BYTES = 64 * 1024;

/** yyyy-mm-dd of a time, in the server's time zone (what the people in the room call "today") */
export function dayOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const timeOf = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${dayOf(ms)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const person = (u) => ({ name: u.name || u.username || u.id, username: u.username || '' });

export class ConsoleJournal {
  /**
   * @param store           the platform store
   * @param retentionDays   days kept (today counts as one)
   * @param maxBytesPerDay  size cap of one device's day
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

  /** A writer for one console line: { output(buf), mark(text), attended(user), piloted(user), close() } */
  open({ bench, device, target }) {
    return new JournalWriter(this, { bench, device, target });
  }

  /** Where a day of a device lives: { log, meta: ['journal', b, d, day.json] } (names already safe) */
  paths(benchDir, deviceDir, day) {
    if (!DAY.test(day)) throw Object.assign(new Error('Bad day'), { code: 'store.path' });
    return {
      log: this.store.resolve('journal', benchDir, deviceDir, `${day}.log`),
      meta: ['journal', benchDir, deviceDir, `${day}.json`],
    };
  }

  /** The sidecar of a day (null when there is none) */
  meta(benchDir, deviceDir, day) {
    const { meta } = this.paths(benchDir, deviceDir, day);
    try {
      return JSON.parse(fs.readFileSync(this.store.resolve(...meta), 'utf8'));
    } catch {
      return null;
    }
  }

  /** May `user` read this day? Admins, the people who were there, the team that held the bench */
  canRead(user, meta, teamOfUser = () => null) {
    if (!user || !meta) return false;
    if (user.role === 'admin') return true;
    if (meta.attended?.[user.id] || meta.pilots?.[user.id]) return true;
    const team = teamOfUser(user);
    return Boolean(team && (meta.teams ?? []).includes(team));
  }

  /** Every journal day, newest first: [{ benchDir, deviceDir, day, bench, device, bytes, truncated, meta }] */
  list() {
    const root = this.store.resolve('journal');
    const out = [];
    for (const benchDir of readDir(root)) {
      for (const deviceDir of readDir(path.join(root, benchDir))) {
        for (const file of readDir(path.join(root, benchDir, deviceDir))) {
          const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
          if (!m) continue;
          const meta = this.meta(benchDir, deviceDir, m[1]);
          if (!meta) continue;
          // The file itself says how big it is now (the sidecar follows every few seconds)
          let bytes = meta.bytes ?? 0;
          try { bytes = fs.statSync(path.join(root, benchDir, deviceDir, `${m[1]}.log`)).size; } catch { /* output not written yet */ }
          out.push({ benchDir, deviceDir, day: m[1], bench: meta.bench, device: meta.device, bytes, truncated: Boolean(meta.truncated), meta });
        }
      }
    }
    return out.sort((a, b) => b.day.localeCompare(a.day) || a.bench.localeCompare(b.bench) || a.device.localeCompare(b.device));
  }

  /**
   * Delete the days older than the retention (both files), then the folders
   * left empty. Returns the number of days removed
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
        for (const file of readDir(devicePath)) {
          const m = /^(\d{4}-\d{2}-\d{2})\.(log|json)$/.exec(file);
          if (!m || m[1] >= oldest) continue;
          fs.rmSync(path.join(devicePath, file), { force: true });
          if (m[2] === 'json') removed++;
        }
        if (!readDir(devicePath).length) fs.rmSync(devicePath, { recursive: true, force: true });
      }
      if (!readDir(benchPath).length) fs.rmSync(benchPath, { recursive: true, force: true });
    }
    if (removed) this.log.info(`journal: removed ${removed} day(s) older than ${oldest}`);
    return removed;
  }
}

class JournalWriter {
  #pending = [];
  #pendingBytes = 0;
  #timer = null;
  #chain = Promise.resolve();
  #day = null;
  #bytes = 0;          // bytes in today's file
  #stopped = false;    // today's cap reached
  #closed = false;
  #seen = new Set();   // 'a:<id>' / 'p:<id>' already in today's sidecar
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
  }

  /** Someone attached to the console (recorded once per day) */
  attended(user) { this.#remember('a', user); }

  /** Someone held the keyboard (recorded once per day) */
  piloted(user) { this.#remember('p', user); }

  /** Write what is pending and stop; resolves when it is on disk */
  close() {
    if (this.#closed) return this.#chain;
    this.#flush(true);
    this.#closed = true;
    return this.#chain;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #today() {
    const day = dayOf(this.j.now());
    if (day !== this.#day) {
      this.#flush(true);      // what was pending belongs to the previous day
      this.#day = day;
      this.#seen.clear();
      this.#stopped = false;
      const { log } = this.j.paths(this.benchDir, this.deviceDir, day);
      try { this.#bytes = fs.statSync(log).size; } catch { this.#bytes = 0; }
      this.#stopped = this.#bytes >= this.j.maxBytesPerDay;
      this.#touchMeta(() => {});
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
    this.#pendingBytes = 0;
    const { log } = this.j.paths(this.benchDir, this.deviceDir, this.#day);
    const total = this.#bytes;
    this.#chain = this.#chain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(log, data, { mode: 0o600 });
      })
      .catch((err) => this.j.log.warn(`journal of ${this.bench}/${this.device}: ${err.message}`));
    if (force || this.j.now() - this.#metaAt >= 10_000) {
      this.#metaAt = this.j.now();
      this.#touchMeta((m) => { m.bytes = total; });
    }
    return this.#chain;
  }

  #remember(kind, user) {
    if (this.#closed || !user?.id) return;
    this.#today();
    const key = `${kind}:${user.id}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const team = kind === 'a' ? this.j.teamOf(this.bench) : null;
    this.#touchMeta((m) => {
      const list = kind === 'a' ? (m.attended ??= {}) : (m.pilots ??= {});
      list[user.id] ??= { ...person(user), first: new Date(this.j.now()).toISOString() };
      if (team && !m.teams.includes(team)) m.teams.push(team);
    });
  }

  /** Change today's sidecar (serialized by the store) */
  #touchMeta(fn) {
    if (!this.#day) return;
    const { meta } = this.j.paths(this.benchDir, this.deviceDir, this.#day);
    const fresh = { bench: this.bench, device: this.device, target: this.target, day: this.#day, attended: {}, pilots: {}, teams: [], bytes: 0, truncated: false };
    this.j.store.dir('journal', this.benchDir, this.deviceDir);
    const written = this.j.store.json(meta, fresh).update((m) => {
      m.teams ??= [];
      fn(m);
      return m;
    }).catch((err) => this.j.log.warn(`journal of ${this.bench}/${this.device}: ${err.message}`));
    this.#chain = this.#chain.then(() => written);
  }
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}
