/**
 * A fake OpenID Connect provider, for tests and for a pre-production bench
 *
 *   import { startMockOidc } from './dev/mock-oidc.js';
 *   const idp = await startMockOidc({ port: 0 });      // { issuer, port, users, misbehave(), close() }
 *
 *   npm run mock-oidc -- --port 9100                    // then follow what it prints
 *
 * It lets ANYONE sign in as ANY of its users by clicking a name: there is no
 * password. It is a development tool and is built so that it cannot end up
 * in front of real accounts by accident:
 *   - the production image does not contain this folder (.dockerignore),
 *   - it refuses to start when NODE_ENV=production,
 *   - it listens on the loopback interface unless told `expose: true` / --expose,
 *   - Lab Console itself refuses a plain-http issuer that is not localhost
 *     unless OIDC_ALLOW_INSECURE=true, and logs a warning when it accepts one,
 *   - every page it shows says what it is.
 *
 * Implemented: discovery, authorize (with a user picker), token (authorization
 * code, PKCE S256 verified, client_secret_basic / client_secret_post / public
 * client), userinfo, jwks and end-session. ID tokens are RS256, signed with
 * node:crypto.
 *
 * It can be told to misbehave, so the client's refusals can be tested:
 *   wrongNonce            the ID token carries another nonce
 *   groupsInUserinfoOnly  no groups in the ID token, only at /userinfo
 *   groupsAsString        groups is one string ("students,admins"), not an array
 *   badSignature          the ID token's signature does not verify
 *   noUserinfo / noEndSession   the endpoint is not advertised
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_USERS = Object.freeze([
  { sub: 'mock-student1', username: 'student1', name: 'Alice Martin', email: 'alice.martin@example.test', groups: ['students'] },
  { sub: 'mock-student2', username: 'student2', name: 'Bilal Haddad', email: 'bilal.haddad@example.test', groups: ['students'] },
  { sub: 'mock-student3', username: 'student3', name: 'Chloé Dubois', email: 'chloe.dubois@example.test', groups: ['students'] },
  { sub: 'mock-admin', username: 'admin', name: 'Ada Admin', email: 'ada.admin@example.test', groups: ['students', 'admins'] },
]);

/** client id → { secret }: a null secret is a public client (PKCE only) */
export const DEFAULT_CLIENTS = Object.freeze({
  'lab-console': { secret: 'mock-secret' },
  'lab-console-public': { secret: null },
});

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const CODE_TTL_MS = 60_000;
const b64url = (value) => Buffer.from(value).toString('base64url');
const random = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f4f1ea; color: #1d2733; }
  .banner { background: #b3261e; color: #fff; padding: 10px 16px; font-weight: 600; text-align: center; }
  main { max-width: 440px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  ul { list-style: none; padding: 0; display: grid; gap: 8px; }
  a.user { display: block; padding: 12px 14px; border: 1px solid #c9c2b4; border-radius: 8px; background: #fff; color: inherit; text-decoration: none; }
  a.user:hover, a.user:focus { border-color: #1d6fb8; }
  a.user small { display: block; color: #5b6673; }
  .deny { color: #5b6673; }
</style></head>
<body><div class="banner">MOCK identity provider · faux fournisseur d'identité · no password, tests only</div>
<main>${body}</main></body></html>`;

export async function startMockOidc({
  port = 0, host = '127.0.0.1', expose = false, issuer: publicIssuer, users = DEFAULT_USERS, clients = DEFAULT_CLIENTS, misbehave: initialFlags = {},
} = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The mock identity provider signs anyone in without a password: it refuses to start with NODE_ENV=production');
  }
  if (!LOOPBACK.has(host) && !expose) {
    throw new Error(`The mock identity provider only listens on the loopback interface. To put it on ${host}, on a test bench, pass expose: true (--expose)`);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = random(8);
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const flags = { ...initialFlags };
  const requests = new Map();   // authorization requests waiting for a user to be picked
  const codes = new Map();      // authorization code → grant
  const accessTokens = new Map();
  const signOuts = [];          // what /end-session received, for tests
  let issuer = publicIssuer?.replace(/\/+$/, '') ?? null;

  const findUser = (username) => users.find((u) => u.username === username);
  const groupsOf = (user) => (flags.groupsAsString ? user.groups.join(',') : [...user.groups]);

  function signJwt(claims) {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(claims));
    let signature = crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey);
    if (flags.badSignature) signature = Buffer.from(signature).reverse();
    return `${head}.${body}.${signature.toString('base64url')}`;
  }

  const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const sendJson = (res, status, body, headers) => send(res, status, 'application/json', JSON.stringify(body), headers);
  const sendHtml = (res, status, title, body) => send(res, status, 'text/html; charset=utf-8', page(title, body));
  const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
  const oauthError = (res, status, error, description) => sendJson(res, status, { error, error_description: description });

  async function readForm(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024) throw new Error('body too large');
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  /** Who is calling the token endpoint: Basic header, or client_id (+ client_secret) in the body */
  function authenticateClient(req, form) {
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
    if (basic) {
      const [rawId, rawSecret = ''] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      const decode = (v) => decodeURIComponent(v.replace(/\+/g, ' '));
      id = decode(rawId);
      secret = decode(rawSecret);
    }
    const known = id && Object.hasOwn(clients, id) ? clients[id] : null;
    if (!known) return null;
    if (known.secret === null) return secret ? null : id; // a public client must not send a secret
    const given = Buffer.from(String(secret ?? ''));
    const expected = Buffer.from(known.secret);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? id : null;
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────
  function discovery(_req, res) {
    sendJson(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      ...(flags.noUserinfo ? {} : { userinfo_endpoint: `${issuer}/userinfo` }),
      ...(flags.noEndSession ? {} : { end_session_endpoint: `${issuer}/end-session` }),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'groups'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'name', 'preferred_username', 'email', 'groups'],
      authorization_response_iss_parameter_supported: true,
    });
  }

  function authorize(url, res) {
    const q = url.searchParams;
    const clientId = q.get('client_id');
    const redirectUri = q.get('redirect_uri');
    // Before the client and its redirect URI are known, errors are shown here, never redirected
    if (!clientId || !Object.hasOwn(clients, clientId)) return sendHtml(res, 400, 'Unknown client', `<h1>Unknown client</h1><p>${escapeHtml(clientId ?? '(none)')}</p>`);
    let target;
    try { target = new URL(redirectUri); } catch { target = null; }
    const registered = clients[clientId].redirectUris;
    if (!target || !['http:', 'https:'].includes(target.protocol) || (registered && !registered.includes(redirectUri))) {
      return sendHtml(res, 400, 'Bad redirect URI', `<h1>Bad redirect_uri</h1><p>${escapeHtml(redirectUri ?? '(none)')}</p>`);
    }
    const back = (params) => {
      for (const [k, v] of Object.entries({ ...params, state: q.get('state'), iss: issuer })) if (v !== null && v !== undefined) target.searchParams.set(k, v);
      redirect(res, target.href);
    };
    if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
    if (!(q.get('scope') ?? '').split(' ').includes('openid')) return back({ error: 'invalid_scope' });
    if (q.get('code_challenge') && q.get('code_challenge_method') !== 'S256') return back({ error: 'invalid_request', error_description: 'only S256 is supported' });

    const id = random(16);
    requests.set(id, {
      clientId, redirectUri, state: q.get('state'), nonce: q.get('nonce'), scope: q.get('scope'), codeChallenge: q.get('code_challenge'), createdAt: Date.now(),
    });
    const items = users.map((u) => `<li><a class="user" href="/authorize/pick?req=${id}&amp;user=${encodeURIComponent(u.username)}">
      ${escapeHtml(u.name)}<small>${escapeHtml(u.username)} · ${escapeHtml(u.groups.join(', '))}</small></a></li>`).join('');
    sendHtml(res, 200, 'Choose a user', `<h1>Sign in to ${escapeHtml(clientId)} as…</h1><ul>${items}</ul>
      <p><a class="deny" href="/authorize/pick?req=${id}&amp;deny=1">Refuse (access_denied)</a></p>`);
  }

  function pick(url, res) {
    const request = requests.get(url.searchParams.get('req'));
    requests.delete(url.searchParams.get('req'));
    if (!request || Date.now() - request.createdAt > 10 * 60_000) return sendHtml(res, 400, 'Expired', '<h1>This sign-in request has expired</h1>');
    const target = new URL(request.redirectUri);
    if (request.state !== null) target.searchParams.set('state', request.state);
    target.searchParams.set('iss', issuer);
    const user = findUser(url.searchParams.get('user'));
    if (url.searchParams.has('deny') || !user) {
      target.searchParams.set('error', 'access_denied');
      return redirect(res, target.href);
    }
    const code = random();
    codes.set(code, { ...request, user, expiresAt: Date.now() + CODE_TTL_MS });
    target.searchParams.set('code', code);
    redirect(res, target.href);
  }

  async function token(req, res) {
    const form = await readForm(req);
    const clientId = authenticateClient(req, form);
    if (!clientId) return oauthError(res, 401, 'invalid_client', 'unknown client or wrong secret');
    if (form.get('grant_type') !== 'authorization_code') return oauthError(res, 400, 'unsupported_grant_type', 'authorization_code only');

    const code = form.get('code');
    const grant = codes.get(code);
    codes.delete(code); // single use, whatever happens next
    if (!grant || grant.expiresAt < Date.now() || grant.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'unknown, expired or already used code');
    if (form.get('redirect_uri') !== grant.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
    if (grant.codeChallenge) {
      const verifier = form.get('code_verifier') ?? '';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== grant.codeChallenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    } else if (clients[clientId].secret === null) {
      return oauthError(res, 400, 'invalid_grant', 'a public client must use PKCE');
    }

    const now = Math.floor(Date.now() / 1000);
    const { user } = grant;
    const accessToken = random();
    accessTokens.set(accessToken, { user, expiresAt: Date.now() + 5 * 60_000 });
    const idToken = signJwt({
      iss: issuer, sub: user.sub, aud: clientId, iat: now, exp: now + 300, auth_time: now,
      ...(grant.nonce !== null ? { nonce: flags.wrongNonce ? `not-${grant.nonce}` : grant.nonce } : {}),
      name: user.name, preferred_username: user.username, email: user.email,
      ...(flags.groupsInUserinfoOnly ? {} : { groups: groupsOf(user) }),
    });
    sendJson(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken, scope: grant.scope });
  }

  function userinfo(req, res) {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    const grant = bearer && accessTokens.get(bearer[1]);
    if (!grant || grant.expiresAt < Date.now()) return sendJson(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    const { user } = grant;
    sendJson(res, 200, { sub: user.sub, name: user.name, preferred_username: user.username, email: user.email, groups: groupsOf(user) });
  }

  function endSession(url, res) {
    const q = url.searchParams;
    signOuts.push({ idTokenHint: q.get('id_token_hint'), clientId: q.get('client_id'), postLogoutRedirectUri: q.get('post_logout_redirect_uri') });
    const back = q.get('post_logout_redirect_uri');
    if (back) {
      try {
        const target = new URL(back);
        if (q.get('state')) target.searchParams.set('state', q.get('state'));
        return redirect(res, target.href);
      } catch { /* fall through to the page */ }
    }
    sendHtml(res, 200, 'Signed out', '<h1>Signed out of the mock provider</h1>');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /.well-known/openid-configuration': return discovery(req, res);
        case 'GET /authorize': return authorize(url, res);
        case 'GET /authorize/pick': return pick(url, res);
        case 'POST /token': return await token(req, res);
        case 'GET /userinfo': return userinfo(req, res);
        case 'GET /jwks': return sendJson(res, 200, { keys: [jwk] });
        case 'GET /end-session': return endSession(url, res);
        case 'GET /favicon.ico': res.writeHead(204); return res.end();
        case 'GET /': return sendHtml(res, 200, 'Mock identity provider', `<h1>Mock identity provider</h1><p>Issuer: <code>${escapeHtml(issuer)}</code></p>`);
        default: return sendJson(res, 404, { error: 'not_found' });
      }
    } catch (err) {
      sendJson(res, 500, { error: 'server_error', error_description: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const bound = server.address().port;
  issuer ??= `http://${host.includes(':') ? `[${host}]` : host}:${bound}`;

  return {
    issuer,
    port: bound,
    users,
    clients,
    signOuts,
    /** Change how the provider misbehaves: misbehave({ wrongNonce: true }); misbehave() makes it honest again */
    misbehave(next = null) {
      for (const key of Object.keys(flags)) delete flags[key];
      Object.assign(flags, next ?? {});
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ── Command line ─────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    const inline = args.find((a) => a.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
  };
  const misbehave = Object.fromEntries(String(option('misbehave', '')).split(',').filter(Boolean).map((flag) => [flag, true]));
  try {
    const idp = await startMockOidc({
      port: Number(option('port', process.env.MOCK_OIDC_PORT || 9100)),
      host: option('host', '127.0.0.1'),
      expose: args.includes('--expose'),
      issuer: option('issuer', undefined),
      misbehave,
    });
    console.log(`Mock identity provider listening at ${idp.issuer}  (anyone can sign in as anyone: never expose it)`);
    console.log('Users: ' + idp.users.map((u) => `${u.username} [${u.groups.join(', ')}]`).join(' · '));
    if (Object.keys(misbehave).length) console.log(`Misbehaving on purpose: ${Object.keys(misbehave).join(', ')}`);
    console.log('\nPut this in the .env of a Lab Console that runs next to it:\n');
    console.log(`OIDC_ISSUER=${idp.issuer}`);
    console.log('OIDC_CLIENT_ID=lab-console');
    console.log('OIDC_CLIENT_SECRET=mock-secret');
    console.log('OIDC_ADMIN_GROUPS=admins');
    console.log('OIDC_PROVIDER_NAME=Mock SSO');
    if (!idp.issuer.startsWith('http://localhost') && !idp.issuer.startsWith('http://127.0.0.1')) console.log('OIDC_ALLOW_INSECURE=true');
    const stop = () => idp.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    console.error(`\n✖ ${err.message}\n`);
    process.exit(1);
  }
}
