/**
 * Password recovery of a Cisco device left locked (SPEC "Lot recovery")
 *
 * A group leaves a console line password or an enable secret nobody knows:
 * the device can no longer be used, backed up or reset from the application.
 * The way out needs someone on site, who switches the device off and on again
 * (holding the Mode button on a switch) while the application, on the
 * console, interrupts the boot and makes the device start WITHOUT its
 * startup-config. The device then comes up at a clean factory prompt; the
 * startup-config itself is never erased nor changed (only bypassed), and
 * the device is left so that its next boot reads it again. The team then
 * injects a backup or starts afresh (the jobs: an injection saved with
 * `copy running-config startup-config`, or a reset).
 *
 * One procedure per family (FAMILIES), as a list of steps (STEPS). Each step
 * is one method below, run inside the task that holds the console
 * (room.runExclusive); the recovery module asks the person to confirm each
 * one before it runs. Every screen is recognised by its text; anything else
 * stops the step with a reason and nothing more is typed:
 *
 *   routers (ISR G1 1841 / 2801 / 2811, IOS 12.4; ISR 4331, IOS XE 17.3)
 *     power_cycle      the person power-cycles; BREAK is sent, again and again,
 *                      from the first line of the boot until `rommon N >`
 *     confreg          confreg 0x2142: the next boot ignores the startup-config
 *     boot             reset; the boot is followed, the initial dialog answered
 *                      "no", until Router>
 *     restore_register enable, config-register 0x2102 (the next boot reads the
 *                      startup-config again), checked with show version
 *   classic Catalyst (2960, 3560, 3560V2, IOS 12.2 / 15.0) and Catalyst 1000
 *     power_cycle      the person power-cycles holding Mode, until `switch:`
 *     flash_init       the boot loader's flash
 *     park_config      flash:config.text (the startup-config) is renamed
 *                      flash:config.text.recovery, never deleted
 *     boot             boot; followed until Switch>
 *     restore_config   enable, rename flash:config.text.recovery flash:config.text
 *   Catalyst 9300L (IOS XE 17.6)
 *     power_cycle      holding Mode, until `switch:`
 *     ignore_startup   SWITCH_IGNORE_STARTUP_CFG=1
 *     boot             boot; followed until Switch>
 *     restore_startup  enable, no system ignore startupconfig switch all
 *
 * A first step, `look`, reads the console before anything: a router already
 * in ROMMON, a switch already at `switch:`, a router at the initial
 * configuration dialog (the 1841 left at register 0x2141 by an unfinished
 * recovery) skip what is already done (planFrom()).
 *
 * Results: { ok: true, ... } or { ok: false, reason: 'recovery.<code>', message,
 * params, retry?, lastOutput? }. `retry`: the person may try the same step
 * again (the BREAK came too late, Mode was released too early). Codes are
 * translated under `recovery.errors.*`, progress under `recovery.progress.*`.
 *
 * Not verified on the real equipment (no lab access while it was written): the
 * Catalyst 1000 (taken to behave like the 2960, which its documentation
 * follows) and the Catalyst 9300L procedures, the exact boot loader messages,
 * and how quickly the console server passes a BREAK on.
 */
import { screenTail, escapeRe } from '../cliAutomation.js';
import { CiscoIos, classifyScreen, BOOT_MARKS, TIMEOUTS as IOS_TIMEOUTS } from './ciscoIos.js';

/** The device families of the lab, and how each one is recovered */
export const FAMILIES = Object.freeze({
  isr_g1: Object.freeze({ kind: 'router', method: 'confreg', models: ['1841', '2801', '2811'], software: 'IOS 12.4T', verified: true }),
  isr4300: Object.freeze({ kind: 'router', method: 'confreg', models: ['ISR4331'], software: 'IOS XE 17.3', verified: true }),
  catalyst: Object.freeze({ kind: 'switch', method: 'config_text', models: ['WS-C2960', 'WS-C3560', 'WS-C3560V2'], software: 'IOS 12.2SE / 15.0SE', verified: true }),
  c1000: Object.freeze({ kind: 'switch', method: 'config_text', models: ['C1000'], software: 'IOS 15.2(7)E', verified: false }),
  c9300l: Object.freeze({ kind: 'switch', method: 'ignore_startup', models: ['C9300L'], software: 'IOS XE 17.6', verified: false }),
});

/** The steps of each method, in order (`look` comes first, always) */
export const STEPS = Object.freeze({
  confreg: Object.freeze(['look', 'power_cycle', 'confreg', 'boot', 'restore_register']),
  config_text: Object.freeze(['look', 'power_cycle', 'flash_init', 'park_config', 'boot', 'restore_config']),
  ignore_startup: Object.freeze(['look', 'power_cycle', 'ignore_startup', 'boot', 'restore_startup']),
});

/** Steps the person does something for: the UI says what (power off and on, hold Mode) */
export const HANDS_ON = Object.freeze(new Set(['power_cycle']));

/** Where flash:config.text goes while the switch boots without it */
export const PARKED_NAME = 'config.text.recovery';

/** Real-life budgets; the tests and the mock lab pass shorter ones (scaled like the jobs') */
export const RECOVERY_TIMEOUTS = Object.freeze({
  ...IOS_TIMEOUTS,
  powerOnMs: 5 * 60_000,      // after "ready": the person reaches the device and switches it off and on
  breakEveryMs: 1000,         // a BREAK this often once the boot shows…
  breakWindowMs: 60_000,      // … for this long: ROMMON listens during the first minute of the boot
  bootLoaderMs: 4 * 60_000,   // first line of the boot → switch: (a 9300L takes about two minutes)
  flashInitMs: 3 * 60_000,    // flash_init on an old switch
  monitorMs: 20_000,          // an ordinary ROMMON / boot loader command
  confirmMs: 30 * 60_000,     // the person's confirmation of the next step (the module waits for it)
});

/** The budgets multiplied by `scale` (JOB_TIME_SCALE), as the jobs do */
export function scaledRecoveryTimeouts(scale = 1, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(RECOVERY_TIMEOUTS)) out[k] = k === 'wakes' ? v : Math.max(k === 'settleMs' ? 30 : 100, Math.round(v * scale));
  return { ...out, ...overrides };
}

const MESSAGES = {
  unknown_family: 'Unknown device family "{family}".',
  wrong_family: 'The console shows "{line}", which is not what a {expected} shows: check the device family.',
  no_boot_seen: 'Nothing was printed after the power cycle: is it the right device, and is its console cable plugged in?',
  break_missed: 'The device loaded its software before the BREAK took effect. Power it off and on again.',
  mode_missed: 'The switch loaded its software: the Mode button was released too early. Power it off and on again, holding Mode until the console shows switch:.',
  recovery_disabled: 'Password recovery is disabled on this switch: it only offers to erase its configuration. Nothing was answered: power it off and on without holding Mode to leave it as it was.',
  unknown_question: 'The device asks a question the assistant does not know: "{question}". Nothing was answered.',
  unexpected_screen: 'The console shows "{line}" where the assistant expected {expected}. Nothing more was typed.',
  monitor_no_answer: 'The device did not answer "{command}".',
  monitor_refused: 'The device refused "{command}": {detail}',
  parked_exists: 'flash:{name} already exists next to flash:config.text: an earlier recovery left it. Nothing is overwritten: someone must look at the flash on site.',
  rename_failed: 'The startup-config file could not be renamed: {detail}',
  still_locked: 'The device still asks for a password: its startup-config was not bypassed.',
  not_bypassed: 'The device booted its own configuration (prompt {host}): the startup-config was not bypassed.',
  enable_refused: 'enable asks for a password after the bypass: the device is not at a factory prompt.',
  register_not_restored: 'The configuration register could not be set back to 0x2102 (it reads {register}).',
  config_not_restored: 'flash:config.text could not be put back: {detail}',
  ignore_not_cleared: 'The switch refused to read its startup-config again: {detail}',
};

/** Every reason (without `recovery.`), translated under recovery.errors.* */
export const RECOVERY_REASONS = Object.freeze(Object.keys(MESSAGES));

function fail(reason, params = {}, extra = {}) {
  const message = (MESSAGES[reason] || reason).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
  return { ok: false, reason: `recovery.${reason}`, message, params, ...extra };
}
const tailOf = (text, max = 1500) => String(text).slice(-max).replace(/^[^\n]*\n/, '');

// What telnet itself prints when the application sends a BREAK ("telnet> send brk"), wherever the
// device's own output lands around it (a BREAK still on its way when ROMMON prints its prompt): not the device
const clean = (b) => String(b).replace(/telnet> ?/g, '').replace(/send brk/g, '').replace(/\n[ \t]*(?=\n)/g, '\n');
const ROMMON = /(?:^|\n)rommon \d+ ?> ?$/;
const LOADER = /(?:^|\n)switch: ?$/;
const RECOVERY_DISABLED = /password-recovery mechanism has been triggered, but\s+is currently disabled|reset the system back to the default configuration \(y\/n\)\? ?$/;
const IOS_STARTED = /Press RETURN to get started|initial configuration dialog\?|%SYS-5-RESTART/;
const lastLine = (b) => (screenTail(clean(b)).split('\n').at(-1) || '').trim().slice(0, 120);

/** What was printed from the first line of a boot on (what came before belongs to the previous one) */
const sinceBoot = (b) => { const at = String(b).search(BOOT_MARKS); return at < 0 ? '' : String(b).slice(at); };

/** The IOS software is up (the BREAK window is over, or Mode was not held), in output since the boot began */
function iosStarted(b) {
  const text = clean(sinceBoot(b));
  if (IOS_STARTED.test(text)) return true;
  return ['pressReturn', 'dialog', 'autoinstall', 'password', 'username', 'user', 'privileged'].includes(classifyScreen(text, { bootMarks: false }).state);
}

/** What the console shows: classifyScreen() of the cleaned text */
const screenOf = (b, opts) => classifyScreen(clean(b), opts);

/**
 * The steps left once `look` has read the console (→ string[] starting after
 * `look`), or a failure (the console contradicts the family)
 */
export function planFrom(family, look) {
  const f = FAMILIES[family];
  if (!f) return fail('unknown_family', { family: String(family).slice(0, 40) });
  const steps = STEPS[f.method].slice(1);
  const state = look?.state;
  if (state === 'rommon' && f.kind === 'switch') return fail('wrong_family', { line: look.line, expected: family });
  if (state === 'bootLoader' && f.kind === 'router') return fail('wrong_family', { line: look.line, expected: family });
  // Already interrupted: the power cycle is done
  if (state === 'rommon' || state === 'bootLoader') return steps.slice(steps.indexOf('power_cycle') + 1);
  // A router at the initial dialog already ignores its startup-config (left at 0x2141 / 0x2142)
  if (f.kind === 'router' && (state === 'dialog' || state === 'autoinstall')) return steps.slice(steps.indexOf('boot'));
  return steps;
}

export class CiscoRecovery {
  #cli;
  #t;
  #progress;
  #ios;

  /**
   * @param cli       the CliAutomation of the console line, inside a running task
   * @param family    a key of FAMILIES
   * @param timeouts  overrides of RECOVERY_TIMEOUTS
   * @param progress  (code, params) => void: what is going on, for the person (recovery.progress.*)
   */
  constructor(cli, { family, timeouts = {}, progress = () => {} } = {}) {
    if (!FAMILIES[family]) throw new TypeError(`Unknown device family "${family}"`);
    this.#cli = cli;
    this.family = family;
    this.kind = FAMILIES[family].kind;
    this.#t = { ...RECOVERY_TIMEOUTS, ...timeouts };
    this.#progress = progress;
    this.#ios = new CiscoIos(cli, { timeouts: this.#t, progress: (_m, { code }) => code && progress(code, {}) });
  }

  /** Run the step `id` (one of STEPS) with what earlier steps found (`facts`) */
  run(id, facts = {}) {
    const steps = {
      look: () => this.look(facts),
      power_cycle: () => this.interruptBoot(),
      confreg: () => this.setConfreg(),
      flash_init: () => this.flashInit(),
      park_config: () => this.parkConfig(),
      ignore_startup: () => this.ignoreStartup(),
      boot: () => this.boot(),
      restore_register: () => this.restoreRegister(),
      restore_config: () => this.restoreConfig(facts),
      restore_startup: () => this.restoreStartupUse(),
    };
    if (!steps[id]) throw new TypeError(`Unknown recovery step "${id}"`);
    return steps[id]();
  }

  // ── look ──────────────────────────────────────────────────────────────────

  /**
   * Read the console without typing, except one Enter where it is harmless
   * and tells something: an empty or unreadable screen (a sleeping line), or
   * a ROMMON / boot loader / initial dialog prompt (to be sure it is still
   * there). Never on a question, a [confirm] or a password prompt.
   * → { ok: true, state, line }
   */
  async look({ screen = '' } = {}) {
    const cli = this.#cli;
    const t = this.#t;
    this.#progress('recovery.progress.look');
    cli.reset();
    await cli.waitQuiet(t.quietMs, { timeout: t.observeMs });
    let s = screenOf(`${screen}\n${cli.buffer}`);
    if (['empty', 'unknown', 'rommon', 'bootLoader', 'dialog', 'autoinstall'].includes(s.state)) {
      cli.reset();
      cli.send('\r');
      const known = (b) => !['empty', 'unknown', 'booting'].includes(screenOf(b).state);
      await cli.wait(known, { timeout: t.wakeWaitMs, settle: t.settleMs, optional: true });
      const now = screenOf(cli.buffer);
      s = now.state === 'empty' ? { state: 'silent', line: '' } : now;
    }
    return { ok: true, state: s.state, line: s.line };
  }

  // ── power cycle: BREAK into ROMMON, or the Mode button to switch: ────────

  /**
   * The person switches the device off and on (the module told them to, now).
   * A router: from the first line of its boot, a BREAK every `breakEveryMs`
   * until `rommon N >`, for `breakWindowMs` at most. A switch: wait for
   * `switch:` (the person holds Mode). → { ok, breaks? }
   */
  async interruptBoot() {
    const cli = this.#cli;
    const t = this.#t;
    cli.reset();
    this.#progress('recovery.progress.power_now');
    const first = await cli.expect({
      rommon: (b) => ROMMON.test(screenTail(clean(b))),
      loader: (b) => LOADER.test(screenTail(clean(b))),
      disabled: (b) => RECOVERY_DISABLED.test(clean(b)),
      boot: (b) => BOOT_MARKS.test(b),
    }, { timeout: t.powerOnMs, settle: 0 });
    if (!first.name) return fail('no_boot_seen', {}, { retry: true, lastOutput: tailOf(clean(cli.buffer)) });
    return this.kind === 'router' ? this.#breakIntoRommon(first.name) : this.#waitForLoader(first.name);
  }

  async #breakIntoRommon(first) {
    const cli = this.#cli;
    const t = this.#t;
    if (first === 'loader') return fail('wrong_family', { line: lastLine(cli.buffer), expected: this.family }, { lastOutput: tailOf(clean(cli.buffer)) });
    if (first !== 'rommon') {
      this.#progress('recovery.progress.sending_break');
      const until = Date.now() + t.breakWindowMs;
      let breaks = 0;
      for (;;) {
        if (iosStarted(cli.buffer)) return fail('break_missed', {}, { retry: true, lastOutput: tailOf(clean(cli.buffer)) });
        cli.sendBreak();
        breaks++;
        const r = await cli.expect({
          rommon: (b) => ROMMON.test(screenTail(clean(b))),
          loader: (b) => LOADER.test(screenTail(clean(b))),
          ios: iosStarted,
        }, { timeout: t.breakEveryMs, settle: 0 });
        if (r.name === 'rommon') { this.#progress('recovery.progress.in_rommon', { breaks }); break; }
        if (r.name === 'loader') return fail('wrong_family', { line: lastLine(cli.buffer), expected: this.family }, { lastOutput: tailOf(clean(cli.buffer)) });
        if (r.name === 'ios' || Date.now() > until) return fail('break_missed', {}, { retry: true, lastOutput: tailOf(clean(cli.buffer)) });
      }
      // A BREAK may still be on its way: let it land on the prompt, harmlessly
      await cli.waitQuiet(Math.min(600, t.breakEveryMs), { timeout: t.breakEveryMs * 2 });
      return { ok: true, breaks };
    }
    return { ok: true, breaks: 0 };
  }

  async #waitForLoader(first) {
    const cli = this.#cli;
    const t = this.#t;
    let name = first;
    if (name === 'boot') {
      this.#progress('recovery.progress.hold_mode');
      const r = await cli.expect({
        loader: (b) => LOADER.test(screenTail(clean(b))),
        rommon: (b) => ROMMON.test(screenTail(clean(b))),
        disabled: (b) => RECOVERY_DISABLED.test(clean(b)),
        ios: iosStarted,
        question: (b) => screenOf(b, { bootMarks: false }).state === 'question',
      }, { timeout: t.bootLoaderMs, settle: t.settleMs });
      name = r.name;
      if (name === 'question') {
        // Boot output pauses on a ':' now and then: a real question stays still
        if (!(await cli.waitQuiet(t.questionSettleMs, { timeout: t.questionSettleMs * 2 }))) return this.#waitForLoader('boot');
        if (RECOVERY_DISABLED.test(clean(cli.buffer))) name = 'disabled';
        else if (LOADER.test(screenTail(clean(cli.buffer)))) name = 'loader';
        else return fail('unknown_question', { question: lastLine(cli.buffer) }, { lastOutput: tailOf(clean(cli.buffer)) });
      }
    }
    if (name === 'disabled') return fail('recovery_disabled', {}, { lastOutput: tailOf(clean(cli.buffer)) });
    if (name === 'rommon') return fail('wrong_family', { line: lastLine(cli.buffer), expected: this.family }, { lastOutput: tailOf(clean(cli.buffer)) });
    if (name === 'ios') return fail('mode_missed', {}, { retry: true, lastOutput: tailOf(clean(cli.buffer)) });
    if (name !== 'loader') return fail('no_boot_seen', {}, { retry: true, lastOutput: tailOf(clean(cli.buffer)) });
    await cli.waitQuiet(t.settleMs, { timeout: t.monitorMs });
    this.#progress('recovery.progress.in_loader');
    return { ok: true };
  }

  // ── ROMMON / boot loader commands ─────────────────────────────────────────

  /** confreg 0x2142 in ROMMON: the next boot ignores the startup-config */
  async setConfreg() {
    const no = await this.#atMonitor('rommon');
    if (no) return no;
    const r = await this.#monitorCommand('confreg 0x2142', ROMMON);
    if (!r.ok) return r;
    this.#progress('recovery.progress.confreg_set');
    return { ok: true, register: '0x2142' };
  }

  /** flash_init at a classic switch's boot loader */
  async flashInit() {
    const no = await this.#atMonitor('bootLoader');
    if (no) return no;
    this.#progress('recovery.progress.flash_init');
    return this.#monitorCommand('flash_init', LOADER, { timeout: this.#t.flashInitMs });
  }

  /**
   * flash:config.text → flash:config.text.recovery, checked with dir flash:
   * before and after. Nothing is deleted or overwritten: a parked file left by
   * an earlier recovery is taken as already parked when config.text is gone,
   * and stops the step when both exist. → { ok, parked, earlier? }
   */
  async parkConfig() {
    const no = await this.#atMonitor('bootLoader');
    if (no) return no;
    const before = await this.#monitorCommand('dir flash:', LOADER);
    if (!before.ok) return before;
    if (!/Directory of flash:/i.test(before.output)) return fail('monitor_refused', { command: 'dir flash:', detail: lastMeaningful(before.output) }, { lastOutput: tailOf(before.output) });
    const has = (out, name) => new RegExp(`\\s${escapeRe(name)}\\s*$`, 'm').test(out);
    const config = has(before.output, 'config.text');
    const parked = has(before.output, PARKED_NAME);
    if (config && parked) return fail('parked_exists', { name: PARKED_NAME }, { lastOutput: tailOf(before.output) });
    if (!config) {
      this.#progress(parked ? 'recovery.progress.parked_earlier' : 'recovery.progress.no_config_text');
      return { ok: true, parked, earlier: parked };
    }
    this.#progress('recovery.progress.parking');
    const ren = await this.#monitorCommand(`rename flash:config.text flash:${PARKED_NAME}`, LOADER);
    if (!ren.ok) return ren;
    const after = await this.#monitorCommand('dir flash:', LOADER);
    if (!after.ok) return after;
    if (has(after.output, 'config.text') || !has(after.output, PARKED_NAME)) return fail('rename_failed', { detail: lastMeaningful(ren.output) || 'flash:config.text is still there' }, { lastOutput: tailOf(after.output) });
    return { ok: true, parked: true, earlier: false };
  }

  /** SWITCH_IGNORE_STARTUP_CFG=1 at a 9300L's boot loader */
  async ignoreStartup() {
    const no = await this.#atMonitor('bootLoader');
    if (no) return no;
    const r = await this.#monitorCommand('SWITCH_IGNORE_STARTUP_CFG=1', LOADER);
    if (!r.ok) return r;
    this.#progress('recovery.progress.ignore_set');
    return { ok: true };
  }

  // ── boot without the startup-config ──────────────────────────────────────

  /**
   * reset (ROMMON) or boot (switch:), or nothing at an initial dialog that is
   * already on screen; the boot is followed to a user EXEC prompt. The
   * initial dialog must have been asked and the prompt be the factory one:
   * otherwise the startup-config was not bypassed. → { ok, host, seconds }
   */
  async boot() {
    const cli = this.#cli;
    const expected = this.kind === 'router' ? ['rommon', 'dialog', 'autoinstall'] : ['bootLoader'];
    const s = await this.#screenNow(expected);
    if (!s.ok) return s;
    if (s.state === 'rommon') { cli.reset(); await cli.answer('reset'); }
    if (s.state === 'bootLoader') { cli.reset(); await cli.answer('boot'); }
    this.#progress('recovery.progress.booting');
    const r = await this.#ios.followBoot({ keepScreen: true });
    if (!r.ok) {
      if (r.reason === 'ios.unknown_question' && /^(Password|Username):/i.test(r.params?.question ?? '')) return fail('still_locked', {}, { lastOutput: r.lastOutput });
      return { ...r, stage: undefined };
    }
    if (!r.answered.includes('dialog') || !/^(Router|Switch)$/.test(r.host)) return fail('not_bypassed', { host: r.host }, { lastOutput: tailOf(clean(cli.buffer)) });
    return { ok: true, host: r.host, seconds: r.seconds, warnings: r.warnings };
  }

  // ── back to normal for the next boot ──────────────────────────────────────

  /** enable, config-register 0x2102, checked with show version → { ok, register, next } */
  async restoreRegister() {
    const en = await this.#enable();
    if (!en.ok) return en;
    this.#progress('recovery.progress.restoring_register');
    const c = await this.#configure(['config-register 0x2102']);
    if (!c.ok) return fail('register_not_restored', { register: c.detail }, { lastOutput: c.lastOutput });
    const v = await this.#ios.identify();
    if (!v.ok) return v;
    const effective = v.nextConfigRegister || v.configRegister;
    if (!effective || effective.toLowerCase() !== '0x2102') return fail('register_not_restored', { register: effective ?? '?' });
    return { ok: true, register: v.configRegister, next: effective, host: en.host };
  }

  /** enable, then flash:config.text.recovery back to flash:config.text (when it was parked) */
  async restoreConfig({ parked = true } = {}) {
    const cli = this.#cli;
    const t = this.#t;
    const en = await this.#enable();
    if (!en.ok) return en;
    if (!parked) return { ok: true, restored: false, host: en.host };
    this.#progress('recovery.progress.restoring_config');
    cli.reset();
    await cli.answer(`rename flash:${PARKED_NAME} flash:config.text`);
    const q = await cli.expect({
      dest: /Destination filename \[[^\]\n]*\]\? ?$/,
      prompt: (b) => this.#atPrompt(b, en.host),
    }, { timeout: t.promptMs, settle: t.settleMs });
    if (q.name === 'dest') {
      if (!/\[config\.text\]\? ?$/.test(screenTail(cli.buffer))) { cli.send('\x03'); return fail('config_not_restored', { detail: lastLine(cli.buffer) }); }
      cli.reset();
      await cli.answer('');
      await cli.wait((b) => this.#atPrompt(b, en.host), { timeout: t.promptMs, settle: t.settleMs, optional: true });
    } else if (q.name !== 'prompt') {
      return fail('config_not_restored', { detail: lastLine(cli.buffer) }, { lastOutput: tailOf(clean(cli.buffer)) });
    }
    const error = cli.buffer.match(/%Error[^\n]*/);
    if (error) return fail('config_not_restored', { detail: error[0] });
    const dir = await cli.command('dir flash:', { until: (b) => this.#atPrompt(b, en.host), timeout: t.commandMs, idle: t.promptMs, settle: t.settleMs });
    const has = (name) => new RegExp(`\\s${escapeRe(name)}\\s*$`, 'm').test(dir.output);
    if (!dir.complete || !has('config.text') || has(PARKED_NAME)) return fail('config_not_restored', { detail: 'dir flash: does not list config.text' }, { lastOutput: tailOf(dir.output) });
    return { ok: true, restored: true, host: en.host };
  }

  /** enable, no system ignore startupconfig switch all (9300L) */
  async restoreStartupUse() {
    const en = await this.#enable();
    if (!en.ok) return en;
    this.#progress('recovery.progress.restoring_startup');
    const c = await this.#configure(['no system ignore startupconfig switch all']);
    if (!c.ok) return fail('ignore_not_cleared', { detail: c.detail }, { lastOutput: c.lastOutput });
    return { ok: true, host: en.host };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** An Enter at ROMMON / switch: prints the prompt again: make sure it is there */
  async #atMonitor(kind) {
    const s = await this.#screenNow([kind]);
    return s.ok ? null : s;
  }

  /**
   * An Enter, then what the console shows; one of `expected` (classifyScreen
   * states), or a failure. An Enter is harmless at each of them: a new prompt,
   * or "% Please answer 'yes' or 'no'." and the question again at the dialog
   */
  async #screenNow(expected) {
    const cli = this.#cli;
    const t = this.#t;
    cli.reset();
    cli.send('\r');
    await cli.wait((b) => expected.includes(screenOf(b).state), { timeout: t.monitorMs, settle: t.settleMs, optional: true });
    const s = screenOf(cli.buffer);
    if (!expected.includes(s.state)) return fail('unexpected_screen', { line: s.line || lastLine(cli.buffer), expected: expected.join(' / ') }, { lastOutput: tailOf(clean(cli.buffer)) });
    return { ok: true, state: s.state };
  }

  /** A ROMMON / boot loader command, until its prompt comes back → { ok, output } */
  async #monitorCommand(command, prompt, { timeout = this.#t.monitorMs } = {}) {
    const cli = this.#cli;
    cli.reset();
    await cli.answer(command);
    const done = await cli.wait((b) => prompt.test(screenTail(clean(b))) && clean(b).includes('\n'), { timeout, settle: this.#t.settleMs, optional: true });
    const output = clean(cli.buffer);
    if (!done) return fail('monitor_no_answer', { command }, { lastOutput: tailOf(output) });
    const refused = output.match(/(?:^|\n)((?:monitor: command "[^"]*" not found|unknown cmd:|Error|Unable to|[^\n]*not initiali[sz]ed|[^\n]*invalid)[^\n]*)/i);
    if (refused) return fail('monitor_refused', { command, detail: refused[1].trim().slice(0, 160) }, { lastOutput: tailOf(output) });
    return { ok: true, output };
  }

  /** From the user prompt to privileged EXEC; a password asked means the bypass did not work */
  async #enable(returns = 0) {
    const cli = this.#cli;
    const t = this.#t;
    cli.reset();
    cli.send('\r');
    const p = await cli.expect({
      user: (b) => screenOf(b).state === 'user',
      privileged: (b) => screenOf(b).state === 'privileged',
      config: (b) => screenOf(b).state === 'config',
      password: (b) => screenOf(b).state === 'password',
      pressReturn: (b) => screenOf(b).state === 'pressReturn',
    }, { timeout: t.pressReturnMs, settle: t.settleMs });
    if (p.name === 'password') return fail('still_locked', {}, { lastOutput: tailOf(clean(cli.buffer)) });
    if (p.name === 'pressReturn' && returns < 3) return this.#enable(returns + 1);
    if (!p.name || p.name === 'pressReturn') return fail('unexpected_screen', { line: lastLine(cli.buffer), expected: 'Router> / Switch>' }, { lastOutput: tailOf(clean(cli.buffer)) });
    let host = screenOf(cli.buffer).host;
    if (p.name === 'config') {
      cli.reset();
      await cli.answer('end');
      await cli.wait((b) => screenOf(b).state === 'privileged', { timeout: t.promptMs, settle: t.settleMs, optional: true });
      host = screenOf(cli.buffer).host;
    }
    if (p.name === 'user') {
      cli.reset();
      await cli.answer('enable');
      const e = await cli.expect({
        ok: (b) => screenOf(b).state === 'privileged',
        password: (b) => screenOf(b).state === 'password',
      }, { timeout: t.promptMs, settle: t.settleMs });
      if (e.name === 'password') {
        // Leave the password prompt without guessing: Ctrl+C, then an Enter
        cli.send('\x03');
        cli.send('\r');
        return fail('enable_refused', {}, { lastOutput: tailOf(clean(cli.buffer)) });
      }
      if (e.name !== 'ok') return fail('unexpected_screen', { line: lastLine(cli.buffer), expected: `${host}#` }, { lastOutput: tailOf(clean(cli.buffer)) });
    }
    return { ok: true, host };
  }

  /** Lines in configure terminal → { ok, detail?, lastOutput? } */
  async #configure(lines) {
    const cli = this.#cli;
    const t = this.#t;
    const inConfig = (b) => /\([\w.-]{1,40}\)# ?$/.test(screenTail(b));
    cli.reset();
    await cli.answer('configure terminal');
    if (!(await cli.wait(inConfig, { timeout: t.promptMs, settle: t.settleMs, optional: true }))) return { ok: false, detail: lastLine(cli.buffer), lastOutput: tailOf(cli.buffer) };
    let refused = null;
    for (const l of lines) {
      cli.reset();
      await cli.answer(l);
      await cli.wait(inConfig, { timeout: t.promptMs, settle: t.settleMs, optional: true });
      const err = cli.buffer.match(/(?:^|\n)(% [^\n]+|%Error[^\n]*)/);
      if (err && !refused) refused = { detail: err[1].trim(), lastOutput: tailOf(cli.buffer) };
    }
    cli.reset();
    await cli.answer('end');
    await cli.wait((b) => screenOf(b).state === 'privileged', { timeout: t.promptMs, settle: t.settleMs, optional: true });
    return refused ? { ok: false, ...refused } : { ok: true };
  }

  #atPrompt(b, host) {
    return new RegExp(`(?:^|\\n)${escapeRe(host)}# ?$`).test(screenTail(b));
  }
}

/** The last line that says something (an error after a command, for the report) */
function lastMeaningful(text) {
  return String(text).split('\n').map((l) => l.trim()).filter((l) => l && !LOADER.test(`\n${l}`) && !ROMMON.test(`\n${l}`)).at(-1)?.slice(0, 160) ?? '';
}
