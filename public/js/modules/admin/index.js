/**
 * "Administration" section (#/admin/<tab>): one tab per screen, built with
 * shared/tabs.js. The rail shows it to administrators only; the server
 * refuses its routes to anyone else whatever the browser shows.
 *
 * Tabs of the accounts lot: users, invitations, sign-in (SSO). Tabs of the
 * admin lot: lab parameters, diagram, admin switches, sessions, audit trail,
 * announcement. Another screen is one file in ./tabs and one line below
 */
import { h, loadCss } from '../../core/dom.js';
import { t, tNode, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('admin', 'accounts', 'consoles'), loadCss('accounts'), loadCss('admin')]);
  const bar = h('div.admin-tabs');
  el.append(h('header.view-head', h('div.view-title', h('h1', tNode('admin.title')), h('p', tNode('admin.subtitle'))), bar));
  const body = h('div.admin-body');
  el.append(body);

  const admin = () => session.isAdmin;
  const tabs = mountTabs(body, [
    { id: 'users', title: () => t('admin.tabs.users'), load: () => import('./tabs/users.js'), when: admin },
    { id: 'invitations', title: () => t('admin.tabs.invitations'), load: () => import('./tabs/invitations.js'), when: admin },
    { id: 'sso', title: () => t('admin.tabs.sso'), load: () => import('./tabs/sso.js'), when: admin },
    { id: 'lab', title: () => t('admin.tabs.lab'), load: () => import('./tabs/lab.js'), when: admin },
    { id: 'diagram', title: () => t('admin.tabs.diagram'), load: () => import('./tabs/diagram.js'), when: admin },
    { id: 'switches', title: () => t('admin.tabs.switches'), load: () => import('./tabs/switches.js'), when: admin },
    { id: 'sessions', title: () => t('admin.tabs.sessions'), load: () => import('./tabs/sessions.js'), when: admin },
    { id: 'audit', title: () => t('admin.tabs.audit'), load: () => import('./tabs/audit.js'), when: admin },
    { id: 'announcement', title: () => t('admin.tabs.announcement'), load: () => import('./tabs/announcement.js'), when: admin },
  ], { navigate, base: '#/admin', label: t('admin.title'), bar });

  return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
}
