/**
 * Common chrome for every tile of the workspace: header (LED, title, meta,
 * status, actions), focus handling, the end-of-session banner and the state
 * machine connecting → connected → closed | error
 *
 * A *session descriptor* says what a tile shows and where it connects:
 *   { key, kind: 'console' | 'serial' | 'vnc', title, subtitle, address,
 *     ws: { path, query }, target? }
 * Subclasses (TerminalPane, VncPane) implement connect(), fit(), focus(), dispose()
 * (dispose() calls release()). Every text follows the language: fixed ones through
 * data-i18n attributes, the others in retranslate(), which subclasses extend
 */
import { h, icon } from '../core/dom.js';
import { t, tAttr, tNode, setTAttr, onLocaleChange } from '../core/i18n.js';

/** A status or banner text is a string or a function of the current language */
const text = (label) => (typeof label === 'function' ? label() : label);

export class BasePane {
  constructor(session, { onClose, onFocus, onMaximize, onStateChange }, extraActions = []) {
    this.session = session;
    this.callbacks = { onClose, onFocus, onMaximize, onStateChange };
    this.state = 'connecting';

    this.statusLabel = () => t('terminal.pane.starting');
    this.statusText = h('span.pane-status', text(this.statusLabel));
    this.reconnectBtn = h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.pane.reconnect'), hidden: true, onclick: () => this.connect() }, icon('reconnect'));
    this.maxBtn = h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.pane.maximize'), onclick: () => onMaximize(this) }, icon('maximize'));
    this.banner = h('div.pane-banner', { hidden: true });
    this.body = h('div.pane-body');

    this.subtitleEl = h('span');
    this.addressEl = h('code');
    this.el = h(`article.pane.pane-${session.kind}`, { dataset: { state: 'connecting' } },
      h('header.pane-head',
        h('span.pane-led', { 'aria-hidden': 'true' }),
        h('div.pane-title',
          h('strong', session.title),
          h('span.pane-meta', this.subtitleEl, this.addressEl)),
        this.statusText,
        h('div.pane-actions', ...extraActions, this.reconnectBtn, this.maxBtn,
          h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.pane.disconnectAndClose'), onclick: () => onClose(this) }, icon('close')))),
      h('div.pane-term', this.body, this.banner));
    this.el.addEventListener('pointerdown', () => onFocus(this));
    this.#describe();
    this.releaseLocale = onLocaleChange(() => this.retranslate());
  }

  /** The parts of the header made of data and words: subtitle, address, accessible name */
  #describe() {
    const { session } = this;
    this.subtitleEl.textContent = session.subtitle || '';
    this.subtitleEl.hidden = !session.subtitle;
    this.addressEl.textContent = session.address || '';
    this.addressEl.hidden = !session.address;
    this.el.setAttribute('aria-label', t('terminal.pane.label', { subtitle: session.subtitle || t('terminal.pane.console'), title: session.title }));
  }

  /** Language changed: redo every text that was built from parameters */
  retranslate() {
    this.#describe();
    this.statusText.textContent = text(this.statusLabel);
    if (this.end && !this.banner.hidden) this.#fillBanner();
  }

  /** Stop following the language; call from dispose() */
  release() {
    this.releaseLocale?.();
  }

  /** ws(s)://host/path?query for this session */
  wsUrl(extra = {}) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ ...this.session.ws.query, ...extra });
    return `${proto}://${location.host}${this.session.ws.path}?${q}`;
  }

  setState(state, label) {
    this.state = state;
    this.el.dataset.state = state;
    this.statusLabel = label;
    this.statusText.textContent = text(label);
    this.callbacks.onStateChange?.(this);
  }

  /**
   * Session over: show why, offer Reconnect / Close, and any `extra` action
   * ([{ key, run }]: a dictionary key for the label, what the button does)
   */
  showEnd(state, message, { extra = [] } = {}) {
    this.end = { state, message, extra };
    this.setState(state, () => t(state === 'error' ? 'terminal.pane.couldNotConnect' : 'terminal.pane.disconnected'));
    this.#fillBanner();
    this.banner.dataset.kind = state;
    this.banner.hidden = false;
    this.reconnectBtn.hidden = false;
  }

  #fillBanner() {
    const { state, message, extra = [] } = this.end;
    this.banner.replaceChildren(
      h('p', text(message)),
      h('div.banner-actions',
        h('button.btn.primary', { type: 'button', onclick: () => this.connect() }, tNode(state === 'error' ? 'terminal.pane.tryAgain' : 'terminal.pane.reconnect')),
        ...extra.map((a) => h('button.btn', { type: 'button', onclick: () => a.run() }, tNode(a.key))),
        h('button.btn', { type: 'button', onclick: () => this.callbacks.onClose(this) }, tNode('common.actions.close'))));
  }

  hideEnd() {
    this.end = null;
    this.banner.hidden = true;
    this.reconnectBtn.hidden = true;
  }

  setMaximized(on) {
    this.maxBtn.replaceChildren(icon(on ? 'restore' : 'maximize'));
    setTAttr(this.maxBtn, 'title', on ? 'terminal.pane.restore' : 'terminal.pane.maximize');
  }

  setFontSize() {}
}
