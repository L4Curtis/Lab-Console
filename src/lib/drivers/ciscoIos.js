/**
 * Cisco IOS / IOS XE device procedures, built on the CliAutomation steps
 *
 * The bench jobs (backup, injection, reset) stand on these. Nobody can try
 * them on the real devices while they are written, so the rule is: be
 * defensive, never guess. Every procedure returns a structured result:
 *
 *   { ok: true, ...data }
 *   { ok: false, reason: 'ios.<code>', message: 'English sentence', params, stage?, lastOutput? }
 *
 * `reason` is a message code (translated under `ios.errors.<code>`), and
 * `lastOutput` is the end of what the console printed, for the report.
 * Cancellation is not a result: the CliAutomation `cancelled` error is
 * rethrown, with `stage` set when the procedure has stages.
 *
 * A procedure runs inside the task that already holds the console (a job's
 * room.runExclusive) or, when none does, takes the keyboard itself.
 *
 * The lab mixes four families (classic IOS 12.4T routers, IOS XE 17.3
 * routers, classic 12.2SE / 15.0SE switches, Catalyst 1000 / 9300L): every
 * question is recognised by its text, timeouts cover the slowest boot (IOS XE,
 * ten minutes) and the procedures key on what the console prints.
 *
 *   prepare()         any console state → privileged EXEC, or the reason why not
 *   identify()        model, software, configuration register (show version)
 *   runningConfig()   show running-config
 *   vlans() / cdpNeighbors() / interfaces() / ping()
 *   eraseAndReload()  erase, delete vlan.dat, reload without saving, follow the
 *                     boot, answer the first-boot dialog, check the factory prompt
 *   toReplayScript()  a captured running-config → a script for a factory device
 */
import { patterns, screenTail, isSyslogLine, escapeRe } from '../cliAutomation.js';

const { CISCO_PROMPT, DEVICE_ERROR } = patterns;

/** Real-life budgets. Tests and the mock lab pass shorter ones. */
export const TIMEOUTS = Object.freeze({
  observeMs: 10_000,        // prepare(): listen this long for a device that is talking (booting)
  quietMs: 3000,            // … silence that means "not booting"
  wakeWaitMs: 15_000,       // after each wake-up Enter (the lab's silent lines: three Enters, 15 s apart)
  wakes: 3,
  promptMs: 10_000,         // an ordinary answer from the device
  pressReturnMs: 45_000,    // first Enter after "Press RETURN to get started!" (an 1841 took more than 8 s)
  commandMs: 120_000,       // a show command
  eraseMs: 90_000,          // erase startup-config / delete vlan.dat
  bootTotalMs: 15 * 60_000, // reload to prompt, slowest family (IOS XE: up to ten minutes)
  bootIdleMs: 5 * 60_000,   // no output at all for this long during a boot: stalled
  pnpWaitMs: 3 * 60_000,    // IOS XE: wait for "PnP Discovery stopped" before trusting the prompt
  questionSettleMs: 5000,   // a line that looks like a question must stay still this long
  nudgeQuietMs: 5000,       // after "Press RETURN" or a prompt: an unrecognised screen quiet this long gets an Enter (3 at most)
  settleMs: 400,            // quiet time once an expected pattern appeared
});

// ── What a console can show ─────────────────────────────────────────────────

const SCREENS = [
  ['rommon', /(?:^|\n)rommon \d+ ?> ?$/],
  ['bootLoader', /(?:^|\n)switch: ?$/],
  ['more', /--More-- ?$/],
  ['dialog', /initial configuration dialog\? \[yes\/no\]: ?$/],
  ['autoinstall', /terminate autoinstall\? \[yes\]: ?$/],
  ['setup', /basic management setup\? \[yes\/no\]: ?$/],
  ['save', /System configuration has been modified\. Save\? \[yes\/no\]: ?$/],
  ['confirm', /\[confirm\] ?$/],
  ['pressReturn', /Press RETURN to get started[.!]?\s*$/],
  ['username', /(?:^|\n)Username: ?$/],
  ['password', /(?:^|\n)Password: ?$/],
  ['config', /(?:^|\n)[A-Za-z0-9][\w.-]{0,62}\([\w.-]{1,40}\)# ?$/],
  ['privileged', /(?:^|\n)[A-Za-z0-9][\w.-]{0,62}# ?$/],
  ['user', /(?:^|\n)[A-Za-z0-9][\w.-]{0,62}> ?$/],
  ['question', /(?:\? ?|\[[^\]\n]*\]:? ?|: ?)$/],
];
const BOOT_MARKS = /System Bootstrap|Self decompressing the image|Restricted Rights Legend|Initializing Hardware|boot: attempting to boot|Loading "|program load complete|%IOSXEBOOT|Readonly ROMMON initialized|POST: |Waiting for Port download|uncompressed and installed|Xmodem file system/;
const PNP_STARTED = /PNP_DISCOVERY_STARTED|PnP Agent Discovery|PNP_SUDI_UPDATE/;
const PNP_STOPPED = /PNP_DISCOVERY_STOPPED/;

/**
 * What the console is waiting for, from the end of its output:
 * { state, line, host?, mark? }. Trailing syslog lines are ignored.
 * With `bootMarks` (default), output that contains boot messages and ends
 * on no known prompt is 'booting'; a caller already following a boot turns
 * it off so that a question asked during the boot is seen as one.
 */
export function classifyScreen(text, { bootMarks = true } = {}) {
  const tail = screenTail(String(text)).replace(/[ \t]+$/, (s) => (s.length ? ' ' : ''));
  const line = (tail.split('\n').at(-1) || '').trim();
  if (!tail.trim()) return { state: 'empty', line: '' };
  for (const [state, re] of SCREENS) {
    if (!re.test(tail)) continue;
    if (state === 'question' && bootMarks && BOOT_MARKS.test(text) && !/\[(yes|no|yes\/no|confirm)\]/.test(line)) return { state: 'booting', line };
    const p = tail.match(CISCO_PROMPT);
    return p ? { state, line, host: p[1], mark: p[3] } : { state, line };
  }
  if (bootMarks && BOOT_MARKS.test(text)) return { state: 'booting', line };
  return { state: 'unknown', line };
}

// ── Results ─────────────────────────────────────────────────────────────────

const MESSAGES = {
  no_prompt: 'No Cisco prompt answered.',
  rommon: 'The device is in ROMMON (rommon >): it did not load IOS. Someone must check it on site.',
  boot_loader: 'The switch is at its boot loader (switch:): it did not load IOS. Someone must check it on site.',
  booting: 'The device is printing continuously (it looks like it is booting): nothing was typed.',
  silent: 'The device does not answer: check its power and its console cable on site.',
  line_password: 'The console line asks for a password that is not known: the device is locked until someone recovers it on site.',
  login_required: 'The device asks for a username: console login is not supported.',
  enable_refused: 'The enable secret was refused ({attempts} attempts).',
  enable_password_required: 'The device asks for an enable secret and none was supplied.',
  unknown_question: 'The device asks a question the driver does not know: "{question}". Nothing was answered.',
  unknown_state: 'The console is in a state the driver does not recognise: "{line}".',
  not_ios: 'This device does not run Cisco IOS or IOS XE: it is left untouched.',
  not_privileged: 'The device is not in privileged EXEC (#).',
  command_refused: 'The device refused the command: {detail}',
  incomplete_output: 'The device stopped answering before the end of the output.',
  export_failed: 'The running configuration could not be read: {detail}',
  bad_target: 'Not an IPv4 address: "{target}".',
  no_backup: 'No proof of a backup: the device is not erased.',
  backup_mismatch: 'The backup is of {expected}, but the device is {hostname}: the device is not erased.',
  erase_failed: 'The startup configuration could not be erased.',
  vlan_delete_failed: 'flash:vlan.dat could not be deleted: {detail}',
  register_failed: 'The configuration register could not be set back to 0x2102.',
  reload_refused: 'The device did not reload.',
  boot_stalled: 'The boot stalled: nothing was printed for {seconds} s.',
  boot_timeout: 'The device did not reach a prompt within {minutes} minutes.',
  not_factory: 'After the reload the device is not in its factory state: {detail}',
  vlans_survived: 'VLANs are still present after the reload: {vlans}.',
};

/** Every `reason` a procedure can give (without the `ios.` prefix), translated under ios.errors.* */
export const REASONS = Object.freeze(Object.keys(MESSAGES));
/** English text of a reason, as the dictionaries hold it */
export const reasonText = (reason) => MESSAGES[reason];

function fail(reason, params = {}, extra = {}) {
  const message = (MESSAGES[reason] || reason).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
  return { ok: false, reason: `ios.${reason}`, message, params, ...extra };
}
const tailOf = (text, max = 1500) => String(text).slice(-max).replace(/^[^\n]*\n/, '');

/**
 * A result with the candidate passwords masked wherever they could show up
 * (the console output kept for the report, the question or line quoted): the
 * jobs store reports, and passwords are never stored or logged.
 */
function redactor(candidates) {
  const list = [...new Set(candidates.filter((c) => typeof c === 'string' && c.length))].sort((a, b) => b.length - a.length);
  if (!list.length) return (r) => r;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${list.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'g');
  const mask = (v) => (typeof v === 'string' ? v.replace(re, '********') : v);
  return (r) => {
    if (!r || r.ok) return r;
    const params = Object.fromEntries(Object.entries(r.params || {}).map(([k, v]) => [k, mask(v)]));
    return { ...r, message: mask(r.message), params, ...(r.lastOutput !== undefined ? { lastOutput: mask(r.lastOutput) } : {}) };
  };
}

// ── The driver ──────────────────────────────────────────────────────────────

export class CiscoIos {
  #cli;
  #t;
  #progress;
  #host = null;

  /**
   * @param cli       a CliAutomation bound to the console line
   * @param timeouts  overrides of TIMEOUTS
   * @param progress  (message, { code, params, stage }) => void
   */
  constructor(cli, { timeouts = {}, progress = () => {} } = {}) {
    this.#cli = cli;
    this.#t = { ...TIMEOUTS, ...timeouts };
    this.#progress = progress;
  }

  /** The hostname seen at the last prompt (null before any) */
  get hostname() { return this.#host; }

  // ── prepare ───────────────────────────────────────────────────────────────

  /**
   * Bring the device to privileged EXEC (#) from whatever its console shows:
   * wakes the line, answers the initial configuration dialog with "no" (and
   * the autoinstall question with its default), cancels a pending reload or
   * [confirm], leaves configuration mode, quits a pager, answers a console
   * line password and the enable secret with the candidates supplied (three
   * attempts at most, each), and stops with a reason on ROMMON, the boot
   * loader, a booting or silent device, a locked line or an unknown question.
   * Nothing is ever typed into ROMMON, a boot loader or a booting device.
   *
   * @param enablePasswords  candidates for the enable secret, tried in order
   * @param linePasswords    candidates for a console-line password
   * @param screen           optional: the end of what the console already showed
   *                         (the room's scrollback), read before anything is typed
   * → { ok, hostname, startState, steps } where steps lists what was done
   */
  prepare({ enablePasswords = [], linePasswords = [], screen = '' } = {}) {
    const hide = redactor([...enablePasswords, ...linePasswords]);
    return this.#task('prepare', async (cli) => hide(await this.#prepare(cli, { enablePasswords, linePasswords, screen })));
  }

  async #prepare(cli, { enablePasswords, linePasswords, screen }) {
    const t = this.#t;
    const steps = [];
    const enable = { queue: [...enablePasswords].filter((p) => typeof p === 'string'), tries: 0 };
    const line = { queue: [...linePasswords].filter((p) => typeof p === 'string'), tries: 0 };
    let wakes = 0;
    let last = null; // what we did last: decides whose "Password:" this is

    this.#say('Looking at the console', 'look');
    cli.reset();
    const quiet = await cli.waitQuiet(t.quietMs, { timeout: t.observeMs });
    let view = `${screen ? `${screen}\n` : ''}${cli.buffer}`;
    let startState = null;
    // Still printing and not at a prompt or a question: booting (or a flood of debug).
    // A device at its prompt or at the dialog while IOS XE prints syslog / PnP lines is not.
    // Syslog lines alone (IOS XE Plug-and-Play at the dialog) are chatter, not a boot.
    const chatterOnly = view.split('\n').every((l) => !l.trim() || isSyslogLine(l));
    if (!quiet && !chatterOnly && ['empty', 'unknown', 'booting'].includes(classifyScreen(view).state)) return fail('booting', {}, { lastOutput: tailOf(view) });

    const seen = {};
    for (let move = 0; move < 30; move++) {
      cli.throwIfCancelled();
      const s = classifyScreen(view);
      startState ??= s.state === 'empty' ? null : s.state;
      // The same screen answered over and over: something the driver does not understand
      if (!['empty', 'unknown', 'password', 'user'].includes(s.state) && (seen[s.state] = (seen[s.state] || 0) + 1) > 3) {
        return fail('unknown_state', { line: s.line }, { steps, lastOutput: tailOf(view) });
      }
      const act = async (text, step, { raw = false, wait = t.promptMs } = {}) => {
        steps.push(step);
        cli.reset();
        if (raw) cli.send(text); else await cli.answer(text);
        view = await this.#next(wait);
      };
      switch (s.state) {
        case 'privileged':
          if (!steps.length) { // seen in the caller's old screen only: make the device show it again
            wakes++; last = 'wake';
            await act('', 'wake', { wait: t.wakeWaitMs });
            break;
          }
          this.#host = s.host;
          return { ok: true, hostname: s.host, startState: startState || 'privileged', steps };
        case 'user':
          // "% Bad secrets" after a wake-up Enter at a live enable prompt: candidates are left, ask again
          if (last === 'enable-password' && enable.queue.length && enable.tries < 3) {
            last = 'enable';
            await act('enable', 'enable');
            break;
          }
          if (last === 'enable' || last === 'enable-password' || last === 'enable-clear') {
            return fail(enable.tries ? 'enable_refused' : 'enable_password_required', { attempts: enable.tries }, { steps, lastOutput: tailOf(view) });
          }
          this.#say('Entering privileged EXEC (enable)', 'enable');
          last = 'enable';
          await act('enable', 'enable');
          break;
        case 'password': {
          const forEnable = last === 'enable' || last === 'enable-password' || last === 'enable-clear' || last === 'wake-enable' || /(?:^|\n)\S+>\s*enable\s*\n/.test(screenTail(view));
          // A secret is typed only where the device itself printed "Password:" during this task.
          // Seen in the caller's old screen only, it may be long gone (IOS's 30 s password timeout
          // printed while nobody watched): a bare Enter makes the device show where it is.
          if (classifyScreen(cli.buffer).state !== 'password') {
            if (wakes >= t.wakes) return fail('unknown_state', { line: s.line }, { steps, lastOutput: tailOf(view) });
            wakes++; last = forEnable ? 'wake-enable' : 'wake';
            await act('', 'wake', { wait: t.wakeWaitMs });
            break;
          }
          if (forEnable) {
            if (enable.queue.length && enable.tries < 3) {
              enable.tries++; last = 'enable-password';
              await act(enable.queue.shift(), 'enable-password');
            } else {
              // No candidate left: empty answers until IOS gives up ("% Bad secrets").
              // They are not guesses; they only leave the console at its prompt.
              if (last !== 'enable-clear') enable.clears = 0;
              last = 'enable-clear';
              if (++enable.clears > 3) return fail(enable.tries ? 'enable_refused' : 'enable_password_required', { attempts: enable.tries }, { steps, lastOutput: tailOf(view) });
              await act('', 'enable-clear');
            }
            break;
          }
          if (line.queue.length && line.tries < 3) {
            this.#say('Answering the console line password', 'line_password');
            line.tries++; last = 'line-password';
            await act(line.queue.shift(), 'line-password', { wait: t.pressReturnMs });
            break;
          }
          return fail('line_password', { attempts: line.tries }, { steps, lastOutput: tailOf(view) });
        }
        case 'username':
          return fail('login_required', {}, { steps, lastOutput: tailOf(view) });
        case 'config':
          this.#say('Leaving configuration mode', 'end');
          last = 'end';
          await act('end', 'end');
          break;
        case 'more':
          last = 'quit-pager';
          await act('q', 'quit-pager', { raw: true });
          break;
        case 'dialog':
          this.#say('Answering "no" to the initial configuration dialog', 'dialog');
          last = 'dialog';
          await act('no', 'dialog-no', { wait: t.pressReturnMs });
          break;
        case 'autoinstall':
          last = 'autoinstall';
          await act('', 'autoinstall-default', { wait: t.pressReturnMs });
          break;
        case 'setup':
          last = 'setup';
          await act('\x03', 'setup-abort', { raw: true, wait: t.pressReturnMs });
          break;
        case 'save':
          last = 'save';
          await act('no', 'save-no');
          break;
        case 'confirm':
          last = 'confirm';
          await act('n', 'confirm-cancel', { raw: true });
          break;
        case 'pressReturn':
          if (/% Bad passwords/.test(view) && (!line.queue.length || line.tries >= 3)) return fail('line_password', { attempts: line.tries }, { steps, lastOutput: tailOf(view) });
          last = 'return';
          await act('', 'return', { wait: t.pressReturnMs });
          break;
        case 'rommon':
          return fail('rommon', {}, { steps, lastOutput: tailOf(view) });
        case 'bootLoader':
          return fail('boot_loader', {}, { steps, lastOutput: tailOf(view) });
        case 'booting':
          return fail('booting', {}, { steps, lastOutput: tailOf(view) });
        case 'question':
          // Inside the setup dialog IOS itself says "Use ctrl-c to abort configuration dialog at any prompt"
          if (/Use ctrl-c to abort configuration dialog|--- System Configuration Dialog ---/.test(view) && last !== 'setup') {
            last = 'setup';
            await act('\x03', 'setup-abort', { raw: true, wait: t.pressReturnMs });
            break;
          }
          return fail('unknown_question', { question: s.line }, { steps, lastOutput: tailOf(view) });
        default: // empty or unknown: wake the line with Enter, three times at most
          if (wakes >= t.wakes) {
            return s.state === 'empty' ? fail('silent', {}, { steps }) : fail('unknown_state', { line: s.line }, { steps, lastOutput: tailOf(view) });
          }
          wakes++;
          this.#say('Waking the console (Enter)', 'wake');
          last = 'wake';
          await act('', 'wake', { wait: t.wakeWaitMs });
      }
    }
    return fail('unknown_state', { line: classifyScreen(view).line }, { steps, lastOutput: tailOf(view) });
  }

  /** After an action: wait until the console shows a recognisable state (or the budget ends) */
  async #next(timeout) {
    const cli = this.#cli;
    const known = (b) => { const s = classifyScreen(b).state; return s !== 'empty' && s !== 'unknown' && s !== 'booting'; };
    const r = await cli.expect({ known }, { timeout, settle: this.#t.settleMs });
    if (r.name !== 'known') return cli.buffer;
    // A question-looking line must stay still before it counts (boot output can pause on ": ")
    if (classifyScreen(cli.buffer).state === 'question' && !(await cli.waitQuiet(this.#t.questionSettleMs, { timeout: this.#t.questionSettleMs * 2 }))) return this.#next(timeout);
    return cli.buffer;
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /**
   * show version → { ok, family: 'ios'|'iosxe', kind: 'router'|'switch', model,
   * version, image, configRegister, nextConfigRegister, registerOk, hostname,
   * serial, uptime, warnings }
   */
  identify() {
    return this.#task('identify', async () => {
      const r = await this.#show('show version');
      if (!r.ok) return r;
      const v = parseShowVersion(r.output);
      if (!v.family) return fail('not_ios', {}, { lastOutput: tailOf(r.output) });
      return { ok: true, ...v };
    });
  }

  /** show running-config → { ok, hostname, config } (needs privileged EXEC) */
  runningConfig() {
    return this.#task('backup', async (cli) => {
      try {
        const { hostname, config, pagingFallback } = await cli.readRunningConfig((message) => this.#progress(message, { code: 'ios.steps.read_config' }));
        this.#host = hostname;
        return { ok: true, hostname, config, pagingFallback };
      } catch (err) {
        if (err.cancelled) throw err;
        return fail('export_failed', { detail: err.message }, { cause: err.code ?? null });
      }
    });
  }

  /**
   * show vlan brief, and on switches the VTP settings that live in vlan.dat
   * with the VLANs (not in show running-config, outside transparent mode)
   * → { ok, supported, vlans: [{ id, name, status, ports }], vtp: { version, mode, domain, password, pruning } | null }
   * A backup keeps `vtp` with the VLANs and passes both to toReplayScript().
   */
  vlans() {
    return this.#task('vlans', async () => {
      const r = await this.#show('show vlan brief');
      if (!r.ok) return r.reason === 'ios.command_refused' ? { ok: true, supported: false, vlans: [], vtp: null } : r;
      const vtp = await this.vtp();
      if (!vtp.ok) return vtp;
      return { ok: true, supported: true, vlans: parseVlanBrief(r.output), vtp: vtp.supported ? vtp.vtp : null };
    });
  }

  /** show vtp status + show vtp password → { ok, supported, vtp: { version, mode, domain, password, pruning } } */
  vtp() {
    return this.#task('vtp', async () => {
      const r = await this.#show('show vtp status');
      if (!r.ok) return r.reason === 'ios.command_refused' ? { ok: true, supported: false, vtp: null } : r;
      const vtp = parseVtpStatus(r.output);
      if (!vtp) return { ok: true, supported: false, vtp: null };
      const pw = await this.#show('show vtp password');
      if (!pw.ok && pw.reason !== 'ios.command_refused') return pw;
      vtp.password = pw.ok ? parseVtpPassword(pw.output) : null;
      return { ok: true, supported: true, vtp };
    });
  }

  /** show cdp neighbors detail → { ok, enabled, neighbors: [...] } */
  cdpNeighbors() {
    return this.#task('cdp', async () => {
      const r = await this.#show('show cdp neighbors detail');
      if (!r.ok) return /CDP is not enabled/.test(r.params?.detail || '') ? { ok: true, enabled: false, neighbors: [] } : r;
      return { ok: true, enabled: true, neighbors: parseCdpNeighbors(r.output) };
    });
  }

  /** show ip interface brief → { ok, interfaces: [{ name, ip, ok, method, status, protocol }] } */
  interfaces() {
    return this.#task('interfaces', async () => {
      const r = await this.#show('show ip interface brief');
      if (!r.ok) return r;
      const interfaces = parseIpInterfaceBrief(r.output);
      return { ok: true, interfaces, unparsed: countRows(r.output) - interfaces.length };
    });
  }

  /** ping <IPv4> → { ok, target, sent, received, successRate, rtt } (ok: the command ran) */
  ping(target, { repeat = 5 } = {}) {
    if (!isIpv4(target)) return Promise.resolve(fail('bad_target', { target: String(target).slice(0, 64) }));
    const n = Number.isInteger(repeat) && repeat >= 1 && repeat <= 100 ? repeat : 5;
    return this.#task('ping', async () => {
      const r = await this.#show(n === 5 ? `ping ${target}` : `ping ${target} repeat ${n}`, { timeout: n * 2500 + 15_000 });
      if (!r.ok) return r;
      const p = parsePing(r.output);
      if (!p) return fail('command_refused', { detail: r.output.split('\n').find((l) => l.startsWith('%')) || r.output.slice(0, 200) });
      return { ok: true, target, ...p };
    });
  }

  // ── erase and reload ──────────────────────────────────────────────────────

  /**
   * Factory reset: erase startup-config, delete flash:vlan.dat on switches,
   * set the configuration register back to 0x2102 on routers, reload WITHOUT
   * saving, follow the boot, answer the first-boot questions it knows, and
   * check the factory prompt (Router> / Switch>, no enable secret, no VLAN).
   * Leaves the device in privileged EXEC.
   *
   * @param backup        proof of the backup this erase replaces (see checkBackupProof);
   *                      without it nothing happens
   * @param verifyBackup  optional async (backup) => boolean, the jobs' own check
   * @param facts         identify() result, read again when missing
   * → { ok, hostname, kind, vlanDat, register, answered, warnings, bootSeconds }
   *   or { ok: false, reason, stage, lastOutput } saying exactly where it stopped
   */
  eraseAndReload({ backup, verifyBackup = null, facts = null, fixConfigRegister = true } = {}) {
    const proof = checkBackupProof(backup);
    if (!proof.ok) return Promise.resolve(fail('no_backup', {}, { stage: 'check' }));
    return this.#task('reset', async (cli) => {
      const t = this.#t;
      let stage = 'check';
      const at = (r) => ({ ...r, stage, lastOutput: r.lastOutput ?? tailOf(cli.buffer) });
      try {
        if (verifyBackup && !(await verifyBackup(backup))) return at(fail('no_backup'));
        const p = await this.#findPrompt();
        if (!p.ok) return at(p);
        if (p.mark !== '#') return at(fail('not_privileged'));
        if (proof.hostname && proof.hostname !== p.host) return at(fail('backup_mismatch', { expected: proof.hostname, hostname: p.host }));
        let f = facts;
        if (!f?.kind) {
          const id = await this.identify();
          if (!id.ok) return at(id);
          f = id;
        }
        if (f.family !== 'ios' && f.family !== 'iosxe') return at(fail('not_ios'));

        stage = 'erase';
        this.#say('Erasing the startup configuration', 'erase', stage);
        const erase = await this.#ask('erase startup-config', { confirm: /\[confirm\] ?$/ }, t.promptMs);
        if (erase !== 'confirm') return at(fail('erase_failed'));
        cli.reset(); cli.send('\r'); // [confirm] reads one key
        const erased = await cli.expect({ done: (b) => /Erase of nvram: complete/.test(b) && this.#atPrompt(b) }, { timeout: t.eraseMs, settle: t.settleMs });
        if (erased.name !== 'done') return at(fail('erase_failed'));

        let vlanDat = 'n/a';
        if (f.kind === 'switch') {
          stage = 'vlan';
          this.#say('Deleting flash:vlan.dat', 'vlan', stage);
          vlanDat = await this.#deleteVlanDat();
          if (typeof vlanDat !== 'string') return at(vlanDat);
        }

        // A pending value ("will be 0x2142 at next reload") is the one the next boot uses
        let register = f.nextConfigRegister || f.configRegister || null;
        const warnings = [];
        if (f.kind === 'router' && register && register.toLowerCase() !== '0x2102') {
          if (!fixConfigRegister) warnings.push('register_unusual');
          else {
            stage = 'register';
            this.#say('Setting the configuration register back to 0x2102', 'register', stage);
            const ok = await this.#configure(['config-register 0x2102']);
            if (!ok) return at(fail('register_failed'));
            register = `${register} -> 0x2102`;
          }
        }

        stage = 'reload';
        this.#say('Reloading without saving', 'reload', stage);
        cli.reset();
        await cli.answer('reload');
        for (let q = 0; ; q++) {
          const r = await cli.expect({
            save: /System configuration has been modified\. Save\? \[yes\/no\]: ?$/,
            proceed: /Proceed with reload\? \[confirm\] ?$/,
            refused: (b) => DEVICE_ERROR.test(b) && this.#atPrompt(b),
          }, { timeout: t.promptMs, settle: t.settleMs });
          if (r.name === 'save' && q < 3) { cli.reset(); await cli.answer('no'); continue; }
          if (r.name === 'proceed') { cli.reset(); cli.send('\r'); break; }
          const s = classifyScreen(cli.buffer);
          if (s.state === 'question' || s.state === 'confirm') { cli.send('\x03'); return at(fail('unknown_question', { question: s.line })); }
          return at(fail('reload_refused'));
        }

        stage = 'boot';
        this.#say('Following the boot', 'boot', stage);
        const boot = await this.#followBoot();
        stage = boot.stage || stage;
        if (!boot.ok) return at(boot);
        warnings.push(...boot.warnings);

        stage = 'factory_check';
        this.#say('Checking the factory state', 'factory_check', stage);
        if (!/^(Router|Switch)$/.test(boot.host)) return at(fail('not_factory', { detail: `the hostname is still ${boot.host}` }));
        cli.reset();
        await cli.answer('enable');
        const en = await cli.expect({ ok: (b) => /(?:^|\n)(Router|Switch)# ?$/.test(screenTail(b)), password: /(?:^|\n)Password: ?$/ }, { timeout: t.promptMs, settle: t.settleMs });
        if (en.name !== 'ok') {
          if (en.name === 'password') { cli.send('\x03'); cli.send('\r'); }
          return at(fail('not_factory', { detail: 'enable asks for a password' }));
        }
        this.#host = boot.host;
        // Every factory boot asks the initial dialog and has no startup-config: a device that
        // booted its old configuration with the default hostname and no enable secret does not pass
        const start = await this.#show('show startup-config');
        if (!start.ok) return at(start);
        if (!/startup-config is not present/i.test(start.output)) return at(fail('not_factory', { detail: 'a startup-config is still present' }));
        if (!boot.answered.includes('dialog')) return at(fail('not_factory', { detail: 'the initial configuration dialog did not appear' }));
        if (f.kind === 'router' && f.configRegister) {
          const v = await this.identify();
          if (!v.ok) return at(v);
          const effective = v.nextConfigRegister || v.configRegister;
          if (effective && effective.toLowerCase() !== '0x2102') {
            if (fixConfigRegister) return at(fail('not_factory', { detail: `the configuration register is ${effective}` }));
            if (!warnings.includes('register_unusual')) warnings.push('register_unusual');
          }
        }
        if (f.kind === 'switch') {
          const v = await this.vlans();
          if (!v.ok) return at(v);
          const extra = v.vlans.filter((x) => !isDefaultVlan(x.id));
          if (extra.length) return at(fail('vlans_survived', { vlans: extra.map((x) => x.id).join(', ') }));
        }
        return { ok: true, hostname: boot.host, kind: f.kind, vlanDat, register, answered: boot.answered, warnings, bootSeconds: boot.seconds };
      } catch (err) {
        if (err.cancelled) err.stage = stage;
        throw err;
      }
    });
  }

  /** delete flash:vlan.dat → 'deleted' | 'absent' | a failure */
  async #deleteVlanDat() {
    const cli = this.#cli;
    const t = this.#t;
    cli.reset();
    await cli.answer('delete flash:vlan.dat');
    for (let q = 0; q < 4; q++) {
      const r = await cli.expect({
        filename: /Delete filename \[[^\]\n]*\]\? ?$/,
        confirm: /\[confirm\] ?$/,
        done: (b) => this.#atPrompt(b),
      }, { timeout: t.eraseMs, settle: t.settleMs });
      if (r.name === 'filename') { await cli.answer(''); continue; }
      if (r.name === 'confirm') { cli.send('\r'); continue; }
      if (r.name !== 'done') return fail('vlan_delete_failed', { detail: 'no answer' });
      const err = cli.buffer.match(/%Error deleting[^\n]*/);
      if (!err) return 'deleted';
      if (/No such file|not found|does not exist/i.test(err[0])) return 'absent';
      return fail('vlan_delete_failed', { detail: err[0] });
    }
    return fail('vlan_delete_failed', { detail: 'too many questions' });
  }

  /** Lines in configure terminal; true when none was refused */
  async #configure(lines) {
    const cli = this.#cli;
    cli.reset();
    await cli.answer('configure terminal');
    if (!(await cli.wait((b) => /\(config\)# ?$/.test(screenTail(b)), { timeout: this.#t.promptMs, settle: this.#t.settleMs, optional: true }))) return false;
    let ok = true;
    for (const l of lines) {
      cli.reset();
      await cli.answer(l);
      await cli.wait((b) => /\([\w.-]{1,40}\)# ?$/.test(screenTail(b)), { timeout: this.#t.promptMs, settle: this.#t.settleMs, optional: true });
      if (DEVICE_ERROR.test(cli.buffer)) ok = false;
    }
    cli.reset();
    await cli.answer('end');
    await cli.wait((b) => this.#atPrompt(b), { timeout: this.#t.promptMs, settle: this.#t.settleMs, optional: true });
    return ok;
  }

  /**
   * From "Proceed with reload" to a user EXEC prompt. Answers only the
   * questions it knows; any other question stops it with that question.
   * → { ok, host, answered, warnings, seconds } or a failure with its stage
   */
  async #followBoot() {
    const cli = this.#cli;
    const t = this.#t;
    const started = Date.now();
    const deadline = started + t.bootTotalMs;
    const answered = [];
    const warnings = [];
    let log = '';           // everything printed since the reload (tail kept)
    let stage = 'boot';
    let returns = 0;
    let pnp = false;
    let ready = false;      // "Press RETURN" or a prompt was seen: the boot itself is over
    let nudges = 0;
    const noBoot = { bootMarks: false };
    const keep = () => { log = (log + cli.buffer).slice(-200_000); cli.reset(); };
    const failAt = (reason, params) => ({ ...fail(reason, params), stage, lastOutput: tailOf(log + cli.buffer) });
    cli.reset();
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failAt('boot_timeout', { minutes: Math.round(t.bootTotalMs / 60_000) });
      const r = await cli.expect({
        screen: (b) => ['rommon', 'bootLoader', 'dialog', 'autoinstall', 'setup', 'pressReturn', 'user', 'privileged', 'question', 'confirm', 'save', 'password', 'username'].includes(classifyScreen(b, noBoot).state),
      }, { timeout: remaining, idle: ready && nudges < 3 ? Math.min(t.nudgeQuietMs, t.bootIdleMs) : t.bootIdleMs, settle: t.settleMs });
      pnp ||= PNP_STARTED.test(log + cli.buffer);
      if (r.name === null && r.outcome === 'idle' && ready && nudges < 3) {
        // Past the boot, a screen the driver does not read (a message it does not know after
        // the prompt, an Enter the console dropped) that stays quiet: ask for the prompt again
        nudges++;
        keep();
        cli.send('\r');
        continue;
      }
      if (r.name === null) {
        if (r.outcome === 'idle') return failAt('boot_stalled', { seconds: Math.round(t.bootIdleMs / 1000) });
        return failAt('boot_timeout', { minutes: Math.round(t.bootTotalMs / 60_000) });
      }
      const s = classifyScreen(cli.buffer, noBoot);
      if (s.state === 'question' || s.state === 'password' || s.state === 'username' || s.state === 'save' || s.state === 'confirm') {
        // Boot output can pause on a line ending in ':'; a real question stays still
        if (!(await cli.waitQuiet(t.questionSettleMs, { timeout: t.questionSettleMs * 2 })) || classifyScreen(cli.buffer, noBoot).state !== s.state) continue;
        return failAt('unknown_question', { question: s.line });
      }
      switch (s.state) {
        case 'rommon': return failAt('rommon');
        case 'bootLoader': return failAt('boot_loader');
        case 'dialog':
          stage = 'dialog';
          this.#say('Answering "no" to the initial configuration dialog', 'dialog', stage);
          keep(); answered.push('dialog'); await cli.answer('no');
          break;
        case 'autoinstall':
          keep(); answered.push('autoinstall'); await cli.answer('');
          break;
        case 'setup':
          keep(); answered.push('setup-abort'); cli.send('\x03');
          break;
        case 'pressReturn': {
          if (pnp && !PNP_STOPPED.test(log + cli.buffer)) {
            stage = 'pnp';
            this.#say('Waiting for Plug-and-Play discovery to stop', 'pnp', stage);
            const stopped = await cli.wait((b) => PNP_STOPPED.test(b), { timeout: t.pnpWaitMs, settle: t.settleMs, optional: true });
            if (!stopped) warnings.push('pnp_not_stopped');
          }
          if (++returns > 3) return failAt('unknown_state', { line: s.line });
          ready = true;
          keep();
          cli.send('\r');
          // The first answer can take a while (an 1841 needed more than 8 s)
          await cli.wait((b) => ['user', 'privileged', 'password', 'username'].includes(classifyScreen(b).state), { timeout: t.pressReturnMs, settle: t.settleMs, optional: true });
          break;
        }
        case 'user': case 'privileged': {
          // A prompt with no boot before it: the reload did not happen
          if (!answered.length && !BOOT_MARKS.test(log + cli.buffer)) return failAt('reload_refused');
          // Trust the prompt only once it answers again (IOS XE keeps printing syslog lines)
          const host = s.host;
          ready = true;
          keep();
          cli.send('\r');
          const again = await cli.wait((b) => { const x = classifyScreen(b); return (x.state === 'user' || x.state === 'privileged') && x.host === host; }, { timeout: t.pressReturnMs, settle: t.settleMs, optional: true });
          if (!again) continue;
          log += cli.buffer;
          return { ok: true, host, answered, warnings, seconds: Math.round((Date.now() - started) / 1000), stage };
        }
        default:
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Run inside the task holding the console, or take the keyboard for this procedure */
  #task(label, fn) {
    const cli = this.#cli;
    return cli.running ? fn(cli) : cli.perform(`ios:${label}`, fn);
  }

  #say(message, step, stage = undefined) {
    this.#progress(message, { code: `ios.steps.${step}`, stage });
  }

  #atPrompt(b) {
    const host = this.#host;
    const re = host ? new RegExp(`(?:^|\\n)${escapeRe(host)}(?:\\([^)\\n]*\\))?[>#] ?$`) : CISCO_PROMPT;
    return re.test(screenTail(b));
  }

  /** Enter, then the prompt: { ok, host, mark } (config mode is left with `end`) */
  async #findPrompt() {
    const cli = this.#cli;
    cli.reset();
    cli.send('\r');
    const ok = await cli.wait((b) => CISCO_PROMPT.test(screenTail(b)), { timeout: this.#t.promptMs, settle: this.#t.settleMs, optional: true });
    if (!ok) return fail('no_prompt', {}, { lastOutput: tailOf(cli.buffer) });
    let [, host, config, mark] = screenTail(cli.buffer).match(CISCO_PROMPT);
    if (config) {
      cli.reset();
      await cli.answer('end');
      if (!(await cli.wait((b) => CISCO_PROMPT.test(screenTail(b)), { timeout: this.#t.promptMs, settle: this.#t.settleMs, optional: true }))) return fail('no_prompt');
      [, host, , mark] = screenTail(cli.buffer).match(CISCO_PROMPT);
    }
    this.#host = host;
    return { ok: true, host, mark };
  }

  /** Send a command, answer the questions in `answers`; → the name that matched, or null */
  async #ask(command, answers, timeout) {
    const cli = this.#cli;
    cli.reset();
    await cli.answer(command);
    const r = await cli.expect({ ...answers, prompt: (b) => this.#atPrompt(b) }, { timeout, settle: this.#t.settleMs });
    return r.name === 'prompt' ? null : r.name;
  }

  /**
   * A show command with paging turned off around it (a syslog line landing on
   * a --More-- marker can glue itself to the next page on IOS XE).
   * → { ok, output } with the echo, the prompt, pager marks and syslog lines removed
   */
  async #show(command, { timeout = this.#t.commandMs } = {}) {
    const cli = this.#cli;
    const p = await this.#findPrompt();
    if (!p.ok) return p;
    const atPrompt = (b) => this.#atPrompt(b);
    const quick = { until: atPrompt, paging: false, timeout: this.#t.promptMs, idle: Infinity, settle: 80 };
    const off = await cli.command('terminal length 0', quick);
    const pagingOff = off.complete && !DEVICE_ERROR.test(off.output);
    const r = await cli.command(command, { until: atPrompt, paging: true, timeout, idle: Math.min(timeout, 60_000), settle: this.#t.settleMs });
    if (pagingOff) await cli.command('terminal length 24', quick);
    if (!r.complete) return fail('incomplete_output', {}, { lastOutput: tailOf(r.output) });
    const output = cleanOutput(r.output);
    const err = output.match(/^%(?! ?Error deleting)[^\n]*/m);
    if (err && /^% ?(Invalid input|Incomplete command|Ambiguous command|Unknown command|Unrecognized host|CDP is not enabled)/.test(err[0])) {
      return fail('command_refused', { detail: err[0] }, { lastOutput: tailOf(r.output) });
    }
    return { ok: true, output };
  }
}

/** Captured command output → its text: no echo line, no final prompt, no pager marks, no syslog */
function cleanOutput(captured) {
  let lines = captured.replace(/\s*--More--\s*/g, '\n').split('\n');
  lines = lines.slice(1).filter((l) => !isSyslogLine(l));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length && CISCO_PROMPT.test(`\n${lines.at(-1)}`)) lines.pop();
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
}

const isIpv4 = (s) => typeof s === 'string' && /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
const isDefaultVlan = (id) => id === 1 || (id >= 1002 && id <= 1005);

// ── Backup proof: "no backup, no erase" ─────────────────────────────────────

/**
 * eraseAndReload() starts only with one of:
 *   { kind: 'snapshot', snapshotId, config, hostname? }  a backup taken by the job: its
 *        running-config (must look like one) and the hostname it was taken from (by default
 *        the config's `hostname` line), which must match the prompt before anything is erased
 *   { kind: 'override', by, reason? }   an admin ticked "erase without a backup" by hand
 * → { ok, kind, hostname }
 */
export function checkBackupProof(proof) {
  if (!proof || typeof proof !== 'object') return { ok: false };
  if (proof.kind === 'override') return typeof proof.by === 'string' && proof.by.trim() ? { ok: true, kind: 'override', hostname: null } : { ok: false };
  if (proof.kind !== 'snapshot') return { ok: false };
  if (typeof proof.snapshotId !== 'string' || !proof.snapshotId.trim()) return { ok: false };
  if (typeof proof.config !== 'string' || !/^(hostname|version) \S/m.test(proof.config)) return { ok: false };
  // Without an explicit hostname, the one the configuration names: a snapshot of another device
  // (two console ports swapped) is then refused before anything is erased
  const named = (proof.config.match(/^hostname (\S+)\s*$/m) || [])[1] || null;
  return { ok: true, kind: 'snapshot', hostname: typeof proof.hostname === 'string' && proof.hostname ? proof.hostname : named };
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/** show version → facts (family null when it is not Cisco IOS / IOS XE) */
export function parseShowVersion(text) {
  const t = String(text);
  const xe = t.match(/Cisco IOS XE Software, Version (\S+)/);
  const ios = t.match(/Cisco IOS Software(?: \[\w+\])?, (.+?) Software \(([^)]+)\), (?:Experimental )?Version ([^,\s]+)/);
  const family = xe ? 'iosxe' : ios ? 'ios' : null;
  const model = (t.match(/^Model [Nn]umber\s*:\s*(\S+)/m) || t.match(/^[Cc]isco (\S+) \([^)]*\) (?:processor|with)/m) || [])[1] || null;
  const reg = t.match(/Configuration register is (0x[0-9A-Fa-f]+)(?: \(will be (0x[0-9A-Fa-f]+) at next reload\))?/);
  const kind = /^Model [Nn]umber\s*:/m.test(t) || /Switch Ports Model/.test(t) || /^(WS-C|C1000|C9\d00|IE-)/.test(model || '') ? 'switch' : 'router';
  const configRegister = reg ? reg[1] : null;
  const nextConfigRegister = reg?.[2] ?? null;
  const warnings = [];
  let registerOk = true;
  if (kind === 'router' && configRegister) {
    const effective = (nextConfigRegister || configRegister).toLowerCase();
    if (effective !== '0x2102') { registerOk = false; warnings.push('register_unusual'); }
  }
  return {
    family,
    kind,
    model,
    version: xe ? xe[1] : ios ? ios[3] : null,
    software: ios ? ios[2] : null,
    image: (t.match(/System image file is "([^"]+)"/) || [])[1] || null,
    configRegister,
    nextConfigRegister,
    registerOk,
    hostname: (t.match(/^(\S+) uptime is/m) || [])[1] || null,
    uptime: (t.match(/^\S+ uptime is (.+)$/m) || [])[1] || null,
    serial: (t.match(/^Processor board ID (\S+)/m) || [])[1] || null,
    warnings,
  };
}

/** show vlan brief → [{ id, name, status, ports: ['Fa0/1', …] }] (fixed columns, as IOS prints them) */
export function parseVlanBrief(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\d{1,4})\s+(\S+)\s+(active|suspended|act\/lshut|sus\/lshut|act\/ishut|sus\/ishut|act\/unsup)\b\s*(.*)$/);
    if (m) {
      out.push({ id: Number(m[1]), name: m[2], status: m[3], ports: splitPorts(m[4]) });
    } else if (/^\s{20,}\S/.test(line) && out.length) {
      out.at(-1).ports.push(...splitPorts(line));
    }
  }
  return out;
}
const splitPorts = (s) => s.split(',').map((p) => p.trim()).filter(Boolean);

/**
 * show vtp status → { version, mode, domain, pruning } or null. Both layouts:
 * 12.2SE ("VTP Version : running VTP1 (VTP2 capable)" or "VTP Version : 2",
 * "VTP V2 Mode : Enabled") and 15.x / IOS XE ("VTP version running : 1").
 */
export function parseVtpStatus(text) {
  const t = String(text);
  const mode = t.match(/^\s*VTP Operating Mode\s*:\s*(Server|Client|Transparent|Off)\b/im);
  if (!mode) return null;
  const running = t.match(/^VTP version running\s*:\s*(\d)/im) || t.match(/^VTP Version\s*:\s*running VTP(\d)/im) || t.match(/^VTP Version\s*:\s*(\d)\s*$/im);
  let version = running ? Number(running[1]) : 1;
  if (version === 1 && /^VTP V2 Mode\s*:\s*Enabled/im.test(t)) version = 2;
  const domain = (t.match(/^VTP Domain Name\s*:[ \t]*(\S*)/im) || [])[1] || '';
  return { version, mode: mode[1].toLowerCase(), domain, pruning: /^VTP Pruning Mode\s*:\s*Enabled/im.test(t) };
}

/** show vtp password → the password, or null ("The VTP password is not configured.") */
export function parseVtpPassword(text) {
  return (String(text).match(/^VTP Password:[ \t]*(\S+)/m) || [])[1] || null;
}

/** show cdp neighbors detail → [{ deviceId, ip, platform, capabilities, localInterface, remoteInterface, version, nativeVlan, duplex }] */
export function parseCdpNeighbors(text) {
  return String(text).split(/^-{5,}\s*$/m).map((block) => {
    const get = (re) => (block.match(re) || [])[1]?.trim() ?? null;
    const deviceId = get(/Device ID: ?(.+)/);
    if (!deviceId) return null;
    const platform = block.match(/Platform: ?([^,\n]+),\s*Capabilities: ?([^\n]*)/);
    const ifs = block.match(/Interface: ?([^,\n]+),\s*Port ID \(outgoing port\): ?([^\n]+)/);
    const version = block.match(/Version ?:\s*\n([\s\S]*?)(?:\n\s*\n|$)/);
    return {
      deviceId,
      ip: get(/IP(?:v4)? address: ?(\S+)/),
      platform: platform ? platform[1].replace(/^cisco /i, '').trim() : null,
      capabilities: platform ? platform[2].trim() : null,
      localInterface: ifs ? ifs[1].trim() : null,
      remoteInterface: ifs ? ifs[2].trim() : null,
      version: version ? version[1].trim() : null,
      nativeVlan: get(/Native VLAN: ?(\d+)/) ? Number(get(/Native VLAN: ?(\d+)/)) : null,
      duplex: get(/Duplex: ?(\S+)/),
    };
  }).filter(Boolean);
}

const IP_BRIEF_TAIL = String.raw`(YES|NO)\s+(\S+)\s+(up|down|administratively down|reset|deleted)\s+(up|down)\s*$`;
const IP_BRIEF_ROW = new RegExp(String.raw`^(\S+)\s+(\S+)\s+${IP_BRIEF_TAIL}`);
/** A name as long as its column is glued to the address: only readable when the address is "unassigned" */
const IP_BRIEF_GLUED = new RegExp(String.raw`^(\S+?)(unassigned)\s+${IP_BRIEF_TAIL}`);
/** The lines of `show ip interface brief` that look like an interface row (readable or not) */
const IP_BRIEF_LOOKS = new RegExp(String.raw`\s${IP_BRIEF_TAIL}`);

/** How many lines of `show ip interface brief` are interface rows, whether parseIpInterfaceBrief reads them or not */
export function countRows(text) {
  return String(text).split('\n').filter((line) => IP_BRIEF_LOOKS.test(line)).length;
}

/** show ip interface brief → [{ name, ip, ok, method, status, protocol }] */
export function parseIpInterfaceBrief(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(IP_BRIEF_ROW) ?? line.match(IP_BRIEF_GLUED);
    if (m) out.push({ name: m[1], ip: m[2] === 'unassigned' ? null : m[2], ok: m[3] === 'YES', method: m[4], status: m[5], protocol: m[6] });
  }
  return out;
}

/** ping output → { sent, received, successRate, marks, rtt } or null */
export function parsePing(text) {
  const m = String(text).match(/Success rate is (\d+) percent \((\d+)\/(\d+)\)(?:, round-trip min\/avg\/max = (\d+)\/(\d+)\/(\d+) ms)?/);
  if (!m) return null;
  return {
    successRate: Number(m[1]),
    received: Number(m[2]),
    sent: Number(m[3]),
    marks: (String(text).match(/^[!.UQM?&]+$/m) || [''])[0],
    rtt: m[4] ? { min: Number(m[4]), avg: Number(m[5]), max: Number(m[6]) } : null,
  };
}

// ── Replay ──────────────────────────────────────────────────────────────────

/** Top-level lines (and their block) that a replay must not send, with the reason */
const NOT_REPLAYABLE = [
  [/^Building configuration/, 'header'],
  [/^Current configuration\b/, 'header'],
  [/^Using \d+ out of \d+ bytes/, 'header'],
  [/^version \S+/, 'set by the software image'],
  [/^boot-(start|end)-marker$/, 'boot marker'],
  [/^end$/, 'added back at the end of the script'],
  [/^license /, 'licence: tied to the chassis, not replayable'],
  [/^platform /, 'factory default of IOS XE'],
  [/^diagnostic bootup /, 'factory default of IOS XE'],
  [/^redundancy$/, 'factory default of IOS XE'],
  [/^crypto pki (trustpoint|certificate chain) /, 'certificate: generated by the device itself'],
  [/^crypto pki certificate pool$/, 'certificate: generated by the device itself'],
  [/^ntp clock-period /, 'computed by the device'],
  [/^call-home$/, 'factory default (Smart Licensing)'],
  [/^(class-map|policy-map) .*system-cpp/, 'system policy of IOS XE'],
];
const BANNER_HEAD = /^banner (motd|login|exec|incoming|slip-ppp|prompt-timeout)\s+(\^C|\x03)(.*)$/;
const DELIMITERS = ['#', '%', '~', '@', '$', '&', '*', '+', '=', '|', '`', ';', '"', '/', '\\', '?', '<', '>', '{', '}'];

/** Split a running-config into top-level entries { head, body, at } (a banner is one entry) */
function entriesOf(config) {
  const lines = String(config).replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const banner = line.match(BANNER_HEAD);
    if (banner) {
      // The text runs to the next ^C, possibly on the same line
      const close = /\^C|\x03/;
      let rest = banner[3];
      let text;
      if (close.test(rest)) text = rest.slice(0, rest.search(close));
      else {
        const parts = [rest];
        while (++i < lines.length && !close.test(lines[i])) parts.push(lines[i].replace(/\r$/, ''));
        if (i < lines.length) parts.push(lines[i].slice(0, lines[i].search(close)));
        text = parts.join('\n');
      }
      entries.push({ head: line, banner: { kind: banner[1], text }, body: [], at: entries.length });
      continue;
    }
    if (/^\s/.test(line) && entries.length && line.trim()) { entries.at(-1).body.push(line); continue; }
    entries.push({ head: line, body: [], at: entries.length });
  }
  return entries;
}

const isComment = (l) => /^\s*!/.test(l);
const notReplayable = (head) => NOT_REPLAYABLE.find(([re]) => re.test(head))?.[1] ?? null;

/**
 * A captured running-config → a script that, sent to a factory-fresh device
 * of the same model, reproduces it:
 *   - `no shutdown` added to the interfaces that were not shut (routers start
 *     with every interface shut; on switches it is harmless)
 *   - ^C banners re-delimited with a character absent from their text
 *   - header, version, boot markers, certificate chains, licence lines and the
 *     IOS XE factory blocks dropped (`dropped` says which and why); comments too
 *   - the VTP settings of vlans() (`vtp`: version, domain, password, mode: they
 *     live in vlan.dat, not in show run) set first, then the VLANs of `show vlan
 *     brief` (array from vlans() or the raw text) recreated with their suspended
 *     or shut state, unless the config defines them itself (VTP transparent); a
 *     VTP client gets its VLANs before `vtp mode client`, which forbids creating them
 *   - optional `rsaModulus`: RSA keys generated after `ip domain name`
 *   - wrapped in `configure terminal` … `end`
 * Send it with injectScript(script, { skipComments: false, lineTimeouts }):
 * banner text may start with "!", and key generation takes longer than an
 * ordinary line (2048 bits on an ISR G1: a minute or more).
 * → { script, dropped: [{ line, text, reason }], vlans: [ids recreated], lineTimeouts: { [line]: ms } }
 */
export function toReplayScript(config, { vlans = null, vtp = null, facts = {}, rsaModulus = null } = {}) {
  const entries = entriesOf(config);
  const body = [];
  const dropped = [];
  const definedVlans = new Set();
  let hostnameAt = -1;
  let domainAt = -1;
  for (const e of entries) {
    const head = e.head;
    if (!head.trim() || isComment(head)) continue;
    const why = notReplayable(head);
    if (why) {
      if (why !== 'added back at the end of the script' && why !== 'header') dropped.push({ line: e.at + 1, text: head, reason: why, lines: 1 + e.body.length });
      continue;
    }
    if (e.banner) {
      const d = DELIMITERS.find((c) => !e.banner.text.includes(c));
      if (!d) { dropped.push({ line: e.at + 1, text: head, reason: 'banner text uses every possible delimiter', lines: 1 }); continue; }
      body.push(...`banner ${e.banner.kind} ${d}${e.banner.text}${d}`.split('\n'));
      continue;
    }
    const sub = e.body.filter((l) => !isComment(l));
    if (/^vlan \d+$/.test(head)) definedVlans.add(Number(head.split(' ')[1]));
    if (/^interface \S/.test(head)) {
      body.push(head, ...sub);
      if (!sub.some((l) => l.trim() === 'shutdown')) body.push(' no shutdown');
      continue;
    }
    body.push(head, ...sub);
    if (/^hostname \S/.test(head)) hostnameAt = body.length;
    if (/^ip domain[- ]name \S/.test(head)) domainAt = body.length;
  }

  // VTP, then the VLANs (after the hostname): ports join them later in the script
  const created = [];
  const lines = [];
  const ownVtp = (key) => body.some((l) => l.startsWith(`vtp ${key} `));
  const v = facts.kind !== 'router' && vtp && typeof vtp === 'object' ? vtp : null;
  const word = (x) => typeof x === 'string' && /^[\x21-\x7e]{1,64}$/.test(x);
  if (v) {
    if ([2, 3].includes(Number(v.version)) && !ownVtp('version')) lines.push(`vtp version ${Number(v.version)}`);
    if (word(v.domain) && !ownVtp('domain')) lines.push(`vtp domain ${v.domain}`);
    if (word(v.password) && !ownVtp('password')) lines.push(`vtp password ${v.password}`);
  }
  const mode = v && ['client', 'transparent', 'off'].includes(v.mode) && !ownVtp('mode') ? `vtp mode ${v.mode}` : null;
  if (mode && v.mode !== 'client') lines.push(mode);
  if (vlans && facts.kind !== 'router') {
    const list = Array.isArray(vlans) ? vlans : parseVlanBrief(vlans);
    const made = [];
    for (const x of list) {
      const id = Number(x.id);
      if (!Number.isInteger(id) || isDefaultVlan(id) || definedVlans.has(id) || id < 1 || id > 4094) continue;
      made.push(`vlan ${id}`);
      if (x.name && x.name !== `VLAN${String(id).padStart(4, '0')}` && /^[\x21-\x7e]{1,32}$/.test(x.name)) made.push(` name ${x.name}`);
      if (/^sus/.test(x.status || '')) made.push(' state suspend');
      if (/\/lshut$/.test(x.status || '')) made.push(' shutdown');
      created.push(id);
    }
    if (made.length) lines.push(...made, 'exit');
  }
  if (mode && v.mode === 'client') lines.push(mode);
  if (lines.length) {
    if (domainAt >= hostnameAt && domainAt >= 0) domainAt += lines.length;
    body.splice(hostnameAt < 0 ? 0 : hostnameAt, 0, ...lines);
  }
  const lineTimeouts = {};
  const modulus = Number(rsaModulus);
  if (rsaModulus && domainAt >= 0 && RSA_SECONDS[modulus]) {
    body.splice(domainAt, 0, `crypto key generate rsa general-keys modulus ${modulus}`);
    lineTimeouts[domainAt + 2] = RSA_SECONDS[modulus] * 1000; // + 1: 1-based, + 1: "configure terminal"
  }
  const script = ['configure terminal', ...body, 'end'].join('\n');
  return { script: `${script}\n`, dropped, vlans: created, lineTimeouts };
}

/** Budget for `crypto key generate rsa` per modulus, slowest family (ISR G1: 2048 bits takes a minute or more) */
const RSA_SECONDS = { 512: 30, 768: 30, 1024: 60, 2048: 300, 4096: 900 };

/**
 * A running-config reduced to what a replay reproduces, for comparisons
 * (snapshot vs live after an injection): no header, no comments, no volatile
 * or non-replayable lines, banners normalised.
 */
export function comparableConfig(config) {
  const out = [];
  for (const e of entriesOf(config)) {
    if (!e.head.trim() || isComment(e.head) || notReplayable(e.head)) continue;
    if (e.banner) { out.push(`banner ${e.banner.kind} ^C${e.banner.text}^C`); continue; }
    out.push(e.head.replace(/\s+$/, ''), ...e.body.filter((l) => !isComment(l)).map((l) => l.replace(/\s+$/, '')));
  }
  return `${out.join('\n')}\n`;
}
