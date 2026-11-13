/**
 * Administration › Users: every account the platform knows
 *
 *   - the environment's administrator, first, unchangeable here;
 *   - local accounts: role (an administrator signs in with a passkey),
 *     disable / enable, a password reset link, clear passkeys (a lost device);
 *   - accounts waiting for approval (signed up through a link for several
 *     people): approve or reject;
 *   - SSO accounts, once they signed in: the role their groups give, or one
 *     forced here, disable / enable.
 * Any change of role or state signs the person out everywhere at once; the
 * server refuses to remove the last administrator
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { session } from '../../../core/session.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { formatDate, errorText, showLink } from '../common.js';

export function mount(el) {
  const filter = h('input.field.filter', { type: 'search', placeholder: t('accounts.users.filter'), 'aria-label': t('accounts.users.filter') });
  const count = h('span.muted');
  const tbody = h('tbody');
  const notice = h('p.form-error', { role: 'alert' });
  const table = h('div.table-wrap', h('table.vm-table.accounts-table',
    h('thead', h('tr', ['name', 'role', 'state', 'passkeys', 'lastSignIn', 'actions'].map((c) => h('th', { dataset: { col: c } }))),
    tbody)));
  el.append(h('div.panel', h('div.panel-toolbar', filter, count), notice, table));

  let users = [];
  let passkeysAvailable = false;
  let visible = false;

  async function load() {
    try {
      ({ users, passkeysAvailable } = await getJson('/api/accounts/users'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = errorText(err);
    }
    render();
  }

  const roleLabel = (role) => t(`auth.menu.roles.${role}`);

  function roleControl(user) {
    if (user.environment) return h('span.badge', roleLabel('admin'));
    const options = user.via === 'oidc'
      ? [
        { value: '', label: t('accounts.users.roleAuto', { role: roleLabel(user.groupRole ?? 'student') }) },
        { value: 'student', label: t('accounts.users.roleForced', { role: roleLabel('student') }) },
        { value: 'admin', label: t('accounts.users.roleForced', { role: roleLabel('admin') }) },
      ]
      : [{ value: 'student', label: roleLabel('student') }, { value: 'admin', label: roleLabel('admin') }];
    const current = user.via === 'oidc' ? user.roleOverride ?? '' : user.role;
    const select = h('select.field.role-select', { 'aria-label': t('accounts.users.roleOf', { name: user.name }), disabled: user.state === 'pending' },
      options.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label)));
    select.addEventListener('change', () => changeRole(user, select.value === '' ? null : select.value, select, current));
    return select;
  }

  async function changeRole(user, role, select, previous) {
    const target = role ?? user.groupRole ?? 'student';
    const body = [t('accounts.users.roleConfirm', { name: user.name, role: roleLabel(target) }), t('accounts.users.signedOut')];
    if (target === 'admin' && user.via === 'local') body.push(t('accounts.users.adminNeedsPasskey'));
    const ok = await confirmDialog({ title: t('accounts.users.roleTitle'), body, confirmLabel: t('accounts.users.roleApply') });
    if (!ok) {
      select.value = previous;
      return;
    }
    await act(() => request('PATCH', `/api/accounts/users/${encodeURIComponent(user.id)}`, { role }), 'accounts.users.roleDone', () => { select.value = previous; });
  }

  async function act(fn, doneKey, onError) {
    try {
      await fn();
      if (doneKey) toast(t(doneKey));
    } catch (err) {
      toast(errorText(err), 'error', 7000);
      onError?.();
    }
    await load();
  }

  function actions(user) {
    if (user.environment) return h('span.muted.small-note', t('accounts.users.environment'));
    const path = `/api/accounts/users/${encodeURIComponent(user.id)}`;
    const buttons = [];
    if (user.state === 'pending') {
      buttons.push(h('button.btn.small.primary', { type: 'button', dataset: { action: 'approve' }, onclick: () => act(() => request('POST', `${path}/approve`), 'accounts.users.approved') }, icon('check'), t('accounts.users.approve')));
      buttons.push(h('button.btn.small.danger', {
        type: 'button',
        dataset: { action: 'reject' },
        onclick: async () => {
          if (await confirmDialog({ title: t('accounts.users.rejectTitle'), body: t('accounts.users.rejectBody', { name: user.name, username: user.username }), confirmLabel: t('accounts.users.reject'), danger: true })) {
            await act(() => request('POST', `${path}/reject`), 'accounts.users.rejected');
          }
        },
      }, t('accounts.users.reject')));
      return h('div.row-actions.end', buttons);
    }
    if (user.state === 'active') {
      buttons.push(h('button.btn.small.danger', {
        type: 'button',
        dataset: { action: 'disable' },
        onclick: async () => {
          const ok = await confirmDialog({ title: t('accounts.users.disableTitle'), body: [t('accounts.users.disableBody', { name: user.name }), t('accounts.users.signedOut')], confirmLabel: t('accounts.users.disable'), danger: true });
          if (ok) await act(() => request('PATCH', path, { state: 'disabled' }), 'accounts.users.disabled');
        },
      }, t('accounts.users.disable')));
    } else {
      buttons.push(h('button.btn.small', { type: 'button', dataset: { action: 'enable' }, onclick: () => act(() => request('PATCH', path, { state: 'active' }), 'accounts.users.enabled') }, t('accounts.users.enable')));
    }
    if (user.via === 'local') {
      buttons.push(h('button.btn.small', {
        type: 'button',
        dataset: { action: 'reset' },
        onclick: async () => {
          const created = await formDialog({
            title: t('accounts.users.resetTitle'),
            intro: [t('accounts.users.resetIntro', { name: user.name }), t('accounts.users.resetEffect')],
            fields: [{ name: 'ttl', label: t('accounts.links.validity'), type: 'select', value: '1h', options: [{ value: '1h', label: t('accounts.links.ttl.1h') }, { value: '24h', label: t('accounts.links.ttl.24h') }] }],
            submitLabel: t('accounts.users.resetCreate'),
            onSubmit: (values) => request('POST', `${path}/reset-link`, { ttl: values.ttl }),
          }).catch((err) => { toast(errorText(err), 'error'); return null; });
          if (created) await showLink({ title: t('accounts.users.resetTitle'), intro: t('accounts.users.resetShare', { name: user.name }), url: created.url, expiresAt: created.expiresAt });
        },
      }, icon('link'), t('accounts.users.reset')));
      if (user.passkeys) {
        buttons.push(h('button.btn.small.danger', {
          type: 'button',
          dataset: { action: 'clear-passkeys' },
          onclick: async () => {
            const ok = await confirmDialog({ title: t('accounts.users.clearTitle'), body: [t('accounts.users.clearBody', { name: user.name, count: user.passkeys }), t('accounts.users.signedOut')], confirmLabel: t('accounts.users.clear'), danger: true });
            if (ok) await act(() => request('DELETE', `${path}/passkeys`), 'accounts.users.cleared');
          },
        }, icon('key'), t('accounts.users.clear')));
      }
    }
    return h('div.row-actions.end', buttons);
  }

  function row(user) {
    const you = user.id === session.user?.id;
    const via = user.environment ? t('accounts.users.viaEnvironment') : user.via === 'oidc' ? t('accounts.users.viaSso') : t('accounts.users.viaLocal');
    const notes = [];
    if (you) notes.push(h('span.badge', t('accounts.users.you')));
    if (user.needsPasskey) notes.push(h('span.badge.warn', t('accounts.users.needsPasskey')));
    return h('tr', { dataset: { account: user.id, state: user.state } },
      h('td', h('div.account-cell', h('strong', user.name), h('span.vm-meta', `${user.username} · ${via}`), notes.length ? h('div.account-notes', notes) : null)),
      h('td', roleControl(user)),
      h('td', h('span.state-pill', { dataset: { state: user.state } }, t(`accounts.states.${user.state}`))),
      h('td', user.via === 'local' && !user.environment ? String(user.passkeys) : '—'),
      h('td', formatDate(user.lastSignInAt)),
      h('td.right', actions(user)));
  }

  function render() {
    for (const th of el.querySelectorAll('th[data-col]')) th.textContent = th.dataset.col === 'actions' ? '' : t(`accounts.users.columns.${th.dataset.col}`);
    filter.placeholder = t('accounts.users.filter');
    const needle = filter.value.trim().toLowerCase();
    const shown = users.filter((u) => !needle || `${u.name} ${u.username}`.toLowerCase().includes(needle));
    // Waiting for approval first: they are the ones to act on
    shown.sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending'));
    tbody.replaceChildren(...(shown.length ? shown.map(row) : [h('tr', h('td.empty-row', { colspan: 6 }, t('accounts.users.none')))]));
    const pending = users.filter((u) => u.state === 'pending').length;
    count.textContent = t('accounts.users.count', { count: users.length }) + (pending ? ` · ${t('accounts.users.pendingCount', { count: pending })}` : '');
    el.dataset.passkeys = String(passkeysAvailable);
  }

  filter.addEventListener('input', render);
  onLocaleChange(render);
  live.on('accounts:changed', () => { if (visible) load(); });

  return {
    show() {
      visible = true;
      load();
    },
    hide() { visible = false; },
  };
}
