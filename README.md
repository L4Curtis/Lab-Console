# Lab Console

**English** · [Français](README.fr.md)

Version 2.0.0. Browser access to the physical lab equipment of a networking
course. Pick a bench, click a router or switch on its diagram, and its console
opens in a terminal next to the diagram. Open several at once to configure
devices side by side.

```
Browser ──WebSocket──► Lab Console ──SSH (exec)──► jump server ──telnet──► console server ──► device
```

## What it does

- **Consoles**: every device of the lab diagram opens as a text console in the
  browser. A console line belongs to the server, so several people can join
  it: one types (the pilot), the others watch, and the keyboard is passed on
  request.
- **Teams and benches**: students form teams, take a bench, invite guests and
  reserve slots. A bench held by a team is driven by its members only.
- **Bench jobs**: backup of every device of a bench, injection of a script,
  reset to the base configuration, comparison of snapshots; TP templates
  published by the teachers.
- **Checks and password recovery**: line status, cabling, ping matrix and
  interface addresses; a guided recovery of a device locked by a password.
- **Group work**: a note per device, a chat per bench, a script library,
  browser notifications, the console journal.
- **Accounts and administration**: single sign-in through your identity
  provider (OpenID Connect), local accounts by invitation, passkeys, a
  mandatory local administrator, audit trail, sessions, lab parameters,
  diagram versions, announcements, health page.
- **Infrastructure** (administrators only): admin switches and the Proxmox
  virtual machines, reached through the jump server.
- Everything is in French and English, and the in-app **Aide** page explains
  each section to the students.

## Documentation

| For | English | Français |
|---|---|---|
| Students and teachers | [Student guide](docs/STUDENTS.md) | [Guide étudiant](docs/fr/ETUDIANTS.md) |
| Putting it online (reverse proxy, HTTPS, backups) | [docs/DEPLOY.md](docs/DEPLOY.md) | [docs/fr/DEPLOY.md](docs/fr/DEPLOY.md) |
| Signing in, SSO, local administrator | [docs/v2/AUTH.md](docs/v2/AUTH.md) | [docs/fr/AUTH.md](docs/fr/AUTH.md) |
| Every setting | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) (generated from `.env.example`) | [README.fr.md](README.fr.md) |
| What changed | [CHANGELOG.md](CHANGELOG.md) | [CHANGELOG.fr.md](CHANGELOG.fr.md) |
| People who work on the code | [docs/v2/ARCHITECTURE.md](docs/v2/ARCHITECTURE.md), [SPEC.md](docs/v2/SPEC.md), [TESTING.md](docs/v2/TESTING.md) (English) | |

## Quick start (Docker)

```bash
cp .env.example .env        # Windows: Copy-Item .env.example .env
# edit .env: PUBLIC_URL, SSH_* (jump server) and TELNET_* (console login)
npm run setup-admin         # prints the three LOCAL_ADMIN_* lines: paste them into .env
docker compose up -d --build
```

Open http://localhost:3000 and sign in with the local administrator (user
name, password, and the 6-digit code of your authenticator app).

The Docker image runs with `NODE_ENV=production`, which requires
`SSH_HOST_FINGERPRINT` (the identity of the jump server): without it no
console connects. Get it with
`ssh-keyscan -t ed25519 <jump server> | ssh-keygen -lf -`. To put the
application on the Internet read [docs/DEPLOY.md](docs/DEPLOY.md) first.

Without Docker (Node.js 22.13 or newer):

```bash
npm ci
npm run setup-admin
npm start
```

### Quick start with the mock lab (Docker)

No lab at hand? `docker-compose.mock.yml` starts a simulated jump server and
simulated devices next to the application:

```bash
cp .env.example .env
npm run setup-admin         # paste the three LOCAL_ADMIN_* lines into .env
# in .env:  PUBLIC_URL=http://localhost:3000
#           SSH_HOST=mock-lab  SSH_PORT=2222  SSH_USERNAME=lab  SSH_PASSWORD=lab
#           TELNET_USERNAME=  TELNET_PASSWORD=
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build
```

The comments of `docker-compose.mock.yml` explain the details. It is a demo
tool: the simulator's host key changes at each start, so the application runs
there with `NODE_ENV=development` (no host key pinning). Never use it with real
accounts. (This file was written without a Docker engine at hand: if it
fails, run the two programs on the host as described next.)

## Configuration

Everything is set through environment variables, read from `.env`:
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) lists every one of them with its
default and description. It is generated from the comments of `.env.example`
(`npm run gen-config-doc`; a test fails when the two differ). The settings
that matter first: `PUBLIC_URL`, `TRUSTED_PROXIES`, `LOCAL_ADMIN_*`, `SSH_*`
with `SSH_HOST_FINGERPRINT`, `TELNET_*`, `ALLOWED_CONSOLE_HOSTS`, `APP_SECRET`.

## Upgrading from v1

Lab Console 2 is a different application with the same job; plan an
upgrade, not a drop-in replacement.

- **Sign-in is mandatory.** v1 had none (it relied on a proxy in front).
  v2 refuses to start unless `LOCAL_ADMIN_USERNAME`,
  `LOCAL_ADMIN_PASSWORD_HASH` and `LOCAL_ADMIN_TOTP_SECRET` are set: run
  `npm run setup-admin` and paste its three lines into `.env`. The identity
  provider (`OIDC_*`) is optional. `TRUST_PROXY=true` is refused at
  start-up: replace it with `TRUSTED_PROXIES` (list every hop) and set
  `PUBLIC_URL` (https behind a proxy).
- **There is now a data directory.** v1 kept nothing. v2 keeps its state in
  `DATA_DIR` (default `./data`; `/data` in the Docker image, a named volume
  `lab-console-data` in `docker-compose.yml`, the root filesystem being
  read-only): the SQLite database `lab-console.db` (accounts, teams,
  sessions, audit trail, settings, jobs, notes…) and files (snapshots,
  templates, console journals, diagram versions). A bind-mounted folder must
  be writable by uid 1000. Back it up: see [docs/DEPLOY.md](docs/DEPLOY.md).
- **The database is created at the first start** and migrated by itself at
  each later start. Files of earlier v2 builds (`auth/*.json`,
  `audit/*.jsonl`) are imported once and renamed `*.imported`. There is
  nothing to import from v1.
- **The diagram.** `diagrams/diagram.drawio` is copied to
  `DATA_DIR/diagrams/current.drawio` on the first start and that copy is the
  active one from then on: replace it from Administration > Diagram (preview,
  versions, rollback). Editing the file on the host no longer changes a
  running platform.
- **Jump server host key.** In production (the Docker image) the key must be
  pinned with `SSH_HOST_FINGERPRINT` or on the lab parameters page, otherwise
  no console connects (`consoles.ssh_unpinned`).
- **Lab parameters** (jump server, console login, allowed consoles) can be
  edited from Administration without a restart; set `APP_SECRET` (32
  characters or more) to store their passwords encrypted.
- **Proxmox tunnel transport.** The tunnel to the Proxmox API still goes
  through the jump server, with `PROXMOX_TUNNEL_TRANSPORT=auto` by default
  (TCP forwarding, then a relay command such as `socat`, `nc` or bash
  `/dev/tcp` when the jump server forbids forwarding; `forward` and `exec`
  force one). The Infra section's virtual machines are now reserved to
  administrators; admin switches stay open to everyone.
- **Names and tags.** The image is `lab-console:2`. Settings of v1 keep their
  meaning; new ones have defaults (see the reference above).

## Try it without the lab

`dev/mock-lab.js` runs a fake SSH jump server whose devices answer like Cisco
IOS and IOS XE consoles (`dev/fakeIos.js`: enable secret, configuration modes,
`show running-config` with its pager, VLANs, erase and reload with a boot and
the initial configuration dialog…). Each console port keeps its device for as
long as the mock lab runs, takes one session at a time like a real console
server, and shows nothing until you press Enter.

```bash
# in .env
SSH_HOST=127.0.0.1
SSH_PORT=2222
npm run mock-lab     # terminal 1
npm start            # terminal 2
```

To try the identity provider as well, `npm run mock-oidc` starts a fake one
on `http://127.0.0.1:9100` with a user picker (three students, one admin) and
prints the `OIDC_*` lines to put in `.env`. Anyone can sign in as anyone
there: it is a development tool, and it refuses to start with
`NODE_ENV=production`. A pre-production Docker stack can use it through
`docker-compose.preprod.yml` (docs/v2/AUTH.md §6; in French, docs/fr/AUTH.md).

`MOCK_DOWN_PORTS=2003` simulates an unplugged console, `MOCK_BUSY_PORTS=2004`
a line held outside the app.
`MOCK_LOGIN_PORTS=2001` simulates a terminal server that shows `login:`
immediately and hangs up on an empty login.
`MOCK_MODELS=2001=2811,2002=c9300l` chooses the model per console port
(default: 2811 for names starting with R, 2960 otherwise),
`MOCK_STATES=2005=linepass,2006=dialog,2007=rommon,2008=silent` the state a
console starts in, `MOCK_ENABLE_SECRET` an enable secret for every device,
`MOCK_TIME_SCALE=0.02` how fast devices boot.
The devices are cabled as the diagram draws them (CDP, line protocol and ping
follow the cables); `MOCK_CABLING=unplug:2016/Fa0/1;move:2016/Fa0/2>Fa0/9`
makes deliberate faults for the cabling check. To try the password recovery,
the person on site is played from a shell:
`ssh -p 2222 <user>@127.0.0.1 mock-power 10.22.9.211 2001` switches the
device off and on (add `mode` to hold a switch's Mode button).

## The diagram

`diagrams/diagram.drawio` is the diagram shipped with the platform; on the
first start it is copied to `DATA_DIR/diagrams/current.drawio`, which is the
active diagram from then on. Each page is a lab. Replace the active diagram
from Administration > Diagram (preview of the changes, versions, rollback);
the platform reloads it within seconds, with no restart.

A shape becomes a clickable device when either:

1. its label contains the console reference, as in the current diagrams:
   `R1` on the first line, `.211 - 2001` on the second
   (→ `CONSOLE_NETWORK_PREFIX.211`, port 2001; a full IP such as
   `10.22.9.211 - 2001` also works), or
2. it carries data (draw.io › right click › *Edit Data*): `console_host` and
   `console_port`. This wins over the label.

Check a diagram before deploying it:

```bash
npm run check-diagram                     # or: npm run check-diagram -- other.drawio
```

It lists every device per lab and flags console lines used by two different
devices (exit code 1). The current file has one: on **B5H, R4 and S1 both
point to `.212 - 2005`**. Devices that appear on several pages with the same
name and console (S5, R5) are treated as shared equipment.

Page names such as `B4H / B4M / B4B` are shown as rack elevations (bay 4,
top/middle/bottom). Any other naming falls back to plain tabs.

## Security model

- **The browser never chooses where to connect.** It sends a device key from
  the diagram; the server looks up host and port in its own copy of the file
  and checks them against `ALLOWED_CONSOLE_HOSTS` and `ALLOWED_PORT_RANGE`.
- **No shell on the jump server.** Each terminal is an SSH `exec` of
  `telnet <host> <port>`; when telnet ends, the SSH channel ends.
- **No `telnet>` escape.** `Ctrl+]` is stripped from student input, so
  telnet's command mode (which can spawn a shell with `!`) is unreachable. The
  *Send BREAK* button is the only server-side use of it.
- **Credentials stay on the server.** Auto-login answers only the first
  Username/Password prompt of a line, once, within 30 s, and stops as soon as
  a device prompt appears. `enable` passwords are never sent.
- **One keyboard per console line.** A line belongs to the server: everyone
  who opens the device joins it and sees the same output, one person types
  (the pilot), the others watch; the keyboard passes on request (the pilot
  answers, or after 30 s, or at once when the pilot has been idle 2 min).
  Keys from a spectator are dropped by the server. Lines close 30 s after the
  last person leaves or after `IDLE_TIMEOUT_MINUTES` without input; per-user
  and global limits, and a rate limit on opening consoles.
- **Console journal.** What the devices print (never keystrokes) is kept
  `JOURNAL_RETENTION_DAYS` days with who held the keyboard, session by
  session. Read access covers the whole day of a console: the people who were
  on it that day, the teams that held its bench that day and admins only.
  Capped per device and day (`JOURNAL_MAX_KB_PER_DAY`) and in all
  (`JOURNAL_MAX_TOTAL_MB`: the oldest days go first).
- **Bench rule on every key.** On a bench a team holds, only its members,
  their accepted guests and admins open or drive its consoles; anyone may
  watch a line already open. The rule is asked again at every keystroke: a
  bench that gets locked takes the keyboard away at once.
- **Group work.** A shared note per device (everyone reads it on the diagram,
  the bench's occupants and admins write it; two people saving at once are
  told, never overwritten); a small text chat per bench for its occupants,
  kept with the team that holds the bench (200 messages, rate-limited); and
  browser notifications, turned on with the bell in the rail, for a request
  for the keyboard, a line that became free and a job that finished, shown
  only while the window is not the one in front.
- **Few SSH connections.** Console lines share connections to the jump
  server, `SSH_CHANNELS_PER_CONNECTION` each (keep it under sshd's
  `MaxSessions`).
- WebSockets accept only the platform's own origin (`ALLOWED_ORIGINS` adds
  more). The UI is fully self-hosted under a strict Content-Security-Policy.
- Set `SSH_HOST_FINGERPRINT` to pin the jump server's identity (or set it on
  the lab parameters page). Under `NODE_ENV=production` (the Docker image) it is
  required: without it no console connects (`consoles.ssh_unpinned`) and the
  log shows the fingerprint the server sees; elsewhere it is only logged.

Recommended on the jump server: a dedicated account that may only run telnet,
for example `ForceCommand` in `sshd_config` or a restricted shell.

**Everything needs a signed-in user**: pages, API, live events and the three
console WebSockets. People sign in through your identity provider (OpenID
Connect: Pocket ID, Authentik, Keycloak, Authelia…), and a local
administrator (password + one-time code) always exists for when the provider
is down. There is no mode without sign-in: the platform refuses to start until
`LOCAL_ADMIN_*` is set (`npm run setup-admin`). Configuration:
[docs/v2/AUTH.md](docs/v2/AUTH.md).

Behind a reverse proxy, list every hop in `TRUSTED_PROXIES` (IP addresses or
CIDR blocks; behind a CDN, its published ranges too) so that client addresses
are read from `X-Forwarded-For`; the header is ignored when it comes from
anyone else. The upstream `TRUST_PROXY=true` is refused at start-up. State is
written to `DATA_DIR` only: structured state (sessions, audit trail,
settings, accounts, teams, benches, reservations…) in an SQLite database,
`DATA_DIR/lab-console.db`; documents (console journals, diagram versions,
configuration snapshots and TP templates) as files. The Docker image runs with a read-only root
filesystem and a volume on `/data`. Files written by earlier v2 builds are
imported into the database at the first start and kept as `*.imported`.

## Teams, accounts and administration (v2)

- **Teams and benches** (Team section, bench bar above the diagram): a
  student creates a team and invites classmates by user name; a member takes
  a free bench for the team; others ask to join; idle benches are released
  after `BENCH_IDLE_HOURS`; admins lock a bench with a reason; per-bench
  reservation calendar with warnings before another team's slot. A team has
  at most `TEAM_MAX_MEMBERS` members (8 by default), unanswered invitations
  included.
- **Accounts**: local accounts created through invitation links (single use,
  or several people with approval), password reset links made by an admin,
  passkeys (required for promoted administrators, one-click sign-in), roles
  and states for local and SSO accounts, My account, SSO settings page.
- **Administration**: lab parameters (jump server, console login, allowed
  consoles) applied without a restart and confirmed again before saving
  (password + code, a passkey, or a fresh sign-in at the identity provider
  that confirms the session for 5 minutes); diagram import with preview,
  versions and rollback; admin switches; sessions; audit viewer (filter by a
  person's name or id);
  announcement banner. **Lab status** for everyone: health of the jump
  server, the console servers, the open lines and shared SSH connections, the
  journals' total, and what is recorded.

## Bench jobs, console tools and group work (v2, wave 3)

- **Sauvegardes** (Backups section, `#/jobs/<bench>`): jobs that cover the
  devices of one bench and run on the server, watched live by everyone and
  cancellable. A **backup** (running-config, VLANs and VTP on switches, model
  and version, five devices at a time) is a snapshot owned by the team that
  held the bench: list, read, diff (two snapshots, or a snapshot against the
  live devices), search, ZIP download and import. The server is not a
  backup: download the ZIP it offers right away. An **injection** shows the
  exact script of each device before it starts ("reset then inject" or
  "merge"), then reads the device back and compares. A **reset** says what
  is erased and who is on the consoles, wants the bench name typed and
  counts down; a device is never erased without a verified backup. Admins
  publish **TP templates** from a backup, by hand or by importing a ZIP (one may be the base configuration applied after
  a reset); the **TP folder** is one ZIP of a snapshot and the console
  journals of its day. Only Cisco IOS / IOS XE is touched. Releasing a bench
  from the bench bar offers its team a backup for 30 minutes. Settings:
  `JOB_DEVICES_AT_ONCE`, `JOB_COUNTDOWN_SECONDS`, `JOB_IMPORT_MAX_KB`,
  `JOB_TIME_SCALE`.
- **Console tools**: a multi-line paste is sent paced, line by line, like an
  injection; **send to several consoles** sends the same lines to every
  console the person pilots and ticks; **history** searches what a console
  printed (its live screen, and the journal days the person may read) and
  downloads it; a **script library** with personal, team and published
  shelves feeds the inject and send dialogs.
- **Group work**: a shared note per device, a chat per bench for its
  occupants, and browser notifications, among them "the job on your bench is
  finished" (see the security model above).

## Checks, password recovery, home page and help (v2, wave 4)

- **Accueil** (`#/home`, the page after sign-in): my team, the invitations
  waiting for me, our bench, our five latest backups, the bench's activity
  since our team took it, our next slots, the lab in numbers, the
  announcement. **Vue d'ensemble** (`#/overview`): one live card per bench
  for everyone (team, occupants, open consoles and pilots, running job, lock,
  next slots, console lines, with the last line status of the checks while
  it is fresh). Both are read-only views of the existing services.
- **Vérifications** (button above the diagram, occupants and admins):
  line status (free, busy outside the app, device silent), cabling (CDP
  against the diagram's links: missing, wrong port, unexpected), a ping
  matrix between the routers, and the addresses and state of the
  interfaces, shown in a report and on the diagram. Read-only commands
  only; a console line someone uses is never touched; one check at a time
  per bench, never during a job; the last result of each kind is kept.
- **Password recovery** (a button on a lab console tile): a guided BREAK /
  ROMMON / configuration register procedure (or the switch's boot loader)
  for a device locked by a password nobody knows, with someone on site to
  power-cycle it. The startup-config is only bypassed for one boot, never
  erased; any stop puts the device back first. Not yet tried on the real
  equipment, and the browser says so.
- **Aide** (`#/help`): what each section does, in French and English, and a
  guided tour at the first sign-in (replayable from the user menu).
- Settings: none of their own; the device budgets of the checks and of the
  recovery follow `JOB_TIME_SCALE`.

## Console tools (v1.1)

Every text console tile has two extra buttons in its header:

| Button | Where | What it does |
|---|---|---|
| **Export config** (download icon) | lab devices and admin switches | Saves `show running-config` as `<hostname>_running-config_<date>.txt` |
| **Inject script** (script icon) | lab devices, admin switches, VM serial consoles | Sends a list of commands, pasted or loaded from a `.txt` file, line by line |

Both run **on the server**, right next to the SSH → telnet stream
(`src/lib/cliAutomation.js`). Browsers slow timers in background tabs to about
one per second, so pacing done in the browser would break as soon as you
switched tabs. While a task runs, the tile shows its progress and a **Stop**
button, and your own keystrokes are held back so they can't mix with the
automated commands.

**Export config** (Cisco):
1. Presses Enter to read the prompt and the hostname.
2. Leaves configuration mode with `end` if needed.
3. Stops if the device is in user mode (`R1>`) and asks you to `enable` first.
4. Sends `terminal length 0`, then captures `show running-config` until `R1#` comes back.
5. Restores `terminal length 24`.

If a device ignores `terminal length`, each `--More--` is answered with a space
instead. Syslog lines that appear during the capture are removed.

**Inject script**:
- One command per line, sent like a careful human would type them:
  - each line is typed in 32-byte chunks, so even a long `description` never
    overflows a small console input buffer;
  - the next line waits for the device's prompt, or a question such as
    `[confirm]` or `Destination filename [startup-config]?`;
  - then a configurable delay (default 50 ms).
- Blank lines are sent as Enter, which is how a script answers those questions.
- Multi-line `banner motd #…#` blocks are handled.
- Lines starting with `!` are skipped (optional).
- Device errors (`% Invalid input…`) are listed with their script line numbers.
  The script can optionally stop at the first one.

To see why pacing matters, run the mock lab with `MOCK_SLOW_CONSOLE=1`. It
simulates an old device: about 1 character per ms, a 64-byte input buffer, and
40 ms per command. The unit tests show a plain paste of a 60-line script
losing over 1,000 characters, while the paced injection gets every line
through intact.

## Bulk VM power (v1.1)

In **Infra › Virtual machines**:
- Tick VMs, or use the header checkbox to select every VM shown (the filter applies).
- **Start selected** starts the stopped ones; **Stop selected** shuts down the
  running ones (graceful ACPI shutdown, after a confirmation).
- Requests go 4 at a time, and progress appears in the job list.
- The selection survives the automatic refresh.

## Infrastructure section

The **Infra** entry in the sidebar is open to everyone, like the lab consoles.

- **Virtual machines** (administrators only: everybody else sees that the tab
  is reserved, and the API and both VM consoles answer them 403): every Proxmox VM, with:
  - **Start / Stop / Force stop** (Stop asks the guest to shut down; Force stop cuts the power);
  - **Serial** (text console in xterm.js, for VMs with a serial port) and **VNC** (graphical console);
  - the **VLAN tag of net0**: type a number and press Enter, or leave empty for untagged.
    The MAC address and the other NIC options are kept;
  - **Clone template**: template, name, node, VLAN. A full clone, with progress shown live.
- **Admin switches**: the switches from `config/infrastructure.json`, or the
  list an administrator edited (kept in the database). Their consoles go
  through the same jump server → telnet chain as the lab devices.

All consoles share one workspace, so an admin switch and a VM screen can be
side by side, and they stay open when you switch sections.

### How Proxmox is reached: through the jump server

```
platform ──SSH──► jump server ──direct-tcpip──► 10.22.9.20:8006 (Proxmox)
           shared connection(s), one lightweight channel per HTTPS socket / console
```

- The platform keeps a shared SSH connection to the jump server for Proxmox
  (`src/lib/sshTunnel.js`). Every HTTPS request and every console WebSocket is an
  SSH channel on it, with TLS end-to-end to Proxmox inside.
- HTTPS sockets are kept alive, and at most 6 API requests run at once, so
  listing 20 VMs reuses a handful of channels.
- If the jump server drops the connection, it is re-opened on the next call.

**Two transports (`PROXMOX_TUNNEL_TRANSPORT`, default `auto`).** How the tunnel
crosses the jump server — the device consoles are unaffected either way:

- `forward` — a `direct-tcpip` channel (`ssh -L`-style). Lightest; one
  connection carries everything. Needs `AllowTcpForwarding` on the jump server.
- `exec` — the jump server runs a relay (`socat`/`nc`/bash `/dev/tcp`) that
  connects to Proxmox, and the platform speaks TLS over its stdio. This is the
  **same** mechanism the device consoles use, so it works even when forwarding
  is turned off. Each relay is a *session* channel, so these count against
  sshd's `MaxSessions`; the pool spreads bursts over a few connections.
- `auto` (default) — try `forward`, and the first time the jump server answers
  *administratively prohibited / open failed*, switch to `exec` for the rest of
  the run and log it once. Zero-config survival of a locked-down jump server.

If forwarding is allowed, restrict it to Proxmox only:
  ```
  Match User labjump
      PermitOpen 10.22.9.20:8006
  ```
**Troubleshooting `open failed` / `administratively prohibited`:** the jump
server's sshd forbids TCP forwarding for that account (`AllowTcpForwarding no`,
`DisableForwarding`, a mismatched `PermitOpen`, or `restrict` /
`no-port-forwarding` in `authorized_keys`). A `curl -k` *from* the jump box
still works because that originates on the box itself. Either re-enable
forwarding for the account, or leave `PROXMOX_TUNNEL_TRANSPORT=auto` (or set
`exec`) and the platform relays through a command instead, needing only
`socat`, `nc`/`ncat`, or bash on the jump server. After changing jump-server
sshd config, **restart Lab Console** so the tunnel reconnects with the new policy.
- Authentication is a username/password **ticket**, renewed before Proxmox's
  2-hour expiry and again on any 401. No Proxmox credential, ticket or VNC
  password reaches the browser:
  - for **VNC**, the platform does the VNC password exchange with Proxmox itself;
  - for **Serial**, it translates Proxmox's `termproxy` protocol to the platform's own.

### Serial consoles

A VM needs a serial port for **Serial**: `qm set <vmid> -serial0 socket`, and
in a Linux guest `systemctl enable --now serial-getty@ttyS0`. Add the port to
your templates so every clone has it. **VNC** works on every VM.

### Try it without Proxmox

```bash
npm run mock-lab       # fake jump server; also forwards 10.22.9.20:8006 to the mock Proxmox
npm run mock-proxmox   # fake Proxmox on 127.0.0.1:8006; prints PROXMOX_FINGERPRINT=…
```

In `.env`, set `PROXMOX_URL=https://10.22.9.20:8006` (yes, the lab address)
and the printed fingerprint. The mock jump server is the only way to that
address, exactly like in the lab.

## Project layout

```
src/
  server.js                 HTTP + WebSocket entry, mounts modules
  config.js                 .env loading and validation
  lib/                      logger, SSE hub, security helpers, SSH options + shared SSH tunnel,
                            CLI automation (config export, paced script injection), settings, diagrams
  lib/db/                   the database: SQLite adapter, migrations, repositories, import of older files
  lib/drivers/ciscoIos.js   Cisco IOS / IOS XE procedures: prepare, identify, backup,
                            erase and reload, replay script
  lib/drivers/ciscoRecovery.js  password recovery procedures per device family
  modules/
    index.js                module registry
    auth/                   sign-in: sessions, OpenID Connect, local administrator + TOTP
    consoles/               lab consoles: diagram parser, registry, shared rooms, journal, SSH pool
    teams/                  teams, bench occupancy, locks, reservations
    accounts/               directory, invitations, reset links, passkeys, SSO settings
    admin/                  lab parameters, confirmation, health, announcements
    jobs/                   bench jobs (backup, injection, reset, compare), snapshots, TP templates
    scripts/                shared script library (personal, team, published)
    collab/                 device notes, bench chat
    checks/                 line status, cabling (CDP), ping matrix, interfaces (migration 015)
    recovery/               guided password recovery (migration 016)
    overview/               home page and overview of every bench (read only, no table)
    help/                   guided tour, help page, tour progress (migration 017)
    proxmox/                Proxmox client (ticket auth, over the SSH tunnel), service, console proxies
public/
  index.html, css/app.css
  js/main.js                shell: sidebar, routing, theme
  js/core/                  DOM helpers, API + live events
  js/modules/consoles/      diagram renderer, terminal workspace, lab picker, finder
  js/shared/                workspace (shared by all sections), terminal + VNC panes, split layout
  js/modules/infra/         Infrastructure section: VMs, network dialog, admin switches
  js/modules/jobs/          Sauvegardes section: jobs, snapshots, templates, the diagram layer
  js/modules/collab/        device notes, bench chat panel, browser notifications
  js/modules/checks/        checks dialog and the diagram layers (line badges, cabling, addresses)
  js/modules/recovery/      the recovery assistant (console tile button) and its diagram badge
  js/modules/overview/      Accueil and Vue d'ensemble sections
  js/modules/help/          guided tour and the Help section
scripts/check-diagram.js    diagram linter
scripts/gen-config-doc.js   builds docs/CONFIGURATION.md from .env.example
docs/                       DEPLOY, STUDENTS, CONFIGURATION (generated), fr/ (French), v2/ (architecture, spec, tests)
dev/mock-lab.js             fake jump server (telnet, line probe, port forwarding); importable
dev/fakeIos.js              simulated Cisco IOS / IOS XE (four families, boot, erase, VLANs, slow console,
                            power cycle, BREAK, ROMMON and boot loader)
dev/mockCabling.js          the mock lab's cables, from the diagram's links
dev/mock-proxmox.js         fake Proxmox VE (HTTPS, API, serial + VNC consoles)
config/infrastructure.json  admin switches
test/                       node:test unit tests (npm test)
```

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl K` or `/` (outside a terminal) | Find a device in any lab |
| `Tab`, then `Enter` on the diagram | Open the focused device |
| `Ctrl Shift C` in a terminal | Copy the selection |
| `Ctrl V` in a terminal | Paste |
