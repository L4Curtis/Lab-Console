/**
 * Translations: the dictionaries (every key exists in French and in English)
 * and the browser runtime (public/js/core/i18n.js), which is plain enough to
 * run here with a stubbed fetch and localStorage
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/app.js';

const localesDir = path.join(repoRoot, 'public', 'locales');

/** { 'actions.cancel': 'Annuler', … } - plural objects count as one entry */
function flatten(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) flatten(value, at, out);
    else out[at] = value;
  }
  return out;
}
const namespacesOf = (lang) => fs.readdirSync(path.join(localesDir, lang)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const dictionary = (lang, ns) => JSON.parse(fs.readFileSync(path.join(localesDir, lang, `${ns}.json`), 'utf8'));
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// ── Dictionaries ────────────────────────────────────────────────────────────

test('locales: the same namespaces exist in fr and en', () => {
  assert.deepEqual(fs.readdirSync(localesDir).sort(), ['en', 'fr']);
  assert.deepEqual(namespacesOf('fr'), namespacesOf('en'));
  assert.ok(namespacesOf('fr').includes('common'));
});

test('locales: fr/en key parity - a key present in one language only fails here', () => {
  for (const ns of namespacesOf('fr')) {
    const fr = flatten(dictionary('fr', ns));
    const en = flatten(dictionary('en', ns));
    assert.deepEqual(Object.keys(fr).filter((k) => !(k in en)), [], `${ns}: missing in en`);
    assert.deepEqual(Object.keys(en).filter((k) => !(k in fr)), [], `${ns}: missing in fr`);
  }
});

test('locales: every entry is a non-empty string with the same {placeholders} in both languages', () => {
  for (const ns of namespacesOf('fr')) {
    const fr = flatten(dictionary('fr', ns));
    const en = flatten(dictionary('en', ns));
    for (const key of Object.keys(fr)) {
      for (const [lang, value] of [['fr', fr[key]], ['en', en[key]]]) {
        assert.equal(typeof value, 'string', `${lang}/${ns}.${key}`);
        assert.notEqual(value.trim(), '', `${lang}/${ns}.${key}`);
      }
      assert.deepEqual(placeholders(fr[key]), placeholders(en[key]), `${ns}.${key}`);
    }
  }
});

test('locales: the helpers of the skeleton have their strings', () => {
  const fr = flatten(dictionary('fr', 'common'));
  for (const key of ['actions.ok', 'actions.cancel', 'actions.confirm', 'actions.close', 'dialog.typeToConfirm', 'tabs.loadFailed',
    'errors.server.internal', 'errors.server.not_found', 'errors.server.bad_request', 'errors.server.too_large', 'errors.server.cross_origin',
    'errors.auth.required', 'errors.auth.forbidden']) {
    assert.ok(key in fr, key);
  }
  assert.deepEqual(placeholders(fr['dialog.typeToConfirm']), ['text']);
});

// ── Runtime ─────────────────────────────────────────────────────────────────

const files = {
  '/locales/fr/common.json': { actions: { cancel: 'Annuler' }, greet: 'Bonjour {name}, baie {bench}', errors: { auth: { forbidden: 'Interdit ({role})' } } },
  '/locales/en/common.json': { actions: { cancel: 'Cancel', close: 'Close' }, greet: 'Hello {name}, bench {bench}', onlyEnglish: 'English only', errors: { auth: { forbidden: 'Forbidden ({role})' } } },
  '/locales/fr/benches.json': { lines: { one: '{count} ligne', other: '{count} lignes' }, errors: { taken: 'La baie {bench} est déjà prise' } },
  '/locales/en/benches.json': { lines: { one: '{count} line', other: '{count} lines' }, errors: { taken: 'Bench {bench} is already taken' } },
};
let fetched = [];
let storage;
let i18n;

before(async () => {
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const body = files[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => structuredClone(body) };
  };
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
  };
  console.warn = () => {}; // a missing dictionary is reported on the console; not interesting here
  i18n = await import('../public/js/core/i18n.js');
});
beforeEach(() => { storage = new Map(); fetched = []; });

test('runtime: first visit uses the default locale served by the server', async () => {
  assert.equal(await i18n.initI18n({ defaultLocale: 'en' }), 'en');
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.t('common.actions.cancel'), 'Cancel');
  assert.equal(await i18n.initI18n({ defaultLocale: 'fr' }), 'fr');
  assert.equal(i18n.t('common.actions.cancel'), 'Annuler');
  assert.equal(storage.size, 0, 'the default is not stored: only a choice is');
});

test('runtime: French by default when the server says nothing sensible', async () => {
  assert.equal(await i18n.initI18n(), 'fr');
  assert.equal(await i18n.initI18n({ defaultLocale: 'de' }), 'fr');
});

test('runtime: {name} interpolation', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  assert.equal(i18n.t('common.greet', { name: 'Ada', bench: 'B4M' }), 'Bonjour Ada, baie B4M');
  assert.equal(i18n.t('common.greet', { name: 'Ada' }), 'Bonjour Ada, baie {bench}', 'a missing value stays visible');
  assert.equal(i18n.t('common.greet', { name: 0, bench: '' }), 'Bonjour 0, baie ');
  assert.equal(i18n.t('common.greet'), 'Bonjour {name}, baie {bench}');
  assert.equal(i18n.t('common.greet', { name: '{bench}', bench: 'x' }), 'Bonjour {bench}, baie x', 'values are not interpolated again');
});

test('runtime: fallback is requested locale → en → key', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  assert.equal(i18n.t('common.actions.cancel'), 'Annuler');
  assert.equal(i18n.t('common.actions.close'), 'Close', 'missing in fr: English');
  assert.equal(i18n.t('common.onlyEnglish'), 'English only');
  assert.equal(i18n.t('common.nowhere.to.be.found'), 'common.nowhere.to.be.found', 'missing everywhere: the key');
  assert.equal(i18n.t('unloaded.key'), 'unloaded.key');
  assert.equal(i18n.t('common.actions'), 'common.actions', 'a group is not a text');
  assert.equal(i18n.t('common'), 'common');
  assert.equal(i18n.has('common.actions.close'), true);
  assert.equal(i18n.has('common.nowhere'), false);
});

test('runtime: loadNamespace fetches the language and its fallback, once', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  fetched = [];
  assert.equal(i18n.t('benches.errors.taken', { bench: 'B4M' }), 'benches.errors.taken', 'not loaded yet');
  await Promise.all([i18n.loadNamespace('benches'), i18n.loadNamespace('benches')]);
  assert.deepEqual(fetched.sort(), ['/locales/en/benches.json', '/locales/fr/benches.json']);
  assert.equal(i18n.t('benches.errors.taken', { bench: 'B4M' }), 'La baie B4M est déjà prise');
  await i18n.loadNamespace('benches');
  assert.equal(fetched.length, 2, 'cached');
});

test('runtime: a namespace that does not exist does not break anything', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  await assert.doesNotReject(i18n.loadNamespace('ghost'));
  assert.equal(i18n.t('ghost.title'), 'ghost.title');
});

test('runtime: plural forms follow the language', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  await i18n.loadNamespace('benches');
  assert.equal(i18n.t('benches.lines', { count: 0 }), '0 ligne', 'French: zero is singular');
  assert.equal(i18n.t('benches.lines', { count: 1 }), '1 ligne');
  assert.equal(i18n.t('benches.lines', { count: 12 }), '12 lignes');
  await i18n.setLocale('en', { persist: false });
  assert.equal(i18n.t('benches.lines', { count: 0 }), '0 lines');
  assert.equal(i18n.t('benches.lines', { count: 1 }), '1 line');
  assert.equal(i18n.t('benches.lines'), '{count} lines');
});

test('runtime: setLocale reloads the namespaces in use, tells the listeners and persists the choice', async () => {
  await i18n.initI18n({ defaultLocale: 'en' });
  await i18n.loadNamespace('benches');
  const heard = [];
  const off = i18n.onLocaleChange((locale) => heard.push(locale));
  assert.equal(await i18n.setLocale('fr'), 'fr');
  assert.equal(i18n.getLocale(), 'fr');
  assert.equal(i18n.t('common.actions.cancel'), 'Annuler');
  assert.equal(i18n.t('benches.errors.taken', { bench: 'B4M' }), 'La baie B4M est déjà prise');
  assert.deepEqual(heard, ['fr']);
  assert.equal(storage.get('labconsole.locale'), '"fr"', 'stored with the existing prefs helper');
  off();
  await i18n.setLocale('en');
  assert.deepEqual(heard, ['fr']);
  await assert.rejects(i18n.setLocale('de'), RangeError);
  assert.equal(i18n.getLocale(), 'en');
});

test('runtime: the stored choice wins over the server default on the next visit', async () => {
  storage.set('labconsole.locale', '"en"');
  assert.equal(await i18n.initI18n({ defaultLocale: 'fr' }), 'en');
  storage.set('labconsole.locale', '"xx"');
  assert.equal(await i18n.initI18n({ defaultLocale: 'fr' }), 'fr', 'a stored value we do not support is ignored');
});

test('runtime: tError translates an API error code, else keeps the server sentence', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  await i18n.loadNamespace('benches');
  assert.equal(i18n.tError('benches.taken', { bench: 'B4M' }, 'Bench B4M is already taken'), 'La baie B4M est déjà prise', "the module's own namespace");
  assert.equal(i18n.tError('auth.forbidden', { role: 'admin' }, 'You are not allowed'), 'Interdit (admin)', 'common.errors.<code>');
  assert.equal(i18n.tError('jobs.unknown', {}, 'Server sentence'), 'Server sentence');
  assert.equal(i18n.tError(undefined, {}, 'Server sentence'), 'Server sentence');
  assert.equal(i18n.tError('jobs.unknown'), 'jobs.unknown');
});

test('api.js: a failed request carries status, code, params and a translated message', async () => {
  await i18n.initI18n({ defaultLocale: 'fr' });
  const { request } = await import('../public/js/core/api.js');
  const answer = (status, body) => { globalThis.fetch = async () => ({ ok: status < 400, status, json: async () => body }); };

  answer(403, { error: 'You are not allowed to do this', code: 'auth.forbidden', params: { role: 'admin' } });
  await assert.rejects(request('POST', '/api/admin/x', {}), (err) => {
    assert.equal(err.message, 'Interdit (admin)');
    assert.equal(err.status, 403);
    assert.equal(err.code, 'auth.forbidden');
    assert.deepEqual(err.params, { role: 'admin' });
    assert.equal(err.serverMessage, 'You are not allowed to do this');
    return true;
  });

  answer(503, { error: 'Proxmox is not configured (PROXMOX_URL is empty)' }); // an upstream route without a code
  await assert.rejects(request('GET', '/api/proxmox/vms'), (err) => err.message === 'Proxmox is not configured (PROXMOX_URL is empty)' && err.code === null && err.status === 503);

  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  await assert.rejects(request('GET', '/api/x'), /\/api\/x answered HTTP 502/);

  answer(200, { ok: true });
  assert.deepEqual(await request('GET', '/api/health'), { ok: true });
});
