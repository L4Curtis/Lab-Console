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
import { dataList } from '../../../shared/dataList.js';
import { tagRows } from '../common.js';
import { fmtLong } from '../../../core/format.js';

/** A short name for a browser, from its user agent */
function browserOf(ua = '') {
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [name, os].filter(Boolean).join(' · ') || ua.slice(0, 40) || '—';
}

export function mount(el, ctx) {
  const notice = h('p.form-error', { role: 'alert' });
  const intro = h('p.muted.panel-intro');
  const list = dataList({
    label: () => t('admin.sessions.title'),
    dense: true,
    rowKey: (s) => s.id,
    columns: [
      {
        id: 'user', label: () => t('admin.sessions.columns.user'), primary: true,
        cell: (s) => h('div.account-cell', h('strong', s.user.name || s.user.username), h('span.vm-meta', `${s.user.username} · ${t(`auth.menu.roles.${s.user.role}`)}`),
          s.current ? h('div.account-notes', h('span.badge', { dataset: { tone: 'info' } }, t('admin.sessions.thisOne'))) : null),
      },
      { id: 'browser', label: () => t('admin.sessions.columns.browser'), cell: (s) => [browserOf(s.userAgent), s.connections ? ` · ${t('admin.sessions.sockets', { count: s.connections })}` : ''].join(''), meta: true },
      { id: 'ip', label: () => t('admin.sessions.columns.ip'), cell: (s) => h('span.mono', s.ip ?? '—'), hideCompact: true },
      { id: 'since', label: () => t('admin.sessions.columns.since'), cell: (s) => fmtLong(s.createdAt), hideCompact: true },
      { id: 'lastSeen', label: () => t('admin.sessions.columns.lastSeen'), cell: (s) => t('admin.sessions.seen', { date: fmtLong(s.lastSeenAt) }), meta: true },
    ],
    actions: (s) => [
      { id: 'end', label: 'admin.sessions.end', icon: 'close', danger: true, run: () => end(s) },
      { id: 'end-all', label: 'admin.sessions.endAll', icon: 'logout', run: () => endAll(s) },
    ],
    empty: { icon: 'user', title: 'admin.sessions.none' },
  });
  tagRows(list, (s) => ({ session: s.id, user: s.user.id }));
  el.append(h('div.admin-page', intro, notice, list.el));

  let sessions = [];
  let visible = false;

  async function load() {
    try {
      ({ sessions } = await getJson('/api/admin/sessions'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = err.message;
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
      toast(err.message, 'error');
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
      toast(err.message, 'error');
    }
    await load();
  }

  function render() {
    intro.textContent = t('admin.sessions.intro');
    list.render(sessions);
    ctx.setHeader(ctx.tab, { context: () => t('admin.sessions.count', { count: sessions.length }) });
  }

  onLocaleChange(render);
  live.on('admin:changed', ({ what }) => { if (visible && what === 'sessions') load(); });
  render();
  return {
    show() { visible = true; load(); },
    hide() { visible = false; },
  };
}
