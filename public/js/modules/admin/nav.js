/**
 * The administration's own navigation (docs/v2/UX.md §4.3): its screens in
 * three groups, a list at the left of the page from 720 px, and on a phone the
 * hub that #/admin shows. Some entries are screens of other sections that
 * belong to the administration: Équipes (#/team/all), Machines et switchs
 * (#/infra) and État du labo (#/status)
 *
 *   const nav = adminNav({ current: 'users' });   // nav.el, nav.setCurrent(id), nav.setCounts({ users: 2 })
 *   adminHref(entry)                              // '#/admin/users', '#/infra'
 *   tabsBesideNav(header, column, el)             // the page's tabs in the content column, beside the list
 *
 * Machines et switchs and État du labo show the same list for an administrator
 * (infra/index.js, status/index.js)
 */
import { h, icon } from '../../core/dom.js';
import { t, onLocaleChange } from '../../core/i18n.js';
import { isCompact, onViewportChange } from '../../core/viewport.js';

export const ADMIN_GROUPS = [
  { id: 'accounts', entries: [{ id: 'users', tab: true }, { id: 'invitations', tab: true }, { id: 'sso', tab: true }, { id: 'teams', href: '#/team/all' }] },
  { id: 'lab', entries: [{ id: 'lab', tab: true }, { id: 'diagram', tab: true }, { id: 'switches', tab: true }, { id: 'infra', href: '#/infra' }, { id: 'status', href: '#/status' }] },
  { id: 'monitoring', entries: [{ id: 'sessions', tab: true }, { id: 'audit', tab: true }, { id: 'announcement', tab: true }] },
];

export const TAB_IDS = ADMIN_GROUPS.flatMap((g) => g.entries.filter((e) => e.tab).map((e) => e.id));

export const adminHref = (entry) => entry.href ?? `#/admin/${entry.id}`;
/** The label of an entry: a tab keeps its title, the other sections their own name */
export const entryLabel = (entry) => (entry.tab ? t(`admin.tabs.${entry.id}`) : t(`admin.nav.${entry.id}`));

export function adminNav({ current = null } = {}) {
  let at = current;
  let counts = {};
  const el = h('nav.admin-nav', { dataset: { adminNav: '' } });

  function render() {
    el.setAttribute('aria-label', t('admin.title'));
    el.replaceChildren(...ADMIN_GROUPS.map((group) => h('section.admin-group', { dataset: { group: group.id } },
      h('h2.admin-group-title', t(`admin.groups.${group.id}`)),
      h('ul', group.entries.map((entry) => {
        const n = counts[entry.id];
        return h('li', h('a.admin-link', { href: adminHref(entry), dataset: { entry: entry.id }, 'aria-current': entry.id === at ? 'page' : null },
          h('span.admin-link-label', entryLabel(entry)),
          n ? h('span.count', { dataset: n.tone ? { tone: n.tone } : {} }, String(n.count ?? n)) : null,
          icon('chevronRight')));
      })))));
  }
  render();
  onLocaleChange(render);
  return {
    el,
    setCurrent(id) { at = id; render(); },
    /** { users: 2 } or { users: { count: 2, tone: 'danger' } } */
    setCounts(next) { counts = next; render(); },
  };
}

/**
 * A screen of another section that sits in the administration (el has `admin-sub`) shows the list of the
 * administration at the left. Its own tabs then go at the top of the content column, to the right of that
 * list, so that the two navigations do not stack on the same width and the list starts where it does on
 * the other administration screens. Without the list (a phone, a student) they stay in the page header.
 * Call it again (the returned function) when `admin-sub` changes. → place()
 */
export function tabsBesideNav(header, column, el) {
  const place = () => {
    const beside = !isCompact() && el.classList.contains('admin-sub');
    header.el.classList.toggle('has-tabs', !beside);
    if (beside) column.prepend(header.tabBar);
    else header.el.append(header.tabBar);
  };
  place();
  onViewportChange(place);
  return place;
}
