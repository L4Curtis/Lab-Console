/**
 * App shell: the navigation, hash routing between feature modules, the theme
 * (docs/v2/UX.md §4, §5)
 *
 * A section is a line of MODULES: { id, path, titleKey, icon, nav, order,
 * load: () => import(...) } where the imported file exports
 * `mount(container, ctx)` returning { show?(params), hide?() }, or a promise
 * of it. Views stay mounted when hidden, so switching to another section
 * never drops a student's open consoles.
 * `id` is the server module that serves it (/api/modules says whether it is
 * on), `path` the address (#/path) and the section's class (view-<path>).
 * Navigation (core/nav.js reads these; a section never adds itself):
 *   nav: 'main'    a destination of the rail and of the phone's tab bar (`order`: above 40 goes into Plus on a phone)
 *   nav: 'plus'    reached from Plus (the rail's menu, the phone's sheet); `desktopMenu: false` keeps it out of the rail's menu
 *   nav: 'hidden'  reached from links only
 *   navKey         the short label of the rail and the tab bar; `parent(params)` the destination lit when it is on screen
 *   when: () => boolean keeps a section away from those it is not for (the server checks the role anyway)
 */
import { h, loadCss } from './core/dom.js';
import { getJson } from './core/api.js';
import { interceptDownloads } from './core/downloads.js';
import { loadSession, session } from './core/session.js';
import { initI18n, onLocaleChange, t, tNode } from './core/i18n.js';
import { initTheme } from './core/theme.js';
import { startViewport, isCompact } from './core/viewport.js';
import { routeRedirect, hashParts } from './core/routes.js';
import { buildNav, setActiveNav, navKeyFor, navSlot } from './core/nav.js';
import { mountUserMenu } from './core/userMenu.js';
import { mountAnnouncement } from './shared/announcement.js';
import { startCollab } from './modules/collab/index.js';
import { startRecovery } from './modules/recovery/index.js';

const isAdmin = () => session.isAdmin;
/** Machines et switchs, État du labo: part of the administration for an administrator, of Plus for a student */
const adminOrPlus = () => (session.isAdmin ? 'admin' : 'plus');

const MODULES = [
  // The page shown after sign-in: my team, our bench, our backups, recent activity (also the address no section answers)
  { id: 'overview', path: 'home', titleKey: 'common.shell.home', icon: 'home', nav: 'main', order: 10, load: () => import('./modules/overview/home.js') },
  { id: 'consoles', path: 'consoles', titleKey: 'common.shell.consoles', icon: 'topology', nav: 'main', order: 20, load: () => import('./modules/consoles/index.js') },
  { id: 'teams', path: 'team', titleKey: 'common.shell.team', icon: 'team', nav: 'main', order: 30, parent: ([tab]) => (tab === 'all' && session.isAdmin ? 'admin' : 'team'), load: () => import('./modules/teams/index.js') },
  // Backups, injection, reset of a bench; snapshots and TP templates
  { id: 'jobs', path: 'jobs', titleKey: 'common.shell.jobs', icon: 'archive', nav: 'main', order: 40, load: () => import('./modules/jobs/index.js') },
  // Administration: the accounts lot's tabs (users, invitations, SSO); the admin lot adds its own
  { id: 'accounts', path: 'admin', titleKey: 'common.shell.admin', navKey: 'common.shell.adminShort', icon: 'shield', nav: 'main', order: 50, when: isAdmin, load: () => import('./modules/admin/index.js') },
  // Backend module "proxmox" serves this section (admin switches + Proxmox VMs)
  { id: 'proxmox', path: 'infra', titleKey: 'common.shell.infra', icon: 'rack', nav: 'plus', order: 60, parent: adminOrPlus, load: () => import('./modules/infra/index.js') },
  // Lab status (health, what is journaled): everyone; the admin lot's server module answers it
  { id: 'admin', path: 'status', titleKey: 'common.shell.status', icon: 'pulse', nav: 'plus', order: 70, parent: adminOrPlus, load: () => import('./modules/status/index.js') },
  // Help page and guided tour (the tour opens by itself at the first sign-in)
  { id: 'help', path: 'help', titleKey: 'common.shell.help', icon: 'help', nav: 'plus', order: 80, load: () => import('./modules/help/index.js') },
  // My account: the account menu on a PC, the Plus sheet on a phone
  { id: 'accounts', path: 'account', titleKey: 'common.shell.account', icon: 'user', nav: 'plus', order: 90, desktopMenu: false, parent: () => 'account-menu', load: () => import('./modules/account/index.js') },
  // Every bench of the lab on one screen. Becomes "Le labo" on the home page (part C); until then it stays, out of the navigation,
  // and its old address keeps leading here instead of to #/home/lab
  { id: 'overview', path: 'overview', titleKey: 'common.shell.overview', icon: 'dashboard', nav: 'hidden', parent: () => 'home', load: () => import('./modules/overview/index.js') },
];
const available = () => MODULES.filter((m) => m.when?.() !== false);

const views = document.getElementById('views');
const mounted = new Map(); // path → Promise<{ el, api }>
const scrolls = new Map(); // path → [[element, scrollTop, scrollLeft]] while the section is hidden
let current = null;
let routes = 0; // route() calls so far
let routed = null; // the address last routed, without a sheet's marker
let announcement = null;

async function init() {
  initTheme();
  startViewport();
  // Who is signed in, then the language: both must be known before any screen is built
  await loadSession();
  // 'terminal' is needed as soon as the shared workspace is imported, by any section
  await initI18n({ defaultLocale: session.locale, namespaces: ['common', 'terminal'] });
  await loadCss('shared'); // menus, sheets, tabs, lists: the shell uses them too
  interceptDownloads();
  document.getElementById('skip-link').addEventListener('click', (e) => { e.preventDefault(); views.focus(); });

  // The backend says which modules are live; disabled ones show a "soon" tag
  let status = [];
  try { status = await getJson('/api/modules'); } catch { /* render all as enabled */ }
  for (const m of available()) m.enabled = status.find((s) => s.id === m.id)?.enabled ?? true;
  buildNav(available());
  await mountUserMenu(navSlot('account'));

  announcement = mountAnnouncement(views);
  // Bench jobs drawn on the diagram, whichever section is on screen
  import('./modules/jobs/layer.js').then((m) => m.start()).catch(() => {});
  // Bench checks (line status, cabling, addresses) drawn on the diagram
  import('./modules/checks/layer.js').then((m) => m.start()).catch(() => {});
  await startCollab(); // notes on the diagram, notifications: needs the session and the language
  // The password recovery assistant on console tiles, and its badge on the diagram
  await startRecovery().catch((err) => console.warn(`[recovery] ${err.message}`));

  onLocaleChange(setPageTitle);
  addEventListener('hashchange', route);
  route();
  import('./modules/help/tour.js').then((m) => m.maybeStartTour()).catch(() => {});
}

/** The address as [section path, ...params] (an open sheet's marker is not part of it) */
const address = () => {
  const [path, ...params] = hashParts(location.hash).map(decodeURIComponent);
  return [path || 'home', ...params];
};
const screenOf = (hash) => hashParts(hash).join('/');

/** Old addresses (UX.md §4.2) become the new ones, without an extra history entry */
function redirect() {
  const target = routeRedirect(location.hash, { isAdmin: session.isAdmin, compact: isCompact() });
  if (!target) return;
  // A section that still answers its old address keeps it until it is retired (the overview, part C)
  if (available().some((m) => m.path === hashParts(location.hash)[0] && m.nav === 'hidden')) return;
  history.replaceState(history.state, '', target);
}

async function route() {
  redirect();
  const screen = screenOf(location.hash);
  if (screen === routed && current) return; // only a sheet's history entry came or went
  routed = screen;
  const [path, ...params] = address();
  const known = available().find((m) => m.path === path);
  if (!known) history.replaceState(null, '', '#/home'); // an address that leads nowhere: say so in the bar too
  const mod = known || MODULES[0];
  setActiveNav(navKeyFor(mod, known ? params : []));

  // The promise is stored at once: an address change while a section is
  // still loading must not mount it a second time
  if (!mounted.has(mod.path)) mounted.set(mod.path, mountSection(mod));
  const ticket = ++routes;
  const view = await mounted.get(mod.path);
  if (ticket !== routes) { // a later address change wins
    if (current !== mod.path) view.el.hidden = true;
    return;
  }
  if (current && current !== mod.path) {
    const prev = await mounted.get(current);
    keepScroll(current, prev.el);
    prev.el.hidden = true;
    prev.api.hide?.();
  }
  view.el.hidden = false;
  const arrived = current !== null && current !== mod.path;
  if (arrived || current === null) {
    restoreScroll(mod.path);
    announcement?.place(view.el);
  }
  current = mod.path;
  title = mod.titleKey;
  setPageTitle();
  view.api.show?.(known ? params : []);
  // A screen reader hears the new section: focus goes to its heading (not on first load, nor when only the sub-address changed)
  if (arrived) {
    const heading = view.el.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
}

/** A hidden section loses its scroll positions (display: none): note them, and put them back on return */
function keepScroll(path, el) {
  const kept = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.classList.contains('xterm') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.scrollTop || n.scrollLeft) kept.push([n, n.scrollTop, n.scrollLeft]);
  scrolls.set(path, kept);
}
function restoreScroll(path) {
  for (const [n, top, left] of scrolls.get(path) ?? []) if (n.isConnected) { n.scrollTop = top; n.scrollLeft = left; }
  scrolls.delete(path);
}

let title = null;
function setPageTitle() {
  if (title) document.title = `${t(title)} · ${t('common.shell.appTitle')}`;
}

async function mountSection(mod) {
  const el = h(`section.view.view-${mod.path}`); // visible while it mounts: the diagram measures itself
  views.append(el);
  try {
    const { mount } = await mod.load();
    // A section rewrites the address only while it is the one asked for: a late call (its data
    // came back after the user went elsewhere) must not take the address back from the new section
    const own = (hash, options) => { if (address()[0] === mod.path) navigate(hash, options); };
    return { el, api: (await mount(el, { enabled: mod.enabled, navigate: own })) || {} }; // mount may be async
  } catch (err) {
    // Typically a tab opened before a release: its scripts are no longer served under the old
    // build id (src/lib/assets.js), and only a reload brings the new ones
    console.error(`[${mod.path}] ${err?.message ?? err}`);
    el.replaceChildren(h('div.load-failure', { role: 'alert' },
      h('p', tNode('common.shell.loadFailed')),
      h('button.btn.sm', { type: 'button', dataset: { action: 'reload' }, onclick: () => location.reload() }, tNode('common.shell.reload'))));
    return { el, api: {} };
  }
}

/** Update the URL without re-running the router (for in-module state such as the selected lab) */
function navigate(hash, { replace = true } = {}) {
  if (location.hash === hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  routed = screenOf(hash);
  const mod = available().find((m) => m.path === hashParts(hash)[0]);
  if (mod) setActiveNav(navKeyFor(mod, hashParts(hash).slice(1)));
}

init();
