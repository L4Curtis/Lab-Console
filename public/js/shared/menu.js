/**
 * Menus (docs/v2/UX.md §7.8): every ⋯ button, the rail's Plus, a bench's
 * tools. A popover anchored to its button from 720 px, a bottom sheet of
 * 52 px rows below
 *
 *   const id = await openMenu(button, [
 *     { group: 'jobs.menu.more' },                       // a heading (a key, or a function)
 *     { id: 'inject', label: 'jobs.actions.inject', icon: 'upload' },
 *     'separator',
 *     { id: 'reset', label: 'jobs.actions.reset', icon: 'refresh', danger: true, hint: 'jobs.hints.reset' },
 *     { id: 'wall', label: 'consoles.wall', disabled: true, hint: () => t('…', { why }) },
 *     { id: 'dark', label: 'common.theme.dark', checked: true },
 *   ], { label: t('common.menu.more') });
 *   // → the chosen item's id, or null (Escape, a click elsewhere)
 *
 *   el.append(moreButton(() => items, { label, onSelect: (id) => … }));   // the ⋯ icon button
 *
 * A label, a hint or a group is a dictionary key or a function returning the
 * text (never HTML). An item may also carry `run()`: it is called after the
 * menu closed, with the same result. An item with `href` is a link
 * Keyboard: arrows, Home / End, a letter jumps to the next item starting
 * with it, Enter / Space choose, Escape and Tab close; the focus returns to
 * the button
 */
import { h, icon, loadCss } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { isCompact } from '../core/viewport.js';
import { openDialog } from './dialog.js';

let serial = 0;
const text = (v) => (typeof v === 'function' ? v() : v ? t(v) : '');

function buildItems(items, choose) {
  const nodes = [];
  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator') { nodes.push(h('li.menu-sep', { role: 'separator' })); continue; }
    if (item.group) { nodes.push(h('li.menu-group', { role: 'presentation' }, text(item.group))); continue; }
    const hint = item.hint ? text(item.hint) : '';
    const attrs = {
      role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
      tabindex: '-1',
      'aria-disabled': item.disabled ? 'true' : null,
      'aria-checked': item.checked === undefined ? null : String(Boolean(item.checked)),
      title: item.disabled && hint ? hint : null,
      dataset: { id: item.id },
    };
    const content = [
      item.icon ? icon(item.icon) : null,
      h('span.menu-label', text(item.label), hint ? h('span.menu-hint', hint) : null),
      item.checked ? icon('check', 'menu-check') : null,
      item.trail ? h('span.menu-trail', item.trail) : null,
    ];
    const el = item.href
      ? h(`a.menu-item${item.danger ? '.danger' : ''}`, { ...attrs, href: item.href }, content)
      : h(`button.menu-item${item.danger ? '.danger' : ''}`, { ...attrs, type: 'button' }, content);
    el.addEventListener('click', (e) => {
      if (item.disabled) { e.preventDefault(); return; }
      choose(item);
    });
    buttons.push(el);
    nodes.push(h('li', { role: 'none' }, el));
  }
  return { nodes, buttons };
}

/** Arrow keys, Home/End and type-ahead over `buttons`; Escape / Tab call close() */
function keyboard(container, buttons, close) {
  container.addEventListener('keydown', (e) => {
    const at = buttons.indexOf(document.activeElement);
    const move = (to) => { e.preventDefault(); buttons[(to + buttons.length) % buttons.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at < 0 ? buttons.length - 1 : at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(buttons.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const letter = e.key.toLocaleLowerCase();
      for (let i = 1; i <= buttons.length; i++) {
        const b = buttons[(at + i) % buttons.length];
        if (b.textContent.trim().toLocaleLowerCase().startsWith(letter)) { b.focus(); break; }
      }
    }
  });
}

/** Put the popover next to `anchor`, flipped so that it stays on screen */
function place(pop, anchor, { side = 'below' } = {}) {
  const a = anchor.getBoundingClientRect();
  const m = pop.getBoundingClientRect();
  const gap = 4;
  const vw = innerWidth;
  const vh = innerHeight;
  let left;
  let top;
  if (side === 'right') {
    left = a.right + gap;
    if (left + m.width > vw - 8) left = Math.max(8, a.left - m.width - gap);
    top = Math.min(a.top, vh - m.height - 8);
  } else {
    left = Math.min(a.right - m.width, vw - m.width - 8);
    if (left < 8) left = Math.min(a.left, vw - m.width - 8);
    top = a.bottom + gap;
    if (top + m.height > vh - 8) top = a.top - m.height - gap; // flip above
  }
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

/**
 * Open a menu of `items` for `anchor`; → Promise of the chosen id, or null.
 * Options: label (accessible name; required in practice), side ('below' or
 * 'right', for the rail), sheet (true / false: force a presentation)
 */
export function openMenu(anchor, items, { label, side, sheet = isCompact() } = {}) {
  loadCss('shared');
  const id = `menu-${++serial}`;
  return new Promise((resolve) => {
    let done = false;
    let chosen = null;
    const finish = () => {
      if (done) return;
      done = true;
      anchor?.setAttribute?.('aria-expanded', 'false');
      resolve(chosen?.id ?? null);
      chosen?.run?.();
    };

    if (sheet) {
      let dlg = null;
      const { nodes, buttons } = buildItems(items, (item) => { chosen = item; dlg.close(); });
      const list = h('ul.menu-list', { role: 'menu', id, 'aria-label': label }, nodes);
      dlg = openDialog(h('div.sheet-menu', list), { label, size: 'sm', initialFocus: buttons[0] });
      keyboard(list, buttons, () => dlg.close());
      anchor?.setAttribute?.('aria-expanded', 'true');
      dlg.closed.then(finish);
      return;
    }

    // The popover lives in the top layer, inside the open dialog if there is one (the rest of the page is inert then)
    const host = anchor?.closest?.('dialog[open]') ?? document.body;
    const close = () => {
      if (done) return;
      document.removeEventListener('pointerdown', outside, true);
      removeEventListener('resize', close);
      try { pop.hidePopover?.(); } catch { /* already hidden */ }
      pop.remove();
      if (anchor?.isConnected && (!chosen || !chosen.href)) anchor.focus();
      finish();
    };
    const { nodes, buttons } = buildItems(items, (item) => { chosen = item; close(); });
    const list = h('ul.menu-list', { role: 'menu', id, 'aria-label': label }, nodes);
    const pop = h('div.menu-pop', list);
    if ('popover' in pop) pop.popover = 'manual';
    host.append(pop);
    pop.showPopover?.();
    place(pop, anchor, { side });
    keyboard(pop, buttons, close);
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    document.addEventListener('pointerdown', outside, true);
    addEventListener('resize', close);
    anchor?.setAttribute?.('aria-haspopup', 'menu');
    anchor?.setAttribute?.('aria-expanded', 'true');
    anchor?.setAttribute?.('aria-controls', id);
    (buttons.find((b) => b.getAttribute('aria-disabled') !== 'true') ?? buttons[0])?.focus();
  });
}

/**
 * The ⋯ icon button. `items` is an array or a function returning one (asked
 * on every click, so it follows the current state). → the button
 */
export function moreButton(items, { label = () => t('common.menu.more'), onSelect, cls = '' } = {}) {
  const name = () => (typeof label === 'function' ? label() : label);
  const button = h(`button.icon-btn.more-btn${cls}`, { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
  const labelIt = () => { button.title = name(); button.setAttribute('aria-label', name()); };
  labelIt();
  button.addEventListener('click', async () => {
    labelIt();
    const list = typeof items === 'function' ? items() : items;
    const id = await openMenu(button, list, { label: name() });
    if (id !== null) onSelect?.(id);
  });
  return button;
}
