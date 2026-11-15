/** "Tâches" tab: the bench's recent jobs, each with its report */
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { dataList } from '../../shared/dataList.js';
import { fmtShort } from '../../core/format.js';
import { kindText, stateBadge } from './text.js';

const SHOWN = 15;

/** ctx: { history(), act: { report } } → { el, render() } */
export function createRuns(ctx) {
  const list = dataList({
    label: () => t('jobs.history.title'),
    columns: [
      { id: 'job', label: 'jobs.history.col.job', cell: (job) => h('span.jobs-name', h('strong', kindText(job.kind)), h('span.card-meta', t('jobs.history.by', { name: job.actor?.name ?? '', count: job.devices.length }))), primary: true },
      { id: 'date', label: 'jobs.snapshots.col.date', cell: (job) => fmtShort(job.createdAt), meta: true },
      { id: 'state', label: 'jobs.history.col.state', cell: (job) => stateBadge(job.state), badge: true },
    ],
    actions: () => [{ id: 'report', label: 'jobs.current.report', primary: true, run: (job) => ctx.act.report(job) }],
    empty: { icon: 'history', title: 'jobs.history.noneTitle', text: 'jobs.history.none' },
    rowKey: (job) => job.id,
  });
  return { el: h('div.jobs-runs', list.el), render() { list.render(ctx.history().slice(0, SHOWN)); }, destroy() { list.destroy(); } };
}
