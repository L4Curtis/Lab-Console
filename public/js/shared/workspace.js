/**
 * The terminal workspace: ONE instance for the whole app, so a console opened
 * from the lab diagram stays open (and visible) when you switch to the
 * Infrastructure section, and vice versa. Views host it through SplitView
 *
 * Tiles every open session — lab console, admin switch, VM serial (xterm.js)
 * or VM screen (noVNC); Layouts: grid (auto), columns, rows; any tile can be
 * maximized while the others stay connected
 *
 * Events: 'change' (tiles opened/closed/state changed), 'toggle-primary'
 * (the "show/hide side panel" button)
 */
import { h, icon, prefs } from '../core/dom.js';
import { t, tAttr, tNode, onLocaleChange } from '../core/i18n.js';
import { TerminalPane } from './terminalPane.js';
import { VncPane } from './vncPane.js';

const MIN_TILE_WIDTH = 520; // px — keeps ~70 columns of CLI readable

class Workspace extends EventTarget {
  panes = new Map(); // session.key → pane
  #active = null;
  #maximized = null;

  constructor() {
    super();
    this.layout = prefs.get('layout', 'grid');
    this.fontSize = prefs.get('fontSize', 14);

    this.countLabel = h('span.ws-count');
    this.layoutBtns = Object.fromEntries(['grid', 'columns', 'rows'].map((l) => [l,
      h('button.icon-btn', { type: 'button', ...tAttr('title', `terminal.workspace.layout.${l}`), 'aria-pressed': String(l === this.layout), onclick: () => this.setLayout(l) }, icon(l))]));
    this.tiles = h('div.ws-tiles', { dataset: { layout: this.layout } });

    this.el = h('section.workspace.empty', tAttr('aria-label', 'terminal.workspace.label'),
      h('div.ws-toolbar',
        h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.workspace.togglePanel'), onclick: () => this.dispatchEvent(new Event('toggle-primary')) }, icon('sidebar')),
        this.countLabel,
        h('div.ws-group', { role: 'group', ...tAttr('aria-label', 'terminal.workspace.layoutGroup') }, Object.values(this.layoutBtns)),
        h('div.ws-group.ws-text-size', { role: 'group', ...tAttr('aria-label', 'terminal.workspace.textSize') },
          h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.workspace.smaller'), onclick: () => this.setFontSize(this.fontSize - 1) }, icon('textSmaller')),
          h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.workspace.larger'), onclick: () => this.setFontSize(this.fontSize + 1) }, icon('textLarger'))),
        h('button.btn.subtle', { type: 'button', onclick: () => this.closeAll() }, tNode('terminal.workspace.closeAll'))),
      this.tiles);
    new ResizeObserver(() => this.#arrange()).observe(this.tiles);
    addEventListener('pagehide', () => this.closeAll()); // hang up cleanly when the tab goes away
    onLocaleChange(() => this.#arrange()); // the count of open consoles is a sentence
  }

  /** Opens (or focuses) the tile for a session descriptor */
  open(session) {
    const existing = this.panes.get(session.key);
    if (existing) {
      if (this.#maximized && this.#maximized !== existing) this.toggleMaximize(this.#maximized);
      this.#focus(existing);
      existing.el.classList.remove('flash');
      void existing.el.offsetWidth;
      existing.el.classList.add('flash');
      if (existing.state === 'closed' || existing.state === 'error') existing.connect();
      return existing;
    }
    if (this.#maximized) this.toggleMaximize(this.#maximized);
    const Pane = session.kind === 'vnc' ? VncPane : TerminalPane;
    const pane = new Pane(session, {
      fontSize: this.fontSize,
      onClose: (p) => this.close(p.session.key),
      onFocus: (p) => this.#focus(p, false),
      onMaximize: (p) => this.toggleMaximize(p),
      onStateChange: () => this.#changed(),
    });
    this.panes.set(session.key, pane);
    this.tiles.append(pane.el);
    this.#arrange();
    pane.attach();
    this.#focus(pane);
    this.#changed();
    return pane;
  }

  close(key) {
    const pane = this.panes.get(key);
    if (!pane) return;
    if (this.#maximized === pane) { this.#maximized = null; this.tiles.classList.remove('has-max'); }
    pane.dispose();
    this.panes.delete(key);
    if (this.#active === pane) {
      this.#active = null;
      const next = [...this.panes.values()].at(-1);
      if (next) this.#focus(next);
    }
    this.#arrange();
    this.#changed();
  }

  closeAll() {
    for (const key of [...this.panes.keys()]) this.close(key);
  }

  /** "host:port" of every live lab/admin console tile (for busy indicators) */
  liveTargets() {
    return new Set([...this.panes.values()]
      .filter((p) => p.session.target && (p.state === 'connecting' || p.state === 'connected'))
      .map((p) => `${p.session.target.host}:${p.session.target.port}`));
  }

  toggleMaximize(pane) {
    const on = this.#maximized !== pane;
    if (this.#maximized) this.#maximized.setMaximized(false);
    this.#maximized = on ? pane : null;
    pane.setMaximized(on);
    this.tiles.classList.toggle('has-max', on);
    for (const p of this.panes.values()) p.el.classList.toggle('maximized', p === this.#maximized);
    this.#arrange();
    this.#focus(pane);
  }

  setLayout(layout) {
    this.layout = layout;
    prefs.set('layout', layout);
    this.tiles.dataset.layout = layout;
    for (const [l, b] of Object.entries(this.layoutBtns)) b.setAttribute('aria-pressed', String(l === layout));
    this.#arrange();
  }

  setFontSize(px) {
    this.fontSize = Math.max(10, Math.min(24, px));
    prefs.set('fontSize', this.fontSize);
    for (const p of this.panes.values()) p.setFontSize(this.fontSize);
  }

  refit() {
    this.#arrange();
  }

  #changed() {
    this.dispatchEvent(new Event('change'));
  }

  #focus(pane, moveFocus = true) {
    if (this.#active !== pane) {
      this.#active?.el.classList.remove('active');
      this.#active = pane;
      pane.el.classList.add('active');
    }
    if (moveFocus) pane.focus();
  }

  /** Computes the grid for the current layout and tile count */
  #arrange() {
    const n = this.panes.size;
    this.countLabel.textContent = t('terminal.workspace.count', { count: n });
    this.el.classList.toggle('empty', n === 0);
    if (!n) return;

    let cols;
    if (this.#maximized) cols = 1;
    else if (this.layout === 'columns') cols = n;
    else if (this.layout === 'rows') cols = 1;
    else cols = Math.max(1, Math.min(n, Math.floor(this.tiles.clientWidth / MIN_TILE_WIDTH) || 1, Math.ceil(Math.sqrt(n))));
    const rows = this.#maximized ? 1 : Math.ceil(n / cols);
    this.tiles.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.tiles.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

    // The last tile stretches across any empty cells of the final row
    const panes = [...this.panes.values()];
    const spare = cols * rows - n;
    panes.forEach((p, i) => { p.el.style.gridColumn = !this.#maximized && i === n - 1 && spare ? `span ${spare + 1}` : ''; });
    for (const p of panes) p.fit();
  }
}

export const workspace = new Workspace();
