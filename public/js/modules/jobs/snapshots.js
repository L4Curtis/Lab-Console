/**
 * "Sauvegardes" tab: the team's snapshots as a list (a table from 720 px,
 * cards below), with the ZIP at hand and the rest in ⋯, and a search across
 * their configurations (a field on a PC, a sheet from the app bar on a phone)
 */
import { h, icon } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { dataList } from '../../shared/dataList.js';
import { fmtShort } from '../../core/format.js';
import { benchApi, download } from './text.js';

export const snapshotName = (s) => s.label || t(`jobs.origin.${s.origin}`);
export const snapshotChoice = (s) => `${fmtShort(s.createdAt)} · ${s.bench} · ${snapshotName(s)}`;

/** The lines a search found, as a list (text only) */
export function hitsView(res, q) {
  return h('div.jobs-hits',
    h('p.card-meta', t('jobs.snapshots.hits', { count: res.hits.length, q })),
    h('ul', res.hits.map((x) => h('li', h('span.card-meta', `${fmtShort(x.createdAt)} · ${x.bench} · ${x.device}:${x.line}`), ' ', h('code', x.text)))));
}

/**
 * ctx: { bench(), detail(), snapshots(), isAdmin, act: { view, diff, compare, inject, publish, remove, search(q) } }
 * → { el, render(), searchOut }
 */
export function createSnapshots(ctx) {
  const box = h('input.field', { type: 'search', placeholder: t('jobs.snapshots.searchPlaceholder'), 'aria-label': t('jobs.snapshots.search'), minlength: 2, maxlength: 100 });
  const out = h('div.jobs-search', { hidden: true });
  const form = h('form.jobs-search-form', { onsubmit: async (e) => {
    e.preventDefault();
    const q = box.value.trim();
    if (q.length < 2) { out.hidden = true; return; }
    const res = await ctx.act.search(q);
    if (!res) return;
    out.hidden = false;
    out.replaceChildren(hitsView(res, q));
  } }, box, h('button.btn', { type: 'submit' }, icon('search'), t('jobs.snapshots.search')));

  const list = dataList({
    label: () => t('jobs.snapshots.title'),
    columns: [
      { id: 'name', label: 'jobs.snapshots.col.label', cell: (s) => h('span.jobs-name', h('strong', snapshotName(s)), ctx.isAdmin && s.teamName ? h('span.card-meta', s.teamName) : null), primary: true },
      { id: 'date', label: 'jobs.snapshots.col.date', cell: (s) => fmtShort(s.createdAt), meta: true },
      { id: 'devices', label: 'jobs.snapshots.col.devices', cell: (s) => h('span', { title: s.devices.map((d) => d.device).join(', ') }, t('jobs.snapshots.devices', { count: s.devices.length })), meta: true },
      { id: 'by', label: 'jobs.snapshots.col.by', cell: (s) => s.author.name, hideCompact: true },
    ],
    actions: (s) => {
      const may = ctx.detail()?.canOperate;
      return [
        { id: 'zip', label: 'jobs.snapshots.zip', icon: 'download', primary: true, run: () => download(`/api/jobs/snapshots/${encodeURIComponent(s.id)}/zip`) },
        { id: 'view', label: 'jobs.snapshots.view', icon: 'search', run: () => ctx.act.view(s) },
        may ? { id: 'compare', label: 'jobs.snapshots.live', icon: 'columns', run: () => ctx.act.compare(s) } : null,
        may ? { id: 'inject', label: 'jobs.snapshots.inject', icon: 'upload', run: () => ctx.act.inject(s) } : null,
        ctx.snapshots().length > 1 ? { id: 'diff', label: 'jobs.snapshots.diff', icon: 'columns', run: () => ctx.act.diff(s) } : null,
        s.bench === ctx.bench() ? { id: 'folder', label: 'jobs.snapshots.folder', icon: 'archive', run: () => download(`${benchApi(ctx.bench(), '/folder')}?snapshot=${encodeURIComponent(s.id)}`) } : null,
        ctx.isAdmin ? { id: 'publish', label: 'jobs.snapshots.publish', icon: 'script', run: () => ctx.act.publish(s) } : null,
        { id: 'delete', label: 'jobs.snapshots.delete', icon: 'trash', danger: true, run: () => ctx.act.remove(s) },
      ];
    },
    empty: { icon: 'archive', title: 'jobs.snapshots.noneTitle', text: 'jobs.snapshots.none' },
    rowKey: (s) => s.id,
  });

  const el = h('div.jobs-snapshots', h('div.jobs-toolbar', form), h('p.card-meta.jobs-not-backup', t('jobs.snapshots.notBackup')), out, list.el);
  return {
    el,
    render() { list.render(ctx.snapshots()); },
    destroy() { list.destroy(); },
  };
}
