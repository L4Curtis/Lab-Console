/**
 * Administration › Audit trail: who did what and when, newest first, with
 * filters (action, person, bench, dates). Entries are shown as text; the
 * details of an entry unfold on demand
 */
import { h, icon } from '../../../core/dom.js';
import { isCompact } from '../../../core/viewport.js';
import { getJson } from '../../../core/api.js';
import { t, has, onLocaleChange } from '../../../core/i18n.js';
import { dataList } from '../../../shared/dataList.js';
import { fmtLong, fmtShort } from '../../../core/format.js';

/** The code of an action in words: a sentence of the dictionary, the kind of a job or a check named in it, else the code itself */
export function actionLabel(code) {
  const known = `admin.audit.actions.${code.replace(/\./g, '_')}`;
  if (has(known)) return t(known);
  const kind = /^(job|check)\.([a-z_]+?)(?:\.(cancel|end))?$/.exec(code);
  if (kind) return t(`admin.audit.dynamic.${kind[1]}${kind[3] === 'cancel' ? 'Cancel' : kind[3] === 'end' ? 'End' : 'Start'}`, { kind: kind[2] });
  return code;
}

const FILTERS = [['action', 'text'], ['actor', 'text'], ['bench', 'text'], ['since', 'datetime-local'], ['until', 'datetime-local']];

export function mount(el, ctx) {
  const inputs = Object.fromEntries(FILTERS.map(([name, type]) => [name, h('input.field', { type, id: `audit-${name}`, name, spellcheck: 'false' })]));
  const limit = h('select.field', { id: 'audit-limit' }, [100, 200, 500, 1000].map((n) => h('option', { value: n, selected: n === 200 }, String(n))));
  const apply = h('button.btn.primary', { type: 'submit', dataset: { action: 'filter' } });
  const clear = h('button.btn', { type: 'button', dataset: { action: 'clear' } });
  const form = h('form', { novalidate: true },
    h('div.form-grid.audit-grid',
      FILTERS.map(([name]) => h('div.fld', h('label', { for: `audit-${name}`, dataset: { label: name } }), inputs[name])),
      h('div.fld', h('label', { for: 'audit-limit', dataset: { label: 'limit' } }), limit)),
    h('div.form-actions', clear, apply));
  // On a phone the six filters are folded behind their title; from 720 px they are open and the title is hidden
  const filters = h('details.card.audit-filters', { open: !isCompact() }, h('summary', h('span', { dataset: { text: 'filtersTitle' } }), icon('filter')), form);
  const notice = h('p.form-error', { role: 'alert' });

  const list = dataList({
    label: () => t('admin.audit.title'),
    dense: true,
    columns: [
      { id: 'ts', label: () => t('admin.audit.columns.ts'), cell: (e) => h('time.audit-time', { datetime: e.ts, title: fmtLong(e.ts) }, fmtShort(e.ts)), meta: true },
      {
        id: 'actor', label: () => t('admin.audit.columns.actor'), meta: true,
        cell: (e) => h('div.account-cell', h('strong', e.actor?.name || e.actor?.username || e.actor?.id), h('span.vm-meta', [e.actor?.id, e.ip].filter(Boolean).join(' · '))),
      },
      // The action in words, its code small and grey beneath (the exact date is the tooltip of the short one)
      { id: 'action', label: () => t('admin.audit.columns.action'), cell: (e) => h('div.account-cell', h('strong', actionLabel(e.action)), h('span.vm-meta', e.action)), primary: true },
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
  el.append(h('div.admin-page', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), filters, notice, list.el));

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
    list.el.classList.toggle('no-bench', !entries.some((e) => (e.details ?? {}).bench)); // an empty column says nothing
    ctx.setHeader(ctx.tab, { context: () => t('admin.audit.count', { count: entries.length }) });
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
  clear.addEventListener('click', () => { for (const i of Object.values(inputs)) i.value = ''; load(); });
  onLocaleChange(render);
  render();
  return { show: load };
}
