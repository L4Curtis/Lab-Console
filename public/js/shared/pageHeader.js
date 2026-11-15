/**
 * The header of a section (docs/v2/UX.md §5.4, §7.12): title, a context line,
 * secondary actions, one primary action. From 720 px: a 72 px band, the
 * primary at the right, two secondary actions as buttons and the rest in ⋯.
 * On a phone: a 56 px app bar (back arrow, title, up to two icon actions,
 * ⋯ with every secondary action), the context line under it, and the
 * primary as a full-width button
 *
 *   const header = pageHeader({
 *     title: 'jobs.title',                                   // key (or function): the page's <h1>
 *     context: () => t('jobs.context', { bench }),           // optional line; a function is asked again on a language change
 *     primary: { id: 'backup', label: 'jobs.actions.backup', icon: 'download', run: backup },
 *     actions: [{ id: 'inject', label: 'jobs.actions.inject', icon: 'upload', run, danger?, disabled?, bar? }],
 *     back: '#/admin',                                       // optional: a back arrow (phone sub-pages)
 *     tabs: true,                                            // optional: header.tabBar is the `bar` of mountTabs()
 *     full: false,                                           // true: no 1280 px limit (Consoles)
 *   });
 *   section.append(header.el, h('div.view-body', …));
 *   header.update({ context, primary, actions });            // any of them
 *   header.setBadge('alerts', 3);                            // a count on an action's icon
 *
 * An action with `bar: true` (two at most) stays visible on a phone as an
 * icon in the app bar; every other secondary action goes into ⋯ there.
 * The section scrolls inside its .view-body, so the header never moves
 */
import { h, icon } from '../core/dom.js';
import { t, onLocaleChange } from '../core/i18n.js';
import { moreButton } from './menu.js';

const text = (v) => (typeof v === 'function' ? v() : v ? t(v) : '');
const MAX_BUTTONS = 2;

export function pageHeader({ title, context, primary, actions = [], back, tabs = false, full = false } = {}) {
  const heading = h('h1');
  const contextLine = h('p.ph-context');
  const titleRow = h('div.ph-title', heading);
  const actionsBox = h('div.ph-actions');
  const primarySlot = h('div.ph-primary-slot');
  const backLink = back ? h('a.icon-btn.ph-back', { href: back }, icon('back')) : null;
  const tabBar = tabs ? h('div.ph-tabs') : null;
  const el = h(`header.page-header${full ? '.full' : ''}${back ? '.has-back' : ''}${tabs ? '.has-tabs' : ''}`,
    backLink, titleRow, contextLine, actionsBox, primarySlot, tabBar);
  const state = { title, context, primary, actions };
  const badges = new Map(); // action id → count

  const actionButton = (a, cls) => h(`button.btn${cls}${a.danger ? '.danger' : ''}`, {
    type: 'button', disabled: a.disabled ? true : null, dataset: { action: a.id }, onclick: () => a.run?.(),
  }, a.icon ? icon(a.icon) : null, text(a.label));

  function render() {
    heading.textContent = text(state.title);
    contextLine.replaceChildren(typeof state.context === 'function' ? state.context() ?? '' : state.context ? t(state.context) : '');
    if (backLink) {
      backLink.title = t('common.nav.back');
      backLink.setAttribute('aria-label', t('common.nav.back'));
    }
    const list = (state.actions ?? []).filter(Boolean);
    const wide = list.slice(0, MAX_BUTTONS);
    const overflowWide = list.slice(MAX_BUTTONS);
    const onBar = list.filter((a) => a.bar && a.icon).slice(0, 2);
    const overflowPhone = list.filter((a) => !onBar.includes(a));
    const nodes = [];
    // From 720 px: two buttons, the rest in ⋯ (a ⋯ of its own on a phone, with everything not on the bar)
    for (const a of wide) nodes.push(actionButton(a, '.ph-secondary'));
    if (overflowWide.length) {
      const more = moreButton(() => overflowWide.map(menuItem), { onSelect: run });
      more.classList.add('ph-secondary');
      nodes.push(more);
    }
    if (state.primary) nodes.push(actionButton(state.primary, '.primary.ph-primary'));
    for (const a of onBar) {
      const b = h('button.icon-btn.ph-icon-action', { type: 'button', title: text(a.label), 'aria-label': text(a.label), dataset: { action: a.id }, disabled: a.disabled ? true : null, onclick: () => a.run?.() }, icon(a.icon));
      const n = badges.get(a.id);
      if (n) b.append(h('span.count', { 'aria-hidden': 'true' }, String(n)));
      nodes.push(b);
    }
    if (overflowPhone.length) {
      const more = moreButton(() => overflowPhone.map(menuItem), { onSelect: run });
      more.classList.add('ph-icon-action');
      nodes.push(more);
    }
    actionsBox.replaceChildren(...nodes);
    primarySlot.replaceChildren(state.primary ? actionButton(state.primary, '.primary.lg.block') : '');
    primarySlot.hidden = !state.primary;
  }
  const menuItem = (a) => ({ id: a.id, label: a.label, icon: a.icon, danger: a.danger, disabled: a.disabled, hint: a.hint });
  const run = (id) => (state.actions ?? []).find((a) => a?.id === id)?.run?.();

  render();
  const stop = onLocaleChange(render);
  return {
    el,
    tabBar,
    heading,
    update(next = {}) { Object.assign(state, next); render(); },
    setBadge(id, n) { badges.set(id, n); render(); },
    destroy() { stop(); el.remove(); },
  };
}
