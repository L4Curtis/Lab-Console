/**
 * Administration › Users: every account the platform knows
 *
 *   - accounts waiting for approval (signed up through a link for several
 *     people) come first, with a notice: approve or reject;
 *   - the environment's administrator, unchangeable here;
 *   - local accounts (they sign in with a passkey): role, disable / enable,
 *     a password reset link (a new password and a new passkey: the old
 *     passkeys are removed), clear passkeys;
 *   - SSO accounts, once they signed in: the role their groups give, or one
 *     forced here, disable / enable.
 * Any change of role or state signs the person out everywhere at once; the
 * server refuses to remove the last administrator. Whatever makes or unmakes
 * an administrator is confirmed first (../confirm.js: the server asks)
 *
 * From 720 px the role is a select in the row; on a phone the row is a card
 * and "Changer le rôle" is in its ⋯ (a sheet with the choices, then the same
 * confirmation)
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { session } from '../../../core/session.js';
import { isCompact, onViewportChange } from '../../../core/viewport.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { dataList } from '../../../shared/dataList.js';
import { setNavBadge } from '../../../core/nav.js';
import { showLink, tagRows, stateBadge } from '../common.js';
import { withConfirmation } from '../confirm.js';
import { fmtLong } from '../../../core/format.js';

export function mount(el, ctx) {
  const filter = h('input.field.filter', { type: 'search', 'aria-label': t('accounts.users.filter') });
  const notice = h('p.form-error', { role: 'alert' });
  const waiting = h('section.card.admin-waiting', { dataset: { panel: 'waiting' }, hidden: true });
  const stateLabel = (s) => t(`accounts.states.${s}`);

  const list = dataList({
    label: () => t('accounts.users.title'),
    dense: true,
    rowKey: (u) => u.id,
    columns: [
      { id: 'name', label: () => t('accounts.users.columns.name'), cell: nameCell, primary: true },
      { id: 'role', label: () => t('accounts.users.columns.role'), cell: roleControl, hideCompact: true },
      { id: 'roleText', label: () => t('accounts.users.columns.role'), cell: (u) => roleLabelOf(u), meta: true },
      { id: 'state', label: () => t('accounts.users.columns.state'), cell: (u) => stateBadge(u.state, stateLabel(u.state)), badge: true },
      { id: 'passkeys', label: () => t('accounts.users.columns.passkeys'), cell: (u) => (u.via === 'local' && !u.environment ? String(u.passkeys) : '—'), num: true, hideCompact: true },
      { id: 'lastSignIn', label: () => t('accounts.users.columns.lastSignIn'), cell: (u) => fmtLong(u.lastSignInAt), hideCompact: true },
    ],
    actions: rowActions,
    empty: { icon: 'user', title: 'accounts.users.none' },
  });
  tagRows(list, (u) => ({ account: u.id, state: u.state }));
  el.append(h('div.admin-page', waiting, h('div.admin-toolbar', filter), notice, list.el));

  let users = [];
  let passkeysAvailable = false;
  let visible = false;

  const roleLabel = (role) => t(`auth.menu.roles.${role}`);
  function roleLabelOf(user) {
    if (user.environment) return roleLabel('admin');
    if (user.via === 'oidc') return user.roleOverride ? t('accounts.users.roleForced', { role: roleLabel(user.roleOverride) }) : t('accounts.users.roleAuto', { role: roleLabel(user.groupRole ?? 'student') });
    return roleLabel(user.role);
  }

  async function load() {
    try {
      ({ users, passkeysAvailable } = await getJson('/api/accounts/users'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = err.message;
    }
    render();
  }

  function nameCell(user) {
    const you = user.id === session.user?.id;
    const via = user.environment ? t('accounts.users.viaEnvironment') : user.via === 'oidc' ? t('accounts.users.viaSso') : t('accounts.users.viaLocal');
    const notes = [];
    if (you) notes.push(h('span.badge', { dataset: { tone: 'info' } }, t('accounts.users.you')));
    if (user.needsPasskey) notes.push(h('span.badge', { dataset: { tone: 'warning' } }, t('accounts.users.needsPasskey')));
    // Where the sign-in columns wait for a wider window (admin.css), their content is under the name
    const signIn = [t('accounts.users.signInMeta', { when: fmtLong(user.lastSignInAt) }), ...(user.via === 'local' && !user.environment ? [t('accounts.users.passkeysMeta', { count: user.passkeys })] : [])].join(' · ');
    return h('div.account-cell', h('strong', user.name), h('span.vm-meta', `${user.username} · ${via}`), h('span.vm-meta.account-signin', signIn), notes.length ? h('div.account-notes', notes) : null);
  }

  /** The role as a select: from 720 px (a phone changes it from the row's ⋯) */
  function roleControl(user) {
    if (user.environment) return h('span.badge', { dataset: { tone: 'info' } }, roleLabel('admin'));
    const options = roleOptions(user);
    const current = currentRole(user);
    const select = h('select.field.role-select', { 'aria-label': t('accounts.users.roleOf', { name: user.name }), disabled: user.state === 'pending' },
      options.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label)));
    select.addEventListener('change', () => changeRole(user, select.value === '' ? null : select.value, () => { select.value = current; }));
    return select;
  }
  const currentRole = (user) => (user.via === 'oidc' ? user.roleOverride ?? '' : user.role);
  const roleOptions = (user) => (user.via === 'oidc'
    ? [
      { value: '', label: t('accounts.users.roleAuto', { role: roleLabel(user.groupRole ?? 'student') }) },
      { value: 'student', label: t('accounts.users.roleForced', { role: roleLabel('student') }) },
      { value: 'admin', label: t('accounts.users.roleForced', { role: roleLabel('admin') }) },
    ]
    : [{ value: 'student', label: roleLabel('student') }, { value: 'admin', label: roleLabel('admin') }]);

  async function changeRole(user, role, undo) {
    const target = role ?? user.groupRole ?? 'student';
    const body = [t('accounts.users.roleConfirm', { name: user.name, role: roleLabel(target) }), t('accounts.users.signedOut')];
    const ok = await confirmDialog({ title: t('accounts.users.roleTitle'), body, confirmLabel: t('accounts.users.roleApply') });
    if (!ok) {
      undo?.();
      return;
    }
    await act(() => change('PATCH', `/api/accounts/users/${encodeURIComponent(user.id)}`, { role }), 'accounts.users.roleDone', undo);
  }

  /** A phone: the choices in a sheet, then the same confirmation */
  async function chooseRole(user) {
    const picked = await formDialog({
      title: t('accounts.users.roleTitle'),
      intro: [t('accounts.users.roleOf', { name: user.name })],
      fields: [{ name: 'role', label: t('accounts.users.columns.role'), type: 'select', value: currentRole(user), options: roleOptions(user) }],
      submitLabel: t('accounts.users.roleNext'),
    });
    if (!picked || picked.role === currentRole(user)) return;
    await changeRole(user, picked.role === '' ? null : picked.role);
  }

  /** A change the server may want confirmed (a role given or taken, an administrator's account): null when it was not sent */
  const change = (method, url, body = {}) => withConfirmation((confirmation) => request(method, url, { ...body, confirmation }), { returnTo: 'users' });

  async function act(fn, doneKey, onError) {
    try {
      if ((await fn()) === null) onError?.(); // not confirmed: nothing changed
      else if (doneKey) toast(t(doneKey));
    } catch (err) {
      toast(err.message, 'error', 7000);
      onError?.();
    }
    await load();
  }

  const pathOf = (user) => `/api/accounts/users/${encodeURIComponent(user.id)}`;

  const approve = (user) => act(() => change('POST', `${pathOf(user)}/approve`), 'accounts.users.approved');
  async function reject(user) {
    if (await confirmDialog({ title: t('accounts.users.rejectTitle'), body: t('accounts.users.rejectBody', { name: user.name, username: user.username }), confirmLabel: t('accounts.users.reject'), danger: true })) {
      await act(() => request('POST', `${pathOf(user)}/reject`), 'accounts.users.rejected');
    }
  }
  async function disable(user) {
    const ok = await confirmDialog({ title: t('accounts.users.disableTitle'), body: [t('accounts.users.disableBody', { name: user.name }), t('accounts.users.signedOut')], confirmLabel: t('accounts.users.disable'), danger: true });
    if (ok) await act(() => change('PATCH', pathOf(user), { state: 'disabled' }), 'accounts.users.disabled');
  }
  async function resetLink(user) {
    const created = await formDialog({
      title: t('accounts.users.resetTitle'),
      intro: [t('accounts.users.resetIntro', { name: user.name }), t('accounts.users.resetEffect')],
      fields: [{ name: 'ttl', label: t('accounts.links.validity'), type: 'select', value: '1h', options: [{ value: '1h', label: t('accounts.links.ttl.1h') }, { value: '24h', label: t('accounts.links.ttl.24h') }] }],
      submitLabel: t('accounts.users.resetCreate'),
      onSubmit: (values) => request('POST', `${pathOf(user)}/reset-link`, { ttl: values.ttl }),
    }).catch((err) => { toast(err.message, 'error'); return null; });
    if (created) await showLink({ title: t('accounts.users.resetTitle'), intro: t('accounts.users.resetShare', { name: user.name }), url: created.url, expiresAt: created.expiresAt });
  }
  async function clearPasskeys(user) {
    const ok = await confirmDialog({ title: t('accounts.users.clearTitle'), body: [t('accounts.users.clearBody', { name: user.name, count: user.passkeys }), t('accounts.users.signedOut')], confirmLabel: t('accounts.users.clear'), danger: true });
    if (ok) await act(() => change('DELETE', `${pathOf(user)}/passkeys`), 'accounts.users.cleared');
  }

  /** What may be done to this account; the first with `primary` is the button, the rest wait in ⋯ */
  function rowActions(user) {
    if (user.environment) return [];
    if (user.state === 'pending') {
      return [
        { id: 'approve', label: 'accounts.users.approve', icon: 'check', primary: true, run: () => approve(user) },
        { id: 'reject', label: 'accounts.users.reject', icon: 'close', danger: true, run: () => reject(user) },
      ];
    }
    const actions = [];
    if (isCompact() && user.state !== 'pending') actions.push({ id: 'role', label: 'accounts.users.changeRole', icon: 'edit', run: () => chooseRole(user) });
    if (user.via === 'local') {
      actions.push({ id: 'reset', label: 'accounts.users.reset', icon: 'link', run: () => resetLink(user) });
      if (user.passkeys) actions.push({ id: 'clear-passkeys', label: 'accounts.users.clear', icon: 'key', danger: true, run: () => clearPasskeys(user) });
    }
    actions.push(user.state === 'active'
      ? { id: 'disable', label: 'accounts.users.disable', icon: 'lock', danger: true, run: () => disable(user) }
      : { id: 'enable', label: 'accounts.users.enable', icon: 'check', run: () => act(() => change('PATCH', pathOf(user), { state: 'active' }), 'accounts.users.enabled') });
    return actions;
  }

  function renderWaiting(pending) {
    waiting.hidden = pending.length === 0;
    if (!pending.length) return;
    waiting.replaceChildren(
      h('div.card-head', icon('user'), h('h2', t('accounts.users.waitingTitle', { count: pending.length }))),
      h('p', t('accounts.users.waitingText')));
  }

  function render() {
    filter.placeholder = t('accounts.users.filter');
    filter.setAttribute('aria-label', t('accounts.users.filter'));
    const needle = filter.value.trim().toLowerCase();
    const shown = users.filter((u) => !needle || `${u.name} ${u.username}`.toLowerCase().includes(needle));
    // Waiting for approval first: they are the ones to act on
    shown.sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending'));
    list.render(shown);
    const pending = users.filter((u) => u.state === 'pending');
    renderWaiting(pending);
    setNavBadge('admin', pending.length ? { count: pending.length, tone: 'danger' } : null);
    ctx.setHeader(ctx.tab, {
      context: () => t('accounts.users.count', { count: users.length }) + (pending.length ? ` · ${t('accounts.users.pendingCount', { count: pending.length })}` : ''),
      primary: { id: 'invite', label: 'accounts.users.invite', icon: 'plus', run: () => { location.hash = '#/admin/invitations/new'; } },
    });
    el.dataset.passkeys = String(passkeysAvailable);
  }

  filter.addEventListener('input', render);
  onLocaleChange(render);
  let compact = isCompact();
  onViewportChange((now) => { if (now.compact !== compact) { compact = now.compact; if (users.length) render(); } });
  live.on('accounts:changed', () => { if (visible) load(); });
  render();

  return {
    show() {
      visible = true;
      render();
      load();
    },
    hide() { visible = false; },
  };
}
