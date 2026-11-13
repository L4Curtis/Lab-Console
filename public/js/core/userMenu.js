/**
 * Who is signed in, in the rail: a badge with the user's initials that opens
 * a small menu (name, role, how they signed in, My account, sign out)
 *
 *   import { mountUserMenu } from './core/userMenu.js';
 *   mountUserMenu();          // after loadSession() and initI18n()
 *
 * It goes at the bottom of the rail and adds nothing else there, so the
 * other rail items (the language switch, the theme) stay their own
 */
import { h, loadCss } from './dom.js';
import { session, signOut } from './session.js';
import { t, loadNamespace, onLocaleChange } from './i18n.js';

export async function mountUserMenu(rail = document.querySelector('.rail')) {
  const user = session.user;
  if (!rail || !user) return null;
  await Promise.all([loadNamespace('auth'), loadCss('auth')]);

  const badge = h('span.user-badge', { 'aria-hidden': 'true' }, user.initials);
  badge.style.background = user.color; // derived from the id on the server, never from user input
  const button = h('button.rail-btn.user-menu-btn', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'user-menu' }, badge);
  const name = h('strong.user-menu-name');
  const role = h('span.user-menu-role');
  const via = h('span.user-menu-via');
  const heading = h('span.user-menu-label');
  const out = h('button.btn.wide.user-menu-out', { type: 'button', onclick: () => { out.disabled = true; signOut(); } });
  const account = h('a.btn.wide.user-menu-account', { href: '#/account', onclick: () => toggle(false) });
  const menu = h('div.user-menu#user-menu', { role: 'dialog', hidden: true }, heading, name, h('div.user-menu-meta', role, via), account, out);
  const root = h('div.user-menu-root', button, menu);

  function render() {
    button.title = `${t('auth.menu.open')} · ${user.name}`;
    button.setAttribute('aria-label', button.title);
    menu.setAttribute('aria-label', t('auth.menu.open'));
    heading.textContent = t('auth.menu.signedInAs');
    name.textContent = user.name;
    role.textContent = t(`auth.menu.roles.${user.role}`);
    role.dataset.role = user.role;
    via.textContent = user.via === 'oidc' ? t('auth.menu.viaOidc', { provider: session.providerName ?? 'SSO' }) : t('auth.menu.viaLocal');
    account.textContent = t('auth.menu.account');
    out.textContent = t('auth.menu.signOut');
  }

  const isOpen = () => !menu.hidden;
  function toggle(open = !isOpen()) {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) out.focus();
  }

  button.addEventListener('click', () => toggle());
  document.addEventListener('click', (event) => { if (isOpen() && !root.contains(event.target)) toggle(false); });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      toggle(false);
      button.focus();
    }
  });

  render();
  onLocaleChange(render);
  rail.append(root);
  return { el: root, open: () => toggle(true), close: () => toggle(false) };
}
