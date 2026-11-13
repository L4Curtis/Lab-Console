/**
 * "Administration" section (#/admin/<tab>): one tab per screen, built with
 * shared/tabs.js. The rail shows it to administrators only; the server
 * refuses its routes to anyone else whatever the browser shows.
 *
 * Tabs of the accounts lot: users, invitations, sign-in (SSO). Another
 * screen is one file in ./tabs and one line below
 */
import { h, loadCss } from '../../core/dom.js';
import { t, tNode, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('admin', 'accounts'), loadCss('accounts')]);
  const bar = h('div.admin-tabs');
  el.append(h('header.view-head', h('div.view-title', h('h1', tNode('admin.title')), h('p', tNode('admin.subtitle'))), bar));
  const body = h('div.admin-body');
  el.append(body);

  const admin = () => session.isAdmin;
  const tabs = mountTabs(body, [
    { id: 'users', title: () => t('admin.tabs.users'), load: () => import('./tabs/users.js'), when: admin },
    { id: 'invitations', title: () => t('admin.tabs.invitations'), load: () => import('./tabs/invitations.js'), when: admin },
    { id: 'sso', title: () => t('admin.tabs.sso'), load: () => import('./tabs/sso.js'), when: admin },
  ], { navigate, base: '#/admin', label: t('admin.title'), bar });

  return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
}
