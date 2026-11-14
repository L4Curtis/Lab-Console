/**
 * What a section shows while its data is coming and when it could not come:
 * the same two blocks everywhere, so that a failed load is never a blank page
 *
 *   loading()                          "Chargement…", a status for screen readers
 *   loadFailure(whatKey, err, retry)   what failed, why (the server's or the network's reason), and a "Réessayer" button
 */
import { h } from '../core/dom.js';
import { tNode } from '../core/i18n.js';
import { errorText } from './serverText.js';

export const loading = () => h('p.load-state.muted', { role: 'status' }, tNode('common.loading'));

export function loadFailure(whatKey, err, retry) {
  return h('div.load-failure', { role: 'alert' },
    h('p', tNode(whatKey), ' ', errorText(err)),
    retry ? h('button.btn.small', { type: 'button', dataset: { action: 'retry' }, onclick: retry }, tNode('common.actions.retry')) : null);
}
