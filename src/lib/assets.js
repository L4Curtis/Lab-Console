/**
 * The application's own front-end files (public/) and how long a browser
 * may keep them (ARCHITECTURE §4, "Caching of the front end")
 *
 * Every file is reachable twice:
 *   /js/main.js              revalidated on every load (`private, no-cache`):
 *                            old tabs, bookmarks, tests
 *   /v/<buildId>/js/main.js  kept for a year (`private, max-age=31536000,
 *                            immutable`): what the pages really load
 *
 * The build id is a short hash of the contents of public/, computed once at
 * start-up: it changes exactly when a file changes, and is the same across
 * restarts of one release. The pages (index.html, login.html, join.html,
 * 404.html) are served from memory with their script and stylesheet
 * references rewritten to the versioned prefix; modules imported relatively
 * inherit it, and the scripts that build an address themselves (i18n,
 * loadCss) derive it from import.meta.url.
 *
 * A versioned request is only an address rewrite: `/v/<id>/js/x.js` goes
 * down the same pipeline as `/js/x.js`, so a public file stays public and a
 * gated one needs a session exactly as without the prefix. Only scripts,
 * stylesheets and dictionaries under /js, /css and /locales are answered
 * this way. An id that is not the current one is a 404, never the current
 * file: the old page would mix two releases (and load a second copy of
 * modules it already holds), which is what the prefix exists to prevent.
 *
 * `private` everywhere: Cloudflare rewrites a public max-age into hours of
 * browser caching, but leaves private responses alone
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendError } from './httpError.js';

export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export const CACHE_REVALIDATE = 'private, no-cache';
export const CACHE_IMMUTABLE = 'private, max-age=31536000, immutable';

/** What may follow /v/<id>: the application's scripts, stylesheets and dictionaries; no page, no API */
const VERSIONED = /^\/(?:js|css|locales)\/[\w./-]+\.(?:js|css|json)$/;
/** Dot segments are refused outright: the rewritten address must name the file it looks like */
const DOT_SEGMENT = /\/\.\.?(?:\/|$)/;
/** The application's own files when asked without the prefix */
const APP_FILE = /\.(?:m?js|css|json|html)$/;

/** Every file under `dir`, as sorted paths relative to it with '/' separators */
function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Short hash of the names and contents of every file under `dir`: 12 hex
 * characters, enough to tell releases apart, short enough for an address
 */
export function computeBuildId(dir = PUBLIC_DIR) {
  const hash = crypto.createHash('sha256');
  for (const rel of listFiles(dir)) {
    const body = fs.readFileSync(path.join(dir, rel));
    hash.update(`${rel}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest('hex').slice(0, 12);
}

/** Point a page's script and stylesheet references (src="/js/…", href="/css/…") at the versioned prefix */
export function rewriteHtml(html, prefix) {
  return html.replace(/(\s(?:src|href)=["'])\/(js|css|locales)\//g, `$1${prefix}/$2/`);
}

/**
 * Cache-Control of a versioned response, decided when its status is known:
 * only the file itself is kept for a year. A redirect to the sign-in page, a
 * refusal or a missing file is never stored, or a browser would keep it too
 */
function immutableOnSuccess(res) {
  const writeHead = res.writeHead;
  res.writeHead = function versionedWriteHead(status, ...rest) {
    this.setHeader('Cache-Control', status === 200 || status === 206 || status === 304 ? CACHE_IMMUTABLE : 'no-store');
    return writeHead.call(this, status, ...rest);
  };
}

/**
 * The front end of one release, read once:
 *   buildId            the hash of `dir`
 *   prefix             '/v/<buildId>'
 *   middleware         mounted first in the pipeline: rewrites a current versioned
 *                      address, refuses any other /v/ address, sets the
 *                      revalidation header on the unversioned files
 *   hasPage(name)      is `name` one of the pages at the root of `dir` (index.html…)
 *   page(name)         its rewritten HTML
 *   sendPage(res, name, status = 200)   answer with it (`private, no-cache`
 *                      unless the route already set a header, e.g. no-store)
 */
export function createAssets({ dir = PUBLIC_DIR } = {}) {
  const buildId = computeBuildId(dir);
  const prefix = `/v/${buildId}`;
  const pages = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.html')) pages.set(name, rewriteHtml(fs.readFileSync(path.join(dir, name), 'utf8'), prefix));
  }

  function middleware(req, res, next) {
    if (!req.path.startsWith('/v/')) {
      if (!req.path.startsWith('/vendor/') && APP_FILE.test(req.path)) res.setHeader('Cache-Control', CACHE_REVALIDATE);
      return next();
    }
    const [, id, rest = ''] = /^\/v\/([^/]*)(\/.*)?$/.exec(req.path) ?? [];
    if (id !== buildId || !VERSIONED.test(rest) || DOT_SEGMENT.test(rest) || !['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Cache-Control', 'no-store');
      return sendError(res, 404, 'server.not_found', 'Not found');
    }
    const query = req.url.indexOf('?');
    req.url = rest + (query === -1 ? '' : req.url.slice(query));
    immutableOnSuccess(res);
    next();
  }

  function page(name) {
    if (!pages.has(name)) throw new Error(`No page ${name} in ${dir}`);
    return pages.get(name);
  }

  function sendPage(res, name, status = 200) {
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', CACHE_REVALIDATE);
    res.status(status).type('html').send(page(name));
  }

  return { buildId, prefix, dir, middleware, hasPage: (name) => pages.has(name), page, sendPage };
}

let shared = null;
/** The application's own public/ directory, read once per process */
export function appAssets() {
  shared ??= createAssets();
  return shared;
}
