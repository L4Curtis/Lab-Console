/**
 * App shell: sidebar rail, hash routing between feature modules, theme
 *
 * A module is { id, path, title, icon, load: () => import(...) } where the
 * imported file exports `mount(container, ctx)` returning
 * { show?(params), hide?() }, or a promise of it. Views stay mounted when
 * hidden, so switching to another section never drops a student's open consoles
 */
import { h, icon, prefs } from './core/dom.js';
import { getJson } from './core/api.js';
import { loadSession } from './core/session.js';
import { initI18n, setLocale, getLocale, onLocaleChange, t, tNode } from './core/i18n.js';
import { mountUserMenu } from './core/userMenu.js';

const MODULES = [
  { id: 'consoles', path: 'consoles', titleKey: 'common.shell.consoles', icon: 'topology', load: () => import('./modules/consoles/index.js') },
  { id: 'teams', path: 'team', titleKey: 'common.shell.team', icon: 'team', load: () => import('./modules/teams/index.js') },
  // Backend module "proxmox" serves this section (admin switches + Proxmox VMs)
  { id: 'proxmox', path: 'infra', titleKey: 'common.shell.infra', icon: 'rack', load: () => import('./modules/infra/index.js') },
];

const views = document.getElementById('views');
const rail = document.getElementById('rail-items');
const mounted = new Map(); // id → Promise<{ el, api }>
let current = null;
let routes = 0; // route() calls so far

async function init() {
  applyTheme(prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  document.getElementById('theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));

  // Who is signed in, then the language: both must be known before any screen is built
  const session = await loadSession();
  // 'terminal' is needed as soon as the shared workspace is imported, by any section
  await initI18n({ defaultLocale: session.locale, namespaces: ['common', 'terminal'] });
  bindLanguageSwitch();
  mountUserMenu();

  // The backend says which modules are live; disabled ones show a "soon" tag
  let status = [];
  try { status = await getJson('/api/modules'); } catch { /* render all as enabled */ }
  for (const m of MODULES) {
    m.enabled = status.find((s) => s.id === m.id)?.enabled ?? true;
    m.link = h(`a.rail-btn${m.enabled ? '' : '.soon'}`, { href: `#/${m.path}`, dataset: { module: m.id } },
      icon(m.icon), tNode(m.titleKey), m.enabled ? null : tNode('common.shell.off', 'em'));
    rail.append(m.link);
  }
  const labelRail = () => {
    for (const m of MODULES) {
      const title = t(m.titleKey);
      m.link.title = m.enabled ? title : t('common.shell.turnedOff', { title });
    }
  };
  labelRail();
  onLocaleChange(labelRail);
  addEventListener('hashchange', route);
  route();
}

async function route() {
  const [path = 'consoles', ...params] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const mod = MODULES.find((m) => m.path === path) || MODULES[0];
  for (const a of rail.querySelectorAll('.rail-btn')) a.classList.toggle('active', a.dataset.module === mod.id);

  // The promise is stored at once: an address change while a section is
  // still loading must not mount it a second time
  if (!mounted.has(mod.id)) mounted.set(mod.id, mountSection(mod));
  const ticket = ++routes;
  const view = await mounted.get(mod.id);
  if (ticket !== routes) { // a later address change wins
    if (current !== mod.id) view.el.hidden = true;
    return;
  }
  if (current && current !== mod.id) {
    const prev = await mounted.get(current);
    prev.el.hidden = true;
    prev.api.hide?.();
  }
  view.el.hidden = false;
  current = mod.id;
  view.api.show?.(params);
}

async function mountSection(mod) {
  const el = h(`section.view.view-${mod.id}`); // visible while it mounts: the diagram measures itself
  views.append(el);
  const { mount } = await mod.load();
  return { el, api: (await mount(el, { enabled: mod.enabled, navigate })) || {} }; // mount may be async
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
