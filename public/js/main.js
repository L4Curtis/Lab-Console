/**
 * App shell: sidebar rail, hash routing between feature modules, theme
 *
 * A section is { id, path, titleKey, icon, load: () => import(...) } where
 * the imported file exports `mount(container, ctx)` returning
 * { show?(params), hide?() }, or a promise of it. Views stay mounted when
 * hidden, so switching to another section never drops a student's open consoles.
 * `id` is the server module that serves it (/api/modules says whether it is
 * on), `path` the address (#/path). Optional: `when: () => boolean` keeps the
 * section away from those it is not for (the server checks the role anyway),
 * `rail: false` leaves it out of the rail (reached from the user menu)
 */
import { h, icon, prefs } from './core/dom.js';
import { getJson } from './core/api.js';
import { interceptDownloads } from './core/downloads.js';
import { loadSession, session } from './core/session.js';
import { initI18n, setLocale, getLocale, onLocaleChange, t, tNode } from './core/i18n.js';
import { mountUserMenu } from './core/userMenu.js';
import { mountAnnouncement } from './shared/announcement.js';
import { startCollab } from './modules/collab/index.js';
import { startRecovery } from './modules/recovery/index.js';

const MODULES = [
  // The page shown after sign-in: my team, our bench, our backups, recent activity (also the address no section answers)
  { id: 'overview', path: 'home', titleKey: 'common.shell.home', icon: 'home', load: () => import('./modules/overview/home.js') },
  { id: 'consoles', path: 'consoles', titleKey: 'common.shell.consoles', icon: 'topology', load: () => import('./modules/consoles/index.js') },
  // Every bench of the lab on one screen, live
  { id: 'overview', path: 'overview', titleKey: 'common.shell.overview', icon: 'dashboard', load: () => import('./modules/overview/index.js') },
  { id: 'teams', path: 'team', titleKey: 'common.shell.team', icon: 'team', load: () => import('./modules/teams/index.js') },
  // Backend module "proxmox" serves this section (admin switches + Proxmox VMs)
  { id: 'proxmox', path: 'infra', titleKey: 'common.shell.infra', icon: 'rack', load: () => import('./modules/infra/index.js') },
  // Administration: the accounts lot's tabs (users, invitations, SSO); the admin lot adds its own
  { id: 'accounts', path: 'admin', titleKey: 'common.shell.admin', icon: 'shield', railKey: 'common.shell.adminShort', when: () => session.isAdmin, load: () => import('./modules/admin/index.js') },
  { id: 'accounts', path: 'account', titleKey: 'common.shell.account', icon: 'user', rail: false, load: () => import('./modules/account/index.js') },
  // Backups, injection, reset of a bench; snapshots and TP templates
  { id: 'jobs', path: 'jobs', titleKey: 'common.shell.jobs', icon: 'archive', load: () => import('./modules/jobs/index.js') },
  // Lab status (health, what is journaled): everyone; the admin lot's server module answers it
  { id: 'admin', path: 'status', titleKey: 'common.shell.status', icon: 'pulse', load: () => import('./modules/status/index.js') },
  // Help page and guided tour (the tour opens by itself at the first sign-in)
  { id: 'help', path: 'help', titleKey: 'common.shell.help', icon: 'help', load: () => import('./modules/help/index.js') },
];
const available = () => MODULES.filter((m) => m.when?.() !== false);

const views = document.getElementById('views');
const rail = document.getElementById('rail-items');
const mounted = new Map(); // path → Promise<{ el, api }>
let current = null;
let routes = 0; // route() calls so far

async function init() {
  applyTheme(prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  document.getElementById('theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));

  // Who is signed in, then the language: both must be known before any screen is built
  await loadSession();
  // 'terminal' is needed as soon as the shared workspace is imported, by any section
  await initI18n({ defaultLocale: session.locale, namespaces: ['common', 'terminal'] });
  bindLanguageSwitch();
  interceptDownloads();
  document.getElementById('skip-link').addEventListener('click', (e) => { e.preventDefault(); views.focus(); });
  mountUserMenu();
  mountAnnouncement(document.querySelector('.views'));
  // Bench jobs drawn on the diagram, whichever section is on screen
  import('./modules/jobs/layer.js').then((m) => m.start()).catch(() => {});
  // Bench checks (line status, cabling, addresses) drawn on the diagram
  import('./modules/checks/layer.js').then((m) => m.start()).catch(() => {});
  await startCollab(); // notes on the diagram, notifications: needs the session and the language
  // The password recovery assistant on console tiles, and its badge on the diagram
  await startRecovery().catch((err) => console.warn(`[recovery] ${err.message}`));

  // The backend says which modules are live; disabled ones show a "soon" tag
  let status = [];
  try { status = await getJson('/api/modules'); } catch { /* render all as enabled */ }
  const inRail = available().filter((m) => m.rail !== false);
  for (const m of available()) m.enabled = status.find((s) => s.id === m.id)?.enabled ?? true;
  for (const m of inRail) {
    m.link = h(`a.rail-btn${m.enabled ? '' : '.soon'}`, { href: `#/${m.path}`, dataset: { module: m.id, path: m.path } },
      icon(m.icon), tNode(m.railKey ?? m.titleKey), m.enabled ? null : tNode('common.shell.off', 'em'));
    rail.append(m.link);
  }
  const labelRail = () => {
    for (const m of inRail) {
      const title = t(m.titleKey);
      m.link.title = m.enabled ? title : t('common.shell.turnedOff', { title });
      if (m.railKey) m.link.setAttribute('aria-label', m.link.title); // the rail shows a short label
    }
  };
  labelRail();
  onLocaleChange(labelRail);
  onLocaleChange(setPageTitle);
  addEventListener('hashchange', route);
  route();
  import('./modules/help/tour.js').then((m) => m.maybeStartTour()).catch(() => {});
}

/** The address as [section path, ...params] */
const address = () => {
  const [path, ...params] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return [path || 'home', ...params];
};

async function route() {
  const [path, ...params] = address();
  const known = available().find((m) => m.path === path);
  if (!known) history.replaceState(null, '', '#/home'); // an address that leads nowhere: say so in the bar too
  const mod = known || MODULES[0];
  for (const a of rail.querySelectorAll('.rail-btn')) a.classList.toggle('active', a.dataset.path === mod.path);

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
    prev.el.hidden = true;
    prev.api.hide?.();
  }
  view.el.hidden = false;
  const arrived = current !== null && current !== mod.path;
  current = mod.path;
  title = mod.titleKey;
  setPageTitle();
  view.api.show?.(params);
  // A screen reader hears the new section: focus goes to its heading (not on first load, nor when only the sub-address changed)
  if (arrived) {
    const heading = view.el.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
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
      h('button.btn.small', { type: 'button', dataset: { action: 'reload' }, onclick: () => location.reload() }, tNode('common.shell.reload'))));
    return { el, api: {} };
  }
}

/** Update the URL without re-running the router (for in-module state such as the selected lab) */
function navigate(hash, { replace = true } = {}) {
  if (location.hash === hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}

/** FR / EN buttons in the rail: the language follows at once, open consoles stay connected */
function bindLanguageSwitch() {
  const buttons = [...document.querySelectorAll('.lang-btn')];
  const mark = () => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.lang === getLocale())); };
  for (const b of buttons) b.addEventListener('click', () => setLocale(b.dataset.lang));
  onLocaleChange(mark);
  mark();
}

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  if (persist) prefs.set('theme', theme);
  dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

init();
