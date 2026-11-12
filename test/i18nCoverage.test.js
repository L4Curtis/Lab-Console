/**
 * The dictionaries and the code agree: every key the front end asks for
 * exists in French and in English, no key sits unused, and every code the
 * server puts on a message has its translation
 *
 * A key reaches the screen as a string literal ('consoles.title'), so the
 * scan looks for literals that start with the name of a namespace. A key
 * built from a variable is written as a template literal with a fixed
 * prefix (`consoles.state.${state}`): it counts as a use of every key under
 * that prefix, and the prefix must lead to something
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/app.js';

const publicDir = path.join(repoRoot, 'public');
const localesDir = path.join(publicDir, 'locales');
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

const namespaces = fs.readdirSync(path.join(localesDir, 'fr')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const dictionary = (lang, ns) => JSON.parse(fs.readFileSync(path.join(localesDir, lang, `${ns}.json`), 'utf8'));
const isPlural = (node) => node !== null && typeof node === 'object' && Object.keys(node).length > 0 && Object.keys(node).every((k) => PLURAL_FORMS.has(k));

/** { 'consoles.title': 'Consoles du labo', … } - a plural object is one entry */
function entries(node, prefix, out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const at = `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !isPlural(value)) entries(value, at, out);
    else out[at] = value;
  }
  return out;
}
const allKeys = (lang) => Object.assign({}, ...namespaces.map((ns) => entries(dictionary(lang, ns), ns)));

function filesUnder(dir, extensions, skip = () => false) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (skip(full)) return [];
    if (e.isDirectory()) return filesUnder(full, extensions, skip);
    return extensions.includes(path.extname(e.name)) ? [full] : [];
  });
}
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

/** What the front end asks for: { literals: Set of keys, prefixes: Set of 'ns.path.' } */
function frontEndUses() {
  const literals = new Set();
  const prefixes = new Set();
  const nsPattern = namespaces.join('|');
  const quoted = new RegExp(`(['"\`])((?:${nsPattern})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])\\1`, 'g');
  const dynamic = new RegExp(`\`((?:${nsPattern})\\.[A-Za-z0-9_.]*\\.)\\$\\{`, 'g');
  const sources = filesUnder(publicDir, ['.js'], (p) => p.includes(`${path.sep}vendor${path.sep}`) || p.startsWith(localesDir)).map((f) => withoutComments(fs.readFileSync(f, 'utf8')));
  for (const source of sources) {
    for (const m of source.matchAll(quoted)) literals.add(m[2]);
    for (const m of source.matchAll(dynamic)) prefixes.add(m[1]);
  }
  // Static markup: data-i18n="key", data-i18n-title="key", …
  for (const file of filesUnder(publicDir, ['.html'], (p) => p.includes(`${path.sep}vendor${path.sep}`))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) literals.add(m[1]);
  }
  return { literals, prefixes };
}

// Keys looked up from a code, not written in the front end: the API error
// codes (<module>.errors.<reason>) and the messages of the console sockets
const byCode = (key) => /^[a-z]+\.errors\./.test(key) || key.startsWith('terminal.server.');

test('i18n coverage: every key the front end asks for exists in fr and en', () => {
  const { literals, prefixes } = frontEndUses();
  const fr = allKeys('fr');
  const en = allKeys('en');
  const missing = [...literals].filter((k) => !(k in fr) || !(k in en));
  assert.deepEqual(missing, [], 'used in public/ but missing from a dictionary');
  for (const prefix of prefixes) {
    assert.ok(Object.keys(fr).some((k) => k.startsWith(prefix)), `no key under the dynamic prefix ${prefix}`);
    assert.ok(Object.keys(en).some((k) => k.startsWith(prefix)), `no key under the dynamic prefix ${prefix} (en)`);
  }
  assert.ok(literals.size > 100, 'the scan found the keys of the existing screens');
});

test('i18n coverage: no dictionary key is unused', () => {
  const { literals, prefixes } = frontEndUses();
  const unused = Object.keys(allKeys('fr')).filter((key) => !byCode(key) && !literals.has(key) && ![...prefixes].some((p) => key.startsWith(p)));
  assert.deepEqual(unused, [], 'in a dictionary but never used in public/');
});

// ── Messages the server sends over the console sockets ─────────────────────

const SERVER_FILES = [
  'src/lib/automationProtocol.js', 'src/lib/cliAutomation.js', 'src/lib/ssh.js',
  ...fs.readdirSync(path.join(repoRoot, 'src/modules/consoles')).filter((f) => f.endsWith('.js')).map((f) => `src/modules/consoles/${f}`),
];
const CODE = /(['"])((?:consoles|automation)\.[a-z_]+)\1/g;

function serverCodes() {
  const codes = new Set();
  for (const file of SERVER_FILES) {
    for (const m of withoutComments(fs.readFileSync(path.join(repoRoot, file), 'utf8')).matchAll(CODE)) codes.add(m[2]);
  }
  return codes;
}

test('server messages: every code has a translation in fr and en, and every translation has a code', () => {
  const codes = serverCodes();
  for (const lang of ['fr', 'en']) {
    const translated = Object.keys(allKeys(lang)).filter((k) => k.startsWith('terminal.server.')).map((k) => k.slice('terminal.server.'.length));
    assert.deepEqual([...codes].filter((c) => !translated.includes(c)).sort(), [], `${lang}: codes without a translation`);
    assert.deepEqual(translated.filter((c) => !codes.has(c)).sort(), [], `${lang}: translations no code points to`);
  }
  assert.ok(codes.size > 40);
});

test('server messages: the placeholders of a translation are the params the server sends', () => {
  // Every {name} of a translation must be given by the code that produces it
  const sent = {
    'consoles.status_ssh': ['host'], 'consoles.status_telnet': ['target'], 'consoles.telnet_failed': ['detail'], 'consoles.closed_exit': ['code'],
    'consoles.idle_timeout': ['minutes', 'name'], 'consoles.line_busy': ['name', 'since'], 'consoles.line_busy_since': ['name', 'since'],
    'consoles.client_full': ['max'], 'consoles.not_allowed': ['name'], 'consoles.ssh_refused': ['host', 'port'], 'consoles.ssh_timeout': ['host'],
    'consoles.ssh_unreachable': ['host'], 'consoles.ssh_error': ['detail'],
    'automation.busy_task': ['task'], 'automation.script_too_long': ['max'], 'automation.restoring_paging': ['length'], 'automation.user_mode': ['host'],
    'automation.device_answered': ['detail'], 'automation.sending_line': ['line', 'total'], 'automation.exported': ['count', 'hostname'],
    'automation.exported_paging': ['count', 'hostname'], 'automation.sent': ['sent', 'total', 'count'], 'automation.device_errors': ['count', 'lines'],
    'automation.no_prompt_after': ['lines', 'count'], 'automation.waiting_for': ['question'],
  };
  for (const lang of ['fr', 'en']) {
    const all = allKeys(lang);
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('terminal.server.')) continue;
      const code = key.slice('terminal.server.'.length);
      const texts = isPlural(value) ? Object.values(value) : [value];
      for (const text of texts) {
        for (const [, name] of text.matchAll(/\{(\w+)\}/g)) assert.ok((sent[code] || []).includes(name), `${lang} ${code}: {${name}} is not a param of this code`);
      }
    }
  }
});

test('server messages: the sentence stays next to the code (English text unchanged)', async () => {
  const { sshErrorInfo, describeSshError } = await import('../src/lib/ssh.js');
  const ssh = { host: 'jump', port: 22 };
  assert.equal(describeSshError({ code: 'ECONNREFUSED', message: 'x' }, ssh), 'Jump server jump:22 refused the connection');
  assert.deepEqual(sshErrorInfo({ code: 'ECONNREFUSED', message: 'x' }, ssh), { code: 'consoles.ssh_refused', params: { host: 'jump', port: 22 }, message: 'Jump server jump:22 refused the connection' });
  assert.equal(sshErrorInfo({ level: 'client-authentication', message: 'x' }, ssh).code, 'consoles.ssh_rejected');
  assert.equal(sshErrorInfo({ message: 'boom' }, ssh).message, 'SSH error: boom');
});
