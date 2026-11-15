/**
 * "Mon compte" (#/account), for everyone signed in; reached from the account
 * menu (the rail) or from Plus (a phone). A column of cards (docs/v2/UX.md §10.11):
 *
 *   - Profil: name, identifiant, role, how they sign in (a local account may
 *     rename itself); SSO accounts: as the provider gives them; the
 *     environment's administrator: changed in the server's configuration only;
 *   - Mot de passe: local accounts (the other sessions end);
 *   - Clés d'accès: add, rename, remove (an administrator keeps one);
 *   - Sessions: their open sessions, and "sign out everywhere else";
 *   - Préférences: theme and language, the same controls as the account menu
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { request, getJson } from '../../core/api.js';
import { loading, loadFailure } from '../../shared/loadState.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { confirmDialog, formDialog } from '../../shared/dialog.js';
import { dataList } from '../../shared/dataList.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { preferenceRows } from '../../core/userMenu.js';
import { addPasskey, isCancelled } from '../../core/passkeys.js';
import { fmtLong } from '../../core/format.js';
import { tagRows, stateBadge } from '../admin/common.js';

export async function mount(el) {
  await Promise.all([loadNamespace('accounts'), loadCss('accounts')]);
  const header = pageHeader({ title: 'accounts.me.title', context: 'accounts.me.subtitle' });
  const body = h('div.stack.account-panel');
  el.append(header.el, h('div.view-body', body));
  let me = null;

  async function load() {
    if (!me) body.replaceChildren(loading());
    try {
      me = await getJson('/api/accounts/me');
    } catch (err) {
      body.replaceChildren(loadFailure('accounts.me.loadFailed', err, load));
      return;
    }
    render();
  }

  const card = (titleKey, ...content) => h('section.card.account-card', h('div.card-head', h('h2', t(titleKey))), h('div.card-body', ...content));

  function identityCard() {
    const a = me.account;
    const via = a.environment ? t('accounts.users.viaEnvironment') : a.via === 'oidc' ? t('accounts.me.viaSso', { provider: session.providerName ?? 'SSO' }) : t('accounts.users.viaLocal');
    const rows = h('dl.account-facts',
      h('div', h('dt', t('accounts.me.name')), h('dd.me-name', a.name)),
      h('div', h('dt', t('accounts.me.username')), h('dd.mono', a.username)),
      h('div', h('dt', t('accounts.me.role')), h('dd.me-role', t(`auth.menu.roles.${a.role}`))),
      h('div', h('dt', t('accounts.me.via')), h('dd', via)));
    const note = a.environment ? t('accounts.me.environmentNote') : a.via === 'oidc' ? t('accounts.me.ssoNote') : null;
    const foot = me.canChangePassword ? h('div.card-foot', h('button.btn.sm', { type: 'button', dataset: { action: 'rename' }, onclick: rename }, icon('edit'), t('accounts.me.rename'))) : null;
    const el = card('accounts.me.identity', rows, note ? h('p.muted', note) : null);
    el.dataset.card = 'profile';
    if (foot) el.append(foot);
    return el;
  }

  function passwordCard() {
    if (!me.canChangePassword) return null; // SSO accounts and the environment's administrator have none here
    const el = card('accounts.me.password', h('p.muted', t('accounts.me.passwordCard')));
    el.dataset.card = 'password';
    el.append(h('div.card-foot', h('button.btn.sm', { type: 'button', dataset: { action: 'password' }, onclick: changePassword }, icon('lock'), t('accounts.me.changePassword'))));
    return el;
  }

  function passkeysCard() {
    if (!me.canChangePassword) return null; // SSO accounts and the environment's administrator have none here
    const list = h('ul.passkey-list', me.passkeys.map((p) => h('li', { dataset: { passkey: p.id } },
      icon('key'),
      h('div.passkey-text', h('strong', p.name), h('span.vm-meta', t('accounts.me.passkeyDates', { created: fmtLong(p.createdAt), used: fmtLong(p.lastUsedAt) }))),
      h('div.row-actions',
        h('button.btn.sm', { type: 'button', dataset: { action: 'rename-passkey' }, onclick: () => renamePasskey(p) }, t('accounts.me.renamePasskey')),
        h('button.btn.sm.danger', { type: 'button', dataset: { action: 'remove-passkey' }, onclick: () => removePasskey(p) }, t('accounts.me.removePasskey'))))));
    const intro = me.account.role === 'admin' ? t('accounts.me.passkeysAdmin') : t('accounts.me.passkeysStudent');
    const add = h('button.btn.primary.sm', { type: 'button', dataset: { action: 'add-passkey' }, disabled: !me.canAddPasskeys, onclick: () => register(add) }, icon('plus'), t('accounts.me.addPasskey'));
    const el = card('accounts.me.passkeys', h('p.muted', intro),
      me.passkeys.length ? list : h('p.muted', t('accounts.me.noPasskey')),
      me.passkeysAvailable ? null : h('p.notice', t('accounts.me.passkeysUnavailable')));
    el.dataset.card = 'passkeys';
    el.append(h('div.card-foot', add));
    return el;
  }

  const sessionList = dataList({
    label: () => t('accounts.me.sessions'),
    dense: true,
    rowKey: (s) => s.id,
    columns: [
      {
        id: 'device', label: () => t('accounts.me.columns.device'), primary: true,
        cell: (s) => h('div.account-cell', h('strong', s.userAgent ? shortAgent(s.userAgent) : t('accounts.me.unknownBrowser')),
          s.current ? h('div.account-notes', stateBadge('active', t('accounts.me.thisSession'))) : null),
      },
      { id: 'ip', label: () => t('accounts.me.columns.ip'), cell: (s) => h('span.mono', s.ip || '—'), hideCompact: true },
      { id: 'since', label: () => t('accounts.me.columns.since'), cell: (s) => fmtLong(s.createdAt), hideCompact: true },
      { id: 'seen', label: () => t('accounts.me.columns.seen'), cell: (s) => t('accounts.me.seen', { date: fmtLong(s.lastSeenAt) }), meta: true },
    ],
    actions: (s) => (s.current ? [] : [{ id: 'end-session', label: 'accounts.me.endSession', icon: 'close', primary: true, run: () => endSession(s) }]),
  });
  tagRows(sessionList, (s) => ({ session: s.id, current: s.current }));

  function sessionsCard() {
    sessionList.render(me.sessions);
    const others = me.sessions.filter((s) => !s.current).length;
    const el = h('section.card.account-card', { dataset: { card: 'sessions' } },
      h('div.card-head', h('h2', t('accounts.me.sessions'))),
      sessionList.el,
      h('div.card-foot', h('button.btn.sm.ghost.danger', { type: 'button', dataset: { action: 'end-others' }, disabled: !others, onclick: endOthers }, icon('logout'), t('accounts.me.endOthers'))));
    return el;
  }

  /** The same controls as the account menu: they apply at once */
  function preferencesCard() {
    const el = card('accounts.me.preferences', ...preferenceRows());
    el.dataset.card = 'preferences';
    return el;
  }

  function render() {
    if (!me) return;
    body.replaceChildren(identityCard(), ...[passwordCard(), passkeysCard()].filter(Boolean), sessionsCard(), preferencesCard());
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
      if (!isCancelled(err)) toast(err.status ? err.message : t('auth.step.failed'), 'error', 7000);
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
      toast(err.message, 'error', 7000);
    }
    await load();
  }

  async function endSession(s) {
    try {
      await request('DELETE', `/api/accounts/me/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      toast(err.message, 'error');
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
      toast(err.message, 'error');
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
