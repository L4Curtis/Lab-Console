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
import { h, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { tagRows, stateBadge } from '../common.js';
import { dataList } from '../../../shared/dataList.js';
import { serverText } from '../../../shared/serverText.js';
import { confirmDialog } from '../../../shared/dialog.js';
import { DiagramView } from '../../consoles/diagramView.js';
import { fmtLong } from '../../../core/format.js';

const MAX_BYTES = 5 * 1024 * 1024;

/** POST the file as it is: the body is the diagram, not JSON */
const uploadFile = (file) => request('POST', `/api/admin/diagrams?name=${encodeURIComponent(file.name)}`, file, { type: 'application/octet-stream' });

export function mount(el, ctx) {
  const input = h('input', { type: 'file', accept: '.drawio,.xml,application/xml', id: 'diagram-file', hidden: true });
  const notice = h('p.form-error', { role: 'alert' });
  const intro = h('p.muted.panel-intro');
  const preview = h('section.card.diagram-preview', { hidden: true, 'aria-live': 'polite' });
  const list = dataList({
    label: () => t('admin.diagram.versionsTitle'),
    dense: true,
    rowKey: (v) => v.id,
    columns: [
      { id: 'name', label: () => t('admin.diagram.columns.name'), cell: (v) => h('div.account-cell', h('strong', v.name), v.source === 'environment' ? h('span.vm-meta', t('admin.diagram.fromEnvironment')) : null), primary: true },
      { id: 'devices', label: () => t('admin.diagram.columns.devices'), cell: (v) => t('admin.diagram.deviceCount', { count: v.devices ?? 0 }), meta: true },
      { id: 'by', label: () => t('admin.diagram.columns.by'), cell: (v) => v.by?.username ?? '—', hideCompact: true },
      { id: 'at', label: () => t('admin.diagram.columns.at'), cell: (v) => fmtLong(v.at), meta: true },
      { id: 'state', label: () => t('admin.diagram.columns.state'), cell: (v) => (v.active ? stateBadge('active', t('admin.diagram.active')) : ''), badge: true },
    ],
    actions: (v) => [
      v.active ? null : { id: 'activate', label: 'admin.diagram.activate', icon: 'check', primary: true, run: () => activate(v) },
      { id: 'preview', label: 'admin.diagram.preview', icon: 'search', run: () => showPreview(v.id) },
      { id: 'download', label: 'admin.diagram.download', icon: 'download', run: () => { location.assign(`/api/admin/diagrams/${encodeURIComponent(v.id)}/download`); } },
    ].filter(Boolean),
    empty: { icon: 'archive', title: 'admin.diagram.none' },
  });
  tagRows(list, (v) => ({ version: v.id, active: v.active }));
  el.append(h('div.admin-page.diagram-panel',
    intro, input, notice,
    preview,
    h('section.admin-section', h('h2', { dataset: { text: 'versionsTitle' } }), list.el)));

  let state = { versions: [], canRollback: false };
  let shown = null; // the version in the preview
  const canvas = h('div.preview-canvas');
  let view = null;    // one drawing, reused by every preview

  async function load() {
    try {
      state = await getJson('/api/admin/diagrams');
      notice.textContent = '';
    } catch (err) {
      notice.textContent = err.message;
    }
    render();
  }

  function pick() { input.click(); }

  function render() {
    intro.textContent = t('admin.diagram.intro');
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.diagram.${node.dataset.text}`);
    list.render(state.versions);
    const active = state.versions.find((v) => v.active);
    ctx.setHeader(ctx.tab, {
      context: () => (active ? t('admin.diagram.context', { name: active.name, count: active.devices ?? 0 }) : t('admin.diagram.none')),
      primary: { id: 'import', label: 'admin.diagram.import', icon: 'upload', run: pick },
      actions: [{ id: 'rollback', label: 'admin.diagram.rollback', icon: 'restore', disabled: !state.canRollback, run: () => rollbackNow() }],
    });
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
        ? stateBadge('active', t('admin.diagram.active'))
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
      toast(err.message, 'error', 7000);
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
      toast(err.message, 'error', 7000);
    }
    await load();
  }

  async function rollbackNow() {
    const ok = await confirmDialog({ title: t('admin.diagram.rollbackTitle'), body: t('admin.diagram.rollbackBody'), confirmLabel: t('admin.diagram.rollback'), danger: true });
    if (!ok) return;
    try {
      await request('POST', '/api/admin/diagrams/rollback', {});
      toast(t('admin.diagram.rolledBack'));
      preview.hidden = true;
    } catch (err) {
      toast(err.message, 'error', 7000);
    }
    await load();
  }

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast(t('admin.errors.diagram_too_large'), 'error', 7000);
      return;
    }
    try {
      const result = await uploadFile(file);
      toast(t('admin.diagram.imported'));
      await load();
      await showPreview(result.version.id);
    } catch (err) {
      notice.textContent = err.message;
    }
  });

  onLocaleChange(() => { render(); if (shown && !preview.hidden) showPreview(shown.id); });
  live.on('admin:changed', ({ what }) => { if (what === 'diagrams') load(); });
  render();
  return { show: load };
}
