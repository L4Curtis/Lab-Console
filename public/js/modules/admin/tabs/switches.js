/**
 * Administration › Admin switches: the console devices that are not on the
 * lab diagram (the bays' administration switches), shown in the
 * Infrastructure section. Edited as a table; saved as a whole, used by the
 * consoles at once. A line outside the allowed console addresses stays
 * listed but cannot be opened (the lab parameters say which are allowed).
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { formatDate, errorText } from '../common.js';

const COLUMNS = ['id', 'name', 'bay', 'host', 'port'];

export function mount(el) {
  const tbody = h('tbody');
  const notice = h('p.form-error', { role: 'alert' });
  const meta = h('p.muted.small-note');
  const intro = h('p.muted.panel-intro');
  const add = h('button.btn', { type: 'button', dataset: { action: 'add' } }, icon('plus'), h('span.lbl'));
  const save = h('button.btn.primary', { type: 'button', dataset: { action: 'save' } });
  el.append(h('div.panel.switches-panel', intro, meta,
    h('div.table-wrap', h('table.vm-table.switches-table',
      h('thead', h('tr', [...COLUMNS, 'actions'].map((c) => h('th', { dataset: { col: c } })))),
      tbody)),
    notice,
    h('div.form-actions', add, save)));

  function line(s = { id: '', name: '', bay: '', host: '', port: '' }) {
    const cells = COLUMNS.map((c) => h('td', h('input.field', {
      type: c === 'port' ? 'number' : 'text',
      value: s[c] ?? '',
      dataset: { col: c },
      'aria-label': t(`admin.switches.columns.${c}`),
      spellcheck: 'false',
    }), h('small.field-problem', { role: 'alert', dataset: { problem: c } })));
    const remove = h('button.btn.small.subtle', { type: 'button', dataset: { action: 'remove' }, 'aria-label': t('admin.switches.remove'), title: t('admin.switches.remove') }, icon('trash'));
    const tr = h('tr', cells, h('td.right', remove));
    remove.addEventListener('click', () => tr.remove());
    return tr;
  }

  function fill(data) {
    tbody.replaceChildren(...data.switches.map((s) => line(s)));
    meta.textContent = data.source === 'saved'
      ? t('admin.switches.saved', { date: formatDate(data.updatedAt), by: data.updatedBy ?? '—' })
      : t('admin.switches.fromEnvironment');
  }

  function values() {
    return [...tbody.children].map((tr) => Object.fromEntries([...tr.querySelectorAll('input[data-col]')].map((i) => [i.dataset.col, i.dataset.col === 'port' ? Number(i.value) : i.value.trim()])));
  }

  function showProblems(list = []) {
    for (const p of tbody.querySelectorAll('[data-problem]')) p.textContent = '';
    for (const { index, field, code } of list) {
      const cell = tbody.children[index]?.querySelector(`[data-problem="${field}"]`);
      if (cell) cell.textContent = t(`admin.switches.problems.${code}`);
    }
  }

  async function load() {
    try {
      fill(await getJson('/api/admin/switches'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = errorText(err);
    }
  }

  function render() {
    intro.textContent = t('admin.switches.intro');
    add.querySelector('.lbl').textContent = t('admin.switches.add');
    save.textContent = t('admin.switches.save');
    for (const th of el.querySelectorAll('th[data-col]')) th.textContent = th.dataset.col === 'actions' ? '' : t(`admin.switches.columns.${th.dataset.col}`);
  }

  add.addEventListener('click', () => tbody.append(line()));
  save.addEventListener('click', async () => {
    save.disabled = true;
    notice.textContent = '';
    showProblems();
    try {
      fill(await request('PUT', '/api/admin/switches', { switches: values() }));
      toast(t('admin.switches.done'));
    } catch (err) {
      showProblems(err.params?.problems);
      notice.textContent = errorText(err);
    } finally {
      save.disabled = false;
    }
  });

  onLocaleChange(render);
  render();
  return { show: load };
}
