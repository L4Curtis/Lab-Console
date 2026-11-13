/**
 * The page of an invitation (/join#<token>) or of a password reset link
 * (/reset#<token>), public/join.html. Served without a session
 *
 * The token is in the fragment, which the browser never sends to a server;
 * the page reads it, takes it out of the address bar, and posts it with
 * each request. The server says what the link offers (or one message for
 * every unusable link), then:
 *   - invitation: user name, display name, password twice. A link for one
 *     person gives an active account and signs it in at once (an
 *     administrator registers a passkey first); a link for several people
 *     gives an account that waits for an administrator's approval;
 *   - reset: a new password twice; the account's sessions end, and the
 *     person signs in again on the login page
 */
import { prefs } from './core/dom.js';
import { request } from './core/api.js';
import { loadSession } from './core/session.js';
import { initI18n, setLocale, getLocale, onLocaleChange, t, tError } from './core/i18n.js';
import { completeStep, isCancelled } from './core/passkeys.js';

const $ = (id) => document.getElementById(id);
const mode = location.pathname === '/reset' ? 'reset' : 'join';
const token = location.hash.replace(/^#/, '');
// Out of the address bar: not in the history, not on a screen someone photographs
history.replaceState(null, '', location.pathname);

document.documentElement.dataset.theme = prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const session = await loadSession();
await initI18n({ defaultLocale: session.locale, namespaces: ['common', 'auth', 'accounts'] });

const form = $('join-form');
const submit = $('join-submit');
let offer = null;     // what the link offers, once known
let message = null;   // { key, params } shown above the form
let error = null;     // { key } or { code, params, fallback } under the form
let stepError = null;
let state = 'loading'; // loading | form | step | done | invalid
let busy = false;

const translate = (m) => (!m ? '' : m.code ? tError(m.code, m.params, m.fallback) : t(m.key, m.params));
const fromError = (err) => (err.status ? { code: err.code, params: err.params, fallback: err.serverMessage } : { key: 'accounts.join.network' });

function render() {
  $('join-title').textContent = t(mode === 'reset' ? 'accounts.reset.title' : 'accounts.join.title');
  const sub = state === 'form' && offer ? (mode === 'reset'
    ? t('accounts.reset.for', { username: offer.username })
    : t(offer.approval ? 'accounts.join.offerApproval' : 'accounts.join.offer', { role: t(`auth.menu.roles.${offer.role}`) }))
    : '';
  $('join-sub').textContent = sub;
  $('join-message').hidden = !message;
  $('join-message').textContent = translate(message);
  $('join-box').hidden = state !== 'form';
  $('signup-fields').hidden = mode === 'reset';
  $('join-step').hidden = state !== 'step';
  $('join-done').hidden = !(state === 'done' || state === 'invalid');
  $('join-error').hidden = !error;
  $('join-error').textContent = translate(error);
  $('join-step-error').hidden = !stepError;
  $('join-step-error').textContent = translate(stepError);
  submit.textContent = t(busy ? 'accounts.join.sending' : mode === 'reset' ? 'accounts.reset.submit' : 'accounts.join.submit');
  for (const button of document.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === getLocale()));
}

for (const button of document.querySelectorAll('[data-lang]')) button.addEventListener('click', () => setLocale(button.dataset.lang));
onLocaleChange(render);

try {
  offer = await request('POST', mode === 'reset' ? '/auth/reset-link' : '/auth/invitation', { token });
  state = 'form';
} catch (err) {
  state = 'invalid';
  message = err.status ? fromError(err) : { key: 'accounts.join.network' };
}
render();
if (state === 'form') (mode === 'reset' ? $('join-password') : $('join-username')).focus();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const values = Object.fromEntries(new FormData(form));
  if (mode === 'join' && (!String(values.username ?? '').trim() || !String(values.name ?? '').trim())) {
    error = { key: 'accounts.join.missing' };
    return render();
  }
  if (!values.password) {
    error = { key: 'accounts.join.missing' };
    return render();
  }
  if (values.password !== values.confirm) {
    error = { key: 'accounts.join.mismatch' };
    form.elements.confirm.value = '';
    form.elements.confirm.focus();
    return render();
  }
  busy = true;
  submit.disabled = true;
  error = null;
  render();
  try {
    if (mode === 'reset') {
      await request('POST', '/auth/reset', { token, password: values.password });
      state = 'done';
      message = { key: 'accounts.reset.done' };
    } else {
      const answer = await request('POST', '/auth/signup', { token, username: values.username.trim(), name: values.name.trim(), password: values.password });
      if (answer.redirect) {
        location.assign(answer.redirect);
        return;
      }
      if (answer.step) {
        state = 'step';
        message = { key: 'accounts.join.created' };
      } else {
        state = 'done';
        message = { key: 'accounts.join.pending' };
      }
    }
    form.reset();
  } catch (err) {
    error = fromError(err);
    if (err.code === 'accounts.link_invalid') {
      state = 'invalid';
      message = error;
      error = null;
    }
  } finally {
    busy = false;
    submit.disabled = false;
  }
  render();
  if (state === 'step') $('join-step-button').focus();
});

// ── A new administrator's passkey ─────────────────────────────────────────
$('join-step-button').addEventListener('click', async () => {
  const button = $('join-step-button');
  if (button.disabled) return;
  button.disabled = true;
  stepError = null;
  render();
  try {
    const { redirect } = await completeStep();
    location.assign(redirect || '/');
    return;
  } catch (err) {
    if (isCancelled(err)) stepError = { key: 'auth.step.cancelled' };
    else if (err.status === 401) {
      // The account exists: from now on it signs in on the login page, password then passkey
      state = 'done';
      message = { key: 'accounts.join.stepExpired' };
    } else stepError = err.status ? fromError(err) : { key: 'auth.step.failed' };
  } finally {
    button.disabled = false;
  }
  render();
});
