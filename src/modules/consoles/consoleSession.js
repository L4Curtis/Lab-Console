/**
 * One console line = one ConsoleSession = one `exec` channel on a pooled SSH
 * connection to the jump server, running exactly one command:
 * `telnet <host> <port>`. It is the transport of a ConsoleRoom: the room
 * decides who may type, the session only moves bytes and says what happens
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
 * What can go wrong, told apart for the student:
 *   - the jump server cannot be reached or refuses us: `consoles.ssh_*`;
 *   - the console server refuses the line (someone outside the application
 *     holds it, or the line is dead): `consoles.line_refused`;
 *   - the console server cannot be reached from the jump server:
 *     `consoles.console_server_unreachable`;
 *   - the line is accepted but the device answers nothing within `silentMs`
 *     of an Enter (powered off, cable unplugged, hung): a 'status' with phase
 *     'silent' and `consoles.device_silent`. The line stays open; the next
 *     output brings the phase back to 'connected'.
 *
 * Events:  'data' (Buffer) · 'status' ({phase, message, code, params}) · 'close' ({reason, code, info})
 *          'ready' once telnet is connected and the console server's login is done
 *
 * Texts meant for the student come with a stable message `code` and its `params`
 * next to the English sentence; the browser translates by code. On 'close', `code`
 * is the telnet exit code and `info` is { code, params } of the reason
 */
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { sshErrorInfo } from '../../lib/ssh.js';
import { SshPool } from '../../lib/sshPool.js';
import { CliAutomation } from '../../lib/cliAutomation.js';

const TELNET_ESCAPE = '\x1d'; // Ctrl+]
const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/;
// Printed by the telnet client once the TCP connection to the console port is up
const TELNET_CONNECTED = /Escape character is|Connected to /i;
// Printed by the telnet client when the console server says no
const LINE_REFUSED = /Unable to connect to remote host: Connection refused/i;
const SERVER_UNREACHABLE = /Unable to connect to remote host: (?:No route to host|Connection timed out|Network is unreachable)|Could not resolve|Unknown host/i;
const DEFAULT_WAKE_IDLE_MS = 2500;
const DEFAULT_SILENT_MS = 6000;

export class ConsoleSession extends EventEmitter {
  #stream = null;
  #closed = false;
  #autoLogin = null;
  #nudge = null;
  #telnetUp = false;
  #ready = false;
  #exitCode = undefined;
  #bannerTail = '';
  #silentTimer = null;
  #silent = false;
  #breaking = false;    // a BREAK is on its way (telnet escape sent, its command not yet)
  #answered = true;

  /**
   * @param target   { host, port } from the server's registry
   * @param name     the device's name, for the messages
   * @param ssh      jump server settings (settings.get('lab').ssh, read by the caller now)
   * @param telnet   console server login (settings.get('lab').telnet)
   * @param pool     the SshPool the channel is taken from (default: a connection of its own)
   * @param silentMs how long a device may stay mute after an Enter before it is reported silent
   */
  constructor({ target, name = '', cols = 80, rows = 24, ssh, telnet, pool = null, logger, silentMs = DEFAULT_SILENT_MS }) {
    super();
    // Defense in depth: the target comes from the server-side registry, but it
    // is interpolated into a remote command line, so validate it strictly anyway
    if (!HOST_RE.test(target.host)) throw new Error(`Invalid console host "${target.host}"`);
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('Invalid console port');
    this.target = target;
    this.name = name || `${target.host}:${target.port}`;
    this.size = { cols: clampSize(cols, 80), rows: clampSize(rows, 24) };
    this.ssh = ssh;
    this.telnet = telnet ?? {};
    this.pool = pool ?? new SshPool({ channelsPerConnection: 1, idleMs: 0, logger });
    this.log = logger;
    this.silentMs = silentMs;
    this.lastActivity = Date.now();
    this.phase = 'ssh';
    // Resolves once the line can be driven (telnet up, console server login done); rejects if it closes first
    this.ready = new Promise((resolve, reject) => {
      this.once('ready', resolve);
      this.once('close', (info) => reject(Object.assign(new Error(info.reason), { code: info.info?.code, params: info.info?.params })));
    });
    this.ready.catch(() => {});
    // Export config / inject script / bench jobs. Its writes bypass write()'s lock
    this.cli = new CliAutomation({
      write: (text) => { this.lastActivity = Date.now(); this.#send(text); },
      onStart: () => { this.#nudge?.cancel(); },
      sendBreak: () => this.sendBreak(),
    });
    this.decoder = new StringDecoder('utf8'); // multi-byte characters split across chunks stay intact
  }

  get telnetUp() { return this.#telnetUp; }
  get silent() { return this.#silent; }

  start() {
    this.#status('ssh', `Connecting to jump server ${this.ssh.host}…`, 'consoles.status_ssh', { host: this.ssh.host });
    const command = `telnet ${this.target.host} ${this.target.port}`;
    const attach = (stream) => {
      if (this.#closed) return;
      this.#stream = stream;
      this.#status('telnet', `Opening console ${this.target.host}:${this.target.port}…`, 'consoles.status_telnet', { target: `${this.target.host}:${this.target.port}` });
      const write = (s) => this.#send(s);
      if (this.telnet.autoLogin && this.telnet.password) {
        this.#autoLogin = new AutoLogin(this.telnet, write, (m) => this.#status('login', m, 'consoles.status_login'), () => this.#loginDone());
      }
      this.#nudge = new WakeNudge({ idleMs: this.telnet.wakeIdleMs ?? DEFAULT_WAKE_IDLE_MS, write });
      stream.on('data', (buf) => this.#onOutput(buf));
      stream.stderr.on('data', (buf) => this.#onOutput(buf));
      stream.on('exit', (code) => { this.#exitCode = code ?? 0; });
      stream.on('close', () => this.#onChannelClosed());
    };
    this.pool.exec(this.ssh, command, { pty: { term: 'xterm-256color', ...this.size } }, attach).then((stream) => {
      if (this.#closed && this.#stream !== stream) { try { stream.close(); } catch { /* gone */ } }
    }, (err) => {
      if (err.channelRefused) {
        return this.close(`The jump server refused one more console: ${err.message}`, null, { code: 'consoles.telnet_failed', params: { detail: err.message } });
      }
      const { message, ...info } = sshErrorInfo(err, this.ssh);
      this.close(message, null, info);
    });
  }

  #onChannelClosed() {
    const target = `${this.target.host}:${this.target.port}`;
    if (!this.#telnetUp && LINE_REFUSED.test(this.#bannerTail)) {
      return this.close(`The console server refused the line of ${this.name} (${target}): someone outside the application is using it, or the line is out of order`, this.#exitCode ?? null,
        { code: 'consoles.line_refused', params: { name: this.name, target } });
    }
    if (!this.#telnetUp && SERVER_UNREACHABLE.test(this.#bannerTail)) {
      return this.close(`The jump server cannot reach the console server ${this.target.host}`, this.#exitCode ?? null,
        { code: 'consoles.console_server_unreachable', params: { host: this.target.host } });
    }
    // No exit status at all: the channel went down with its SSH connection
    if (this.#exitCode === undefined) return this.close('Connection to the jump server closed', null, { code: 'consoles.ssh_closed' });
    if (this.#exitCode) return this.close(`Console closed (telnet exit code ${this.#exitCode})`, this.#exitCode, { code: 'consoles.closed_exit', params: { code: this.#exitCode } });
    return this.close('Console closed', null, { code: 'consoles.closed' });
  }

  /** Keystrokes from the person at the keyboard (the room checks who that may be) */
  write(data) {
    if (!this.#stream || typeof data !== 'string') return false;
    // While an export or a script runs, the student's keys are held back so
    // they can't interleave with the automated commands
    if (this.cli.running) return false;
    this.lastActivity = Date.now();
    this.#nudge?.cancel(); // the student is driving now: never inject keys behind their back
    // Typing real characters means the student is answering prompts themselves:
    // auto-login stands down so both don't answer the same "Username:"
    // A bare Enter (the usual "wake the console" key) keeps auto-login on
    if (/[^\r\n]/.test(data)) this.#autoLogin?.cancel();
    const safe = data.replaceAll(TELNET_ESCAPE, '');
    if (safe) this.#send(safe);
    return Boolean(safe);
  }

  resize(cols, rows) {
    this.size = { cols: clampSize(cols, this.size.cols), rows: clampSize(rows, this.size.rows) };
    try { this.#stream?.setWindow(this.size.rows, this.size.cols, 0, 0); } catch { /* channel gone */ }
  }

  /** Serial BREAK through telnet's command mode, then straight back to the session */
  sendBreak() {
    // One at a time: a second escape while telnet waits for its command would end up in that command
    if (!this.#stream || this.#breaking) return;
    this.#breaking = true;
    this.lastActivity = Date.now();
    this.#nudge?.cancel();
    this.#stream.write(TELNET_ESCAPE);
    setTimeout(() => { this.#breaking = false; this.#stream?.write('send brk\r'); }, 150);
  }

  close(reason = 'Session closed', code = null, info = { code: 'consoles.session_closed' }) {
    if (this.#closed) return;
    this.#closed = true;
    this.#nudge?.cancel();
    this.#autoLogin?.cancel();
    clearTimeout(this.#silentTimer);
    // Closing the channel hangs up telnet on the jump server, which frees the
    // console line on the terminal server for the next student; the pooled
    // SSH connection stays for the other lines
    try { this.#stream?.close(); } catch { /* ignore */ }
    this.#stream = null;
    this.phase = 'closed';
    this.emit('close', { reason, code, info: { params: {}, ...info } });
  }

  get closed() { return this.#closed; }

  /** Every byte to the device goes through here: an Enter starts the "is anybody there?" watch */
  #send(text) {
    if (!this.#stream) return;
    this.#stream.write(text);
    if (this.#telnetUp && text.includes('\r') && this.silentMs > 0) {
      // Each Enter starts the count again: silent means "nothing visible since the last Enter"
      // (the console server's own "\r\n" after its login does not count as an answer)
      this.#answered = false;
      clearTimeout(this.#silentTimer);
      this.#silentTimer = setTimeout(() => this.#goneSilent(), this.silentMs);
      this.#silentTimer.unref?.();
    }
  }

  #goneSilent() {
    this.#silentTimer = null;
    if (this.#closed || this.#silent || this.#answered) return;
    this.#silent = true;
    const seconds = Math.round(this.silentMs / 1000);
    this.#status('silent', `${this.name} does not answer: the console server accepted the line, but nothing came back ${seconds} s after Enter. Check that the device is powered on and that its console cable is plugged in`,
      'consoles.device_silent', { name: this.name, seconds });
  }

  #loginDone() {
    if (this.#ready || this.#closed || !this.#telnetUp) return;
    this.#ready = true;
    this.emit('ready');
  }

  #onOutput(buf) {
    this.emit('data', buf);
    const text = buf.toString('latin1');
    if (!this.#telnetUp) {
      this.#bannerTail = (this.#bannerTail + text).slice(-300); // the banner may arrive split across chunks
      if (TELNET_CONNECTED.test(this.#bannerTail)) {
        this.#telnetUp = true;
        this.#status('connected', 'Console connected', 'consoles.status_connected');
        if (!this.#autoLogin || this.#autoLogin.done) this.#loginDone();
      }
    } else {
      // The device talks: whatever Enter was waiting got its answer
      if (/[^\s]/.test(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) this.#answered = true;
      if (this.#silent && this.#answered) {
        this.#silent = false;
        this.#status('connected', 'Console connected', 'consoles.status_connected');
      }
    }
    // Auto-login first: if it answers a prompt, the nudge sees that prompt too and stands down
    this.#autoLogin?.feed(text);
    this.#nudge?.feed(text);
    this.cli.feed(this.decoder.write(buf));
  }

  #status(phase, message, code, params = {}) {
    this.phase = phase === 'login' ? 'connected' : phase;
    this.lastStatus = { phase, message, code, params };
    this.emit('status', this.lastStatus);
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

  constructor({ username, password }, write, notify, onDone = () => {}) {
    this.username = username;
    this.password = password;
    this.write = write;
    this.notify = notify;
    this.onDone = onDone;
    this.timer = setTimeout(() => this.#stop(), 30_000);
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

  get done() { return this.#done; }

  #stop() {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.timer);
    this.onDone();
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
