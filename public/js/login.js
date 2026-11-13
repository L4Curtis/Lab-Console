/**
 * The sign-in page (public/login.html)
 *
 * Three ways in: the identity provider's button (a plain link to /auth/login,
 * which starts the OpenID Connect redirect); a passkey, in one click (or from
 * the user name field's suggestions where the browser offers that); and the
 * local form - local accounts and the environment's administrator. The form
 * is sent with fetch as JSON - the page's Content-Security-Policy forbids
 * native form submissions - and its fields go together, so a refusal never
 * says which one was wrong, nor whether the account exists.
 *
 * An administrator's local account owes a passkey after its password: the
 * server answers { step } instead of a session, and the page asks for the
 * passkey (or to register one, the first time) before going on.
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
import { passkeysSupported, autofillSupported, signInWithPasskey, completeStep, isCancelled } from './core/passkeys.js';

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
const passkeyButton = $('passkey-button');
const stepBox = $('login-step');
const stepButton = $('step-button');
const offerPasskeys = Boolean(session.passkeys) && passkeysSupported();
// Messages are kept as { key } or { code, params, fallback } and translated at each render: they follow a language change
let lastError = null;
let passkeyError = null;
let stepError = null;
let step = null; // 'passkey' | 'passkey-enrol' while a password sign-in waits for its passkey
let busy = false;

const translate = (m) => (!m ? '' : m.code ? tError(m.code, m.params, m.fallback) : t(m.key));
const fromError = (err, networkKey) => (err.status ? { code: err.code, params: err.params, fallback: err.serverMessage } : { key: networkKey });
const show = (el, message) => {
  el.hidden = !message;
  el.textContent = translate(message);
};

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
  show(errorBox, lastError);
  show($('passkey-error'), passkeyError);
  show($('step-error'), stepError);
  if (step) {
    $('step-title').textContent = t(step === 'passkey-enrol' ? 'auth.step.enrolTitle' : 'auth.step.useTitle');
    $('step-text').textContent = t(step === 'passkey-enrol' ? 'auth.step.enrolText' : 'auth.step.useText');
    stepButton.textContent = t(busy ? 'auth.step.waiting' : step === 'passkey-enrol' ? 'auth.step.enrol' : 'auth.step.use');
  }
  for (const button of document.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === getLocale()));
}

/** Show the form, or the passkey step in its place */
function setStep(kind) {
  step = kind;
  stepError = null;
  stepBox.hidden = !step;
  local.hidden = Boolean(step);
  $('login-sso').hidden = Boolean(step) || !session.providerName;
  $('login-extra').hidden = Boolean(step) || !offerPasskeys;
  render();
  if (step) stepButton.focus();
}

$('login-sso').hidden = !session.providerName;
$('login-extra').hidden = !offerPasskeys;
// Without an identity provider the local form is the main way in: show it open
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
  if (!values.username || !values.password) {
    lastError = { key: 'auth.login.missing' };
    return render();
  }
  submit.disabled = true;
  submit.textContent = t('auth.login.submitting');
  try {
    const answer = await request('POST', '/auth/local', { ...values, next });
    if (answer.step) {
      lastError = null;
      form.reset();
      setStep(answer.step);
      return;
    }
    location.assign(answer.redirect || '/');
    return;
  } catch (err) {
    // The server's code is translated by api.js; a network failure has none
    lastError = fromError(err, 'auth.login.network');
    form.elements.code.value = '';
    form.elements.password.value = '';
    form.elements.password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = t('auth.login.submit');
  }
  render();
});

// ── The passkey a password sign-in still owes ─────────────────────────────
stepButton.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  stepButton.disabled = true;
  stepError = null;
  render();
  try {
    const { redirect } = await completeStep();
    location.assign(redirect || '/');
    return;
  } catch (err) {
    if (isCancelled(err)) {
      stepError = { key: 'auth.step.cancelled' };
    } else if (err.status === 401) {
      // The step is over (refused, or too old): back to the password
      lastError = fromError(err, 'auth.login.network');
      setStep(null);
      local.open = true;
    } else {
      stepError = err.status ? fromError(err, 'auth.login.network') : { key: 'auth.step.failed' };
    }
  } finally {
    busy = false;
    stepButton.disabled = false;
  }
  render();
});
$('step-restart').addEventListener('click', () => {
  setStep(null);
  local.open = true;
});

// ── One click with a passkey ──────────────────────────────────────────────
async function passkeySignIn({ autofill = false } = {}) {
  try {
    const { redirect } = await signInWithPasskey({ next, autofill });
    location.assign(redirect || '/');
  } catch (err) {
    if (autofill || isCancelled(err)) return; // a suggestion nobody picked, a dialog closed
    passkeyError = err.status ? fromError(err, 'auth.login.network') : { key: 'auth.login.passkeyFailed' };
    render();
  }
}

passkeyButton.addEventListener('click', () => {
  passkeyError = null;
  render();
  passkeySignIn();
});

// Where the browser can, the suggestions under the user name field include
// this site's passkeys (conditional UI). Offered once the local form is open,
// which is where a person goes to type a user name
let autofillOffered = false;
async function offerAutofill() {
  if (autofillOffered || !offerPasskeys || !local.open || step) return;
  autofillOffered = true;
  if (await autofillSupported()) passkeySignIn({ autofill: true });
}
local.addEventListener('toggle', offerAutofill);
offerAutofill();
