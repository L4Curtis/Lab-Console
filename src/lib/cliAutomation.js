/**
 * Server-side automation of a device CLI over an existing console session:
 *   - exportRunningConfig(): Cisco `show running-config` with pagination bypass
 *   - injectScript():        paced, prompt-aware command injection
 *
 * It runs on the server, next to the SSH/telnet stream, rather than in the
 * browser: browsers throttle timers in background tabs (≈1/s), which would
 * wreck the pacing, and the server sees device output with no extra hop
 *
 * The session feeds every chunk of device output to feed(); the engine keeps
 * a cleaned copy (ANSI codes and \r removed, backspaces applied - which also
 * makes IOS's " --More-- " erase itself) and waits on it like `expect`
 * While a task runs, the session must ignore the student's keystrokes
 * (check `running`), so typed text can't interleave with injected lines
 */
const CISCO_PROMPT = /(?:^|\n)([A-Za-z0-9][\w.-]{0,62})(\(config[^)\n]*\))?([>#]) ?$/;
const ANY_PROMPT = /(?:^|\n)[^\n]{1,80}[>#$%] ?$/;          // Cisco, Linux (root@vm:~#), ASA…
const QUESTION = /(?:\?|\]|:|\(y\/n\)) ?$/i;                 // "[startup-config]? ", "Password: ", "[confirm]"
const BANNER_START = /End with the character '.'\.?\s*$/;    // IOS waits for the banner text
const DEVICE_ERROR = /^% [^\n]+/m;                            // "% Invalid input…", "% Incomplete command"
const SYSLOG_LINE = /^(?:\*?[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+\w+)?:\s*)?%[A-Z0-9_]+-\d-[A-Z0-9_]+:/;
const MORE = /--More--\s*$/;

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
  #moreAnswered = false;

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
      if (ch === '\b') { if (buf && !buf.endsWith('\n')) buf = buf.slice(0, -1); } else buf += ch;
    }
    this.#buf = buf.length > 2_000_000 ? buf.slice(-2_000_000) : buf;
    // Paging could not be disabled (or wasn't): answer each --More-- with a space, once
    if (this.#autoMore) {
      if (MORE.test(this.#buf.slice(-24))) {
        if (!this.#moreAnswered) { this.#moreAnswered = true; this.write(' '); }
      } else this.#moreAnswered = false;
    }
    this.#waiter?.poke();
  }

  // ── Feature 2: running-config export ──────────────────────────────────────

  /**
   * 1. find the prompt (and the hostname); leave config mode with `end`;
   *    refuse user mode (`>`): `show running-config` needs privilege 15
   * 2. `terminal length 0` so the device doesn't paginate
   * 3. `show running-config`, captured until the hostname# prompt returns -
   *    if paging couldn't be disabled, every --More-- is answered with a space
   * 4. restore `terminal length <restoreLength>` (24 = IOS default)
   */
  exportRunningConfig(progress = () => {}, { restoreLength = 24 } = {}) {
    return this.#run('export', async () => {
      progress('Looking for the device prompt', { code: 'automation.looking_for_prompt' });
      let p = await this.#findCiscoPrompt();
      if (p.configMode) {
        progress('Leaving configuration mode', { code: 'automation.leaving_config' });
        this.#clear(); this.write('end\r');
        p = await this.#findCiscoPrompt(false);
      }
      if (p.mark === '>') {
        throw new AutomationError(`${p.host} is in user mode (${p.host}>). Type "enable" to reach ${p.host}#, then export again.`, 'automation.user_mode', { host: p.host });
      }
      const promptAtEnd = new RegExp(`(?:^|\\n)${escapeRe(p.host)}# ?$`);

      progress('Turning paging off (terminal length 0)', { code: 'automation.paging_off' });
      this.#clear(); this.write('terminal length 0\r');
      await this.#waitFor((b) => promptAtEnd.test(b), { timeout: 6000 });
      const pagingOff = !DEVICE_ERROR.test(this.#buf);

      progress('Reading the running configuration', { code: 'automation.reading_config' });
      this.#autoMore = true; // safety net: some platforms (or old images) ignore terminal length
      this.#clear(); this.write('show running-config\r');
      const complete = await this.#waitFor((b) => promptAtEnd.test(b), { timeout: 180_000, idle: 20_000, settle: 400 });
      this.#autoMore = false;
      const captured = this.#buf;

      if (pagingOff) {
        progress(`Restoring paging (terminal length ${restoreLength})`, { code: 'automation.restoring_paging', params: { length: restoreLength } });
        this.#clear(); this.write(`terminal length ${restoreLength}\r`);
        await this.#waitFor((b) => promptAtEnd.test(b), { timeout: 6000 });
      }
      if (!complete) throw new AutomationError('The device stopped sending before the end of the configuration. Nothing was saved.', 'automation.device_stopped');

      const config = cleanRunningConfig(captured, promptAtEnd);
      const deviceError = config.match(DEVICE_ERROR);
      if (!/^(version|hostname|end)\b/m.test(config)) {
        throw deviceError
          ? new AutomationError(`The device answered: ${deviceError[0]}`, 'automation.device_answered', { detail: deviceError[0] })
          : new AutomationError('The output does not look like a running configuration.', 'automation.not_a_config');
      }
      return { hostname: p.host, config, pagingFallback: !pagingOff };
    });
  }

  // ── Feature 3: paced script injection ─────────────────────────────────────

  /**
   * Sends a script line by line, like a careful human:
   *   - each line is typed in small chunks (`chunkBytes` every `chunkDelayMs`),
   *     so even a long line never overruns a small console input buffer;
   *   - with `waitForPrompt`, the next line goes only once the device has
   *     answered with a prompt (or a question such as "[confirm]" or
   *     "Destination filename [startup-config]?"); a line that gets no
   *     answer within `lineTimeoutMs` is reported as slow and the script moves on;
   *   - `delayMs` is added between lines (≈ the classic "paste with delay");
   *   - device errors ("% Invalid input…") are collected with their line numbers,
   *     and optionally stop the script
   * Multi-line `banner motd #…#` blocks are handled: until the closing
   * delimiter the device prints no prompt, so those lines use the delay only
   */
  injectScript(script, options = {}, progress = () => {}) {
    const o = {
      waitForPrompt: true, delayMs: 50, stopOnError: false, skipComments: true,
      lineTimeoutMs: 8000, chunkBytes: 32, chunkDelayMs: 40, ...options,
    };
    const lines = parseScript(script, o.skipComments);
    return this.#run('inject', async () => {
      const errors = [];
      const slow = [];
      let bannerEnd = null; // delimiter character while inside a multi-line banner
      let sent = 0;
      for (const { n, text } of lines) {
        this.#checkCancelled();
        progress(`Sending line ${sent + 1} of ${lines.length}`, { done: sent, total: lines.length, code: 'automation.sending_line', params: { line: sent + 1, total: lines.length } });
        this.#clear();
        await this.#type(`${text}\r`, o);
        sent++;

        if (bannerEnd !== null) {
          if (text.includes(bannerEnd)) bannerEnd = null; // closing delimiter: the prompt comes back
          else { await this.#sleep(Math.max(o.delayMs, 50)); continue; }
        }
        if (o.waitForPrompt) {
          const answered = await this.#waitFor(answeredAfterEcho, { timeout: o.lineTimeoutMs, settle: 60 });
          const banner = this.#buf.match(/End with the character '(.)'/);
          if (banner) { bannerEnd = banner[1]; continue; }
          if (!answered) slow.push(n);
        } else {
          await this.#sleep(o.delayMs);
        }
        const err = this.#buf.match(DEVICE_ERROR);
        if (err) {
          errors.push({ line: n, command: text, message: err[0].trim() });
          if (o.stopOnError) break;
        }
        await this.#sleep(o.delayMs);
      }
      progress('Done', { done: sent, total: lines.length, code: 'automation.done' });
      // Left at a question after the last line? ("Destination filename [startup-config]?")
      const lastLine = this.#buf.split('\n').at(-1).trim();
      const waitingFor = QUESTION.test(lastLine) && !ANY_PROMPT.test(`\n${lastLine}`) ? lastLine : null;
      return { sent, total: lines.length, errors, slow, waitingFor, stoppedOnError: o.stopOnError && errors.length > 0 };
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async #run(task, fn) {
    if (this.#task) throw new AutomationError(`Another task (${this.#task}) is still running on this console.`, 'automation.busy_task', { task: this.#task });
    this.#task = task;
    this.#cancelled = false;
    this.#buf = '';
    this.onStart(task);
    try {
      return await fn();
    } finally {
      this.#task = null;
      this.#autoMore = false;
      this.#buf = '';
    }
  }

  async #findCiscoPrompt(nudge = true) {
    if (nudge) { this.#clear(); this.write('\r'); }
    const ok = await this.#waitFor((b) => CISCO_PROMPT.test(b), { timeout: 6000, settle: 150 });
    if (!ok) throw new AutomationError('No Cisco prompt answered. Log in to the device first (until you see a prompt such as R1# ), then try again.', 'automation.no_prompt');
    const [, host, configMode, mark] = this.#buf.match(CISCO_PROMPT);
    return { host, configMode: Boolean(configMode), mark };
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
   * Resolves true once test(buffer) holds and no new output came for `settle` ms;
   * false on `timeout` (or after `idle` ms without any output)
   */
  #waitFor(test, { timeout = 5000, settle = 80, idle = Infinity } = {}) {
    return new Promise((resolve, reject) => {
      let settleTimer = null;
      let idleTimer = null;
      const finish = (fn, v) => { clearTimeout(timer); clearTimeout(settleTimer); clearTimeout(idleTimer); this.#waiter = null; fn(v); };
      const armIdle = () => {
        clearTimeout(idleTimer);
        if (idle !== Infinity) idleTimer = setTimeout(() => finish(resolve, false), idle);
      };
      const timer = setTimeout(() => finish(resolve, test(this.#buf)), timeout);
      this.#waiter = {
        poke: () => {
          armIdle();
          clearTimeout(settleTimer);
          if (test(this.#buf)) settleTimer = setTimeout(() => { if (test(this.#buf)) finish(resolve, true); }, settle);
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

  #clear() { this.#buf = ''; }
  #checkCancelled() { if (this.#cancelled) throw new Cancelled(); }
}

/** The device answered a line: something after the echoed line ends in a prompt or a question */
function answeredAfterEcho(buf) {
  const nl = buf.indexOf('\n');
  if (nl < 0) return false;
  const after = buf.slice(nl);
  return ANY_PROMPT.test(after) || QUESTION.test(after) || BANNER_START.test(after);
}

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
  if (lines.length && promptAtEnd.test(`\n${lines.at(-1)}`)) lines.pop();
  lines = lines
    .map((l) => l.replace(/\s*--More--\s*/g, '').replace(/\s+$/, ''))
    .filter((l) => !SYSLOG_LINE.test(l));
  while (lines.length && (!lines[0].trim() || /^Building configuration/i.test(lines[0]))) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return `${lines.join('\n')}\n`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
