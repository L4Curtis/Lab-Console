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
  server.js                 composition root: middleware order, module mounting
  config.js                 frozen config object, assembled from fragments
  lib/
    env.js                  env readers + validation errors      (lot: skeleton)
    store.js                data directory, JSON / JSONL files   (lot: skeleton)
    audit.js                audit trail                          (lot: skeleton)
    events.js               SSE hub, with per-user audiences     (lot: skeleton)
    security.js             headers, origin check, rate limiter, client IP
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
  login.html                the only page served without a session
  js/core/                  dom.js, api.js, i18n.js, session.js
  js/shared/                workspace, panes, dialog.js, tabs.js
  js/modules/<section>/     one folder per rail section
  locales/<lang>/<ns>.json  one namespace per module (fr, en)
  css/<module>.css          one stylesheet per module, loaded by the module
dev/                        mock-lab.js, fakeIos.js, mock-oidc.js, mock-proxmox.js
test/                       *.test.js (node:test)   test/e2e/*.e2e.js (browser)
docs/v2/                    this file, SPEC.md
```

Vocabulary: a **lab** (code) is one page of the diagram, shown to users as a
**bench** (English UI) / **baie** (French UI), e.g. `B4M`. A **device** is a
shape with a console address. A **target** is `host:port` on a console server.

## 3. Configuration

`src/lib/env.js` exports the readers that used to be private in `config.js`:
`str`, `required`, `int`, `bool`, `list`, `portRange`, and the shared `errors`
array. `src/config.js` still exports one frozen `config`, built from fragments:
a module that needs settings exports `readConfig()` from
`src/modules/<id>/config.js` and gets one line in `src/config.js`
(`<id>: readXxxConfig()`). Never read `process.env` anywhere else.

Global keys added by the skeleton:

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | — | Public origin, e.g. `https://lab.example.org`. Required when auth is on. Drives OIDC redirect URIs and cookie security. |
| `DATA_DIR` | `./data` | Writable state directory. |
| `TRUSTED_PROXIES` | empty | Comma list of proxy IPs / CIDRs whose `X-Forwarded-For` is believed. `TRUST_PROXY=true` (legacy) trusts every peer. |
| `DEFAULT_LOCALE` | `fr` | UI language for a first visit. |
| `AUTH_MODE` | `on` | `off` restores upstream behaviour: no login, one anonymous admin. |

Every new variable is documented in `.env.example`. Secrets never get defaults.

## 4. Request pipeline

Order in `src/server.js`:

1. `securityHeaders`
2. public static assets: `/css`, `/vendor`, `/locales`, `/js/core`, favicon
3. `GET /api/health` (liveness only, no detail)
4. auth routes: `/login`, `/auth/*`
5. **gate**: `auth.attach` then `auth.requireAuth` — everything below needs a user
6. state-changing requests must pass the existing same-origin check
7. app shell and remaining static files
8. `/api/events` (SSE), `/api/modules`, then each module router at `/api/<id>`
9. JSON 404 and error handler

WebSocket upgrades call `auth.authenticateUpgrade(req)` before any module sees
the request; a missing user ends the socket with 401. The origin check stays.

API errors are JSON: `{ "error": "English sentence", "code": "module.reason", "params": {} }`.
The browser translates `code` when it knows it and falls back to `error`.

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
auth.authenticateUpgrade(req)  // → User | null, for WebSocket upgrades
auth.sessions.list() / .revoke(sessionId) / .revokeUser(userId)
```

`GET /auth/me` returns `{ user, mode, locale, providerName }`; the browser reads
it once through `public/js/core/session.js` (`session.user`, `session.isAdmin`).

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
store.jsonl('audit/2026-11.jsonl')        // → { append(obj), read({ limit, since, filter }) }
```

**audit** (`src/lib/audit.js`)

```js
audit.log(actor, action, details)   // actor: req | User | 'system'
audit.query({ since, until, actorId, action, bench, limit })
```

Actions are `module.verb[.detail]`: `auth.login`, `console.open`,
`console.control.grant`, `bench.take`, `job.reset.start`. Put the bench name in
`details.bench` and the device name in `details.device` when they apply.
Never log secrets, passwords, tokens or typed keystrokes.

**events** (`src/lib/events.js`) — one SSE stream per browser tab

```js
events.publish(topic, data, { sticky, audience })  // audience: (user) => boolean
events.toUser(userId, topic, data)
```

Topics are `module:name`. Sticky topics are replayed on connect, through the
same audience filter. The handler reads `req.user`.

**services** — a plain object. A module publishes its API as
`services.<id> = {...}` while being created and other modules read it lazily,
inside handlers, never at creation time (creation order must not matter).

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
- **i18n.** `core/i18n.js` exports `t(key, params)`, `loadNamespace(ns)`,
  `getLocale()`, `setLocale()`. Keys are `ns.path.to.text`; dictionaries are
  `public/locales/<lang>/<ns>.json`. **No user-visible literal in JavaScript or
  HTML**: every string goes through `t()`, with both `fr` and `en` entries.
  French is the reference wording; write it the way a French networking
  student would say it, not as a translation. Interpolation is `{name}`.
- **Dialogs.** `shared/dialog.js`: `confirmDialog({ title, body, confirmLabel,
  danger, requireText })`, `formDialog(...)`, `openDialog(node)`. No
  `window.confirm` / `alert`.
- **Styles.** A module ships `public/css/<module>.css` and loads it with
  `loadCss()` from `core/dom.js`. Use the existing custom properties
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
  stay under a minute.
- `npm run test:e2e` runs `test/e2e/*.e2e.js` serially: `playwright-core`
  driving the system Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`,
  `--no-sandbox`). `test/e2e/harness.js` starts the mock lab, the mock OIDC
  provider and the app **on ephemeral ports** with a temporary data directory.
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
