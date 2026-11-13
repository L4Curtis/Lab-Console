/**
 * Server-side automation of a device CLI over an existing console session.
 *
 * Two layers live here:
 *   1. A small step API that device drivers (src/lib/drivers/) compose:
 *        perform(label, fn)   take the keyboard: the one exclusive task on this line
 *        command(cmd, opts)   run a command, capture its output, answer --More--
 *        wait / expect        wait for a pattern (timeout, idle, settle)
 *        waitQuiet(ms)        wait until the device stops printing
 *        answer / type / send / sendLine / pause / reset / findPrompt
 *        cancel()             stop the running task (steps throw `cancelled`)
 *      Every step runs inside perform(): output is only captured while a
 *      task runs, so a step outside one would wait for nothing.
 *   2. Two features expressed on those steps, each in two forms: a step that
 *      runs inside a task a driver already holds (readRunningConfig,
 *      sendScript) and the standalone task the console tile uses
 *      (exportRunningConfig, injectScript).
 *
 * It runs on the server, next to the SSH/telnet stream, rather than in the
 * browser: browsers throttle timers in background tabs (≈1/s), which would
 * wreck the pacing, and the server sees device output with no extra hop.
 *
 * The session feeds every chunk of device output to feed(); the engine keeps
 * a cleaned copy (ANSI codes and \r removed, backspaces applied - which also
 * makes IOS's " --More-- " erase itself) and waits on it like `expect`.
 * While a task runs, the session must ignore the student's keystrokes
 * (check `running`), so typed text can't interleave with injected lines.
 *
 * Console syslog: without `logging synchronous`, IOS prints syslog lines
 * wherever the cursor is, including right after a prompt or a " --More-- "
 * marker (IOS XE does it constantly while it boots and runs PnP). Prompt
 * checks therefore look at the screen with trailing syslog lines removed
 * (screenTail), and the pager answers every --More-- it has not answered yet,
 * wherever it sits in the buffer.
 */
const CISCO_PROMPT = /(?:^|\n)([A-Za-z0-9][\w.-]{0,62})(\([\w.-]{1,40}\))?([>#]) ?$/; // R1> R1# R1(config-if)# R1(dhcp-config)#
const ANY_PROMPT = /(?:^|\n)[^\n]{1,80}[>#$%] ?$/;          // Cisco, Linux (root@vm:~#), ASA…
const QUESTION = /(?:\?|\]|:|\(y\/n\)) ?$/i;                 // "[startup-config]? ", "Password: ", "[confirm]"
const BANNER_START = /End with the character '.'\.?\s*$/;    // IOS waits for the banner text
// "% Invalid input…", "% Incomplete command", "%Error opening…", "Command rejected: …". IOS also prints
// informational lines that start with "% " ("% The key modulus size is 1024 bits", "% Generating 1024
// bit RSA keys…", "% Access VLAN does not exist. Creating vlan 10"): those are not errors.
const INFO_LINES = 'The key modulus size is|Generating \\d+ bit RSA keys|You already have RSA keys defined|Access VLAN does not exist\\. Creating vlan|Applying VLAN changes';
const DEVICE_ERROR = new RegExp(`^(?:% (?!${INFO_LINES})[^\\n]+|%Error[^\\n]*|Command rejected[^\\n]*|VTP VLAN configuration not allowed[^\\n]*)`, 'm');
// The stamp of a console syslog line, each optional: a sequence number, then a date ("*Nov 12
// 22:23:19.054", "Mar  1 00:00:52 UTC") or an uptime ("00:00:42", "1d02h", "2w3d": `service
// timestamps log uptime`, the classic switches' factory default), with an optional '*' or '.'
// (clock not authoritative / lost): "000045: Mar  1 00:00:52 UTC: %LINK-3-UPDOWN: …", "%PNP-6-…: …"
const SYSLOG_LINE = /^(?:\d+: )?(?:[*.]?(?:[A-Z][a-z]{2}\s+\d+\s+(?:\d{4}\s+)?\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d+[wd]\d+[dh])(?:\s+\w+)?:\s*)?%[A-Z0-9_]+-\d-[A-Z0-9_]+:/;
// %SYS-5-RESTART is followed by the software banner, on lines of their own that are part of the message
const RESTART_HEAD = /%SYS-5-RESTART:/;
const RESTART_MORE = /^(?:Cisco IOS Software|Cisco IOS XE Software|Technical Support: |Copyright \(c\) |Compiled \S+ \S+ \S+ by )/;
const MORE_MARK = /--More--/g;

const DEFAULT_TYPING = { chunkBytes: 32, chunkDelayMs: 40 };

/** `code` and `params` let the browser show the message in the user's language (the sentence stays English) */
export class AutomationError extends Error {
  constructor(message, code = null, params = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}
class Cancelled extends AutomationError {
  constructor() { super('Stopped', 'automation.stopped'); this.cancelled = true; }
}

export class CliAutomation {
  #buf = '';
  #task = null;
  #cancelled = false;
  #waiter = null;
  #autoMore = false;
  #moreSeen = 0;      // --More-- markers received since the last reset
  #moreAnswered = 0;  // … and answered with a space
  #moreTail = '';     // end of the previous chunk, so a marker split across chunks still counts
  #erase = null;      // IOS's erase of an answered marker, when it would hit other text: { phase, n }

  /**
   * @param write   (text) => void - raw bytes to the device, bypassing the student lock
   * @param onStart called when a task starts (e.g. to switch off auto-login / wake-up)
   */
  constructor({ write, onStart = () => {} }) {
    this.write = write;
    this.onStart = onStart;
  }

  get running() { return this.#task; }

  cancel() {
    if (!this.#task) return;
    this.#cancelled = true;
    this.#waiter?.fail(new Cancelled());
  }

  /** Every chunk of device output (decoded text) */
  feed(text) {
    if (!this.#task) return;
    const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\x1b[=>]/g, '').replace(/[\r\0\x07]/g, '');
    let buf = this.#buf;
    for (const ch of clean) {
      if (this.#erase && this.#skipErase(ch)) {
        // The marker's own line goes away and the next page starts on a line of its own
        if (this.#erase?.phase === 'start') buf = `${buf.replace(/ ?--More-- ?\n?(?![\s\S]*--More--)/, '').replace(/([^\n])$/, '$1\n')}`;
        continue;
      }
      if (ch === '\b') { if (buf && !buf.endsWith('\n')) buf = buf.slice(0, -1); } else buf += ch;
    }
    this.#buf = buf.length > 2_000_000 ? buf.slice(-2_000_000) : buf;
    // Paging could not be disabled (or wasn't): answer each --More-- with a space, once.
    // Markers are counted in the raw stream, not looked for at the end of the
    // buffer: syslog lines may land after a marker before it is answered.
    if (this.#autoMore) {
      const scan = this.#moreTail + clean;
      let end = 0;
      for (const m of scan.matchAll(MORE_MARK)) { this.#moreSeen++; end = m.index + m[0].length; }
      this.#moreTail = scan.slice(Math.max(end, scan.length - 7));
      if (this.#moreSeen > this.#moreAnswered) {
        this.#moreAnswered = this.#moreSeen;
        this.#erase = { phase: 'armed', n: 0 };
        this.write(' ');
      }
    }
    this.#waiter?.poke();
  }

  // ── Composable steps: the public API drivers build on ─────────────────────

  /** Take the keyboard and run `fn(this)` as the one exclusive task on this line. */
  perform(label, fn) {
    return this.#run(label, () => fn(this));
  }

  /** The cleaned output captured so far (ANSI / CR stripped, backspaces applied). */
  get buffer() { return this.#buf; }

  /** True once cancel() has been called on the running task. */
  get cancelled() { return this.#cancelled; }

  /** Throw immediately if the task was cancelled (for use between manual steps). */
  throwIfCancelled() { this.#checkCancelled(); }

  /** Forget everything captured so far. Call before sending a command whose output you capture. */
  reset() { this.#clear(); }

  /** Send `text` to the device at once (no pacing). */
  send(text = '') { this.#needTask(); this.write(text); }

  /** Send `text` + Enter at once. */
  sendLine(text = '') { this.#needTask(); this.write(`${text}\r`); }

  /** Type `text` in small chunks so a slow console's input buffer never overflows. */
  async type(text, opts = {}) {
    this.#needTask();
    await this.#type(text, { ...DEFAULT_TYPING, ...opts });
  }

  /** Answer a prompt with `text` + Enter, paced (safe on a slow console). */
  async answer(text = '', opts = {}) {
    this.#needTask();
    await this.#type(`${text}\r`, { ...DEFAULT_TYPING, ...opts });
  }

  /** Pause for `ms`; rejects with a cancelled error if the task is cancelled meanwhile. */
  pause(ms) { this.#needTask(); return this.#sleep(ms); }

  /**
   * Wait until `pattern` (a RegExp or a `(buffer) => boolean` predicate) holds
   * and output has settled. Resolves the RegExp match (or `true` for a
   * predicate); throws on timeout or idle unless `optional`, which resolves `null`.
   * Options: timeout (ms, default 5000), idle (ms without any output, default
   * none), settle (ms of silence once the pattern holds, default 80).
   */
  async wait(pattern, { optional = false, ...opts } = {}) {
    this.#needTask();
    const outcome = await this.#waitFor(asTest(pattern), opts);
    if (outcome !== 'match') {
      if (optional) return null;
      throw new AutomationError('Timed out waiting for the device.', 'automation.timeout');
    }
    return pattern instanceof RegExp ? this.#buf.match(pattern) || true : true;
  }

  /**
   * Wait until the device has printed nothing for `ms`. Resolves true then,
   * or false if output was still arriving after `timeout` (a booting device).
   */
  async waitQuiet(ms, { timeout = ms * 4 } = {}) {
    this.#needTask();
    return (await this.#waitFor(() => false, { timeout, idle: ms })) === 'idle';
  }

  /**
   * Wait for whichever of `patterns` ({ name: RegExp | predicate }) holds first
   * and resolve `{ name, match, buffer, outcome }`. When nothing matched, `name`
   * is null and `outcome` says why ('timeout' or 'idle'): the caller decides
   * whether an unrecognised state is an error. Patterns are tried in insertion
   * order, so put the most specific first.
   */
  async expect(patterns, opts = {}) {
    this.#needTask();
    const entries = Object.entries(patterns).map(([name, p]) => [name, p, asTest(p)]);
    const hit = (b) => entries.find(([, , test]) => test(b));
    const outcome = await this.#waitFor((b) => Boolean(hit(b)), opts);
    const found = outcome === 'match' ? hit(this.#buf) : null;
    if (!found) return { name: null, match: null, buffer: this.#buf, outcome: outcome === 'match' ? 'timeout' : outcome };
    const [name, p] = found;
    return { name, match: p instanceof RegExp ? this.#buf.match(p) : null, buffer: this.#buf, outcome: 'match' };
  }

  /**
   * Run `cmd`, capturing its output until `until` (default: a Cisco prompt at
   * the end of the screen, trailing syslog lines ignored), with --More-- pager
   * handling on by default. Returns `{ output, complete, outcome }` where
   * `complete` is false if `until` never held within the budget.
   */
  async command(cmd, { until = (b) => CISCO_PROMPT.test(screenTail(b)), paging = true, pace = false, timeout = 180_000, idle = 20_000, settle = 400 } = {}) {
    this.#needTask();
    this.#clear();
    this.#autoMore = paging;
    try {
      if (pace) await this.#type(`${cmd}\r`, DEFAULT_TYPING);
      else this.write(`${cmd}\r`);
      const outcome = await this.#waitFor(asTest(until), { timeout, idle, settle });
      return { output: this.#buf, complete: outcome === 'match', outcome };
    } finally {
      this.#autoMore = false;
    }
  }

  /**
   * Find the Cisco prompt and the hostname: `{ host, configMode, mark }`.
   * With `nudge`, an Enter is sent first. Throws when no prompt answers.
   */
  async findPrompt({ nudge = true, timeout = 6000 } = {}) {
    this.#needTask();
    if (nudge) { this.#clear(); this.write('\r'); }
    const ok = await this.#waitFor((b) => CISCO_PROMPT.test(screenTail(b)), { timeout, settle: 150 });
    if (ok !== 'match') throw new AutomationError('No Cisco prompt answered. Log in to the device first (until you see a prompt such as R1# ), then try again.');
    const [, host, configMode, mark] = screenTail(this.#buf).match(CISCO_PROMPT);
    return { host, configMode: Boolean(configMode), mark };
  }

  // ── Feature: running-config export ────────────────────────────────────────

  /** The standalone task behind the console tile's "Export config" button. */
  exportRunningConfig(progress = () => {}, opts = {}) {
    return this.perform('export', () => this.readRunningConfig(progress, opts));
  }

  /**
   * Step (inside a task):
   * 1. find the prompt (and the hostname); leave config mode with `end`;
   *    refuse user mode (`>`): `show running-config` needs privilege 15
   * 2. `terminal length 0` so the device doesn't paginate
   * 3. `show running-config`, captured until the hostname# prompt returns -
   *    if paging couldn't be disabled, every --More-- is answered with a space
   * 4. restore `terminal length <restoreLength>` (24 = IOS default)
   */
  async readRunningConfig(progress = () => {}, { restoreLength = 24 } = {}) {
    progress('Looking for the device prompt');
    let p = await this.findPrompt();
    if (p.configMode) {
      progress('Leaving configuration mode');
      this.reset(); this.sendLine('end');
      p = await this.findPrompt({ nudge: false });
    }
    if (p.mark === '>') {
      throw new AutomationError(`${p.host} is in user mode (${p.host}>). Type "enable" to reach ${p.host}#, then export again.`);
    }
    const promptAtEnd = new RegExp(`(?:^|\\n)${escapeRe(p.host)}# ?$`);
    const atPrompt = (b) => promptAtEnd.test(screenTail(b));

    progress('Turning paging off (terminal length 0)');
    const off = await this.command('terminal length 0', { until: atPrompt, paging: false, timeout: 6000, idle: Infinity, settle: 80 });
    const pagingOff = !DEVICE_ERROR.test(off.output);

    progress('Reading the running configuration');
    // Safety net: some platforms (or old images) ignore terminal length, so keep the --More-- answerer on.
    const run = await this.command('show running-config', { until: atPrompt, paging: true, timeout: 180_000, idle: 20_000, settle: 400 });

    if (pagingOff) {
      progress(`Restoring paging (terminal length ${restoreLength})`);
      await this.command(`terminal length ${restoreLength}`, { until: atPrompt, paging: false, timeout: 6000, idle: Infinity, settle: 80 });
    }
    if (!run.complete) throw new AutomationError('The device stopped sending before the end of the configuration. Nothing was saved.');

    const config = cleanRunningConfig(run.output, promptAtEnd);
    const deviceError = config.match(DEVICE_ERROR);
    if (!/^(version|hostname|end)\b/m.test(config)) {
      throw new AutomationError(deviceError ? `The device answered: ${deviceError[0]}` : 'The output does not look like a running configuration.');
    }
    return { hostname: p.host, config, pagingFallback: !pagingOff };
  }

  // ── Feature: paced script injection ───────────────────────────────────────

  /** The standalone task behind the console tile's "Send a script" dialog. */
  injectScript(script, options = {}, progress = () => {}) {
    return this.perform('inject', () => this.sendScript(script, options, progress));
  }

  /**
   * Step (inside a task). Sends a script line by line, like a careful human:
   *   - each line is typed in small chunks (`chunkBytes` every `chunkDelayMs`),
   *     so even a long line never overruns a small console input buffer;
   *   - with `waitForPrompt`, the next line goes only once the device has
   *     answered with a prompt (or a question such as "[confirm]" or
   *     "Destination filename [startup-config]?"); a line that gets no
   *     answer within `lineTimeoutMs` is reported as slow and the script moves on;
   *   - `lineTimeouts` ({ [line number]: ms }) gives some lines a longer budget than
   *     `lineTimeoutMs` (RSA key generation: see toReplayScript's `lineTimeouts`);
   *   - `delayMs` is added between lines (≈ the classic "paste with delay");
   *   - device errors ("% Invalid input…") are collected with their line numbers,
   *     and optionally stop the script
   * Multi-line `banner motd #…#` blocks are handled: until the closing
   * delimiter the device prints no prompt, so those lines use the delay only
   */
  async sendScript(script, options = {}, progress = () => {}) {
    this.#needTask();
    const o = {
      waitForPrompt: true, delayMs: 50, stopOnError: false, skipComments: true,
      lineTimeoutMs: 8000, chunkBytes: 32, chunkDelayMs: 40, ...options,
    };
    const lines = parseScript(script, o.skipComments);
    const errors = [];
    const slow = [];
    let bannerEnd = null; // delimiter character while inside a multi-line banner
    let sent = 0;
    for (const { n, text } of lines) {
      this.throwIfCancelled();
      progress(`Sending line ${sent + 1} of ${lines.length}`, { done: sent, total: lines.length });
      this.reset();
      await this.type(`${text}\r`, o);
      sent++;

      if (bannerEnd !== null) {
        if (text.includes(bannerEnd)) bannerEnd = null; // closing delimiter: the prompt comes back
        else { await this.pause(Math.max(o.delayMs, 50)); continue; }
      }
      if (o.waitForPrompt) {
        const timeout = Number(o.lineTimeouts?.[n]) > 0 ? Number(o.lineTimeouts[n]) : o.lineTimeoutMs;
        const answered = await this.wait(answeredAfterEcho, { timeout, settle: 60, optional: true });
        const banner = this.buffer.match(/End with the character '(.)'/);
        if (banner) { bannerEnd = banner[1]; continue; }
        if (!answered) slow.push(n);
      } else {
        await this.pause(o.delayMs);
      }
      const err = this.buffer.match(DEVICE_ERROR);
      if (err) {
        errors.push({ line: n, command: text, message: err[0].trim() });
        if (o.stopOnError) break;
      }
      await this.pause(o.delayMs);
    }
    progress('Done', { done: sent, total: lines.length });
    // Left at a question after the last line? ("Destination filename [startup-config]?")
    const lastLine = screenTail(this.buffer).split('\n').at(-1).trim();
    const waitingFor = QUESTION.test(lastLine) && !ANY_PROMPT.test(`\n${lastLine}`) ? lastLine : null;
    return { sent, total: lines.length, errors, slow, waitingFor, stoppedOnError: o.stopOnError && errors.length > 0 };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async #run(task, fn) {
    if (this.#task) throw new AutomationError(`Another task (${this.#task}) is still running on this console.`);
    this.#task = task;
    this.#cancelled = false;
    this.#clear();
    this.onStart(task);
    try {
      return await fn();
    } finally {
      this.#task = null;
      this.#autoMore = false;
      this.#clear();
    }
  }

  /** Types text in small chunks so the device's input buffer never overflows */
  async #type(text, { chunkBytes, chunkDelayMs }) {
    for (let i = 0; i < text.length; i += chunkBytes) {
      this.#checkCancelled();
      this.write(text.slice(i, i + chunkBytes));
      if (i + chunkBytes < text.length) await this.#sleep(chunkDelayMs);
    }
  }

  /**
   * Resolves 'match' once test(buffer) holds and no new output came for
   * `settle` ms; 'timeout' after `timeout` ms (or 'match' if the test holds
   * then), 'idle' after `idle` ms without any output
   */
  #waitFor(test, { timeout = 5000, settle = 80, idle = Infinity } = {}) {
    this.#checkCancelled();
    return new Promise((resolve, reject) => {
      let settleTimer = null;
      let idleTimer = null;
      const finish = (fn, v) => { clearTimeout(timer); clearTimeout(settleTimer); clearTimeout(idleTimer); this.#waiter = null; fn(v); };
      const armIdle = () => {
        clearTimeout(idleTimer);
        if (idle !== Infinity) idleTimer = setTimeout(() => finish(resolve, test(this.#buf) ? 'match' : 'idle'), idle);
      };
      const timer = setTimeout(() => finish(resolve, test(this.#buf) ? 'match' : 'timeout'), timeout);
      this.#waiter = {
        poke: () => {
          armIdle();
          clearTimeout(settleTimer);
          if (test(this.#buf)) settleTimer = setTimeout(() => { if (test(this.#buf)) finish(resolve, 'match'); }, settle);
        },
        fail: (err) => finish(reject, err),
      };
      armIdle();
      this.#waiter.poke();
    });
  }

  #sleep(ms) {
    return new Promise((resolve, reject) => {
      if (this.#cancelled) return reject(new Cancelled());
      const t = setTimeout(resolve, ms);
      this.#waiter = { poke() {}, fail: (e) => { clearTimeout(t); this.#waiter = null; reject(e); } };
    }).finally(() => { this.#waiter = null; });
  }

  /**
   * After a --More-- is answered, IOS erases it in place: N backspaces, N
   * spaces, N backspaces, wherever the cursor is. If syslog lines landed after
   * the marker, that erase would eat the end of the last one and glue the next
   * page to it. So the engine removes the marker itself, drops the erase
   * sequence (whatever N is) and starts the next page on a line of its own.
   * Returns true when `ch` was consumed.
   */
  #skipErase(ch) {
    const e = this.#erase;
    if (e.phase === 'armed') {
      if (ch !== '\b') return false; // syslog text before the erase: keep waiting for it
      e.phase = 'start'; e.n = 1;
      return true;
    }
    if (e.phase === 'start' || e.phase === 'back') {
      e.phase = 'back';
      if (ch === '\b') { e.n++; return true; }
      if (ch === ' ') {
        e.left = e.n - 1;
        e.phase = 'spaces';
        if (!e.left) { e.phase = 'back2'; e.left = e.n; }
        return true;
      }
      this.#erase = null; return false;
    }
    if (e.phase === 'spaces') {
      if (ch !== ' ') { this.#erase = null; return false; }
      if (--e.left === 0) { e.phase = 'back2'; e.left = e.n; }
      return true;
    }
    if (ch !== '\b') { this.#erase = null; return false; }
    if (--e.left === 0) this.#erase = null;
    return true;
  }

  #clear() {
    this.#buf = '';
    this.#moreSeen = 0;
    this.#moreAnswered = 0;
    this.#moreTail = '';
    this.#erase = null;
  }
  #checkCancelled() { if (this.#cancelled) throw new Cancelled(); }
  #needTask() {
    if (!this.#task) throw new AutomationError('A console step ran outside perform(): nothing would be captured.', 'automation.no_task');
  }
}

/** The device answered a line: something after the echoed line ends in a prompt or a question */
function answeredAfterEcho(buf) {
  const nl = buf.indexOf('\n');
  if (nl < 0) return false;
  const after = screenTail(buf.slice(nl));
  return ANY_PROMPT.test(after) || QUESTION.test(after) || BANNER_START.test(after);
}

/**
 * The screen as a person reads it: trailing syslog lines and blank lines
 * removed, so a prompt followed by "*Nov 12 …: %SYS-5-CONFIG_I: …" still ends
 * the text. The prompt line itself keeps its trailing space.
 */
export function screenTail(buf) {
  const lines = buf.split('\n');
  let end = lines.length;
  for (;;) {
    if (end > 1 && (!lines[end - 1].trim() || SYSLOG_LINE.test(lines[end - 1]))) { end--; continue; }
    // The lines that continue a %SYS-5-RESTART message ("Cisco IOS Software, …", "Compiled … by prod_rel_team")
    let head = end;
    while (head > 1 && RESTART_MORE.test(lines[head - 1])) head--;
    if (head < end && head > 1 && SYSLOG_LINE.test(lines[head - 1]) && RESTART_HEAD.test(lines[head - 1])) { end = head - 1; continue; }
    break;
  }
  return end === lines.length ? buf : lines.slice(0, end).join('\n');
}

/** True for a console syslog line ("*Nov 12 22:23:19.054: %SYS-5-CONFIG_I: …") */
export function isSyslogLine(line) { return SYSLOG_LINE.test(line); }

/** Patterns drivers reuse, so they agree with the engine on what a prompt or an error is */
export const patterns = Object.freeze({ CISCO_PROMPT, DEVICE_ERROR, SYSLOG_LINE });

/**
 * Script text → lines to send (original line numbers kept for error reports)
 * Blank lines ARE sent (as a bare Enter): that is how a script answers
 * "Destination filename [startup-config]?" or "[confirm]"; at a prompt an
 * extra Enter is harmless; Only the empty piece after the file's final
 * newline is dropped - it is a line terminator, not a blank line
 */
export function parseScript(script, skipComments = true) {
  const text = String(script).replace(/\r\n?/g, '\n');
  const raw = text.split('\n');
  if (text.endsWith('\n')) raw.pop();
  return raw
    .map((line, i) => ({ n: i + 1, text: line.replace(/\s+$/, '') }))
    .filter(({ text: t }) => !(skipComments && /^\s*!/.test(t)));
}

/** Raw captured `show running-config` output → the configuration file */
export function cleanRunningConfig(captured, promptAtEnd) {
  let lines = captured.split('\n');
  const echo = lines.findIndex((l) => /\bsh(ow)?\s+run/i.test(l));
  if (echo >= 0) lines = lines.slice(echo + 1);
  lines = lines
    .map((l) => l.replace(/\s*--More--\s*/g, '').replace(/\s+$/, ''))
    .filter((l) => !SYSLOG_LINE.test(l));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length && promptAtEnd.test(`\n${lines.at(-1)}`)) lines.pop();
  while (lines.length && (!lines[0].trim() || /^Building configuration/i.test(lines[0]))) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return `${lines.join('\n')}\n`;
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A RegExp or a predicate, as a predicate */
function asTest(pattern) {
  if (pattern instanceof RegExp) return (b) => pattern.test(b);
  if (typeof pattern === 'function') return pattern;
  throw new AutomationError('A wait pattern must be a RegExp or a predicate function.', 'automation.bad_pattern');
}
