/**
 * Request bodies are never inflated (src/lib/bodies.js): no page of the
 * application sends a compressed body, and inflating one before sign-in gives
 * a stranger a way to make the server work (GHSA-27r3-jxmh-p828). A body
 * that says it is compressed is refused before it is read, on the public
 * sign-in routes as everywhere else.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startTestApp, repoRoot } from './helpers/app.js';

let lab;
before(async () => { lab = await startTestApp(); });
after(() => lab?.close());

const post = (route, body, headers = {}) => fetch(`${lab.url}${route}`, {
  method: 'POST',
  headers: { origin: lab.url, 'content-type': 'application/json', ...headers },
  body,
});
const json = JSON.stringify({ username: 'nobody', password: 'wrong', code: '000000' });

test('a compressed body is refused before sign-in, whatever its encoding', async () => {
  for (const [encoding, body] of [
    ['gzip', Buffer.concat([zlib.gzipSync(json), Buffer.from('trailing bytes')])],
    ['deflate', zlib.deflateSync(json)],
    ['br', zlib.brotliCompressSync(json)],
  ]) {
    for (const route of ['/auth/local', '/auth/signup', '/auth/passkey/options']) {
      const res = await post(route, body, { 'content-encoding': encoding });
      assert.equal(res.status, 415, `${encoding} on ${route}`);
      assert.equal((await res.json()).code, 'server.bad_request');
    }
  }
});

test('a compressed body is refused after sign-in too; a plain one is read', async () => {
  const res = await post('/api/scripts', zlib.gzipSync(JSON.stringify({ scope: 'personal', title: 'x', body: 'show clock' })), { 'content-encoding': 'gzip', ...lab.as('student1') });
  assert.equal(res.status, 415);
  const plain = await post('/auth/local', json);
  assert.notEqual(plain.status, 415, 'the sign-in form still works');
});

test('every body parser of the application is one of src/lib/bodies.js', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && !full.endsWith(path.join('lib', 'bodies.js'))
        && /express\.(?:json|raw|text|urlencoded)\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(repoRoot, full));
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, []);
});
