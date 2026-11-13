/**
 * "My account" (#/account), for everyone signed in; reached from the user
 * menu at the bottom of the rail
 *
 *   - local accounts: display name, password change (the other sessions
 *     end), passkeys (add, rename, remove; an administrator keeps one);
 *   - SSO accounts: name and role as the provider gives them, nothing to
 *     change here;
 *   - the environment's administrator: changed in the server's
 *     configuration only;
 *   - everyone: their open sessions, and "sign out everywhere else"
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { request, getJson } from '../../core/api.js';
import { t, tNode, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { confirmDialog, formDialog } from '../../shared/dialog.js';
import { addPasskey, isCancelled } from '../../core/passkeys.js';
import { formatDate, errorText } from '../admin/common.js';

export async function mount(el) {
  await Promise.all([loadNamespace('accounts'), loadCss('accounts')]);
  el.append(h('header.view-head', h('div.view-title', h('h1', tNode('accounts.me.title')), h('p', tNode('accounts.me.subtitle')))));
  const body = h('div.panel.account-panel');
  el.append(h('div.account-scroll', body));
  let me = null;

  async function load() {
    try {
      me = await getJson('/api/accounts/me');
    } catch (err) {
      body.replaceChildren(h('p.form-error', { role: 'alert' }, errorText(err)));
      return;
    }
    render();
  }

  const card = (titleKey, ...content) => h('section.account-card', h('h2', t(titleKey)), ...content);

  function identityCard() {
    const a = me.account;
    const via = a.environment ? t('accounts.users.viaEnvironment') : a.via === 'oidc' ? t('accounts.me.viaSso', { provider: session.providerName ?? 'SSO' }) : t('accounts.users.viaLocal');
    const rows = h('dl.account-facts',
      h('div', h('dt', t('accounts.me.name')), h('dd.me-name', a.name)),
      h('div', h('dt', t('accounts.me.username')), h('dd', a.username)),
      h('div', h('dt', t('accounts.me.role')), h('dd.me-role', t(`auth.menu.roles.${a.role}`))),
      h('div', h('dt', t('accounts.me.via')), h('dd', via)));
    const actions = [];
    if (me.canChangePassword) {
      actions.push(h('button.btn.small', { type: 'button', dataset: { action: 'rename' }, onclick: rename }, t('accounts.me.rename')));
      actions.push(h('button.btn.small', { type: 'button', dataset: { action: 'password' }, onclick: changePassword }, t('accounts.me.changePassword')));
    }
    const note = a.environment ? t('accounts.me.environmentNote') : a.via === 'oidc' ? t('accounts.me.ssoNote') : null;
    return card('accounts.me.identity', rows, note ? h('p.muted', note) : null, actions.length ? h('div.row-actions', actions) : null);
  }

  function passkeysCard() {
    if (!me.canChangePassword) return null; // SSO accounts and the environment's administrator have none here
    const list = h('ul.passkey-list', me.passkeys.map((p) => h('li', { dataset: { passkey: p.id } },
      icon('key'),
      h('div.passkey-text', h('strong', p.name), h('span.vm-meta', t('accounts.me.passkeyDates', { created: formatDate(p.createdAt), used: formatDate(p.lastUsedAt) }))),
      h('div.row-actions',
        h('button.btn.small', { type: 'button', dataset: { action: 'rename-passkey' }, onclick: () => renamePasskey(p) }, t('accounts.me.renamePasskey')),
        h('button.btn.small.danger', { type: 'button', dataset: { action: 'remove-passkey' }, onclick: () => removePasskey(p) }, t('accounts.me.removePasskey'))))));
    const intro = me.account.role === 'admin' ? t('accounts.me.passkeysAdmin') : t('accounts.me.passkeysStudent');
    const add = h('button.btn.primary.small', { type: 'button', dataset: { action: 'add-passkey' }, disabled: !me.canAddPasskeys, onclick: () => register(add) }, icon('plus'), t('accounts.me.addPasskey'));
    return card('accounts.me.passkeys', h('p.muted', intro),
      me.passkeys.length ? list : h('p.muted', t('accounts.me.noPasskey')),
      me.passkeysAvailable ? null : h('p.notice', t('accounts.me.passkeysUnavailable')),
      h('div.row-actions', add));
  }

  function sessionsCard() {
    const items = me.sessions.map((s) => h('li', { dataset: { session: s.id, current: String(s.current) } },
      h('div.passkey-text',
        h('strong', s.current ? t('accounts.me.thisSession') : s.userAgent ? shortAgent(s.userAgent) : t('accounts.me.unknownBrowser')),
        h('span.vm-meta', t('accounts.me.sessionDates', { ip: s.ip || '—', since: formatDate(s.createdAt), seen: formatDate(s.lastSeenAt) }))),
      s.current ? null : h('button.btn.small', { type: 'button', onclick: () => endSession(s) }, t('accounts.me.endSession'))));
    const others = me.sessions.filter((s) => !s.current).length;
    return card('accounts.me.sessions', h('ul.passkey-list', items),
      h('div.row-actions', h('button.btn.small', { type: 'button', dataset: { action: 'end-others' }, disabled: !others, onclick: endOthers }, t('accounts.me.endOthers'))));
  }

  function render() {
    if (!me) return;
    body.replaceChildren(identityCard(), ...[passkeysCard()].filter(Boolean), sessionsCard());
  }

  async function rename() {
    const done = await formDialog({
      title: t('accounts.me.rename'),
      fields: [{ name: 'name', label: t('accounts.me.name'), value: me.account.name, required: true, attrs: { maxlength: 64 } }],
      submitLabel: t('accounts.me.save'),
      onSubmit: (values) => request('PATCH', '/api/accounts/me', { name: values.name }),
    });
    if (done) {
      toast(t('accounts.me.renamed'));
      await load();
    }
  }

  async function changePassword() {
    const done = await formDialog({
      title: t('accounts.me.changePassword'),
      intro: [t('accounts.me.passwordIntro')],
      fields: [
        { name: 'current', label: t('accounts.me.currentPassword'), type: 'password', required: true, attrs: { autocomplete: 'current-password' } },
        { name: 'password', label: t('accounts.me.newPassword'), type: 'password', required: true, hint: t('accounts.join.passwordHint'), attrs: { autocomplete: 'new-password', minlength: 10 } },
        { name: 'confirm', label: t('accounts.join.confirm'), type: 'password', required: true, attrs: { autocomplete: 'new-password' } },
      ],
      submitLabel: t('accounts.me.save'),
      validate: (v) => (!v.current || !v.password ? t('accounts.join.missing') : v.password !== v.confirm ? t('accounts.join.mismatch') : ''),
      onSubmit: (v) => request('POST', '/api/accounts/me/password', { current: v.current, password: v.password }),
    });
    if (done) {
      toast(t('accounts.me.passwordChanged', { count: done.sessionsEnded ?? 0 }));
      await load();
    }
  }

  async function register(button) {
    button.disabled = true;
    try {
      const name = guessDeviceName();
      await addPasskey(name);
      toast(t('accounts.me.passkeyAdded'));
    } catch (err) {
      if (!isCancelled(err)) toast(err.status ? errorText(err) : t('auth.step.failed'), 'error', 7000);
    } finally {
      button.disabled = false;
    }
    await load();
  }

  async function renamePasskey(passkey) {
    const done = await formDialog({
      title: t('accounts.me.renamePasskey'),
      fields: [{ name: 'name', label: t('accounts.me.passkeyName'), value: passkey.name, required: true, attrs: { maxlength: 64 } }],
      submitLabel: t('accounts.me.save'),
      onSubmit: (v) => request('PATCH', `/api/accounts/me/passkeys/${encodeURIComponent(passkey.id)}`, { name: v.name }),
    });
    if (done) await load();
  }

  async function removePasskey(passkey) {
    const ok = await confirmDialog({ title: t('accounts.me.removePasskey'), body: t('accounts.me.removeBody', { name: passkey.name }), confirmLabel: t('accounts.me.removePasskey'), danger: true });
    if (!ok) return;
    try {
      await request('DELETE', `/api/accounts/me/passkeys/${encodeURIComponent(passkey.id)}`);
      toast(t('accounts.me.passkeyRemoved'));
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    }
    await load();
  }

  async function endSession(s) {
    try {
      await request('DELETE', `/api/accounts/me/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
    await load();
  }

  async function endOthers() {
    const ok = await confirmDialog({ title: t('accounts.me.endOthers'), body: t('accounts.me.endOthersBody'), confirmLabel: t('accounts.me.endOthers') });
    if (!ok) return;
    try {
      const { ended } = await request('POST', '/api/accounts/me/sessions/end-others');
      toast(t('accounts.me.ended', { count: ended }));
    } catch (err) {
      toast(errorText(err), 'error');
    }
    await load();
  }

  onLocaleChange(render);
  return { show: load };
}

/** "Chrome · Linux" from a user agent: enough to recognise one's own browsers */
function shortAgent(agent) {
  const os = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac OS/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' · ') || agent.slice(0, 40);
}

const guessDeviceName = () => shortAgent(navigator.userAgent);
