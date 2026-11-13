/**
 * Administration › Sessions: everyone signed in right now, on which browser,
 * since when. Ending a session signs that browser out at once: its consoles
 * and live streams close with it. "End all" does it for every browser of
 * that person.
 */
import { h, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { confirmDialog } from '../../../shared/dialog.js';
import { formatDate, errorText } from '../common.js';

/** A short name for a browser, from its user agent */
function browserOf(ua = '') {
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [name, os].filter(Boolean).join(' · ') || ua.slice(0, 40) || '—';
}

export function mount(el) {
  const tbody = h('tbody');
  const notice = h('p.form-error', { role: 'alert' });
  const count = h('span.muted');
  const intro = h('p.muted.panel-intro');
  el.append(h('div.panel', intro, h('div.panel-toolbar', count), notice,
    h('div.table-wrap', h('table.vm-table.sessions-table',
      h('thead', h('tr', ['user', 'browser', 'ip', 'since', 'lastSeen', 'actions'].map((c) => h('th', { dataset: { col: c } })))),
      tbody))));

  let sessions = [];
  let visible = false;

  async function load() {
    try {
      ({ sessions } = await getJson('/api/admin/sessions'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = errorText(err);
    }
    render();
  }

  async function end(s) {
    const own = s.current;
    const ok = await confirmDialog({
      title: t('admin.sessions.endTitle'),
      body: own ? t('admin.sessions.endOwn') : t('admin.sessions.endBody', { name: s.user.name || s.user.username }),
      confirmLabel: t('admin.sessions.end'),
      danger: true,
    });
    if (!ok) return;
    try {
      await request('DELETE', `/api/admin/sessions/${encodeURIComponent(s.id)}`);
      toast(t('admin.sessions.ended'));
    } catch (err) {
      toast(errorText(err), 'error');
    }
    await load();
  }

  async function endAll(s) {
    const ok = await confirmDialog({ title: t('admin.sessions.endAllTitle'), body: t('admin.sessions.endAllBody', { name: s.user.name || s.user.username }), confirmLabel: t('admin.sessions.endAll'), danger: true });
    if (!ok) return;
    try {
      const { count: n } = await request('POST', '/api/admin/sessions/revoke-user', { userId: s.user.id });
      toast(t('admin.sessions.endedAll', { count: n }));
    } catch (err) {
      toast(errorText(err), 'error');
    }
    await load();
  }

  function row(s) {
    const role = t(`auth.menu.roles.${s.user.role}`);
    return h('tr', { dataset: { session: s.id, user: s.user.id } },
      h('td', h('div.account-cell', h('strong', s.user.name || s.user.username), h('span.vm-meta', `${s.user.username} · ${role}`),
        s.current ? h('div.account-notes', h('span.badge', t('admin.sessions.thisOne'))) : null)),
      h('td', browserOf(s.userAgent), s.connections ? h('span.vm-meta', ` · ${t('admin.sessions.sockets', { count: s.connections })}`) : null),
      h('td.mono', s.ip ?? '—'),
      h('td', formatDate(s.createdAt)),
      h('td', formatDate(s.lastSeenAt)),
      h('td.right', h('div.row-actions.end',
        h('button.btn.small.danger', { type: 'button', dataset: { action: 'end' }, onclick: () => end(s) }, t('admin.sessions.end')),
        h('button.btn.small', { type: 'button', dataset: { action: 'end-all' }, onclick: () => endAll(s) }, t('admin.sessions.endAll')))));
  }

  function render() {
    intro.textContent = t('admin.sessions.intro');
    for (const th of el.querySelectorAll('th[data-col]')) th.textContent = th.dataset.col === 'actions' ? '' : t(`admin.sessions.columns.${th.dataset.col}`);
    count.textContent = t('admin.sessions.count', { count: sessions.length });
    tbody.replaceChildren(...(sessions.length ? sessions.map(row) : [h('tr', h('td.empty-row', { colspan: 6 }, t('admin.sessions.none')))]));
  }

  onLocaleChange(render);
  live.on('admin:changed', ({ what }) => { if (visible && what === 'sessions') load(); });
  return {
    show() { visible = true; load(); },
    hide() { visible = false; },
  };
}
