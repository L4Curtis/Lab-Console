/**
 * The way this browser last signed in ('sso', 'passkey' or 'local'), so that the login page puts that
 * button first. Only this browser's convenience (localStorage, may be blocked: every access is guarded);
 * it grants nothing and is never sent to the server
 *
 *   rememberLogin('passkey');   lastLogin()   // → 'passkey' | 'sso' | 'local' | null
 */
const KEY = 'labconsole.lastLogin';
const METHODS = new Set(['sso', 'passkey', 'local']);

export function lastLogin() {
  try {
    const value = localStorage.getItem(KEY);
    return METHODS.has(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberLogin(method) {
  if (!METHODS.has(method)) return;
  try { localStorage.setItem(KEY, method); } catch { /* blocked storage: the page still works */ }
}
