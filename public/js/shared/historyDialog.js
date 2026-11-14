/**
 * "History" of a console: search what it showed and download it, as text.
 *
 * Two places are searched (server side: the /history routes of
 * src/modules/consoles/index.js):
 *   - what the room still holds, the recent output a newcomer is replayed -
 *     for the people on the console;
 *   - the journal, day by day - for the people the journal's rule lets read
 *     that day (those who were on the console, their team, the admins). When
 *     the person may not read it, the dialog says so instead of staying silent.
 * The search is plain text (case ignored unless asked), never a pattern.
 */
import { h, icon, loadCss } from '../core/dom.js';
import { getJson } from '../core/api.js';
import { t, tNode, tAttr, loadNamespace, onLocaleChange, getLocale } from '../core/i18n.js';
import { openDialog } from './dialog.js';
import { errorText } from './serverText.js';

/** `text` with the occurrences of `query` in <mark> (as DOM nodes: nothing is read as HTML) */
export function highlight(text, query, matchCase = false) {
  if (!query) return [text];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  const out = [];
  let at = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(h('mark', text.slice(i, i + needle.length)));
    at = i + needle.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export async function openHistoryDialog({ pane }) {
  await Promise.all([loadNamespace('terminal'), loadCss('terminal')]);
  const device = encodeURIComponent(pane.session.device);
  let data = null;
  let searched = { query: '', matchCase: false };
  let failure = '';

  const input = h('input.field', { type: 'search', autocomplete: 'off', spellcheck: 'false', maxlength: 200, ...tAttr('placeholder', 'terminal.history.placeholder'), ...tAttr('aria-label', 'terminal.history.placeholder') });
  const matchCase = h('input', { type: 'checkbox' });
  const go = h('button.btn.primary', { type: 'submit', dataset: { action: 'search' } }, icon('search'), tNode('terminal.history.search'));
  const live = h('section.hist-section', { dataset: { source: 'screen' } });
  const journal = h('section.hist-section', { dataset: { source: 'journal' } });
  const form = h('form.hist-form', { onsubmit: (e) => { e.preventDefault(); run(); } }, input, h('label.check', matchCase, h('span', tNode('terminal.history.matchCase'))), go);
  const dlg = openDialog(h('div.modal-body.hist',
    h('p.muted.script-hint', tNode('terminal.history.intro')),
    form,
    h('p.form-error', { role: 'alert', hidden: true }),
    live, journal), { title: t('terminal.history.title', { title: pane.session.title }), wide: true, initialFocus: input });
  const error = dlg.el.querySelector('.form-error');

  async function run() {
    const query = input.value.trim();
    searched = { query, matchCase: matchCase.checked };
    const url = `/api/consoles/history?device=${device}${query ? `&q=${encodeURIComponent(query)}` : ''}${query && matchCase.checked ? '&case=1' : ''}`;
    try {
      data = await getJson(url);
      failure = '';
    } catch (err) {
      failure = errorText(err);
    }
    render();
  }

  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '');
  const dayName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(getLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
  const download = (query, key, extra = '') => h('a.btn.small', { href: `/api/consoles/history/download?device=${device}${extra}`, download: '', dataset: { action: key } }, icon('download'), query);
  const matchesList = (found, mapMeta) => h('ol.hist-matches', found.matches.map((m) => h('li',
    h('span.hist-where', mapMeta(m)),
    h('code', highlight(m.text, searched.query, searched.matchCase)))));
  const outcome = (found) => [
    h('p.hist-count', t(found.total ? 'terminal.history.found' : 'terminal.history.nothing', { count: found.total })),
    found.truncated && found.total ? h('p.muted', t('terminal.history.truncated', { count: found.matches.length })) : null,
  ];

  function render() {
    error.hidden = !failure;
    error.textContent = failure;
    if (!data) return;
    const searching = Boolean(searched.query);

    // What the room still holds
    const l = data.live;
    live.replaceChildren(
      h('header.hist-head', h('h3', tNode('terminal.history.screen')),
        l.attached ? download(t('terminal.history.downloadScreen'), 'download-screen') : null),
      !l.attached
        ? h('p.muted', t(l.open ? 'terminal.history.notOnIt' : 'terminal.history.closed'))
        : searching
          ? h('div', ...outcome(l), l.total ? matchesList(l, (m) => t('terminal.history.line', { line: m.n })) : null)
          : h('p.muted', t('terminal.history.screenLines', { count: l.lines })));

    // The journal
    const j = data.journal;
    let body;
    if (!j.exists) body = h('p.muted', tNode('terminal.history.noJournal'));
    else if (!j.allowed) body = h('p.muted', tNode('terminal.history.journalDenied'));
    else {
      body = h('div',
        searching ? [...outcome(j), j.total ? matchesList(j, (m) => `${dayName(m.day)} ${clock(m.from)} · ${t('terminal.history.line', { line: m.n })}`) : null] : null,
        h('ul.hist-days', j.days.map((d) => h('li', h('span', `${dayName(d.day)} · ${t('terminal.history.sessions', { count: d.sessions })}`),
          download(t('terminal.history.downloadDay'), 'download-day', `&day=${d.day}`)))));
    }
    journal.replaceChildren(h('header.hist-head', h('h3', tNode('terminal.history.journal'))), body);
  }

  const offLocale = onLocaleChange(render);
  dlg.closed.then(offLocale);
  await run();
}
