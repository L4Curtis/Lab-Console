/**
 * What a section shows while its data is coming, when it could not come, and
 * when there is nothing to show (docs/v2/UX.md §7.6): the same blocks
 * everywhere, so that a failed load is never a blank page
 *
 *   loading()                          skeleton rows after 300 ms (nothing before: no flash), a status for screen readers
 *   loadFailure(whatKey, err, retry)   what failed, why (the server's or the network's reason), and a "Réessayer" button
 *   emptyState({ icon, title, text, action: { label, run, icon? } })
 *                                      a 40 px icon, a title, one sentence and one primary action;
 *                                      title / text / label are dictionary keys or functions
 */
import { h, icon as iconNode } from '../core/dom.js';
import { t, tNode } from '../core/i18n.js';
import { errorText } from './serverText.js';

const SKELETON_DELAY_MS = 300;

export function loading({ rows = 3 } = {}) {
  const el = h('div.skeleton.load-state', { role: 'status', 'aria-busy': 'true', dataset: { ready: 'false' } },
    h('span.sr-only', tNode('common.loading')),
    Array.from({ length: rows }, () => h('div.skeleton-bar', { 'aria-hidden': 'true' })));
  setTimeout(() => { el.dataset.ready = 'true'; }, SKELETON_DELAY_MS);
  return el;
}

export function loadFailure(whatKey, err, retry) {
  return h('div.load-failure', { role: 'alert' },
    h('p', tNode(whatKey), ' ', errorText(err)),
    retry ? h('button.btn.sm', { type: 'button', dataset: { action: 'retry' }, onclick: retry }, tNode('common.actions.retry')) : null);
}

const text = (v) => (typeof v === 'function' ? v() : v ? t(v) : '');

export function emptyState({ icon = 'info', title, text: sentence, action } = {}) {
  return h('div.empty-state',
    iconNode(icon),
    title ? h('h3', text(title)) : null,
    sentence ? h('p', text(sentence)) : null,
    action ? h('button.btn.primary', { type: 'button', dataset: { action: 'empty' }, onclick: action.run }, action.icon ? iconNode(action.icon) : null, text(action.label)) : null);
}
