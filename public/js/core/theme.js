/**
 * Light, dark, or the system's choice ("auto", the default): the preference
 * is stored with prefs (labconsole.theme), the theme on screen is
 * data-theme="light|dark" on <html>, so CSS and the terminals only ever see
 * one of two values. With "auto" the page follows the system live
 *
 *   initTheme();            // every page, as early as possible
 *   setTheme('dark');       // the account menu's segmented control
 *   themePref();            // 'light' | 'dark' | 'auto'
 *
 * A change of the theme on screen fires `themechange` on window (detail: the theme)
 */
import { prefs } from './dom.js';

export const THEMES = ['light', 'dark', 'auto'];
const dark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let started = false;

export function themePref() {
  const stored = prefs.get('theme', 'auto');
  return THEMES.includes(stored) ? stored : 'auto';
}

function apply() {
  const pref = themePref();
  const theme = pref === 'auto' ? (dark?.matches ? 'dark' : 'light') : pref;
  const root = document.documentElement;
  root.dataset.themePref = pref;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

export function initTheme() {
  apply();
  if (started) return;
  started = true;
  dark?.addEventListener('change', apply);
  // Another tab of the same browser changed it
  addEventListener('storage', (e) => { if (e.key === 'labconsole.theme') apply(); });
}

export function setTheme(pref) {
  if (!THEMES.includes(pref)) return;
  prefs.set('theme', pref);
  apply();
}
