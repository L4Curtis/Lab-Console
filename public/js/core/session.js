/**
 * Who is using this tab. GET /auth/me is read once, at start-up; the rest of
 * the front end reads `session.user` / `session.isAdmin` synchronously
 *
 *   await loadSession();
 *   if (session.isAdmin) …
 *
 * This is for showing or hiding things only. The server checks every action
 * again: a hidden button is not a permission
 */
import { getJson, leavingPage } from './api.js';

export const session = {
  loaded: false,
  user: null,          // User (ARCHITECTURE §5) or null when nobody is signed in
  locale: 'fr',        // server default language, for a first visit
  providerName: null,  // label of the identity provider's sign-in button; null when there is none
  passkeys: false,     // whether this site offers passkeys (https, or localhost)
  get isAdmin() { return this.user?.role === 'admin'; },
};

let pending = null;

/** Fetch /auth/me once; later calls return the same answer. Never rejects */
export function loadSession({ reload = false } = {}) {
  if (!pending || reload) {
    pending = getJson('/auth/me')
      .then((me) => {
        session.user = me?.user ?? null;
        session.locale = me?.locale ?? 'fr';
        session.providerName = me?.providerName ?? null;
        session.passkeys = me?.passkeys === true;
      })
      .catch((err) => { console.warn(`[session] /auth/me failed: ${err.message}`); })
      .then(() => { session.loaded = true; return session; });
  }
  return pending;
}

/**
 * End this browser's session and leave: to the provider's sign-out page when
 * it has one, else to the sign-in page. Never rejects
 */
export async function signOut() {
  leavingPage();
  let redirect = '/login';
  try {
    const res = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (typeof body?.redirect === 'string') redirect = body.redirect;
  } catch (err) {
    console.warn(`[session] sign-out failed: ${err.message}`);
  }
  location.assign(redirect);
}
