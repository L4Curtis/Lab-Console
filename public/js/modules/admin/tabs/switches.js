/**
 * Administration › Admin switches: the console devices that are not on the
 * lab diagram (the bays' administration switches), shown with the machines
 * under Machines et switchs. Edited as a list, one card per switch; saved as a
 * whole, used by the consoles at once. A line outside the allowed console
 * addresses stays listed but cannot be opened (the lab parameters say which
 * are allowed).
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { emptyState } from '../../../shared/loadState.js';
import { fmtLong } from '../../../core/format.js';

const COLUMNS = ['id', 'name', 'bay', 'host', 'port'];

export function mount(el, ctx) {
  const rows = h('div.sw-rows');
  const empty = h('div', { hidden: true });
  const notice = h('p.form-error', { role: 'alert' });
  const intro = h('p.muted.panel-intro');
  let metaText = '';
  el.append(h('div.admin-page.switches-panel', intro, h('section.card.sw-card', rows, empty), notice));

  function line(s = { id: '', name: '', bay: '', host: '', port: '' }) {
    const cells = COLUMNS.map((c) => h('div.fld.sw-cell', { dataset: { cell: c } },
      h('label', { dataset: { col: c } }, t(`admin.switches.columns.${c}`)),
      h('input.field', {
        type: c === 'port' ? 'number' : 'text',
        value: s[c] ?? '',
        dataset: { col: c },
        'aria-label': t(`admin.switches.columns.${c}`),
        spellcheck: 'false',
      }),
      h('small.field-problem', { role: 'alert', dataset: { problem: c } })));
    const remove = h('button.btn.sm.ghost.danger', { type: 'button', dataset: { action: 'remove' }, 'aria-label': t('admin.switches.remove'), title: t('admin.switches.remove') }, icon('trash'), h('span.sw-remove-text', t('admin.switches.remove')));
    const tr = h('div.sw-row', cells, remove);
    remove.addEventListener('click', () => { tr.remove(); sync(); });
    return tr;
  }

  const sync = () => {
    const none = rows.children.length === 0;
    rows.hidden = none;
    empty.hidden = !none;
    if (none) empty.replaceChildren(emptyState({ icon: 'network', title: 'admin.switches.none', text: 'admin.switches.noneText', action: { label: 'admin.switches.add', icon: 'plus', run: add } }));
  };

  function fill(data) {
    rows.replaceChildren(...data.switches.map((s) => line(s)));
    metaText = data.source === 'saved'
      ? t('admin.switches.saved', { date: fmtLong(data.updatedAt), by: data.updatedBy ?? '—' })
      : t('admin.switches.fromEnvironment');
    sync();
    render();
  }

  function values() {
    return [...rows.children].map((tr) => Object.fromEntries([...tr.querySelectorAll('input[data-col]')].map((i) => [i.dataset.col, i.dataset.col === 'port' ? Number(i.value) : i.value.trim()])));
  }

  function showProblems(list = []) {
    for (const p of rows.querySelectorAll('[data-problem]')) p.textContent = '';
    for (const { index, field, code } of list) {
      const cell = rows.children[index]?.querySelector(`[data-problem="${field}"]`);
      if (cell) cell.textContent = t(`admin.switches.problems.${code}`);
    }
  }

  async function load() {
    try {
      fill(await getJson('/api/admin/switches'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = err.message;
    }
  }

  function add() {
    rows.append(line());
    sync();
    rows.lastElementChild.querySelector('input')?.focus();
  }

  async function save() {
    notice.textContent = '';
    showProblems();
    try {
      fill(await request('PUT', '/api/admin/switches', { switches: values() }));
      toast(t('admin.switches.done'));
    } catch (err) {
      showProblems(err.params?.problems);
      notice.textContent = err.message;
    }
  }

  function render() {
    intro.textContent = t('admin.switches.intro');
    for (const label of rows.querySelectorAll('label[data-col]')) label.textContent = t(`admin.switches.columns.${label.dataset.col}`);
    ctx.setHeader(ctx.tab, {
      context: () => metaText,
      primary: { id: 'save', label: 'admin.switches.save', icon: 'check', run: save },
      actions: [{ id: 'add', label: 'admin.switches.add', icon: 'plus', run: add }],
    });
  }

  onLocaleChange(render);
  render();
  return { show: load };
}
