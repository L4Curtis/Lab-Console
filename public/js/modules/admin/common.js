/**
 * Small pieces shared by the accounts screens (administration tabs and My account)
 *
 *   showLink({ title, intro, url, expiresAt })   the one time a link's token is shown, with a copy button
 *   columnHeads(name, cols)                       the th of a table, named by name(col) (the actions column gets a hidden name)
 *   labelColumns(el, name)                        the same names again, after a language change
 */
import { h, icon, toast } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { fmtLong } from '../../core/format.js';
import { openDialog } from '../../shared/dialog.js';


function labelColumn(th, name) {
  if (th.dataset.col === 'actions') th.replaceChildren(h('span.sr-only', t('common.columns.actions')));
  else th.textContent = name(th.dataset.col);
}

export function columnHeads(name, cols) {
  return cols.map((col) => { const th = h('th', { dataset: { col } }); labelColumn(th, name); return th; });
}

export function labelColumns(el, name) {
  for (const th of el.querySelectorAll('th[data-col]')) labelColumn(th, name);
}

/**
 * Show a freshly created link. It is the only time its token is visible:
 * the server keeps a hash of it, nothing else
 */
export function showLink({ title, intro, url, expiresAt }) {
  const field = h('input.field.link-field', { type: 'text', readonly: true, value: url, 'aria-label': t('accounts.links.url') });
  const copy = h('button.btn.primary', {
    type: 'button',
    onclick: async () => {
      field.select();
      try {
        await navigator.clipboard.writeText(url);
        toast(t('accounts.links.copied'));
      } catch {
        // No clipboard (http on a LAN address): the text is selected, Ctrl+C does it
        toast(t('accounts.links.copyByHand'), 'warn');
      }
    },
  }, icon('copy'), t('accounts.links.copy'));
  const body = h('div.modal-body.link-dialog',
    h('div.dialog-text', h('p', intro), h('p.muted', t('accounts.links.once')), expiresAt ? h('p.muted', t('accounts.links.expires', { date: fmtLong(expiresAt) })) : null),
    h('div.link-row', field, copy),
    h('div.form-actions', h('button.btn', { type: 'button', onclick: () => dlg.close() }, t('common.actions.close'))));
  const dlg = openDialog(body, { title, wide: true, initialFocus: copy });
  field.addEventListener('focus', () => field.select());
  return dlg.closed;
}
