/**
 * The navigation (docs/v2/UX.md §4, §5): built once from main.js's MODULES.
 *
 *   rail (from 720 px)   main destinations, Plus (a menu), then Alertes and the account at the bottom;
 *                        collapsed to 72 px under 1200 px, collapsible above (pref labconsole.rail)
 *   tab bar (< 720 px)   exactly five items: the main destinations up to order 40, and Plus
 *   Plus                 the rail's popover menu (Machines et switchs, État du labo, Aide), or on a phone
 *                        a bottom sheet: the account, Admin, Alertes, those sections, Mon compte,
 *                        Thème, Langue, the guided tour, Se déconnecter
 *
 * A section never adds itself: it is a line of MODULES with `nav` ('main' |
 * 'plus' | 'hidden'), `order`, `icon`, `titleKey`, `navKey` (short label) and
 * `parent(params)` (the destination lit for a section reached from elsewhere).
 * Every item carries data-nav="<path>" (rail and tab bar alike, so the guided
 * tour finds whichever is on screen); rail links keep data-path.
 *
 *   setNavBadge('team', { count: 2 });            // a number (a dot on a collapsed rail)
 *   setNavBadge('consoles', { dot: true, tone: 'success' });
 *   setNavBadge('team', null);                    // gone
 *   registerPlusEntry({ id: 'alerts', icon: 'bell', label: () => …, hint: () => …, run, order: 15 });
 *   navSlot('alerts')                             // the rail's place for the bell
 */
import { h, icon, prefs } from './dom.js';
import { t, tNode, onLocaleChange } from './i18n.js';
import { openMenu } from '../shared/menu.js';
import { openDialog } from '../shared/dialog.js';

const TAB_BAR_MAX_ORDER = 40; // Admin (50) goes into Plus on a phone: four entries and Plus
const badges = new Map();     // path → { count, dot, tone }
const plusEntries = [];       // registered by other modules (the bell)
const slots = new Map();      // name → element in the rail
let modules = [];
let activeKey = null;
let railItems;
let tabbar;
let plusButtons = []; // the rail's and the tab bar's

const label = (m, short = false) => t((short && m.navKey) || m.titleKey);
const mainEntries = () => modules.filter((m) => m.nav === 'main').sort((a, b) => a.order - b.order);
const plusSections = () => modules.filter((m) => m.nav === 'plus').sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

function badgeNode(path) {
  return h('span.nav-badge', { dataset: { badge: path }, 'aria-hidden': 'true' });
}

function paintBadges() {
  for (const node of document.querySelectorAll('.nav-badge[data-badge]')) {
    let b = badges.get(node.dataset.badge);
    if (node.dataset.badge === 'plus') {
      // On a phone Plus also stands for what it holds (Admin, Alertes)
      const inside = node.closest('.tabbar')
        ? [...mainEntries().filter((m) => m.order > TAB_BAR_MAX_ORDER).map((m) => badges.get(m.path)), ...plusEntries.map((e) => badges.get(e.id))]
        : plusSections().map((m) => badges.get(m.path));
      if (!b && inside.some(Boolean)) b = { dot: true, tone: inside.find(Boolean).tone };
    }
    const show = b && (b.count || b.dot);
    if (show) {
      node.dataset.show = b.count ? String(b.count) : '';
      node.textContent = b.count ? String(b.count) : '';
      if (b.tone) node.dataset.tone = b.tone; else delete node.dataset.tone;
    } else {
      delete node.dataset.show;
      node.textContent = '';
    }
  }
  labelItems();
}

/** Accessible names and tooltips: the full title, and what a badge says */
function labelItems() {
  for (const el of document.querySelectorAll('.rail-btn[data-nav], .tab-item[data-nav]')) {
    const m = modules.find((x) => x.path === el.dataset.nav);
    const name = el.dataset.nav === 'plus' ? t('common.plus.label') : m ? label(m) : null;
    if (!name) continue;
    const b = badges.get(el.dataset.nav);
    const extra = b?.count ? ` (${t('common.nav.badge', { count: b.count })})` : '';
    const off = m && m.enabled === false ? t('common.shell.turnedOff', { title: name }) : name;
    el.title = off + extra;
    el.setAttribute('aria-label', off + extra);
  }
}

export function setNavBadge(path, badge) {
  if (badge && (badge.count || badge.dot)) badges.set(path, badge);
  else badges.delete(path);
  paintBadges();
}

export function registerPlusEntry(entry) {
  plusEntries.push(entry);
  plusEntries.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return () => { plusEntries.splice(plusEntries.indexOf(entry), 1); };
}

export const navSlot = (name) => slots.get(name) ?? null;

/**
 * Light the destination `key` (a main path, 'plus' or 'account-menu'). A
 * destination the tab bar does not hold (Admin, Mon compte on a phone) lights Plus there
 */
export function setActiveNav(key) {
  activeKey = key;
  for (const bar of [railItems?.closest('.rail'), tabbar]) {
    if (!bar) continue;
    const items = [...bar.querySelectorAll('.rail-btn[data-nav], .tab-item[data-nav]')];
    const lit = items.some((el) => el.dataset.nav === key) ? key : key ? 'plus' : null;
    for (const el of items) {
      const on = el.dataset.nav === lit;
      el.classList.toggle('active', on);
      if (el.tagName === 'A') {
        if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      }
    }
  }
}

function railLink(m) {
  return h(`a.rail-btn${m.enabled === false ? '.soon' : ''}`, { href: `#/${m.path}`, dataset: { nav: m.path, path: m.path, module: m.id } },
    icon(m.icon), h('span.rail-label', tNode(m.navKey ?? m.titleKey)), badgeNode(m.path),
    m.enabled === false ? tNode('common.shell.off', 'em') : null);
}

function tabLink(m) {
  return h('a.tab-item', { href: `#/${m.path}`, dataset: { nav: m.path } },
    h('span.tab-pill', icon(m.icon), badgeNode(m.path)), h('span.rail-label', tNode(m.navKey ?? m.titleKey)));
}

/** The rail's Plus: a popover of the sections that are not main destinations */
function openPlusMenu(button) {
  const items = plusSections().filter((m) => m.desktopMenu !== false).map((m) => ({ id: m.path, label: m.titleKey, icon: m.icon, href: `#/${m.path}` }));
  openMenu(button, items, { label: t('common.plus.label'), side: 'right', sheet: false });
}

/** A row of the Plus sheet: an icon, a label, a hint or a count, a chevron */
function sheetRow({ nav, icon: name, text, hint, trail, href, run, cls = '' }) {
  const content = [icon(name), h('span.menu-label', text, hint ? h('span.menu-hint', hint) : null), h('span.menu-trail', trail ?? null, icon('chevronRight'))];
  const attrs = { dataset: nav ? { nav } : {} };
  return href ? h(`a.menu-item${cls}`, { ...attrs, href, onclick: run }, content) : h(`button.menu-item${cls}`, { ...attrs, type: 'button', onclick: run }, content);
}

/** The Plus sheet (phone): everything that is not in the tab bar */
export async function openPlusSheet(anchor) {
  const { accountHeader, preferenceRows, tourButton, signOutButton } = await import('./userMenu.js');
  let dlg = null;
  let release;
  const until = new Promise((resolve) => { release = resolve; });
  // Leave for another screen once the sheet (and its history entry) is gone
  const go = (href) => async (e) => {
    e.preventDefault();
    dlg.close();
    await dlg.closed;
    location.hash = href;
  };
  const count = (path) => (badges.get(path)?.count ? h('span.count', String(badges.get(path).count)) : null);
  const admin = mainEntries().filter((m) => m.order > TAB_BAR_MAX_ORDER);
  const rows = [
    ...admin.map((m) => sheetRow({ nav: m.path, icon: m.icon, text: label(m, true), trail: count(m.path), href: `#/${m.path}`, run: go(`#/${m.path}`) })),
    ...plusEntries.map((e) => {
      const row = sheetRow({ nav: e.id, icon: e.icon, text: e.label(), hint: e.hint?.(), trail: count(e.id), run: async () => {
        await e.run();
        const hint = row.querySelector('.menu-hint');
        if (hint) hint.textContent = e.hint?.() ?? '';
      } });
      return row;
    }),
    ...plusSections().map((m) => sheetRow({ nav: m.path, icon: m.icon, text: label(m), href: `#/${m.path}`, run: go(`#/${m.path}`) })),
  ];
  const body = h('div.plus-sheet.sheet-menu',
    accountHeader({ until }),
    h('nav.plus-rows', { 'aria-label': t('common.plus.label') }, rows),
    h('div.plus-prefs', preferenceRows({ until })),
    h('div.plus-rows.plus-end', tourButton(() => dlg.close()), signOutButton()));
  anchor?.setAttribute('aria-expanded', 'true');
  dlg = openDialog(body, { label: t('common.plus.label'), size: 'md' });
  dlg.closed.then(() => { release(); anchor?.setAttribute('aria-expanded', 'false'); });
  return dlg;
}

function collapseButton() {
  const button = h('button.icon-btn.rail-collapse', { type: 'button', onclick: () => {
    const next = document.documentElement.dataset.rail === 'collapsed' ? 'expanded' : 'collapsed';
    document.documentElement.dataset.rail = next;
    prefs.set('rail', next);
    name();
  } }, icon('collapse'));
  const name = () => {
    const collapsed = document.documentElement.dataset.rail === 'collapsed';
    button.title = t(collapsed ? 'common.nav.expand' : 'common.nav.collapse');
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', String(!collapsed));
  };
  name();
  onLocaleChange(name);
  return button;
}

/**
 * Build the rail and the tab bar. `list` is MODULES, already filtered for
 * this person, each with `enabled` (from /api/modules)
 */
export function buildNav(list) {
  modules = list;
  document.documentElement.dataset.rail = prefs.get('rail', 'expanded') === 'collapsed' ? 'collapsed' : 'expanded';
  railItems = document.getElementById('rail-items');
  tabbar = document.getElementById('tabbar');
  const foot = document.getElementById('rail-foot');
  document.querySelector('.rail-top')?.append(collapseButton());

  const railPlus = h('button.rail-btn.plus-btn', { type: 'button', dataset: { nav: 'plus' }, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openPlusMenu(railPlus) },
    icon('more'), h('span.rail-label', tNode('common.plus.label')), badgeNode('plus'));
  railItems.replaceChildren(...mainEntries().map(railLink), railPlus);

  const tabPlus = h('button.tab-item.plus-btn', { type: 'button', dataset: { nav: 'plus' }, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => openPlusSheet(tabPlus) },
    h('span.tab-pill', icon('more'), badgeNode('plus')), h('span.rail-label', tNode('common.plus.label')));
  tabbar.replaceChildren(...mainEntries().filter((m) => m.order <= TAB_BAR_MAX_ORDER).map(tabLink), tabPlus);
  plusButtons = [railPlus, tabPlus];

  const alerts = h('div.rail-slot', { dataset: { slot: 'alerts' } });
  const account = h('div.rail-slot', { dataset: { slot: 'account' } });
  foot.replaceChildren(alerts, account);
  slots.set('alerts', alerts);
  slots.set('account', account);

  onLocaleChange(labelItems);
  paintBadges();
  if (activeKey) setActiveNav(activeKey);
  return { plusButtons };
}

/** Which destination to light for module `m` reached with `params` */
export function navKeyFor(m, params = []) {
  if (!m) return null;
  const parent = typeof m.parent === 'function' ? m.parent(params) : m.parent;
  if (parent) return parent;
  if (m.nav === 'main') return m.path;
  if (m.nav === 'plus') return 'plus';
  return null;
}
