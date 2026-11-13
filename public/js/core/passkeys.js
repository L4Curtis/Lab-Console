/**
 * Passkeys in the browser: a thin layer over @simplewebauthn/browser (served
 * from /vendor/simplewebauthn, like xterm) and the accounts module's routes.
 * Public: the login page and the invitation page use it before any session
 *
 *   if (passkeysSupported()) await signInWithPasskey({ next })   → { redirect }
 *   await completeStep()            the passkey a password sign-in still owes → { redirect }
 *   await addPasskey(name)          My account → { passkey }
 *
 * The server keeps the challenge; the browser only carries the cookie that
 * ties it to this tab's ceremony. A user who closes the browser's dialog gets
 * an error for which isCancelled(err) is true: not worth a red message
 */
import {
  startAuthentication, startRegistration, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill,
} from '/vendor/simplewebauthn/index.js';
import { request } from './api.js';

export const passkeysSupported = () => browserSupportsWebAuthn();
export const autofillSupported = () => browserSupportsWebAuthnAutofill().catch(() => false);

/** The person closed the browser's dialog, or another ceremony replaced this one */
export const isCancelled = (err) => ['NotAllowedError', 'AbortError'].includes(err?.name)
  || ['NotAllowedError', 'AbortError'].includes(err?.cause?.name)
  || err?.code === 'ERROR_CEREMONY_ABORTED';

/**
 * Sign in with any passkey of this site. `autofill`: offer it in the user
 * name field's suggestions (conditional UI) instead of a dialog; the promise
 * then waits until the person picks one
 */
export async function signInWithPasskey({ next, autofill = false } = {}) {
  const { options } = await request('POST', '/auth/passkey/options', {});
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
  return request('POST', '/auth/passkey/verify', { response, next });
}

/** Register (first time) or use the passkey a password sign-in still owes */
export async function completeStep() {
  const { kind, options } = await request('POST', '/auth/passkey/step/options', {});
  const response = kind === 'passkey-enrol'
    ? await startRegistration({ optionsJSON: options })
    : await startAuthentication({ optionsJSON: options });
  return request('POST', '/auth/passkey/step/verify', { response });
}

/** Add a passkey to the signed-in account */
export async function addPasskey(name) {
  const { options } = await request('POST', '/api/accounts/me/passkeys/options', {});
  const response = await startRegistration({ optionsJSON: options });
  return request('POST', '/api/accounts/me/passkeys', { response, name });
}
