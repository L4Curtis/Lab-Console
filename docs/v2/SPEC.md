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
- User menu in the rail: name, role, sign out. (The language switch is in
  the rail too, but belongs to the lot i18n.)
- `dev/mock-oidc.js`: an importable fake provider with a user picker
  (three students, one admin), used by tests and by the pre-production stack.
- **No mode without sign-in** (owner decision, 12 Nov). The application
  refuses to start, with a readable message, unless the local administrator
  is configured; OIDC stays optional. Tests sign in for real (mock provider,
  local administrator with a computed code, or a session created in the
  session store by the test helper).
- Exposed directly to the Internet: throttling keyed on the real client
  address (trusted proxies only) and on the user name, with exponential
  backoff; identical answers and timing whether or not an account exists;
  `X-Robots-Tag: noindex` on the login page; no version or stack in errors.

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

Owner decisions of 12 Nov 2026 shape this wave: **teams** own benches,
backups and reservations; **accounts** are created through invitation links;
**passkeys** protect promoted admins; the **SSO** and the **lab connection
parameters** are set from the administration pages. After launch the site is
exposed directly to the Internet (no Cloudflare Access in front).

### Lot rooms — shared consoles
- A second user opening a device **joins** the same line and sees the recent
  history (server-side scrollback, about 200 KB).
- One **pilot**, any number of **spectators**. Every signed-in user may watch
  any console. "Request control": the pilot is asked; control passes
  automatically after 30 s without an answer, or when the pilot has been idle
  for 2 min. "Release control". An admin can take it. The pilot can switch the
  console to a shared keyboard.
- Who may pilot is decided by `services.benches.canPilot(user, device)`
  (lot teams). Until that lot is merged, treat every signed-in user as allowed,
  behind that single call.
- Presence on the diagram: who is on each device, who pilots; states *free*,
  *open in the app*, *busy outside the app*. A live panel lists open consoles,
  people, the last command (rebuilt from the device echo) and an activity feed.
- Bench wall: every open console of a bench as live read-only tiles.
- The line stays open while someone is attached, 30 s of grace after the last
  one leaves, 60 min idle timeout, an explicit "free the line" button.
- "Line busy outside the app" and "device silent" (accepted by the console
  server, no output: power or cable) are distinct, explicit messages; "tell me
  when it is free".
- **Console journal**: what the device printed, with who held the keyboard,
  kept 14 days (`JOURNAL_RETENTION_DAYS`), size-capped per device and day
  (`JOURNAL_MAX_KB_PER_DAY`) and in all (`JOURNAL_MAX_TOTAL_MB`, 1024 by
  default: past it the oldest days go first, never today's), readable by the
  participants, the team that held the bench, and admins; downloadable.
  **Read rights cover the whole day of a console** (owner decision, 13 Nov):
  whoever was on R1 at any time of a day, and the teams that held its bench
  that day, read every session of R1 that day, other people's included; the
  journaling page and the journal dialog say so. The list of days per console
  is a table of the database; the output stays in files.
  Output only, never keystrokes. A banner tells users that sessions are
  journaled.
- Lab connection parameters (jump server, console login, allowed hosts) are
  read from `deps.settings.get('lab')` **each time a line is opened**, never
  from `config` and never once at start-up: the admin lot makes them editable.
- Generic decoration API on the diagram and action registry on console tiles
  (ARCHITECTURE §8) for the later lots.
- Fewer SSH connections to the jump server: lines share a small pool of
  connections instead of one connection each (mind sshd `MaxSessions`).

### Lot teams — teams, benches, reservations
- **Teams.** Any student creates a team (name), invites classmates by
  username, and they accept. The user name must be one the directory knows
  (`services.accounts.findByUsername`, compared without case; an SSO account
  is known from its first sign-in): the invitation keeps the account's own
  spelling, an unknown name is refused (`teams.unknown_user`); members can leave; the last member leaving
  dissolves it. A student belongs to at most one team at a time (admins: none
  needed). Admins see, rename, edit and dissolve every team.
- **Taking a bench.** A member takes a free bench **for the team**; every
  member is then an occupant. Someone outside the team asks to join; any
  member accepts or refuses; an accepted guest is an occupant until they leave
  or the bench is released. Admins can assign a bench to a team, remove
  people and release.
- Released by hand or after 3 h without activity (`BENCH_IDLE_HOURS`). On
  release the application offers a backup of the bench (the jobs lot provides
  the action; until then the offer is a hook that does nothing).
- **Permissions.** On a taken bench only its occupants and admins may open or
  pilot its consoles and run jobs; everyone else watches (a line already open
  can be joined by anyone signed in, read-only). On a free bench anyone may
  open a console. A device shared by several benches follows any of them.
  Admin switches stay open to every signed-in user. The consoles ask
  `services.benches.canPilot` when a line opens and at every keystroke and
  control action: a pilot whose bench is locked or taken by another team
  watches from then on. Console activity postpones the automatic release
  (`services.benches.touch`).
- **Bench lock** (admin): freeze a bench with a reason ("prepared for the
  graded lab"); nobody opens a console or runs a job on it, the reason is shown
  on the bench; admins only can lift it.
- **Reservations**: a per-bench calendar, slots booked **by a team**. At the
  start of its slot the team may take the bench; current occupants are warned
  ten minutes before. Limits per team (e.g. 2 future slots, 4 h each); admins
  manage everything. A team cannot book a slot that has already started, nor,
  on a bench another team holds, one that starts in less than ten minutes (the
  warning would not have time to reach the occupants). The promise is
  therefore "at most ten minutes": a team that takes a free bench less than ten
  minutes before another team's slot is warned at the next tick with the
  minutes that remain.
- **Bench history**: occupants see who took, backed up, injected or reset
  their bench, and when (from the audit trail).
- Snapshots, chat and journals will belong to **the team** that held the bench
  (wave 3 relies on `services.teams.teamOf(user)` and
  `services.benches.holder(labName)`).

### Lot accounts — directory, invitations, passkeys, SSO settings
Built in the same worktree as the admin lot, before it. Builds on the auth
lot's extension points (`auth.accounts.add`, `auth.sessions.create`,
`auth.oidc.configure`; ARCHITECTURE §5).
- **Directory** (tables `accounts` and `account_passkeys`): local accounts (username,
  display name, scrypt hash, role, state, passkeys) and the SSO accounts seen
  at sign-in (with an optional role set by an admin, which wins over the group
  mapping). The environment's administrator stays outside the directory and is
  always admin.
- **Invitations**: an admin creates a link valid 1 h, 24 h or 7 days, single-use
  or for N people, with the role it grants (student by default); revocable;
  list of pending ones. The token is 256 random bits, stored hashed. The sign-up
  page asks username, display name, password twice (10 characters minimum).
  **A single-use link gives an active account at once; a multi-use link gives
  an account pending approval**, which an admin approves or rejects in one
  click. Sign-up is rate-limited. **The sign-up page may say that a chosen
  user name is taken** (owner decision, 13 Nov): only the holder of a valid
  invitation can ask, a taken name (the environment admin's included) is
  refused like a reserved one, before any hashing, and refusals are limited
  to 10 per link per 15 minutes (AUTH.md §2b).
- **Password reset links**, generated by an admin (there is no e-mail): same
  mechanism, single use, short-lived; using one ends the account's sessions.
- **Roles and states**: any admin, the environment's admin included, promotes or
  demotes any account, local or SSO, and disables or re-enables it. The last
  admin cannot be removed. Changing a role or disabling an account ends its
  sessions.
- **Passkeys (WebAuthn)** with `@simplewebauthn/server` and
  `@simplewebauthn/browser`: an account promoted to admin must register a
  passkey at its next sign-in and then signs in with it (it replaces TOTP for
  them); students may add passkeys for their own devices and keep their
  password. **One-click sign-in** with a passkey on the login page
  (discoverable credentials, conditional UI where the browser supports it).
  Relying party id = the host of `PUBLIC_URL`; refuse to offer passkeys when
  `PUBLIC_URL` is not https (except `localhost` for tests). The environment's
  administrator keeps password + TOTP.
- **My account**: display name, password change, passkeys (add, rename,
  remove; an admin cannot remove the last one), sessions (sign out others).
- **Login page**: SSO button when configured, local sign-in, passkey button;
  no hint about which accounts exist.
- **SSO settings page** (admin): provider name, issuer, client id, client
  secret (write-only), scopes, groups claim, admin groups, allowed groups; the
  callback URL shown for copying; "test" (discovery); "try a sign-in" that
  shows the claims received and the resulting role without opening a session;
  enable / disable. Saved in the database (`settings` row `sso`; the client
  secret is kept in clear in the database file, mode 600, encrypted when
  `APP_SECRET` is set). Applied at once with `auth.oidc.configure`. When `OIDC_ISSUER` is set
  in the environment, the environment wins and the page is read-only. The
  discovery request is guarded against SSRF (https only unless the insecure
  flag, timeouts, size limit, no redirect to an internal address).
- **Administration section shell**: a rail entry for admins only, built with
  `shared/tabs.js`, with the tabs Users, Invitations, Sign-in (SSO). The admin
  lot adds its tabs next to them.

### Lot admin — administration pages
Same worktree as the accounts lot, after it.
- **Lab parameters page**: jump server (host, port, username, password or
  key, host key fingerprint), console server login, allowed console hosts and
  port range, Proxmox URL and credentials. Secrets are write-only; saving asks
  the admin to confirm with their passkey or their password + TOTP; applied to
  the lines opened next, no restart. Implemented by completing
  `src/lib/settings.js` (`describe`, `update`, `register`, persistence in
  the database through `repos.settings` (ARCHITECTURE §6), validation, audit without secrets,
  'change' event). Environment values are the starting point; saved values
  win over them.
- **Diagram import**: upload a `.drawio`, validate with the existing parser
  and linter, preview and diff against the current one, activate. Versions
  kept, one-click rollback, download. 5 MB limit, DOCTYPE / entities refused.
  Also edit the admin switches list (`infrastructure.json`).
- Active sessions with revocation; audit viewer with filters; **announcement
  banner** shown to everyone; **health page**: jump server, console servers,
  Proxmox tunnel state (read-only for students, details for admins); a page
  saying what is journaled and for how long.

*As built (admin lot):* Administration tabs Lab parameters, Diagram, Admin
switches, Sessions, Audit trail, Announcement; a "Lab status" rail section
for everyone with Health and What is recorded.
- **Confirmation.** The environment's administrator confirms with password +
  code, a local administrator with a passkey, **an SSO administrator by signing
  in again at the identity provider** (owner decision, 13 Nov): a dedicated
  authorization request asks for a fresh sign-in (`prompt=login`,
  `max_age=0`, checked on return: the same person, still an administrator);
  its callback marks the admin's session as freshly confirmed for 5 minutes,
  during which saving needs no further proof. The lab page keeps the
  non-secret draft across the trip and fills it in again. Tickets: 2 minutes,
  one use, 10 attempts per 15 minutes (trips to the provider included); a
  ticket is spent only when the values are valid (a typo does not cost a new
  confirmation).
- **Diagram import.** DOCTYPE / entities are refused by the parser on every
  document it builds, compressed pages written in CDATA, with comments or
  with character references included; the pages may not inflate to more than
  20 MB in all. An import or an activation is refused while the linter finds
  two different devices on one console line (`admin.diagram_lint`; rolling
  back is never refused). The preview lists the devices whose console is
  outside the allow-list; that does not block (they stay inert for students).
- **Health.** A console server is probed on its console lines (the ports
  the lab diagram uses on it, else the start of the allowed range), never
  on telnet's port 23: it is up when one of up to three lines answers, a
  connection accepted or actively refused, so only silence on all of them
  reads as down. Whether the jump server's `nc -z` prints anything on a
  refusal could not be checked without touching the lab: a server whose
  probed lines are all busy may read as down. Proxmox must accept its API
  port. The Proxmox tunnel state is read from
  `services.proxmox.tunnel()` as soon as the Proxmox module publishes it.
  The page also shows, from the consoles module itself, the lines open, the
  shared SSH connections to the jump server (details for admins) and the
  journals' total against `JOURNAL_MAX_TOTAL_MB` (for everyone).
- **What is recorded** reads the consoles module's journal settings
  (retention, the caps) and says that read access covers a console's whole
  day.
- **Proxmox URL and credentials are shown, not editable** (owner decision,
  13 Nov: Proxmox is postponed; its tunnel does follow the jump server's
  parameters).

*Not met:* the Proxmox module does not publish `services.proxmox.tunnel()`
yet (a three-line addition in `src/modules/proxmox/index.js`, which the
working rules keep untouched), so the health page shows no tunnel line until
it does.

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
  **search** across snapshots. Owned by the team that held the bench; visible
  to its members and to admins. The server is not a backup: right after a
  backup the UI offers the ZIP and says plainly to download it.
- **Injection**: choose a snapshot; **preview** the exact script each device
  will receive before starting; mode "reset then inject" (default) or
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
note per device; a small chat per bench for its occupants (kept with the team).

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
One screen with every bench: team, occupants, open consoles, running jobs,
locks. A **personal home page** after sign-in: my team, our bench, our
backups, recent activity. A guided tour at first sign-in and a help page.

## Wave 5
End-to-end scenarios, security review, completeness check against this file,
documentation in French and English, version 2.0.0.
