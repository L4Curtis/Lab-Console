/** HTTP hardening helpers shared by every module */
import net from 'node:net';

/** Strict security headers; The UI is fully self-hosted, so 'self' is enough */
export function securityHeaders(req, res, next) {
  const host = req.headers.host || '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // xterm.js injects runtime <style> rules
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://${host} wss://${host}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

/**
 * WebSocket upgrades are not covered by CORS, so a malicious page could open a
 * terminal on behalf of a visitor (cross-site WebSocket hijacking)
 * Only accept the platform's own origin, plus explicitly configured ones
 */
export function isOriginAllowed(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Fixed-window rate limiter keyed by client (IP) */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/**
 * Middleware form of the same-origin rule, for state-changing requests: another
 * website must not be able to make a visitor's browser act on the platform
 * (cross-site request forgery). GET and HEAD pass, they never change state
 */
export function requireSameOrigin(allowedOrigins = []) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || isOriginAllowed(req, allowedOrigins)) return next();
    res.status(403).json({ error: 'Cross-origin request refused', code: 'server.cross_origin', params: {} });
  };
}

// ── Client address behind reverse proxies ───────────────────────────────────
//
// X-Forwarded-For is written by whoever sends the request, so it is only
// believed when the TCP peer is a proxy we were told about (TRUSTED_PROXIES).
// Anyone else could put a classmate's address there to dodge a rate limit or
// to sign the audit trail with it

/** "::ffff:192.0.2.7" (IPv4 seen through a dual-stack socket) → "192.0.2.7" */
export function normalizeIp(address) {
  const ip = String(address ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/**
 * Compile TRUSTED_PROXIES entries (single addresses or CIDR blocks, IPv4 or
 * IPv6) into a matcher. Throws on the first entry that is not an address, so
 * the configuration can refuse to start
 */
export function parseTrustedProxies(entries = []) {
  const blocks = new net.BlockList();
  for (const entry of entries) {
    const [address, prefix, extra] = String(entry).trim().split('/');
    const ip = normalizeIp(address);
    const family = net.isIP(ip);
    const bits = prefix === undefined ? null : Number(prefix);
    const max = family === 4 ? 32 : 128;
    if (!family || extra !== undefined || (bits !== null && (!/^\d{1,3}$/.test(prefix) || bits > max))) {
      throw new Error(`"${entry}" is not an IP address or CIDR block`);
    }
    if (bits === null) blocks.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
    else blocks.addSubnet(ip, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return (address) => {
    const ip = normalizeIp(address);
    const family = net.isIP(ip);
    return family !== 0 && blocks.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };
}

const trustCache = new WeakMap();

/**
 * Turn the server configuration into `{ isTrusted(address), clientIp(req) }`.
 * `trust` is `config.server` ({ trustProxy, trustedProxies }); a bare boolean
 * is the upstream signature and means "trust any peer" when true.
 * A non-empty TRUSTED_PROXIES list wins over the legacy TRUST_PROXY=true
 */
export function proxyTrust(trust) {
  const key = trust !== null && typeof trust === 'object' ? trust : null;
  if (key && trustCache.has(key)) return trustCache.get(key);

  const listed = key?.trustedProxies?.length ? parseTrustedProxies(key.trustedProxies) : null;
  const trustAll = !listed && (key ? Boolean(key.trustProxy) : Boolean(trust));
  const isTrusted = listed || (() => trustAll);

  const resolved = {
    isTrusted,
    clientIp(req) {
      const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown';
      if (!isTrusted(peer)) return peer;
      const hops = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map(normalizeIp).filter(Boolean);
      if (!hops.length) return peer;
      // Upstream behaviour, kept for TRUST_PROXY=true: the first address wins
      if (trustAll) return net.isIP(hops[0]) ? hops[0] : peer;
      // Walk back from our own proxy: the first hop that is not one of our
      // proxies is the client; whatever precedes it was written by the client
      let client = peer;
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!net.isIP(hops[i])) break;
        client = hops[i];
        if (!isTrusted(client)) break;
      }
      return client;
    },
  };
  if (key) trustCache.set(key, resolved);
  return resolved;
}

/** The address a request really comes from; see proxyTrust for `trust` */
export function clientIp(req, trust) {
  return proxyTrust(trust).clientIp(req);
}
