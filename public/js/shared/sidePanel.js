/**
 * Side panels (docs/v2/UX.md §7.9): En direct, Discussion, Alertes. A 360 px
 * column at the right of a section that resizes its content from 1200 px
 * (no overlay); a drawer over the content with a scrim from 720 px; a
 * full-height sheet on a phone. One panel open per host: opening another
 * closes the first
 *
 *   const host = sideHost(sectionBody);         // wraps the section's content: { el, main }
 *   const live = sidePanel(host, {
 *     title: () => t('consoles.live.title'),    // a key or a function
 *     footer: composerNode,                     // optional, sticky (a chat composer)
 *     onOpen, onClose,                          // optional
 *   });
 *   live.body.append(list);
 *   button.onclick = () => live.toggle();
 *   live.setCount(3);  live.isOpen;  live.close();
 *
 * The panel says when it opens or closes to whoever listens (`onToggle(fn)`),
 * so a toggle button keeps its aria-pressed in step. Escape closes it when
 * the focus is inside
 */
import { h, icon, loadCss } from '../core/dom.js';
import { t, onLocaleChange } from '../core/i18n.js';

let serial = 0;
const openIn = new WeakMap(); // host element → the panel open in it

/** Prepare `container` to hold side panels: its children move into `main` */
export function sideHost(container) {
  loadCss('shared');
  if (container.classList.contains('side-host')) return { el: container, main: container.querySelector(':scope > .side-main') };
  const main = h('div.side-main', [...container.childNodes]);
  const scrim = h('div.side-scrim', { hidden: true });
  container.classList.add('side-host');
  container.append(main, scrim);
  scrim.addEventListener('click', () => openIn.get(container)?.close());
  return { el: container, main };
}

export function sidePanel(host, { title, footer, onOpen, onClose } = {}) {
  const hostEl = host.el ?? host;
  const id = `side-${++serial}`;
  const text = () => (typeof title === 'function' ? title() : title ? t(title) : '');
  const heading = h('h2', { id: `${id}-title` }, text());
  const count = h('span.count', { hidden: true });
  const closeBtn = h('button.icon-btn', { type: 'button', onclick: () => api.close() }, icon('close'));
  const body = h('div.side-body');
  const foot = h('div.side-foot', footer ?? null);
  const el = h('aside.side-panel', { id, hidden: true, 'aria-labelledby': `${id}-title`, tabindex: '-1' },
    h('header.side-head', heading, count, closeBtn), body, foot);
  hostEl.append(el);
  const listeners = new Set();

  const label = () => {
    heading.textContent = text();
    closeBtn.title = t('common.actions.close');
    closeBtn.setAttribute('aria-label', t('common.actions.close'));
  };
  label();
  const stop = onLocaleChange(label);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); } });

  const scrim = () => hostEl.querySelector(':scope > .side-scrim');
  const api = {
    el, body, footer: foot, id,
    get isOpen() { return !el.hidden; },
    open() {
      if (!el.hidden) return;
      const other = openIn.get(hostEl);
      if (other && other !== api) other.close();
      openIn.set(hostEl, api);
      el.hidden = false;
      if (scrim()) scrim().hidden = false;
      el.focus({ preventScroll: true });
      onOpen?.();
      for (const fn of listeners) fn(true);
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      if (openIn.get(hostEl) === api) openIn.delete(hostEl);
      if (scrim()) scrim().hidden = true;
      onClose?.();
      for (const fn of listeners) fn(false);
    },
    toggle(force = el.hidden) { if (force) api.open(); else api.close(); },
    setCount(n) { count.hidden = !n; count.textContent = n ? String(n) : ''; },
    onToggle(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() { api.close(); stop(); el.remove(); },
  };
  return api;
}
