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
import { getJson } from './api.js';

export const session = {
  loaded: false,
  user: null,          // User (ARCHITECTURE §5) or null when nobody is signed in
  mode: 'on',          // 'on' | 'off' (AUTH_MODE)
  locale: 'fr',        // server default language, for a first visit
  providerName: null,  // label of the sign-in button
  get isAdmin() { return this.user?.role === 'admin'; },
  get isAnonymous() { return this.user?.via === 'anonymous'; },
};

let pending = null;

/** Fetch /auth/me once; later calls return the same answer. Never rejects */
export function loadSession({ reload = false } = {}) {
  if (!pending || reload) {
    pending = getJson('/auth/me')
      .then((me) => {
        session.user = me?.user ?? null;
        session.mode = me?.mode ?? 'on';
        session.locale = me?.locale ?? 'fr';
        session.providerName = me?.providerName ?? null;
      })
      .catch((err) => { console.warn(`[session] /auth/me failed: ${err.message}`); })
      .then(() => { session.loaded = true; return session; });
  }
  return pending;
}
