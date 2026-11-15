/**
 * The dock of a phone (UX.md §8.3): while consoles are open and the bench is
 * on screen, a floating pill above the tab bar with their LEDs and names (3
 * at most, then "+n") and how many are open. A tap goes back to the last
 * console's screen
 *
 *   const dock = new Dock({ onOpen: (pane) => … });
 *   el.append(dock.el);  dock.render();   // after every change of the workspace
 */
import { h, icon } from '../../core/dom.js';
import { t, onLocaleChange } from '../../core/i18n.js';
import { workspace } from '../../shared/workspace.js';

const SHOWN = 3;

export class Dock {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.names = h('span.dock-names');
    this.count = h('span.dock-count');
    this.el = h('button.dock', { type: 'button', hidden: true, dataset: { action: 'dock' }, onclick: () => this.#open() },
      this.names, this.count, icon('chevronRight'));
    workspace.addEventListener('change', () => this.render());
    onLocaleChange(() => this.render());
  }

  render() {
    const panes = [...workspace.panes.values()];
    this.el.hidden = !panes.length;
    if (!panes.length) return;
    this.names.replaceChildren(
      ...panes.slice(0, SHOWN).map((p) => h('span.dock-item', { dataset: { state: p.state } }, h('span.dock-led', { 'aria-hidden': 'true' }), p.session.title)),
      ...(panes.length > SHOWN ? [h('span.dock-more', `+${panes.length - SHOWN}`)] : []));
    this.count.textContent = t('consoles.dock.count', { count: panes.length });
    const last = this.#last();
    this.el.setAttribute('aria-label', t('consoles.dock.label', { count: panes.length, name: last?.session.title ?? '' }));
  }

  #last() {
    return workspace.active ?? [...workspace.panes.values()].at(-1) ?? null;
  }

  #open() {
    const last = this.#last();
    if (last) this.onOpen(last);
  }
}
