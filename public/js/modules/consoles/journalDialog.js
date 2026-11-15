/**
 * "My console journals": the console sessions this user may read (the ones
 * they were on, their team's bench while the team held it, everything for an
 * admin), each downloadable as a text file. The server checks the permission
 * again on the download. A list rather than a table, so that it reads on a phone
 */
import { h, icon } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { t, tNode } from '../../core/i18n.js';
import { fmtTime, fmtCalendarDay } from '../../core/format.js';
import { openDialog } from '../../shared/dialog.js';
import { loading, loadFailure, emptyState } from '../../shared/loadState.js';

export async function openJournalDialog() {
  const body = h('div.journal-list.modal-body', loading());
  const dlg = openDialog(body, { title: t('consoles.journal.title'), wide: true });
  try {
    const { sessions: days, retentionDays } = await getJson('/api/consoles/journal');
    const intro = h('p.journal-intro', t('consoles.journal.intro', { days: retentionDays }));
    if (!days.length) {
      body.replaceChildren(intro, emptyState({ icon: 'script', title: 'consoles.journal.noneTitle', text: 'consoles.journal.none' }));
      return dlg;
    }
    // One row per session: what and where first, when and who under it, the file at the right (a card on a phone)
    body.replaceChildren(intro, h('ul.journal-rows', { 'aria-label': t('consoles.journal.title') }, ...days.map((d) => h('li.journal-row',
      h('div.journal-main',
        h('strong', d.device), h('span.journal-bench', d.bench),
        d.truncated ? h('span.badge', { dataset: { tone: 'warning' }, title: t('consoles.journal.truncatedHint') }, t('consoles.journal.truncated')) : null),
      h('p.journal-meta', [fmtCalendarDay(d.day), span(d.from, d.to), size(d.bytes)].join(' · ')),
      d.people.length ? h('p.journal-people', d.people.join(', ')) : null,
      h('a.btn.sm.journal-download', { href: `/api/consoles/journal/${d.id.split('/').map(encodeURIComponent).join('/')}`, download: '', title: t('consoles.journal.downloadOf', { device: d.device, day: fmtCalendarDay(d.day) }) }, icon('download'), tNode('consoles.journal.download'))))));
  } catch (err) {
    body.replaceChildren(loadFailure('consoles.journal.loadFailed', err, () => { dlg.close(); openJournalDialog(); }));
  }
  return dlg;
}

/** 10:02 – 11:47, or 10:02 – ongoing */
function span(from, to) {
  const clock = (iso) => (iso ? fmtTime(iso) : '');
  return `${clock(from)} – ${to ? clock(to) : t('consoles.journal.ongoing')}`;
}

function size(bytes) {
  if (bytes < 1024) return t('consoles.journal.bytes', { count: bytes });
  if (bytes < 1024 * 1024) return t('consoles.journal.kb', { count: Math.round(bytes / 1024) });
  return t('consoles.journal.mb', { count: (bytes / 1024 / 1024).toFixed(1) });
}
