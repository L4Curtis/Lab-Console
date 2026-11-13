/**
 * Administration › Audit trail: who did what and when, newest first, with
 * filters (action, person, bench, dates). Entries are shown as text; the
 * details of an entry unfold on demand
 */
import { h } from '../../../core/dom.js';
import { getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { formatDate, errorText } from '../common.js';

const FILTERS = [['action', 'text'], ['actor', 'text'], ['bench', 'text'], ['since', 'datetime-local'], ['until', 'datetime-local']];

export function mount(el) {
  const inputs = Object.fromEntries(FILTERS.map(([name, type]) => [name, h('input.field', { type, id: `audit-${name}`, name, spellcheck: 'false' })]));
  const limit = h('select.field', { id: 'audit-limit' }, [100, 200, 500, 1000].map((n) => h('option', { value: n, selected: n === 200 }, String(n))));
  const apply = h('button.btn.primary', { type: 'submit', dataset: { action: 'filter' } });
  const clear = h('button.btn', { type: 'button', dataset: { action: 'clear' } });
  const form = h('form.audit-filters', FILTERS.map(([name]) => h('label.audit-filter', h('span', { dataset: { label: name } }), inputs[name])),
    h('label.audit-filter', h('span', { dataset: { label: 'limit' } }), limit), h('div.row-actions', clear, apply));
  const notice = h('p.form-error', { role: 'alert' });
  const count = h('p.muted.small-note');
  const tbody = h('tbody');
  el.append(h('div.panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), form, notice, count,
    h('div.table-wrap', h('table.vm-table.audit-table',
      h('thead', h('tr', ['ts', 'actor', 'action', 'bench', 'details'].map((c) => h('th', { dataset: { col: c } })))),
      tbody))));

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
      notice.textContent = errorText(err);
    }
    render();
  }

  function row(e) {
    const { bench, ...rest } = e.details ?? {};
    const detail = Object.keys(rest).length ? h('details', h('summary', t('admin.audit.more')), h('pre.audit-details', JSON.stringify(rest, null, 2))) : '';
    return h('tr', { dataset: { action: e.action } },
      h('td', formatDate(e.ts)),
      h('td', h('div.account-cell', h('strong', e.actor?.name || e.actor?.username || e.actor?.id), h('span.vm-meta', [e.actor?.id, e.ip].filter(Boolean).join(' · ')))),
      h('td.mono', e.action),
      h('td', bench ?? ''),
      h('td', detail));
  }

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.audit.${node.dataset.text}`);
    for (const node of el.querySelectorAll('[data-label]')) node.textContent = t(`admin.audit.filters.${node.dataset.label}`);
    for (const th of el.querySelectorAll('th[data-col]')) th.textContent = t(`admin.audit.columns.${th.dataset.col}`);
    inputs.action.placeholder = t('admin.audit.actionHint');
    apply.textContent = t('admin.audit.apply');
    clear.textContent = t('admin.audit.clear');
    count.textContent = t('admin.audit.count', { count: entries.length });
    tbody.replaceChildren(...(entries.length ? entries.map(row) : [h('tr', h('td.empty-row', { colspan: 5 }, t('admin.audit.none')))]));
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
  clear.addEventListener('click', () => { for (const i of Object.values(inputs)) i.value = ''; load(); });
  onLocaleChange(render);
  render();
  return { show: load };
}
