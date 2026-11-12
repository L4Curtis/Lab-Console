/**
 * The sign-in page (public/login.html)
 *
 * Two ways in: the identity provider's button (a plain link to /auth/login,
 * which starts the OpenID Connect redirect), and the local administrator's
 * form. The form is sent with fetch as JSON - the page's Content-Security-
 * Policy forbids native form submissions - and the three fields go together,
 * so a refusal never says which one was wrong.
 *
 * Errors coming back from the provider arrive as ?error=<reason> and are
 * shown in the visitor's language. Where to go afterwards is ?next=/path, or
 * the fragment the browser kept across the redirect to this page (the
 * application's screens are #/routes, which never reach the server). The
 * server checks it again: only a path on this site is accepted
 */
import { prefs } from './core/dom.js';
import { request } from './core/api.js';
import { loadSession } from './core/session.js';
import { initI18n, setLocale, getLocale, onLocaleChange, t, tError, has } from './core/i18n.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const next = params.get('next') || `/${location.hash}`;
const reason = params.get('error');

document.documentElement.dataset.theme = prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const session = await loadSession();
await initI18n({ defaultLocale: session.locale, namespaces: ['common', 'auth'] });

const ssoButton = $('sso-button');
const local = $('login-local');
const form = $('local-form');
const submit = $('local-submit');
const errorBox = $('local-error');
let lastError = null; // { key } or { code, params, fallback }: translated at each render, so it follows a language change

function render() {
  if (session.providerName) {
    ssoButton.textContent = t('auth.login.sso', { provider: session.providerName });
    ssoButton.href = `/auth/login?next=${encodeURIComponent(next)}`;
  }
  $('local-hint').textContent = t(session.providerName ? 'auth.login.localHint' : 'auth.login.localHintAlone');
  const message = $('login-message');
  const key = reason && has(`auth.messages.${reason}`) ? `auth.messages.${reason}` : null;
  message.hidden = !key;
  message.textContent = key ? t(key) : '';
  errorBox.hidden = !lastError;
  errorBox.textContent = !lastError ? '' : lastError.code ? tError(lastError.code, lastError.params, lastError.fallback) : t(lastError.key);
  for (const button of document.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === getLocale()));
}

$('login-sso').hidden = !session.providerName;
// Without an identity provider the local form is the only way in: show it open
local.open = !session.providerName;
render();
onLocaleChange(render);

for (const button of document.querySelectorAll('[data-lang]')) {
  button.addEventListener('click', () => setLocale(button.dataset.lang));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  values.username = String(values.username ?? '').trim();
  values.code = String(values.code ?? '').replace(/\s/g, '');
  if (!values.username || !values.password || !values.code) {
    lastError = { key: 'auth.login.missing' };
    return render();
  }
  submit.disabled = true;
  submit.textContent = t('auth.login.submitting');
  try {
    const { redirect } = await request('POST', '/auth/local', { ...values, next });
    location.assign(redirect || '/');
    return;
  } catch (err) {
    // The server's code is translated by api.js; a network failure has none
    lastError = err.status ? { code: err.code, params: err.params, fallback: err.serverMessage } : { key: 'auth.login.network' };
    form.elements.code.value = '';
    form.elements.password.value = '';
    form.elements.password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = t('auth.login.submit');
  }
  render();
});
