/**
 * "Overview" section (#/overview): every bench of the lab on one screen,
 * live: the team that holds it, who is on it, the consoles open and their
 * pilots, the running job, the lock, the next slots and the state of its
 * console lines. Read only: taking a bench, joining it or opening a console
 * is done from the bench itself (a card leads there)
 *
 * The data is GET /api/overview/benches; the screen reads it again when the
 * topics it depends on move (live.js). The server decides what each person
 * may see; nothing here hides or reveals anything
 */
import { h, loadCss, prefs } from '../../core/dom.js';
import { t, tNode, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { followApi, roomsSignature, checksSignature } from './live.js';
import { benchCard } from './benchCard.js';
import { replaceKeepingFocus } from './keepFocus.js';

const FILTERS = ['all', 'free', 'mine'];
const matches = {
  all: () => true,
  free: (c) => c.state === 'free',
  mine: (c) => c.you.occupant,
};

export async function mount(el) {
  await Promise.all([loadNamespace('overview', 'benches', 'jobs'), loadCss('overview')]);

  let data = null;
  let failed = false;
  let filter = FILTERS.includes(prefs.get('benchFilter', 'all')) ? prefs.get('benchFilter', 'all') : 'all';

  const totals = h('ul.ov-totals', { 'aria-label': t('overview.totals.label') });
  const buttons = new Map(FILTERS.map((id) => [id, h('button.btn.small', { type: 'button', dataset: { filter: id }, onclick: () => choose(id) }, t(`overview.filters.${id}`))]));
  const filters = h('div.ov-filters', { role: 'group', 'aria-label': t('overview.filters.label') }, [...buttons.values()]);
  const grid = h('div.ov-grid');
  const status = h('p.ov-status.muted', { role: 'status' }, t('overview.loading'));
  el.append(
    h('header.view-head', h('div.view-title', h('h1', tNode('overview.title')), h('p', tNode('overview.subtitle'))), filters),
    h('div.ov-body', totals, status, grid));

  function choose(id) {
    filter = id;
    prefs.set('benchFilter', id);
    render();
  }

  function render() {
    for (const [id, b] of buttons) {
      b.textContent = t(`overview.filters.${id}`);
      b.setAttribute('aria-pressed', String(id === filter));
    }
    filters.setAttribute('aria-label', t('overview.filters.label'));
    totals.setAttribute('aria-label', t('overview.totals.label'));
    if (!data) {
      status.hidden = false;
      status.textContent = failed ? t('overview.loadError') : t('overview.loading');
      status.append(...(failed ? [' ', h('button.btn.small', { type: 'button', dataset: { action: 'retry' }, onclick: () => feed.refresh() }, t('overview.retry'))] : []));
      totals.replaceChildren();
      grid.replaceChildren();
      return;
    }
    const cards = data.benches;
    const count = (state) => cards.filter((c) => c.state === state).length;
    const consoles = cards.reduce((n, c) => n + c.consoles.length, 0);
    const jobs = cards.filter((c) => c.job).length;
    totals.replaceChildren(...[
      ['benches', cards.length], ['free', count('free')], ['taken', count('taken')], ['locked', count('locked')], ['consoles', consoles], ['jobs', jobs],
    ].map(([key, n]) => h('li', { dataset: { total: key, count: String(n) } }, t(`overview.totals.${key}`, { count: n }))));
    const shown = cards.filter(matches[filter]);
    status.hidden = shown.length > 0;
    status.textContent = t('overview.empty');
    replaceKeepingFocus(grid, shown.map((c) => benchCard(c)));
  }

  const feed = followApi('/api/overview/benches', {
    // The state of the benches, of the consoles open, of the jobs, the calendar, the teams' names and the line status the checks found
    topics: ['benches:state', 'benches:reservations', 'consoles:rooms', 'consoles:busy', 'jobs:running', 'teams:changed', 'checks:running'],
    changed: { 'consoles:rooms': roomsSignature, 'checks:running': checksSignature },
    onData: (next) => {
      // Most events move nothing a card shows: draw again only when the benches differ
      const same = data && !failed && JSON.stringify(next.benches) === JSON.stringify(data.benches);
      data = next;
      failed = false;
      if (!same) render();
    },
    onError: () => { failed = true; if (!data) render(); },
  });
  onLocaleChange(render);
  render();

  return { show: () => feed.show(), hide: () => feed.hide() };
}
