/**
 * The terminal workspace: ONE instance for the whole app, so a console opened
 * from the lab diagram stays open (and visible) when you switch to the
 * Infrastructure section, and vice versa. Views host it through SplitView
 *
 * Tiles every open session — lab console, admin switch, VM serial (xterm.js)
 * or VM screen (noVNC); Layouts: grid (auto), columns, rows; any tile can be
 * maximized while the others stay connected
 *
 * Its bar (40 px, UX.md §8.2): show or hide the side (the diagram), how many
 * consoles are open, the layout, and "Affichage": the text size, the key
 * toolbar, close everything
 *
 * On a phone, one tile at a time takes the whole screen (`solo(key)`, the
 * console screen of UX.md §8.3): a row of chips switches between the open
 * consoles, and the tile's back arrow asks whoever hosts the workspace to
 * leave that screen ('back' event)
 *
 * Events: 'change' (tiles opened/closed/state changed), 'toggle-primary'
 * (show or hide the side), 'back' (the console screen's back arrow),
 * 'solo' (the console on the console screen changed: event.detail = pane)
 */
import { h, icon, prefs, loadCss } from '../core/dom.js';
import { t, tAttr, tNode, onLocaleChange } from '../core/i18n.js';
import { isCoarse, isCompact, onViewportChange } from '../core/viewport.js';
import { openMenu } from './menu.js';
import { TerminalPane } from './terminalPane.js';
import { VncPane } from './vncPane.js';

const MIN_TILE_WIDTH = 520; // px — keeps ~70 columns of CLI readable
const FONT_MIN = 10;
const FONT_MAX = 24;
/** Text size of a terminal: 12 px on a phone (≈ 50 columns at 390 px), 14 px elsewhere, unless chosen */
const defaultFont = () => (isCompact() ? 12 : 14);

class Workspace extends EventTarget {
  panes = new Map(); // session.key → pane
  #active = null;
  #maximized = null;
  #solo = null;

  constructor() {
    super();
    loadCss('terminal');
    this.layout = prefs.get('layout', 'grid');
    this.fontSize = prefs.get('fontSize', null) ?? defaultFont();

    this.countLabel = h('span.ws-count');
    this.layoutBtns = Object.fromEntries(['grid', 'columns', 'rows'].map((l) => [l,
      h('button.seg-btn', { type: 'button', dataset: { layout: l }, ...tAttr('title', `terminal.workspace.layout.${l}`), ...tAttr('aria-label', `terminal.workspace.layout.${l}`), 'aria-pressed': String(l === this.layout), onclick: () => this.setLayout(l) }, icon(l))]));
    this.tiles = h('div.ws-tiles', { dataset: { layout: this.layout } });
    this.switcher = h('nav.ws-switcher', tAttr('aria-label', 'terminal.workspace.switcher'));
    this.displayBtn = h('button.btn.sm.ghost.ws-display', { type: 'button', 'aria-haspopup': 'menu', onclick: () => this.#displayMenu() }, tNode('terminal.workspace.display'), icon('chevronDown'));

    this.el = h('section.workspace.empty', tAttr('aria-label', 'terminal.workspace.label'),
      h('div.ws-toolbar',
        h('button.icon-btn.ws-side', { type: 'button', dataset: { action: 'toggle-side' }, ...tAttr('title', 'terminal.workspace.togglePanel'), ...tAttr('aria-label', 'terminal.workspace.togglePanel'), onclick: () => this.dispatchEvent(new Event('toggle-primary')) }, icon('sidebar')),
        this.countLabel,
        h('div.seg.ws-layout', { role: 'group', ...tAttr('aria-label', 'terminal.workspace.layoutGroup') }, Object.values(this.layoutBtns)),
        this.displayBtn),
      this.switcher,
      this.tiles);
    this.#applyKeys();
    new ResizeObserver(() => this.#arrange()).observe(this.tiles);
    addEventListener('pagehide', () => this.closeAll()); // hang up cleanly when the tab goes away
    onLocaleChange(() => { this.#arrange(); this.#renderSwitcher(); }); // the count of open consoles is a sentence
    // The phone's keyboard opens or closes, the phone turns: the terminal fits what is left, and shows its last line
    onViewportChange(() => {
      this.#applyKeys();
      requestAnimationFrame(() => {
        this.#arrange();
        for (const p of this.panes.values()) p.term?.scrollToBottom?.();
      });
    });
  }

  /** Opens (or focuses) the tile for a session descriptor */
  open(session) {
    const existing = this.panes.get(session.key);
    if (existing) {
      if (this.#maximized && this.#maximized !== existing) this.toggleMaximize(this.#maximized);
      if (this.#solo && this.#solo !== existing) this.solo(existing.session.key);
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
      onFontSize: (px) => this.setFontSize(px),
      onBack: () => this.dispatchEvent(new Event('back')),
    });
    this.panes.set(session.key, pane);
    this.tiles.append(pane.el);
    this.#arrange();
    pane.attach();
    if (this.#solo) this.solo(session.key);
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
    if (this.#solo === pane) {
      // The console screen shows the next console, or there is nothing left to show
      const next = [...this.panes.values()].at(-1);
      if (next) { this.solo(next.session.key); this.dispatchEvent(new CustomEvent('solo', { detail: next })); } else this.dispatchEvent(new Event('back'));
    }
    this.#arrange();
    this.#renderSwitcher();
    this.#changed();
  }

  closeAll() {
    for (const key of [...this.panes.keys()]) this.close(key);
  }

  /** The tile that has the focus (the last one opened or touched) */
  get active() { return this.#active; }

  /** "host:port" of every live lab/admin console tile (for busy indicators) */
  liveTargets() {
    return new Set([...this.panes.values()]
      .filter((p) => p.session.target && (p.state === 'connecting' || p.state === 'connected'))
      .map((p) => `${p.session.target.host}:${p.session.target.port}`));
  }

  /**
   * One tile on the whole screen (the phone's console screen), or back to the tiles (`null`).
   * The other consoles stay connected; the chip row switches between them
   */
  solo(key) {
    const pane = key ? this.panes.get(key) : null;
    this.#solo = pane ?? null;
    this.el.classList.toggle('solo', Boolean(pane));
    for (const p of this.panes.values()) {
      p.solo = p === pane;
      p.el.classList.toggle('solo', p === pane);
    }
    if (pane) this.#focus(pane, false);
    this.#renderSwitcher();
    this.#applyKeys();
    requestAnimationFrame(() => this.#arrange());
    return pane;
  }

  get soloPane() { return this.#solo; }

  /** The console after (step 1) or before (-1) the one on the console screen */
  neighbour(step) {
    const list = [...this.panes.values()];
    if (!this.#solo || list.length < 2) return null;
    return list[(list.indexOf(this.#solo) + step + list.length) % list.length];
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
    this.fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
    prefs.set('fontSize', this.fontSize);
    for (const p of this.panes.values()) p.setFontSize(this.fontSize);
  }

  /**
   * The key toolbar (UX.md §9): shown under the focused tile on a touch screen,
   * or wherever the person turned it on (a touch laptop)
   */
  get keysShown() {
    const choice = prefs.get('terminalKeys', null);
    return choice === null ? isCoarse() : choice;
  }

  setKeysShown(on) {
    prefs.set('terminalKeys', on);
    this.#applyKeys();
    this.#arrange();
  }

  #applyKeys() {
    this.tiles.dataset.keys = this.keysShown ? 'on' : 'off';
  }

  refit() {
    this.#arrange();
  }

  /** Affichage: the text size (with the current one), the key toolbar, close everything */
  async #displayMenu() {
    await openMenu(this.displayBtn, [
      { id: 'smaller', icon: 'textSmaller', label: () => t('terminal.workspace.smallerSize', { size: this.fontSize - 1 }), disabled: this.fontSize <= FONT_MIN, run: () => this.setFontSize(this.fontSize - 1) },
      { id: 'larger', icon: 'textLarger', label: () => t('terminal.workspace.largerSize', { size: this.fontSize + 1 }), disabled: this.fontSize >= FONT_MAX, run: () => this.setFontSize(this.fontSize + 1) },
      { id: 'keys', icon: 'keyboard', label: 'terminal.workspace.keys', checked: this.keysShown, run: () => this.setKeysShown(!this.keysShown) },
      'separator',
      { id: 'close-all', icon: 'close', label: 'terminal.workspace.closeAll', danger: true, run: () => this.closeAll() },
    ], { label: t('terminal.workspace.display') });
  }

  /** The chips of the console screen: one per open console, and + to go back to the diagram */
  #renderSwitcher() {
    const list = [...this.panes.values()];
    this.switcher.hidden = !this.#solo || list.length < 2;
    if (this.switcher.hidden) { this.switcher.replaceChildren(); return; }
    this.switcher.replaceChildren(
      ...list.map((p) => h('button.chip.ws-chip', {
        type: 'button', 'aria-pressed': String(p === this.#solo), dataset: { key: p.session.key, state: p.state },
        onclick: () => { this.solo(p.session.key); this.dispatchEvent(new CustomEvent('solo', { detail: p })); },
      }, h('span.ws-chip-led', { 'aria-hidden': 'true' }), p.session.title)),
      h('button.chip.ws-chip-back', { type: 'button', ...tAttr('title', 'terminal.pane.back'), ...tAttr('aria-label', 'terminal.pane.back'), onclick: () => this.dispatchEvent(new Event('back')) }, icon('topology')));
    this.switcher.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }

  #changed() {
    this.#renderSwitcher();
    this.dispatchEvent(new Event('change'));
  }

  #focus(pane, moveFocus = true) {
    if (this.#active !== pane) {
      this.#active?.el.classList.remove('active');
      this.#active = pane;
      pane.el.classList.add('active');
      requestAnimationFrame(() => this.#arrange()); // the key toolbar moved to this tile
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
    if (this.#maximized || this.#solo) cols = 1;
    else if (this.layout === 'columns') cols = n;
    else if (this.layout === 'rows') cols = 1;
    else cols = Math.max(1, Math.min(n, Math.floor(this.tiles.clientWidth / MIN_TILE_WIDTH) || 1, Math.ceil(Math.sqrt(n))));
    const rows = this.#maximized || this.#solo ? 1 : Math.ceil(n / cols);
    this.tiles.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.tiles.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

    // The last tile stretches across any empty cells of the final row
    const panes = [...this.panes.values()];
    const spare = cols * rows - n;
    panes.forEach((p, i) => { p.el.style.gridColumn = !this.#maximized && !this.#solo && i === n - 1 && spare ? `span ${spare + 1}` : ''; });
    for (const p of panes) p.fit();
  }
}

export const workspace = new Workspace();
