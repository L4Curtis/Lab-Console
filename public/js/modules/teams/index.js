/**
 * "Team" section: my team (create, invite, accept, leave), the bench (state,
 * requests, occupants, history), the reservation calendar, and for admins
 * every team (docs/v2/UX.md §10.2–10.5)
 *
 * Routes: #/team/mine · #/team/bench[/<bench>] · #/team/calendar[/<bench>] · #/team/all
 *
 * Each tab sets the header's context line and actions when it is shown
 * (`header` is in the context every tab receives)
 *
 * For an administrator, Toutes les équipes belongs to the administration
 * (UX.md §4.3): on that tab the page shows the Admin list at the left, or a
 * back arrow to the Admin hub on a phone, as Machines et switchs does
 */
import { h, loadCss } from '../../core/dom.js';
import { t, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { adminNav, tabsBesideNav } from '../admin/nav.js';

export async function mount(el, { navigate }) {
  const admin = session.isAdmin;
  await Promise.all([loadNamespace('teams', 'benches', 'jobs', 'ios', ...(admin ? ['admin'] : [])), loadCss('teams'), admin ? loadCss('admin') : null]);
  const header = pageHeader({ title: 'teams.title', tabs: true, back: admin ? '#/admin' : undefined });
  const body = h(`div.view-body${admin ? '.admin-content' : ''}`);
  el.append(header.el, admin ? h('div.admin-layout', adminNav({ current: 'teams' }).el, body) : body);
  const placeTabs = admin ? tabsBesideNav(header, body, el) : null;
  const tabs = mountTabs(body, [
    { id: 'mine', title: () => t('teams.tabs.mine'), load: () => import('./tabs/mine.js') },
    { id: 'bench', title: () => t('teams.tabs.bench'), load: () => import('./tabs/bench.js') },
    { id: 'calendar', title: () => t('teams.tabs.calendar'), load: () => import('./tabs/calendar.js') },
    { id: 'all', title: () => t('teams.tabs.all'), load: () => import('./tabs/all.js'), when: () => session.isAdmin },
  ], { navigate, base: '#/team', bar: header.tabBar, label: t('teams.title'), ctx: { header } });
  return {
    show: (params) => {
      if (admin) { el.classList.toggle('admin-sub', params?.[0] === 'all'); placeTabs(); }
      return tabs.show(params);
    },
    hide: () => tabs.hide(),
  };
}
