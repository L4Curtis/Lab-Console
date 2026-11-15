/**
 * "Admin" (#/admin/<tab>): the administration, for administrators (the server
 * refuses its routes to anyone else whatever the browser shows)
 *
 * From 720 px a list of the screens at the left (nav.js, three groups) and the
 * screen at the right; on a phone #/admin is the hub, the same list as rows
 * with counts, and a screen opens full height with ← to the hub. The header is
 * the page's: each screen says what its title, its context line and its
 * primary action are through `ctx.setHeader(ctx.tab, { context, primary,
 * actions })`, and the one on screen is shown.
 *
 * Tabs of the accounts lot: users, invitations, sso. Tabs of the admin lot:
 * lab, diagram, switches, sessions, audit, announcement. Another screen is one
 * file in ./tabs, one line below and one entry in nav.js. A tab's `show(params)`
 * receives what follows its name in the address
 */
import { h, loadCss } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { t, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { isCompact, onViewportChange } from '../../core/viewport.js';
import { mountTabs } from '../../shared/tabs.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { setNavBadge } from '../../core/nav.js';
import { adminNav, TAB_IDS } from './nav.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('admin', 'accounts', 'consoles'), loadCss('accounts'), loadCss('admin')]);
  el.classList.add('admin-area');

  const meta = new Map(); // tab → { context, primary, actions } the tab asked for
  let current = null;     // the tab on screen, null for the hub
  let visible = false;

  const header = pageHeader({ title: () => t(current ? `admin.tabs.${current}` : 'admin.title'), back: '#/admin' });
  const nav = adminNav();
  const content = h('div.view-body.admin-content');
  el.append(header.el, h('div.admin-layout', nav.el, content));

  function apply() {
    const m = (current && meta.get(current)) || {};
    el.dataset.mode = current ? 'tab' : 'hub';
    header.el.classList.toggle('has-back', Boolean(current)); // the hub has nowhere to go back to
    nav.setCurrent(current);
    header.update({
      context: m.context ?? (current ? undefined : () => t('admin.subtitle')),
      primary: m.primary ?? null,
      actions: m.actions ?? [],
    });
  }

  const ctx = {
    /** A tab's say on the page header (kept until it changes it; applied while the tab is on screen) */
    setHeader(tab, partial) {
      meta.set(tab, { ...meta.get(tab), ...partial });
      if (tab === current && visible) apply();
    },
  };

  const admin = () => session.isAdmin;
  const loaders = {
    users: () => import('./tabs/users.js'),
    invitations: () => import('./tabs/invitations.js'),
    sso: () => import('./tabs/sso.js'),
    lab: () => import('./tabs/lab.js'),
    diagram: () => import('./tabs/diagram.js'),
    switches: () => import('./tabs/switches.js'),
    sessions: () => import('./tabs/sessions.js'),
    audit: () => import('./tabs/audit.js'),
    announcement: () => import('./tabs/announcement.js'),
  };
  const tabs = mountTabs(content, TAB_IDS.map((id) => ({ id, title: () => t(`admin.tabs.${id}`), when: admin, load: loaders[id] })), { navigate, base: '#/admin', label: t('admin.title'), bar: h('div', { hidden: true }), ctx });

  /** The hub's counts: accounts waiting, invitations open, sessions */
  async function readCounts() {
    const [users, invitations, sessions] = await Promise.allSettled([
      getJson('/api/accounts/users'), getJson('/api/accounts/invitations'), getJson('/api/admin/sessions'),
    ]);
    const counts = {};
    if (users.status === 'fulfilled') {
      const pending = users.value.users.filter((u) => u.state === 'pending').length;
      if (pending) counts.users = { count: pending, tone: 'danger' };
      setNavBadge('admin', pending ? { count: pending, tone: 'danger' } : null);
    }
    if (invitations.status === 'fulfilled') {
      const open = invitations.value.invitations.filter((i) => i.state === 'active').length;
      if (open) counts.invitations = open;
    }
    if (sessions.status === 'fulfilled' && sessions.value.sessions.length) counts.sessions = sessions.value.sessions.length;
    nav.setCounts(counts);
  }

  function showScreen(params = []) {
    const [id] = params;
    current = TAB_IDS.includes(id) ? id : (isCompact() ? null : 'users');
    apply();
    if (current) tabs.show(current === id ? params : [current]);
    else {
      tabs.hide();
      readCounts();
    }
  }
  let last = [];
  live.on('accounts:changed', () => { if (visible && !current) readCounts(); });
  // Crossing 720 px changes what #/admin is (the hub, or its first screen)
  let wasCompact = isCompact();
  onViewportChange((now) => {
    if (now.compact === wasCompact) return;
    wasCompact = now.compact;
    if (visible && !TAB_IDS.includes(last[0])) showScreen(last);
  });

  return {
    show(params = []) {
      visible = true;
      last = params;
      showScreen(params);
    },
    hide() {
      visible = false;
      tabs.hide();
    },
  };
}
