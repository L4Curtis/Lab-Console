/**
 * The keys a phone keyboard does not have, and a line to type in
 * (UX.md §9.2, §9.3), under a console tile
 *
 *   const keys = new TerminalKeys(pane);   // pane: a TerminalPane
 *   pane.el.append(keys.el);
 *   keys.update();                         // after a presence frame, a task, a state change
 *
 * Toolbar: Esc, Tab, Ctrl (sticky: the next key is sent as its control code;
 * pressed again it stays locked), the arrows (in application cursor mode
 * when the terminal is), ?, ^C, ^Z, Ctrl+Shift+6 (interrupts a ping on IOS),
 * Space (the next page of --More--), Paste, and the switch between the two
 * ways of typing:
 *
 *   line mode     a field that holds the line until Enter: the phone's
 *                 autocorrect, predictions and compositions stay out of the
 *                 console. Tab and ? send the line so far with the key (the
 *                 device completes it and prints it again), Ctrl+C clears it.
 *                 While it holds text, the keys that would make the device's
 *                 line and the field disagree (↑ ↓ Esc ^Z) wait
 *   direct mode   no field: the terminal takes the keys, as on a PC
 *
 * Who may not type sees "Ask for the keyboard" instead; a task holding the
 * keyboard is said in place of the field. Every key goes through the same
 * path as the terminal's own input (pane.sendInput), which the page and then
 * the server refuse to a spectator
 */
import { h, icon, toast, prefs } from '../core/dom.js';
import { t, tAttr, tNode, onLocaleChange } from '../core/i18n.js';
import { isCoarse } from '../core/viewport.js';

const PASSWORD_PROMPT = /password:\s*$/i;

/** Arrows: normal and application cursor mode (the terminal decides which one the device asked for) */
const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };
const arrow = (dir, app) => `\x1b${app ? 'O' : '['}${ARROWS[dir]}`;

/** The toolbar, in order: id, label (a key, or the text itself for symbols), what it sends */
const KEYS = [
  { id: 'esc', label: 'terminal.keys.esc', send: '\x1b', holds: true },
  { id: 'tab', label: 'terminal.keys.tab', line: '\t' },
  { id: 'ctrl', label: 'terminal.keys.ctrl', modifier: true },
  { id: 'up', icon: 'arrowUp', arrow: 'up', holds: true },
  { id: 'down', icon: 'arrowDown', arrow: 'down', holds: true },
  { id: 'left', icon: 'arrowLeft', arrow: 'left', caret: -1 },
  { id: 'right', icon: 'arrowRight', arrow: 'right', caret: 1 },
  { id: 'help', text: '?', line: '?' },
  { id: 'ctrlC', text: '^C', send: '\x03', clears: true },
  { id: 'ctrlZ', text: '^Z', send: '\x1a', holds: true },
  { id: 'break', text: '^⇧6', send: '\x1e' },
  { id: 'space', text: '␣', send: ' ', inField: ' ' },
  { id: 'paste', icon: 'clipboard', paste: true },
  { id: 'mode', icon: 'keyboard', mode: true },
];

/** The preferred way of typing: the field on a touch screen, the terminal itself with a keyboard */
export const inputMode = () => prefs.get('terminalInput', isCoarse() ? 'line' : 'direct');
const modeListeners = new Set();
export function setInputMode(mode) {
  prefs.set('terminalInput', mode);
  for (const fn of modeListeners) fn(mode);
}

/** A letter's control code: Ctrl+C → \x03 */
const control = (ch) => {
  const c = ch.toUpperCase();
  if (c >= '@' && c <= '_') return String.fromCharCode(c.charCodeAt(0) - 64);
  if (c === ' ') return '\x00';
  if (c === '?') return '\x7f';
  return ch;
};

export class TerminalKeys {
  #ctrl = 'off'; // 'off' | 'once' | 'locked'
  #buttons = new Map();
  #stop = [];

  constructor(pane) {
    this.pane = pane;
    this.toolbar = h('div.term-toolbar', { role: 'toolbar', ...tAttr('aria-label', 'terminal.keys.label') },
      KEYS.map((k) => this.#key(k)));
    this.field = h('input.term-line', {
      type: 'text', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
      enterkeyhint: 'send', ...tAttr('aria-label', 'terminal.keys.field'), ...tAttr('placeholder', 'terminal.keys.placeholder'),
    });
    this.sendBtn = h('button.icon-btn.term-send', { type: 'submit', ...tAttr('title', 'terminal.keys.send'), ...tAttr('aria-label', 'terminal.keys.send') }, icon('enter'));
    this.form = h('form.term-input', { onsubmit: (e) => { e.preventDefault(); this.#sendLine('\r'); } }, this.field, this.sendBtn);
    this.ask = h('button.btn.lg.block.primary.term-ask', { type: 'button', dataset: { action: 'request-keyboard' }, onclick: () => pane.presenceBar?.request() }, icon('keyboard'), tNode('terminal.presence.request'));
    this.note = h('p.term-note', { hidden: true, role: 'status' });
    this.el = h('div.term-keys', { dataset: { mode: inputMode() } }, this.toolbar, this.form, this.ask, this.note);

    this.field.addEventListener('keydown', (e) => this.#onFieldKey(e));
    this.field.addEventListener('beforeinput', (e) => this.#onBeforeInput(e));
    this.field.addEventListener('input', () => this.#refreshKeys());
    this.field.addEventListener('focus', () => pane.callbacks.onFocus?.(pane));
    const onMode = (mode) => { this.el.dataset.mode = mode; this.#applyMode(); this.update(); };
    modeListeners.add(onMode);
    this.#stop.push(() => modeListeners.delete(onMode), onLocaleChange(() => this.update()));
    // A password prompt on the last line turns the field into a password field (until the next line is sent)
    if (pane.term.onWriteParsed) {
      const sub = pane.term.onWriteParsed(() => {
        if (this.passwordFrame) return;
        this.passwordFrame = requestAnimationFrame(() => { this.passwordFrame = 0; this.#watchPassword(); });
      });
      this.#stop.push(() => sub.dispose());
    }
    this.#applyMode();
    this.update();
  }

  get mode() { return this.el.dataset.mode; }

  dispose() {
    for (const stop of this.#stop.splice(0)) stop();
  }

  /** Follow who may type, a task, the line's state */
  update() {
    const { pane } = this;
    const p = pane.presenceBar?.presence;
    const connected = pane.state === 'connected';
    const task = p?.task?.state === 'running' || pane.task.running;
    const may = pane.mayType;
    let state;
    if (!connected) state = 'offline';
    else if (task) state = 'task';
    else if (may) state = 'typing';
    else state = 'watching';
    this.el.dataset.state = state;
    this.toolbar.hidden = state !== 'typing';
    this.form.hidden = state !== 'typing' || this.mode !== 'line';
    const asked = pane.presenceBar?.asked;
    this.ask.hidden = state !== 'watching' || !p?.canPilot;
    this.ask.disabled = Boolean(asked);
    this.ask.replaceChildren(icon('keyboard'), t(asked ? 'terminal.presence.waiting' : 'terminal.presence.request'));
    this.note.hidden = !(state === 'task' || (state === 'watching' && !p?.canPilot));
    this.note.textContent = state === 'task' ? pane.presenceBar?.sentence() ?? '' : t('terminal.presence.watchOnly');
    for (const [id, b] of this.#buttons) {
      const k = KEYS.find((x) => x.id === id);
      if (k.mode) {
        b.setAttribute('aria-label', t(this.mode === 'line' ? 'terminal.keys.toDirect' : 'terminal.keys.toLine'));
        b.title = b.getAttribute('aria-label');
        b.setAttribute('aria-pressed', String(this.mode === 'direct'));
      }
    }
    this.#refreshKeys();
  }

  // ── The toolbar ───────────────────────────────────────────────────────────

  #key(k) {
    const content = k.icon ? icon(k.icon) : k.text ? h('span', k.text) : tNode(k.label);
    const b = h('button.term-key', { type: 'button', dataset: { key: k.id }, ...tAttr('aria-label', `terminal.keys.names.${k.id}`), ...tAttr('title', `terminal.keys.hints.${k.id}`) }, content);
    if (k.modifier) b.setAttribute('aria-pressed', 'false');
    // The field keeps the focus (and the phone its keyboard) while a key is pressed
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.#press(k));
    this.#buttons.set(k.id, b);
    return b;
  }

  /** While the field holds text, the keys that would make it and the device's line disagree wait */
  #refreshKeys() {
    const holding = this.mode === 'line' && this.field.value.length > 0;
    for (const [id, b] of this.#buttons) {
      const k = KEYS.find((x) => x.id === id);
      b.disabled = Boolean(k.holds && holding);
    }
    const ctrl = this.#buttons.get('ctrl');
    ctrl.setAttribute('aria-pressed', String(this.#ctrl !== 'off'));
    ctrl.dataset.locked = String(this.#ctrl === 'locked');
  }

  #press(k) {
    const { pane } = this;
    if (k.modifier) {
      this.#ctrl = { off: 'once', once: 'locked', locked: 'off' }[this.#ctrl];
      this.#refreshKeys();
      return;
    }
    if (k.mode) { setInputMode(this.mode === 'line' ? 'direct' : 'line'); return; }
    if (k.paste) { this.#paste(); return; }
    const line = this.mode === 'line';
    const ctrl = this.#ctrl !== 'off';
    if (ctrl && this.#ctrl === 'once') this.#ctrl = 'off';
    if (k.arrow) {
      if (line && this.field.value && k.caret) { this.#moveCaret(k.caret); this.#refreshKeys(); return; }
      pane.sendInput(arrow(k.arrow, pane.term.modes?.applicationCursorKeysMode));
    } else if (k.line !== undefined) {
      // Tab and ?: the line so far and the key; the device completes it, or says what may follow
      if (line) this.#sendLine(ctrl ? control(k.line) : k.line);
      else pane.sendInput(ctrl ? control(k.line) : k.line);
    } else if (k.inField !== undefined && line && this.field.value) {
      this.#insert(k.inField);
    } else {
      if (k.clears && line) this.field.value = '';
      pane.sendInput(ctrl && k.send === ' ' ? control(' ') : k.send);
    }
    this.#refreshKeys();
    if (line && this.form.isConnected && !this.form.hidden) this.field.focus({ preventScroll: true });
  }

  /** Direct mode: what the terminal itself typed. After the toolbar's Ctrl, a letter becomes its control code */
  direct(data) {
    if (this.#ctrl !== 'off' && data.length === 1) {
      if (this.#ctrl === 'once') this.#ctrl = 'off';
      this.#refreshKeys();
      this.pane.sendInput(control(data));
      return;
    }
    this.pane.sendInput(data);
  }

  // ── The field ─────────────────────────────────────────────────────────────

  /** Send what the field holds followed by `end` ('\r' for Enter, '\t', '?') and clear it */
  #sendLine(end) {
    const text = this.field.value;
    this.field.value = '';
    if (this.field.type === 'password') this.field.type = 'text';
    this.pane.sendInput(text + end);
    this.#refreshKeys();
  }

  #insert(text) {
    const f = this.field;
    const at = f.selectionStart ?? f.value.length;
    const to = f.selectionEnd ?? at;
    f.value = f.value.slice(0, at) + text + f.value.slice(to);
    f.setSelectionRange(at + text.length, at + text.length);
  }

  #moveCaret(step) {
    const f = this.field;
    const at = Math.max(0, Math.min(f.value.length, (f.selectionStart ?? f.value.length) + step));
    f.setSelectionRange(at, at);
  }

  /** Ctrl from the toolbar, then a letter typed on the phone's keyboard: its control code */
  #onBeforeInput(e) {
    if (e.inputType !== 'insertText' || !e.data) return;
    if (this.#ctrl !== 'off') {
      e.preventDefault();
      if (this.#ctrl === 'once') this.#ctrl = 'off';
      this.#controlKey(e.data[0]);
      return;
    }
    // A ? at the end of the line asks the device what may follow
    if (e.data === '?' && this.field.selectionStart === this.field.value.length) {
      e.preventDefault();
      this.#sendLine('?');
    }
  }

  /** A control code from the field: the line so far goes first (Ctrl+C drops it, as on the device) */
  #controlKey(ch) {
    const code = control(ch);
    if (code === '\x03') this.field.value = '';
    else if (this.field.value) { this.#sendLine(code); return; }
    this.pane.sendInput(code);
    this.#refreshKeys();
  }

  #onFieldKey(e) {
    if (e.isComposing) return;
    const empty = !this.field.value;
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      this.#controlKey(e.key);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      this.#sendLine('\t');
    } else if (empty && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      this.pane.sendInput(arrow(e.key.slice(5).toLowerCase(), this.pane.term.modes?.applicationCursorKeysMode));
    } else if (empty && e.key === 'Escape') {
      e.preventDefault();
      this.pane.sendInput('\x1b');
    }
  }

  async #paste() {
    let text;
    try { text = await navigator.clipboard.readText(); } catch { toast(t('terminal.keys.pasteRefused'), 'warn'); return; }
    if (!text) return;
    // Several lines: the server types them one by one (the terminal's own paste path, with its guard)
    if (text.replace(/\r\n?/g, '\n').replace(/\n$/, '').includes('\n')) { this.pane.pasteText(text); return; }
    if (this.mode === 'line') { this.#insert(text.replace(/\r?\n$/, '')); this.#refreshKeys(); this.field.focus({ preventScroll: true }); }
    else this.pane.sendInput(text);
  }

  // ── Modes ─────────────────────────────────────────────────────────────────

  /** In line mode the terminal does not open the phone's keyboard: the field does */
  #applyMode() {
    const textarea = this.pane.term.textarea;
    if (!textarea) return;
    if (this.mode === 'line' && isCoarse()) textarea.setAttribute('inputmode', 'none');
    else textarea.removeAttribute('inputmode');
  }

  #watchPassword() {
    if (this.mode !== 'line') return;
    const buf = this.pane.term.buffer.active;
    const row = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '';
    const secret = PASSWORD_PROMPT.test(row);
    if (secret && this.field.type !== 'password') this.field.type = 'password';
  }

  /** The terminal's xterm textarea gets the focus: in line mode on a touch screen, the field takes it instead */
  focus() {
    if (this.mode === 'line' && !this.form.hidden) { this.field.focus({ preventScroll: true }); return true; }
    return false;
  }
}

export { control as controlCode };
