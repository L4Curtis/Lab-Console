/**
 * "Le labo": every bench of the lab on one screen, the block of the home page
 * (docs/v2/UX.md §10.1). Filter chips (Toutes, Libres, Prises, Verrouillées,
 * La nôtre), then the benches: cards in a grid on a PC, a dense list on a
 * phone. Read only: taking, joining or releasing a bench is done from the
 * bench itself, a card leads there
 *
 *   const lab = labBlock({ onFilter: (id) => … });
 *   host.append(lab.el);
 *   lab.render(cards);          // GET /api/overview/benches → benches
 *   lab.setFilter('free');      // 'all' | 'free' | 'taken' | 'locked' | 'mine'
 *   lab.focusHeading();         // #/home/lab: the heading gets the focus
 *
 * The filter is kept with prefs (benchFilter). The server decides what each
 * person may see; nothing here hides or reveals anything
 */
import { h, icon, prefs } from '../../core/dom.js';
import { t, onLocaleChange } from '../../core/i18n.js';
import { isCompact, onViewportChange } from '../../core/viewport.js';
import { dataList } from '../../shared/dataList.js';
import { benchCard, stateBadge, holderText } from './benchCard.js';
import { replaceKeepingFocus } from './keepFocus.js';

export const FILTERS = ['all', 'free', 'taken', 'locked', 'mine'];
const matches = {
  all: () => true,
  free: (c) => c.state === 'free',
  taken: (c) => c.state === 'taken',
  locked: (c) => c.state === 'locked',
  mine: (c) => c.you.occupant,
};

export const isFilter = (id) => FILTERS.includes(id);

export function labBlock({ onFilter } = {}) {
  let cards = null;
  let compactNow = isCompact();
  let filter = isFilter(prefs.get('benchFilter', 'all')) ? prefs.get('benchFilter', 'all') : 'all';

  const heading = h('h2#ov-lab-title', { tabindex: '-1' });
  const chips = new Map(FILTERS.map((id) => [id, h('button.chip', { type: 'button', dataset: { filter: id }, onclick: () => choose(id) })]));
  const chipRow = h('div.chips.ov-filters', { role: 'group' }, [...chips.values()]);
  const status = h('p.ov-status.muted', { role: 'status' });
  const grid = h('div.ov-grid');
  const list = dataList({
    label: () => t('overview.lab.title'),
    dense: true,
    columns: [
      // A card of a phone: the bench and its state, one line under them, a chevron (the whole row opens the bench)
      { id: 'bench', label: 'overview.lab.cols.bench', cell: (c) => h('a.ov-link', { href: `#/consoles/${encodeURIComponent(c.bench)}`, dataset: { bench: c.bench } }, c.bench, icon('chevronRight', 'ov-chevron')), primary: true },
      { id: 'state', label: 'overview.lab.cols.state', cell: (c) => stateBadge(c), badge: true },
      { id: 'detail', label: 'overview.lab.cols.detail', cell: (c) => [holderText(c), t('overview.card.lines', { count: c.lines.open, total: c.lines.total })].filter(Boolean).join(' · '), meta: true },
    ],
    onOpen: (c) => { location.hash = `#/consoles/${encodeURIComponent(c.bench)}`; },
    rowKey: (c) => c.bench,
  });
  const el = h('section.ov-lab', { dataset: { panel: 'lab' }, 'aria-labelledby': 'ov-lab-title' }, heading, chipRow, status, grid, list.el);

  function choose(id) {
    setFilter(id);
    onFilter?.(id);
  }

  function setFilter(id) {
    if (!isFilter(id)) return;
    filter = id;
    prefs.set('benchFilter', id);
    render();
  }

  function render(next = cards) {
    cards = next;
    heading.textContent = t('overview.lab.title');
    chipRow.setAttribute('aria-label', t('overview.lab.filters.label'));
    const count = (id) => (cards ? cards.filter(matches[id]).length : 0);
    for (const [id, chip] of chips) {
      chip.textContent = cards && id !== 'mine' ? `${t(`overview.lab.filters.${id}`)} ${count(id)}` : t(`overview.lab.filters.${id}`);
      chip.setAttribute('aria-pressed', String(id === filter));
    }
    const compact = isCompact();
    compactNow = compact;
    if (!cards) {
      status.hidden = false;
      status.textContent = t('overview.loading');
      grid.hidden = true;
      list.el.hidden = true;
      return;
    }
    const shown = cards.filter(matches[filter]);
    status.hidden = shown.length > 0;
    status.textContent = t('overview.lab.empty');
    grid.hidden = compact || shown.length === 0;
    list.el.hidden = !compact || shown.length === 0;
    if (compact) {
      grid.replaceChildren();
      list.render(shown);
    } else {
      list.render([]);
      replaceKeepingFocus(grid, shown.map((c) => benchCard(c)));
    }
  }

  onLocaleChange(() => render());
  onViewportChange((now) => { if (cards && now.compact !== compactNow) render(); });
  render();

  return {
    el,
    render,
    setFilter,
    get filter() { return filter; },
    focusHeading() {
      heading.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
    },
  };
}
