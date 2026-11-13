/**
 * "Team" section: my team (create, invite, accept, leave), the reservation
 * calendar, and for admins every team
 *
 * Routes: #/team/mine · #/team/calendar/<bench> · #/team/all
 */
import { h, loadCss } from '../../core/dom.js';
import { t, tNode, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('teams', 'benches'), loadCss('teams')]);
  const bar = h('div.team-tabs');
  el.append(h('header.view-head', h('div.view-title', h('h1', tNode('teams.title')), h('p', tNode('teams.subtitle'))), bar));
  const body = h('div.team-view');
  el.append(body);
  const tabs = mountTabs(body, [
    { id: 'mine', title: () => t('teams.tabs.mine'), load: () => import('./tabs/mine.js') },
    { id: 'calendar', title: () => t('teams.tabs.calendar'), load: () => import('./tabs/calendar.js') },
    { id: 'all', title: () => t('teams.tabs.all'), load: () => import('./tabs/all.js'), when: () => session.isAdmin },
  ], { navigate, base: '#/team', bar, label: t('teams.title') });
  return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
}
