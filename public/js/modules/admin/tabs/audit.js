/**
 * Administration › Audit trail: who did what and when, newest first, with
 * filters (action, person, bench, dates). Entries are shown as text; the
 * details of an entry unfold on demand
 */
import { h } from '../../../core/dom.js';
import { getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { dataList } from '../../../shared/dataList.js';
import { fmtLong } from '../../../core/format.js';

const FILTERS = [['action', 'text'], ['actor', 'text'], ['bench', 'text'], ['since', 'datetime-local'], ['until', 'datetime-local']];

export function mount(el, ctx) {
  const inputs = Object.fromEntries(FILTERS.map(([name, type]) => [name, h('input.field', { type, id: `audit-${name}`, name, spellcheck: 'false' })]));
  const limit = h('select.field', { id: 'audit-limit' }, [100, 200, 500, 1000].map((n) => h('option', { value: n, selected: n === 200 }, String(n))));
  const apply = h('button.btn.primary', { type: 'submit', dataset: { action: 'filter' } });
  const clear = h('button.btn', { type: 'button', dataset: { action: 'clear' } });
  const form = h('form.card.audit-filters', { novalidate: true },
    h('div.form-grid.audit-grid',
      FILTERS.map(([name]) => h('div.fld', h('label', { for: `audit-${name}`, dataset: { label: name } }), inputs[name])),
      h('div.fld', h('label', { for: 'audit-limit', dataset: { label: 'limit' } }), limit)),
    h('div.form-actions', clear, apply));
  const notice = h('p.form-error', { role: 'alert' });

  const list = dataList({
    label: () => t('admin.audit.title'),
    dense: true,
    columns: [
      { id: 'ts', label: () => t('admin.audit.columns.ts'), cell: (e) => fmtLong(e.ts), meta: true },
      {
        id: 'actor', label: () => t('admin.audit.columns.actor'), meta: true,
        cell: (e) => h('div.account-cell', h('strong', e.actor?.name || e.actor?.username || e.actor?.id), h('span.vm-meta', [e.actor?.id, e.ip].filter(Boolean).join(' · '))),
      },
      { id: 'action', label: () => t('admin.audit.columns.action'), cell: (e) => h('span.mono', e.action), primary: true },
      { id: 'bench', label: () => t('admin.audit.columns.bench'), cell: (e) => (e.details ?? {}).bench ?? '', meta: true },
      {
        id: 'details', label: () => t('admin.audit.columns.details'), meta: true,
        cell: (e) => {
          const { bench: _bench, ...rest } = e.details ?? {};
          return Object.keys(rest).length ? h('details', h('summary', t('admin.audit.more')), h('pre.audit-details', JSON.stringify(rest, null, 2))) : '';
        },
      },
    ],
    empty: { icon: 'history', title: 'admin.audit.none' },
  });
  list.el.querySelector('table').classList.add('audit-table');
  el.append(h('div.admin-page', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), form, notice, list.el));

  let entries = [];

  const iso = (v) => (v ? new Date(v).toISOString() : '');
  async function load() {
    const q = new URLSearchParams();
    for (const [name] of FILTERS) {
      const v = inputs[name].value.trim();
      if (v) q.set(name, name === 'since' || name === 'until' ? iso(v) : v);
    }
    q.set('limit', limit.value);
    try {
      ({ entries } = await getJson(`/api/admin/audit?${q}`));
      notice.textContent = '';
    } catch (err) {
      entries = [];
      notice.textContent = err.message;
    }
    render();
  }

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.audit.${node.dataset.text}`);
    for (const node of el.querySelectorAll('[data-label]')) node.textContent = t(`admin.audit.filters.${node.dataset.label}`);
    inputs.action.placeholder = t('admin.audit.actionHint');
    apply.textContent = t('admin.audit.apply');
    clear.textContent = t('admin.audit.clear');
    list.render(entries);
    ctx.setHeader(ctx.tab, { context: () => t('admin.audit.count', { count: entries.length }) });
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
  clear.addEventListener('click', () => { for (const i of Object.values(inputs)) i.value = ''; load(); });
  onLocaleChange(render);
  render();
  return { show: load };
}
