/**
 * "My console journals": the console sessions this user may read (the ones
 * they were on, their team's bench while the team held it, everything for an
 * admin), each downloadable as a text file. The server checks the permission
 * again on the download
 */
import { h, icon } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { t, tNode, getLocale } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';
import { errorText } from '../../shared/serverText.js';

export async function openJournalDialog() {
  const body = h('div.journal-list.modal-body', h('p.muted', tNode('consoles.journal.loading')));
  const dlg = openDialog(body, { title: t('consoles.journal.title'), wide: true });
  try {
    const { sessions: days, retentionDays } = await getJson('/api/consoles/journal');
    const intro = h('p.journal-intro', t('consoles.journal.intro', { days: retentionDays }));
    if (!days.length) {
      body.replaceChildren(intro, h('p.muted', tNode('consoles.journal.none')));
      return dlg;
    }
    body.replaceChildren(intro, h('table.journal-table',
      h('thead', h('tr', ...['day', 'time', 'bench', 'device', 'people', 'size', 'file'].map((c) => h('th', { scope: 'col' }, t(`consoles.journal.columns.${c}`))))),
      h('tbody', ...days.map((d) => h('tr',
        h('td', d.day),
        h('td', span(d.from, d.to)),
        h('td', d.bench),
        h('td', h('strong', d.device)),
        h('td', d.people.join(', ')),
        h('td', size(d.bytes), d.truncated ? h('em.journal-cut', { title: t('consoles.journal.truncatedHint') }, ` ${t('consoles.journal.truncated')}`) : null),
        h('td', h('a.btn.small', { href: `/api/consoles/journal/${d.id.split('/').map(encodeURIComponent).join('/')}`, download: '' }, icon('download'), tNode('consoles.journal.download'))))))));
  } catch (err) {
    body.replaceChildren(h('p.form-error', errorText(err)));
  }
  return dlg;
}

/** 10:02 – 11:47, or 10:02 – ongoing */
function span(from, to) {
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '');
  return `${clock(from)} – ${to ? clock(to) : t('consoles.journal.ongoing')}`;
}

function size(bytes) {
  if (bytes < 1024) return t('consoles.journal.bytes', { count: bytes });
  if (bytes < 1024 * 1024) return t('consoles.journal.kb', { count: Math.round(bytes / 1024) });
  return t('consoles.journal.mb', { count: (bytes / 1024 / 1024).toFixed(1) });
}
