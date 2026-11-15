/**
 * "Modèles de TP" tab: the configurations everyone may inject; admins publish
 * them, import a ZIP, and choose the base applied after a reset
 */
import { h, icon } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { dataList } from '../../shared/dataList.js';

/** ctx: { detail(), templates(), isAdmin, act: { view, inject, setBase, remove, create, importZip }, importInput } → { el, render() } */
export function createTemplates(ctx) {
  const list = dataList({
    label: () => t('jobs.templates.title'),
    columns: [
      { id: 'name', label: 'jobs.templates.name', cell: (x) => h('span.jobs-name', h('strong', x.name), x.base ? h('span.badge', { dataset: { tone: 'info' } }, t('jobs.templates.baseBadge')) : null), primary: true },
      { id: 'description', label: 'jobs.templates.description', cell: (x) => x.description || '—', meta: true },
      { id: 'devices', label: 'jobs.snapshots.col.devices', cell: (x) => x.devices.map((d) => (d.device === '*' ? t('jobs.templates.every') : d.device)).join(', '), meta: true },
    ],
    actions: (x) => {
      const may = ctx.detail()?.canOperate;
      return [
        may ? { id: 'inject', label: 'jobs.snapshots.inject', icon: 'upload', primary: true, run: () => ctx.act.inject(x) } : { id: 'view', label: 'jobs.snapshots.view', icon: 'search', primary: true, run: () => ctx.act.view(x) },
        may ? { id: 'view', label: 'jobs.snapshots.view', icon: 'search', run: () => ctx.act.view(x) } : null,
        ctx.isAdmin ? { id: 'base', label: x.base ? 'jobs.templates.unsetBase' : 'jobs.templates.setBase', icon: 'check', run: () => ctx.act.setBase(x, !x.base) } : null,
        ctx.isAdmin ? { id: 'delete', label: 'jobs.templates.delete', icon: 'trash', danger: true, run: () => ctx.act.remove(x) } : null,
      ];
    },
    empty: { icon: 'script', title: 'jobs.templates.noneTitle', text: 'jobs.templates.none' },
    rowKey: (x) => x.name,
  });
  const toolbar = ctx.isAdmin ? h('div.jobs-toolbar.jobs-toolbar-end',
    h('button.btn', { type: 'button', dataset: { action: 'import-template' }, onclick: () => ctx.importInput.click() }, icon('upload'), t('jobs.templates.import')),
    h('button.btn.primary', { type: 'button', dataset: { action: 'new-template' }, onclick: () => ctx.act.create() }, icon('plus'), t('jobs.templates.new')),
    ctx.importInput) : null;
  const el = h('div.jobs-templates', toolbar, list.el);
  return { el, render() { list.render(ctx.templates()); }, destroy() { list.destroy(); } };
}
