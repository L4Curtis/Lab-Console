# Lab Console v2 — architecture and contracts

This document is the shared contract for everyone working on v2. Lots are built
in parallel on separate branches: the interfaces below are what lets them merge.

**If you must deviate from a contract, change this file in the same commit and
say so in your report.** A contract that silently drifts breaks another lot.

Feature decisions live in [SPEC.md](SPEC.md). Base: upstream v1.1.1.

## 1. Principles

1. **Keep the stack simple.** Plain ES modules, no build step, no TypeScript, no
   front-end framework, `node:test`, because they are simple, not to stay
   mergeable with upstream (owner decision, 12 Nov: clean code comes first;
   unclear code is rewritten inside a lot's scope). Same file style: a header
   comment explaining the *why*, small modules, private `#fields`.
2. **Security by default.** Every HTTP route, SSE stream and WebSocket requires
   an authenticated user unless listed as public in §4. Authorization is
   checked on the server for every action; the browser is never trusted.
3. **Nothing destructive without a successful backup and an explicit
   confirmation.** A device whose backup failed is never erased silently.
4. **The simulator is the only lab.** Code and tests never contact a real
   jump server. Everything is exercised against `dev/` mocks.
5. **No database.** State lives in JSON / JSONL files under the data directory.
6. **The Proxmox module is out of scope.** Do not modify `src/modules/proxmox/`,
   `src/lib/sshTunnel.js` or `public/js/modules/infra/` beyond what
   authentication and i18n strictly require: upstream is reworking it. One
   exception (admin lot): its SSH tunnel follows the lab settings and
   reconnects on their `'change'` event; its Proxmox URL and credentials
   still come from the environment only.

## 2. Repository layout

```
src/
  server.js                 composition root: createApp(), middleware order, module mounting
  config.js                 frozen config object, assembled from fragments; loadConfig()
  lib/
    env.js                  env readers + validation errors      (lot: skeleton)
    store.js                data directory, JSON / JSONL files   (lot: skeleton)
    audit.js                audit trail                          (lot: skeleton)
    settings.js             run-time settings, labSettings.js the "lab" namespace   (lot: admin)
    sealed.js               secrets saved from the admin pages, encrypted with APP_SECRET
    diagrams.js             the active diagram in DATA_DIR, its versions and checks   (lot: admin)
    infrastructure.js       the admin switches list (shipped file, then DATA_DIR)    (lot: admin)
    events.js               SSE hub, with per-user audiences     (lot: skeleton)
    httpError.js            API error shape: HttpError, sendError (lot: skeleton)
    security.js             headers, origin check, rate limiter, client IP, trusted proxies
    cliAutomation.js        expect-like engine on a console line
    drivers/ciscoIos.js     device procedures built on the engine (lot: ios)
  modules/
    auth/                   sessions, OIDC, local accounts + TOTP, roles   (lot: auth)
    consoles/               diagram, rooms, console WebSocket    (lot: rooms)
    benches/                occupancy, reservations, history     (lot: benches)
    admin/                  lab parameters + confirmation, diagram versions, switches, sessions,
                            audit viewer, announcements, health, journaling   (lot: admin)
    jobs/                   bench jobs, snapshots                (lot: jobs)
    collab/                 device notes, bench chat, notifications
    scripts/                shared script library
    checks/                 line status, cabling, ping matrix, interface overlay
    proxmox/                unchanged
public/
  login.html, js/login.js   the only page served without a session, and its script (lot: auth)
  js/core/                  dom.js, api.js, i18n.js, session.js, userMenu.js   (public: the login page uses them)
  js/shared/                workspace, panes, dialog.js, tabs.js
  js/modules/<section>/     one folder per rail section
  locales/<lang>/<ns>.json  one namespace per module (fr, en); common.json is shared
  css/<module>.css          one stylesheet per module, loaded by the module; shared.css for dialog / tabs
dev/                        mock-lab.js, fakeIos.js, mock-oidc.js, mock-proxmox.js
test/                       *.test.js (node:test)   test/e2e/*.e2e.js (browser)
test/helpers/               app.js (startTestApp), fakes.js (users, fakeAuth, fake req / res)
docs/v2/                    this file, SPEC.md
```

Vocabulary: a **lab** (code) is one page of the diagram, shown to users as a
**bench** (English UI) / **baie** (French UI), e.g. `B4M`. A **device** is a
shape with a console address. A **target** is `host:port` on a console server.

## 3. Configuration

`src/lib/env.js` exports the readers that used to be private in `config.js`:
`str`, `required`, `int`, `bool`, `list`, `portRange`, plus `oneOf(name,
allowed, fallback)` and `origin(name)`, and the shared `errors` array. A
reader never throws: it pushes a message to `errors` and returns its fallback.
A fragment reports its own problems with `fail(message)`.

`src/config.js` still exports one frozen (deeply) `config`, built from
fragments: a module that needs settings exports `readConfig()` from
`src/modules/<id>/config.js` and gets one line in `loadConfig()`
(`<id>: readXxxConfig()`). Never read `process.env` anywhere else (a test
enforces it for `src/`).

`loadConfig()` is exported too: it reads the environment again and returns a
new frozen object, or throws a `ConfigError` whose `problems` lists every
error. Importing `src/config.js` evaluates it once and exits the process on
error, so only the process entry point imports `config`; everything else
receives it through `deps`.

Global keys added by the skeleton:

| Variable | Default | In `config` | Meaning |
|---|---|---|---|
| `PUBLIC_URL` | — | `server.publicUrl` | Public origin, e.g. `https://lab.example.org` (no path). Required. Drives OIDC redirect URIs and cookie security. |
| `DATA_DIR` | `./data` | `dataDir` (absolute) | Writable state directory. The Docker image sets `/data`. |
| `TRUSTED_PROXIES` | empty | `server.trustedProxies` (string[]) | Comma list of proxy IPs / CIDRs (IPv4, IPv6) whose `X-Forwarded-For` is believed: every hop, CDN ranges included. The upstream `TRUST_PROXY=true` (trust every peer) is refused at start-up and `server.trustProxy` no longer exists. |
| `DEFAULT_LOCALE` | `fr` | `defaultLocale` | UI language for a first visit (`fr` or `en`). |
| `APP_SECRET` | empty | `appSecret` | Optional, 32 characters at least. Encrypts (AES-256-GCM, key derived with HKDF) the secrets saved from the administration pages: the SSO client secret in `data/auth/oidc.json` and the lab parameters' secrets in `data/settings/lab.json`. Without it they are kept in clear in files of mode 600. Changing it makes them unreadable (the page says so). |

`PORT=0` is accepted and binds any free port (tests, the e2e harness).

There is no mode without sign-in (owner decision, 12 Nov). The auth fragment
(`src/modules/auth/config.js`, `config.auth`) makes the local administrator
mandatory: without `LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD_HASH` and
`LOCAL_ADMIN_TOTP_SECRET` the configuration is refused with a message that
says to run `npm run setup-admin`. `config.auth` is
`{ localAdmin: { username, passwordHash, totpSecret }, oidc }`, where `oidc`
is the object of `src/modules/auth/oidcSettings.js` (`enabled`, `issuer`,
`clientId`, `clientSecret`, `clientAuthMethod`, `scopes`, `groupsClaim`,
`adminGroups`, `allowedGroups`, `providerName`, `allowInsecure`), validated by
`normalizeOidcSettings()`, the same function a later admin page uses. The
variables are listed in `.env.example` and explained in [AUTH.md](AUTH.md).

Every new variable is documented in `.env.example`. Secrets never get defaults.

## 4. Request pipeline

`src/server.js` exports `createApp({ config, logger?, createAuth?, createModules? })`
→ `{ app, server, modules, deps, listen(), close() }` and only listens when it
is run directly (`node src/server.js`). Order inside `createApp`:

1. `securityHeaders`
2. public static assets: `/css`, `/vendor` (`/vendor/simplewebauthn` is the
   WebAuthn browser library), `/locales`, `/js/core`, `/favicon.svg` (also
   answered on `/favicon.ico`). A missing public file is a 404, never a
   redirect to the login page.
3. `GET /api/health` (liveness only, no detail)
4. auth routes: `app.use(auth.router)` — `/login`, `/js/login.js`, `/auth/*`
   (all `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`), and
   the routes other modules add with `auth.extend()`: the accounts module's
   `/join`, `/reset`, `/js/join.js`, `POST /auth/invitation`, `/auth/signup`,
   `/auth/reset-link`, `/auth/reset` and `/auth/passkey/*`. Each checks what
   it needs itself (a link's token, a passkey ceremony) and is listed in the
   allow-list of `test/routeWalk.test.js`
5. **gate**: `auth.attach` then `auth.requireAuth` — everything below needs a user
6. state-changing requests (anything but GET / HEAD, on any path) must pass
   the existing same-origin check: `requireSameOrigin(allowedOrigins)` from
   `src/lib/security.js`. Routes mounted **above** the gate are not covered:
   the auth lot applies the same middleware to its own POST routes.
7. app shell and remaining static files
8. `/api/events` (SSE), `/api/modules`, then each module router at `/api/<id>`
9. JSON 404 for `/api/*` and the error handler

WebSocket upgrades are handled in this order: same-origin check (403), then
`await auth.authenticateUpgrade(req)` — a missing user ends the socket with
401 — then `req.user` is set and the modules are asked in turn (404 when none
takes the path). A module's `upgrade(req, socket, head)` therefore always sees
`req.user`. Modules may keep their own origin check; it is no longer required.

API errors are JSON: `{ "error": "English sentence", "code": "module.reason", "params": {} }`.
The browser translates `code` when it knows it and falls back to `error`.
Use `src/lib/httpError.js`: either `sendError(res, status, code, message, params)`,
or `throw httpError(status, code, message, params)` from a handler (async
handlers included: Express 5 forwards the rejection) and the error handler
answers. Any other thrown error is logged and answered as a 500
`server.internal` without detail. Codes used by the platform itself:
`server.not_found`, `server.bad_request` (malformed body), `server.too_large`,
`server.cross_origin`, `server.internal`, `auth.required`, `auth.forbidden`.
The Proxmox module is unchanged and still answers `{ error }` without a code:
its job labels and messages, its serial and status frames and its API error
bodies reach the UI in English (known gap, to translate when the module is
opened). Diagram `warnings` and `error` (`/api/consoles/labs`, `labs:version`)
are `{ code, params, message }` objects, not strings.

**Client address.** `clientIp(req, config.server)` (`src/lib/security.js`) is
the only way to read it: the TCP peer, unless that peer is listed in
`TRUSTED_PROXIES`, in which case `X-Forwarded-For` is walked from the right
and the first address that is not one of our proxies is the client. A header
sent by anyone else is ignored. It works on Express requests and on raw
upgrade requests; Express's `req.ip` follows the same rule. Limits and audit
entries are per user (§13); the address is only a secondary key.

## 5. Identity

```js
User = {
  id,          // 'oidc:<sub>' | 'local:<username>'
  username, name, email,
  role,        // 'student' | 'admin'
  groups,      // string[] from the identity provider
  via,         // 'oidc' | 'local'
  initials, color   // stable, derived from id, for presence badges
}
```

There is no anonymous user and no mode without sign-in: every request below
the gate carries a real user from a real session.

The auth module returns this service, passed to every module as `deps.auth`:

```js
auth.attach(req, res, next)    // sets req.user and req.sessionId (or leaves them undefined)
auth.requireAuth(req, res, next)   // 401 JSON under /api and for writes, 302 /login?next=… otherwise
auth.requireRole('admin')      // middleware, 403 JSON
auth.authenticateUpgrade(req)  // → User | null, for WebSocket upgrades; the socket closes when the session ends
auth.sessions.list() / .revoke(sessionId) / .revokeUser(userId)
auth.sessions.create(user, { ip, userAgent }) // → { id, token, cookie }: a session in the store (tests)
auth.sessions.open(req, res, user)   // sign this browser in as someone the server authenticated another
                               //   way (passkey, invitation): previous session ended, cookie set → session;
                               //   a local account's browser becomes known for its name (lc_device)
auth.accounts.add(provider)    // another source of local accounts → remove()
auth.steps.peek(req) / .complete(req, res, { method, user }) / .fail(req, res) / .start(req, res, user, requires, { binding })
                               // a sign-in whose password was right and that still owes a passkey;
                               //   peek() hands back the provider's `binding` (see Ways in)
auth.extend(router, { describe })    // public routes mounted above the gate; describe(req) adds fields to /auth/me
auth.reauthenticate(user, { password, code })   // → boolean: the environment's administrator proves itself
                               //   again before a sensitive change (an accepted code is burnt); false for anyone else
auth.environmentAdminId        // 'local:<LOCAL_ADMIN_USERNAME>'
auth.oidc.settings             // current OIDC settings, without the secret ({ …, hasClientSecret })
auth.oidc.configure(raw)       // replace them at run time (validated; open sessions untouched); an omitted
                               //   clientSecret keeps the current one for the same issuer and client id only
auth.oidc.redirectUri          // the callback URL to give the provider
auth.oidc.trial(req, res, { returnTo, onResult, reauth })   // → { url }: a sign-in at the provider that opens no
                               //   session; onResult gets the claims, the user id and the role they give.
                               //   `reauth: true` asks for a fresh sign-in (prompt=login, max_age=0) and refuses
                               //   an answer whose auth_time/iat is older than 2 minutes (an SSO administrator
                               //   confirming a lab change: admin/confirm.js)
auth.router                    // /login, /js/login.js, /auth/*; mounted before the gate
auth.cookieName                // '__Host-lc_sid' | 'lc_sid'
auth.shutdown()                // stops the timers, writes the sessions; called when the application closes
```

`src/modules/auth/index.js` exports `createAuth(deps)` (deps: `{ config,
logger, events, store, audit }`) and, for every module and for tests,
`requireAuth`, `requireRole`, `hasRole(user, role)`, `createUser` and
`ROLES`. Roles are ordered: `student` < `admin`, so `requireRole('student')`
lets an admin through. `requireAuth` answers 401 JSON (`auth.required`) under
`/api/` and for any non-GET request, 302 `/login` otherwise (with
`?next=<path>` so the user comes back); `requireRole` answers 403
`auth.forbidden` with `params.role`. `createUser({ id, username, name, email,
role, groups, via })` builds the frozen `User` above, `initials` and `color`
included (`user.js` also exports `initialsOf` and `colorOf`).

`createAuth` throws when the local administrator or `PUBLIC_URL` is missing.

**Ways in.** Both end in the same kind of session, and the session id is new
at every sign-in.

- OpenID Connect (`oidc.js`): authorization code + PKCE S256 + `state` +
  `nonce`, ID token signature checked against the provider's keys. The
  pending sign-in (state, nonce, verifier, return path) stays on the server,
  10 minutes, single use, bound to the browser by the `lc_login` cookie
  (`__Host-lc_login` over https). The return path is a same-origin relative
  path only (`safeReturnPath`). Groups come from `OIDC_GROUPS_CLAIM` in the ID
  token, else from userinfo; a string is one group or a comma list.
- Local accounts (`accounts.js`): the form posts `{ username, password, code,
  next }` to `POST /auth/local`; every registered provider is asked, the first
  one being the environment's administrator (`envAdmin.js`: scrypt hash,
  RFC 6238 TOTP ±1 step, a step that was accepted is dead, even across a
  restart), the second the directory of the accounts module (accounts created
  through invitations; the code is ignored). A provider is `{ id, verify({
  username, password, code }) → { user, requires? } | null }` and does the
  same work whether or not the name exists. One generic refusal (401
  `auth.invalid_credentials`) for every cause. A provider that answers
  `requires: ['passkey' | 'passkey-enrol']` (a local account promoted to
  administrator) gets no session: the answer is `{ step }`, a 5-minute,
  single-use step is kept on the server (cookie `lc_step`, `__Host-` over
  https), and the accounts module finishes it with `auth.steps.complete()`
  once the passkey is given or registered. The provider may add an opaque
  `binding` to its answer, kept with the step: the directory binds a step to
  a fingerprint of the password hash and to the passkeys the account had, so
  a password reset or change, or passkeys cleared, end the steps in progress
  as they end the sessions.
- Passkeys (accounts module, `@simplewebauthn/server`): one-click sign-in with
  a discoverable credential and user verification (`/auth/passkey/options`,
  `/auth/passkey/verify`), and the step above. Relying party = the host of
  `PUBLIC_URL`, origin = `PUBLIC_URL`; offered only over https on a domain
  name, or on `http://localhost` (tests). Challenges stay on the server, 5
  minutes, single use, bound to the browser (cookie `lc_passkey`) and to what
  they were issued for. Local accounts only: SSO accounts rely on their
  provider, the environment's administrator keeps password + TOTP.
- Attempts on the local form are limited (`throttle.js`) per client address
  (5 per 15 min), per user name (exponential backoff after 2 failures, one
  attempt in flight), and globally (past 50 failures per 15 min, a name that
  failed itself waits until the count goes down; a name with no failure of
  its own still gets in, so strangers failing on made-up names never refuse
  a student's right password): 429 `auth.throttled` with `Retry-After` and
  `params.seconds`, identical for an unknown name. A browser that already
  signed in with that name (password, sign-up or passkey) carries a signed
  `lc_device` cookie (`devices.js`, 180 days) and is limited on its own
  instead (5 per 15 min, its own backoff), so strangers cannot keep the
  owner of a name out. Refusals that cost nothing (throttled attempts, callbacks
  without a sign-in in progress, the latter limited to 60 a minute per
  address) are audited once per address and kind per 15 min, then summed up
  in one `auth.login.suppressed` entry (`refusals.js`).
- The local administrator's sessions are stored with a fingerprint of its
  credentials (`envAdmin.js` `binding`); after a restart with other
  credentials they are not restored. The known-browser key does not: it is
  a random secret in `data/auth/device-key.json`, so the administrator's
  known browsers keep their own limits across a change of credentials.

**Roles.** `resolveRole({ groups, adminGroups, storedRole })` in `roles.js`
is the only place a role is decided: admin when a group is in
`OIDC_ADMIN_GROUPS`, otherwise student, and a role stored per user wins: at
every provider sign-in the callback asks `services.accounts.roleOverride(id)`
(set by an administrator on the Users tab), then `services.accounts.admit(user,
{ groupRole })`, which records the account in the directory and answers
`false` for a disabled one (`/login?error=account_disabled`). Local accounts
carry their role in the directory. `isAllowed()` applies `OIDC_ALLOWED_GROUPS`
(an admin group always counts); a refused user lands on
`/login?error=not_allowed`.

`GET /auth/me` is public and returns `{ user, locale, providerName, passkeys }`
(`user: null` when nobody is signed in, `locale` = `DEFAULT_LOCALE`,
`providerName` = the sign-in button's label or `null` without a provider,
`passkeys` = whether this site offers them); the browser reads it once
through `public/js/core/session.js` (`await loadSession()`, then
`session.user`, `session.isAdmin`, `session.locale`, `session.providerName`,
`session.passkeys`; `signOut()` posts `/auth/logout`
and follows its `redirect`, the provider's end-session page when it has one).
`public/js/core/userMenu.js` (`mountUserMenu()`, called once from `main.js`)
shows the user, the role and the sign-out button at the bottom of the rail.

Sessions are server-side, keyed by a random 256-bit token in a cookie named
`__Host-lc_sid` when `PUBLIC_URL` is https (`Secure; HttpOnly; SameSite=Lax; Path=/`)
and `lc_sid` otherwise (development and tests over http). The cookie has no
`Max-Age`: it ends with the browser. Idle timeout 8 h (an open WebSocket
counts as activity), absolute lifetime 24 h, at most 10 sessions per user.
`data/auth/sessions.json` keeps them across a restart, keyed by the SHA-256 of
the token: the token itself is never stored. When a session ends (sign-out,
revocation, expiry, a new sign-in in the same browser) the WebSockets opened
with it are destroyed and the user's SSE streams are ended
(`events.disconnect((u) => u?.id === id)`); they reconnect only with another
valid session.

## 6. Platform services

Created once in `server.js` and passed to every module in `deps`:
`{ config, logger, events, infra, store, audit, auth, settings, diagrams, services }`.

**store** (`src/lib/store.js`)

```js
store.resolve('snapshots', bench, name)   // absolute path inside DATA_DIR; throws on traversal
store.dir('journal', bench)               // same, and creates the directory
store.json('benches/occupancy.json', {})  // → { get(), set(value), update(fn) }  atomic, serialized
store.jsonl('audit/2026-11.jsonl')        // → { append(obj), read({ limit, since, until, filter }) }
store.safeName(label)                     // any label → a file name resolve() accepts
store.flush()                             // resolves when every pending write is done
```

- **Paths.** The first segment may be a literal relative path
  (`'benches/occupancy.json'`); every further segment is ONE name and may not
  contain a separator. Refused everywhere (`StoreError`, `code: 'store.path'`):
  `..`, `.`, empty or hidden names (leading dot), `/`, `\`, control
  characters, surrounding spaces, names over 200 bytes. Names with spaces or
  accents are fine. `json()` and `jsonl()` also take an array of segments:
  `store.jsonl(['collab/chat', bench + '.jsonl'])`. For a label that may
  contain anything (a device name with a slash), use `safeName()` and keep the
  real name inside the document.
- **`json(path, fallback)`** returns the same handle for the same file, so
  updates are serialized across modules. `get()` is **synchronous** and
  returns a private copy (the fallback while the file does not exist).
  `set(value)` and `update(fn)` return promises resolved once the content is
  on disk (temporary file + rename, mode 0600). `update(fn)` gives `fn` a
  private copy; `fn` returns the new value or changes the copy in place, and
  may be async — other updates of that document wait. If `fn` throws or the
  write fails, nothing changes, on disk or in memory. A file that is not valid
  JSON is renamed `<name>.corrupt-<ts>` and the fallback is used.
- **`jsonl(path)`**: `append(obj)` returns a promise; `read()` resolves to the
  entries in file order, `limit` keeps the most recent ones, `since` / `until`
  compare with each entry's `ts` (ISO string or ms). Unparsable lines are skipped.
- Other files (a snapshot's `.cfg`, a diagram version) are written by the
  module itself with `store.resolve` / `store.dir` and `writeFileAtomic(file, data)`,
  exported by `src/lib/store.js`.
- `createStore(dataDir)` throws at start-up when the directory cannot be
  created or written (`code: 'store.unwritable'`).

**audit** (`src/lib/audit.js`)

```js
audit.log(actor, action, details)   // actor: req | User | 'system'
audit.query({ since, until, actorId, action, bench, limit })
```

`log()` never throws and never rejects; it returns a promise of `true`
(written) or `false` (lost, and reported in the server log) that callers
normally ignore. An entry is
`{ ts, action, actor: { id, username, name, role, via }, ip?, details }`;
`ip` is present when the actor is a request. `query()` resolves to entries
**newest first** (`limit` defaults to 200, at most 5000); `action` matches
exactly or as a dotted prefix (`'console'` selects `console.open` and
`console.control.grant`) and may be an array. Keys of `details` that look like
credentials (`password`, `secret`, `token`, `totp`…) are stored as
`[redacted]`, and details over 16 KB are reduced to `{ bench, device, truncated }`:
safety nets, not a licence to pass secrets.

Actions are `module.verb[.detail]`: `auth.login`, `console.open`,
`console.control.grant`, `bench.take`, `job.reset.start`. Put the bench name in
`details.bench` and the device name in `details.device` when they apply.
Never log secrets, passwords, tokens or typed keystrokes.

**events** (`src/lib/events.js`) — one SSE stream per browser tab

```js
events.publish(topic, data, { sticky, audience })  // audience: (user) => boolean
events.toUser(userId, topic, data)
events.clear(topic)                 // forget a sticky topic
events.disconnect((user) => bool)   // end matching streams (session revoked); returns how many
events.count(userId?)               // open streams
```

Topics are `module:name`. Sticky topics are replayed on connect, through the
same audience filter: the audience is stored with the snapshot and evaluated
again for each new stream, with the user of that stream. One snapshot per
topic: a later sticky publish replaces both the data and the audience. An
audience that throws counts as "no". The handler reads `req.user`. The filter
is not re-run when rights change later: publish again when the membership of
an audience changes.

**services** — a plain object. A module publishes its API as
`services.<id> = {...}` while being created and other modules read it lazily,
inside handlers, never at creation time (creation order must not matter).
Today the consoles module publishes `services.consoles = { registry }`; the
rooms lot adds `rooms` and `sharedTargets()`.

`createApp().close()` calls every module's `shutdown()`, `auth.shutdown?.()`,
ends the SSE streams, closes the HTTP server and waits for `store.flush()`.
A module must release in `shutdown()` whatever would keep the process alive
(timers that are not `unref`'d, file watchers, sockets).

**settings** (`src/lib/settings.js`, passed as `deps.settings`) — values an
administrator may change at run time. **Read them each time a connection or
a console is opened**, never once at start-up.

```js
settings.get(ns)                    // current values, a private copy (secrets included: server side only)
settings.describe(ns)               // { values (secrets as { set: true|false }), fields, saved: [paths], unreadable: [paths],
                                    //   updatedAt, updatedBy, encrypted }
settings.check(ns, patch)           // update()'s validation alone → { changed, reset }, or the same 400; nothing saved
settings.update(ns, patch, actor)   // → describe(ns) + { changed, reset }; 400 settings.invalid { problems: [{ field, code }] }
                                    //   only the fields a namespace lists exist: 'constructor' or '__proto__' are { code: 'unknown' }
settings.register(ns, { defaults: () => values, fields: { 'dotted.path': { type, … } }, check?(values) → problems })
settings.on('change', (ns, values) => …)   // → off(); after a save that changed something
```

- `get('lab')` returns `{ ssh, telnet, consoles }` with the shapes of
  `config.ssh`, `config.telnet` and `config.consoles` (an SSH key read from a
  file is handed out as text). Editable fields (`src/lib/labSettings.js`):
  `ssh.host|port|username|password|privateKey|passphrase|hostFingerprint`,
  `telnet.username|password|autoLogin|wakeIdleMs`,
  `consoles.allowedHosts|portRange`. Everything else (timeouts, tunnel
  transport, the diagram's network prefix) stays with the environment.
- The environment gives the starting values; a saved field wins; saving
  `null` for a field brings the environment's value back. A patch carries
  only what changes; a secret left out is kept. Types: `string`, `int`,
  `bool`, `list`, `range`, `secret`; every field is checked, then the
  namespace's `check()` on the values that would apply (lab: a password or a
  key, a key that parses, a passphrase that opens it). Nothing is saved when
  one problem is found.
- Saved in `data/settings/<ns>.json` (mode 600), one entry per field.
  Secrets are sealed with `src/lib/sealed.js` (AES-256-GCM under a key
  derived from `APP_SECRET`, in clear without it); one that cannot be opened
  any more falls back to the environment and is listed in `unreadable`.
- `update()` audits `settings.update` with `{ ns, changed, reset, values }`:
  field names only for secrets, new values for the others.
- Modules that keep a long-lived connection listen for `'change'`: the
  consoles registry reloads (the allow-list may have moved), the Proxmox
  tunnel reconnects, the health cache is dropped.
- Confirmation is not the service's job: the admin module's `PUT /api/admin/lab`
  requires a ticket (`src/modules/admin/confirm.js`).

**diagrams** (`src/lib/diagrams.js`, passed as `deps.diagrams`) — the active
lab diagram is `data/diagrams/current.drawio`, seeded from `DIAGRAM_PATH` on
the first start (which becomes the first version).

```js
diagrams.currentPath                 // what the consoles registry reads and watches
diagrams.list()                      // { active, canRollback, previous, versions: [...] } newest first
diagrams.add(buffer, { name, actor }) → { version, warnings, labs }   // checked, kept, NOT active
diagrams.model(id) / diagrams.compare(id)   // parsed labs / what changes against the active one
diagrams.activate(id, actor) / diagrams.rollback(actor)
diagrams.fileOf(id)                  // absolute path of a version (download)
diagrams.on('change', fn)            // after an activation or a rollback
```

A file is refused (`admin.diagram_*`) over 5 MB or when its pages inflate to
more than 20 MB in all (`diagram_too_large`; the inflate itself is capped),
with a DOCTYPE or an entity declaration anywhere (`diagram_doctype`: checked
by the parser, `parseDrawio`, on the file and on every page it decodes, so
CDATA, comments or character references around a compressed page hide
nothing), when the parser rejects it, without a single console device, and
at import or activation while two different devices share a console line
(`diagram_lint`, what `npm run check-diagram` fails on; a rollback is never
refused for it). 30 versions are
kept (never the active one nor the last ones a rollback may need). A rollback
returns to the diagram active before the current one (a stack of activations).

**infra** (`src/lib/infrastructure.js`, `deps.infra`) — the admin switches.
`infra.adminSwitches` is the current list (read it when a console opens);
`infra.describe()`, `infra.replace(list, actor)` (validated, audited
`admin.switches.update`), `infra.on('change')`. The shipped file
(`INFRA_CONFIG_PATH`) is the starting point; an edited list lives in
`data/admin/switches.json` and wins.

## 7. Server modules

The upstream contract is unchanged:
`{ id, title, enabled, router?, upgrade?(req, socket, head) → boolean, shutdown?() }`,
registered with one line in `src/modules/index.js`. A module owns its folder,
its `/api/<id>` routes, its `data/<id>/` subtree, its locale namespace and its
front-end section. It checks roles itself with `auth.requireRole` or
`req.user.role`.

Cross-module APIs (published in `services`):

```js
services.consoles = {
  registry,                      // LabRegistry: model, getDevice(key), on('change')
  rooms,                         // RoomManager, see §9
  sharedTargets(),               // Set of 'host:port' used by several labs
}
services.teams = {                           // lot teams
  teamOf(userOrId) → Team | null               // { id, name, members: userId[] }
  get(teamId) → Team | null
  list() → Team[]
}
services.benches = {                           // lot teams
  holder(labName) → { teamId, since } | null   // the team that took the bench
  occupants(labName) → userId[]                // team members + accepted guests
  isOccupant(user, labName) → boolean
  canOperate(user, labName) → boolean          // occupant or admin, and the bench is not locked
  canPilot(user, device) → boolean             // the rule of SPEC "Lot teams / Permissions"
  lock(labName) → { reason, by, at } | null
  touch(labName)                               // activity, postpones auto-release
  onRelease(fn)                                // hook: fn({ labName, teamId, by }); the jobs lot offers a backup
}
services.accounts = {                          // lot accounts
  get(userId) → Account | null                 // { id, username, name, role, state, via, hasPasskey, … }
  list() → Account[]                           // the environment's administrator first ({ environment: true })
  roleOverride(userId) → 'student' | 'admin' | null   // forced on an SSO account; null = its groups decide
  admit(user, { groupRole }) → Promise<boolean>       // called by the sign-in module at each SSO sign-in
  confirmation: {                              // a local administrator proves itself again with a passkey
    available(user) → boolean
    options(req, res) → PublicKeyCredentialRequestOptionsJSON   // challenge bound to browser, account and session
    verify(req, res, response) → Promise<boolean>
  }
}
services.admin = { announcement() → { text, level, at, expiresAt, by } | null }   // lot admin
services.jobs = { running(labName) → Job | null, list({ bench }) }
```

## 8. Front end

- **Sections.** `public/js/main.js` keeps the `MODULES` array; a new rail
  section is one line there and one folder in `public/js/modules/`. `id` is
  the server module (`/api/modules`), `path` the address and the section's
  class (`section.view-<path>`); `when: () => session.isAdmin` keeps a section
  away from students, `rail: false` leaves it out of the rail. The
  **Administration** section (`#/admin/<tab>`, `modules/admin/index.js`) is
  for administrators, built with `shared/tabs.js`; the accounts lot's tabs are
  `users`, `invitations`, `sso`; the admin lot's are `lab`, `diagram`,
  `switches`, `sessions`, `audit`, `announcement` (one file in
  `modules/admin/tabs/`, one line each). **Lab status** (`#/status/<tab>`,
  `modules/status/index.js`, every signed-in user): `health` and
  `journaling`. The **announcement banner** (`shared/announcement.js`,
  mounted once by `main.js`) follows the sticky SSE topic `admin:announcement`. **My account** (`#/account`) is
  reached from the user menu. Passkeys in the browser go through
  `core/passkeys.js` (public: the login page and `/join` use it).
- **Tabs.** A section with several screens uses `shared/tabs.js`:
  `mountTabs(container, tabs, { navigate, base })` where a tab is
  `{ id, title, load: () => import('./tabs/x.js') }` and the tab file exports
  `mount(el, ctx) → { show?, hide? }`. Adding a tab is one file and one line.
  The returned object has `show(params)` (params = `[tabId, ...rest]` from the
  address), `hide()`, `select(id)`, `current`, `destroy()`: a section forwards
  its own `show` / `hide` to it. Tabs are mounted on first display and stay
  mounted. `title` is a string or a function (`() => t('admin.tabs.audit')`,
  re-evaluated when the language changes); `when: () => boolean` hides a tab.
  Other options: `label` (accessible name), `bar` (element that receives the
  tab buttons), `ctx` (merged into what each tab's `mount` receives, with
  `navigate` and `tab`). `base` is the section's hash, e.g. `'#/admin'`.
- **Start-up.** `main.js` awaits `loadSession()` then
  `initI18n({ defaultLocale: session.locale })` before it builds anything, so
  `session` and `t()` are usable synchronously everywhere else.
- **i18n.** `core/i18n.js` exports `t(key, params)`, `loadNamespace(ns)`,
  `getLocale()`, `setLocale()`. Keys are `ns.path.to.text`; dictionaries are
  `public/locales/<lang>/<ns>.json`. **No user-visible literal in JavaScript or
  HTML**: every string goes through `t()`, with both `fr` and `en` entries.
  French is the reference wording; write it the way a French networking
  student would say it, not as a translation. Interpolation is `{name}`.
  - Lookup: current language → `en` → the key itself. A namespace must be
    loaded (`await loadNamespace('benches')`, typically at the top of the
    section's `mount`) before its keys resolve; `common` is loaded at start-up.
  - Plurals: an entry may be `{ "one": "{count} ligne", "other": "{count} lignes" }`,
    selected by `params.count` with the language's rules. Use the same forms
    in both languages (the parity test compares leaf keys).
  - `setLocale(lang)` stores the choice with `prefs` (`labconsole.locale`),
    reloads every namespace in use, sets `<html lang>`, re-applies static
    markup and calls the `onLocaleChange(fn)` listeners. A screen built with
    `h()` re-renders its texts in such a listener (or is rebuilt).
  - Static markup: `data-i18n="key"` sets the text, `data-i18n-title`,
    `data-i18n-aria-label`, `data-i18n-placeholder` set attributes;
    `translateDom(root)` applies them, and it runs by itself on the document
    at start-up and on every language change.
  - API errors: `core/api.js` puts `status`, `code`, `params` and
    `serverMessage` on the thrown error and sets `message` to the translation
    of `code` when there is one. Code `module.reason` is looked up as
    `<module>.errors.<reason>` (the module's namespace), then as
    `common.errors.<module>.<reason>`. `tError(code, params, fallback)` does
    the same for codes received over a WebSocket.
- **Dialogs.** `shared/dialog.js`: `confirmDialog({ title, body, confirmLabel,
  danger, requireText })`, `formDialog(...)`, `openDialog(node)`. No
  `window.confirm` / `alert`.
  - `confirmDialog({ title, body, confirmLabel, cancelLabel, danger, requireText })`
    → `Promise<boolean>`. `body` is a string, a node or an array of them
    (strings are text, never HTML). `danger` makes it an `alertdialog` with
    the focus on Cancel; `requireText` locks the button until that exact text
    is typed.
  - `formDialog({ title, intro, fields, submitLabel, cancelLabel, danger, wide, validate, onSubmit })`
    → `Promise<values | null>`. A field is `{ name, label, type, value,
    required, placeholder, hint, options, attrs }` with type `text` (trimmed),
    `password`, `number`, `email`, `textarea`, `select`, `checkbox`, or a DOM
    node inserted as is. `validate(values)` returns a message or nothing;
    `onSubmit(values)` may be async: if it throws, its message is shown and
    the dialog stays open; what it returns becomes the result.
  - `openDialog(node, { title, label, wide, role, describedBy, dismissible, initialFocus })`
    → `{ el, close(value), closed }` for anything else (a countdown, a report).
  - All three trap Tab, close on Escape (unless `dismissible: false`), name
    the dialog for screen readers and give the focus back on close.
- **Styles.** A module ships `public/css/<module>.css` and loads it with
  `loadCss('<module>')` from `core/dom.js` (once per page; resolves when the
  rules apply). Use the existing custom properties
  (`--surface`, `--ink`, `--console`, `--led-green`…) so both themes work.
- **DOM.** Build nodes with `h()`. Never assign user-controlled data to
  `innerHTML`. Add icons to the `ICONS` map in `core/dom.js`.
- **Diagram decorations** (owned by the rooms lot): `DiagramView` exposes
  `decorate(layer, fn)` where `fn(device) → { ring?, badges?, tooltip? } | null`
  and `refresh()`. Presence, line status, job progress and notes are layers.
- **Pane actions** (owned by the rooms lot): `registerPaneAction({ id, icon,
  title, when(session), run(pane) })` adds a button to console tiles.

## 9. Consoles and rooms

One **room** per console line. The room owns the SSH → telnet session; browsers
attach to it. `RoomManager` (`services.consoles.rooms`):

```js
rooms.get(targetKey) → ConsoleRoom | undefined
rooms.list() → RoomSummary[]
rooms.open(device, user, { cols, rows }) → ConsoleRoom    // creates or returns
rooms.on('change', (summaries) => {})

room.attach(client)                     // client: { user, send(msg), sendBytes(buf), close() }
room.write(user, data)                  // ignored unless user is the pilot
room.requestControl(user) / room.grantControl(to, by) / room.releaseControl(user)
room.runExclusive(actor, label, async (cli) => { ... })   // automation takes the keyboard
room.cli                                // CliAutomation bound to this line
room.summary()                          // { target, bench, device, users, pilot, task, since, lastActivity }
```

`runExclusive` follows the same handover rule as a human request: if another
user is piloting, they are asked, and control passes automatically after 30 s
without an answer or when they have been idle for 2 min. It rejects with
`code: 'console.control.refused'` when the pilot refuses.

WebSocket `/ws/console?device=<key>&cols&rows` keeps the upstream frames and
adds, server → client: `{type:'replay'}` followed by the buffered bytes,
`{type:'presence', users, pilot, you}`, `{type:'control', event, by, to}`;
client → server: `{type:'control', action:'request'|'grant'|'deny'|'release'}`.

SSE topics: `consoles:rooms` (sticky, all room summaries), `consoles:activity`.

### Device automation (lot: ios)

`src/lib/cliAutomation.js` is the engine on one console line. Steps (only
inside a task: output is captured while a task runs, a step outside one
throws `automation.no_task`):

```js
cli.perform(label, async (cli) => { ... })     // the one exclusive task on the line
cli.command(cmd, { until, paging, timeout, idle, settle }) → { output, complete, outcome }
cli.wait(pattern, { timeout, idle, settle, optional }) / cli.expect({ name: RegExp | fn }, opts) → { name, match, outcome }
cli.waitQuiet(ms, { timeout }) → boolean        // false: the device keeps printing (booting)
cli.answer(text) / cli.type(text) / cli.send(text) / cli.sendLine(text) / cli.pause(ms) / cli.reset()
cli.findPrompt({ nudge }) → { host, configMode, mark }
cli.readRunningConfig(progress) / cli.sendScript(script, options, progress)   // the features, as steps
cli.exportRunningConfig() / cli.injectScript()  // the same as standalone tasks (console tile)
cli.cancel()                                    // steps reject with err.cancelled
```

Prompt checks ignore syslog lines printed after a prompt (`screenTail`), and
the pager answers every `--More--` even when syslog lines follow it.

`src/lib/drivers/ciscoIos.js`: `new CiscoIos(cli, { timeouts, progress })`.
A procedure runs inside the task that holds the console (`room.runExclusive`)
or takes it itself. Each returns `{ ok: true, ... }` or `{ ok: false, reason:
'ios.<code>', message, params, stage?, lastOutput? }`; cancellation rethrows
the engine's `cancelled` error with `err.stage`. Codes are translated under
`ios.errors.*`, progress under `ios.steps.*` (`public/locales/*/ios.json`).

```js
ios.prepare({ enablePasswords, linePasswords, screen }) → { hostname, startState, steps }
ios.identify() → { family: 'ios'|'iosxe', kind: 'router'|'switch', model, version, configRegister, registerOk, warnings, ... }
ios.runningConfig() → { hostname, config }
ios.vlans() → { supported, vlans: [{ id, name, status, ports }], vtp: { version, mode, domain, password, pruning } | null }
ios.cdpNeighbors() → { enabled, neighbors: [...] }   ios.interfaces() → { interfaces: [...] }   ios.ping(ipv4, { repeat })
ios.eraseAndReload({ backup, verifyBackup, facts }) → { hostname, kind, vlanDat, register, answered, warnings }
toReplayScript(config, { vlans, vtp, facts, rsaModulus }) → { script, dropped, vlans, lineTimeouts }
comparableConfig(config) → text                     // snapshot vs live, volatile lines removed
checkBackupProof(proof) → { ok, kind, hostname }
```

- `prepare` never types into ROMMON, a boot loader or a booting device and
  never loops on a password prompt (three attempts each for the line password
  and the enable secret). Pass the room's recent output as `screen`: without
  it the first key is a wake-up Enter, which would confirm a `[confirm]`
  someone left on screen.
- `eraseAndReload` does nothing without `backup`: `{ kind: 'snapshot',
  snapshotId, config, hostname? }` (the backup it replaces) or `{ kind:
  'override', by, reason }` (an admin ticked "erase without a backup").
  `verifyBackup(backup)` is the jobs' own check. Budgets cover the slowest
  family (`TIMEOUTS`: 15 min boot, 5 min without output); tests pass shorter.
- Send the replay script with `injectScript(script, { skipComments: false,
  lineTimeouts })`: banner text may start with `!`, and `lineTimeouts` (from
  `toReplayScript`) gives `crypto key generate rsa` a longer budget.
- A switch backup keeps `vtp` with its VLANs (on classic IOS the VTP domain,
  mode and password live in vlan.dat, not in show running-config) and passes
  both to `toReplayScript`. `vtp.password` is a secret of the backup, like the
  ones in the running-config.

`dev/fakeIos.js` impersonates each family (`MODELS`: 1841, 2801, 2811,
isr4331, 2960, 3560, 3560v2, c1000, c9300l); `dev/mock-lab.js` keeps one
device per console port for its whole life and answers `nc -z -w <s> <host>
<port>` (exit 0: the line is free, 1: busy or down).

## 10. Data directory

```
data/
  auth/sessions.json        auth/local-admin.json (last TOTP step used)   auth/device-key.json (known-browser key)
  audit/<yyyy-mm>.jsonl
  diagrams/current.drawio   diagrams/versions/<ts>-<user>-<rand>.drawio   diagrams/index.json
  journal/<bench>/<device>/<yyyy-mm-dd>.log
  teams/teams.json          benches/occupancy.json    benches/locks.json    benches/reservations.json
  accounts/users.json       accounts/invitations.json    auth/oidc.json (600)
  settings/<ns>.json (600)
  snapshots/<bench>/<ts>-<label>/{manifest.json,<device>.cfg,<device>.vlan.txt}
  templates/<name>/...      same layout as a snapshot
  collab/notes.json         collab/chat/<bench>.jsonl
  scripts/library.json
  admin/announcements.json  admin/switches.json
```

The image runs read-only; `DATA_DIR` is the only writable path. Bench and
device names used in paths go through `store.resolve`, never string concat.

## 11. Testing

- `npm test` runs every `test/**/*.test.js` with `node:test`. It must pass and
  stay under a minute. (The glob needs Node 22, like the Docker image.)
- `npm run test:e2e` runs `test/e2e/*.e2e.js` serially: `playwright-core`
  driving the system Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`,
  headless, `--no-sandbox`). Every file goes through the shared harness,
  `test/e2e/harness.js`, never its own `chromium.launch`: `const h =
  useHarness({ oidc, mockLab, env })` starts, in `before()`, the mock lab
  (devices named after the diagram, a console server login answered by the
  app's auto-login), the mock OIDC provider and the app **on ephemeral
  ports** with a temporary data directory, then Chromium; `after()` closes
  them all and removes the directory, also when a test failed, when start-up
  failed half-way, or on SIGINT / SIGTERM (`teardown.e2e.js` checks it). A
  file's own `before()` awaits `h.ready` first (top-level hooks run
  concurrently). `h.newPage({ locale })` (with `page.errors`),
  `h.session(page, who)` (cookie of a session opened by the test helper),
  `h.adminCode()` (the next usable TOTP code); page helpers `signInAs(page,
  'alice')` (mock provider; first names or user names), `signInAsAdmin(page)`,
  `signOut(page)`, `setLanguage(page, lang)`, `waitForApp(page)`,
  `openConsole(page, bench, device)` → the pane, `typeInConsole(pane, line)`,
  `terminalText(pane | page)` (what is on screen), `waitForTerminal(pane,
  pattern)`. Helpers wait on conditions, never on fixed delays. Guide:
  [TESTING.md](TESTING.md).
- `test/helpers/app.js`: `startTestApp({ env, auth, modules, now })` starts
  the real application, real sign-in included, on a free port with a
  temporary `DATA_DIR` and returns `{ url, wsUrl, app, server, deps, config,
  dataDir, as(who), signIn(who), close() }`. Tests sign in; production code
  has no bypass:
  - `lab.as('student1' | 'student2' | 'student3' | 'admin' | user)` opens a
    real session in the session store (what a successful sign-in does) and
    returns `{ cookie }` headers, reused for the same user;
    `lab.signIn(who)` opens a new one → `{ id, token, cookie, headers, user }`
    (the id is what `auth.sessions.revoke()` takes);
  - `TEST_ADMIN` and `adminCode(timeMs)` are the local administrator of every
    test application and its current TOTP code; `now` gives the sign-in module
    a clock (`{ now: () => clock.ms }`) for expiry and code tests;
  - `test/helpers/browser.js`: `TestBrowser` (cookie jar, redirects followed
    by hand), `signInWithOidc(lab, username)` through the mock provider,
    `postLocalSignIn(lab, fields)`.
  `loadTestConfig(env)` returns a configuration. `test/helpers/fakes.js`:
  `student(n)`, `admin()`, `fakeRequest()`, `fakeResponse()`,
  `recordingLogger()`, and `fakeAuth()`, a test seam that wraps the real
  sign-in module: a request naming a user in an `x-test-user` header (or
  `?as=` on a WebSocket URL) gets that user's real session cookie before the
  real gate looks at it; no header = nobody. To test a module in the real
  pipeline as a student, an admin and nobody, either works:
  `startTestApp({ modules: (deps) => [createMyModule(deps)] })` with
  `lab.as('student1')`, or `startTestApp({ auth: fakeAuth(), modules })`.
- `test/routeWalk.test.js` records every route and mount the application
  registers and asks each one without a session: only its explicit allow-list
  of public paths may answer. A new route is covered without touching it.
- `npm run lint` (ESLint flat config) must pass.
- The mocks are importable: `startMockLab({ port: 0, ssh, telnet, devices, ... })`
  returns `{ port, close(), device(target) }` (`device('10.22.9.4:2001')` is
  the simulated device behind that console port); `startMockOidc({ port: 0,
  users })` returns `{ issuer, close() }`. `test/helpers/ios.js` wires a
  simulated device to the engine and the driver (`rig()`, `roundTrip()`).
  The mock provider also has `misbehave({ wrongNonce, groupsInUserinfoOnly,
  groupsAsString, badSignature, noUserinfo, noEndSession })` and `signOuts`;
  its users are `student1`…`student3` (group `students`) and `admin`
  (`students`, `admins`), clients `lab-console` (secret `mock-secret`) and
  `lab-console-public` (no secret).
- Never hard-code a port in a test. Never leave a process running.
- A feature is not done until its happy path and its refusals are tested.

## 12. Conventions

- 2 spaces, single quotes, semicolons, trailing commas on multi-line literals.
- English code, comments, commit messages and API errors.
- Conventional Commits (`feat(auth): …`, `fix(rooms): …`, `test: …`), small
  and logical. Trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Never commit `.env`, `data/`, `node_modules/`, credentials or real configs.
- Dependencies allowed: `openid-client`, `fflate`, `diff`,
  `@simplewebauthn/server`, `@simplewebauthn/browser` (runtime; the browser
  bundle is served from `/vendor` like xterm);
  `playwright-core`, `eslint`, `@eslint/js`, `globals` (dev). TOTP, hashing and
  random values use `node:crypto`. Anything else needs a written reason in
  your report.

## 13. Security checklist (every lot)

- Route or message handler → who may call it? Enforced on the server?
- Input that reaches a file path, a shell command line, a regular expression
  or the device → validated against an allow-list?
- Upload → size limit, type check, no path from the archive trusted?
- Output shown to other users → rendered as text, never as HTML?
- Secret → never logged, never sent to the browser, never written to `data/`
  unless it is a hash? Two exceptions, secrets the server must send on:
  the SSO client secret (`data/auth/oidc.json`) and the lab parameters'
  secrets (jump server password, key and passphrase, console server password,
  `data/settings/lab.json`). Both files are mode 600 and the secrets are
  encrypted when `APP_SECRET` is set (`src/lib/sealed.js`); no answer and no
  audit entry ever contains them.
- Limits → per user, not per IP.

## 14. Recipes

Each recipe names every file to touch. `benches` is the example module.

### Add a server module

1. `src/modules/benches/index.js`:

   ```js
   import express from 'express';
   import { httpError } from '../../lib/httpError.js';

   export function createBenchesModule({ config, logger, events, store, audit, auth, services }) {
     const log = logger.child('benches');
     const occupancy = store.json('benches/occupancy.json', {});
     const router = express.Router();
     const json = express.json({ limit: '4kb' });

     router.get('/', (_req, res) => res.json({ benches: occupancy.get() }));
     router.post('/:bench/take', json, async (req, res) => {
       const bench = services.consoles.registry.model.labs.find((l) => l.name === req.params.bench); // read lazily
       if (!bench) throw httpError(404, 'benches.unknown', 'Unknown bench', { bench: req.params.bench });
       await occupancy.update((all) => { all[bench.name] = [req.user.id]; });
       audit.log(req, 'bench.take', { bench: bench.name });
       events.publish('benches:occupancy', occupancy.get(), { sticky: true });
       res.json({ ok: true });
     });
     router.delete('/:bench', auth.requireRole('admin'), async (req, res) => { /* … */ res.json({ ok: true }); });

     services.benches = { occupants: (name) => occupancy.get()[name] ?? [] };
     return { id: 'benches', title: 'Benches', enabled: true, router, shutdown() {} };
   }
   ```

2. One line in `src/modules/index.js`: add `createBenchesModule(deps)` to the list.
3. Nothing else: the router is mounted at `/api/benches` below the gate, so
   `req.user` is always set and the same-origin check already ran. A WebSocket
   endpoint is `upgrade(req, socket, head)` returning `true` when the path is
   yours; `req.user` is set there too.
4. Tests in `test/benches.test.js` with
   `startTestApp({ auth: fakeAuth(), modules: (deps) => [createConsolesModule(deps), createBenchesModule(deps)] })`:
   the happy path, then nobody (401), a student on an admin route (403), bad input (4xx).

### Add a rail section

1. `public/js/modules/benches/index.js` exporting `mount(el, ctx)` →
   `{ show?(params), hide?() }`. `mount` may be async: start it with
   `await Promise.all([loadNamespace('benches'), loadCss('benches')])`.
2. One line in the `MODULES` array of `public/js/main.js`:
   `{ id: 'benches', path: 'benches', title: …, icon: 'grid', load: () => import('./modules/benches/index.js') }`
   (`id` is the server module that answers `/api/modules`, `path` the hash).
3. `public/css/benches.css` and `public/locales/{fr,en}/benches.json`.
4. A new icon is one entry in the `ICONS` map of `public/js/core/dom.js`.

### Add a tab to a section

1. `public/js/modules/admin/tabs/audit.js` exporting `mount(el, ctx)` →
   `{ show?(params), hide?() }` (same contract as a section; `ctx.tab` is the
   tab id, `ctx.navigate` updates the address).
2. One line in the section's tab list:

   ```js
   const tabs = mountTabs(el, [
     { id: 'sessions', title: () => t('admin.tabs.sessions'), load: () => import('./tabs/sessions.js') },
     { id: 'audit', title: () => t('admin.tabs.audit'), load: () => import('./tabs/audit.js'), when: () => session.isAdmin },
   ], { navigate, base: '#/admin', label: t('admin.title') });
   return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
   ```

### Add a locale namespace

1. `public/locales/fr/benches.json` and `public/locales/en/benches.json` with
   the same keys (nested objects are fine). `npm test` fails when a key exists
   in one language only or when the `{placeholders}` differ.
2. `await loadNamespace('benches')` before the first `t('benches.…')`.
3. Translations of your API error codes go under `errors`:
   code `benches.unknown` → key `benches.errors.unknown`.

### Add a configuration fragment

1. `src/modules/benches/config.js`:

   ```js
   import { int, fail } from '../../lib/env.js';

   export function readConfig() {
     const idleHours = int('BENCH_IDLE_HOURS', 3, { min: 1, max: 48 });
     if (idleHours > 24) fail('BENCH_IDLE_HOURS above 24 makes no sense for a lab session');
     return { idleHours };
   }
   ```

2. One import and one line in `loadConfig()` of `src/config.js`:
   `benches: readBenchesConfig(),` — the module then reads `config.benches`.
3. Document the variable in `.env.example`; test it with
   `loadTestConfig({ BENCH_IDLE_HOURS: '5' })` and with a bad value
   (`assert.rejects`, the message is in `err.problems`).
