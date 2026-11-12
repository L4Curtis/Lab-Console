/**
 * Client address (src/lib/security.js): X-Forwarded-For is written by the
 * sender, so it is believed only when the TCP peer is one of OUR proxies.
 * Rate limits and the audit trail depend on this
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, proxyTrust, parseTrustedProxies, normalizeIp, isOriginAllowed, requireSameOrigin } from '../src/lib/security.js';
import { fakeRequest, fakeResponse } from './helpers/fakes.js';

const from = (remoteAddress, forwardedFor) =>
  fakeRequest({ remoteAddress, headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor } });
const proxied = { trustProxy: false, trustedProxies: ['192.168.10.112', '10.0.0.0/8'] };

test('no proxy configured: the peer address, whatever the headers say', () => {
  const direct = { trustProxy: false, trustedProxies: [] };
  assert.equal(clientIp(from('192.168.10.20'), direct), '192.168.10.20');
  assert.equal(clientIp(from('192.168.10.20', '1.2.3.4'), direct), '192.168.10.20');
  assert.equal(clientIp(from('192.168.10.20', '1.2.3.4'), false), '192.168.10.20');
});

test('a spoofed X-Forwarded-For from an untrusted peer is ignored', () => {
  // A student talks to the app directly and pretends to be someone else
  assert.equal(clientIp(from('192.168.10.20', '192.168.10.21'), proxied), '192.168.10.20');
  assert.equal(clientIp(from('192.168.10.20', '127.0.0.1'), proxied), '192.168.10.20');
  assert.equal(clientIp(from('192.168.10.20', '192.168.10.112'), proxied), '192.168.10.20', 'naming our proxy does not make you the proxy');
  assert.equal(clientIp(from('::ffff:192.168.10.20', '10.1.2.3, 192.168.10.112'), proxied), '192.168.10.20');
  assert.equal(clientIp(from('203.0.113.9', '8.8.8.8'), proxied), '203.0.113.9');
});

test('a trusted proxy is believed: the client is the hop it reports', () => {
  assert.equal(clientIp(from('192.168.10.112', '203.0.113.7'), proxied), '203.0.113.7');
  assert.equal(clientIp(from('10.4.5.6', '203.0.113.7'), proxied), '203.0.113.7', 'CIDR block');
  assert.equal(clientIp(from('192.168.10.112', '2001:db8::7'), proxied), '2001:db8::7', 'IPv6 clients');
  assert.equal(clientIp(from('192.168.10.112'), proxied), '192.168.10.112', 'no header: the proxy itself');
  assert.equal(clientIp(from('192.168.10.112', ''), proxied), '192.168.10.112');
});

test('behind a trusted proxy, what the client put in the header is still ignored', () => {
  // Client 203.0.113.7 sends "X-Forwarded-For: 192.168.10.21"; our proxy appends the real address
  assert.equal(clientIp(from('192.168.10.112', '192.168.10.21, 203.0.113.7'), proxied), '203.0.113.7');
  assert.equal(clientIp(from('192.168.10.112', '1.1.1.1, 2.2.2.2, 203.0.113.7'), proxied), '203.0.113.7');
});

test('a chain of trusted proxies is walked back to the first address that is not ours', () => {
  // client → Cloudflare-like edge (10.9.9.9) → reverse proxy (192.168.10.112) → app
  assert.equal(clientIp(from('192.168.10.112', '203.0.113.7, 10.9.9.9'), proxied), '203.0.113.7');
  assert.equal(clientIp(from('192.168.10.112', '6.6.6.6, 203.0.113.7, 10.9.9.9'), proxied), '203.0.113.7');
  assert.equal(clientIp(from('192.168.10.112', '10.9.9.9, 10.8.8.8'), proxied), '10.9.9.9', 'only proxies: the outermost one');
});

test('garbage in the header never becomes the client address', () => {
  assert.equal(clientIp(from('192.168.10.112', 'not-an-ip'), proxied), '192.168.10.112');
  assert.equal(clientIp(from('192.168.10.112', '<script>, 203.0.113.7'), proxied), '203.0.113.7');
  assert.equal(clientIp(from('192.168.10.112', '203.0.113.7, unknown'), proxied), '192.168.10.112');
  assert.equal(clientIp(from('192.168.10.112', ' , ,'), proxied), '192.168.10.112');
});

test('IPv4-mapped IPv6: the proxy seen through a dual-stack socket is the same proxy', () => {
  assert.equal(clientIp(from('::ffff:192.168.10.112', '203.0.113.7'), proxied), '203.0.113.7');
  assert.equal(clientIp(from('::FFFF:10.1.2.3', '::ffff:203.0.113.7'), proxied), '203.0.113.7');
  const mapped = { trustedProxies: ['::ffff:192.168.10.112'] };
  assert.equal(clientIp(from('192.168.10.112', '203.0.113.7'), mapped), '203.0.113.7', 'and the other way round');
  assert.equal(clientIp(from('::ffff:192.168.10.113', '203.0.113.7'), mapped), '192.168.10.113');
  assert.equal(normalizeIp('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
});

test('IPv6 proxies and blocks work too', () => {
  const v6 = { trustedProxies: ['fd00::/8', '2001:db8::1'] };
  assert.equal(clientIp(from('fd12:3456::1', '203.0.113.7'), v6), '203.0.113.7');
  assert.equal(clientIp(from('2001:db8::1', '203.0.113.7'), v6), '203.0.113.7');
  assert.equal(clientIp(from('2001:db8::2', '203.0.113.7'), v6), '2001:db8::2');
});

test('legacy TRUST_PROXY=true: any peer is believed, first address wins (upstream behaviour)', () => {
  assert.equal(clientIp(from('192.168.10.20', '203.0.113.7, 10.0.0.1'), true), '203.0.113.7');
  assert.equal(clientIp(from('192.168.10.20', '203.0.113.7'), { trustProxy: true, trustedProxies: [] }), '203.0.113.7');
  assert.equal(clientIp(from('192.168.10.20'), true), '192.168.10.20');
  assert.equal(clientIp(from('192.168.10.20', '<script>alert(1)</script>'), true), '192.168.10.20', 'but only an address is accepted');
});

test('TRUSTED_PROXIES wins over the legacy switch when both are set', () => {
  const both = { trustProxy: true, trustedProxies: ['192.168.10.112'] };
  assert.equal(clientIp(from('192.168.10.20', '203.0.113.7'), both), '192.168.10.20');
  assert.equal(clientIp(from('192.168.10.112', '203.0.113.7'), both), '203.0.113.7');
});

test('no socket address at all: "unknown", never a header value', () => {
  assert.equal(clientIp(fakeRequest({ remoteAddress: null, headers: { 'x-forwarded-for': '203.0.113.7' } }), proxied), 'unknown');
});

test('parseTrustedProxies: addresses and CIDR blocks, anything else is an error', () => {
  const trusted = parseTrustedProxies(['192.168.10.112', '10.0.0.0/8', '172.16.0.0/12', '::1']);
  for (const yes of ['192.168.10.112', '10.255.255.255', '172.31.0.1', '::1', '::ffff:10.0.0.1']) assert.equal(trusted(yes), true, yes);
  for (const no of ['192.168.10.113', '11.0.0.0', '172.32.0.1', '::2', '', undefined, 'nonsense']) assert.equal(trusted(no), false, String(no));
  for (const bad of ['proxy.example.org', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/8/8', '::1/129', '300.1.1.1', '10.0.0.0/-1', '10.0.0.0/x']) {
    assert.throws(() => parseTrustedProxies([bad]), /is not an IP address or CIDR block/, bad);
  }
  assert.equal(parseTrustedProxies([])('127.0.0.1'), false, 'an empty list trusts nobody');
});

test('proxyTrust: one compiled matcher per configuration, usable as Express "trust proxy"', () => {
  const trust = proxyTrust(proxied);
  assert.equal(proxyTrust(proxied), trust);
  assert.equal(trust.isTrusted('10.1.1.1'), true);
  assert.equal(trust.isTrusted('192.168.10.20'), false);
  assert.equal(proxyTrust({ trustProxy: true }).isTrusted('8.8.8.8'), true);
  assert.equal(proxyTrust({}).isTrusted('127.0.0.1'), false);
});

test('same-origin rule: reads pass, writes need the platform\'s own origin', () => {
  const run = (req, allowed = []) => {
    const res = fakeResponse();
    let passed = false;
    requireSameOrigin(allowed)(req, res, () => { passed = true; });
    return { passed, res };
  };
  const post = (headers) => fakeRequest({ method: 'POST', url: '/api/proxmox/clone', headers });
  assert.equal(run(fakeRequest({ method: 'GET', headers: { host: 'lab.example.org' } })).passed, true);
  assert.equal(run(post({ host: 'lab.example.org', origin: 'https://lab.example.org' })).passed, true);
  assert.equal(run(post({ host: 'lab.example.org', origin: 'https://other.example.org' }), ['https://other.example.org']).passed, true);

  for (const headers of [{ host: 'lab.example.org', origin: 'https://evil.example' }, { host: 'lab.example.org' }, { host: 'lab.example.org', origin: 'null' }]) {
    const { passed, res } = run(post(headers));
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Cross-origin request refused', code: 'server.cross_origin', params: {} });
  }
  assert.equal(isOriginAllowed(fakeRequest({ headers: { host: 'a', origin: 'http://a' } })), true);
});
