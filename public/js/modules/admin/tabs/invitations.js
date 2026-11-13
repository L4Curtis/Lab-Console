/**
 * Administration › Invitations: links that let people create a local account
 *
 * A link is valid 1 hour, 24 hours or 7 days, for one person (the account is
 * active at once) or for several (each account waits for an administrator's
 * approval, in the Users tab), and grants a role: student by default. The
 * link itself is shown once, when it is created; the list shows what each
 * one is for, how many times it was used, and lets an administrator
 * withdraw it
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson, live } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { formatDate, errorText, showLink } from '../common.js';

export function mount(el) {
  const create = h('button.btn.primary', { type: 'button', dataset: { action: 'create' } }, icon('plus'), h('span.create-label'));
  const showEnded = h('input', { type: 'checkbox' });
  const tbody = h('tbody');
  const notice = h('p.form-error', { role: 'alert' });
  el.append(h('div.panel',
    h('div.panel-toolbar', h('label.check.inline', showEnded, h('span.ended-label')), create),
    h('p.muted.panel-intro'),
    notice,
    h('div.table-wrap', h('table.vm-table.invitations-table',
      h('thead', h('tr', ['note', 'role', 'uses', 'expires', 'by', 'state', 'actions'].map((c) => h('th', { dataset: { col: c } })))),
      tbody))));

  let invitations = [];
  let passkeysAvailable = false;
  let visible = false;

  async function load() {
    try {
      ({ invitations, passkeysAvailable } = await getJson('/api/accounts/invitations'));
      notice.textContent = '';
    } catch (err) {
      notice.textContent = errorText(err);
    }
    render();
  }

  async function createInvitation() {
    const roles = [{ value: 'student', label: t('auth.menu.roles.student') }];
    if (passkeysAvailable) roles.push({ value: 'admin', label: t('auth.menu.roles.admin') });
    const created = await formDialog({
      title: t('accounts.invitations.createTitle'),
      intro: [t('accounts.invitations.createIntro')],
      fields: [
        { name: 'note', label: t('accounts.invitations.note'), placeholder: t('accounts.invitations.notePlaceholder'), attrs: { maxlength: 120 } },
        { name: 'ttl', label: t('accounts.links.validity'), type: 'select', value: '24h', options: ['1h', '24h', '7d'].map((v) => ({ value: v, label: t(`accounts.links.ttl.${v}`) })) },
        { name: 'uses', label: t('accounts.invitations.uses'), type: 'number', value: 1, hint: t('accounts.invitations.usesHint'), attrs: { min: 1, max: 100, step: 1 } },
        { name: 'role', label: t('accounts.invitations.role'), type: 'select', value: 'student', options: roles, hint: passkeysAvailable ? t('accounts.invitations.roleHint') : t('accounts.invitations.noAdminHint') },
      ],
      submitLabel: t('accounts.invitations.create'),
      validate: (values) => (Number.isInteger(values.uses) && values.uses >= 1 && values.uses <= 100 ? '' : t('accounts.errors.bad_uses')),
      onSubmit: (values) => request('POST', '/api/accounts/invitations', values),
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
      toast(errorText(err), 'error');
    }
    await load();
  }

  function row(invitation) {
    const active = invitation.state === 'active';
    return h('tr', { dataset: { invitation: invitation.id, state: invitation.state } },
      h('td', invitation.note ? h('strong', invitation.note) : h('span.muted', t('accounts.invitations.noNote'))),
      h('td', t(`auth.menu.roles.${invitation.role}`)),
      h('td', t('accounts.invitations.used', { uses: invitation.uses, max: invitation.maxUses }),
        invitation.maxUses > 1 ? h('span.vm-meta', ` · ${t('accounts.invitations.withApproval')}`) : null),
      h('td', formatDate(invitation.expiresAt)),
      h('td', invitation.createdBy?.username ?? '—'),
      h('td', h('span.state-pill', { dataset: { state: invitation.state } }, t(`accounts.invitations.states.${invitation.state}`))),
      h('td.right', active ? h('button.btn.small.danger', { type: 'button', dataset: { action: 'revoke' }, onclick: () => revoke(invitation) }, t('accounts.invitations.revoke')) : null));
  }

  function render() {
    for (const th of el.querySelectorAll('th[data-col]')) th.textContent = th.dataset.col === 'actions' ? '' : t(`accounts.invitations.columns.${th.dataset.col}`);
    el.querySelector('.create-label').textContent = t('accounts.invitations.create');
    el.querySelector('.ended-label').textContent = t('accounts.invitations.showEnded');
    el.querySelector('.panel-intro').textContent = t('accounts.invitations.intro');
    const shown = invitations.filter((i) => showEnded.checked || i.state === 'active');
    tbody.replaceChildren(...(shown.length ? shown.map(row) : [h('tr', h('td.empty-row', { colspan: 7 }, t('accounts.invitations.none')))]));
  }

  create.addEventListener('click', () => createInvitation().catch((err) => toast(errorText(err), 'error')));
  showEnded.addEventListener('change', render);
  onLocaleChange(render);
  live.on('accounts:changed', () => { if (visible) load(); });
  render();

  return {
    show() {
      visible = true;
      load();
    },
    hide() { visible = false; },
  };
}
