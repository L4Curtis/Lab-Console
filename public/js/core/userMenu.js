/**
 * Who is signed in, and their preferences (docs/v2/UX.md §5.2, §5.3): the
 * account button at the bottom of the rail opens a popover with the name,
 * the role and how they signed in, Mon compte, Thème (Clair / Sombre / Auto),
 * Langue (FR / EN), the guided tour and Se déconnecter. On a phone the same
 * pieces are in the Plus sheet (core/nav.js)
 *
 *   import { mountUserMenu } from './core/userMenu.js';
 *   mountUserMenu(navSlot('account'));     // after loadSession(), initI18n() and buildNav()
 *
 * The pieces (accountHeader, preferenceRows, tourButton, signOutButton) follow
 * the language; a piece built for a sheet is given `until` (a promise: the
 * sheet closed) and stops listening then
 */
import { h, icon } from './dom.js';
import { session, signOut } from './session.js';
import { t, tNode, loadNamespace, onLocaleChange, setLocale, getLocale, LOCALES } from './i18n.js';
import { setTheme, themePref, THEMES } from './theme.js';

const THEME_ICONS = { light: 'sun', dark: 'moon', auto: 'auto' };

function avatar(user, cls = '') {
  const el = h(`span.avatar${cls}`, { 'aria-hidden': 'true' }, user.initials);
  el.style.background = user.color; // derived from the id on the server, never from user input
  return el;
}

/** Name, role · how they signed in */
export function accountHeader({ until } = {}) {
  const user = session.user;
  const name = h('strong.user-menu-name');
  const role = h('span.user-menu-role');
  const via = h('span.user-menu-via');
  const heading = h('span.user-menu-label.sr-only');
  const render = () => {
    heading.textContent = t('auth.menu.signedInAs');
    name.textContent = user.name;
    role.textContent = t(`auth.menu.roles.${user.role}`);
    role.dataset.role = user.role;
    via.textContent = user.via === 'oidc' ? t('auth.menu.viaOidc', { provider: session.providerName ?? 'SSO' }) : t('auth.menu.viaLocal');
  };
  render();
  const stop = onLocaleChange(render);
  until?.then(stop);
  return h('div.account-head', avatar(user, '.md'), h('div.account-who', heading, name, h('div.user-menu-meta', role, h('span', { 'aria-hidden': 'true' }, ' · '), via)));
}

/** Thème and Langue as segmented controls; the change applies at once (open consoles stay connected) */
export function preferenceRows({ until } = {}) {
  const themeButtons = THEMES.map((id) => h('button.seg-btn', { type: 'button', role: 'radio', dataset: { themeChoice: id }, onclick: () => { setTheme(id); mark(); } },
    icon(THEME_ICONS[id]), tNode(`common.theme.${id}`)));
  const langButtons = LOCALES.map((lang) => h('button.seg-btn.lang-btn', { type: 'button', lang, dataset: { lang }, onclick: () => setLocale(lang) }, lang.toUpperCase()));
  const themeLabel = tNode('common.theme.label');
  const langLabel = tNode('common.shell.language.label');
  themeLabel.id = `pref-theme-${Math.random().toString(36).slice(2, 8)}`;
  langLabel.id = `${themeLabel.id}-lang`;
  const theme = h('div.seg.fill', { role: 'radiogroup', 'aria-labelledby': themeLabel.id }, themeButtons);
  const language = h('div.seg.fill', { role: 'group', 'aria-labelledby': langLabel.id }, langButtons);
  function mark() {
    for (const b of themeButtons) b.setAttribute('aria-checked', String(b.dataset.themeChoice === themePref()));
    for (const b of langButtons) {
      b.setAttribute('aria-pressed', String(b.dataset.lang === getLocale()));
      b.title = t(`common.shell.language.${b.dataset.lang}`);
    }
  }
  mark();
  const stop = onLocaleChange(mark);
  addEventListener('themechange', mark);
  until?.then(() => { stop(); removeEventListener('themechange', mark); });
  return [h('div.pref-row', themeLabel, theme), h('div.pref-row', langLabel, language)];
}

export function tourButton(before) {
  return h('button.menu-item.user-menu-tour', { type: 'button', dataset: { action: 'replay-tour' }, onclick: () => {
    before?.();
    import('../modules/help/tour.js').then((m) => m.startTour());
  } }, icon('tour'), h('span.menu-label', tNode('help.menu.tour')));
}

export function signOutButton() {
  const out = h('button.menu-item.danger.user-menu-out', { type: 'button', onclick: () => { out.disabled = true; signOut(); } }, icon('logout'), h('span.menu-label', tNode('auth.menu.signOut')));
  return out;
}

export async function mountUserMenu(slot = document.getElementById('rail-foot')) {
  const user = session.user;
  if (!slot || !user) return null;
  await loadNamespace('auth', 'help');

  const name = h('span.rail-label');
  const button = h('button.rail-btn.user-menu-btn', { type: 'button', dataset: { nav: 'account-menu' }, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'user-menu' }, avatar(user), name);
  const account = h('a.menu-item.user-menu-account', { href: '#/account', onclick: () => toggle(false) }, icon('user'), h('span.menu-label', tNode('auth.menu.account')));
  const menu = h('div.user-menu.menu-pop#user-menu', { role: 'dialog', hidden: true },
    accountHeader(),
    h('div.menu-sep'),
    account,
    h('div.menu-sep'),
    h('div.plus-prefs', preferenceRows()),
    h('div.menu-sep'),
    tourButton(() => toggle(false)),
    signOutButton());
  const root = h('div.user-menu-root', button, menu);

  function render() {
    name.textContent = user.name;
    button.title = `${t('auth.menu.open')} · ${user.name}`;
    button.setAttribute('aria-label', button.title);
    menu.setAttribute('aria-label', t('auth.menu.open'));
  }

  const isOpen = () => !menu.hidden;
  function place() {
    const r = button.getBoundingClientRect();
    menu.style.left = `${Math.round(r.right + 8)}px`;
    menu.style.bottom = `${Math.max(8, Math.round(innerHeight - r.bottom))}px`;
    menu.style.top = 'auto';
  }
  function toggle(open = !isOpen()) {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      place();
      menu.querySelector('a, button')?.focus();
    }
  }

  button.addEventListener('click', () => toggle());
  document.addEventListener('click', (event) => { if (isOpen() && !root.contains(event.target)) toggle(false); });
  addEventListener('resize', () => { if (isOpen()) toggle(false); });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.stopPropagation(); // the menu's Escape, not the page's (the guided tour ends on Escape)
      toggle(false);
      button.focus();
    }
  });

  render();
  onLocaleChange(render);
  slot.append(root);
  return { el: root, open: () => toggle(true), close: () => toggle(false) };
}
