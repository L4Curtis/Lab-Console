/**
 * The guarded fetch (src/lib/safeFetch.js): which addresses are reached, on
 * the addresses the connection really uses, with a deadline and a size limit
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addressKind, createSafeFetch, SafeFetchError } from '../src/lib/safeFetch.js';

const reason = (promise) => promise.then(() => 'fetched', (err) => (err instanceof SafeFetchError ? err.reason : `other: ${err.message}`));

describe('safe fetch', () => {
  let server;
  let port;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/big') return res.end('x'.repeat(4096));
      if (req.url === '/hop') { res.statusCode = 302; res.setHeader('location', '/json'); return res.end(); }
      if (req.url === '/post') {
        let body = '';
        req.on('data', (c) => { body += c; });
        return req.on('end', () => res.end(JSON.stringify({ method: req.method, body, type: req.headers['content-type'] })));
      }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ({ port } = server.address());
  });
  after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  test('address kinds: public, internal, never', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(addressKind(ip), 'public', ip);
    for (const ip of ['10.22.0.5', '192.168.10.250', '172.16.3.4', '127.0.0.1', '100.64.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(addressKind(ip), 'internal', ip);
    }
    for (const ip of ['169.254.169.254', '0.0.0.0', 'fe80::1', '224.0.0.1', '255.255.255.255', '::', '[fe80::1]', '::ffff:169.254.169.254']) {
      assert.equal(addressKind(ip), 'forbidden', ip);
    }
    assert.equal(addressKind('not an ip'), null);
  });

  test('the trusted host may be internal; JSON comes back as a Response', async () => {
    const fetch = createSafeFetch({ trustedHost: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('another internal host is refused, before any connection', async () => {
    const fetch = createSafeFetch({ trustedHost: 'id.example.org', allowInsecure: true });
    assert.equal(await reason(fetch(`http://127.0.0.1:${port}/json`)), 'internal_address');
  });

  test('the check is on the addresses the connection uses: a name that resolves inside is refused (DNS rebinding)', async () => {
    const lookup = (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
    const fetch = createSafeFetch({ trustedHost: 'id.example.org', allowInsecure: true, lookup });
    assert.equal(await reason(fetch(`http://rebind.example.org:${port}/json`)), 'internal_address');
    const metadata = createSafeFetch({ trustedHost: 'id.example.org', allowInsecure: true, lookup: (_h, _o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]) });
    assert.equal(await reason(metadata(`http://id.example.org:${port}/json`)), 'forbidden_address', 'even for the trusted host');
    // The trusted name, resolving inside: allowed (a school's provider on its LAN)
    const lan = createSafeFetch({ trustedHost: 'id.example.org', allowInsecure: true, lookup });
    assert.equal((await lan(`http://id.example.org:${port}/json`)).status, 200);
  });

  test('plain http only for loopback names or with the insecure flag', async () => {
    const fetch = createSafeFetch({ trustedHost: 'id.example.org', lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
    assert.equal(await reason(fetch(`http://id.example.org:${port}/json`)), 'insecure');
    assert.equal(await reason(createSafeFetch({ trustedHost: 'x' })('file:///etc/passwd')), 'bad_url');
    assert.equal(await reason(createSafeFetch({ trustedHost: '127.0.0.1' })(`http://u:p@127.0.0.1:${port}/`)), 'bad_url');
  });

  test('size limit, redirects not followed unless allowed, and each hop checked again', async () => {
    assert.equal(await reason(createSafeFetch({ trustedHost: '127.0.0.1', maxBytes: 1000 })(`http://127.0.0.1:${port}/big`)), 'too_large');
    assert.equal(await reason(createSafeFetch({ trustedHost: '127.0.0.1' })(`http://127.0.0.1:${port}/hop`)), 'redirect');
    const following = createSafeFetch({ trustedHost: '127.0.0.1', maxRedirects: 2 });
    assert.deepEqual(await (await following(`http://127.0.0.1:${port}/hop`)).json(), { ok: true });
    // openid-client asks for redirect: 'manual' - the 302 comes back as it is
    assert.equal((await createSafeFetch({ trustedHost: '127.0.0.1' })(`http://127.0.0.1:${port}/hop`, { redirect: 'manual' })).status, 302);
  });

  test('a form body is sent as openid-client sends it', async () => {
    const fetch = createSafeFetch({ trustedHost: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${port}/post`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
    });
    assert.deepEqual(await res.json(), { method: 'POST', body: 'grant_type=authorization_code&code=abc', type: 'application/x-www-form-urlencoded' });
  });
});
