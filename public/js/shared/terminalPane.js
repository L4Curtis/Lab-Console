/**
 * Text console tile: xterm.js + one WebSocket speaking the platform's console
 * protocol; Used for lab devices and admin switches (/ws/console) and for
 * Proxmox serial consoles (/ws/proxmox/serial, translated server-side)
 *
 * A lab console is shared (ARCHITECTURE §9): the tile shows who is on the
 * line and who holds the keyboard (PresenceBar), replays the recent output
 * when it joins, and only lets the keys through when the server says this
 * user may type. The buttons of the header come from the pane action
 * registry (paneActions.js); those below are registered here (break, export,
 * inject, send to several consoles, history)
 *
 * A multi-line paste is not typed: it is sent as one `paste` request, and the
 * server types it line by line, like an injection, through the room (so a
 * spectator's paste is refused there too)
 */
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { icon, h, toast, loadCss } from '../core/dom.js';
import { request } from '../core/api.js';
import { t, tAttr, tNode, setTAttr } from '../core/i18n.js';
import { BasePane } from './pane.js';
import { TaskBar, downloadText } from './taskBar.js';
import { openScriptDialog } from './scriptDialog.js';
import { serverText, errorText } from './serverText.js';
import { PresenceBar } from './presenceBar.js';
import { registerPaneAction, paneActionsFor, onPaneActionsChange } from './paneActions.js';

// High-contrast palette tuned for long CLI sessions; every ANSI colour,
// including "bright black" (used for dim text), stays readable on the background
export const THEME = {
  background: '#0F1821',
  foreground: '#E3E9EF',
  cursor: '#7CC3F0',
  cursorAccent: '#0F1821',
  selectionBackground: 'rgba(124, 195, 240, 0.32)',
  black: '#2B3642', red: '#F07B72', green: '#7BD88F', yellow: '#F2C462',
  blue: '#73B3EC', magenta: '#D59CF0', cyan: '#6FD3DA', white: '#D6DEE6',
  brightBlack: '#8796A5', brightRed: '#FF9C94', brightGreen: '#9BE8AB', brightYellow: '#FFD884',
  brightBlue: '#97C9F5', brightMagenta: '#E3B8F5', brightCyan: '#94E4EA', brightWhite: '#FFFFFF',
};

// What the status line says for each phase the server reports (terminal.phase.<phase>)
const PHASES = new Set(['ssh', 'telnet', 'proxmox', 'connected', 'login', 'silent']);
const LIVE = new Set(['connected', 'login', 'silent']);
// What the server accepts for a paste (src/lib/automationProtocol.js)
const MAX_PASTE_BYTES = 256 * 1024;
// The console server refused the line: someone outside the application holds it (a code, not a dictionary key)
const LINE_REFUSED = `consoles.${'line_refused'}`;

// ── The tile's own buttons, through the registry other lots use too ─────────
registerPaneAction({
  id: 'break', icon: 'break', title: 'terminal.actions.break', order: 10,
  when: (s) => s.kind === 'console',
  enabled: (pane) => pane.mayType,
  run: (pane) => pane.sendBreak(),
});
registerPaneAction({
  id: 'export', icon: 'download', title: 'terminal.actions.export', order: 20,
  when: (s) => s.kind === 'console',
  enabled: (pane) => pane.canAutomate,
  run: (pane) => pane.exportConfig(),
});
registerPaneAction({
  id: 'inject', icon: 'script', title: 'terminal.actions.inject', order: 30,
  when: (s) => s.kind === 'console' || s.kind === 'serial',
  enabled: (pane) => pane.canAutomate,
  run: (pane) => pane.openInject(),
});

registerPaneAction({
  id: 'broadcast', icon: 'broadcast', title: 'terminal.actions.broadcast', order: 40,
  when: (s) => s.kind === 'console',
  enabled: (pane) => pane.isPilot && !pane.task.running,
  run: async (pane) => (await import('./broadcastDialog.js')).openBroadcastDialog({ from: pane }),
});
registerPaneAction({
  id: 'history', icon: 'history', title: 'terminal.actions.history', order: 50,
  when: (s) => s.kind === 'console' && Boolean(s.device),
  run: async (pane) => (await import('./historyDialog.js')).openHistoryDialog({ pane }),
});

const enabledFor = (action, pane) => {
  try { return action.enabled(pane) !== false; } catch { return false; }
};

export class TerminalPane extends BasePane {
  #actionsEl;
  #releaseActions;
  #automationListeners = new Set();

  constructor(session, opts) {
    const actionsEl = h('span.pane-custom-actions');
    const journalBadge = session.kind === 'console'
      ? h('span.pane-journal', { ...tAttr('title', 'terminal.journal.badgeHint') }, tNode('terminal.journal.badge'))
      : null;
    super(session, opts, [journalBadge, actionsEl]);
    loadCss('consoles');
    this.#actionsEl = actionsEl;
    this.shared = session.kind === 'console';
    this.presenceBar = this.shared ? new PresenceBar({ send: (m) => this.#send(m), device: session.title }) : null;
    this.task = new TaskBar({ onStop: () => this.#send({ type: 'automation-cancel' }) });
    this.el.querySelector('.pane-head').after(...[this.presenceBar?.el, this.task.el].filter(Boolean));
    this.#releaseActions = onPaneActionsChange(() => this.#renderActions());
    this.#renderActions();

    this.term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: opts.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      theme: THEME,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.onData((data) => { if (this.mayType) this.#send({ type: 'input', data }); else this.#hintWatching(); });
    this.term.textarea?.addEventListener('focus', () => opts.onFocus(this));
    // Ctrl+Shift+C copies the selection (Ctrl+C must stay "interrupt" for the device)
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
        navigator.clipboard?.writeText(this.term.getSelection());
        return false;
      }
      return true;
    });
  }

  /** May this user type now? A shared console: when the server says so; a VM's serial console: always */
  get mayType() {
    if (!this.shared) return true;
    return this.state === 'connected' && Boolean(this.presenceBar.presence?.mayType);
  }

  /** Does this user hold the keyboard of this console now (not just type on a shared one)? */
  get isPilot() {
    const p = this.presenceBar?.presence;
    return this.state === 'connected' && Boolean(p) && p.pilot === p.you && Boolean(p.mayType);
  }

  /** May this user start an export or a script? Not a spectator who may not pilot, not during a task */
  get canAutomate() {
    if (this.state !== 'connected' || this.task.running) return false;
    if (!this.shared) return true;
    const p = this.presenceBar.presence;
    return Boolean(p?.canPilot) && !p?.task;
  }

  /** Called once the element is in the DOM (xterm needs real dimensions) */
  attach() {
    this.term.open(this.body);
    // Before xterm's own listener (capture phase): a paste of several lines is ours to pace
    if (this.shared) this.term.element.addEventListener('paste', (e) => this.#onPaste(e), true);
    this.fit();
    new ResizeObserver(() => this.fit()).observe(this.body);
    this.connect();
  }

  connect() {
    this.ws?.close();
    this.setState('connecting', () => t('terminal.pane.starting'));
    this.hideEnd();
    if (this.everConnected) this.term.write('\r\n');
    this.everConnected = true;

    const ws = (this.ws = new WebSocket(this.wsUrl({ cols: this.term.cols, rows: this.term.rows })));
    ws.binaryType = 'arraybuffer';
    let ended = false;

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this.term.write(new Uint8Array(e.data));
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        this.#status(msg);
      } else if (msg.type === 'replay') {
        // Joining a line already open: its recent output follows. A reconnection starts from a clean screen
        if (this.replayed) this.term.reset();
        this.replayed = true;
      } else if (msg.type === 'presence') {
        this.presenceBar?.update(msg);
        this.el.dataset.role = msg.mayType ? 'pilot' : 'spectator';
        this.term.options.cursorBlink = Boolean(msg.mayType);
        this.#renderActions();
      } else if (msg.type === 'control') {
        this.presenceBar?.control(msg);
      } else if (msg.type === 'control-refused') {
        this.presenceBar?.refused(msg);
      } else if (msg.type === 'automation') {
        this.task.update(msg);
        this.#renderActions();
        for (const fn of this.#automationListeners) fn(msg);
      } else if (msg.type === 'export-result') {
        downloadText(msg.filename, msg.content);
      } else if (msg.type === 'error' || msg.type === 'exit') {
        ended = true;
        this.#end(msg.type === 'error' ? 'error' : 'closed', msg);
      }
    };
    ws.onclose = (e) => {
      if (ended || ws !== this.ws) return;
      this.#end('closed', null, () => (e.code === 1006 ? t('terminal.pane.connectionLost') : e.reason || t('terminal.pane.sessionClosed')));
    };
  }

  #status(msg) {
    const live = LIVE.has(msg.phase);
    const label = () => (PHASES.has(msg.phase) ? t(`terminal.phase.${msg.phase}`) : serverText(msg));
    this.setState(live ? 'connected' : 'connecting', label);
    this.el.dataset.silent = msg.phase === 'silent' ? 'true' : '';
    // Pre-connection steps and a device that does not answer go into the scrollback
    if (!live || msg.phase === 'silent') this.term.write(`\x1b[${msg.phase === 'silent' ? '93' : '90'}m› ${serverText(msg)}\x1b[0m\r\n`);
    this.#renderActions();
  }

  /** Config export: the server pages through `show running-config` and sends the file back */
  exportConfig() {
    if (!this.#canStart()) return;
    this.task.update({ state: 'running', key: 'terminal.task.startingExport' });
    this.#renderActions();
    this.#send({ type: 'export-config' });
  }

  /** Config import : pick commands, then the server sends them line by line */
  openInject() {
    if (!this.#canStart()) return;
    openScriptDialog({
      session: this.session,
      onSend: (script, options) => {
        this.task.update({ state: 'running', key: 'terminal.task.startingScript' });
        this.#renderActions();
        this.#send({ type: 'inject', script, options });
        this.focus();
      },
    });
  }

  sendBreak() {
    if (this.mayType) this.#send({ type: 'break' });
  }

  /**
   * A paste of several lines: not typed key by key (a console takes a few
   * hundred characters a second, and drops the rest) but handed to the server,
   * which sends the lines one at a time. One line, or a console that is only
   * watched, is left to the terminal, which does what a keystroke does (the
   * room cuts a long line into small chunks, see room.write)
   */
  #onPaste(event) {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length < 2) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.mayType) {
      // Nothing is lost silently: a console that is only watched, or busy with a task, says why the paste was not sent
      if (this.state === 'connected') toast(t(this.task.running || this.presenceBar?.presence?.task ? 'terminal.paste.taskRunning' : 'terminal.presence.typingHint'), 'info', 4000);
      return;
    }
    if (new Blob([text]).size > MAX_PASTE_BYTES) { toast(t('terminal.paste.tooLarge'), 'warn', 6000); return; }
    // The pacing is the server's (it waits for each prompt): the injection dialog's choices do not apply to a paste
    if (!this.#send({ type: 'paste', script: text })) return;
    this.task.update({ state: 'running', key: 'terminal.task.startingPaste' });
    this.#renderActions();
  }

  /** The same lines for several consoles (broadcastDialog.js): this console's share of it. → false when the line is not open */
  sendBroadcast({ batch, script, options }) {
    return this.#send({ type: 'broadcast', batch, script, options });
  }

  /** Stop the task running on this console (the server decides who may) */
  stopTask() {
    this.#send({ type: 'automation-cancel' });
  }

  /** Follow the server's automation messages of this console; → the function that stops */
  onAutomation(fn) {
    this.#automationListeners.add(fn);
    return () => this.#automationListeners.delete(fn);
  }

  #canStart() {
    if (this.state !== 'connected') {
      this.task.update({ state: 'error', key: 'terminal.task.connectFirst' });
      return false;
    }
    return this.canAutomate;
  }

  /** A key typed by a spectator: say once in a while why nothing happens */
  #hintWatching() {
    if (this.state !== 'connected' || Date.now() - (this.hintedAt ?? 0) < 8000) return;
    this.hintedAt = Date.now();
    toast(t('terminal.presence.typingHint'), 'info', 3500);
  }

  /** The header's buttons: every registered action for this kind of tile, enabled or not for this user now */
  #renderActions() {
    const list = paneActionsFor(this.session);
    const existing = new Map([...this.#actionsEl.children].map((b) => [b.dataset.action, b]));
    const buttons = list.map((a) => {
      let b = existing.get(a.id);
      if (!b) {
        b = h('button.icon-btn', { type: 'button', dataset: { action: a.id }, onclick: () => a.run(this) }, icon(a.icon));
        if (typeof a.title === 'function') b.title = a.title();
        else setTAttr(b, 'title', a.title);
      }
      b.disabled = !enabledFor(a, this);
      return b;
    });
    this.#actionsEl.replaceChildren(...buttons);
    this.el.dataset.task = this.task.running ? 'running' : '';
  }

  /** The line ended (or was refused): why, and what can be done */
  #end(state, msg, fallback) {
    if (this.task.running) this.task.hide();
    const message = msg ? () => serverText(msg) : fallback;
    this.term.write(`\r\n\x1b[${state === 'error' ? '91' : '90'}m› ${message()}\x1b[0m\r\n`);
    // A line held by someone outside the application: offer to be told when it frees up
    const extra = msg?.code === LINE_REFUSED && this.session.device
      ? [{ key: 'terminal.pane.notifyFree', run: () => this.#notifyWhenFree() }]
      : [];
    this.showEnd(state, message, { extra });
    this.#renderActions();
  }

  async #notifyWhenFree() {
    try {
      await request('POST', '/api/consoles/notify', { device: this.session.device });
      toast(t('terminal.pane.notifyArmed', { name: this.session.title }));
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  #send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  fit() {
    if (!this.body.isConnected || !this.body.clientWidth) return;
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      try {
        const { cols, rows } = this.term;
        this.fitAddon.fit();
        if (cols !== this.term.cols || rows !== this.term.rows) this.#send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
      } catch { /* hidden pane */ }
    });
  }

  setFontSize(px) {
    this.term.options.fontSize = px;
    this.fit();
  }

  focus() { this.term.focus(); }

  retranslate() {
    super.retranslate();
    this.task.retranslate();
    this.presenceBar?.retranslate();
    for (const b of this.#actionsEl.children) {
      const a = paneActionsFor(this.session).find((x) => x.id === b.dataset.action);
      if (typeof a?.title === 'function') b.title = a.title();
    }
  }

  dispose() {
    this.release();
    this.#releaseActions?.();
    this.presenceBar?.dispose();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.term.dispose();
    this.el.remove();
  }
}
