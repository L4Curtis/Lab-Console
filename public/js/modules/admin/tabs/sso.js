/**
 * Administration › Sign-in (SSO): the identity provider students and
 * teachers sign in with, set without a restart
 *
 * The client secret is write-only: the page only knows whether there is one,
 * and an empty field keeps it. "Test" fetches the provider's discovery
 * document (the server guards that request); "Try a sign-in" goes to the
 * provider with the saved settings and comes back here with the claims
 * received and the role they give, without opening a session. When the
 * environment sets the provider (OIDC_ISSUER), it wins: the page is read-only
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { errorText } from '../common.js';

const TEXT_FIELDS = ['providerName', 'issuer', 'clientId', 'scopes', 'groupsClaim', 'adminGroups', 'allowedGroups'];

export function mount(el) {
  const form = h('form.sso-form', { novalidate: true });
  const lockNotice = h('p.notice', { hidden: true });
  const secretNotice = h('p.notice.warn', { hidden: true });
  const status = h('p.form-error', { role: 'alert' });
  const testResult = h('div.sso-result', { hidden: true, 'aria-live': 'polite' });
  const trialResult = h('div.sso-result', { hidden: true, 'aria-live': 'polite' });
  const callback = h('input.field.link-field', { type: 'text', readonly: true, id: 'sso-callback' });

  const inputs = {};
  const problems = {};
  const row = (name, control, { hint } = {}) => {
    problems[name] = h('small.field-problem', { role: 'alert' });
    return h('div.sso-row', { dataset: { field: name } },
      h('label', { for: control.id, dataset: { label: name } }),
      control,
      hint ? h('small.hint', { dataset: { hint: name } }) : null,
      problems[name]);
  };
  for (const name of TEXT_FIELDS) inputs[name] = h('input.field', { id: `sso-${name}`, name, type: 'text', autocomplete: 'off', spellcheck: 'false' });
  inputs.clientSecret = h('input.field', { id: 'sso-clientSecret', name: 'clientSecret', type: 'password', autocomplete: 'new-password' });
  inputs.clearClientSecret = h('input', { id: 'sso-clearClientSecret', type: 'checkbox' });
  inputs.clientAuthMethod = h('select.field', { id: 'sso-clientAuthMethod' },
    ['client_secret_basic', 'client_secret_post'].map((v) => h('option', { value: v }, v)));
  inputs.enabled = h('input', { id: 'sso-enabled', type: 'checkbox' });
  inputs.allowInsecure = h('input', { id: 'sso-allowInsecure', type: 'checkbox' });

  const save = h('button.btn.primary', { type: 'submit', dataset: { action: 'save' } });
  const test = h('button.btn', { type: 'button', dataset: { action: 'test' } });
  const trial = h('button.btn', { type: 'button', dataset: { action: 'trial' } });
  const copy = h('button.btn.small', { type: 'button' }, icon('copy'), h('span.copy-label'));

  form.append(
    h('label.check', inputs.enabled, h('span', { dataset: { label: 'enabled' } })),
    row('providerName', inputs.providerName, { hint: true }),
    row('issuer', inputs.issuer, { hint: true }),
    row('clientId', inputs.clientId),
    row('clientSecret', inputs.clientSecret, { hint: true }),
    h('label.check', inputs.clearClientSecret, h('span', { dataset: { label: 'clearClientSecret' } })),
    row('clientAuthMethod', inputs.clientAuthMethod),
    row('scopes', inputs.scopes, { hint: true }),
    row('groupsClaim', inputs.groupsClaim, { hint: true }),
    row('adminGroups', inputs.adminGroups, { hint: true }),
    row('allowedGroups', inputs.allowedGroups, { hint: true }),
    h('label.check', inputs.allowInsecure, h('span', { dataset: { label: 'allowInsecure' } })),
    status,
    h('div.form-actions.sso-actions', test, trial, save),
  );
  el.append(h('div.panel.sso-panel',
    h('p.muted.panel-intro'),
    lockNotice,
    secretNotice,
    h('div.sso-callback', h('label', { for: 'sso-callback', dataset: { label: 'callback' } }), h('div.link-row', callback, copy), h('small.hint', { dataset: { hint: 'callback' } })),
    form,
    testResult,
    trialResult));

  let current = null;

  function fill(described) {
    current = described;
    const s = described.settings;
    inputs.enabled.checked = s.enabled;
    inputs.providerName.value = s.issuer || s.enabled ? s.providerName : '';
    inputs.issuer.value = s.issuer;
    inputs.clientId.value = s.clientId;
    inputs.clientSecret.value = '';
    inputs.clearClientSecret.checked = false;
    inputs.clientAuthMethod.value = s.clientAuthMethod;
    inputs.scopes.value = s.scopes.join(' ');
    inputs.groupsClaim.value = s.groupsClaim;
    inputs.adminGroups.value = s.adminGroups.join(', ');
    inputs.allowedGroups.value = s.allowedGroups.join(', ');
    inputs.allowInsecure.checked = s.allowInsecure;
    callback.value = described.callbackUrl;
    for (const control of [...Object.values(inputs), save]) control.disabled = described.locked;
    render();
  }

  function render() {
    for (const label of el.querySelectorAll('[data-label]')) label.textContent = t(`accounts.sso.fields.${label.dataset.label}`);
    for (const hint of el.querySelectorAll('[data-hint]')) hint.textContent = t(`accounts.sso.hints.${hint.dataset.hint}`);
    el.querySelector('.panel-intro').textContent = t('accounts.sso.intro');
    el.querySelector('.copy-label').textContent = t('accounts.links.copy');
    save.textContent = t('accounts.sso.save');
    test.textContent = t('accounts.sso.test');
    trial.textContent = t('accounts.sso.trial');
    inputs.clientSecret.placeholder = current?.settings.hasClientSecret ? t('accounts.sso.secretKept') : t('accounts.sso.secretNone');
    lockNotice.hidden = !current?.locked;
    lockNotice.textContent = t('accounts.sso.locked');
    secretNotice.hidden = !current?.secretUnreadable;
    secretNotice.textContent = t('accounts.sso.secretUnreadable');
    trial.disabled = !current?.settings.enabled;
  }

  function values() {
    const out = {
      enabled: inputs.enabled.checked,
      clientAuthMethod: inputs.clientAuthMethod.value,
      allowInsecure: inputs.allowInsecure.checked,
    };
    for (const name of TEXT_FIELDS) out[name] = inputs[name].value.trim();
    if (inputs.clientSecret.value) out.clientSecret = inputs.clientSecret.value;
    if (inputs.clearClientSecret.checked) out.clearClientSecret = true;
    return out;
  }

  function showProblems(list = []) {
    for (const p of Object.values(problems)) p.textContent = '';
    for (const { field, code } of list) {
      if (problems[field]) problems[field].textContent = t(`accounts.errors.${code}`);
    }
  }

  async function load() {
    try {
      fill(await getJson('/api/accounts/sso'));
      status.textContent = '';
    } catch (err) {
      status.textContent = errorText(err);
    }
    // Back from "try a sign-in": what the provider sent
    try {
      const { result } = await getJson('/api/accounts/sso/trial');
      if (result) showTrial(result);
    } catch { /* nothing waiting */ }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (current?.locked) return;
    save.disabled = true;
    status.textContent = '';
    showProblems();
    try {
      fill(await request('PUT', '/api/accounts/sso', values()));
      toast(t('accounts.sso.saved'));
    } catch (err) {
      showProblems(err.params?.problems);
      status.textContent = errorText(err);
    } finally {
      save.disabled = Boolean(current?.locked);
    }
  });

  test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const result = await request('POST', '/api/accounts/sso/test', { issuer: inputs.issuer.value.trim(), allowInsecure: inputs.allowInsecure.checked });
      showTest(result);
    } catch (err) {
      showTest({ ok: false, message: errorText(err) });
    } finally {
      test.disabled = false;
    }
  });

  trial.addEventListener('click', async () => {
    trial.disabled = true;
    try {
      const { url } = await request('POST', '/api/accounts/sso/trial');
      location.assign(url);
    } catch (err) {
      toast(errorText(err), 'error');
      trial.disabled = false;
    }
  });

  copy.addEventListener('click', async () => {
    callback.select();
    try {
      await navigator.clipboard.writeText(callback.value);
      toast(t('accounts.links.copied'));
    } catch {
      toast(t('accounts.links.copyByHand'), 'warn');
    }
  });

  function showTest(result) {
    testResult.hidden = false;
    testResult.dataset.ok = String(Boolean(result.ok));
    if (!result.ok) {
      testResult.replaceChildren(h('h3', t('accounts.sso.testFailed')),
        h('p', result.message ?? t(`accounts.sso.reasons.${result.reason ?? 'unreachable'}`, { status: result.status ?? '' })));
      return;
    }
    const items = Object.entries(result.endpoints).map(([name, value]) => h('div', h('dt', t(`accounts.sso.endpoints.${name}`)), h('dd', value ?? '—')));
    testResult.replaceChildren(
      h('h3', t('accounts.sso.testOk')),
      result.issuerMatches ? null : h('p.notice.warn', t('accounts.sso.issuerMismatch', { issuer: result.issuer })),
      result.pkce === false ? h('p.notice.warn', t('accounts.sso.noPkce')) : null,
      h('dl.sso-endpoints', items));
  }

  function showTrial(result) {
    trialResult.hidden = false;
    trialResult.dataset.ok = String(Boolean(result.ok));
    if (!result.ok) {
      trialResult.replaceChildren(h('h3', t('accounts.sso.trialFailed')), h('p', t(`auth.messages.${result.error === 'provider_unavailable' ? 'provider_unavailable' : 'sso_failed'}`)));
      return;
    }
    const role = result.allowed ? t(`auth.menu.roles.${result.role}`) : t('accounts.sso.trialRefused');
    trialResult.replaceChildren(
      h('h3', t('accounts.sso.trialOk')),
      h('dl.sso-endpoints',
        h('div', h('dt', t('accounts.sso.trialUser')), h('dd', result.username)),
        h('div', h('dt', t('accounts.sso.trialGroups')), h('dd', result.groups.length ? result.groups.join(', ') : '—')),
        h('div', h('dt', t('accounts.sso.trialRole')), h('dd.trial-role', role)),
        result.storedRole ? h('div', h('dt', t('accounts.sso.trialForced')), h('dd', t(`auth.menu.roles.${result.storedRole}`))) : null),
      h('details', h('summary', t('accounts.sso.trialClaims')), h('pre.sso-claims', JSON.stringify({ idToken: result.idClaims, userinfo: result.userinfo }, null, 2))));
  }

  onLocaleChange(render);
  render();
  return { show: load };
}
