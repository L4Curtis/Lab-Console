/**
 * Outgoing HTTP requests to an address an administrator typed (the identity
 * provider set on the SSO settings page), guarded against server-side
 * request forgery
 *
 *   const fetch = createSafeFetch({ trustedHost: 'id.example.org', allowInsecure: false });
 *   const res = await fetch('https://id.example.org/.well-known/openid-configuration');
 *
 * The server sits on the lab network and next to other services, so "fetch
 * this URL" must not become a way to reach them. The rules:
 *
 *   - https only. Plain http is accepted for a loopback host (the mock
 *     provider on a developer's machine) or with `allowInsecure` (a test
 *     bench, the same flag as OIDC_ALLOW_INSECURE);
 *   - the host the administrator chose (`trustedHost`) may be on the LAN: a
 *     school's own provider often is. Any OTHER host - an endpoint the
 *     discovery document points to, the target of a redirect - must resolve
 *     to public addresses only;
 *   - some addresses are never reached, whoever asks: unspecified, link-local
 *     (the cloud metadata service lives at 169.254.169.254), multicast,
 *     reserved and broadcast;
 *   - the check is made on the addresses the connection really uses (a custom
 *     DNS lookup), so a name that resolves to a public address for the check
 *     and to an internal one for the connection (DNS rebinding) does not pass;
 *   - every request has a deadline and a size limit; redirects are not
 *     followed unless `maxRedirects` allows it, and each hop is checked again.
 *
 * The returned function has the shape of fetch (url, { method, headers, body,
 * signal, redirect }) → Promise<Response>, which is also what openid-client
 * accepts as its `customFetch`. Failures reject with a SafeFetchError whose
 * `reason` says what was refused, in words fit for an administrator
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const SAFE_FETCH_DEFAULTS = Object.freeze({ timeoutMs: 8000, maxBytes: 1024 * 1024, maxRedirects: 0 });
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const NO_BODY = new Set([101, 103, 204, 205, 304]);

export class SafeFetchError extends Error {
  /** reason: bad_url | insecure | forbidden_address | internal_address | redirect | too_many_redirects | timeout | too_large | unreachable */
  constructor(reason, message, cause) {
    super(message);
    this.name = 'SafeFetchError';
    this.reason = reason;
    this.cause = cause;
  }
}

function blocks(v4, v6) {
  const list = new net.BlockList();
  for (const cidr of v4) {
    const [ip, bits] = cidr.split('/');
    list.addSubnet(ip, Number(bits), 'ipv4');
  }
  for (const cidr of v6) {
    const [ip, bits] = cidr.split('/');
    list.addSubnet(ip, Number(bits), 'ipv6');
  }
  return list;
}

/** Never reached, whatever the host: nothing legitimate lives there */
const FORBIDDEN = blocks(
  ['0.0.0.0/8', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'],
  ['::/128', 'fe80::/10', 'ff00::/8', '2001:db8::/32', '100::/64'],
);
/** Private networks: reachable only on the host the administrator chose */
const INTERNAL = blocks(
  ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15'],
  ['::1/128', 'fc00::/7', 'fec0::/10'],
);

/** An IPv4 address carried inside an IPv6 one (mapped, NAT64): judged as the IPv4 address */
function embeddedV4(ip) {
  const m = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (m) return m[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** → 'public' | 'internal' | 'forbidden' | null (not an address) */
export function addressKind(address) {
  let ip = String(address ?? '').replace(/^\[|\]$/g, '');
  let family = net.isIP(ip);
  if (family === 6) {
    const v4 = embeddedV4(ip);
    if (v4) { ip = v4; family = 4; }
  }
  if (!family) return null;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (FORBIDDEN.check(ip, type)) return 'forbidden';
  if (INTERNAL.check(ip, type)) return 'internal';
  return 'public';
}

/** May a connection to `ip` be made for a host that is (or is not) the trusted one? Throws a SafeFetchError when not */
function checkAddress(ip, trusted) {
  const kind = addressKind(ip);
  if (kind === null || kind === 'forbidden') throw new SafeFetchError('forbidden_address', `${ip} is an address that is never contacted`);
  if (kind === 'internal' && !trusted) throw new SafeFetchError('internal_address', `${ip} is an internal address; only the provider's own host may be on the local network`);
}

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

/**
 * Options: trustedHost (the host the administrator typed, may be internal),
 * allowInsecure, timeoutMs, maxBytes, maxRedirects, lookup (test seam:
 * a dns.lookup replacement)
 */
export function createSafeFetch({ trustedHost, allowInsecure = false, lookup = dns.lookup, ...limits } = {}) {
  const { timeoutMs, maxBytes, maxRedirects } = { ...SAFE_FETCH_DEFAULTS, ...limits };
  const trustedName = String(trustedHost ?? '').replace(/^\[|\]$/g, '').toLowerCase();

  function checkUrl(url) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SafeFetchError('bad_url', `${url.protocol} URLs are not fetched`);
    if (url.username || url.password) throw new SafeFetchError('bad_url', 'URLs with credentials are not fetched');
    if (url.protocol === 'http:' && !allowInsecure && !LOOPBACK_NAMES.has(url.hostname.toLowerCase())) {
      throw new SafeFetchError('insecure', `${url.origin} is plain http: https is required (or the insecure flag, on a test bench)`);
    }
    const trusted = hostOf(url) === trustedName;
    if (net.isIP(hostOf(url))) checkAddress(hostOf(url), trusted); // no DNS lookup happens for a literal address
    return trusted;
  }

  /** The DNS lookup every connection goes through: the addresses checked are the ones used */
  const guardedLookup = (trusted) => (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || net.isIP(addresses) }];
      try {
        if (!list.length) throw new SafeFetchError('unreachable', `${hostname} has no address`);
        for (const { address } of list) checkAddress(address, trusted);
      } catch (refusal) {
        return callback(refusal);
      }
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };

  function once(url, { method = 'GET', headers, body, signal }, trusted) {
    return new Promise((resolve, reject) => {
      const outgoing = Object.fromEntries(new Headers(headers ?? {}).entries());
      outgoing['accept-encoding'] = 'identity';
      let payload = null;
      if (body !== undefined && body !== null) {
        payload = Buffer.from(body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : new Uint8Array(body));
        outgoing['content-length'] = String(payload.length);
      }
      const transport = url.protocol === 'https:' ? https : http;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.destroy();
        reject(err instanceof SafeFetchError ? err : new SafeFetchError('unreachable', `${url.origin} could not be reached: ${err.message}`, err));
      };
      const request = transport.request(url, { method, headers: outgoing, lookup: guardedLookup(trusted) }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return fail(new SafeFetchError('too_large', `${url.origin} answered more than ${maxBytes} bytes`));
          chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const responseHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          const status = response.statusCode;
          resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, statusText: response.statusMessage, headers: responseHeaders }));
        });
      });
      const timer = setTimeout(() => fail(new SafeFetchError('timeout', `${url.origin} did not answer within ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
      request.on('error', fail);
      if (signal) {
        if (signal.aborted) return fail(new SafeFetchError('timeout', 'The request was cancelled'));
        signal.addEventListener('abort', () => fail(new SafeFetchError('timeout', 'The request was cancelled')), { once: true });
      }
      request.end(payload ?? undefined);
    });
  }

  return async function safeFetch(input, options = {}) {
    let url;
    try { url = new URL(String(input)); } catch { throw new SafeFetchError('bad_url', 'Not a URL'); }
    let trusted = checkUrl(url);
    for (let hops = 0; ; hops += 1) {
      const response = await once(url, options, trusted);
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location || options.redirect === 'manual') return response;
      if (hops >= maxRedirects) {
        if (maxRedirects === 0) throw new SafeFetchError('redirect', `${url.origin} answered with a redirect, which is not followed`);
        throw new SafeFetchError('too_many_redirects', `More than ${maxRedirects} redirects`);
      }
      let next;
      try { next = new URL(location, url); } catch { throw new SafeFetchError('bad_url', 'The redirect leads to an invalid URL'); }
      trusted = checkUrl(next);
      url = next;
      if (options.method && options.method !== 'GET' && options.method !== 'HEAD') options = { ...options, method: 'GET', body: undefined };
    }
  };
}
