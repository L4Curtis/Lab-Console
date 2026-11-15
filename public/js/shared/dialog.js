/**
 * Modal dialogs: the only way to ask the user something. No window.confirm,
 * no alert - they block the whole tab, consoles included, and cannot be
 * translated or styled
 *
 *   if (await confirmDialog({ title, body, confirmLabel, danger: true, requireText: 'B4M' })) …
 *   const values = await formDialog({ title, fields: [{ name: 'label', label, required: true }], onSubmit });
 *   const dlg = openDialog(node, { title });   dlg.close(value);   await dlg.closed;
 *
 * Built on <dialog>.showModal(): the page behind is inert and Escape closes.
 * On top of that, Tab cycles inside the dialog, focus goes back to where it
 * was, and the dialog is named for screen readers (aria-labelledby /
 * aria-describedby; a dangerous confirmation is an alertdialog)
 *
 * Presentation (docs/v2/UX.md §7.7): a centred dialog from 720 px, a bottom
 * sheet below (css/shared.css). `size`: 'sm' 420 px (confirmations), 'md'
 * 560 px (the default, forms), 'lg' 800 px (lists, reports; `wide: true` is
 * the same), 'full' (an editor, a diff). A tap on the scrim closes a
 * dismissible dialog. On a phone, Back closes the sheet on top: opening one
 * adds an entry to the history (same address), closing it takes the entry
 * back, and `closed` settles once that is done, so a caller may navigate
 * right after `await dlg.closed`
 */
import { h, icon, loadCss } from '../core/dom.js';
import { t, onLocaleChange } from '../core/i18n.js';
import { isCompact } from '../core/viewport.js';

let serial = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (el) => el.getClientRects().length > 0;
const asNodes = (content) => [content].flat().filter((c) => c !== null && c !== undefined && c !== false)
  .map((c) => (c instanceof Node ? c : h('p', String(c))));

const SIZES = ['sm', 'md', 'lg', 'full'];

/**
 * The history entry an open sheet added, so that Back closes it (compact
 * only). Going back is asynchronous: a sheet opened while another one is
 * still giving its entry back waits for that before it adds its own
 */
let pendingBack = Promise.resolve();
function sheetHistory(id, close, dismissible) {
  if (!isCompact()) return null;
  let pushed = false;
  let released = false;
  const push = () => { history.pushState({ ...(history.state ?? {}), sheet: id }, ''); pushed = true; };
  pendingBack.then(() => { if (!released) push(); });
  const onPop = () => {
    if (!pushed || history.state?.sheet === id) return;
    if (dismissible) close();
    else push(); // a sheet that cannot be dismissed keeps its entry
  };
  addEventListener('popstate', onPop);
  return {
    /** The dialog closed: take its entry back if it is still the current one; → once done */
    release() {
      released = true;
      removeEventListener('popstate', onPop);
      if (!pushed || history.state?.sheet !== id) return Promise.resolve();
      pendingBack = new Promise((resolve) => {
        const done = () => { removeEventListener('popstate', done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 500); // a browser that never answers must not hold the caller
        addEventListener('popstate', done);
        history.back();
      });
      return pendingBack;
    },
  };
}

/**
 * Show `node` in a modal. `node` is the dialog's content, or a ready-made
 * <dialog> element. Options: title (adds the header and its close button; a
 * function is asked again when the language changes while the dialog is open),
 * label (accessible name when there is no title), size ('sm' | 'md' | 'lg' |
 * 'full'), wide (= size 'lg'), role, describedBy, dismissible (false: Escape,
 * the scrim and the close button do nothing), initialFocus (element or
 * selector). Returns { el, close(value), closed: Promise<value> }
 */
export function openDialog(node, { title, label, size, wide = false, role, describedBy, dismissible = true, initialFocus } = {}) {
  loadCss('shared');
  const id = `dlg-${++serial}`;
  const opener = document.activeElement;
  let result;
  let settle;
  const closed = new Promise((resolve) => { settle = resolve; });

  const dlg = node instanceof HTMLDialogElement ? node : h(`dialog.modal${wide ? '.wide' : ''}`, node);
  const chosen = wide ? 'lg' : size;
  if (SIZES.includes(chosen)) dlg.dataset.size = chosen;
  if (dlg.classList.contains('modal') && !dlg.querySelector(':scope > .sheet-handle')) dlg.prepend(h('div.sheet-handle', { 'aria-hidden': 'true' }));
  const close = (value) => {
    result = value;
    if (dlg.open) dlg.close();
  };

  if (title !== undefined && !(node instanceof HTMLDialogElement)) {
    const heading = h('h2', { id: `${id}-title` }, typeof title === 'function' ? title() : title);
    if (typeof title === 'function') closed.then(onLocaleChange(() => { heading.textContent = title(); }));
    const head = h('header.modal-head', heading,
      dismissible ? h('button.icon-btn', { type: 'button', title: t('common.actions.close'), 'aria-label': t('common.actions.close'), onclick: () => close() }, icon('close')) : null);
    const handle = dlg.querySelector(':scope > .sheet-handle');
    if (handle) handle.after(head);
    else dlg.prepend(head);
    dlg.setAttribute('aria-labelledby', `${id}-title`);
  } else if (label) {
    dlg.setAttribute('aria-label', label);
  }
  dlg.setAttribute('aria-modal', 'true');
  if (role) dlg.setAttribute('role', role);
  if (describedBy) dlg.setAttribute('aria-describedby', describedBy);

  // Escape: the browser fires "cancel" first; refusing it keeps the dialog open
  dlg.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
  // Tab stays inside (showModal makes the page inert but lets focus reach the browser's own UI)
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dlg.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !dlg.contains(active))) { e.preventDefault(); first.focus(); }
  });
  // A tap on the scrim (the dialog element itself, outside its box) closes it
  let downOnScrim = false;
  const onScrim = (e) => {
    if (e.target !== dlg) return false;
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dlg.addEventListener('pointerdown', (e) => { downOnScrim = onScrim(e); });
  dlg.addEventListener('click', (e) => {
    if (dismissible && downOnScrim && onScrim(e)) close();
    downOnScrim = false;
  });
  let entry = null;
  dlg.addEventListener('close', async () => {
    dlg.remove();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    await entry?.release();
    settle(result);
  }, { once: true });

  if (!dlg.isConnected) document.body.append(dlg);
  dlg.showModal();
  entry = sheetHistory(id, () => close(), dismissible);
  const target = typeof initialFocus === 'string' ? dlg.querySelector(initialFocus) : initialFocus;
  if (target) target.focus();

  return { el: dlg, close, closed };
}

/**
 * Ask for a confirmation; resolves to true or false. `danger` styles the
 * button and puts the focus on Cancel; `requireText` makes the user type
 * that exact text (a bench name…) before the button unlocks
 */
export function confirmDialog({ title, body, confirmLabel, cancelLabel, danger = false, requireText, size = 'sm' } = {}) {
  const id = `confirm-${++serial}`;
  const confirm = h(`button.btn.${danger ? 'danger-solid' : 'primary'}`, { type: 'submit', dataset: { action: 'confirm' } }, confirmLabel ?? t('common.actions.confirm'));
  const cancel = h('button.btn', { type: 'button', dataset: { action: 'cancel' }, onclick: () => dlg.close(false) }, cancelLabel ?? t('common.actions.cancel'));

  let input = null;
  let gate = null;
  if (requireText) {
    input = h('input.field', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': `${id}-hint` });
    gate = h('label.require-text', h('span', { id: `${id}-hint` }, t('common.dialog.typeToConfirm', { text: requireText })), input);
    const sync = () => { confirm.disabled = input.value.trim() !== String(requireText); };
    input.addEventListener('input', sync);
    sync();
  }

  const form = h('form.modal-body.form-grid', {
    onsubmit: (e) => {
      e.preventDefault();
      if (!confirm.disabled) dlg.close(true);
    },
  },
  h('div.dialog-text', { id: `${id}-body` }, asNodes(body)),
  gate,
  h('div.form-actions', cancel, confirm));

  const dlg = openDialog(form, {
    title,
    size,
    role: danger ? 'alertdialog' : undefined,
    describedBy: `${id}-body`,
    initialFocus: input ?? (danger ? cancel : confirm),
  });
  return dlg.closed.then((value) => value === true);
}

function buildField(spec, id) {
  const { name, label, type = 'text', value, required = false, placeholder, hint, options = [], attrs = {} } = spec;
  const common = { id, name, required, placeholder, ...attrs };
  let control;
  if (type === 'select') {
    control = h('select.field', common, options.map((o) => {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      return h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label ?? opt.value);
    }));
  } else if (type === 'textarea') {
    control = h('textarea.field', { rows: 4, ...common });
    control.value = value ?? '';
  } else if (type === 'checkbox') {
    control = h('input', { ...common, type: 'checkbox', checked: Boolean(value) });
    return { control, row: h('label.check', control, h('span', label, hint ? h('small', hint) : null)) };
  } else {
    control = h('input.field', { autocomplete: 'off', ...common, type });
    if (value !== undefined && value !== null) control.value = value;
  }
  return { control, row: h('label', h('span', label), control, hint ? h('small', hint) : null) };
}

function readField(spec, control) {
  if (spec.type === 'checkbox') return control.checked;
  if (spec.type === 'number') return control.value === '' ? null : Number(control.value);
  if (spec.type === 'password' || spec.type === 'textarea') return control.value;
  return control.value.trim();
}

/**
 * Ask for a few values; resolves to { name: value } or to null when the user
 * gives up. A field is { name, label, type, value, required, placeholder,
 * hint, options, attrs } with type text | password | number | email |
 * textarea | select | checkbox; a DOM node is inserted as is.
 * `validate(values)` returns an error message or nothing. `onSubmit(values)`
 * may be async: while it runs the button is disabled, if it throws its
 * message is shown and the dialog stays open, and what it returns (if
 * anything) becomes the result
 */
export function formDialog({ title, intro, fields = [], submitLabel, cancelLabel, danger = false, wide = false, size, validate, onSubmit } = {}) {
  const id = `form-${++serial}`;
  const built = fields.map((spec, i) => (spec instanceof Node ? { row: spec } : { spec, ...buildField(spec, `${id}-${i}`) }));
  const error = h('p.form-error', { role: 'alert' });
  const submit = h(`button.btn.${danger ? 'danger-solid' : 'primary'}`, { type: 'submit', dataset: { action: 'confirm' } }, submitLabel ?? t('common.actions.ok'));
  const cancel = h('button.btn', { type: 'button', dataset: { action: 'cancel' }, onclick: () => dlg.close(null) }, cancelLabel ?? t('common.actions.cancel'));

  const form = h('form.modal-body.form-grid', {
    onsubmit: async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(built.filter((f) => f.spec).map((f) => [f.spec.name, readField(f.spec, f.control)]));
      error.textContent = validate?.(values) || '';
      if (error.textContent) return;
      submit.disabled = true;
      try {
        const result = await onSubmit?.(values);
        dlg.close(result === undefined ? values : result);
      } catch (err) {
        error.textContent = err?.message || String(err);
        submit.disabled = false;
      }
    },
  },
  intro ? h('div.dialog-text', asNodes(intro)) : null,
  built.map((f) => f.row),
  error,
  h('div.form-actions', cancel, submit));

  const first = built.find((f) => f.control)?.control;
  const dlg = openDialog(form, { title, wide, size, initialFocus: first ?? submit });
  return dlg.closed.then((value) => (value === undefined ? null : value));
}
