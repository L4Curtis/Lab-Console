# Changelog

**English** · [Français](CHANGELOG.fr.md)

## 2.3.0 - 2026-11-15

The redesign of 2.2.0 (bottom tab bar on a phone, the five destinations and
Plus, the new components) now comes with **mandatory passkeys for every local
account**. The passkey steps of sign-up, sign-in and reset links are drawn
with the redesign's login frame, on a phone and on a PC. It also carries the
fixes that came out of using the redesign on a phone and a laptop (below,
"Fixed").

### Changed

- **Every local account signs in with a passkey**, students included (only
  administrators made from a local account needed one). The passkey is
  registered as part of the sign-up through an invitation, before any
  session; a local account that has none yet (every student account made
  before this version) types its password at its next sign-in, then
  registers one before reaching the application. Once it has one, its
  password alone no longer opens a session: one click on **Sign in with a
  passkey**, or the password then the passkey. The last passkey of an
  account cannot be removed from My account. SSO accounts and the server's
  administrator (password + code) are unchanged. No migration: accounts are
  asked at their next sign-in, and their open sessions run to their end.
- **A password reset link also replaces the passkeys.** Using it sets the
  new password, removes the account's passkeys and ends its sessions; the
  person then registers a new passkey before the first session (a lost
  phone is the usual reason to ask for a link).
- **Local accounts need https.** Where `PUBLIC_URL` is not https on a
  domain name (or `http://localhost`), local accounts can neither be
  created nor sign in, and the pages and the API say so
  (`accounts.passkeys_unavailable`) instead of falling back to passwords;
  invitations and reset links are refused there. The server's
  administrator still signs in. See [AUTH.md](docs/v2/AUTH.md) §2b and
  [DEPLOY.md](docs/DEPLOY.md) ("Local accounts and passkeys").
- **The passkey steps look like the rest of the redesign.** The sign-in,
  sign-up and reset link pages keep their card on a PC and their full-width
  phone layout for the passkey: a heading, one sentence, one large button.
  What went well (account created, password saved, waiting for approval) is
  a green notice; a browser without passkeys or a site without https gets
  "Passkeys are not available here" instead of "This link does not work".
  Admin › Invitations says why no link can be made without https and
  disables **New invitation**.
- Passkey requests are limited per address with room for a classroom behind
  one public address (300 one-click and 240 step requests a minute), and up
  to 100 sign-ins of one address may wait for their passkey at once.

### Fixed

- **Turning the phone keeps the console.** A touch screen shorter than 500 px
  is compact whatever its width: the console keeps the whole screen (no tab
  bar, a slimmer head, key bar and field), turning back and forth or loading
  its address on its side shows it again, and the bench screen has no journal
  notice there.
- **Consoles and Réservations open on your team's bench**, then the last one
  used, then the first. A bench detail says where the team already sits
  (`you.teamBench`) and no longer offers to take another: the strip and the
  Baie tab say **Aller à B4M** instead of a button the server refuses.
- **A phone opens the bench as a list**, not a diagram that runs off the
  screen; the diagram stays one tap away and is remembered once chosen.
  Beside open consoles, a diagram column under 400 px shows the list too. The journal notice shows
  once per browser, with a short sentence on a phone.
- **The IOS keys most used come first** (Tab, ?, Ctrl, ^C, ^Z, the history
  arrows) and the ones after the swipe say a word (Break, Espace, Coller,
  Clavier). One **Demander la main**, not two; the pilot reads "Sans réponse,
  la main passe à Zoé dans 28 s" on its own line; the chips row and the
  turn-your-phone line leave while the keyboard is open.
- **Admin › Utilisateurs fits a 1280 px laptop**: the sign-in columns give
  way up to 1359 px (what they held is under the name), so Valider is never
  behind a sideways scroll. Machines et switchs, État du labo and Toutes les
  équipes put their tabs in the content column beside the administration
  list instead of stacking two navigations.
- **Réservations**: today's hours already over fold into one line, the hour
  in progress is not offered (the server refuses it), the start is a list of
  24 h times that are still free, and the week button says Aujourd'hui.
- **Libérer la baie** is a danger button in the bench's card (it was a big
  blue button that pushed the tabs down) with a danger confirmation; button
  rows start at the card's content edge; the bench strip's state word is
  never cut ("Libre", "Prise par vous").
- **The guided tour** puts its card on the half of a phone's screen the
  target is not in, rings the heading on its first step and ends on the page
  it began on.
- **Accueil and Équipe**: an invited student has one blue button (Rejoindre,
  Accepter); the lab list of a phone is 58 px rows with a chevron. The login
  page puts the method this browser used last first, and says that an account
  made by invitation uses its passkey.
- **Administration**: the audit trail says "Connexion", "Schéma refusé"…
  with the code beneath, dates on one line and no empty Baie column; a
  diagram refusal is a notice with an icon and no developer command; the
  invitation form's button is **Créer le lien**; a lab value nobody changed
  has no "environnement" pill; a student is told "Proxmox n'est pas
  disponible pour le moment", not to edit `.env`; **Mur de consoles** no
  longer says no console is open while some are.
- `npm run check-diagram` prints the parser's warnings (it printed
  `[object Object]` and crashed) and exits 1 on the blocking one.

## 2.2.0 - 2026-11-15

A redesign of the interface for the phone, the tablet and the PC
([UX.md](docs/v2/UX.md)). The colours stay (console blue, light and dark
themes); the layout, the navigation and the components are new.

- **Navigation.** Five destinations: Accueil, Consoles, Équipe, Sauvegardes
  and, for administrators, Admin. Everything else is under **Plus**:
  Machines et switchs, État du labo, Aide, Mon compte, alerts, theme,
  language, the tour and sign-out. On a phone they are a bottom tab bar
  (four entries and Plus), on a PC a rail. Old addresses keep working
  (`#/overview` leads to Accueil's "Le labo").
- **Consoles.** A one-line header (bench picker, finder, En direct,
  Discussion, an Outils menu); the diagram takes the page. Console tiles have
  a slim header with the people on the console and a ⋯ menu that holds every
  action. On a phone: a device list, pinch and pan on the diagram, and a
  full-screen console (`#/consoles/<bench>/<device>`) with a key bar (Esc,
  Tab, Ctrl, arrows, ?, ^C…) and a line mode for whole commands.
- **The bench strip.** One line saying who holds the bench, with the one
  button that matters now and the rest in ⋯; a tap opens the bench as a
  sheet on a phone.
- **Équipe.** Tabs Mon équipe, **Baie** (new: the state of the bench, its
  requests, occupants and history), Réservations (a day agenda on a phone)
  and, for administrators, Toutes les équipes.
- **Sauvegardes.** Back up, inject or compare from the header; a progress
  card for the running job; backups, TP templates and jobs as lists that
  become cards on a phone.
- **Accueil** starts with what needs you (requests, invitations, a bench about
  to be released) and absorbs the former Vue d'ensemble as "Le labo".
- **Admin** groups its screens (Comptes, Labo, Suivi): a list at the left on
  a PC, a hub on a phone. Aide, Mon compte and the sign-in pages are
  rewritten for the phone too.
- Shared components: page header, lists that become cards on a phone,
  dialogs that become bottom sheets, menus, side panels; 44 px touch targets,
  12 px text at least, AA contrast in both themes.
- Fixed: the word "null" printed in the injection preview and in some list
  headers.

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
