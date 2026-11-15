/**
 * Small pieces shared by the accounts screens (administration tabs and My account)
 *
 *   showLink({ title, intro, url, expiresAt })   the one time a link's token is shown, with a copy button
 *   tagRows(list, attrs)                          data attributes on the rows of a dataList
 *   field({ label, control, hint, problem })      a form field: label above, hint and problem under
 *   stateBadge(state, label)                      the word and colour of an account's or an invitation's state
 */
import { h, icon, toast } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { fmtLong } from '../../core/format.js';
import { openDialog } from '../../shared/dialog.js';


/**
 * Mark the rows of a dataList with data attributes (data-account, data-state…):
 * what the scenarios and the styles look at. `attrs(row)` → { name: value };
 * the marks are put again whenever the list draws its rows (a new language too)
 */
export function tagRows(list, attrs) {
  const apply = () => {
    const rows = list.rows;
    list.el.querySelectorAll('tbody tr').forEach((tr, i) => {
      const row = rows[i];
      if (row) for (const [name, value] of Object.entries(attrs(row))) if (value !== undefined && value !== null) tr.dataset[name] = String(value);
    });
  };
  new MutationObserver(apply).observe(list.el.querySelector('tbody'), { childList: true });
  apply();
}

/**
 * A form field: label above, the control, a hint under it, and where the
 * server's problem with this very field is written
 *
 *   field({ label, control, hint, problem, name })  → div.fld (data-field = name)
 */
export function field({ label, control, hint, problem, name }) {
  return h('div.fld', { dataset: name ? { field: name } : {} },
    label ? h('label', { for: control?.id }, label) : null,
    control,
    hint ?? null,
    problem ?? null);
}

/** A status word with its colour: active / pending / disabled / revoked / expired / used */
const STATE_TONES = { active: 'success', pending: 'warning', disabled: 'neutral', revoked: 'neutral', expired: 'neutral', used: 'neutral' };
export const stateBadge = (state, label) => h('span.badge', { dataset: { tone: STATE_TONES[state] ?? 'neutral', state } }, label);

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
