/**
 * One terminal = one ConsoleSession = one SSH connection to the jump server
 * running exactly one command: `telnet <host> <port>`
 *
 * Why `exec` instead of an interactive shell (as the old draft did):
 *   - The student never gets a shell on the jump server; When telnet exits
 *     (device closes the line, network error…), the SSH channel closes with it
 *   - No prompt-scraping to know when the shell is ready; no stray commands
 *
 * The telnet escape character (Ctrl+]) is filtered from student input so the
 * `telnet>` command mode - which can spawn a local shell with `!` on many
 * clients - is unreachable. The server uses it itself, only to send a BREAK
 * (needed for Cisco password recovery / ROMMON)
 *
 * Events:  'data' (Buffer) · 'status' ({phase, message, code, params}) · 'close' ({reason, code, info})
 *
 * Texts meant for the student come with a stable message `code` and its `params`
 * next to the English sentence; the browser translates by code. On 'close', `code`
 * is the telnet exit code and `info` is { code, params } of the reason
 */
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { Client } from 'ssh2';
import { sshConnectOptions, sshErrorInfo } from '../../lib/ssh.js';
import { CliAutomation } from '../../lib/cliAutomation.js';

const TELNET_ESCAPE = '\x1d'; // Ctrl+]
const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/;
// Printed by the telnet client once the TCP connection to the console port is up
const TELNET_CONNECTED = /Escape character is|Connected to /i;
const DEFAULT_WAKE_IDLE_MS = 2500;

export class ConsoleSession extends EventEmitter {
  #conn = null;
  #stream = null;
  #closed = false;
  #autoLogin = null;
  #nudge = null;
  #telnetUp = false;
  #bannerTail = '';

  constructor({ target, cols = 80, rows = 24, ssh, telnet, logger }) {
    super();
    // Defense in depth: the target comes from the server-side registry, but it
    // is interpolated into a remote command line, so validate it strictly anyway
    if (!HOST_RE.test(target.host)) throw new Error(`Invalid console host "${target.host}"`);
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('Invalid console port');
    this.target = target;
    this.size = { cols: clampSize(cols, 80), rows: clampSize(rows, 24) };
    this.ssh = ssh;
    this.telnet = telnet;
    this.log = logger;
    this.lastActivity = Date.now();
    // Export config / inject script; Its writes bypass write()'s lock
    this.cli = new CliAutomation({
      write: (text) => { this.lastActivity = Date.now(); this.#stream?.write(text); },
      onStart: () => { this.#nudge?.cancel(); this.#autoLogin?.cancel(); },
    });
    this.decoder = new StringDecoder('utf8'); // multi-byte characters split across chunks stay intact
  }

  start() {
    this.#status('ssh', `Connecting to jump server ${this.ssh.host}…`, 'consoles.status_ssh', { host: this.ssh.host });
    const conn = (this.#conn = new Client());

    conn.on('ready', () => {
      this.#status('telnet', `Opening console ${this.target.host}:${this.target.port}…`, 'consoles.status_telnet', { target: `${this.target.host}:${this.target.port}` });
      const command = `telnet ${this.target.host} ${this.target.port}`;
      conn.exec(command, { pty: { term: 'xterm-256color', ...this.size } }, (err, stream) => {
        if (err) return this.close(`Could not start telnet on the jump server: ${err.message}`, null, { code: 'consoles.telnet_failed', params: { detail: err.message } });
        this.#stream = stream;
        const write = (s) => this.#stream?.write(s);
        if (this.telnet.autoLogin && this.telnet.password) {
          this.#autoLogin = new AutoLogin(this.telnet, write, (m) => this.#status('login', m, 'consoles.status_login'));
        }
        this.#nudge = new WakeNudge({ idleMs: this.telnet.wakeIdleMs ?? DEFAULT_WAKE_IDLE_MS, write });
        stream.on('data', (buf) => this.#onOutput(buf));
        stream.stderr.on('data', (buf) => this.#onOutput(buf));
        stream.on('exit', (code) => { this.exitCode = code; });
        stream.on('close', () => (this.exitCode
          ? this.close(`Console closed (telnet exit code ${this.exitCode})`, this.exitCode, { code: 'consoles.closed_exit', params: { code: this.exitCode } })
          : this.close('Console closed', null, { code: 'consoles.closed' })));
      });
    });

    conn.on('error', (err) => { const { message, ...info } = sshErrorInfo(err, this.ssh); this.close(message, null, info); });
    conn.on('close', () => this.close('Connection to the jump server closed', null, { code: 'consoles.ssh_closed' }));

    conn.connect(sshConnectOptions(this.ssh, this.log));
  }

  /** Keystrokes from the browser */
  write(data) {
    if (!this.#stream || typeof data !== 'string') return;
    // While an export or a script runs, the student's keys are held back so
    // they can't interleave with the automated commands
    if (this.cli.running) return;
    this.lastActivity = Date.now();
    this.#nudge?.cancel(); // the student is driving now: never inject keys behind their back
    // Typing real characters means the student is answering prompts themselves:
    // auto-login stands down so both don't answer the same "Username:"
    // A bare Enter (the usual "wake the console" key) keeps auto-login on
    if (/[^\r\n]/.test(data)) this.#autoLogin?.cancel();
    const safe = data.replaceAll(TELNET_ESCAPE, '');
    if (safe) this.#stream.write(safe);
  }

  resize(cols, rows) {
    this.size = { cols: clampSize(cols, this.size.cols), rows: clampSize(rows, this.size.rows) };
    try { this.#stream?.setWindow(this.size.rows, this.size.cols, 0, 0); } catch { /* channel gone */ }
  }

  /** Serial BREAK through telnet's command mode, then straight back to the session */
  sendBreak() {
    if (!this.#stream) return;
    this.lastActivity = Date.now();
    this.#nudge?.cancel();
    this.#stream.write(TELNET_ESCAPE);
    setTimeout(() => this.#stream?.write('send brk\r'), 150);
  }

  close(reason = 'Session closed', code = null, info = { code: 'consoles.session_closed' }) {
    if (this.#closed) return;
    this.#closed = true;
    this.#nudge?.cancel();
    // Closing the channel hangs up telnet on the jump server, which frees the
    // console line on the terminal server for the next student
    try { this.#stream?.close(); } catch { /* ignore */ }
    try { this.#conn?.end(); } catch { /* ignore */ }
    this.#stream = null;
    this.#conn = null;
    this.emit('close', { reason, code, info: { params: {}, ...info } });
  }

  get closed() { return this.#closed; }

  #onOutput(buf) {
    this.emit('data', buf);
    const text = buf.toString('latin1');
    if (!this.#telnetUp) {
      this.#bannerTail = (this.#bannerTail + text).slice(-200); // the banner may arrive split across chunks
      if (TELNET_CONNECTED.test(this.#bannerTail)) {
        this.#telnetUp = true;
        this.#status('connected', 'Console connected', 'consoles.status_connected');
      }
    }
    // Auto-login first: if it answers a prompt, the nudge sees that prompt too and stands down
    this.#autoLogin?.feed(text);
    this.#nudge?.feed(text);
    this.cli.feed(this.decoder.write(buf));
  }

  #status(phase, message, code, params = {}) {
    this.emit('status', { phase, message, code, params });
  }
}

/**
 * The "wake-up" Enter for silent console lines
 *
 * A Cisco console that is already idle prints nothing after telnet connects
 * ("Press RETURN to get started" was shown hours ago), so one Enter makes the
 * prompt appear; But a terminal server that is *already* showing `login:`
 * treats that Enter as an empty login and hangs up
 * The rule is therefore "when in doubt, don't press Enter":
 *
 *   - only armed once telnet reports the TCP connection is up (a key typed
 *     while telnet is still dialing would be queued and land on the prompt);
 *   - every chunk of output restarts the idle timer;
 *   - fires only after `idleMs` of silence, at most once, within 15 s;
 *   - cancelled for good as soon as the last visible line looks like any
 *     prompt (`login:`, `Username:`, `Password:`, `R1>`, `S1#`, `rommon 1 >`,
 *     `switch:`…), or the student types or sends a BREAK
 *
 * A missed nudge costs the student one keypress; a wrong one drops the session
 */
export class WakeNudge {
  #timer = null;
  #done = false;
  #armedAt = 0;
  #tail = '';

  constructor({ idleMs = DEFAULT_WAKE_IDLE_MS, write, maxWindowMs = 15_000 }) {
    this.idleMs = idleMs;
    this.write = write;
    this.maxWindowMs = maxWindowMs;
    if (!idleMs) this.#done = true; // 0 disables the nudge entirely
  }

  feed(text) {
    if (this.#done) return;
    this.#tail = (this.#tail + stripAnsi(text)).slice(-300);
    if (!this.#armedAt) {
      if (!TELNET_CONNECTED.test(this.#tail)) return;
      this.#armedAt = Date.now();
    }
    if (Date.now() - this.#armedAt > this.maxWindowMs) return this.cancel(); // device is busy talking (e.g. booting)
    if (looksLikePrompt(lastLine(this.#tail))) return this.cancel();
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#fire(), this.idleMs);
    this.#timer.unref?.();
  }

  cancel() {
    this.#done = true;
    clearTimeout(this.#timer);
  }

  get done() { return this.#done; }

  #fire() {
    if (this.#done) return;
    this.#done = true;
    if (looksLikePrompt(lastLine(this.#tail))) return; // belt and braces
    this.write('\r');
  }
}

/**
 * Answers the console server's first Username/Password prompts with the
 * configured telnet credentials, then switches itself off for good:
 *   - after the password has been sent,
 *   - as soon as a CLI prompt (`R1>` / `S1#`) shows the line needs no login,
 *   - or after 30 s
 * It never answers a second time, so a wrong password can't loop or lock an
 * account, and later prompts (e.g. `enable` → Password:) are left to the student
 */
export class AutoLogin {
  #tail = '';
  #sentUser = false;
  #done = false;

  constructor({ username, password }, write, notify) {
    this.username = username;
    this.password = password;
    this.write = write;
    this.notify = notify;
    this.timer = setTimeout(() => { this.#done = true; }, 30_000);
    this.timer.unref?.();
  }

  feed(text) {
    if (this.#done) return;
    this.#tail = (this.#tail + stripAnsi(text)).slice(-200);
    const t = this.#tail.trimEnd();

    if (/(?:username|login)\s*:$/i.test(t)) {
      if (this.#sentUser || !this.username) return this.#stop();
      this.#sentUser = true;
      this.#tail = '';
      this.write(this.username + '\r');
    } else if (/password\s*:$/i.test(t)) {
      this.#tail = '';
      this.write(this.password + '\r');
      this.notify('Signed in to the console automatically');
      this.#stop();
    } else if (/(?:^|\n)[\w.()/-]+[>#]$/.test(t)) {
      this.#stop(); // already at a device prompt: no login on this line
    }
  }

  /** The student took over the login */
  cancel() { this.#stop(); }

  #stop() {
    this.#done = true;
    clearTimeout(this.timer);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deliberately broad: a line ending in ':', '>', '#', '$', '%', '?' or ']'
 * is treated as "something is waiting for input". The telnet banners end in
 * '.', so they never count; False positives only mean "no nudge"
 */
export function looksLikePrompt(line) {
  return /[:>#$%?\]]$/.test(line) || /\b(?:login|username|password)\b/i.test(line);
}

function lastLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) || '';
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const clampSize = (n, fallback) => (Number.isInteger(n) && n >= 10 && n <= 500 ? n : fallback);
