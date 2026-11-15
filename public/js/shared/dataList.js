/**
 * Lists of records (docs/v2/UX.md §7.3): one column definition, a table from
 * 720 px and stacked cards below. One <table> for the header and the body, so
 * columns always line up; the cards are the same rows laid out by CSS
 *
 *   const list = dataList({
 *     label: t('jobs.snapshots.title'),                         // accessible name of the table
 *     columns: [
 *       { id: 'name', label: 'jobs.cols.name', cell: (r) => r.name, primary: true },     // card title
 *       { id: 'when', label: 'jobs.cols.date', cell: (r) => fmtShort(r.at), meta: true }, // card meta line
 *       { id: 'state', label: 'jobs.cols.state', cell: (r) => badge, badge: true },       // card top right
 *       { id: 'devices', label: 'jobs.cols.devices', cell: (r) => r.count, num: true, hideCompact: true },
 *     ],
 *     actions: (r) => [                                          // last column; on a card: the primary, the rest in ⋯
 *       { id: 'zip', label: 'jobs.actions.zip', icon: 'download', run: () => …, primary: true },
 *       { id: 'delete', label: 'jobs.actions.delete', icon: 'trash', run: () => …, danger: true },
 *     ],
 *     empty: { icon, title, text, action: { label, run } },     // emptyState() when there is no row
 *     onOpen: (r) => …,                                          // optional: the row / card opens a detail
 *     dense: false,                                              // 44 px rows; on a phone one card with dividers
 *     rowKey: (r) => r.id,                                       // optional: data-key on each row
 *   });
 *   list.render(rows);   el.append(list.el);
 *
 * `label` of a column or an action is a dictionary key or a function; `cell`
 * returns a string or a node (text, never HTML). A table shows at most two
 * action buttons per row (the primary, then the next one that is not
 * dangerous), the rest in ⋯; a card shows the primary only
 */
import { h, icon, loadCss } from '../core/dom.js';
import { t, onLocaleChange } from '../core/i18n.js';
import { moreButton } from './menu.js';
import { emptyState } from './loadState.js';

const text = (v) => (typeof v === 'function' ? v() : v ? t(v) : '');

export function dataList({ label, columns = [], actions, empty, onOpen, dense = false, rowKey } = {}) {
  loadCss('shared');
  const head = h('tr');
  const body = h('tbody');
  const table = h('table.dl-table', { 'aria-label': typeof label === 'function' ? label() : label });
  const holder = h('div.dl-empty', { hidden: true });
  const el = h(`div.data-list${dense ? '.dense' : ''}`, table, holder);
  table.append(h('thead', head), body);
  let rows = [];

  function renderHead() {
    head.replaceChildren(
      ...columns.map((c) => h(`th${c.num ? '.num' : ''}`, { scope: 'col', dataset: { col: c.id } }, text(c.label))),
      ...(actions ? [h('th.dl-actions', { scope: 'col' }, h('span.sr-only', t('common.columns.actions')))] : []),
    );
    if (typeof label === 'function') table.setAttribute('aria-label', label());
  }

  function actionCell(row) {
    const list = (actions?.(row) ?? []).filter(Boolean);
    if (!list.length) return h('td.dl-actions');
    const primary = list.find((a) => a.primary) ?? null;
    const second = list.find((a) => a !== primary && !a.danger) ?? null;
    const button = (a, extra = '') => h(`button.btn.sm${a.danger ? '.danger' : ''}${extra}`, {
      type: 'button', disabled: a.disabled ? true : null, dataset: { action: a.id },
      onclick: (e) => { e.stopPropagation(); a.run?.(row); },
    }, a.icon ? icon(a.icon) : null, text(a.label));
    const shown = [primary ? button(primary) : null, second ? button(second, '.dl-table-only') : null];
    // ⋯ holds what is not shown: on a card the second action is in it too
    const rest = () => list.filter((a) => a !== primary && (a !== second || matchMedia('(max-width: 719.98px)').matches));
    const more = list.length > shown.filter(Boolean).length || second
      ? moreButton(() => rest().map((a) => ({ id: a.id, label: a.label, icon: a.icon, danger: a.danger, disabled: a.disabled, hint: a.hint })), {
        onSelect: (id) => list.find((a) => a.id === id)?.run?.(row),
      })
      : null;
    if (more && list.length - shown.filter(Boolean).length === 0) more.classList.add('dl-compact-only');
    return h('td.dl-actions', h('div.dl-actions-inner', shown, more));
  }

  function renderRows() {
    body.replaceChildren(...rows.map((row) => {
      const tr = h(`tr${onOpen ? '.dl-open' : ''}`, { dataset: rowKey ? { key: rowKey(row) } : {} });
      for (const c of columns) {
        const cls = [c.primary && 'dl-primary', c.meta && 'dl-meta', c.badge && 'dl-badge', c.hideCompact && 'dl-hide-compact', c.num && 'num'].filter(Boolean).map((x) => `.${x}`).join('');
        tr.append(h(`td${cls}`, { dataset: { col: c.id } }, c.cell(row)));
      }
      if (actions) tr.append(actionCell(row));
      if (onOpen) {
        tr.addEventListener('click', (e) => { if (!e.target.closest('button, a, input, select, label')) onOpen(row); });
        // the primary cell is the keyboard's way in
        const first = tr.querySelector('.dl-primary') ?? tr.firstElementChild;
        first.tabIndex = 0;
        first.addEventListener('keydown', (e) => { if (e.key === 'Enter') onOpen(row); });
      }
      return tr;
    }));
    const none = rows.length === 0;
    table.hidden = none && Boolean(empty);
    holder.hidden = !(none && empty);
    if (none && empty) holder.replaceChildren(emptyState(empty));
  }

  renderHead();
  const stop = onLocaleChange(() => { renderHead(); renderRows(); });
  return {
    el,
    render(next = []) { rows = [...next]; renderRows(); },
    get rows() { return rows; },
    destroy() { stop(); el.remove(); },
  };
}
