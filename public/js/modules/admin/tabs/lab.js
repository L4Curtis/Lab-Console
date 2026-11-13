/**
 * Administration › Lab parameters: how Lab Console reaches the consoles
 * (jump server, the console server's login, which console addresses may be
 * dialled). Applied to the consoles opened next, without a restart.
 *
 * Each field says whether its value comes from the environment or was saved
 * here, and a saved one can go back to the environment's. Secrets are
 * write-only: the page only knows whether one is set; an empty field keeps
 * it. Saving asks the administrator to confirm (confirm.js). Proxmox is
 * shown for reference: its module reads the environment only.
 */
import { h, toast } from '../../../core/dom.js';
import { request, getJson } from '../../../core/api.js';
import { t, has, onLocaleChange } from '../../../core/i18n.js';
import { formatDate, errorText } from '../common.js';
import { askConfirmation } from '../confirm.js';

// Field names within their section (the server's paths are `${section}.${name}`)
const SECTIONS = [
  { id: 'ssh', fields: [['host', 'text'], ['port', 'number'], ['username', 'text'], ['password', 'secret'], ['privateKey', 'secretArea'], ['passphrase', 'secret'], ['hostFingerprint', 'text']] },
  { id: 'telnet', fields: [['username', 'text'], ['password', 'secret'], ['autoLogin', 'check'], ['wakeIdleMs', 'number']] },
  { id: 'consoles', fields: [['allowedHosts', 'list'], ['portRange', 'range']] },
];
const get = (obj, path) => path.split('.').reduce((at, k) => at?.[k], obj);
const domId = (path) => `lab-${path.replace('.', '-')}`;

export function mount(el) {
  const status = h('p.form-error', { role: 'alert' });
  const meta = h('p.muted.small-note');
  const secretNotice = h('p.notice.warn', { hidden: true });
  const save = h('button.btn.primary', { type: 'submit', dataset: { action: 'save' } });
  const form = h('form.lab-form', { novalidate: true });
  const proxmox = h('dl.sso-endpoints');
  const rows = new Map(); // path → { kind, control(s), origin, reset, problem }

  for (const section of SECTIONS) {
    const box = h('fieldset.lab-section', { dataset: { section: section.id } }, h('legend', { dataset: { text: `sections.${section.id}` } }));
    for (const [name, kind] of section.fields) {
      const path = `${section.id}.${name}`;
      const id = domId(path);
      let control;
      if (kind === 'secretArea') control = h('textarea.field.mono', { id, rows: 3, spellcheck: 'false', autocomplete: 'off' });
      else if (kind === 'check') control = h('input', { id, type: 'checkbox' });
      else if (kind === 'range') control = h('div.range-pair', h('input.field', { id, type: 'number', min: 1, max: 65535 }), h('span', '–'), h('input.field', { id: `${id}-max`, type: 'number', min: 1, max: 65535 }));
      else control = h('input.field', { id, type: kind === 'secret' ? 'password' : kind === 'number' ? 'number' : 'text', autocomplete: kind === 'secret' ? 'new-password' : 'off', spellcheck: 'false' });
      const origin = h('span.origin-pill');
      const reset = h('button.btn.small.subtle', { type: 'button', dataset: { action: 'reset', field: path }, hidden: true });
      const problem = h('small.field-problem', { role: 'alert' });
      const hint = h('small.hint', { dataset: { hint: path } });
      reset.addEventListener('click', () => {
        const row = rows.get(path);
        row.resetting = !row.resetting;
        renderRow(path);
      });
      rows.set(path, { kind, control, origin, reset, problem, resetting: false });
      box.append(h(`div.lab-row${kind === 'check' ? '.check-row' : ''}`, { dataset: { field: path } },
        h('div.lab-label', h('label', { for: id, dataset: { text: `fields.${path}` } }), origin, reset),
        control, hint, problem));
    }
    form.append(box);
  }
  form.append(status, h('div.form-actions', save));
  el.append(h('div.panel.lab-panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), secretNotice, meta, form,
    h('section.lab-proxmox', h('h3', { dataset: { text: 'proxmox.title' } }), h('p.muted.small-note', { dataset: { text: 'proxmox.note' } }), proxmox)));

  let page = null;

  function renderRow(path) {
    const row = rows.get(path);
    const saved = page?.settings.saved.includes(path);
    row.origin.textContent = row.resetting ? t('admin.lab.origin.resetting') : saved ? t('admin.lab.origin.saved') : t('admin.lab.origin.environment');
    row.origin.dataset.origin = row.resetting ? 'resetting' : saved ? 'saved' : 'environment';
    row.reset.hidden = !saved;
    row.reset.textContent = row.resetting ? t('admin.lab.keepSaved') : t('admin.lab.reset');
    const value = get(page?.settings.values, path);
    if (row.kind === 'secret' || row.kind === 'secretArea') {
      row.control.placeholder = value?.set ? t('admin.lab.secretKept') : t('admin.lab.secretNone');
    }
  }

  function fill(next) {
    page = next;
    const values = page.settings.values;
    for (const [path, row] of rows) {
      const value = get(values, path);
      row.resetting = false;
      if (row.kind === 'check') row.control.checked = Boolean(value);
      else if (row.kind === 'range') { row.control.children[0].value = value.min; row.control.children[2].value = value.max; }
      else if (row.kind === 'list') row.control.value = value.join(', ');
      else if (row.kind === 'secret' || row.kind === 'secretArea') row.control.value = '';
      else row.control.value = value ?? '';
    }
    showProblems();
    render();
  }

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.lab.${node.dataset.text}`);
    for (const node of el.querySelectorAll('[data-hint]')) node.textContent = has(`admin.lab.hints.${node.dataset.hint}`) ? t(`admin.lab.hints.${node.dataset.hint}`) : '';
    save.textContent = t('admin.lab.save');
    for (const path of rows.keys()) renderRow(path);
    if (!page) return;
    meta.textContent = page.settings.updatedAt ? t('admin.lab.updated', { date: formatDate(page.settings.updatedAt), by: page.settings.updatedBy ?? '—' }) : t('admin.lab.fromEnvironment');
    secretNotice.hidden = !page.settings.unreadable.length;
    secretNotice.textContent = t('admin.lab.unreadable', { fields: page.settings.unreadable.map((p) => t(`admin.lab.fields.${p}`)).join(', ') });
    const p = page.proxmox;
    proxmox.replaceChildren(...(p.enabled
      ? [['url', p.url], ['username', `${p.username}@${p.realm}`], ['password', p.hasPassword ? t('admin.lab.secretKept') : t('admin.lab.secretNone')], ['fingerprint', p.fingerprint || '—']]
        .map(([k, v]) => h('div', h('dt', t(`admin.lab.proxmox.${k}`)), h('dd', v)))
      : [h('div', h('dt', t('admin.lab.proxmox.state')), h('dd', t('admin.lab.proxmox.off')))]));
  }

  /** Only what changed, so that an untouched field keeps its origin */
  function patch() {
    const out = {};
    const set = (path, value) => {
      const [a, b] = path.split('.');
      (out[a] ??= {})[b] = value;
    };
    for (const [path, row] of rows) {
      if (row.resetting) { set(path, null); continue; }
      const before = get(page.settings.values, path);
      if (row.kind === 'secret' || row.kind === 'secretArea') {
        if (row.control.value) set(path, row.control.value);
      } else if (row.kind === 'check') {
        if (row.control.checked !== before) set(path, row.control.checked);
      } else if (row.kind === 'number') {
        const v = row.control.value.trim() === '' ? '' : Number(row.control.value);
        if (v !== before) set(path, v);
      } else if (row.kind === 'range') {
        const v = { min: Number(row.control.children[0].value), max: Number(row.control.children[2].value) };
        if (v.min !== before.min || v.max !== before.max) set(path, v);
      } else if (row.kind === 'list') {
        const v = row.control.value.split(/[\s,]+/).filter(Boolean);
        if (v.join(',') !== before.join(',')) set(path, v);
      } else if (row.control.value.trim() !== (before ?? '')) {
        set(path, row.control.value.trim());
      }
    }
    return out;
  }

  function showProblems(list = []) {
    for (const row of rows.values()) row.problem.textContent = '';
    for (const { field, code } of list) {
      const row = rows.get(field);
      if (row) row.problem.textContent = t(`admin.lab.problems.${code}`);
    }
  }

  async function load() {
    try {
      fill(await getJson('/api/admin/lab'));
      status.textContent = '';
    } catch (err) {
      status.textContent = errorText(err);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    showProblems();
    const values = patch();
    if (!Object.keys(values).length) {
      toast(t('admin.lab.nothing'));
      return;
    }
    save.disabled = true;
    try {
      const confirmation = await askConfirmation();
      if (!confirmation) return;
      fill(await request('PUT', '/api/admin/lab', { values, confirmation }));
      toast(t('admin.lab.saved'));
    } catch (err) {
      showProblems(err.params?.problems);
      status.textContent = errorText(err);
    } finally {
      save.disabled = false;
    }
  });

  onLocaleChange(render);
  render();
  return { show: load };
}
