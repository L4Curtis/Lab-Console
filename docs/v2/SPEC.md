# Lab Console v2 — what it must do

Product decisions, by lot. "Must" lines are acceptance criteria: the lot is not
done until each one is implemented **and tested**. Contracts are in
[ARCHITECTURE.md](ARCHITECTURE.md).

Users: one class of about thirty students, working in groups on eight benches,
plus a few admins. Two roles: **student** and **admin**. The UI is French by
default with English kept.

## Wave 1

### Lot skeleton
Platform services of ARCHITECTURE §3–§8 (env, store, audit, events with
audiences, services registry, request pipeline, i18n runtime, dialog and tabs
helpers, `loadCss`), every allowed dependency added to `package.json`, ESLint,
Dockerfile and `.env.example` updated. Existing behaviour and tests unchanged.

### Lot auth
- **Generic OpenID Connect.** Authorization code + PKCE (S256), `state`, `nonce`,
  discovery, ID-token validation through `openid-client`. Nothing specific to
  one provider: it must work with Pocket ID, Authentik, Keycloak, Authelia.
  Confidential (secret) or public client. Settings: `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`
  (`openid profile email groups`), `OIDC_GROUPS_CLAIM` (`groups`, dotted path
  allowed, string or array accepted, userinfo fallback), `OIDC_ADMIN_GROUPS`,
  `OIDC_ALLOWED_GROUPS` (empty = every authenticated user), `OIDC_PROVIDER_NAME`.
  Callback path is `/auth/callback`. Logout calls the provider's end-session
  endpoint when it advertises one.
- **Local admin, as a fallback.** Username + password (scrypt hash in
  `LOCAL_ADMIN_PASSWORD_HASH`) **+ mandatory TOTP** (RFC 6238, secret in
  `LOCAL_ADMIN_TOTP_SECRET`, ±1 step, a code cannot be replayed). Works when
  the provider is down. At most 5 attempts per 15 minutes per client and
  globally throttled; constant-time comparisons; every attempt audited.
  `npm run setup-admin` prints the hash, the secret and the `otpauth://` URI.
- **Everything requires a session** (ARCHITECTURE §4): pages, API, SSE, the
  three WebSocket endpoints. Verified by a test that walks every route.
- Client IP comes from `TRUSTED_PROXIES` only.
- Login page: provider button, a discreet "local administrator" form, both
  languages, clear errors, no information leak about which field was wrong.
- User menu in the rail: name, role, language switch, sign out.
- `dev/mock-oidc.js`: an importable fake provider with a user picker
  (three students, one admin), used by tests and by the pre-production stack.
- `AUTH_MODE=off` keeps the application usable exactly as upstream.

### Lot i18n
Every user-visible string of the existing UI (shell, consoles, infra, dialogs,
toasts, terminal status lines) goes through `t()`, with `fr` and `en`
dictionaries. A test fails when a key exists in one language only. Server
errors shown in the UI get a `code` and a French translation.

### Lot ios
- `CliAutomation` exposes composable steps (send a command and capture its
  output, wait for a pattern, answer a question) so procedures live outside it.
- `src/lib/drivers/ciscoIos.js`: `prepare()` brings any device to privileged
  EXEC — wakes the line, answers the initial configuration dialog with `no`,
  leaves config mode, quits a pager, runs `enable` with the supplied passwords
  (at most three attempts), and reports ROMMON / `switch:` / booting / silent /
  locked instead of forcing anything. Plus: `identify()` (model, software,
  configuration register), `runningConfig()`, `vlans()`, `cdpNeighbors()`,
  `interfaces()`, `ping()`, `eraseAndReload()` (erase startup-config, delete
  `vlan.dat` on switches, reload without saving, follow the boot, answer the
  initial dialog, confirm the factory prompt), `toReplayScript()` (see Lot jobs).
- `dev/fakeIos.js` grows to match real IOS closely enough to trust the driver:
  enable secret, startup vs running config, `erase startup-config` /
  `write erase`, `reload` with its questions and a boot sequence, the initial
  configuration dialog, `vlan.dat`, `show vlan brief`, `show version`,
  `show cdp neighbors detail`, `ping`, ROMMON, a busy line, a silent device.
  Prompts, confirmations and error texts copy real IOS wording.

### E2E harness
ARCHITECTURE §11, with a first scenario: sign in through the mock provider,
open a console on the mock lab, type a command, sign out.

## Wave 2

### Lot rooms — shared consoles
- A second user opening a device **joins** the same line and sees the recent
  history (server-side scrollback, about 200 KB).
- One **pilot**, any number of **spectators**. Every signed-in user may watch
  any console. "Request control": the pilot is asked; control passes
  automatically after 30 s without an answer, or when the pilot has been idle
  for 2 min. "Release control". An admin can take it. The pilot can switch the
  console to a shared keyboard.
- Presence on the diagram: who is on each device, who pilots; states *free*,
  *open in the app*, *busy outside the app*. A live panel lists open consoles,
  people, the last command (rebuilt from the device echo) and an activity feed.
- Bench wall: every open console of a bench as live read-only tiles.
- The line stays open while someone is attached, 30 s of grace after the last
  one leaves, 60 min idle timeout, an explicit "free the line" button.
- "Line busy outside the app": explicit message and "tell me when it is free".
- **Console journal**: what the device printed, with who held the keyboard,
  kept 14 days (`JOURNAL_RETENTION_DAYS`), size-capped, readable by the
  participants and admins, downloadable. Output only, never keystrokes. A
  banner tells users that sessions are journaled.
- Generic decoration API on the diagram and action registry on console tiles
  (ARCHITECTURE §8) for the later lots.
- Fewer SSH connections to the jump server: lines share a small pool of
  connections instead of one connection each.

### Lot benches — occupancy and reservations
- "Take the bench": the first user takes a free bench at once; **the next ones
  ask to join and an occupant accepts or refuses**. Occupants can leave;
  admins can assign, remove and release.
- Released by hand or after 3 h without activity (`BENCH_IDLE_HOURS`). On
  release the application offers a backup of the bench.
- On a taken bench only its occupants and admins may open or pilot its
  consoles and run jobs; everyone else watches. On a free bench anyone may
  open a console. A device shared by several benches follows any of them.
  Admin switches stay open to every signed-in user.
- **Reservations**: a small per-bench calendar. At the start of a slot the
  group that reserved may take the bench; current occupants are warned ten
  minutes before. Limits per user; admins manage everything.
- **Bench history**: occupants see who took, backed up, injected or reset
  their bench, and when (from the audit trail).

### Lot admin
- **Diagram import**: upload a `.drawio`, validate with the existing parser
  and linter, preview and diff against the current one, activate. Versions
  kept, one-click rollback, download. 5 MB limit, DOCTYPE / entities refused.
- Active sessions with revocation; audit viewer with filters; **announcement
  banner** shown to everyone; **health page**: jump server, console servers,
  Proxmox tunnel state (read-only for students, details for admins).

## Wave 3

### Lot jobs — backup, injection, reset
A job covers the devices of one bench, runs on the server, takes the keyboard
through `room.runExclusive`, is watched live by everyone, can be cancelled,
and ends with a per-device report. One mutating job per bench. Occupants and
admins only. Enable passwords are asked when the job is started, kept in
memory, never stored or logged.
- **Backup**: running-config, VLANs on switches, model and version, five
  devices at a time; stored as a snapshot with a manifest. List, read,
  **diff** (two snapshots, or snapshot vs live), **ZIP download and import**,
  **search** across snapshots. Visible to the people who occupied the bench
  when it was taken, and to admins.
- **Injection**: choose a snapshot; mode "reset then inject" (default) or
  "merge". The replay script fixes what makes a `show run` unreplayable:
  `no shutdown` on interfaces that were up, `^C` banners, non-replayable
  lines, VLANs recreated, optional RSA keys. Afterwards the device is read
  again and compared with the snapshot. `copy run start` on by default.
- **Reset**: dialog listing devices, connected people and what is erased; the
  bench name must be typed; 10 s cancellable countdown. Per device: automatic
  backup first — **if it fails the device is not erased** unless ticked by
  hand — then erase, reload, boot follow-up, factory prompt check. Devices
  shared between benches are unticked by default; admin switches never appear.
- **TP templates**: named starting configurations published by admins, that
  anyone may inject on their bench. **Base configuration** applied after a
  reset. **TP folder**: one ZIP with final configurations and console journals.
- Only Cisco IOS / IOS-XE. Any other system is detected and left untouched.

### Lot terminal
Reliable multi-line paste (paced like script injection); the same command sent
to several consoles at once; a shared script library; search in a console's
history and download of that history.

### Lot collab
Browser notifications (control requested, line freed, job finished); a shared
note per device; a small chat per bench for its occupants.

## Wave 4

### Lot checks
Line status on demand (free / busy outside the app) shown on the diagram;
cabling check (CDP on the whole bench against the diagram's links); ping
matrix; IP addresses and interface state read from the devices and shown on
the diagram.

### Lot recovery
Guided password recovery (BREAK, ROMMON, configuration register) for a device
left locked. It needs someone on site to power-cycle the device.

### Lot overview, lot help
One screen with every bench: occupants, open consoles, running jobs. A guided
tour at first sign-in and a help page.

## Wave 5
End-to-end scenarios, security review, completeness check against this file,
documentation in French and English, version 2.0.0.
