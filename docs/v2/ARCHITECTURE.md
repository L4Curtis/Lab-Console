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
5. **Structured state in a database, documents in files.** (Owner decision,
   13 Nov, replacing "no database".) Sessions, the audit trail, settings,
   accounts, teams, reservations… live in SQLite (`DATA_DIR/lab-console.db`,
   through the built-in `node:sqlite`), behind an asynchronous interface and
   portable SQL, so that moving to PostgreSQL later means writing one more
   adapter and nothing else (§6, "database"). Files stay files where they are
   documents people download or diff: backed-up configurations, console
   journals, diagram versions; the database only indexes them.
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
    db/                     the database (lot: db), see §6
      index.js              openDatabase(), createRepositories(), importLegacyFiles()
      sqlite.js             the SQLite adapter (node:sqlite); a PostgreSQL one would sit beside it
      portable.js           the portability rules every statement is checked against
      values.js             how ids, timestamps, booleans and JSON are stored
      migrate.js            migrations: loaded, applied in order, recorded
      migrations/NNN-name.js   one schema change each, never edited once merged
      repositories/<concern>.js   the only place SQL is written; index.js lists them
      legacy.js             one-time import of the JSON / JSONL files of before
    cachedDocument.js       state kept in memory, written through a repository (the store.json contract)
    audit.js                audit trail                          (lot: skeleton)
    settings.js             run-time settings, labSettings.js the "lab" namespace   (lot: admin)
    sealed.js               secrets saved from the admin pages, encrypted with APP_SECRET
    diagrams.js             the active diagram in DATA_DIR, its versions (index in the database) and checks   (lot: admin)
    infrastructure.js       the admin switches list (shipped file, then the database)    (lot: admin)
    events.js               SSE hub, with per-user audiences     (lot: skeleton)
    httpError.js            API error shape: HttpError, sendError (lot: skeleton)
    security.js             headers, origin check, rate limiter, client IP, trusted proxies
    cliAutomation.js        expect-like engine on a console line
    terminalText.js         terminal output as plain text (history search and download)   (lot: terminal)
    drivers/ciscoIos.js     device procedures built on the engine (lot: ios)
  modules/
    auth/                   sessions, OIDC, local accounts + TOTP, roles   (lot: auth)
    consoles/               diagram, rooms, console WebSocket    (lot: rooms)
    teams/                  teams; benches: occupancy, locks, reservations, history (lot: teams)
    accounts/               directory, invitations, reset links, passkeys, SSO settings (lot: accounts)
    admin/                  lab parameters + confirmation, diagram versions, switches, sessions,
                            audit viewer, announcements, health, journaling   (lot: admin)
    jobs/                   bench jobs (runner.js), snapshots and templates (library.js,
                            configFiles.js: files, hashes, ZIP)      (lot: jobs), see §9b
    collab/                 device notes, bench chat (notifications are browser work)   (lot: collab), see §9 "Group work"
    scripts/                shared script library: personal, team, published scripts   (lot: terminal)
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
test/helpers/               app.js (startTestApp), fakes.js (users, fakeAuth, fake req / res), db.js (memoryDatabase)
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
| `APP_SECRET` | empty | `appSecret` | Optional, 32 characters at least. Encrypts (AES-256-GCM, key derived with HKDF) the secrets saved from the administration pages: the SSO client secret and the lab parameters' secrets (both in the `settings` table of the database). Without it they are kept in clear in the database file (mode 600). Changing it makes them unreadable (the page says so). |

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
  a random secret in the database (`auth_state`; `npm run forget-browsers`
  removes it), so the administrator's
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
The `auth_sessions` table keeps them across a restart, keyed by the SHA-256 of
the token: the token itself is never stored. The session store works in
memory and writes behind (at once for a sign-in, a rotation or an end; "last
seen" every 30 s), so a request never waits for the database. When a session ends (sign-out,
revocation, expiry, a new sign-in in the same browser) the WebSockets opened
with it are destroyed and the user's SSE streams are ended
(`events.disconnect((u) => u?.id === id)`); they reconnect only with another
valid session.

## 6. Platform services

Created once in `server.js` and passed to every module in `deps`:
`{ config, logger, events, infra, store, repos, audit, auth, settings, diagrams, services }`.
The database is opened, migrated and the legacy files imported before any
other service is created; `createApp()` is therefore **async** and rejects,
with nothing left open, when the database cannot be used.

**database** (`src/lib/db/`, passed as `deps.repos`)

Modules never see the database itself, only **repositories**: one per
concern, the only place SQL is written (a test fails on SQL anywhere else in
`src/`). `repos = createRepositories(db)` holds them all:

```js
await repos.audit.insert(entry)
await repos.sessions.all()
await repos.transaction(async (r) => { await r.sessions.remove(id); await r.audit.insert(e); })  // one transaction
```

Today: `sessions`, `authState` (the local administrator's last TOTP step, the
known-browser key), `audit`, `settings` (run-time settings, plus the rows
`sso` and `switches`), `legacyImports`, `teams`, `benches` (occupancy, locks,
reservations), `accounts` (with their passkeys), `accountLinks` (invitation
and reset links), `announcements`, `diagrams` (the index of diagram versions
and the stack of activations), `journalDays` (§9), `jobs`, `snapshots`,
`templates` (§9b), `scripts` (the script library, §9), `collab` (device
notes and bench chat, §9 "Group work"). Modules that read their
state synchronously on every request keep it in memory with
`createCachedDocument({ fallback, load, save })` (`src/lib/cachedDocument.js`,
the contract of `store.json()`: serialized updates, nothing changes when the
write fails), loaded in their `start()`; the repository's `save(next, prev)`
writes only the records that changed, in one transaction.

The data-access interface, implemented by an adapter (`sqlite.js` today):

```js
await db.query(sql, params)   // → rows (plain objects; [] when none)
await db.get(sql, params)     // → the first row, or undefined
await db.run(sql, params)     // → { changes }
await db.transaction(async (tx) => { … })   // tx: the same interface; committed when fn resolves,
                                            // rolled back when it throws (the error is passed on)
await db.close()              // waits for what is queued, then refuses new calls
```

- **Asynchronous on purpose**, although SQLite is synchronous: a PostgreSQL
  adapter will not be, and callers must not notice the switch.
- **One connection, one queue.** Statements and transactions run one at a
  time in call order: transactions are serialized, and statements issued
  without awaiting are applied in the order they were issued. Inside a
  transaction use `tx` (or the `r` repositories of `repos.transaction`),
  never `db` or `deps.repos`: the transaction holds the only connection, so
  such a call is refused at once with `db.tx_reentry` (the transaction's
  code is tracked with `AsyncLocalStorage`), awaited or not — including an
  `audit.log()` made from inside, which is then lost with an error in the
  log: record it after the transaction. `tx.transaction()` nests as a
  savepoint, rolled back alone when its callback fails.
- **Repositories reject, never throw**: every repository method is `async`,
  so bad input (an invalid time, a value JSON cannot serialise) comes back as
  a rejected promise.
- **The SQLite file**: `DATA_DIR/lab-console.db` (mode 0600, with its `-wal`
  and `-shm` files), WAL journal, foreign keys on, busy timeout 5 s,
  temporary data in memory. `node:sqlite` needs Node 22.13 or later (no flag
  from that version on; `engines` in package.json). Its "experimental"
  warning is kept out of the log; any other warning goes through.
- Errors are `DatabaseError` with a `code`: `db.unique`, `db.foreign_key`,
  `db.constraint`, `db.params`, `db.not_portable`, `db.closed`, `db.migration`,
  `db.tx_reentry`, `db.tx_over`, `db.tx_close`, `db.error`.

**Portability rules.** Every statement and its parameters are checked by the
adapter before they run (`portable.js`), so a SQLite-only construct fails in
the first test that reaches it, not on the day of the move:

- placeholders are a plain `?` (the PostgreSQL adapter numbers them); one per
  parameter, one statement per call;
- ids are text: a UUID (`newId()`, a UUID v7 whose text order is creation
  order) or a natural key. No `INTEGER PRIMARY KEY`, no `AUTOINCREMENT`, no rowid;
- timestamps are ISO-8601 text in UTC, made by the application
  (`toIso(ms | Date)` → `2026-11-13T09:00:00.000Z`, fixed length, so text
  order is time order). Never `CURRENT_TIMESTAMP`, `now()`, `datetime()`;
- booleans are integers 0 / 1 (`toFlag` / `fromFlag`); a JS boolean as a
  parameter is refused. JSON payloads are text (`toJson` / `fromJson`); a
  `Date` or an object as a parameter is refused;
- column types are `TEXT`, `INTEGER`, `BIGINT`, `REAL`;
- no SQLite-only functions or syntax: no `INSERT OR …`, `REPLACE INTO`
  (write `INSERT … ON CONFLICT (key) DO UPDATE SET … = excluded.…` or
  `ON CONFLICT DO NOTHING`), no `PRAGMA`, `GLOB`, `COLLATE`, `IFNULL`,
  `GROUP_CONCAT`, `json_*()`, `strftime()`, multi-argument `min()` / `max()`,
  `LIMIT a, b`, quoted identifiers, `==` (write `=`), `ILIKE`. `RETURNING`
  is fine;
- `LIKE` ignores case for ASCII in SQLite and respects it in PostgreSQL: it
  is only accepted as `lower(x) LIKE lower(?)` (or `NOT LIKE`), which behaves
  the same on both. Use standard
  functions (`coalesce`, `substr`, `lower`, `length`, `count`) or compute in
  JavaScript;
- every index is created explicitly in a migration, named `<table>_<what>`;
  every table has a primary key.

**Migrations.** `src/lib/db/migrations/NNN-name.js` (three digits, then
lowercase words joined by dashes) exports `async up(tx)` running portable
statements with `tx.run()`. At start-up the pending ones run in order, all in
one transaction, each recorded in `schema_migrations (version, name,
applied_at)`: the database reaches the code's version, or nothing changes and
the start stops with `Database migration NNN-name failed: …`. A database that
records a migration the code does not have (a newer version ran on it, or
two branches used one number) also stops the start. A merged migration is
never edited: a change is a new file with the next number; two lots that took
the same number renumber at merge.

**Files of before.** On the first start with the database, `importLegacyFiles()`
reads `data/auth/sessions.json`, `auth/local-admin.json`,
`auth/device-key.json`, `audit/<yyyy-mm>.jsonl`, and the files the wave 2
lots wrote before they had tables (the pre-production stack may hold them):
`settings/<ns>.json`, `auth/oidc.json` (→ row `sso`), `admin/switches.json`
(→ row `switches`), `teams/teams.json`, `benches/occupancy.json`,
`benches/locks.json`, `benches/reservations.json`, `accounts/users.json`,
`accounts/invitations.json`, `admin/announcements.json` and
`diagrams/index.json` (into an empty index only). It writes their records
through the repositories in one transaction per file (also recorded in
`legacy_imports`), then renames each file `<name>.imported`. Nothing is ever
deleted; a file that cannot be read is kept as `<name>.not-imported` with an
error in the log; what the database already holds wins over a file.
`legacy_imports` keeps each file's SHA-256: a file found again under an
imported path with the same content (a crash between the commit and the
rename) is only renamed; with other content (pre-production rolled back to a
build without the database, then upgraded) it is imported again, the records
already in the database skipped (sessions and values by key, audit entries
by time, action, actor and details), with a warning in the log.

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

Entries are rows of `audit_entries` (`repos.audit`), indexed on time, actor,
action and bench. `log()` never throws and never rejects; it returns a
promise of `true` (stored) or `false` (lost, and reported in the server log)
that callers normally ignore. An entry is
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
The consoles module publishes `services.consoles = { registry, rooms,
sharedTargets(), journal }` (§7, §9). The teams lot publishes
`services.teams` and `services.benches` (§7).

Teams and benches are two modules built by one factory
(`createTeamsModules(deps)` in `src/modules/teams/index.js`): `/api/teams`
(create, rename, invite, accept, leave; admins dissolve and remove members)
and `/api/benches` (take, release, join on request, guests, lock, history,
reservations). Their SSE topics: `benches:state` (sticky, everyone: holder,
occupants, lock, automatic release time), `benches:requests:<bench>` (sticky,
the bench's occupants only), `benches:request` (to the person who asked),
`benches:warning` (occupants, at most ten minutes before another team's
slot; `minutes` is what remains),
`benches:slot` (the team whose slot starts), `benches:reservations` (a
calendar changed), `teams:invitation` (the person invited only) and
`teams:changed` (the members, the people invited, admins). In the browser,
the rail section `#/team` (`public/js/modules/teams/`: my team, the
reservation calendar, all teams for admins) and the bench bar
(`teams/benchBar.js`), which the consoles view mounts above the diagram:
`mountBenchBar(viewEl)` → `{ setBench(name), decorate(diagramView),
mayOpen(device, benchNames), refusal(benchNames) }`. `decorate` uses the
diagram's `decorate()` layer when the diagram has one and does nothing
otherwise.

`createApp().close()` calls every module's `shutdown()` (and waits for the
promises they return), `auth.shutdown()`, ends the SSE streams, closes the
HTTP server, waits for `store.flush()`, then closes the database (after the
statements the shutdowns queued).
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
- The SSO page (`sso`) and the admin switches (`switches`) keep their own
  rows in the same table through `repos.settings`; the service never reads
  or writes a namespace it did not register.
- Saved in the database (table `settings`, one row per namespace through
  `repos.settings`: the saved fields by dotted path, who saved them and
  when), loaded once when the service is created (`await createSettings({
  config, repo, audit })`), so `get()` stays synchronous; a namespace
  registered later finds what was saved for it. Secrets are sealed with `src/lib/sealed.js` (AES-256-GCM under a key
  derived from `APP_SECRET`, in clear without it); one that cannot be opened
  any more falls back to the environment and is listed in `unreadable`.
- `update()` audits `settings.update` with `{ ns, changed, reset, values }`:
  field names only for secrets, new values for the others.
- Modules that keep a long-lived connection listen for `'change'`: the
  consoles registry reloads (the allow-list may have moved), the Proxmox
  tunnel reconnects, the health cache is dropped.
- Confirmation is not the service's job: the admin module's `PUT /api/admin/lab`
  requires a ticket (`src/modules/admin/confirm.js`, 2 minutes, one change,
  same user and session). The environment's administrator gets it with its
  password and a fresh TOTP code, a local administrator with a passkey. An
  SSO administrator signs in again at the provider (owner decision, 13 Nov):
  `POST /api/admin/confirm/sso` → a dedicated authorization request with
  `prompt=login` and `max_age=0`; its callback (same person, still an
  administrator, a fresh `auth_time`) marks the session as freshly confirmed
  for 5 minutes (`SSO_FRESH_MS`), during which `POST /api/admin/confirm {}`
  answers with a ticket; `GET /api/admin/confirm` → `{ method, confirmedUntil }`.
  Nothing waits on the server meanwhile; the lab page keeps its non-secret
  draft in `sessionStorage` across the trip. The Proxmox fields stay
  read-only on that page (owner decision: Proxmox is postponed).

**diagrams** (`src/lib/diagrams.js`, passed as `deps.diagrams`, `await
createDiagrams({ config, store, repos })`) — the active lab diagram is
`data/diagrams/current.drawio`, seeded from `DIAGRAM_PATH` on the first start
(which becomes the first version). The versions stay files
(`data/diagrams/versions/<id>.drawio`); their index (name, size, hash, who,
when, the labs) and the stack of activations live in the database
(`diagram_versions`, `diagram_activations`: the last activation is the
active diagram).

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
(`INFRA_CONFIG_PATH`) is the starting point; an edited list lives in the
database (`settings` row `switches`, read once by `await
createInfrastructure({ file, repos, audit })`) and wins.

## 7. Server modules

The upstream contract is unchanged:
`{ id, title, enabled, router?, upgrade?(req, socket, head) → boolean, start?(), shutdown?() }`,
registered with one line in `src/modules/index.js`. `start()` (optional,
may be async) runs once every module is created and before the server
listens: the place to load state from a repository into memory. A module owns its folder,
its `/api/<id>` routes, its `data/<id>/` subtree, its locale namespace and its
front-end section. It checks roles itself with `auth.requireRole` or
`req.user.role`.

Cross-module APIs (published in `services`):

```js
services.consoles = {
  registry,                      // LabRegistry: model, getDevice(key), on('change')
  rooms,                         // RoomManager, see §9
  sharedTargets(),               // Set of 'host:port' used by several labs
  journal,                       // ConsoleJournal: list(), meta(), canRead(), canReadDay(), dayMetas(), usage(), paths() (§9)
  pool(),                        // the shared SSH connections: { connections, channels, channelsPerConnection, lines: [{ key, channels, capacity, state }] }
}
services.teams = {                           // lot teams (src/modules/teams/)
  teamOf(userOrId) → Team | null               // { id, name, members: userId[], people: [{ id, username, name, since }], invitations }
  get(teamId) → Team | null
  list() → Team[]
}
services.benches = {                           // lot teams (src/modules/teams/)
  holder(labName) → { teamId, since } | null   // the team that took the bench
  occupants(labName) → userId[]                // team members + accepted guests
  isOccupant(user, labName) → boolean
  canOperate(user, labName) → boolean          // admin (locks included), or occupant of an unlocked bench
  canPilot(user, device) → boolean             // the rule of SPEC "Lot teams / Permissions": admin switches and
                                               //   admins always; never while any bench of the device (same
                                               //   console line) is locked; else any of them that is free or
                                               //   occupied by the user.
                                               //   The rooms ask it when a line opens and at every keystroke and
                                               //   control action (§9)
  lock(labName) → { reason, by, at } | null
  touch(labName)                               // activity, postpones auto-release; cheap (one write a minute);
                                               //   the consoles module calls it on every console activity
  onRelease(fn) → off()                        // hook: fn({ labName, teamId, by, reason }) after every release
                                               //   (by: Person | 'system'; reason: hand|admin|idle|reservation|dissolved);
                                               //   an object it returns is handed to the browser that released
                                               //   (`offers`), e.g. the jobs lot's backup offer
}
services.accounts = {                          // lot accounts
  get(userId) → Account | null                 // { id, username, name, role, state, via, hasPasskey, … }
  list() → Account[]                           // the environment's administrator first ({ environment: true })
  roleOverride(userId) → 'student' | 'admin' | null   // forced on an SSO account; null = its groups decide
  admit(user, { groupRole }) → Promise<boolean>       // called by the sign-in module at each SSO sign-in
  findByUsername(name) → Account | null        // compared without case; local accounts first, SSO ones once signed in
  findAllByUsername(name) → Account[]          // every account with that name (sign-up refuses a name any account
                                               //   holds, but SSO names come from the provider): a team invitation
                                               //   binds the one account, teams.unknown_user / teams.ambiguous_user otherwise
  confirmation: {                              // a local administrator proves itself again with a passkey
    available(user) → boolean
    options(req, res) → PublicKeyCredentialRequestOptionsJSON   // challenge bound to browser, account and session
    verify(req, res, response) → Promise<boolean>
  }
}
services.admin = { announcement() → { text, level, at, expiresAt, by } | null }   // lot admin
services.jobs = {                              // lot jobs (§9b)
  running(labName) → { id, kind, bench, state, startsAt, actor: { name }, devices: [{ key, name, state, step }] } | null
  list({ bench }) → Job[]                      // recent jobs kept in memory, newest first
}
services.scripts = { list(user), get(user, id) }   // lot terminal: the library as that person may see it, the rules of the API
services.collab = {                            // lot collab
  notes() → Promise<Note[]>                    // every note of a device still in the diagram
  noteOf(deviceKey) → Promise<Note | null>     // { key, bench, device, text, rev, updatedAt, by: { id, name } }
}
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
  **Sauvegardes** (`#/jobs/<bench>[/<action>]`, `modules/jobs/`, every
  signed-in user; `#/jobs/B4M/backup` opens the backup dialog, which is where
  the release offer of the bench bar leads) holds the bench jobs, the
  snapshots and the templates (§9b). `main.js` also starts, for every
  section, the diagram layer of the jobs (`modules/jobs/layer.js`) and the
  group work (`modules/collab/index.js`: the notes layer, and the
  notification bell `#notify-toggle`, placed in the rail before the theme
  button, outside `#rail-items`). The consoles view mounts the collab
  bench panel (notes and chat) beside the diagram, one side panel at a time
  with the live panel, and a script library button in its header.
- **Live events.** `live.on(topic, fn)` (`core/api.js`) shares one
  `EventSource`. A named event without a listener is lost, and sticky topics
  are only replayed when a stream opens: when a section subscribes to a new
  topic after the stream is open (the announcement banner opens it at
  start-up), the stream is opened again once for the topics added in that
  turn, and every sticky topic is replayed.
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
  `ring` is a class name (`.deco-ring.ring-<ring>`; the last layer's wins),
  `badges` is `[{ text, color?, title?, kind? }]` (at most four drawn, then
  "+n"), `tooltip` is extra lines of the device's tooltip; `decorate(layer,
  null)` removes a layer. Call `refresh()` when the data behind a layer
  changes. A later lot does not hold the view: it calls
  `registerDiagramLayer(layer, fn)` → `unregister()` and `refreshDiagram()`
  from `shared/diagramLayers.js`; every diagram view on the page, drawn
  before or after, uses those layers after its own (presence).
  `destroy()` stops a thrown-away view listening to that registry and to
  the language; the consoles section's `destroy()` calls it.
  Device states (`setStates`): `idle`, `open` (in my workspace), `live` (open
  in the application by someone else: a click joins), `busy` (refused by the
  console server lately: busy outside the application), `disabled`.
- **Pane actions** (owned by the rooms lot, `shared/paneActions.js`):
  `registerPaneAction({ id, icon, title, when(session), enabled?(pane), run(pane), order? })`
  adds a button to console tiles → `unregister()`. `title` is a dictionary
  key or a function; `enabled(pane)` is asked again whenever the tile's state,
  the keyboard or a task changes (`pane.mayType`, `pane.canAutomate`,
  `pane.isPilot`, `pane.presenceBar.presence`). Break, export, inject, send to
  several consoles, history (lot terminal) and the device note (lot collab)
  are registered this way (order 10, 20, 30, 40, 50, 60). `pane.onAutomation(fn)` follows the server's `automation` frames of
  that console; `pane.sendBroadcast({ batch, script, options })` sends a
  broadcast frame on its socket. A session descriptor of a lab console carries
  `device` (the device key).

## 9. Consoles and rooms

One **room** per console line. The room owns the SSH → telnet session; browsers
attach to it. `RoomManager` (`services.consoles.rooms`, `src/modules/consoles/roomManager.js`):

```js
rooms.get(targetKey) → ConsoleRoom | undefined
rooms.list() → RoomSummary[]
rooms.canOpen(device, user, { readOnly }) → { ok } | { ok: false, code, params, message }
rooms.open(device, user, { cols, rows, readOnly, task }) → ConsoleRoom    // creates or returns; throws RoomError { code, params };
                                        //   `task`: a bench job's line, not counted in the user's MAX_SESSIONS_PER_CLIENT
rooms.busyOutside() → ['host:port']     // lines the console server refused in the last 15 min
rooms.on('change', (summaries) => {}) · rooms.on('activity', (entry) => {}) · rooms.on('busy', (targets) => {})

room.attach(client) → detach()          // client: { user, send(msg), sendBytes(buf), close(), readOnly? }
room.write(user, data) → boolean        // ignored (false) unless the user may type: the pilot, or anyone
                                        //   who may pilot when the keyboard is shared; nobody while a task runs
room.requestControl(user) / room.grantControl(to, by) / room.denyControl(to, by) / room.releaseControl(user)
room.takeControl(admin) / room.setShared(user, on) / room.hangUp(user)   // → { ok } | { ok: false, code, params }
room.runExclusive(actor, label, async (cli) => { ... }, { signal, privateOutput })   // actor: User | 'system'
room.cancelTask(user | 'system')
room.cli                                // CliAutomation bound to this line
room.summary()                          // { target, key, bench, device, state, users, pilot, shared, task,
                                        //   since, lastActivity, lastCommand }
room.screen(maxBytes = 4096)            // the end of the scrollback as text (no escapes, no CR): what a job's
                                        //   driver reads before typing (ios.prepare({ screen }))
room.presence(user)                     // the presence frame for that user
```

Who may pilot is `services.benches.canPilot(user, device)` when the teams lot
provides it, every signed-in user otherwise (one call site, `mayPilot` in
`src/modules/consoles/index.js`, read lazily). It is asked when a line opens,
at every control action and at every keystroke: a pilot whose bench gets
locked, or taken by another team, keeps watching but no longer types,
shares, grants, frees the line or stops its task, and counts as no pilot:
the next request or task gets the keyboard at once instead of asking them. Anyone signed in may watch an open line
(the browser lets anyone open a tile on a line already open, and asks the
bench bar only before opening a new one); opening a new line needs the right
to pilot it (`consoles.open_not_allowed`). Every console activity entry
(open, join, control, command…) calls `services.benches.touch(bench)`.
Limits are per user: `MAX_SESSIONS` lines on the platform (joining is free),
`MAX_SESSIONS_PER_CLIENT` consoles per user (a read-only wall tile does not
count), 20 openings a minute per user.

Handover rule (people and tasks alike): no pilot or a pilot idle for 2 min →
at once; otherwise the pilot is asked and control passes after 30 s without
an answer; an admin takes it at once. One pending request at a time
(`consoles.control_pending`); a task's request replaces a person's.

`runExclusive` refuses at once when the room is closed (`consoles.room_closed`),
a task already holds it (`consoles.task_running`) or the actor may not pilot
(`consoles.control_not_allowed`: spectators). A person's right to pilot is
asked again once the keyboard is obtained (a task handed the keyboard after
its actor lost the right is rejected), once the line is ready, and before
every byte the task sends (`cli.perform(label, fn, { allowed })`): a lock,
another team taking the bench or a disabled account stops it with
`consoles.control_not_allowed` and nothing more is sent. It rejects with
`code: 'consoles.control_refused'` when the pilot refuses (the contract said
`console.control.refused`: codes of this module start with `consoles.`). Then
it waits for the line to be ready (console server login done), locks every
keyboard and runs `fn` inside `cli.perform()`. `signal` or `cancelTask()`
(actor, pilot while still allowed to drive, admin, or 'system') stops it
while it waits for the pilot, for the line, or while it runs
(`err.cancelled`). Afterwards a person keeps the keyboard; a 'system' task
gives it back to the previous pilot. With `privateOutput: (user) => boolean`
(bench jobs pass "may see the job in full": its team, admins), what the
device prints while the task runs goes only to the attached people it
accepts and stays out of the scrollback (replay, history) and the journal,
which gets a marker line instead; `screen()` still sees it.

The line stays open while someone is attached, 30 s after the last one
leaves (or after the last task, for a line a job opened that nobody
watches), 60 min without input (`IDLE_TIMEOUT_MINUTES`); "free the line"
(`hangUp`: the pilot, an admin, or anyone who may pilot an unowned line;
while a task holds the line, only the people `cancelTask` accepts: its actor,
the pilot, an admin, others get `consoles.task_running`). A line that closes
under a task (dropped, freed, timed out) rejects it with
`consoles.room_closed`, never with a user's `automation.stopped`.
Lab parameters (`settings.get('lab')`: jump server, console login, allowed
hosts) are read when a line opens. Lines share SSH connections
(`src/lib/sshPool.js`: `SSH_CHANNELS_PER_CONNECTION`, 8 by default, under
sshd's MaxSessions; a refused channel moves to another connection).

What can go wrong, as codes: `consoles.ssh_*` (jump server), 
`consoles.line_refused` (the console server refused the line: busy outside
the application or dead), `consoles.console_server_unreachable`, and the
status phase `silent` with `consoles.device_silent` (accepted, but nothing
visible within 6 s of an Enter; the line stays open).

WebSocket `/ws/console?device=<key>&cols&rows[&mode=wall]` keeps the upstream
frames and adds, server → client: `{type:'replay', bytes}` followed by the
buffered bytes (about 200 KB), `{type:'presence', users, pilot, you,
canPilot, mayType, shared, task, pending, state}`, `{type:'control', event,
by, to, until?, label?}` (events: request, granted, denied, released,
timeout, idle, takeover, left, shared, unshared, cancelled, superseded, task,
returned, free), `{type:'control-refused', action, code, params}`, status
phase `silent`; client → server: `{type:'control',
action:'request'|'grant'|'deny'|'release'|'take'|'share'|'unshare'|'hangup', to?}`.
`mode=wall` joins an open line read-only (no keyboard, no automation, not
counted in the per-user limit): the server drops its input, break and resize
frames and refuses its control frames (`consoles.wall_read_only`), and a
person attached only through wall tiles can be neither pilot nor typist on a
shared keyboard. Automation (`export-config`, `inject`, `paste`, `broadcast`)
goes through `runExclusive`; its progress is sent to everyone on the line, the
exported file and the refusals only to the person who asked.
`{type:'paste', script, options}` is a multi-line paste: the browser hands the
text over instead of typing it key by key, and the room sends it line by line
like an injection (comments and blank lines included, since it is what was
copied); it needs the keyboard (`consoles.paste_not_allowed` otherwise, for a
spectator too). A paste and a broadcast always wait for each prompt, 50 ms
between lines: the `waitForPrompt` and `delayMs` of their options are ignored
(they belong to the injection dialog, which neither shows), only `stopOnError`
is read. A paste of a single line stays a keystroke frame (`{type:'input'}`):
`room.write` cuts any input longer than 32 characters into chunks sent 40 ms
apart (the typing pace of an injection), in order, and drops what is left if
the person may not type any more (a task starts, the keyboard moves, a break). `{type:'broadcast', batch, script, options}` is the same
lines for several consoles: the browser sends it on the socket of each
console the person ticked, and each room decides for itself; it needs to be
the pilot of that very console (`consoles.broadcast_not_pilot`: typing on a
shared keyboard is not enough), at most 50 lines, and every `automation`
frame it provokes carries the `batch` tag so that the browser tells its own
request from another person's. The socket accepts frames up to 256 KB plus
their envelope (the automation's own limit).

SSE topics: `consoles:rooms` (sticky, all room summaries), `consoles:activity`
(`{ ts, kind: open|join|leave|control|task|freed|close|command, user, bench,
device, target, event?, label?, state?, command? }`), `consoles:busy`
(sticky, `busyOutside()`), `consoles:free` (to one user: "tell me when it is
free" answered, `state: free|open|expired`).

HTTP (`/api/consoles`): `GET /rooms` → `{ rooms, busy }`; `GET /activity` →
the last 100 entries; `POST /notify { device }` → `{ target, until }` (probe
every 30 s for 30 min, `nc -z` through the jump server; at most 10 per user),
`GET /notify`, `DELETE /notify/:target`; `GET /journal` → `{ sessions,
retentionDays }`, the console sessions this user may read (`{ id, bench,
device, day, from, to, bytes, truncated, people, pilots }`): every session of
each console day they may read; `GET /journal/:bench/:device/:day/:session` →
one session as a text file.

History of a console (`src/modules/consoles/history.js`, 30 requests a minute
per user): `GET /history?device=<key>[&q=<text>][&case=1]` → `{ device, live:
{ open, attached, lines, matches?, total?, truncated? }, journal: { exists,
allowed, days, matches?, total?, truncated?, searched? } }`. `live` is the
room's recent output (what a newcomer is replayed), searched by the people
attached to it only; `journal` is searched for the days the journal's rule
lets this person read (`canReadDay`), and says `allowed: false` otherwise.
A search is plain text (no pattern, no case unless asked), over what the
screen showed (`src/lib/terminalText.js` replays the stream: escape codes
dropped, a carriage return rewrites the line). The replay is synchronous, so a
journal is read at most 16 MB per search and replayed 1 MB at a time with the
event loop given back between two pieces. `GET /history/download?device=<key>`
is the room's output as a text file (people attached only,
`console.history.download` audited), `&day=<yyyy-mm-dd>` a whole day of that
console's journal as one text file (`console.journal.download`).

**Script library** (`src/modules/scripts/`, table `scripts`; `GET/POST
/api/scripts`, `GET/PATCH/DELETE /api/scripts/:id`): three shelves. A
*personal* script is seen by its owner alone (administrators too: it may hold
a password); a *team* script by the members of that team, who all change it
(an administrator sees and tidies every team's, a dissolved team's included);
a *published* script by everybody, changed by administrators only. A script
that is not visible answers `scripts.unknown`, like one that does not exist.
A title is unique on its shelf (`scripts.duplicate_title`), a shelf is capped
(`scripts.shelf_full`), a text is at most 64 KB without control characters, and
a PATCH naming `updatedAt` is refused (`scripts.conflict`) when someone saved
meanwhile. The listing carries no text. Changes are audited (`script.create`,
`script.update`, `script.delete`: title and shelf, never the text). The inject
dialog and the "send to several consoles" dialog pick from it
(`shared/scriptLibrary.js`).

**Console journal** (`src/modules/consoles/journal.js`): the device output
per console **session** (one line opened, used, closed; a new file after
midnight), with marker lines (who took the keyboard, tasks, the end), never
keystrokes; a sidecar `<session>.json` lists who attached, who held the
keyboard, who watched without the right to drive (`watched`: shown, gives no
right) and the teams that held the bench during the session
(`services.benches.holder`, noted at the start, at each attach or handover
and with each marker), which is what `canRead(user, meta)` checks (the
people who attached as someone who may drive or held the keyboard, those
teams through `services.teams.teamOf`, admins). **Read rights
cover the whole day of a console** (owner decision, 13 Nov):
`canReadDay(user, dayMetas(b, d, day))` is true when any session of that
console's day names the user or their team, and then every session of that
day is readable. Someone allowed to drive R1 who was on it for a minute in
the afternoon reads the morning's sessions of another team on R1, never
another day nor another console; a spectator who may not drive reads none. The journaling page (Lab status) says so.
The days that exist per console are listed in the database (`journal_days`,
`repos.journalDays`: safe names, real names, size, first and last write);
the journal page, the retention sweep and the global cap read that table,
and `reconcile()` (at start-up) adds the days found on disk that it does not
list. Capped per device and day, all sessions together
(`JOURNAL_MAX_KB_PER_DAY`), swept daily (`JOURNAL_RETENTION_DAYS`), and every
journal together is capped at `JOURNAL_MAX_TOTAL_MB` (1024 by default):
`enforceCap()`, hourly and at start-up, deletes the oldest days first, never
the current day. `usage()` → `{ bytes, days, maxBytes }` is what the health
page shows. Downloads are audited (`console.journal.download`).

### Group work (lot: collab)

`src/modules/collab/` (`/api/collab`, repository `repos.collab`, migration 014).

**Device notes.** One shared note per device of the diagram, keyed by the
device's key (`<page>:<cell>`), read by every signed-in user, written by the
occupants of the device's bench (`services.benches.isOccupant`, guests
included) and by admins; plain text, 2000 characters, an empty text deletes
it. `GET /api/collab/notes` → `{ notes, limits }`; `PUT /api/collab/notes/:key`
`{ text, rev }`, where `rev` is the revision the editor opened (0: no note):
another revision is a 409 `collab.note_conflict` (`params.rev` is the current
one) and nothing is written. 20 saves a minute per person
(`collab.rate_limited`). Admin switches carry no note. SSE `collab:note`, to
every signed-in tab: the note as listed, or `{ key, bench, rev: 0, removed:
true }`. Audited as `collab.note.set` / `collab.note.clear` (bench, device,
length; never the text). In the browser the diagram shows a badge and the
first lines in the device's tooltip through `registerDiagramLayer('notes')`,
console tiles get a "Note" pane action, and the group panel lists them.

**Bench chat.** A text chat for the people working on a bench, kept **with
the team that holds it** (SPEC "Lot teams"): the thread is the one of (holder
team, bench), shared by the team's members and the bench's guests. Released
and taken again by the same team, the conversation is still there; another
team starts its own; a team that is dissolved loses its threads (a sweep at
start-up and daily, done in the repository against the `teams` table, so it
does not depend on the start order of the modules or on what is loaded).
Occupants read and write; admins read and may take a message down, also while
no team holds the bench (by bench and id; the thread itself is only readable
through the current holder); nobody else sees anything
(`collab.chat_forbidden`). The chat button's unread count is per bench: it
counts the messages of the bench on screen, and a message taken down leaves it.
`GET /api/collab/chat/:bench` → `{ bench, messages, canPost, limits }` (the
last 200, oldest first); `POST` `{ text }`; `DELETE /:bench/:id` (admin). Text
only, 500 characters and 6 lines, no control or direction-changing
characters; 10 messages per 20 s per person; at most 200 messages are kept per
thread. SSE `collab:chat`: `{ bench, message }` or `{ bench, removed: id }`,
sent to the bench's occupants and the admins, the audience being the
occupancy at the moment of the post. Removals are audited
(`collab.chat.delete`); messages are not.

**Notifications** are browser work, from events the page already receives:

| what | event | when it is shown |
|---|---|---|
| someone asks for the keyboard of a line I pilot | `consoles:activity` (`kind: control`, `event: request`) with the pilot of `consoles:rooms` | I am the pilot, not the requester |
| a line I waited for is free, or opened in the app so I can join it | `consoles:free` (`state: free` or `open`; `expired` is not notified) | always for me: it is sent to me alone |
| a job of my bench is over | `jobs:done` `{ bench, jobId, kind, ok, state }` | `bench` is one I am an occupant of (`benches:state`) |

`jobs:done` is published by the jobs module (`runner.js`, at the end of
every job), once per finished job (any `kind`: `backup`, `inject`, `reset`,
`compare`; `ok` is true for `state: 'done'` only, so a `partial`, `failed`
or `cancelled` job is not ok), through `events.publish('jobs:done', payload,
{ audience })` with the bench's occupants **at the end of the job** as
audience (nobody when no team holds the bench: an admin's job on a free bench,
the backup a release offers); the browser checks the bench again. A
cancelled job says "cancelled", not "failed"; clicking the notification
opens the bench's jobs (`#/jobs/<bench>`), where the report is. No
server-side subscription exists or is needed: SSE is the contract. A notification is a
system notification, only when the window is hidden or not focused (the page
says it itself otherwise), only when the person turned them on with the bell
in the rail (which also asks the browser's permission, after a click); the
choice stays in the browser (`labconsole.notifications`). A tag per source
keeps several tabs from showing it twice.

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
cli.sendBreak()                                 // a serial BREAK (telnet "send brk"), under the task's right to type;
                                                //   automation.no_break on a line that has none
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

## 9b. Bench jobs (lot: jobs)

`src/modules/jobs/`: `index.js` (routes, permissions, `services.jobs`, the
release offer), `runner.js` (the jobs themselves), `library.js` (snapshots
and templates: who sees what, import, diff, search), `configFiles.js` (the
files, their SHA-256, ZIP in and out). Contract of SPEC "Lot jobs".

**A job** covers chosen devices of one bench: `backup`, `reset`, `inject`,
`compare` (a snapshot against the live devices). One job per bench at a time
(`jobs.bench_busy`), five devices at once (`JOB_DEVICES_AT_ONCE`). For each
device: `rooms.open(device, actor, { task: true })`, then
`room.runExclusive(actor, 'job:<kind>', fn, { signal })` with the person who
started it as actor (the pilot is asked; the bench rule is asked again before
every byte: a lock or another team taking the bench stops the device with
`consoles.control_not_allowed`, and devices not started yet with
`jobs.not_allowed`), then the IOS driver on `room.cli`. A reset waits
`JOB_COUNTDOWN_SECONDS` (10) in state `pending` before anything starts.

Order enforced in `runner.js`, never in the browser: `prepare` (with
`room.screen()`), `identify` (not Cisco IOS / IOS XE → `skipped`, `ios.not_ios`,
nothing more typed), backup (`runningConfig`, and `vlans` with VTP on a
switch; for a reset or an injection also `show startup-config`, kept as
`<device>.startup.cfg` whenever it is not the running-config, as on a router
at register 0x2141 that ignores it: an erase destroys it, so a startup-config
that cannot be read fails the backup, `jobs.startup_unread`) written to the
job's snapshot and indexed, the files read back and checked against their
SHA-256 and what was read (`verifyBackup`), and only then
`eraseAndReload({ backup: { kind: 'snapshot', … }, verifyBackup, facts })`.
A failed backup leaves the device untouched (`jobs.backup_failed`, `params.cause`)
unless an admin listed it in `forceErase` (then an `override` proof naming
them, and the warning `erased_without_backup`). After a reset the base
configuration (a template marked `base`) is sent and saved unless
`applyBase: false`; a template gone or damaged since the job started is
skipped with the warning `base_missing` / `base_damaged`, and a base the
device refused lines of is not saved (`base_not_saved`). An injection backs
up first; in mode `reset` (the default) it erases as above, then sends the
script with `sendScript` (`skipComments: false`, `lineTimeouts`), reads the
device again and compares (`comparableConfig` + VLANs) with the source, and
only then `copy running-config startup-config` (unless `save: false`): never
when the device refused a line (the device fails with `jobs.script_errors`,
`saved: false`, its report kept) nor, in mode `reset`, when it does not read
back as the source (`jobs.check_differs`). The person reads the report and
saves by hand.

**Exact scripts.** `POST /benches/:bench/preview` returns, per device, the
script `planScript()` (= `toReplayScript` on the stored source) produces and
its SHA-256; `POST /benches/:bench/inject` must carry these fingerprints
(`scripts: { key: sha256 }`), recomputes them and refuses any difference
(`jobs.preview_stale`). The report gives the fingerprint of what was sent.

**Passwords.** `enablePasswords` / `linePasswords` (three each at most) come
with the request, live in the job's memory while it runs and are dropped at
its end; they are never in the `jobs` row, the audit trail, an SSE event or
a report (the driver masks them in its failures). A test greps the data
directory for one.

**Who.** Running a job: `services.benches.canOperate(user, bench)`, refused
with `jobs.locked` (423, the reason) or `jobs.not_occupant` (403). After a
release (`services.benches.onRelease`), the team that let the bench go may
still run a **backup** of it for 30 minutes while it stays free (or theirs)
and unlocked: the hook answers `{ kind: 'backup', bench, href:
'#/jobs/<bench>/backup' }`, the bench bar offers it. Seeing a job is decided by
what was true when it ran, never by who holds the bench now: the members of
the team that held it (`job.teamId`) and admins read the whole report; its
actor otherwise, and the bench's occupants while it runs (and in its own
`jobs:job` publications, the last one included), get `redactedJob()`: the
same report without a configuration line (no `check.patch`, `check.missing`,
`errors[].command`, `lastOutput`; `redacted: true`). Nobody else sees it
(`jobs.job_forbidden`). Cancelling: its actor, the occupants, admins
(`jobs.cancel_forbidden` for anyone else who sees it).
Shared devices (one console line on several benches) are only touched when
listed explicitly (the dialogs leave them unticked); a reset or an injection
of one is refused unless every other bench using the line is free and
unlocked or held by the actor's team (409 `jobs.shared_in_use`, `params.device`,
`params.bench`; admins are not refused), and asked again before the device
starts (`jobs.not_allowed`). Admin switches are never devices of a job.

**Snapshots** are owned by the team that held the bench at the time
(`holder().teamId`; none for an admin on a free bench: admins only) and seen
by its members and admins, never by guests or other teams (403
`jobs.snapshot_forbidden`). Files in `data/snapshots/<bench>/<id>/`
(`manifest.json`, `<device>.cfg`, `<device>.vlan.txt`,
`<device>.startup.cfg`), index in the tables `snapshots` and
`snapshot_devices` (migration 012: path, SHA-256, size, hostname, model,
version, family, kind, register; the startup-config's file and SHA-256). VLANs and VTP (whose
password is a secret of the backup) live in the manifest, not in the
database. Nothing is deleted automatically. **Templates** (`templates`,
`template_devices`, `data/templates/<id>/`): admins publish them (typed, from
a snapshot, or a ZIP), everyone reads and injects them; device `*` (file
`_any.cfg`) applies to every device; at most one is the base configuration.

**ZIP import** (`POST /snapshots/import?bench=`, `POST /templates/import`):
the body is capped (`JOB_IMPORT_MAX_KB`, 413 `server.too_large`); refused
without inflating anything when an entry name leaves the folder
(`jobs.zip_unsafe`), when there are more than 200 entries or a declared size
over 512 KB per file / 8 × the upload in all (`jobs.zip_too_large`: fflate
never writes past a declared size, so a lying header gives a truncated, then
refused, file); a file that is not text or not a configuration is ignored;
only names of the bench's devices are kept (`jobs.zip_empty` otherwise).

HTTP (`/api/jobs`): `GET /benches/:bench` (devices with `shared`, people on
their console, the running job, `canOperate`, `lock`, `offer`, `base`,
`countdownSeconds`); `POST /benches/:bench/backup | reset | preview | inject |
compare`; `GET /benches/:bench/folder?snapshot=` (the TP folder: the
snapshot's configurations and the console journals of its day the user may
read, `canReadDay`); `GET /runs?bench=`, `GET /runs/:id`, `POST
/runs/:id/cancel`; `GET /snapshots?bench=`, `GET /snapshots/search?q=` (plain
text, 2 to 100 characters, 200 hits), `GET /snapshots/:id`, `GET
/snapshots/:id/devices/:device`, `GET /snapshots/:id/zip`, `GET
/snapshots/:a/diff/:b[?device=]`, `POST /snapshots/import`, `DELETE
/snapshots/:id`; `GET /templates`, `GET /templates/:id`, `GET
/templates/:id/devices/:device`, `POST /templates`, `POST /templates/import`,
`PUT /templates/:id` (`name`, `description`, `base`), `DELETE /templates/:id`.
SSE: `jobs:running` (sticky, everyone: per bench, the job and each device's
state and step: the diagram layer `jobs` draws it), `jobs:job` (the whole
job, audience above), `jobs:done` (once per finished job, to the bench's
occupants of that moment: `{ bench, jobId, kind, ok, state }`, what the
collab notifications read, §9 "Group work"). Audit: `job.<kind>` (start, `details.device` = the
device names), `job.<kind>.cancel`, `job.<kind>.end` (each device's state,
code, stage), `job.snapshot.import | download | delete`,
`job.folder.download`, `job.template.publish | update | delete`. A job left
running by a stopped server is closed as failed at start-up
(`jobs.interrupted`).

Configuration (`src/modules/jobs/config.js`): `JOB_DEVICES_AT_ONCE` (5),
`JOB_COUNTDOWN_SECONDS` (10), `JOB_IMPORT_MAX_KB` (2048), `JOB_TIME_SCALE` (1:
the driver's budgets multiplied by it; only the simulator boots fast enough
to lower it). The mock lab's model `aruba` (`dev/fakeOther.js`) is a switch
that does not run Cisco IOS.

## 9c. Password recovery (lot: recovery)

`src/lib/drivers/ciscoRecovery.js` (the procedures), `src/modules/recovery/`
(`index.js`: routes, permissions; `assistant.js`: `RecoveryRunner`), repository
`repos.recoveries` (migration 015), front end `public/js/modules/recovery/`
(a `recovery` pane action on lab console tiles, order 70, and a diagram layer
`recovery`). Contract of SPEC "Lot recovery".

**Families** (`FAMILIES`): `isr_g1` (1841, 2801, 2811) and `isr4300` (ISR 4331)
by `confreg`; `catalyst` (2960, 3560, 3560V2) and `c1000` by `config_text`;
`c9300l` by `ignore_startup`. Steps (`STEPS`): `look` first, always (what the
console shows decides where to begin, `planFrom()`: a router already in
ROMMON, a switch at `switch:`, a router at the initial dialog skip what is
done), then

    confreg         power_cycle, confreg (0x2142), boot, restore_register (0x2102, checked)
    config_text     power_cycle (Mode held), flash_init, park_config (config.text →
                    config.text.recovery, never over an existing file), boot, restore_config
    ignore_startup  power_cycle (Mode held), ignore_startup (SWITCH_IGNORE_STARTUP_CFG=1),
                    boot, restore_startup (no system ignore startupconfig switch all)

The driver never erases flash or the startup-config: it only makes the next
boot ignore it, then makes the boot after that read it again. Every screen is
recognised by its text; anything else is `recovery.unexpected_screen` /
`recovery.unknown_question` and nothing more is typed. A step result is
`{ ok, … }` or `{ ok: false, reason: 'recovery.<code>', params, retry?,
lastOutput? }`; `retry` (BREAK too late, Mode released too early, nobody
power-cycled) puts the same step back to the person.

**A recovery** holds the device's room with `room.runExclusive(actor,
'recovery', fn, { signal })` from `look` to the end. Before each step after
`look` it waits (state `awaiting`, `awaiting: <step>`) for `POST
/runs/:id/confirm { step }` by the person who started it, then asks again
whether that person may still operate the bench (`recovery.not_allowed`).
Nobody confirming for `confirmMs` (30 min) ends it (`recovery.abandoned`).
One recovery per device; none while a job runs on the bench. Who starts one:
`benches.canOperate` (occupants of an unlocked bench, admins), never on an
admin switch, a shared console line only while the other benches are free or
held by the same team. Who follows one: its actor, the occupants, the team
that held the bench, admins. Budgets: `RECOVERY_TIMEOUTS`, multiplied by
`JOB_TIME_SCALE`.

HTTP (`/api/recovery`): `GET /families`, `GET /devices/:key` (`canStart`,
`refusal`, the recovery under way, the last five), `POST /devices/:key/start
{ family }` → 202, `GET /runs?bench=`, `GET /runs/:id`, `POST
/runs/:id/confirm`, `POST /runs/:id/cancel`. SSE: `recovery:run` (the
recovery, to those who follow it), `recovery:running` (sticky, everyone: the
devices being recovered, by whom, at which step). Audit: `recovery.start`,
`recovery.confirm`, `recovery.step`, `recovery.cancel`, `recovery.end`. A
recovery left open by a stopped server is closed as failed at start-up
(`recovery.interrupted`).

Simulator (`dev/fakeIos.js`): `powerCycle({ modeButton })`, BREAK into
ROMMON only while booting, `confreg`, `reset`, the classic switches' boot
loader (`flash_init`, `dir flash:`, `rename`, `boot`, the password-recovery
disabled question), the 9300L's `SWITCH_IGNORE_STARTUP_CFG`; the mock lab's
`mock-power <host> <port> [mode]` command stands in for the person on site.

## 10. Data directory

```
data/
  lab-console.db (600)      + lab-console.db-wal, lab-console.db-shm: the structured state (§6, "database")
  diagrams/current.drawio   diagrams/versions/<ts>-<user>-<rand>.drawio
  journal/<bench>/<device>/<yyyy-mm-dd>/<hhmmss>.log   …/<hhmmss>.json (one console session, who was there)
  snapshots/<bench>/<id>/{manifest.json,<device>.cfg,<device>.vlan.txt,<device>.startup.cfg}   <id> = yyyymmdd-hhmmss-<origin>-<6 hex>
  templates/<id>/...        same layout as a snapshot; _any.cfg is the '*' device
  <dir>/<name>.json.imported   audit/*.jsonl.imported   files of before the database, kept after their import
```

In the database today (migrations 001-015): `schema_migrations`,
`legacy_imports`, `auth_sessions`, `auth_state` (the local administrator's
last TOTP step, the known-browser key), `audit_entries`, `settings` (the
run-time settings per namespace, the SSO page's provider as `sso`, the edited
admin switches as `switches`), `teams`, `team_members`, `team_invitations`
(006; `invitee_id`, the account invited, 011), `bench_occupancy`, `bench_locks`, `bench_reservations` (007),
`accounts`, `account_passkeys`, `account_links` (008), `announcements`,
`diagram_versions`, `diagram_activations` (009), `journal_days` (010),
`jobs`, `snapshots`, `snapshot_devices`, `templates`, `template_devices` (012),
`scripts` (013: the script library, one row per script with its text; `shelf`
is `p:<user id>`, `t:<team id>` or `pub`, a title is unique on its shelf),
`device_notes`, `bench_chat_messages` (014), `recoveries` (015: one row per
password recovery, its steps as JSON).
Passkey ceremonies' challenges are not stored: they live in memory, five
minutes, single use.

The bench chat is in the database too, not in a `chat/<bench>.jsonl` log,
because it is bounded and belongs to a team (§9, "Group work").

What stays a file is a document people download or diff: configuration
backups (snapshots, templates), console journals, diagram versions. The
database indexes them (which snapshot, whose diagram version, when) and
never holds their content.

The image runs read-only; `DATA_DIR` is the only writable path. Bench and
device names used in paths go through `store.resolve`, never string concat.
Back up the database with the rest of `DATA_DIR`, service stopped, or with
`sqlite3 lab-console.db ".backup copy.db"` while it runs: copying the `.db`
file alone while it runs may miss what is still in the `-wal` file.

## 11. Testing

- State in tests: `test/helpers/db.js` `memoryDatabase()` → `{ db, repos,
  close }`, a migrated in-memory database per test (`t.after(close)`), never
  a shared one. `startTestApp()` uses a real file in its temporary data
  directory.
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
  failed half-way, or on SIGINT / SIGTERM (`teardown.e2e.js` checks it, on
  the processes of its own run only: the Chromium processes descended from
  the scenario it starts or carrying its marker argument, and the profiles
  they name, so that another suite's browser on the machine does not make it
  fail). A
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
  returns `{ port, close(), device(target), stats(), setBusy(port, on),
  setDown(port, on) }` (`device('10.22.9.4:2001')` is the simulated device
  behind that console port; like sshd, the jump server refuses a session
  channel past `maxSessions`, 10 by default, and `stats()` counts connections
  and channels); `startMockOidc({ port: 0,
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
  the SSO client secret (`settings` row `sso`) and the lab parameters'
  secrets (jump server password, key and passphrase, console server password,
  `settings` row `lab`). The database file is mode 600 and the secrets are
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

   // Structured state goes through a repository: see "Store structured state" below
   export function createBenchesModule({ config, logger, events, repos, audit, auth, services }) {
     const log = logger.child('benches');
     const occupancy = new Map(); // bench → user ids: loaded in start(), written through repos.benches
     const snapshot = () => Object.fromEntries(occupancy);
     const router = express.Router();
     const json = express.json({ limit: '4kb' });

     router.get('/', (_req, res) => res.json({ benches: snapshot() }));
     router.post('/:bench/take', json, async (req, res) => {
       const bench = services.consoles.registry.model.labs.find((l) => l.name === req.params.bench); // read lazily
       if (!bench) throw httpError(404, 'benches.unknown', 'Unknown bench', { bench: req.params.bench });
       await repos.benches.setOccupants(bench.name, [req.user.id]);
       occupancy.set(bench.name, [req.user.id]);
       audit.log(req, 'bench.take', { bench: bench.name });
       events.publish('benches:occupancy', snapshot(), { sticky: true });
       res.json({ ok: true });
     });
     router.delete('/:bench', auth.requireRole('admin'), async (req, res) => { /* … */ res.json({ ok: true }); });

     services.benches = { occupants: (name) => occupancy.get(name) ?? [] };
     return {
       id: 'benches', title: 'Benches', enabled: true, router,
       async start() { for (const { bench, userIds } of await repos.benches.all()) occupancy.set(bench, userIds); },
       shutdown() {},
     };
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

### Store structured state (a table and its repository)

Records that modules create, change and query (accounts, teams, occupancy,
reservations, invitations, room metadata…) go into the database. A document
people download or diff (a configuration backup, a journal, a diagram
version) stays a file written with `store`; its index row (who, when, which
bench, the file's path relative to `DATA_DIR`) goes into the database.

1. `src/lib/db/migrations/006-benches.js` (the next free number; never edit a
   merged migration):

   ```js
   export async function up(tx) {
     await tx.run(`CREATE TABLE bench_occupancy (
       bench TEXT PRIMARY KEY,
       user_ids TEXT NOT NULL,          -- JSON array
       since TEXT NOT NULL,             -- ISO-8601 UTC
       locked INTEGER NOT NULL          -- 0 / 1
     )`);
     await tx.run('CREATE INDEX bench_occupancy_since ON bench_occupancy (since)');
   }
   ```

2. `src/lib/db/repositories/benches.js`, the only place this table's SQL is
   written; it converts at its boundary (`values.js`), so the module keeps
   numbers, booleans, arrays and objects:

   ```js
   import { toIso, toJson, fromJson, toFlag, fromFlag } from '../values.js';

   export function createBenchesRepository(db, { now = () => new Date() } = {}) {
     return {
       async all() {
         const rows = await db.query('SELECT bench, user_ids, since, locked FROM bench_occupancy ORDER BY bench');
         return rows.map((r) => ({ bench: r.bench, userIds: fromJson(r.user_ids, []), since: r.since, locked: fromFlag(r.locked) }));
       },
       async setOccupants(bench, userIds) {   // async: bad input rejects, never throws
         return db.run(
           `INSERT INTO bench_occupancy (bench, user_ids, since, locked) VALUES (?, ?, ?, ?)
            ON CONFLICT (bench) DO UPDATE SET user_ids = excluded.user_ids, since = excluded.since`,
           [bench, toJson(userIds), toIso(now()), toFlag(false)],
         );
       },
     };
   }
   ```

3. One line in `src/lib/db/repositories/index.js`:
   `benches: createBenchesRepository(db, options),`. The module reads
   `deps.repos.benches`; several writes that must succeed together go
   through `repos.transaction(async (r) => { … r.benches … r.audit … })`.
4. The JSON file the module used before (if a deployed version wrote one):
   one importer in `IMPORTERS` of `src/lib/db/legacy.js` (`files`, `parse`,
   `write`); the file is renamed `.imported` after its import.
5. Tests with `memoryDatabase()` (`test/helpers/db.js`): the repository's
   methods, the module through `startTestApp`. `test/dbPortability.test.js`
   already runs the new migration statement by statement against the
   portability rules, and fails on SQL written outside `src/lib/db`.
6. §10 lists the new table.

Merging a lot written against JSON files (what the wave 2 merge did for
teams, benches, accounts, admin and the journal's days): replace its
`store.json()` / `store.jsonl()` documents by a migration and a repository as
above, keep the module's public API (its `services.*` and routes) unchanged,
keep in memory what it reads on every request with
`createCachedDocument()` (`src/lib/cachedDocument.js`: same `get()` /
`update(fn)` contract, `load()` in `start()`, a repository `save(next, prev)`
that writes what changed), and add an importer for any file a deployed
version (pre-production included) already wrote.

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
