# Changelog

**English** · [Français](CHANGELOG.fr.md)

## 2.1.0 - 2026-11-14

- **Versioned addresses for the application's own files.** The pages load
  their scripts, stylesheets and dictionaries from `/v/<build id>/…`, where
  the build id is a hash of `public/` computed at start-up. Those answers are
  kept by the browser for a year (`private, max-age=31536000, immutable`):
  a page load costs one revalidation instead of one per file, and an upgrade
  is picked up at the next page load. An old build id answers 404; a tab left
  open across an upgrade offers to reload when it opens a new section. The
  plain addresses keep working, revalidated as before. Access rules are
  unchanged. See [DEPLOY.md](docs/DEPLOY.md) ("Caching, and a CDN in front").
- `npm run dev` also restarts when a file of `public/` changes.
- A section whose data came back after the user had moved to another one no
  longer takes the address back (Sauvegardes did, when left quickly).

## 2.0.0 - 2026-11-14

Lab Console 2 is a rewrite of the platform around sign-in, teams and bench
work. It keeps the same stack (Node.js, Express, plain ES modules, no build
step) and the same job: console access to the lab through a jump server.
Upgrading from v1 is described in the README ("Upgrading from v1").

### Breaking changes

- **Sign-in is mandatory.** The application refuses to start without a local
  administrator (`LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD_HASH`,
  `LOCAL_ADMIN_TOTP_SECRET`; `npm run setup-admin`). There is no mode without
  authentication.
- **`PUBLIC_URL` is required.** `TRUST_PROXY=true` is refused at start-up;
  `TRUSTED_PROXIES` lists every proxy hop.
- **State lives in `DATA_DIR`** (SQLite database `lab-console.db` plus files
  for snapshots, templates, journals and diagram versions). The Docker image
  runs read-only with a volume on `/data`; image tag `lab-console:2`.
- **Production requires a pinned jump server key**: under `NODE_ENV=production`
  (the Docker image) no console connects without `SSH_HOST_FINGERPRINT` or a
  fingerprint saved on the lab parameters page (`consoles.ssh_unpinned`).
- **Proxmox** (virtual machines, both VM console WebSockets) is reserved to
  administrators. Admin switches stay open to everyone.
- The active diagram is the copy in `DATA_DIR/diagrams/current.drawio`;
  `diagrams/diagram.drawio` only seeds it on the first start.
- Sensitive administration actions ask for a confirmation (see Security).

### Added

- **Accounts**: OpenID Connect sign-in (settings from the environment or the
  administration page), local accounts by invitation, password reset links,
  passkeys, roles, approval of accounts, My account, audit trail, session
  list and revocation, rate limits and known browsers on the local form.
- **Teams and benches**: teams with invitations (`TEAM_MAX_MEMBERS`), taking
  and releasing a bench, idle release (`BENCH_IDLE_HOURS`), locks with a
  reason, reservation calendar with limits, guests.
- **Shared consoles**: one server-owned line per device, one pilot and any
  number of spectators, passing the keyboard, bench rule asked again at every
  keystroke, journal per console day (`JOURNAL_*`).
- **Bench jobs**: backup, injection, reset and comparison on every device of a
  bench, snapshots (list, read, diff, search, ZIP download and import), TP
  templates (publish, ZIP import), TP folder; a device is never erased without
  a verified backup.
- **Console tools**: paced multi-line paste, send to several consoles, history
  with search and download, script library (personal, team, published).
- **Group work**: a note per device, a chat per bench, browser notifications.
- **Checks**: line status, cabling (CDP), ping matrix, interface addresses.
- **Password recovery**: a guided assistant for several device families (not
  yet tried on every real model).
- **Home page, overview of every bench, Help page and guided tour.**
- **Administration**: lab parameters applied without a restart, diagram import
  with preview, versions and rollback, admin switches, announcement banner,
  lab status page.
- **French and English** everywhere, with a language switch.
- **Documentation**: README, student guide, deployment guide, configuration
  reference generated from `.env.example` (`npm run gen-config-doc`), a
  Docker mock-lab override (`docker-compose.mock.yml`).
- A mock lab with simulated Cisco IOS / IOS XE devices (boot, erase, recovery,
  slow consoles), cabling faults, a mock identity provider and a mock Proxmox.

### Changed

- Proxmox tunnel transport: `PROXMOX_TUNNEL_TRANSPORT` is `auto` (TCP
  forwarding, then a relay command) by default; `forward` and `exec` force one.
- The interface is responsive down to phone width (bottom navigation bar), has
  a skip link, one page title per section and WCAG-oriented contrast tokens;
  failed loads show a message with a retry button instead of an empty page.
- One French typography and one date format throughout.

### Security

- Sign-in: OIDC with PKCE, `state` and `nonce`; scrypt password hashes;
  `__Host-` Secure session cookie under https; HSTS when `PUBLIC_URL` is
  https; origin check on WebSockets and on every change.
- `Ctrl+]` can no longer reach the jump server's telnet command mode from any
  path: keystrokes, pastes, injected scripts, broadcasts, job passwords, the
  console login and the wake-up Enter. Only the BREAK button sends it, and
  anything sent to the line meanwhile is held until the break is done.
  Scripts and job passwords containing control characters are refused.
- Request bodies: compressed bodies are refused (415) before being read; all
  parsers come from one module; `body-parser` and `qs` updated
  (`npm audit --omit=dev` reports nothing).
- Sensitive administration actions need a fresh confirmation (password and
  code, passkey, or a new sign-in at the identity provider): lab parameters,
  SSO settings, inviting, promoting or enabling an administrator, clearing an
  administrator's passkeys.
- Jobs, checks and recovery re-read the person's current role before every
  device: a demoted or disabled account is stopped mid-task.
- Proxmox failures answer a generic error to the browser, the detail stays in
  the log.

### Known limitations

- Not tried on the real equipment: the erase and reload path on IOS XE 17, the
  time of a 2048-bit RSA key on an old router, five job lines at once on the
  console server, every recovery family, CDP output on IOS XE 17 and the 9300L,
  the console server's handling of BREAK.
- The health page shows no Proxmox tunnel line and `/api/proxmox/status` names
  the environment's jump server, not the one saved on the lab page; the
  Proxmox module's API errors reach the interface in English. The Proxmox
  module was left as it was by decision.
- An SSO administrator who confirms from the Users or Invitations tab repeats
  the action after coming back from the identity provider. Disabling an
  administrator needs no confirmation (it only removes access).
- The activity feed prints one line per device for a bulk job.
- Browser scenarios are missing for the SSO settings page, pending approval,
  the password-reset page, My account, snapshot comparison dialogs, the ping
  matrix with addresses, the health and journal pages and the live panel
  (they are covered by unit and integration tests).
- Open decisions for the owner are listed in `docs/v2/SPEC.md` (release offer
  after non-manual releases, the spectator's right to the journal).

## 1.1.0

Console tools (export of the running-config, script injection) and bulk
virtual-machine power.

## 1.0.0

First release: consoles of the lab devices from a draw.io diagram, through an
SSH jump server and telnet, and the Infrastructure section (admin switches,
Proxmox virtual machines).
