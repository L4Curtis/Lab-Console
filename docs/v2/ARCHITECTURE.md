# Lab Console v2 — architecture and contracts

This document is the shared contract for everyone working on v2. Lots are built
in parallel on separate branches: the interfaces below are what lets them merge.

**If you must deviate from a contract, change this file in the same commit and
say so in your report.** A contract that silently drifts breaks another lot.

Feature decisions live in [SPEC.md](SPEC.md). Base: upstream v1.1.1.

## 1. Principles

1. **Stay close to upstream.** Plain ES modules, no build step, no TypeScript, no
   front-end framework, `node:test`. Same file style as the existing code: a
   header comment explaining the *why*, small modules, private `#fields`.
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
   authentication and i18n strictly require: upstream is reworking it.

## 2. Repository layout

```
src/
  server.js                 composition root: createApp(), middleware order, module mounting
  config.js                 frozen config object, assembled from fragments; loadConfig()
  lib/
    env.js                  env readers + validation errors      (lot: skeleton)
    store.js                data directory, JSON / JSONL files   (lot: skeleton)
    audit.js                audit trail                          (lot: skeleton)
    events.js               SSE hub, with per-user audiences     (lot: skeleton)
    httpError.js            API error shape: HttpError, sendError (lot: skeleton)
    security.js             headers, origin check, rate limiter, client IP, trusted proxies
    cliAutomation.js        expect-like engine on a console line
    drivers/ciscoIos.js     device procedures built on the engine (lot: ios)
  modules/
    auth/                   sessions, OIDC, local admin + TOTP   (lot: auth)
    consoles/               diagram, rooms, console WebSocket    (lot: rooms)
    benches/                occupancy, reservations, history     (lot: benches)
    admin/                  diagram import, sessions, audit, announcements, health
    jobs/                   bench jobs, snapshots                (lot: jobs)
    collab/                 device notes, bench chat, notifications
    scripts/                shared script library
    checks/                 line status, cabling, ping matrix, interface overlay
    proxmox/                unchanged
public/
  login.html                the only page served without a session (lot: auth)
  js/core/                  dom.js, api.js, i18n.js, session.js   (public: the login page uses them)
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
| `PUBLIC_URL` | — | `server.publicUrl` | Public origin, e.g. `https://lab.example.org` (no path; `''` when unset). Required when auth is on. Drives OIDC redirect URIs and cookie security. |
| `DATA_DIR` | `./data` | `dataDir` (absolute) | Writable state directory. The Docker image sets `/data`. |
| `TRUSTED_PROXIES` | empty | `server.trustedProxies` (string[]) | Comma list of proxy IPs / CIDRs (IPv4, IPv6) whose `X-Forwarded-For` is believed. `TRUST_PROXY=true` (legacy, `server.trustProxy`) trusts every peer; a non-empty list wins over it. |
| `DEFAULT_LOCALE` | `fr` | `defaultLocale` | UI language for a first visit (`fr` or `en`). |
| `AUTH_MODE` | `on` | `auth.mode` | `off` restores upstream behaviour: no login, one anonymous admin. |

`PORT=0` is accepted and binds any free port (tests, the e2e harness).

Until the auth lot lands, `src/modules/auth/config.js` refuses `AUTH_MODE=on`
(the default) with a message that says to set `AUTH_MODE=off`: a build without
sign-in never runs open by accident. The auth lot removes that refusal and
adds its own keys to the same fragment (`config.auth`).

Every new variable is documented in `.env.example`. Secrets never get defaults.

## 4. Request pipeline

`src/server.js` exports `createApp({ config, logger?, createAuth?, createModules? })`
→ `{ app, server, modules, deps, listen(), close() }` and only listens when it
is run directly (`node src/server.js`). Order inside `createApp`:

1. `securityHeaders`
2. public static assets: `/css`, `/vendor`, `/locales`, `/js/core`,
   `/favicon.svg` (also answered on `/favicon.ico`). A missing public file is a
   404, never a redirect to the login page.
3. `GET /api/health` (liveness only, no detail)
4. auth routes: `app.use(auth.router)` — `/login`, `/auth/*`
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
The Proxmox module is unchanged and still answers `{ error }` without a code.

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
  id,          // 'oidc:<sub>' | 'local:<username>' | 'anonymous'
  username, name, email,
  role,        // 'student' | 'admin'
  groups,      // string[] from the identity provider
  via,         // 'oidc' | 'local' | 'anonymous'
  initials, color   // stable, derived from id, for presence badges
}
```

The auth module returns this service, passed to every module as `deps.auth`:

```js
auth.mode                      // 'on' | 'off'
auth.attach(req, res, next)    // sets req.user (or leaves it undefined)
auth.requireAuth(req, res, next)   // 401 JSON under /api, 302 /login otherwise
auth.requireRole('admin')      // middleware, 403 JSON
auth.authenticateUpgrade(req)  // → User | null (may be a promise), for WebSocket upgrades
auth.sessions.list() / .revoke(sessionId) / .revokeUser(userId)
auth.router                    // Express router with absolute paths (/login, /auth/*), mounted before the gate
auth.shutdown?()               // optional, called when the application closes
```

`src/modules/auth/index.js` exports `createAuth(deps)` (deps: `{ config,
logger, events, store, audit, services }`) and, for every implementation and
for tests, `requireAuth`, `requireRole`, `hasRole(user, role)`, `createUser`,
`ANONYMOUS` and `ROLES`. Roles are ordered: `student` < `admin`, so
`requireRole('student')` lets an admin through. `requireAuth` answers 401 JSON
(`auth.required`) under `/api/` and for any non-GET request, 302 `/login`
otherwise; `requireRole` answers 403 `auth.forbidden` with `params.role`.
`createUser({ id, username, name, email, role, groups, via })` builds the
frozen `User` above, `initials` and `color` included. When a session is
revoked, also end the user's SSE streams: `events.disconnect((u) => u?.id === id)`.

Until the auth lot lands the folder holds the anonymous implementation only:
`createAuth` throws unless `config.auth.mode === 'off'`.

`GET /auth/me` is public and returns `{ user, mode, locale, providerName }`
(`user: null` when nobody is signed in, `locale` = `DEFAULT_LOCALE`); the
browser reads it once through `public/js/core/session.js`
(`await loadSession()`, then `session.user`, `session.isAdmin`, `session.mode`,
`session.locale`, `session.providerName`).

Sessions are server-side, keyed by a random 256-bit id in a cookie named
`__Host-lc_sid` when `PUBLIC_URL` is https (`Secure; HttpOnly; SameSite=Lax; Path=/`)
and `lc_sid` otherwise (development and tests over http). Idle timeout 8 h,
absolute lifetime 24 h, id rotated at login.

With `AUTH_MODE=off` every request carries the same anonymous admin user, so
the rest of the code never branches on the mode.

## 6. Platform services

Created once in `server.js` and passed to every module in `deps`:
`{ config, logger, events, infra, store, audit, auth, services }`.

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
services.benches = {
  occupants(labName) → User ids[]
  isOccupant(user, labName) → boolean
  canOperate(user, labName) → boolean        // occupant or admin
  canPilot(user, device) → boolean           // see SPEC §Benches
  touch(labName)                             // activity, postpones auto-release
}
services.jobs = { running(labName) → Job | null, list({ bench }) }
```

## 8. Front end

- **Sections.** `public/js/main.js` keeps the `MODULES` array; a new rail
  section is one line there and one folder in `public/js/modules/`.
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

## 10. Data directory

```
data/
  auth/sessions.json
  audit/<yyyy-mm>.jsonl
  diagrams/current.drawio   diagrams/versions/<ts>-<user>.drawio   diagrams/index.json
  journal/<bench>/<device>/<yyyy-mm-dd>.log
  benches/occupancy.json    benches/reservations.json
  snapshots/<bench>/<ts>-<label>/{manifest.json,<device>.cfg,<device>.vlan.txt}
  templates/<name>/...      same layout as a snapshot
  collab/notes.json         collab/chat/<bench>.jsonl
  scripts/library.json
  admin/announcements.json
```

The image runs read-only; `DATA_DIR` is the only writable path. Bench and
device names used in paths go through `store.resolve`, never string concat.

## 11. Testing

- `npm test` runs every `test/**/*.test.js` with `node:test`. It must pass and
  stay under a minute. (The glob needs Node 22, like the Docker image.)
- `npm run test:e2e` runs `test/e2e/*.e2e.js` serially: `playwright-core`
  driving the system Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`,
  `--no-sandbox`). `test/e2e/harness.js` starts the mock lab, the mock OIDC
  provider and the app **on ephemeral ports** with a temporary data directory.
  `test/e2e/shared-ui.e2e.js` (dialogs, tabs, i18n in the browser) already
  runs; it starts the app itself and does not need the harness.
- `test/helpers/app.js`: `startTestApp({ env, auth, modules })` starts the
  real application on a free port with a temporary `DATA_DIR` and returns
  `{ url, wsUrl, app, server, deps, config, dataDir, close() }`;
  `loadTestConfig(env)` returns a configuration. `test/helpers/fakes.js`:
  `student(n)`, `admin()`, `fakeAuth()` (the user is named by an
  `x-test-user: student1 | student2 | student3 | admin` header, or `?as=` on a
  WebSocket URL; no header = nobody), `fakeRequest()`, `fakeResponse()`,
  `recordingLogger()`. To test a module in the real pipeline as a student, an
  admin and nobody:
  `startTestApp({ auth: fakeAuth(), modules: (deps) => [createMyModule(deps)] })`.
- `npm run lint` (ESLint flat config) must pass.
- The mocks are importable: `startMockLab({ port: 0, ... })`,
  `startMockOidc({ port: 0, users })` return `{ port | issuer, close() }`.
- Never hard-code a port in a test. Never leave a process running.
- A feature is not done until its happy path and its refusals are tested.

## 12. Conventions

- 2 spaces, single quotes, semicolons, trailing commas on multi-line literals.
- English code, comments, commit messages and API errors.
- Conventional Commits (`feat(auth): …`, `fix(rooms): …`, `test: …`), small
  and logical. Trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Never commit `.env`, `data/`, `node_modules/`, credentials or real configs.
- Dependencies allowed: `openid-client`, `fflate`, `diff` (runtime);
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
  unless it is a hash?
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
