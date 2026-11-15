/**
 * "Baie" (#/team/bench[/<bench>]): everything about one bench in one page.
 * The bench in the address, else the one my team holds; with neither, the
 * list of benches, to take a free one (docs/v2/UX.md §10.3). The header
 * carries the one action (release, take, ask to join…) and the bench picker
 */
import { h, icon } from '../../../core/dom.js';
import { callOrToast } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { openMenu } from '../../../shared/menu.js';
import { dataList } from '../../../shared/dataList.js';
import { onBenches, benchUrl, isOccupant } from '../data.js';
import { watchBench, benchActions } from '../benchModel.js';
import { createBenchPanel, primaryOf } from '../benchPanel.js';

/** One word for a bench of the lab-wide summaries: [tone, word] */
const summaryState = (s) => (s.lock ? ['danger', t('benches.state.locked')] : !s.holder ? ['success', t('benches.state.free')] : isOccupant(s) ? ['info', t('benches.state.mine')] : ['warning', t('benches.state.taken')]);

export function mount(el, { header, navigate }) {
  let benches = new Map();
  let visible = false;
  let wanted = null; // the bench of the address, if any
  let empty = false; // no bench to show: the list instead

  let panel = null; // the model may call back while it is being built (a sticky topic answers at once)
  const model = watchBench(() => { panel?.render(); syncHeader(); });
  const act = benchActions(model);
  panel = createBenchPanel({ model, act });
  const picker = h('button.btn.sm.bench-picker', { type: 'button', dataset: { action: 'pick' }, 'aria-haspopup': 'menu', onclick: () => pick() });
  const chooserHead = h('div.bench-chooser-head');
  const chooser = h('div.bench-chooser');
  const list = dataList({
    label: () => t('benches.list.label'),
    columns: [
      { id: 'bench', label: 'benches.list.bench', cell: (s) => h('strong', s.bench), primary: true },
      { id: 'state', label: 'benches.list.state', cell: (s) => { const [tone, word] = summaryState(s); return h('span.badge', { dataset: { tone } }, h('span.dot'), word); }, badge: true },
      { id: 'team', label: 'benches.list.team', cell: (s) => s.holder?.teamName ?? '', meta: true },
    ],
    // One action a row: take a free bench, look at another; the row itself opens the bench too
    actions: (s) => [
      !s.holder && !s.lock
        ? { id: 'take', label: 'benches.actions.take', icon: 'check', primary: true, run: () => takeAndShow(s.bench) }
        : { id: 'open', label: 'benches.list.open', icon: 'chevronRight', primary: true, run: () => show(s.bench) },
    ],
    onOpen: (s) => show(s.bench),
    rowKey: (s) => s.bench,
    dense: true,
  });
  chooser.append(h('section.card', chooserHead), list.el);
  el.append(h('div.bench-tab', chooser, panel.el));

  const heldByMe = () => [...benches.values()].find((s) => isOccupant(s))?.bench ?? null;

  function render() {
    chooserHead.replaceChildren(h('div.card-head', h('h2', t('benches.list.title'))), h('p.card-meta', t('benches.list.intro')));
    const rows = [...benches.values()].sort((a, b) => a.bench.localeCompare(b.bench, undefined, { numeric: true }));
    list.render(rows);
    chooser.hidden = !empty;
    panel.el.hidden = empty;
    picker.replaceChildren(model.bench ? t('benches.picker', { bench: model.bench }) : '', icon('chevronDown'));
    syncHeader();
  }

  function syncHeader() {
    if (!visible) return;
    const d = model.detail;
    const primary = !empty && d ? primaryOf(d, act) : null;
    header.update({
      context: () => (empty ? t('benches.list.context') : picker),
      primary: primary ? { id: primary.id, label: primary.label, icon: primary.icon, run: primary.run } : null,
      actions: [],
    });
  }

  /** Which bench this page shows: the address, else mine, else none */
  function target() {
    const name = wanted && benches.has(wanted) ? wanted : heldByMe();
    return name ?? null;
  }

  function apply() {
    const name = target();
    empty = !name;
    model.setBench(name);
    render();
  }

  async function pick() {
    const items = [...benches.values()].sort((a, b) => a.bench.localeCompare(b.bench, undefined, { numeric: true }))
      .map((s) => ({ id: s.bench, label: s.bench, checked: s.bench === model.bench, trail: summaryState(s)[1] }));
    const id = await openMenu(picker, items, { label: t('benches.pick') });
    if (id) show(id);
  }

  function show(name) {
    wanted = name;
    navigate?.(`#/team/bench/${encodeURIComponent(name)}`);
    apply();
  }

  async function takeAndShow(name) {
    if (await callOrToast('POST', benchUrl(name, '/take'))) show(name);
  }

  onBenches((all) => { benches = all; if (visible) apply(); });
  onLocaleChange(() => render());

  return {
    show([name] = []) {
      visible = true;
      wanted = name ?? null;
      apply();
    },
    hide() { visible = false; },
  };
}
