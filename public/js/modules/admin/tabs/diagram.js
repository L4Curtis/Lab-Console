/**
 * Administration › Diagram: the lab diagram students open consoles from
 *
 * Import a .drawio file (5 MB at most): the server checks it with the same
 * parser as the consoles and keeps it as a version, without changing
 * anything yet. The page then shows what it contains (drawn as students will
 * see it), the warnings, and what changes against the active diagram;
 * "Activate" makes it the diagram everyone sees, at once. Every version is
 * kept, can be previewed, downloaded, activated again; "Roll back" returns
 * to the diagram that was active before, in one click.
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, tError, onLocaleChange } from '../../../core/i18n.js';
import { serverText } from '../../../shared/serverText.js';
import { confirmDialog } from '../../../shared/dialog.js';
import { DiagramView } from '../../consoles/diagramView.js';
import { formatDate, errorText } from '../common.js';

const MAX_BYTES = 5 * 1024 * 1024;

/** POST the file as it is: the body is the diagram, not JSON */
async function uploadFile(file) {
  const res = await fetch(`/api/admin/diagrams?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.code ? tError(data.code, data.params, data.error) : data?.error || `HTTP ${res.status}`);
    err.code = data?.code ?? null;
    throw err;
  }
  return data;
}

export function mount(el) {
  const input = h('input', { type: 'file', accept: '.drawio,.xml,application/xml', id: 'diagram-file', hidden: true });
  const pick = h('button.btn.primary', { type: 'button', dataset: { action: 'import' }, onclick: () => input.click() }, icon('upload'), h('span.lbl'));
  const rollback = h('button.btn', { type: 'button', dataset: { action: 'rollback' } }, icon('restore'), h('span.lbl'));
  const notice = h('p.form-error', { role: 'alert' });
  const intro = h('p.muted.panel-intro');
  const tbody = h('tbody');
  const preview = h('section.diagram-preview', { hidden: true, 'aria-live': 'polite' });
  el.append(h('div.panel.diagram-panel',
    intro,
    h('div.panel-toolbar', input, pick, rollback),
    notice,
    preview,
    h('div.table-wrap', h('table.vm-table.versions-table',
      h('thead', h('tr', ['name', 'devices', 'by', 'at', 'state', 'actions'].map((c) => h('th', { dataset: { col: c } })))),
      tbody))));

  let state = { versions: [], canRollback: false };
  let shown = null; // the version in the preview
  const canvas = h('div.preview-canvas');
  let view = null;    // one drawing, reused by every preview

  async function load() {
    try {
      state = await getJson('/api/admin/diagrams');
      notice.textContent = '';
    } catch (err) {
      notice.textContent = errorText(err);
    }
    render();
  }

  function row(v) {
    const actions = [
      h('button.btn.small', { type: 'button', dataset: { action: 'preview' }, onclick: () => showPreview(v.id) }, t('admin.diagram.preview')),
      h('a.btn.small', { href: `/api/admin/diagrams/${encodeURIComponent(v.id)}/download`, download: '', dataset: { action: 'download' } }, icon('download'), h('span.lbl', t('admin.diagram.download'))),
    ];
    if (!v.active) actions.unshift(h('button.btn.small.primary', { type: 'button', dataset: { action: 'activate' }, onclick: () => activate(v) }, t('admin.diagram.activate')));
    return h('tr', { dataset: { version: v.id, active: String(v.active) } },
      h('td', h('div.account-cell', h('strong', v.name), v.source === 'environment' ? h('span.vm-meta', t('admin.diagram.fromEnvironment')) : null)),
      h('td', t('admin.diagram.deviceCount', { count: v.devices ?? 0 })),
      h('td', v.by?.username ?? '—'),
      h('td', formatDate(v.at)),
      h('td', v.active ? h('span.state-pill', { dataset: { state: 'active' } }, t('admin.diagram.active')) : ''),
      h('td.right', h('div.row-actions.end', actions)));
  }

  function render() {
    intro.textContent = t('admin.diagram.intro');
    pick.querySelector('.lbl').textContent = t('admin.diagram.import');
    rollback.querySelector('.lbl').textContent = t('admin.diagram.rollback');
    rollback.disabled = !state.canRollback;
    for (const th of el.querySelectorAll('th[data-col]')) th.textContent = th.dataset.col === 'actions' ? '' : t(`admin.diagram.columns.${th.dataset.col}`);
    tbody.replaceChildren(...(state.versions.length ? state.versions.map(row) : [h('tr', h('td.empty-row', { colspan: 6 }, t('admin.diagram.none')))]));
  }

  function diffList(title, items, format) {
    if (!items.length) return null;
    return h('div.diff-group', h('h4', title, ' ', h('span.badge', String(items.length))), h('ul', items.slice(0, 40).map((x) => h('li', format(x))), items.length > 40 ? h('li.muted', '…') : null));
  }

  async function showPreview(id) {
    try {
      const data = await getJson(`/api/admin/diagrams/${encodeURIComponent(id)}/preview`);
      const { labs, version } = data;
      shown = version;
      const d = data.diff;
      const pages = h('div.seg.preview-pages', { role: 'group', 'aria-label': t('admin.diagram.pages') });
      const changes = [
        diffList(t('admin.diagram.diff.labsAdded'), d.labs.added, (n) => n),
        diffList(t('admin.diagram.diff.labsRemoved'), d.labs.removed, (n) => n),
        diffList(t('admin.diagram.diff.devicesAdded'), d.devices.added, (x) => `${x.lab} / ${x.name} → ${x.target}`),
        diffList(t('admin.diagram.diff.devicesRemoved'), d.devices.removed, (x) => `${x.lab} / ${x.name} (${x.target})`),
        diffList(t('admin.diagram.diff.devicesMoved'), d.devices.moved, (x) => `${x.lab} / ${x.name}: ${x.from} → ${x.target}`),
      ].filter(Boolean);
      const activateBtn = version.id === state.active
        ? h('span.state-pill', { dataset: { state: 'active' } }, t('admin.diagram.active'))
        : h('button.btn.primary', { type: 'button', dataset: { action: 'activate-preview' }, onclick: () => activate(version) }, t('admin.diagram.activate'));
      preview.replaceChildren(
        h('header.preview-head', h('div', h('h3', t('admin.diagram.previewTitle', { name: version.name })),
          h('p.muted.small-note', t('admin.diagram.previewMeta', { labs: labs.length, count: version.devices }))),
        h('div.row-actions.end', activateBtn, h('button.btn', { type: 'button', onclick: () => { preview.hidden = true; shown = null; } }, t('common.actions.close')))),
        h('div.diff', d.same ? h('p.notice', t('admin.diagram.diff.same')) : changes.length ? changes : h('p.notice', t('admin.diagram.diff.none'))),
        data.outsideAllowList?.length ? h('div.notice.warn', { dataset: { notice: 'outside-allow-list' } }, h('strong', t('admin.diagram.outsideAllowList', { count: data.outsideAllowList.length })),
          h('ul', data.outsideAllowList.slice(0, 30).map((x) => h('li', `${x.lab} / ${x.name} → ${x.target}`)))) : null,
        data.warnings?.length ? h('div.notice.warn', h('strong', t('admin.diagram.warnings', { count: data.warnings.length })), h('ul', data.warnings.slice(0, 30).map((w) => h('li', serverText(w))))) : null,
        pages,
        canvas);
      preview.hidden = false;
      view ??= new DiagramView(canvas, { onOpen: () => {} });
      const select = (lab) => {
        for (const b of pages.children) b.setAttribute('aria-pressed', String(b.dataset.lab === lab.name));
        view.render(lab);
      };
      for (const lab of labs) pages.append(h('button.seg-btn', { type: 'button', dataset: { lab: lab.name }, onclick: () => select(lab) }, lab.name));
      if (labs[0]) select(labs[0]);
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    }
  }

  async function activate(version) {
    const ok = await confirmDialog({ title: t('admin.diagram.activateTitle'), body: t('admin.diagram.activateBody', { name: version.name }), confirmLabel: t('admin.diagram.activate') });
    if (!ok) return;
    try {
      await request('POST', `/api/admin/diagrams/${encodeURIComponent(version.id)}/activate`, {});
      toast(t('admin.diagram.activated'));
      preview.hidden = true;
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    }
    await load();
  }

  rollback.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('admin.diagram.rollbackTitle'), body: t('admin.diagram.rollbackBody'), confirmLabel: t('admin.diagram.rollback'), danger: true });
    if (!ok) return;
    try {
      await request('POST', '/api/admin/diagrams/rollback', {});
      toast(t('admin.diagram.rolledBack'));
      preview.hidden = true;
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    }
    await load();
  });

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast(t('admin.errors.diagram_too_large'), 'error', 7000);
      return;
    }
    pick.disabled = true;
    try {
      const result = await uploadFile(file);
      toast(t('admin.diagram.imported'));
      await load();
      await showPreview(result.version.id);
    } catch (err) {
      notice.textContent = errorText(err);
    } finally {
      pick.disabled = false;
    }
  });

  onLocaleChange(() => { render(); if (shown && !preview.hidden) showPreview(shown.id); });
  live.on('admin:changed', ({ what }) => { if (what === 'diagrams') load(); });
  render();
  return { show: load };
}
