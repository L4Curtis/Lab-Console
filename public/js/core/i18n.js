/**
 * Translations: every string the user sees goes through t()
 *
 *   await loadNamespace('benches');              // public/locales/<lang>/benches.json
 *   t('benches.take.confirm', { bench: 'B4M' })  // "Prendre la baie {bench} ?" → "Prendre la baie B4M ?"
 *
 * A key is `<namespace>.<path.in.the.file>`. Lookup order: the current
 * language, then English, then the key itself - a missing translation shows
 * up as its key instead of breaking the screen. The language is the user's
 * own choice (kept with the other preferences in this browser); on a first
 * visit it is the server's DEFAULT_LOCALE, served by /auth/me
 *
 * Plurals: when the entry is an object and `count` is given, the form is
 * picked for the language: { "one": "{count} ligne", "other": "{count} lignes" }
 *
 * This file has no dependency on the rest of the app except the preferences
 * helper, so the login page can use it too
 */
import { prefs } from './dom.js';

export const LOCALES = ['fr', 'en'];
const FALLBACK = 'en';
const PREF_KEY = 'locale';

let locale = 'fr';
const namespaces = new Set();    // every namespace asked for so far
const dictionaries = new Map();  // "fr/common" → parsed file
const loading = new Map();       // "fr/common" → promise
const listeners = new Set();

const supported = (value) => (LOCALES.includes(value) ? value : null);

function fetchDictionary(lang, ns) {
  const id = `${lang}/${ns}`;
  if (dictionaries.has(id)) return Promise.resolve();
  if (!loading.has(id)) {
    loading.set(id, fetch(`/locales/${lang}/${ns}.json`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => { dictionaries.set(id, data); })
      // A missing dictionary must not block the screen: its keys show as keys
      .catch((err) => { console.warn(`[i18n] ${id} could not be loaded: ${err.message}`); })
      .finally(() => loading.delete(id)));
  }
  return loading.get(id);
}

/** Load one namespace (or several) for the current language and for the English fallback */
export async function loadNamespace(...names) {
  const wanted = names.flat();
  for (const ns of wanted) namespaces.add(ns);
  const langs = locale === FALLBACK ? [FALLBACK] : [locale, FALLBACK];
  await Promise.all(wanted.flatMap((ns) => langs.map((lang) => fetchDictionary(lang, ns))));
}

function lookup(lang, ns, path) {
  let node = dictionaries.get(`${lang}/${ns}`);
  for (const part of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

function pluralForm(entry, lang, params) {
  if (entry === null || typeof entry !== 'object') return entry;
  const count = Number(params?.count);
  const form = Number.isFinite(count) ? new Intl.PluralRules(lang).select(count) : 'other';
  return entry[form] ?? entry.other;
}

const interpolate = (text, params) =>
  (params ? text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined || params[name] === null ? whole : String(params[name]))) : text);

/** Translate `key`; `{name}` placeholders are replaced from `params`. Never throws */
export function t(key, params) {
  const [ns, ...path] = String(key).split('.');
  for (const lang of locale === FALLBACK ? [FALLBACK] : [locale, FALLBACK]) {
    const text = pluralForm(lookup(lang, ns, path), lang, params);
    if (typeof text === 'string') return interpolate(text, params);
  }
  return String(key);
}

/** True when `key` has a translation (in the current language or the fallback) */
export function has(key) {
  const [ns, ...path] = String(key).split('.');
  return [locale, FALLBACK].some((lang) => {
    const entry = lookup(lang, ns, path);
    return typeof entry === 'string' || (entry !== null && typeof entry === 'object' && typeof entry.other === 'string');
  });
}

/**
 * The message for an API error (ARCHITECTURE §4). The code `module.reason`
 * is looked up as `<module>.errors.<reason>` in the module's own namespace,
 * then as `common.errors.<module>.<reason>`; unknown codes keep the server's
 * English sentence
 */
export function tError(code, params, fallback) {
  if (code) {
    const [module, ...reason] = String(code).split('.');
    for (const key of [`${module}.errors.${reason.join('.')}`, `common.errors.${code}`]) {
      if (has(key)) return t(key, params);
    }
  }
  return fallback ?? String(code ?? '');
}

export function getLocale() {
  return locale;
}

/**
 * Switch language: loads every namespace in use, remembers the choice in
 * this browser, translates the static markup again and tells the listeners
 */
export async function setLocale(next, { persist = true } = {}) {
  const chosen = supported(next);
  if (!chosen) throw new RangeError(`Unsupported locale "${next}"`);
  locale = chosen;
  if (persist) prefs.set(PREF_KEY, chosen);
  await loadNamespace(...namespaces);
  apply();
  for (const fn of listeners) fn(chosen);
  return chosen;
}

/** Called after each language change; returns the function that unsubscribes */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Start-up: pick the language (saved choice, else the server default) and
 * load the shared strings. Call once, before building any screen
 */
export async function initI18n({ defaultLocale, namespaces: initial = ['common'] } = {}) {
  locale = supported(prefs.get(PREF_KEY, null)) || supported(defaultLocale) || 'fr';
  await loadNamespace(...initial);
  apply();
  return locale;
}

const ATTRIBUTES = { i18nTitle: 'title', i18nAriaLabel: 'aria-label', i18nPlaceholder: 'placeholder' };

/**
 * Static markup: <span data-i18n="common.actions.cancel"></span>, plus
 * data-i18n-title / data-i18n-aria-label / data-i18n-placeholder for
 * attributes. Applied again by itself whenever the language changes
 */
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [data, attr] of Object.entries(ATTRIBUTES)) {
    for (const el of root.querySelectorAll(`[data-${data.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`)) el.setAttribute(attr, t(el.dataset[data]));
  }
}

function apply() {
  if (typeof document === 'undefined') return; // unit tests run without a DOM
  document.documentElement.lang = locale;
  translateDom(document);
}
