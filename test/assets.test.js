/**
 * Versioned addresses of the front end (src/lib/assets.js, ARCHITECTURE §4):
 * the build id, the two cache headers, a stale id, the access rules under
 * the prefix, and the pages pointing at it
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { computeBuildId, createAssets, rewriteHtml, CACHE_IMMUTABLE, CACHE_REVALIDATE, PUBLIC_DIR } from '../src/lib/assets.js';
import { startTestApp } from './helpers/app.js';

const IMMUTABLE = 'private, max-age=31536000, immutable';
const REVALIDATE = 'private, no-cache';

describe('build id', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-console-assets-'));
    fs.mkdirSync(path.join(dir, 'js', 'core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<script type="module" src="/js/main.js"></script>');
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), 'import "./core/dom.js";\n');
    fs.writeFileSync(path.join(dir, 'js', 'core', 'dom.js'), 'export const x = 1;\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a short hash, the same for the same files (another start of the same release)', () => {
    const id = computeBuildId(dir);
    assert.match(id, /^[0-9a-f]{12}$/);
    assert.equal(computeBuildId(dir), id);
    assert.equal(createAssets({ dir }).buildId, id);
    // Dates are not content: touching a file changes nothing
    fs.utimesSync(path.join(dir, 'js', 'main.js'), new Date(0), new Date(0));
    assert.equal(computeBuildId(dir), id);
  });

  test('changes when a file changes, appears, disappears or moves', () => {
    const file = path.join(dir, 'js', 'core', 'dom.js');
    const original = computeBuildId(dir);
    const seen = new Set([original]);
    const expectNew = (what) => {
      const id = computeBuildId(dir);
      assert.ok(!seen.has(id), what);
      seen.add(id);
    };
    fs.writeFileSync(file, 'export const x = 2;\n');
    expectNew('one byte changed');
    fs.writeFileSync(path.join(dir, 'js', 'extra.js'), '');
    expectNew('an empty file added');
    fs.renameSync(path.join(dir, 'js', 'extra.js'), path.join(dir, 'js', 'core', 'extra.js'));
    expectNew('a file moved');
    fs.rmSync(path.join(dir, 'js', 'core', 'extra.js'));
    fs.writeFileSync(file, 'export const x = 1;\n');
    assert.equal(computeBuildId(dir), original, 'back to the same files, back to the same id');
  });

  test('the application exposes the id of its own public/ directory', async () => {
    const lab = await startTestApp();
    try {
      assert.equal(lab.assets.buildId, computeBuildId(PUBLIC_DIR));
      assert.equal(lab.assets.prefix, `/v/${lab.assets.buildId}`);
      assert.equal(lab.deps.assets, lab.assets, 'modules receive the same object');
    } finally {
      await lab.close();
    }
  });
});

test('rewriteHtml: scripts and stylesheets of the application, nothing else', () => {
  const html = [
    '<link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />',
    '<link rel="stylesheet" href="/css/app.css" />',
    '<script type="module" src="/js/main.js"></script>',
    '<a href="/login">x</a> <a href="#/home">y</a> <link rel="icon" href="/favicon.svg" />',
  ].join('\n');
  assert.equal(rewriteHtml(html, '/v/abc'), [
    '<link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />',
    '<link rel="stylesheet" href="/v/abc/css/app.css" />',
    '<script type="module" src="/v/abc/js/main.js"></script>',
    '<a href="/login">x</a> <a href="#/home">y</a> <link rel="icon" href="/favicon.svg" />',
  ].join('\n'));
  assert.equal(CACHE_IMMUTABLE, IMMUTABLE);
  assert.equal(CACHE_REVALIDATE, REVALIDATE);
});

describe('served under /v/<build id>/', () => {
  let lab;
  let v;
  let user;
  const get = (p, headers = {}) => fetch(lab.url + p, { redirect: 'manual', headers });
  // The path exactly as written (fetch would normalise dot segments) and no header added (fetch defeats If-None-Match)
  const raw = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: lab.port, path: p, headers }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
  before(async () => {
    lab = await startTestApp();
    v = lab.assets.prefix;
    user = lab.as('student1');
  });
  after(() => lab.close());

  test('the same bytes as without the prefix, kept for a year; without it, revalidated', async () => {
    const files = [
      ['/js/core/dom.js', {}], ['/css/app.css', {}], ['/locales/fr/common.json', {}], ['/js/login.js', {}], ['/js/join.js', {}],
      ['/js/main.js', user], ['/js/modules/consoles/index.js', user], ['/css/consoles.css', {}],
    ];
    for (const [file, headers] of files) {
      const plain = await get(file, headers);
      const versioned = await get(v + file, headers);
      assert.equal(plain.status, 200, file);
      assert.equal(versioned.status, 200, v + file);
      assert.equal(plain.headers.get('cache-control'), REVALIDATE, file);
      assert.equal(versioned.headers.get('cache-control'), IMMUTABLE, v + file);
      assert.equal(versioned.headers.get('content-type'), plain.headers.get('content-type'), file);
      assert.equal(await versioned.text(), await plain.text(), file);
    }
  });

  test('a revalidation answers 304, still immutable; the query string is kept', async () => {
    const first = await raw(`${v}/js/core/dom.js`);
    assert.ok(first.headers.etag);
    const again = await raw(`${v}/js/core/dom.js`, { 'if-none-match': first.headers.etag });
    assert.equal(again.statusCode, 304);
    assert.equal(again.headers['cache-control'], IMMUTABLE);
    const withQuery = await get(`${v}/locales/en/common.json?x=1`);
    assert.equal(withQuery.status, 200);
    assert.equal(typeof (await withQuery.json()).shell, 'object');
  });

  test('vendor files keep their own caching, outside the prefix', async () => {
    const res = await get('/vendor/xterm/css/xterm.css');
    await res.arrayBuffer();
    assert.match(res.headers.get('cache-control'), /immutable/);
    assert.equal((await get(`${v}/vendor/xterm/css/xterm.css`)).status, 404, 'vendor is not under the prefix');
  });

  test('a stale or unknown id is a 404, never the current file, and is not stored', async () => {
    const stale = lab.assets.buildId.replace(/./, (c) => (c === '0' ? '1' : '0'));
    for (const headers of [{}, user]) {
      for (const p of [`/v/${stale}/js/core/dom.js`, `/v/${stale}/js/main.js`, `/v/${stale}/css/app.css`, '/v/nope/js/core/dom.js', '/v//js/core/dom.js', '/v/', '/v']) {
        const res = await get(p, headers);
        if (p === '/v') { // not the prefix at all: an unknown address, as before
          assert.notEqual(res.status, 200, p);
          await res.arrayBuffer();
          continue;
        }
        assert.equal(res.status, 404, p);
        assert.equal(res.headers.get('cache-control'), 'no-store', p);
        assert.equal((await res.json()).code, 'server.not_found', p);
      }
    }
  });

  test('only scripts, stylesheets and dictionaries are under the prefix: no page, no API, no trickery', async () => {
    for (const p of ['/', '/index.html', '/login', '/join', '/api/modules', '/api/health', '/auth/me', '/favicon.svg', '/js/', '/js/core',
      '/js/core/dom.js%00.js', '/locales/fr/common.txt']) {
      for (const headers of [{}, user]) {
        const res = await get(v + p, headers);
        assert.equal(res.status, 404, v + p);
        assert.equal(res.headers.get('cache-control'), 'no-store', v + p);
        await res.arrayBuffer();
      }
    }
    // A public folder with a dot segment would reach a gated file: refused before anything resolves it
    for (const p of ['/js/core/../main.js', '/js/./main.js', '/css/../js/main.js', '/js/core/%2e%2e/main.js', '/js/core/%2E%2E/main.js']) {
      for (const headers of [{}, user]) {
        const res = await raw(v + p, headers);
        assert.equal(res.statusCode, 404, v + p);
        assert.equal(res.headers['cache-control'], 'no-store', v + p);
      }
    }
    const post = await fetch(`${lab.url}${v}/js/core/dom.js`, { method: 'POST', headers: { ...user, origin: lab.url } });
    assert.equal(post.status, 404, 'only GET and HEAD');
    await post.arrayBuffer();
    const head = await fetch(`${lab.url}${v}/js/core/dom.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), IMMUTABLE);
  });

  test('a gated file needs a session under the prefix too, and the refusal is not stored', async () => {
    for (const p of ['/js/main.js', '/js/notFound.js', '/js/shared/workspace.js', '/js/modules/admin/index.js', '/js/missing.js']) {
      const res = await get(v + p);
      assert.equal(res.status, 302, v + p);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(v + p)}`, v + p);
      assert.equal(res.headers.get('cache-control'), 'no-store', v + p);
      const forged = await get(v + p, { cookie: `${lab.deps.auth.cookieName}=${'A'.repeat(43)}` });
      assert.equal(forged.status, 302, `${v + p} (forged cookie)`);
      await forged.arrayBuffer();
    }
  });

  test('a missing file under the prefix is a 404 that is not stored', async () => {
    for (const [p, headers] of [['/js/core/missing.js', {}], ['/css/missing.css', {}], ['/locales/fr/missing.json', {}], ['/js/missing.js', user]]) {
      const res = await get(v + p, headers);
      assert.equal(res.status, 404, v + p);
      assert.equal(res.headers.get('cache-control'), 'no-store', v + p);
      await res.arrayBuffer();
    }
  });

  test('every page points at this release, keeps its own cache header and its strict CSP', async () => {
    const pages = [['/', user, REVALIDATE, 200], ['/index.html', user, REVALIDATE, 200], ['/login', {}, 'no-store', 200],
      ['/join', {}, 'no-store', 200], ['/reset', {}, 'no-store', 200], ['/nowhere', { ...user, accept: 'text/html' }, REVALIDATE, 404]];
    for (const [p, headers, cacheControl, status] of pages) {
      const res = await get(p, headers);
      assert.equal(res.status, status, p);
      assert.match(res.headers.get('content-type'), /^text\/html/, p);
      assert.equal(res.headers.get('cache-control'), cacheControl, p);
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'(?![^;]*unsafe-inline)/, p);
      const html = await res.text();
      const refs = [...html.matchAll(/\s(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
      const own = refs.filter((r) => /^\/(?:js|css|locales)\//.test(r));
      assert.deepEqual(own, [], `${p} still names unversioned files: ${own.join(', ')}`);
      const versioned = refs.filter((r) => r.startsWith('/v/'));
      assert.ok(versioned.some((r) => r.endsWith('.js')) && versioned.some((r) => r.endsWith('.css')), p);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${p}: no inline script`);
      for (const ref of versioned) {
        assert.ok(ref.startsWith(`${v}/`), `${p}: ${ref} is not of this release`);
        const asset = await get(ref, headers);
        assert.equal(asset.status, 200, `${p} → ${ref}`);
        assert.equal(asset.headers.get('cache-control'), IMMUTABLE, ref);
        await asset.arrayBuffer();
      }
    }
  });

  test('a page answers 304 when it did not change, and is still revalidated', async () => {
    for (const [p, headers, cacheControl] of [['/login', {}, 'no-store'], ['/', user, REVALIDATE]]) {
      const first = await raw(p, headers);
      const again = await raw(p, { ...headers, 'if-none-match': first.headers.etag });
      assert.equal(again.statusCode, 304, p);
      assert.equal(again.headers['cache-control'], cacheControl, p);
    }
  });
});

test('another public/ directory: its own id, its pages rewritten with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-console-assets-'));
  try {
    fs.mkdirSync(path.join(dir, 'js'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<link rel="stylesheet" href="/css/app.css"><script type="module" src="/js/main.js"></script>');
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), '');
    const assets = createAssets({ dir });
    assert.equal(assets.page('index.html'), `<link rel="stylesheet" href="${assets.prefix}/css/app.css"><script type="module" src="${assets.prefix}/js/main.js"></script>`);
    assert.equal(assets.hasPage('index.html'), true);
    assert.equal(assets.hasPage('main.js'), false);
    assert.throws(() => assets.page('other.html'), /No page/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
