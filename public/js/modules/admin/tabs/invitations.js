/**
 * Administration › Invitations: links that let people create a local account
 *
 * A link is valid 1 hour, 24 hours or 7 days, for one person (the account is
 * active at once) or for several (each account waits for an administrator's
 * approval, in the Users tab), and grants a role: student by default. The
 * link itself is shown once, when it is created; the list shows what each
 * one is for, how many times it was used, and lets an administrator
 * withdraw it. #/admin/invitations/new opens the form at once (the Users
 * tab's "Inviter" leads there). Every local account signs in with a
 * passkey, registered as part of the sign-up: where the site cannot offer
 * passkeys (not https), no invitation can be made, and the tab says why
 */
import { h, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { dataList } from '../../../shared/dataList.js';
import { showLink, tagRows, stateBadge } from '../common.js';
import { withConfirmation } from '../confirm.js';
import { fmtLong } from '../../../core/format.js';

export function mount(el, ctx) {
  const showEnded = h('input', { type: 'checkbox' });
  const notice = h('p.form-error', { role: 'alert' });
  const intro = h('p.muted.panel-intro');

  const list = dataList({
    label: () => t('accounts.invitations.title'),
    dense: true,
    rowKey: (i) => i.id,
    columns: [
      { id: 'note', label: () => t('accounts.invitations.columns.note'), cell: (i) => (i.note ? h('strong', i.note) : h('span.muted', t('accounts.invitations.noNote'))), primary: true },
      { id: 'role', label: () => t('accounts.invitations.columns.role'), cell: (i) => t(`auth.menu.roles.${i.role}`), meta: true },
      { id: 'uses', label: () => t('accounts.invitations.columns.uses'), cell: (i) => [t('accounts.invitations.used', { uses: i.uses, max: i.maxUses }), i.maxUses > 1 ? ` · ${t('accounts.invitations.withApproval')}` : ''].join(''), meta: true },
      { id: 'expires', label: () => t('accounts.invitations.columns.expires'), cell: (i) => fmtLong(i.expiresAt), meta: true },
      { id: 'by', label: () => t('accounts.invitations.columns.by'), cell: (i) => i.createdBy?.username ?? '—', hideCompact: true },
      { id: 'state', label: () => t('accounts.invitations.columns.state'), cell: (i) => stateBadge(i.state, t(`accounts.invitations.states.${i.state}`)), badge: true },
    ],
    actions: (i) => (i.state === 'active' ? [{ id: 'revoke', label: 'accounts.invitations.revoke', icon: 'trash', danger: true, run: () => revoke(i) }] : []),
    empty: { icon: 'link', title: 'accounts.invitations.none', text: 'accounts.invitations.noneText' },
  });
  tagRows(list, (i) => ({ invitation: i.id, state: i.state }));
  el.append(h('div.admin-page', intro, h('div.admin-toolbar', h('label.check.inline', showEnded, h('span.ended-label'))), notice, list.el));

  let invitations = [];
  let passkeysAvailable = true; // until the server says otherwise
  let visible = false;

  async function load() {
    try {
      ({ invitations, passkeysAvailable } = await getJson('/api/accounts/invitations'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = err.message;
    }
    render();
  }

  async function createInvitation() {
    const roles = ['student', 'admin'].map((value) => ({ value, label: t(`auth.menu.roles.${value}`) }));
    const created = await formDialog({
      title: t('accounts.invitations.createTitle'),
      intro: [t('accounts.invitations.createIntro')],
      fields: [
        { name: 'note', label: t('accounts.invitations.note'), placeholder: t('accounts.invitations.notePlaceholder'), attrs: { maxlength: 120 } },
        { name: 'ttl', label: t('accounts.links.validity'), type: 'select', value: '24h', options: ['1h', '24h', '7d'].map((v) => ({ value: v, label: t(`accounts.links.ttl.${v}`) })) },
        { name: 'uses', label: t('accounts.invitations.uses'), type: 'number', value: 1, hint: t('accounts.invitations.usesHint'), attrs: { min: 1, max: 100, step: 1 } },
        { name: 'role', label: t('accounts.invitations.role'), type: 'select', value: 'student', options: roles, hint: t('accounts.invitations.roleHint') },
      ],
      submitLabel: t('accounts.invitations.create'),
      validate: (values) => (Number.isInteger(values.uses) && values.uses >= 1 && values.uses <= 100 ? '' : t('accounts.errors.bad_uses')),
      // An invitation as administrator is confirmed first (the server asks): null when it was not
      onSubmit: (values) => withConfirmation((confirmation) => request('POST', '/api/accounts/invitations', { ...values, confirmation }), { returnTo: 'invitations' }),
    });
    if (!created) return;
    await load();
    const intro = created.invitation.maxUses > 1
      ? t('accounts.invitations.shareMany', { count: created.invitation.maxUses })
      : t('accounts.invitations.shareOne');
    await showLink({ title: t('accounts.invitations.createdTitle'), intro, url: created.url, expiresAt: created.invitation.expiresAt });
  }

  async function revoke(invitation) {
    const ok = await confirmDialog({
      title: t('accounts.invitations.revokeTitle'),
      body: t('accounts.invitations.revokeBody'),
      confirmLabel: t('accounts.invitations.revoke'),
      danger: true,
    });
    if (!ok) return;
    try {
      await request('DELETE', `/api/accounts/invitations/${encodeURIComponent(invitation.id)}`);
      toast(t('accounts.invitations.revoked'));
    } catch (err) {
      toast(err.message, 'error');
    }
    await load();
  }

  const create = () => createInvitation().catch((err) => toast(err.message, 'error'));

  function render() {
    el.querySelector('.ended-label').textContent = t('accounts.invitations.showEnded');
    // Without passkeys no local account can sign in: the tab says why, and nothing can be created
    intro.textContent = t(passkeysAvailable ? 'accounts.invitations.intro' : 'accounts.invitations.noPasskeys');
    intro.classList.toggle('notice', !passkeysAvailable);
    intro.classList.toggle('warn', !passkeysAvailable);
    intro.classList.toggle('muted', passkeysAvailable);
    const shown = invitations.filter((i) => showEnded.checked || i.state === 'active');
    list.render(shown);
    const active = invitations.filter((i) => i.state === 'active').length;
    ctx.setHeader(ctx.tab, {
      context: () => t('accounts.invitations.count', { count: active }),
      primary: { id: 'create', label: 'accounts.invitations.create', icon: 'plus', run: create, disabled: !passkeysAvailable },
    });
  }

  showEnded.addEventListener('change', render);
  onLocaleChange(render);
  live.on('accounts:changed', () => { if (visible) load(); });
  render();

  return {
    show([sub] = []) {
      visible = true;
      const loaded = load();
      if (sub === 'new') {
        // The address goes back to the list: Back does not reopen the form
        ctx.navigate('#/admin/invitations');
        loaded.then(() => { if (passkeysAvailable) create(); });
      }
    },
    hide() { visible = false; },
  };
}
