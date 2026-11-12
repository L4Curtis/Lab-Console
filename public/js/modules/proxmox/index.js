/**
 * "Virtual machines" section - reserved for Proxmox VE management
 * It is wired into the shell (sidebar, routing, keep-alive views) so the real
 * implementation only has to replace this mount() function
 */
import { h, icon } from '../../core/dom.js';
import { tNode, loadNamespace } from '../../core/i18n.js';

export async function mount(el) {
  await loadNamespace('infra');
  el.append(
    h('header.view-head', h('div.view-title', h('h1', tNode('infra.placeholder.title')), h('p', tNode('infra.placeholder.subtitle')))),
    h('div.placeholder',
      icon('vm', 'placeholder-icon'),
      h('h2', tNode('infra.placeholder.heading')),
      h('p', tNode('infra.placeholder.text')),
      h('p.placeholder-note', tNode('infra.placeholder.note'))));
  return {};
}
