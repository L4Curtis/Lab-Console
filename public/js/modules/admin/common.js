/**
 * Small pieces shared by the accounts screens (administration tabs and My account)
 *
 *   formatDate(iso)          a date and time in the interface's language, '—' for none
 *   showLink({ title, intro, url, expiresAt })   the one time a link's token is shown, with a copy button
 *   errorText(err)           what to say about a failed request
 */
import { h, icon, toast } from '../../core/dom.js';
import { t, getLocale } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** The message of a failed request: api.js already translated the server's code when it knows it */
export const errorText = (err) => err?.message || t('accounts.common.failed');

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
    h('div.dialog-text', h('p', intro), h('p.muted', t('accounts.links.once')), expiresAt ? h('p.muted', t('accounts.links.expires', { date: formatDate(expiresAt) })) : null),
    h('div.link-row', field, copy),
    h('div.form-actions', h('button.btn', { type: 'button', onclick: () => dlg.close() }, t('common.actions.close'))));
  const dlg = openDialog(body, { title, wide: true, initialFocus: copy });
  field.addEventListener('focus', () => field.select());
  return dlg.closed;
}
