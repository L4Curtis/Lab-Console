# Lab Console: ergonomics redesign (design spec)

Status: step 1 of the redesign, written 15 Nov 2026 from an audit of v2.1.0.
This is the document the implementers follow. Where it says **must**, the
reviewer checks it. Where it leaves a choice, it says so.

It does not change the rules of [ARCHITECTURE.md](ARCHITECTURE.md): plain ES
modules, no build step, no front-end framework, relative imports, asset
addresses built from `import.meta.url`, every visible string through `t()` with
`fr` and `en` entries (French is the reference wording), no user data in
`innerHTML`, dialogs only through `shared/dialog.js`.

Contents

1. What the owner asked for
2. Audit: what fails today
3. Principles
4. Information architecture and routes
5. Navigation shell and page header
6. Design tokens
7. Components
8. The Consoles page
9. The terminal on a phone
10. The other screens
11. Implementation plan: shell, then three parts in parallel
12. Acceptance checks
13. Using the components (as delivered by the shell)

---

## 1. What the owner asked for

The owner is a networking student who uses the application daily with his
class. His answers (15 Nov):

- On the phone he does **everything**: watch consoles, type in consoles, manage
  the team and the bench, backups, administration.
- Phone navigation: a **bottom tab bar** with 4 or 5 main entries and **Plus**.
- On the PC: too many sections (9 rail entries); the Consoles page is
  overloaded (diagram, bench bar, buttons, terminals and notices fight for the
  screen); the general look is a raw tool: weak hierarchy, spacing,
  consistency.
- Visual direction: a modern redesign that **keeps the base colours** (console
  blue, light and dark themes).

## 2. Audit: what fails today

Audited on v2.1.0 (`0f9d5d3`) with the e2e harness (mock lab, mock OIDC), as a
student with a team on a taken bench (B4M, consoles open, a backup running,
the journal notice, an announcement, a join request on B5B) and as an
administrator, at 390×844 (Chromium phone emulation, touch), 768×1024 (touch)
and 1440×900, light and dark. Screenshots are kept outside the repository
(`/srv/lab-console-dev/tmp/ux/shots/<size>-<theme>-<scene>.png`), not
committed. Counts below come from measuring every visible control.

### 2.1 Navigation

- **Nine sections in the rail**, plus FR/EN, Alertes, Thème and the account
  badge: 13 controls. Accueil and Vue d'ensemble overlap (both show benches);
  Infra and État du labo are rarely used by students; Administration sits in
  the middle of student sections.
- **Phone**: the rail becomes a bottom bar that **scrolls sideways** with all
  13 controls. Only Accueil to Infra are visible; Sauvegardes is cut in half;
  Aide, Alertes, Thème, language and the account are off-screen. Labels wrap
  on two lines ("Vue d'ensemble"). No safe-area inset.
- **The account menu on a phone opens partly off-screen**: only "Se
  déconnecter" is visible (`phone-light-usermenu.png`).
- Rail labels are 11 px on two lines at 72 px wide; the active state is a
  3 px strip.
- **On a phone, a section taller than the screen loses its top and cannot be
  scrolled.** The app is a `column-reverse` flex box (bar at the bottom) and
  `.views` has no `min-height: 0` and no scroll container, so the overflow
  goes upwards, out of reach: the Aide heading sits at −11 795 px, Accueil
  with a team shows only its last cards, Sauvegardes and Administration ›
  Paramètres du labo start in the middle (`phone-light-home.png`,
  `phone-light-help.png`, `phone-light-jobs.png`, `phone-light-admin-lab.png`).
- Tablet (768 px): the rail keeps the 72 px desktop look with labels cut
  ("Sauvegard…") and 28–30 px targets on a touch screen.

### 2.2 The Consoles page

Desktop (`desktop-light-consoles.png`, `desktop-light-consoles-one-open.png`):

- **Four horizontal bands of chrome before the diagram** (about 300 px at
  900 px high): announcement, header with the rack picker and four buttons,
  bench bar with five actions and a status line, then a canvas heading that
  repeats the bench name in 34 px with three more buttons.
- **The journal notice floats over the diagram** (bottom), covering devices
  and links, and stays there until dismissed.
- **Side panels (En direct, Notes et discussion) cover the diagram** instead
  of sitting beside it.
- **Console tiles**: the head carries 8 icon-only actions (break, export,
  inject, broadcast, history, note, recovery, maximize) and a "Journalisée"
  pill; the presence row adds three more buttons ("Partager le clavier",
  "Rendre la main", "Libérer la ligne") even when nobody else is there. About
  80 px of chrome per tile.
- **A running backup is almost invisible here**: tiny badges on the devices,
  nothing in the bench bar (`desktop-light-consoles-job-running.png`).
- Ten different button styles on one screen (find-btn, btn.small, subtle,
  rack slots, icon buttons, notes button, live button…).
- Dark theme: device tiles barely stand out from the canvas
  (`desktop-dark-consoles-one-open.png`); surfaces, cards and background are
  within a few percent of each other (the phone's bottom bar `#0D141A` on the
  page `#121A22` is 1.1:1), so nothing has hierarchy
  (`phone-dark-consoles.png`).

Phone (`phone-light-consoles.png`, `phone-light-consoles-one-open.png`):

- **The diagram is drawn at 9–12 %** in a 390 × 274 px canvas: devices are
  dots, labels unreadable, nothing can be tapped reliably. It only pans with
  one finger; no pinch. Same at 768 px (`tablet-light-consoles-one-open.png`).
- Chrome takes **the first 1100 of 1688 device pixels**: header buttons on two
  rows, the rack picker, the bench bar (four rows), the journal notice, the
  bench name and three buttons.
- **An open console gets three rows** (a 374 × 177 px tile under the
  diagram), half hidden by the zoom controls. There is no way to type
  comfortably: no Tab, Ctrl, Esc or arrows, and the phone keyboard covers the
  terminal.
- The En direct and Notes et discussion panels open as a **~120 px tall box**
  over the diagram (`phone-light-consoles-live-panel.png`).
- A presence avatar ("S1") is drawn detached from its device at the left edge,
  and the diagram-remarks button ("4 remarques sur le schéma") loses its label
  under 900 px and shows as an empty white pill at the bottom right.
- 36 to 79 visible controls under 44 px on this screen (rack slots are
  64×22 px).

### 2.3 Density, hierarchy, consistency

- Page titles are 17 px, the same weight as card titles; subtitles 12.5 px.
  Nothing tells the eye where to start.
- Accueil, "Notre baie": ten rows "personne n'a la main / 0 personne", one per
  device, push the useful cards below the fold (`desktop-light-home.png`).
- Content widths differ per section (1100, 1280, 760, full width) and are
  left-aligned, leaving a blank band on the right at 1440 px.
- Buttons are 28–30 px high everywhere, also on touch screens; 40 % of the
  home page's buttons are under 44 px on a phone.
- Status chips on the home page ("5 libres", "2 prises") look like buttons but
  do nothing.
- Labels end with "…" ("Injecter…", "Réinitialiser…"), some are vague ("Mur de
  la baie", "Infra", "Dossier de TP"), some speak of clicking on a phone
  ("Cliquez sur une heure libre").

### 2.4 Tables and dialogs on a phone

- **Sauvegardes overflows sideways**: the backup table, its six row buttons,
  the search field and the post-backup callout are cut at the right edge
  (`phone-light-jobs.png`).
- Administration › Utilisateurs keeps two of six columns; state, keys, last
  sign-in and actions are out of reach (`phone-light-admin-users.png`). The
  nine admin tabs scroll sideways in a segmented control.
- Réservations: a seven-day grid at 390 px, scrolled sideways, with 08:00–19:00
  rows (`phone-light-team-calendar.png`).
- Journal dialog: a five-column table where each date wraps on three lines
  (`phone-light-consoles-journal.png`).
- Dialogs are centred cards with small buttons; long ones (backup device list)
  scroll inside a card that leaves the action buttons near the top of the
  thumb zone only by luck.
- Help: the keyboard shortcut table is shown on a phone, one word per line.

### 2.5 What works and stays

- The colour identity (console blue, port-LED status colours, dark terminals),
  IBM Plex, AA contrast (checked by `test/e2e/ui-layout.e2e.js`).
- Hash routes, sections that stay mounted (open consoles survive navigation),
  the shared workspace, the diagram decoration layers, pane actions, the
  loading / failure states of `shared/loadState.js`, the dialog helpers.
- The login page (`phone-light-login.png`) is already clean.

## 3. Principles

1. **One primary action per screen**, visually distinct; everything else is
   secondary, in a menu, or one level down.
2. **Content before chrome**: on the Consoles page the diagram and the
   terminals own the screen; status is a single line; tools are in a menu.
3. **Phone first for students' daily tasks** (open a console and type, take or
   release the bench, back up, answer a request), PC first for administration,
   but every task works on both.
4. **Touch targets of 44 × 44 px minimum** on any coarse pointer, whatever the
   width.
5. **Nothing overlays content unless the user asked** (a menu, a dialog, a
   sheet). Notices push content down and can be dismissed.
6. **The address tells where you are**: every screen, tab, console and sheet
   that matters has a hash route; Back works.
7. **One component per job**, shared from `public/js/shared` and
   `public/css`: one button, one card, one list, one menu, one sheet.

## 4. Information architecture and routes

### 4.1 Destinations

Five main destinations at most, plus **Plus**:

| destination | route | who | absorbs |
|---|---|---|---|
| **Accueil** | `#/home` | everyone | Vue d'ensemble (`#/overview`): "Le labo", every bench, is a section of Accueil |
| **Consoles** | `#/consoles/<bench>[/<device>]` | everyone | unchanged; `/<device>` is new (console in focus, full screen on a phone) |
| **Équipe** | `#/team/<tab>` | everyone | Mon équipe, **Baie** (new tab: what the bench bar does, in full), Réservations, Toutes les équipes (admins) |
| **Sauvegardes** | `#/jobs/<bench>[/<action>]` | everyone | unchanged content: backups, injection, comparison, reset, snapshots, templates, recent jobs |
| **Admin** | `#/admin/<tab>` | admins | its nine tabs, grouped (4.3), plus links to Machines et switchs (`#/infra`) and État du labo (`#/status`) |
| **Plus** | sheet / menu, no route of its own | everyone | Machines et switchs (`#/infra`), État du labo (`#/status`), Aide (`#/help`), Mon compte (`#/account`), Alertes, Thème, Langue, Revoir la visite guidée, Se déconnecter; Admin for admins on a phone |

Renamed entries (French reference, `en` in brackets):

- "Infra" → **Machines et switchs** (Machines and switches).
- "Vue d'ensemble" disappears as a section; its content is **Le labo**
  (The lab) on Accueil.
- "Mur de la baie" → **Mur de consoles** (Console wall).
- "Administration" keeps its page title; its navigation label is **Admin**.

### 4.2 Old addresses keep working

`main.js` keeps a redirect table applied before routing, with
`history.replaceState` (no extra history entry):

| old | new |
|---|---|
| `#/overview` | `#/home/lab` |
| `#/overview/<filter>` | `#/home/lab/<filter>` |
| `#/team` | `#/team/mine` |
| `#/admin` (phone) | stays `#/admin`: shows the Admin hub list (4.3) |
| `#/admin` (≥ 720 px) | `#/admin/users` |
| `#/status`, `#/infra` | unchanged |
| `#/jobs`, `#/jobs/<bench>/<action>` | unchanged |

`#/home/lab` scrolls Accueil to "Le labo" and focuses its heading;
`#/home/lab/<filter>` also selects the filter: `all`, `free`, `mine` (the
filters `modules/overview/index.js` has today) and the new `taken`, `locked`.
`#/consoles/<bench>/<device>` opens (or focuses) that device's console; on a
phone it is the full-screen console screen (8.3), and Back returns to
`#/consoles/<bench>`.
`#/team/bench` is the new Baie tab; `#/team/bench/<bench>` shows another bench
(read-only unless you may act on it).

A unit test (`test/navRoutes.test.js`) covers every row of this table. The
table is a pure function, `routeRedirect(hash, { isAdmin, compact })`, in
`public/js/core/routes.js`, a module with no import and no DOM access so that
`node:test` can load it.

### 4.3 The Admin area

The nine tabs are grouped. Desktop: a secondary vertical list (220 px) at the
left of the Admin page. Phone: `#/admin` is a hub list; each row opens the tab
full screen with a back arrow to the hub.

| group | entries (route) |
|---|---|
| **Comptes** (Accounts) | Utilisateurs (`users`), Invitations (`invitations`), Connexion SSO (`sso`), Équipes (`#/team/all`) |
| **Labo** (Lab) | Paramètres du labo (`lab`), Schéma (`diagram`), Switchs d'admin (`switches`), Machines et switchs (`#/infra`), État du labo (`#/status`) |
| **Suivi** (Monitoring) | Sessions (`sessions`), Journal d'audit (`audit`), Annonce (`announcement`) |

For an administrator, `#/infra`, `#/status` and `#/team/all` light **Admin** in
the navigation and show the Admin secondary list (desktop) or a back arrow to
the hub (phone). For a student, `#/infra` and `#/status` light **Plus**.

### 4.4 Module table in `main.js`

`MODULES` keeps its shape and gains navigation fields. Sections never add
themselves to the navigation; the shell reads this table:

```js
{ id: 'overview', path: 'home', titleKey: 'common.shell.home', icon: 'home', nav: 'main', order: 10, load },
{ id: 'consoles', path: 'consoles', titleKey: 'common.shell.consoles', icon: 'topology', nav: 'main', order: 20, load },
{ id: 'teams', path: 'team', titleKey: 'common.shell.team', icon: 'team', nav: 'main', order: 30, load },
{ id: 'jobs', path: 'jobs', titleKey: 'common.shell.jobs', icon: 'archive', nav: 'main', order: 40, load },
{ id: 'accounts', path: 'admin', titleKey: 'common.shell.admin', navKey: 'common.shell.adminShort', icon: 'shield', nav: 'main', order: 50, when: isAdmin, load },
{ id: 'proxmox', path: 'infra', titleKey: 'common.shell.infra', icon: 'rack', nav: 'plus', parent: () => (session.isAdmin ? 'admin' : 'plus'), load },
{ id: 'admin', path: 'status', titleKey: 'common.shell.status', icon: 'pulse', nav: 'plus', parent: () => (session.isAdmin ? 'admin' : 'plus'), load },
{ id: 'help', path: 'help', titleKey: 'common.shell.help', icon: 'help', nav: 'plus', load },
{ id: 'accounts', path: 'account', titleKey: 'common.shell.account', icon: 'user', nav: 'plus', load },
```

`nav: 'main'` entries appear in the rail and the tab bar; on a phone, an entry
with `order` above 40 (Admin) moves into Plus so the tab bar keeps four entries
plus Plus. `parent` names the destination lit for a section reached from
elsewhere. The Vue d'ensemble module entry is removed; its code moves into
Accueil (part C).

## 5. Navigation shell and page header

### 5.1 Breakpoints

| name | width | navigation | content |
|---|---|---|---|
| **compact** | < 720 px | bottom tab bar | one column, gutter 16 px; dialogs are bottom sheets |
| **medium** | 720–1199 px | rail, collapsed (72 px, icon + short label under it) | gutter 24 px; two columns where useful; centred dialogs |
| **expanded** | ≥ 1200 px | rail, expanded (232 px, icon + label on one line), collapsible to 72 px | gutter 32 px; content max width 1280 px, **centred** (Consoles: full width) |

Independently of width, `@media (pointer: coarse)` raises every interactive
element to 44 px (the `--tap` token, 6.6). A landscape phone (a touch screen
shorter than 500 px, whatever its width) **is compact**: the same screens as
upright, a 48 px tab bar, no journal notice, a slimmer console screen (head,
keys and field), and no tab bar while a console is full screen. Turning the
phone never leaves the console screen: the address still names the console.

Breakpoints are CSS media queries in `tokens.css` comments and the same
numbers in `core/viewport.js` (`isCompact()`: width under 720 px, or touch and shorter than 500 px): JavaScript
only reads them to choose between a popover and a sheet, never to lay out.

### 5.2 Desktop and tablet: the rail

```
┌──────────────────────┐
│ [>_] Lab Console  [«]│  brand (link to #/home) and collapse button
│                      │
│ ⌂  Accueil           │  main destinations, 44 px rows, 8 px radius
│ ⑂  Consoles      ●   │  ● = a console of mine is open (green LED dot)
│ ⚇  Équipe        2   │  count badge = requests / invitations waiting for me
│ ▤  Sauvegardes   ◔   │  ◔ = a job of my team is running
│ ⛉  Admin         1   │  admins: accounts waiting for validation
│ ⋯  Plus              │  opens the Plus menu (popover to the right)
│                      │
│        (space)       │
│                      │
│ 🔔 Alertes       3   │  the collab notification bell, unread count
│ (AM) Alice Martin    │  account button: opens the account menu
└──────────────────────┘
```

- Background `--nav-bg` (dark navy in both themes, as today), text
  `--nav-ink`; active row: `--nav-active-bg`, white text, 3 px accent bar on
  the left edge; hover `--nav-hover-bg`.
- Expanded 232 px; collapsed 72 px shows the icon and a short label under it
  (12 px, one line, ellipsis; `navKey` gives the short form). The choice is
  stored with `prefs` (`labconsole.rail`, `'expanded' | 'collapsed'`); medium
  width is always collapsed and the toggle is hidden.
- Collapsed rows have a tooltip with the full name; badges become a dot at the
  icon's top right.
- **Plus** (desktop): a popover menu anchored to the row, listing Machines et
  switchs, État du labo and Aide. Admins see the same three entries (Machines
  et switchs and État du labo are also in the Admin list, 4.3).
- **Account menu** (desktop): popover anchored to the account button: name,
  role, how signed in; Mon compte; **Thème** segmented control Clair / Sombre /
  Auto (Auto follows `prefers-color-scheme`; new); **Langue** segmented control
  FR / EN; Revoir la visite guidée; Se déconnecter. The FR/EN buttons and the
  theme button leave the rail.

### 5.3 Phone: the bottom tab bar and Plus

```
┌─────────────────────────────────────────────┐
│  ⌂        ⑂        ⚇         ▤        ⋯     │  56 px + env(safe-area-inset-bottom)
│Accueil Consoles  Équipe  Sauvegardes  Plus  │  12 px labels, one line
└─────────────────────────────────────────────┘
```

- Exactly five items: Accueil, Consoles, Équipe, Sauvegardes, Plus. Each item
  is 1/5 of the width, 56 px high, icon 24 px over a 12 px label; the active
  item has a 64 × 32 px `--nav-active-bg` pill behind its icon, the icon in
  `--accent` (dark value `#5BA9E0` in both themes, on the dark bar) and a white
  label; inactive items use `--nav-ink`. Badges as on the rail. The
  Plus item shows a dot when Alertes has unread items or, for admins, when
  accounts wait.
- `padding-bottom: env(safe-area-inset-bottom)`; the page needs
  `viewport-fit=cover` in the viewport meta (5.6).
- It never scrolls sideways. It hides while a console is full screen and while
  the virtual keyboard is open (5.6).
- **Plus** opens a bottom sheet (`#/…` unchanged; Back closes it):

```
┌─────────────────────────────────────────────┐
│ ───                                         │  handle
│ (AM) Alice Martin                           │
│      Étudiante · connectée avec Mock SSO    │
├─────────────────────────────────────────────┤
│ ⛉  Admin                               1 › │  admins only
│ 🔔 Alertes                             3 › │  opens the notifications list in the sheet
│ ▦  Machines et switchs                   › │
│ ∿  État du labo                          › │
│ ?  Aide                                  › │
│ ☺  Mon compte                            › │
├─────────────────────────────────────────────┤
│ Thème    [ Clair | Sombre | Auto ]          │
│ Langue   [   FR   |   EN   ]                │
├─────────────────────────────────────────────┤
│ Revoir la visite guidée                     │
│ Se déconnecter                              │  danger-ink text
└─────────────────────────────────────────────┘
```

Rows are 52 px, icon 22 px, chevron at the right.

### 5.4 Page header

Every section builds its header with `pageHeader()` from
`shared/pageHeader.js` (shell, 7.12):

```js
const header = pageHeader({
  title: 'jobs.title',                 // key; h1
  context: () => t('jobs.context', { bench }), // optional line under the title (function: re-run on locale change)
  primary: { label: 'jobs.actions.backup', icon: 'download', run: backup },   // optional
  actions: [ { id, label, icon, run, danger?, disabled? } ],                   // optional, secondary
  back: '#/admin',                     // optional (phone sub-pages): a back arrow
  tabs: tabsInstance,                  // optional: shared/tabs.js bar placed under the header
});
el.append(header.el);  // header.update({ context, primary }) later
```

Expanded / medium:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Sauvegardes                                   [Injecter] [⋯] [▼ Sauvegarder] │
│ Baie B4M · 2 sauvegardes                                              │
├──────────────────────────────────────────────────────────────────────┤
│ Sauvegardes   Modèles de TP   Tâches        (underline tabs, sticky)  │
└──────────────────────────────────────────────────────────────────────┘
```

- Height 72 px (title 22 px/600, context 14 px muted); background `--bg`
  (no white band); no bottom border unless tabs follow.
- Up to two secondary actions as buttons, the rest in ⋯; primary at the right.
- The header and tabs are **sticky**: the section scrolls inside
  `.view-body`, never the document.

Compact:

```
┌──────────────────────────────────┐
│ ←  Sauvegardes            🔔  ⋯  │  app bar 56 px: back (sub-pages only), title 18 px/600, up to 2 icons
├──────────────────────────────────┤
│ Baie B4M ▾                       │  context line, 14 px, may be a picker
│ [      ⬇ Sauvegarder         ]   │  primary: full-width 48 px button at the top of the content
```

- Secondary actions go into ⋯ (a bottom sheet action list).
- The primary action may instead be a sticky bottom bar (forms: Mon compte,
  Paramètres du labo), 64 px above the tab bar, with the safe area.
- Tabs become scrollable underline tabs under the app bar, sticky, with a fade
  at the edges; more than four tabs is a hub list instead (Admin).

### 5.5 Global notices

- **Announcement** (`shared/announcement.js`): one line at the top of the
  content area, under the page header, `--warning-bg` or `--info-bg`, icon,
  text clamped to two lines with "Lire" to expand, ✕ dismiss (per
  announcement id, already stored). Never above the header, never overlaying.
- **Toasts** (7.10).
- **Journal notice** (consoles, 8.2).

### 5.6 Viewport, scrolling, keyboard

- `index.html` viewport meta becomes
  `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`.
  `login.html`, `join.html`, `404.html` get `viewport-fit=cover` too.
- `html, body { height: 100%; overflow: hidden }` in the app page; `.views`
  and `.view` get `min-height: 0` (this is what cuts the top of long sections
  on a phone today, 2.1); each section's scroll container is `.view-body` (`overflow: auto;
  overscroll-behavior: contain; scroll-padding-top` = sticky header height).
  The shell keeps one scroll position per section when switching.
- The shell sets `--vvh` (visual viewport height, px) on `<html>` from
  `visualViewport` `resize` / `scroll` events (rAF-throttled), and the
  attribute `data-keyboard="open"` when `innerHeight - visualViewport.height >
  120`. With the keyboard open, the tab bar is hidden and the full-screen
  console uses `height: var(--vvh)`.

## 6. Design tokens

All tokens live in a new `public/css/tokens.css`, linked by the four HTML pages
**before** `app.css` (the server rewrites the link to `/v/<build id>/…` like
the others). Existing variable names (`--surface`, `--ink`, `--console`,
`--led-green`…) stay as **aliases** of the new roles so that module CSS keeps
working until each part rewrites its files; parts must use the new names in
what they touch. Aliases are removed in a final cleanup once no file uses them.

### 6.1 Spacing

4 px base. Use only these values for margin, padding and gap.

| token | px | typical use |
|---|---|---|
| `--sp-1` | 4 | icon to text in a badge |
| `--sp-2` | 8 | gap between buttons, inside chips |
| `--sp-3` | 12 | inside list rows, between label and field |
| `--sp-4` | 16 | card padding (compact), phone gutter, stack of fields |
| `--sp-5` | 20 | card padding (medium+) |
| `--sp-6` | 24 | between cards, medium gutter |
| `--sp-8` | 32 | between page sections, expanded gutter |
| `--sp-10` | 40 | empty-state padding |
| `--sp-12` | 48 | top of a page with no header |

`--gutter` is 16 / 24 / 32 px by breakpoint.

### 6.2 Type

IBM Plex Sans (400, 500, 600) and IBM Plex Mono (400, 500), self-hosted as
today. Sizes are `rem`-free pixels (the app never scales with the root font).

| token | size / line | weight | use |
|---|---|---|---|
| `--fs-display` | 28 / 34 | 600 | bench name on Accueil's hero card, empty states |
| `--fs-title` | 22 / 28 (compact 18 / 24) | 600 | page title (`h1`) |
| `--fs-heading` | 17 / 24 | 600 | card and section titles (`h2`) |
| `--fs-subheading` | 15 / 22 | 600 | group titles in a card (`h3`), dialog title is `--fs-heading` |
| `--fs-body` | 14 / 20 (coarse pointer 15 / 22) | 400 | text, list rows, table cells |
| `--fs-label` | 14 / 20 | 500 | buttons, tabs, nav labels (expanded) |
| `--fs-small` | 13 / 18 | 400 | meta lines, help text under fields, context line |
| `--fs-caption` | 12 / 16 | 500 | badges, tab bar labels, table headers (no uppercase except list group headings, 12 px, `letter-spacing: .04em`) |
| `--fs-mono` | 13 / 18 | 400 | addresses, ports, identifiers |

Nothing under 12 px (`tinyText()` in `test/e2e/contrast.js` checks 11 px today;
the shell moves its threshold to 12 px). Form inputs are 16 px on a coarse
pointer (prevents the browser from zooming on focus).

### 6.3 Radii

`--r-sm` 6 px (badges, chips, kbd, small inputs), `--r-md` 10 px (buttons,
inputs, list rows, menu items), `--r-lg` 14 px (cards, popovers, dialogs),
`--r-xl` 20 px (top corners of a bottom sheet), `--r-pill` 999 px (count
badges, segmented control on compact, avatars).

### 6.4 Elevation

| token | light | dark | use |
|---|---|---|---|
| `--elev-0` | none, 1 px `--border` | none, 1 px `--border` | cards, inputs |
| `--elev-1` | `0 1px 2px rgb(24 34 45 / .06), 0 1px 3px rgb(24 34 45 / .08)` | `0 1px 2px rgb(0 0 0 / .4)` | raised cards (hero), segmented selection, tiles |
| `--elev-2` | `0 4px 12px rgb(24 34 45 / .10), 0 2px 4px rgb(24 34 45 / .06)` | `0 6px 16px rgb(0 0 0 / .45)` | menus, popovers, toasts, floating controls on the diagram |
| `--elev-3` | `0 16px 48px rgb(24 34 45 / .18)` | `0 16px 48px rgb(0 0 0 / .6)` | dialogs, sheets |

In dark mode elevation also lightens the surface: a raised element uses
`--surface-raised`, not just a shadow.

### 6.5 Colour roles

Both themes. Values checked with the WCAG formula: text pairs ≥ 4.5:1,
non-text UI (borders of inputs, focus ring, icons that carry meaning) ≥ 3:1.

| role | light | dark | notes |
|---|---|---|---|
| `--bg` | `#EEF1F4` | `#0F151B` | page background |
| `--surface` | `#FFFFFF` | `#161E26` | cards, header of tables, sheets |
| `--surface-2` | `#F4F6F8` | `#1C2630` | table headers, hover, list group background |
| `--surface-raised` | `#FFFFFF` | `#1F2A35` | menus, popovers, dialogs (dark: lighter than surface) |
| `--canvas` | `#E8ECF0` + dots `#C6CFD8` | `#121A22` + dots `#23303C` | the diagram (as today) |
| `--border` | `#D5DCE3` | `#2A3744` | separators, card borders (decorative) |
| `--border-input` | `#8796A5` (3.0:1 on white) | `#6B7C8C` (3.8:1 on surface) | input and checkbox borders, secondary button border |
| `--text` | `#18222D` | `#E3E9EF` | 14.2:1 / 15.0:1 on `--bg` |
| `--text-2` | `#4A5867` | `#A9B6C2` | secondary text (6.4 / 8.9 on `--bg`) |
| `--text-muted` | `#5A6673` | `#93A1AD` | meta, placeholders (5.2 on `--bg` / 6.4 on `--surface`, 5.5 on `--surface-raised`) |
| `--accent` | `#3E8FC9` | `#5BA9E0` | console blue: icons, active indicators, LEDs, progress, focus (non-text) |
| `--accent-strong` | `#23699E` | `#2A6FA6` | filled primary buttons (white text 5.9 / 5.4) |
| `--accent-strong-hover` | `#1B5683` | `#235F91` | |
| `--accent-text` | `#23699E` | `#5BA9E0` | links and accent text (5.2 on `--bg` / 6.6 on `--surface`) |
| `--accent-soft` | `#DCEBF6` | `#1C3346` | selected row, active tab pill, info badge background |
| `--on-accent-soft` | `#1D5F92` | `#86C3EE` | text on `--accent-soft` (5.6 / 6.9) |
| `--success` / `--success-text` / `--success-bg` | `#1FA35A` / `#13743A` / `#E6F4EC` | `#1FA35A` / `#5FCB8A` / `#16302A` | text on bg 5.2 / 7.0 |
| `--warning` / `--warning-text` / `--warning-bg` | `#D48C12` / `#8A5A00` / `#FBF1DE` | `#D48C12` / `#E5B04A` / `#342A17` | 5.3 / 7.1 |
| `--danger` / `--danger-text` / `--danger-bg` | `#D0463B` / `#B8352B` / `#FCE9E7` | `#D0463B` / `#EF7B71` / `#3A2022` | 5.0 / 5.5 |
| `--danger-strong` | `#B8352B` | `#B8352B` | filled destructive button, white text 5.9 |
| `--info-bg` | `#DCEBF6` | `#1C3346` | = `--accent-soft` |
| `--nav-bg` | `#1B2631` | `#0D141A` | rail and tab bar, both themes dark |
| `--nav-ink` | `#AEBBC7` | `#AEBBC7` | 7.8:1 |
| `--nav-hover-bg` / `--nav-active-bg` | `#263443` / `#263443` | `#1A2530` / `#1A2530` | active text `#FFFFFF` |
| `--scrim` | `rgb(15 24 33 / .45)` | `rgb(0 0 0 / .6)` | behind dialogs and sheets |
| terminal | unchanged: `--term-bg`, `--term-head`, `--term-head-ink` | unchanged | |
| diagram | `--device-tile #FFFFFF`, `--device-stroke #5D6E7F` (4.4:1 on the canvas) | `--device-tile #223040`, `--device-stroke #A7B6C4` (8.5:1 on the canvas, 6.5:1 on the tile) | a device is recognised by its 2 px stroke, which must stay ≥ 3:1 against both the canvas and the tile fill; the dark tile is lighter than the canvas so that its body reads too |

Aliases (kept until the cleanup, removed at the integration of 2.2.0): `--paper → --bg`, `--surface` keeps its name
(new value), `--surface-2` same, `--line → --border`, `--ink → --text`,
`--ink-2 → --text-2`, `--ink-3 → --text-muted`, `--console → --accent`,
`--console-strong → --on-accent-soft`, `--console-soft → --accent-soft`,
`--primary → --accent-strong`, `--primary-hover → --accent-strong-hover`,
`--ok-ink → --success-text`, `--warn-ink → --warning-text`,
`--danger-ink → --danger-text`, `--danger → --danger-strong`,
`--led-green → --success`, `--led-amber → --warning`, `--led-red → --danger`,
`--rail → --nav-bg`, `--rail-ink → --nav-ink`, `--rail-hover →
--nav-hover-bg`, `--shadow → --elev-2`, `--radius → --r-md`.

Theme: `data-theme` on `<html>` as today, plus a third preference `auto` that
follows `prefers-color-scheme` live. The stored pref (`labconsole.theme`) takes
`'light' | 'dark' | 'auto'`; missing means `auto`.

Status is never colour alone: a status badge always has a word, a LED dot has
a text label or a tooltip plus an accessible name.

### 6.6 Touch and focus

- `--tap`: 32 px on fine pointers (minimum for dense desktop controls), 44 px
  under `(pointer: coarse)`. Every button, link styled as a button, tab,
  menu item, checkbox row, list row and diagram device uses
  `min-height: var(--tap)` (icon buttons `min-width` too). A visually smaller
  control (a 24 px close icon in a chip) gets a 44 px hit area with a
  transparent `::before` (`inset: -10px`).
- Spacing between adjacent targets: 8 px minimum on coarse pointers.
- Focus ring: `outline: 2px solid var(--focus); outline-offset: 2px` with
  `--focus` = `#2F7FBA` light (3.8:1 on `--bg`, 4.3 on white) and `#5BA9E0`
  dark (7.0). On the dark nav and inside terminals the ring is `#5BA9E0`.
  Only `:focus-visible`. Never removed.

### 6.7 Motion

| token | value | use |
|---|---|---|
| `--dur-1` | 120 ms | hover, press, toggles |
| `--dur-2` | 200 ms | menus, popovers, toasts, tab indicator |
| `--dur-3` | 280 ms | sheets, dialogs, side panels |
| `--ease-out` | `cubic-bezier(.2, .8, .2, 1)` | entering |
| `--ease-in` | `cubic-bezier(.4, 0, 1, 1)` | leaving |

Sheets slide up from the bottom (translateY 100 % → 0), dialogs fade and scale
from .98, side panels slide from the right. Under `prefers-reduced-motion:
reduce` everything only fades in `--dur-1` (keep the existing global rule, but
let opacity transitions through).

### 6.8 Layers

`--z-sticky 10` (page headers, tabs), `--z-nav 20` (rail, tab bar),
`--z-float 30` (diagram controls, the open-consoles dock), `--z-popover 40`,
`--z-toast 80`. Dialogs and sheets use `<dialog>.showModal()` (top layer).

### 6.9 Icons

The `ICONS` map in `core/dom.js` stays the only source (24 × 24 viewBox,
1.7 stroke). Sizes: 16 px in badges and small buttons, 20 px in buttons, list
rows and the rail, 24 px in the tab bar and the app bar. New icons the parts
need are added by the shell first (list in 11.1).

## 7. Components

Every component below is built by the shell (part S) in `public/css/app.css`
(styles) and `public/js/shared/` (behaviour), documented in ARCHITECTURE §8,
and used by the parts. A part does not restyle a shared component in its own
CSS file; it asks for a variant.

### 7.1 Buttons

| variant | class | look |
|---|---|---|
| primary | `.btn.primary` | `--accent-strong` fill, white text; one per screen region |
| secondary | `.btn` | `--surface` fill, 1 px `--border-input`, `--text` |
| ghost | `.btn.ghost` (replaces `.subtle`) | no border, `--text-2`, hover `--surface-2` |
| danger | `.btn.danger` | secondary with `--danger-text` (entry point to a destructive action) |
| danger solid | `.btn.danger-solid` | `--danger-strong` fill (only the confirm button of a destructive dialog) |
| icon | `.icon-btn` | square, ghost look; must have `aria-label` and `title` |

| size | class | height (fine / coarse) | padding | font |
|---|---|---|---|---|
| small | `.btn.sm` (replaces `.small`) | 32 / 44 | 0 12 | 13/500 |
| medium (default) | `.btn` | 40 / 44 | 0 16 | 14/500 |
| large | `.btn.lg` | 48 / 48 | 0 20 | 15/600 — compact primary actions, sheet footers |
| block | `.btn.block` (replaces `.wide`) | full width | | |

Icon 20 px (16 in small), gap 8 px. Labels: a verb, sentence case, no trailing
"…", no full stop. Loading: `aria-busy="true"` shows a 16 px spinner in place
of the icon and keeps the width. Disabled: 45 % opacity, `cursor:
not-allowed`, and a tooltip saying why when the reason is not obvious.

### 7.2 Cards

`.card` (`--surface`, 1 px `--border`, `--r-lg`, padding `--sp-4` compact /
`--sp-5`), optional `.card-head` (title `--fs-heading`, optional meta and
actions at the right, 12 px under), `.card-body`, `.card-foot` (actions
right-aligned, or a full-width primary on compact). A card that leads to one
place is fully clickable (`a.card.link`, chevron at the right, hover border
`--border-input`). `.card.hero` adds `--elev-1` and a 4 px left accent bar
coloured by status (free success, taken accent, mine accent, locked danger).
Cards never nest: inner groups are `.card-section` separated by a 1 px
border.

### 7.3 Lists and tables: `shared/dataList.js`

One column definition renders a table at ≥ 720 px and stacked cards below.

```js
const list = dataList({
  label: t('jobs.snapshots.title'),           // accessible name
  columns: [
    { id: 'name', label: 'jobs.cols.name', cell: (r) => …, primary: true },      // card title
    { id: 'when', label: 'jobs.cols.date', cell: (r) => fmtShort(r.at), meta: true }, // card meta line
    { id: 'state', label: 'jobs.cols.state', cell: (r) => badge(…), badge: true },   // card top-right
    { id: 'devices', label: 'jobs.cols.devices', cell: (r) => …, hideCompact: true },
  ],
  actions: (r) => [                            // last column on a table; on a card: primary visible, rest in ⋯
    { id: 'zip', label: 'jobs.actions.zip', icon: 'download', run, primary: true },
    { id: 'delete', label: 'jobs.actions.delete', icon: 'trash', run, danger: true },
  ],
  empty: { text: 'jobs.snapshots.none', action: { label, run } },
  onOpen: (r) => …,                            // optional: whole row / card opens a detail
});
list.render(rows);  el.append(list.el);
```

- Table: header row `--surface-2`, 12 px/500 `--text-muted`, 40 px high;
  rows 52 px (44 compact density for admin tables), 1 px separators, hover
  `--surface-2`; numbers right-aligned; at most **two visible action
  buttons**, the rest in ⋯. The header and body share one `<table>`: the
  column misalignment found in Administration › Utilisateurs cannot happen.
- Card (compact): title line (primary column, 15/600) with the badge at the
  right, meta line(s) 13 px muted, hidden columns omitted, then the primary
  action as a small secondary button and ⋯. Cards are separated by 8 px, or
  grouped in one `.card` with dividers (`dense: true`).
- Selection (checkbox column) stays a table feature; on compact it becomes a
  "Sélectionner" mode in ⋯.

### 7.4 Segmented control and tabs

- `.seg` (exists): for 2–4 mutually exclusive **views or filters**. Height
  36 px (44 coarse), `--surface-2` track, selected segment `--surface-raised`
  + `--elev-1`. On compact a segmented control with up to 3 options takes the
  full width; with 4–5, it scrolls.
- **Tabs** (`shared/tabs.js`, restyled): underline tabs for **sub-pages**
  (Équipe, Sauvegardes, État du labo): 44 px, 14/500 `--text-2`, active
  `--text` + 2 px `--accent` underline that slides (`--dur-2`). Sticky under
  the header. API unchanged; new option `style: 'underline' | 'segmented'`
  (default underline). Sections using `.seg` for sub-pages today (Équipe,
  État du labo, Machines et switchs) switch to underline tabs.

### 7.5 Badges, chips, avatars

- **Status badge** `.badge` with `data-tone="success|warning|danger|info|neutral"`:
  pill, 12/500, 4 × 8 px padding, `--*-bg` fill, `--*-text` text, optional 6 px
  dot. Never clickable.
- **Count badge** `.count`: 18 px min circle, `--accent-strong` fill, white
  12/600; `data-tone="danger"` for things that need action.
- **Filter chip** `.chip` (`button`, `aria-pressed`): 32 px (44 coarse),
  1 px `--border-input`, pressed = `--accent-soft` + `--on-accent-soft`. The
  home page's "5 libres / 2 prises" become filter chips that filter Le labo.
- **Avatar** `.avatar`: initials on the user's colour (server-given), 24 px in
  lists and presence, 32 px in menus; a stack shows at most 3 then "+n";
  pilot gets a 2 px `--success` ring and a small keyboard glyph.

### 7.6 Empty, loading and error states

- Loading: `loading()` from `shared/loadState.js` shows **skeleton rows**
  (3 bars, `--surface-2`, shimmer disabled under reduced motion) after 300 ms;
  before that, nothing (no flash).
- Empty: `emptyState({ icon, title, text, action })` (new, in
  `shared/loadState.js`): 40 px icon `--text-muted`, title `--fs-subheading`,
  one sentence, one primary action. Every list and card has one (the overview
  lot's rule "a card with nothing to show says what to do next" generalised).
- Error: `loadFailure()` unchanged in behaviour (the `ui-failures` tests rely
  on it), restyled as a `.card` with `--danger-bg` and a "Réessayer" button.

### 7.7 Dialogs and bottom sheets

`shared/dialog.js` keeps its API; presentation depends on the breakpoint:

- **Medium / expanded**: centred `<dialog>`, `--surface-raised`, `--r-lg`,
  `--elev-3`, scrim `--scrim`. Sizes: `size: 'sm'` 420 px (confirmations),
  `'md'` 560 px (default, forms), `'lg'` 800 px (lists, reports; `wide: true`
  stays an alias), `'full'` (95 vw × 90 vh: script editor, diff). Header
  56 px: title `--fs-heading`, ✕ 40 px. Body padding 20 px, scrolls. Footer
  sticky, 16 px padding, top border, buttons right-aligned, primary last.
- **Compact**: the same `<dialog>` becomes a **bottom sheet**: full width,
  anchored at the bottom, `--r-xl` top corners, max height
  `calc(var(--vvh, 100dvh) - 24px)`, a 36 × 4 px handle (decoration only),
  header with ✕, scrolling body, sticky footer above the safe area. Footer
  buttons: two short actions side by side (50/50), otherwise stacked with the
  primary on top; all `lg`. `size: 'lg' | 'full'` sheets take the full height
  (no handle, ✕ at the left as "back", title centred).
- Tapping the scrim closes a dismissible dialog. Back (history) closes the
  top sheet on a phone: the shell pushes a `#…?sheet` state when a sheet opens
  and pops it on close.
- `confirmDialog({ danger })` keeps the alertdialog role and focus on Cancel.
- Forms in dialogs: labels above fields, 16 px between fields, hints 13 px
  under the field, errors `--danger-text` under the field with an icon.

### 7.8 Menus: `shared/menu.js` (new)

`openMenu(anchor, items, { label })` → Promise of the chosen id or null. An
item is `{ id, label, icon?, danger?, disabled?, hint?, checked? }` or
`'separator'` or `{ group: 'key' }`. Expanded / medium: popover anchored to
the button (flip to stay on screen), `--surface-raised`, `--r-lg`,
`--elev-2`, items 36 px (44 coarse), icon 20 px, keyboard: arrows, Home/End,
type-ahead, Escape returns focus. Compact: a bottom sheet listing the items as
52 px rows. Used for every ⋯ button (`moreButton(items)` helper builds the
icon button and opens the menu).

### 7.9 Side panels: `shared/sidePanel.js` (new)

For En direct, Discussion, Alertes on desktop: a right column of 360 px inside
a section, which **resizes** the main content at ≥ 1200 px (no overlay); at
medium width an overlay drawer with scrim; on compact a full-height sheet.
One open per host; opening another closes the first. Header 56 px (title,
optional count, ✕), scrolling body, optional sticky footer (chat composer).
State in the address is optional (`?panel=live`), not required.

### 7.10 Toasts

`toast(message, kind, ms, { action })` keeps its signature, gains an optional
action button (`{ label, run }`) and a ✕. Look: `--surface-raised` in light
(dark text) and `#25313D` in dark, 4 px left bar by kind, icon by kind,
`--r-md`, `--elev-2`. Expanded: bottom-right, 360 px. Compact: bottom, full
width minus gutters, above the tab bar and the safe area; at most two visible
(older ones collapse). `role="status"` (errors `role="alert"`). Errors stay
until dismissed only when they come with an action.

### 7.11 Forms

Inputs and selects 40 px (44 coarse, 16 px text on coarse), `--r-md`, 1 px
`--border-input`, `--surface` fill, focus = ring. Labels 14/500 above;
optional "(facultatif)" in muted; hint 13 px muted under. Checkboxes and radios
20 px with the whole label row as the target (44 px on coarse). Password
fields have a show/hide icon button. A form's submit button is the primary of
its card or dialog footer.

### 7.12 Page header: `shared/pageHeader.js` (new)

Described in 5.4. It also renders the compact app bar (title, back, up to two
icon actions, ⋯) and exposes `header.setBadge(id, n)` for icon actions with
counts.

### 7.13 The bench strip (bench bar)

The bench bar (`modules/teams/benchBar.js`, part B) becomes a one-line strip;
its full content moves to Équipe › Baie (10.3). It is used on the Consoles
page (part A hosts it) and keeps its API (`setBench`, `decorate`, `mayOpen`,
`refusal`, `isOccupant`, `ready`), plus `variant: 'strip'` (default) and
`openSheet()`.

```
expanded, our bench:
│ ● B4M · Les commutateurs (vous) · AM BH · libération auto. 04:54     [Libérer la baie] [⋯] │
expanded, release in under 30 min:
│ ◔ Libération automatique dans 12 min                         [On est toujours là] [⋯] │   warning tone
free bench:
│ ○ B6H est libre                                                       [Prendre la baie] │
another team's bench:
│ ● B5B · Les routeurs fous · CD                                 [Demander à rejoindre] [⋯] │
locked:
│ 🔒 B6B verrouillée : Préparée pour le TP noté (Ada Admin)              [Déverrouiller]* │   danger tone, *admins
join request waiting (second line, only when present):
│ Alice Martin demande à rejoindre la baie · 01:54                    [Accepter] [Refuser] │   warning tone
running job (second line, only when present):
│ ▤ Sauvegarde en cours · 4/9 équipements · Alice                [Voir]  ▬▬▬▬▬▬░░░░ │   info tone, Voir → #/jobs/B4M
```

- Height 44 px per line (52 on coarse), `--surface` fill, bottom border,
  status dot and text 14 px, people as an avatar stack.
- ⋯ holds: Historique de la baie, Planning de la baie (→
  `#/team/calendar/<bench>`), On est toujours là (when not shown), Attribuer,
  Verrouiller (admins), Quitter la baie (guests), Détails (→ `#/team/bench/<bench>`).
- Compact: one line, the bench name is in the picker so the strip starts with
  the state: a word that is never cut ("Libre", "Prise par vous"; the release
  time is in the bench sheet, a team's name may be truncated); the
  only visible button is the most urgent one (Accepter on a request, Prendre
  la baie, On est toujours là near release); tapping the strip opens the bench
  sheet (same content as Équipe › Baie for that bench). Requests and running
  jobs keep their own line on compact too.

## 8. The Consoles page

Part A. Files in 11.3.

### 8.1 Desktop (expanded), nothing open

```
┌ rail ┬─────────────────────────────────────────────────────────────────────────────┐
│      │ Consoles   [B4M ▾]  [🔍 Trouver un équipement   Ctrl K]    [En direct 2] [Discussion •] [Outils ▾] │  56 px
│      │ ● B4M · Les commutateurs (vous) · AM · libération auto. 04:54     [Libérer la baie] [⋯]           │  44 px strip
│      │ ⓘ Les consoles sont journalisées 14 jours. En savoir plus                                    ✕    │  once, 40 px
│      ├────────────────────────────────────────────────────────────────────────────────────┤
│      │                                                                                    │
│      │                         diagram (canvas, full remaining height)                    │
│      │                                                                                    │
│      │  [− 100 % + ⤢]                                     [⚠ 2 remarques sur le schéma]   │  floating, --elev-2
└──────┴────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header (56 px)**: title "Consoles" (no subtitle: the hint lives in the
  canvas); the **bench picker button** "B4M ▾" with the status dot of the
  bench; the **finder** as a search field look-alike (opens `QuickOpen`,
  Ctrl K and "/" kept); at the right: **En direct** and **Discussion** toggle
  buttons (secondary, `aria-pressed`, count badges: open consoles, unread
  messages), then **Outils ▾** menu: Vérifications, Mur de consoles,
  Journaux, Bibliothèque de scripts.
- **Bench picker popover**: the rack elevation drawing stays (it is a good
  picture of the room) but inside the popover: racks side by side, slots
  40 px high with name, status dot, a "vous" marker on our bench, a lock icon,
  and a legend line. Keyboard: arrows move between slots, Enter selects.
  The rack picker no longer sits in the header.
- **Strip (44 px)**: 7.13.
- **Journal notice**: shown once per browser (pref `journalNoticeSeen`), as a
  40 px info line **above** the canvas (pushes it down, never over it), one
  sentence ("Les consoles sont journalisées pendant {days} jours : ce que les
  équipements affichent, pas ce que vous tapez sans écho.") with "En savoir
  plus" (→ `#/help/journal`) and ✕. After dismissal the information stays
  reachable via Outils › Journaux and the record icon on each tile.
- **Canvas**: full remaining height. The big "B4M" heading and its three
  buttons are removed (bench name is in the picker; Mur de consoles and
  Vérifications are in Outils; Discussion is in the header). When no console
  is open, a hint chip at the top-left of the canvas: "Cliquez sur un
  équipement pour ouvrir sa console" (compact: "Touchez…"; `consoles.hint` gets
  a touch variant chosen by `(pointer: coarse)`).
- Zoom controls bottom-left (`--elev-2`, 40 px buttons), diagram remarks
  button bottom-right (with its label, never empty), both 16 px from the edges.
- **Side panels** (En direct, Discussion) use `shared/sidePanel.js` (7.9):
  the canvas shrinks, the diagram refits.

### 8.2 Desktop, consoles open

```
│ header 56 · strip 44                                                                      │
├──────────────────────────────┬─┬──────────────────────────────────────────────────────────┤
│ diagram (34 %, min 280 px)   │┊│ 2 consoles   [▦ ▥ ▤]                         [Affichage ▾] │ 40 px
│                              │┊│┌ ● R1  B4M · .211:2013                ⏺ (AM)  ⛶  ⋯  ✕ ┐  │ 36 px tile head
│                              │┊││ Alice a la main · [Demander la main]                    │  │ presence: only when relevant
│                              │┊││ R1#show ip interface brief                              │  │
│                              │┊││ …                                                       │  │
│                              │┊│└─────────────────────────────────────────────────────────┘  │
└──────────────────────────────┴─┴──────────────────────────────────────────────────────────┘
```

- Splitter kept (keyboard arrows kept), default diagram 34 %, double-click
  the splitter to toggle the diagram column (also the existing "panel" button,
  now in the workspace bar).
- **Workspace bar (40 px)**: diagram toggle, "2 consoles" count, the layout
  segmented control (grille / colonnes / lignes), then **Affichage ▾**: texte
  plus petit / plus grand (with the current size), Tout fermer. Removes the
  standalone A−/A+ and "Tout fermer" buttons.
- **Tile head (36 px)**: LED, device name 14/600 white, bench and address in
  mono 12 px (hidden under 460 px tile width), state text when not
  "Connecté" (Connexion…, Déconnecté, Erreur), a **record icon** (⏺, muted,
  tooltip "Console journalisée") instead of the "Journalisée" pill, the
  presence avatar stack (max 3 + n), **⛶ maximize**, **⋯**, **✕**.
- **⋯ menu of a tile**: every registered pane action, in `order`, with its
  label (they are icon-only today): Envoyer un BREAK, Exporter la
  configuration, Injecter un script, Envoyer à plusieurs consoles, Historique,
  Note de l'équipement, Récupération du mot de passe; separator; Partager le
  clavier / Reprendre le clavier, Rendre la main, Libérer la ligne (presence
  actions when they apply); separator; Se déconnecter et fermer. Disabled
  actions show why (`hint`). `registerPaneAction` gains an optional
  `pinned: true`: a pinned action also appears as an icon in the head when
  the tile is wider than 640 px (none pinned by default; the reviewer may pin
  Injecter).
- **Presence row (32 px)** under the head only when it carries information:
  someone else is on the console, you are watching, a request for the keyboard
  is waiting, or a task holds the keyboard. Content: one sentence and at most
  two buttons (Demander la main / Donner la main + Refuser / Prendre la main
  for admins). When you are alone and pilot, no row (a small key glyph on your
  avatar says it).
- **Task row** (`shared/taskBar.js`): unchanged role, restyled to 32 px with a
  thin progress bar along the bottom edge of the tile head.
- **Banner inside a tile** (connection refused, closed): kept, restyled as a
  card at the bottom of the terminal with `--surface-raised` dark variant.

### 8.3 Phone (compact)

Two screens and two sheets.

**Screen 1, the bench** (`#/consoles/B4M`):

```
┌──────────────────────────────────┐
│ Consoles            💬•    ⋯     │ app bar: Discussion (badge), Outils menu (+ Trouver, En direct)
│ [● B4M ▾]  Prise par vous    │ picker button + strip text (tap → bench sheet)
│ ⚠ Alice demande à rejoindre  [Accepter] │ only when a request waits (Refuser in the sheet)
│ [  Schéma  |  Liste  ]           │ segmented, remembered (pref consolesView)
├──────────────────────────────────┤
│                                  │
│   diagram, pinch / pan,          │
│   devices ≥ 44 px                │
│                                  │
│ [− ⤢ +]                          │
│ ┌──────────────────────────────┐ │
│ │ ● R1 · S1   2 consoles ouvertes › │ dock: back to the last console (only when consoles are open)
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│ tab bar                          │
└──────────────────────────────────┘
```

- **Bench picker sheet**: list grouped by rack (B4, B5, B6), each row 56 px:
  bench name 16/600, status badge (Libre / Prise / Verrouillée / Votre baie),
  team name, open consoles count. Our bench is pinned at the top under
  "Votre baie". Tapping a row selects and closes.
- **Schéma**: the canvas fills the space between the segmented control and the
  tab bar. Gestures: one finger pans, **two fingers pinch-zoom** around the
  midpoint, double-tap zooms ×2 around the point, a tap on a device opens it.
  Initial fit: the whole diagram if that keeps device tiles ≥ 36 px on screen,
  otherwise fit the width and start at the top (the user pans down). Zoom
  range 25 %–300 %. The device hit area is at least 44 × 44 screen px at any
  zoom (enlarged transparent `.device-hit`). Labels hide under 50 % zoom
  except device names. Presence avatars and badges are drawn in diagram
  coordinates next to their device (fixes the detached avatar).
- **Liste** (new, `modules/consoles/deviceList.js`): one row per device of the
  bench, 64 px: device glyph (router/switch), name 16/600, address mono
  13 px, state badge (Libre / Ouverte ici / Avec Alice (main) / Occupée hors
  appli / Indisponible), avatars, chevron. Sorted as the diagram reads (R
  then S, by number). Also available on desktop through the same segmented
  control in the canvas corner (optional, cheap once the list exists).
- **Long press** on a device (diagram or list) opens the **device sheet**:
  name, address, state, who is on it, its note (collab), actions: Ouvrir la
  console, Me prévenir quand elle est libre (busy lines), Ajouter une note.
- **Dock**: a floating pill above the tab bar while consoles are open: LEDs and
  names of open consoles (max 3, then "+n"), "n consoles ouvertes", tap →
  the last console screen. 52 px, `--elev-2`, `--z-float`.
- **Outils** (⋯): Trouver un équipement, En direct, Vérifications, Mur de
  consoles, Journaux, Bibliothèque de scripts. En direct and Discussion open
  as full-height sheets.
- The journal notice is a one-time info line under the segmented control,
  dismissible.

**Screen 2, the console** (`#/consoles/B4M/R1`), full screen, tab bar hidden:

```
┌──────────────────────────────────┐
│ ←  ● R1 · B4M        (AM)  ⋯     │ 48 px: back to screen 1; LED; presence avatars; ⋯ = tile menu + text size
│ [R1] [S1] [+]                    │ 40 px, only with 2+ open: switcher chips (+ = back to diagram)
│ Alice a la main  [Demander la main] │ presence row, only when relevant
├──────────────────────────────────┤
│ R1#show ip interface brief       │
│ Interface   IP-Address  OK? …    │ terminal, 12 px mono by default on compact
│ …                                │
│ R1#                              │
├──────────────────────────────────┤
│ Esc Tab Ctrl ↑ ↓ ← → ? ^C ^Z ␣ … │ key toolbar, 44 px, scrolls sideways
│ [ conf t                    ][⏎] │ line input, 48 px
└──────────────────────────────────┘
        (phone keyboard below)
```

Details in 9.

- Swiping horizontally on the switcher row (not on the terminal) changes
  console; the address follows (`replaceState`).
- ⋯: the tile menu of 8.2 plus "Taille du texte" (− / + stepper) and "Mode
  de saisie : ligne / direct" (9.3).
- Back (header arrow or the browser) returns to the bench screen; the console
  **stays connected** (as today when switching sections).

### 8.4 Tablet (medium)

- Collapsed rail. Consoles page: header and strip as desktop (Outils menu,
  side panels as overlay drawers).
- Portrait (768 × 1024): diagram on top (40 %), workspace below, horizontal
  splitter (as today below 900 px); the key toolbar and line input of 9 appear
  under the focused tile when `(pointer: coarse)`.
- Landscape: desktop layout.

## 9. The terminal on a phone

Part A. Applies whenever `(pointer: coarse)`; the toolbar can also be shown on
desktop from ⋯ (useful on a touch laptop).

### 9.1 Size and fit

- Default font 12 px on compact (≈ 50 columns at 390 px), 14 px elsewhere;
  per-device pref `fontSize` as today (`terminal.workspace.smaller/larger`).
- The terminal fits `width × (var(--vvh) − head − rows − toolbar − input)`
  and refits on `visualViewport` resize (keyboard open/close, rotation), then
  scrolls to the bottom.
- First time a console opens in portrait on a phone: a one-time hint line
  "Tournez le téléphone pour afficher plus de colonnes." (pref
  `rotateHintSeen`), dismissible.
- Scrollback: a vertical finger drag on the terminal scrolls it
  (`.xterm-viewport { touch-action: pan-y; overscroll-behavior: contain }`).
  The page never scrolls behind it.

### 9.2 Key toolbar

A row of 44 px keys (min width 44 px, 8 px gap, mono 14 px labels,
`--surface` on the dark terminal theme: `#1D2B38` with `#DCE4EB` text),
scrolling sideways. Each key sends to the console through the same path as
xterm's input (`pane` sends an `input` frame; refused locally when the user
may not type, as today).

| key | label | sends | note |
|---|---|---|---|
| Esc | `Échap` / `Esc` | `\x1b` | |
| Tab | `Tab` | `\t` | completes IOS commands |
| Ctrl | `Ctrl` | modifier | sticky: the next key (toolbar or typed letter) is sent as its control code; pressed again → locked until tapped again; shown `aria-pressed` |
| ↑ ↓ ← → | arrows | `\x1b[A` `\x1b[B` `\x1b[D` `\x1b[C` (or `\x1bOA`… when xterm's application cursor mode is on) | IOS history and line editing |
| ? | `?` | `?` | context help |
| Ctrl+C | `^C` | `\x03` | |
| Ctrl+Z | `^Z` | `\x1a` | leaves configuration mode |
| Ctrl+Maj+6 | `^⇧6` labelled "Interrompre" | `\x1e` | stops a ping or traceroute on IOS |
| Espace | `␣` | ` ` | next page of `--More--` |
| Coller | clipboard icon | clipboard text | uses `navigator.clipboard.readText()`; long text goes through the existing paste guard of `terminalPane` |
| ⌨ | keyboard icon | — | toggles line / direct mode (9.3) |

Keys are buttons with `aria-label`s in both languages (`terminal.keys.*`) and
`title`s that explain (e.g. "Ctrl+Maj+6 : interrompre un ping").

### 9.3 Line mode and direct mode

Phone keyboards and xterm's hidden textarea get along badly (autocorrect,
predictive text, composition events, a lost first letter). Two modes,
remembered per browser (pref `terminalInput`: `'line' | 'direct'`; default
`line` on a coarse pointer, `direct` otherwise):

**Line mode** (default on phones): an input field under the toolbar,
`font: 16px var(--mono)`, `autocapitalize="off" autocomplete="off"
autocorrect="off" spellcheck="false" enterkeyhint="send"`, and a 48 px send
button (⏎). The field is a local buffer:

- Enter / ⏎: sends the field's text followed by `\r`, clears the field. An
  empty Enter sends `\r` alone (wakes the line, answers prompts).
- Tab and ? (toolbar or typed `?` at the end of the field): send the field's
  text followed by `\t` or `?`, then clear the field: the device keeps the
  partial command and prints it again, as IOS does.
- Ctrl+C: clears the field and sends `\x03`.
- Arrows, Esc, Ctrl+Z, ^⇧6, Espace: sent to the device directly; while the
  field holds text, ↑/↓/Esc/Ctrl+Z are disabled (greyed) so the buffer and the
  device line never disagree; ← → move the caret inside the field.
- The field keeps the focus after sending (the keyboard stays open).
- Password prompts: the field becomes `type="password"` while the last
  terminal line ends with `Password:` (case-insensitive), and returns to text
  after the next send.

**Direct mode**: no field; the terminal's own textarea takes the keystrokes
(as on a PC), the toolbar stays. The ⌨ key switches.

**Watching** (not allowed to type): no field; a full-width 48 px button
"Demander la main" (or the waiting state "Demande envoyée…" with Annuler); the
toolbar is hidden. **A task holds the keyboard**: the field is replaced by the
task line (label, progress, who started it).

### 9.4 Copy

Text selection inside xterm is awkward with a finger. The tile ⋯ menu gains
"Copier l'écran" (copies the visible rows as text) and "Copier les 200
dernières lignes"; the existing Exporter and Historique stay.

### 9.5 Tests that part A adds

A Playwright context with `hasTouch: true, isMobile: true, viewport
390×844`: open B4M → tap R1 in the Liste view → console screen at
`#/consoles/B4M/R1`; type `show ip interface brief` in the line field + ⏎ →
`waitForTerminal`; Tab completion through the toolbar (`sh` + Tab → device
shows `show`); Ctrl sticky + `c`; Back returns to the bench screen with the
console still connected; a watcher sees "Demander la main" and no field.

## 10. The other screens

For each screen: what comes first on a phone and on a PC, and its primary
action. "Phone" means compact; "PC" means expanded (medium follows expanded
with one column less).

### 10.1 Accueil (`#/home`, part C)

Content in order of importance:

1. **Attention** (only what needs me now, as compact cards with one action
   each): a join request on our bench (Accepter / Refuser), a team invitation
   (Accepter), release of our bench in under 30 min (On est toujours là), a
   job of our team running (Voir), our bench locked, for admins accounts
   waiting for validation (Valider → `#/admin/users`) and a health problem
   (→ `#/status`).
2. **Ma baie** hero card: bench name `--fs-display`, status badge, team, who is
   there (avatars), "3 consoles ouvertes sur 10", automatic release time.
   Primary: **Ouvrir les consoles** (→ `#/consoles/B4M`); secondary:
   Sauvegarder (→ `#/jobs/B4M/backup`). The per-device list ("personne n'a la
   main" × 10) is removed; a row of device chips with LEDs (open / free) may
   replace it on PC.
   - No team: card "Créez votre équipe ou acceptez une invitation" →
     primary **Créer une équipe** (→ `#/team/mine`).
   - Team without bench: card listing up to 3 free benches with **Prendre**
     each, and "Voir toutes les baies".
3. **Le labo** (was Vue d'ensemble): filter chips (Toutes 9, Libres 5, Prises 2,
   Verrouillées 1, La nôtre), then the benches. Phone: a list (`dataList`
   cards, dense), one row per bench: name, status badge, team, consoles
   open, chevron → `#/consoles/<bench>`. PC: a grid of compact bench cards,
   3 per row (`benchCard.js` slimmed: name + badge, team, consoles count, next
   slot, one button "Ouvrir"). Live, as today.
4. **Nos prochains créneaux** (next 3, primary "Réserver" → `#/team/calendar`).
5. **Nos dernières sauvegardes** (last 2, each with Télécharger; "Toutes" →
   `#/jobs`).
6. **Activité récente** (last 5 lines, "Voir plus" expands to 20).

PC layout: content max 1280 px centred, 12-column grid: Attention full width;
Ma baie (8 cols) + Mon équipe card (4 cols: members avatars, Gérer); Le labo
full width; Créneaux, Sauvegardes, Activité in three 4-col cards. Phone: one
column in the order above; Mon équipe is a line inside Ma baie ("Les
commutateurs · 2 membres ›").

Admin's Accueil: Attention (accounts, health, locked benches), Le labo full
width first, then the admin shortcuts card (Inviter, Annonce, Paramètres).

Page header: title "Accueil", context "Bonjour Alice"; no primary in the header
(the hero card carries it).

### 10.2 Équipe › Mon équipe (`#/team/mine`, part B)

- Phone first: team name (`--fs-heading`) and members (avatar, name,
  identifiant, "depuis…"), then **Inviter un camarade** (field + primary
  **Inviter**), pending invitations (Retirer in ⋯), our reservations (link to
  Réservations). Renommer and Quitter l'équipe go to the header ⋯ (Quitter is
  danger, confirm dialog).
- No team: two cards: **Invitations reçues** (Accepter primary, Refuser
  ghost), then **Créer une équipe** (name field + primary **Créer**).
- PC: same order in a 760 px column, centred; members as a 2-column list.
- Primary: Inviter (with a team), Créer une équipe (without).

### 10.3 Équipe › Baie (`#/team/bench[/<bench>]`, part B, new)

The full bench management that today hides in the bench bar.

- Our bench (or the one in the address): status card (state, team, since,
  automatic release time with **On est toujours là**), **occupants** (members
  and guests, admins can remove a guest), **requests** (Accepter / Refuser),
  **next slots** (link to Réservations), **history** (last 20 entries inline,
  "Tout voir" opens the dialog), admin block (Attribuer, Verrouiller /
  Déverrouiller with reason).
- Primary: **Libérer la baie** when we hold one (confirm with the backup
  offer, as today); **Prendre une baie** when we hold none (shows the free
  benches list with Prendre each).
- Phone: the status card, then requests, then the rest; the primary as a
  full-width button under the status card.

### 10.4 Équipe › Réservations (`#/team/calendar[/<bench>]`, part B)

- PC: week grid as today, with the bench as a picker button, week navigation
  (← Cette semaine →), cells 40 px high showing booked slots as blocks with
  the team name; our slots in `--accent-soft`; hover shows "Réserver
  14:00–15:00". Instruction text: "Choisissez une heure libre pour réserver
  la baie pour votre équipe ; choisissez votre créneau pour l'annuler."
  (device-neutral).
- Phone: **day agenda**: the bench picker, a row of 7 day chips (lun 9 … dim
  15, today marked, past days muted), then the hours of that day as 52 px rows:
  free → "Libre · Réserver" (tap opens the confirm sheet), booked → team name
  (ours: "Votre équipe · Annuler"). Swipe left/right on the agenda changes the
  day.
- Primary: none in the header; the action is on the slot.

### 10.5 Équipe › Toutes les équipes (`#/team/all`, admins, part B)

`dataList`: team, members (avatars), bench, created; actions Renommer,
Dissoudre (danger) in ⋯. Reached from Admin › Comptes › Équipes as well.

### 10.6 Sauvegardes (`#/jobs/<bench>[/<action>]`, part B)

- Header: title "Sauvegardes", context = bench picker ("Baie B4M ▾"), primary
  **Sauvegarder**; secondary Injecter and Comparer as buttons on PC, in ⋯ on
  phone; **Réinitialiser** always in ⋯ (danger). No "…" in labels.
- Underline tabs: **Sauvegardes** (default), **Modèles de TP**, **Tâches**.
- First on both: the **running job** card when there is one: title, who,
  progress bar with "4 / 9 équipements", Arrêter (danger ghost); the
  per-device list collapsed by default ("Détail" expands), each device a row
  with state badge. Finished job: result summary + the existing "Téléchargez
  cette sauvegarde maintenant" callout (owner's decision: kept), compact,
  with **Télécharger le ZIP** primary and ✕.
- Then the team's backups as `dataList`: name (or date when unnamed), date,
  devices count ("9 équipements", full list in the detail), by; primary row
  action **ZIP**; ⋯: Voir, Comparer à la configuration en cours, Injecter,
  Dossier de TP (rename to **Exporter en dossier de TP**), Supprimer.
- Search in the configurations: a search field in the Sauvegardes tab
  toolbar (PC) or a search icon in the app bar (phone) that opens a search
  sheet. Importer un ZIP in ⋯.
- Dialogs (backup device selection, inject, compare, reset) follow 7.7; the
  device checklist rows are 44 px with the badge "partagé avec une autre
  baie" on its own line.

### 10.7 Admin (`#/admin/<tab>`, part C)

- PC: secondary list at the left (4.3), the tab's content at the right
  (max 1100 px). Header: title of the tab ("Utilisateurs"), context with
  counts, primary per tab:

| tab | first thing shown | primary |
|---|---|---|
| Utilisateurs | accounts waiting for validation (if any) on top, then search + list | Inviter (→ Invitations › new) |
| Invitations | active links | Nouvelle invitation |
| Connexion SSO | state card (configured or not, test result) then the form | Enregistrer (sticky footer) |
| Paramètres du labo | the form grouped in cards (Rebond SSH, Telnet, Consoles autorisées, Proxmox read-only) | Enregistrer (sticky footer, re-auth as today) |
| Schéma | current diagram card (version, benches, warnings) | Importer un schéma |
| Switchs d'admin | the table | Enregistrer |
| Sessions | `dataList` of sessions | none (Fermer per row) |
| Journal d'audit | filters + `dataList` | none (Exporter in ⋯) |
| Annonce | current announcement preview | Publier |

- Phone: `#/admin` = hub list (groups, 52 px rows with counts); a tab opens
  full screen with ← to the hub. Tables are `dataList` cards; the
  Utilisateurs role select moves into the row's ⋯ ("Changer le rôle…" opens a
  sheet with the choices and the existing confirmation).

### 10.8 Machines et switchs (`#/infra`, part C)

Underline tabs Machines virtuelles / Switchs d'admin. VM list as `dataList`
(name, state badge, VLAN, actions Console / Écran / Démarrer-Arrêter in ⋯ on
phone); opening a console uses the shared workspace (on a phone the console
screen of 8.3, with the same toolbar). Primary: none (row actions). When
Proxmox is not configured, an empty state says so (no table).

### 10.9 État du labo (`#/status/<tab>`, part C)

Tabs Santé / Ce qui est journalisé. Santé: a summary line first ("Tout
fonctionne" success, or "1 problème" danger), then one card per component with
LED + label + detail, as today but in a 2-column grid on PC. No primary.

### 10.10 Aide (`#/help[/<section>]`, part C)

- PC: a sticky table of contents at the left (220 px), content 720 px.
- Phone: a "Sommaire" picker at the top (sheet), sections as collapsible
  blocks; the keyboard shortcut table is hidden on a coarse pointer and
  replaced by a new section **Sur téléphone** (bottom bar, Plus, the console
  screen, the key toolbar, line mode, Ctrl+Maj+6, landscape).
- Sections are already routes (`#/help/<section>`, e.g. `#/help/journal`):
  other screens link to them instead of explaining in place.
- Help texts that describe the old navigation are rewritten (rail, "Vue
  d'ensemble", "Infra", "Mur de la baie").
- Guided tour (`modules/help/tour.js`): steps target `[data-nav="…"]`
  attributes provided by the shell (stable across rail and tab bar); on a
  phone the tour has fewer steps (tab bar, Consoles bench screen, console
  screen, Plus).

### 10.11 Mon compte (`#/account`, part C)

Cards: Profil (name, identifiant, rôle, connexion), Mot de passe (local
accounts), Clés d'accès (list + **Ajouter une clé d'accès**; the last one's
Supprimer is disabled, AUTH.md §2b), Sessions
(`dataList`: device, last seen, Fermer; "Fermer les autres sessions" ghost
danger), Préférences (Thème, Langue: the same controls as the account menu).
Phone: the cards stacked; actions inside each card. No header primary.

### 10.12 Login, join / reset, 404 (part C)

- Login: on compact no card: the brand block (48 px mark, "Lab Console",
  subtitle) at the top third, then **Se connecter avec {provider}** (lg,
  block), the "Compte local" disclosure (fields 48 px, 16 px text), the
  language segmented control at the bottom with the safe area. PC: the card as
  today (440 px), with the new tokens.
- Join / reset: same frame; the form fields as 7.11; errors under the field;
  the invalid-link state as an empty state with "Retour à la connexion".
- The passkey steps (2.3.0, AUTH.md §2b) stay in the same card or phone
  frame: a heading, one sentence, one lg block primary (Enregistrer une clé
  d'accès / Utiliser ma clé d'accès) and, on the login page, "Recommencer la
  connexion" as a ghost block. Above the step of the join / reset page, what
  went well (account created, password saved, waiting for approval) is a
  success notice; a timed-out step or a disabled account a warning. A browser
  without passkeys or a site without https gets the empty state titled
  "Clés d'accès indisponibles ici" (not "Ce lien ne fonctionne pas").
- 404: empty state with "Retour à l'accueil".

### 10.13 Alertes (notifications, `modules/collab/notifications.js`, part A owns the module, shell places it)

PC: the bell in the rail opens a side panel (7.9) listing notifications,
"Tout marquer comme lu". Phone: Plus › Alertes opens the list in the Plus
sheet (pushed view with back). The unread count shows on the rail bell and as
a dot on the Plus tab.

## 11. Implementation plan

### 11.1 The shell (part S): first, alone

It must land and be merged on `v2` before A, B and C start. It changes no
section's content, only the frame and the shared kit, and keeps every
existing test green (or updates the tests it deliberately changes).

Owns:

| file | change |
|---|---|
| `public/index.html`, `login.html`, `join.html`, `404.html` | viewport meta (5.6); link `css/tokens.css` before `app.css`; index: new nav markup (rail + tab bar containers, `data-nav` hooks), FR/EN and theme buttons removed from the rail |
| `public/css/tokens.css` (new) | section 6, with the aliases |
| `public/css/app.css` | shell (rail, tab bar, Plus sheet, page header, view-body scrolling), base components 7.1–7.5, 7.10, 7.11; removes the old phone rules of the rail |
| `public/css/shared.css` | dialogs and sheets (7.7), menus (7.8), side panels (7.9), tabs (7.4), dataList (7.3), load states (7.6) |
| `public/js/main.js` | `MODULES` with nav fields (4.4), redirects (4.2), per-section scroll containers and scroll memory, `parent` highlighting; overview module entry removed **only when part C is merged** (until then keep it with `nav: 'hidden'`) |
| `public/js/core/nav.js` (new) | builds rail, tab bar, Plus menu / sheet from `MODULES`; badges API `setNavBadge(path, { count, dot, tone })` |
| `public/js/core/routes.js` (new) | `routeRedirect(hash, { isAdmin, compact })`, pure, no import (4.2) |
| `public/js/core/userMenu.js` | account menu content (5.2): theme (light/dark/auto), language, Mon compte, tour, sign out; on compact its content is rendered in the Plus sheet |
| `public/js/core/dom.js` | new icons (`menu`, `back`, `chevronDown`, `dock`, `clipboard`, `record`, `filter`, `sun`, `moon`, `auto`, `escape`, `tab`, `arrowUp/Down/Left/Right`, `enter`, `phone-rotate`), `toast()` options (7.10) |
| `public/js/core/viewport.js` (new) | `--vvh`, `data-keyboard`, `isCompact()`, `isCoarse()`, `onViewportChange(fn)` |
| `public/js/shared/dialog.js` | sizes, sheet presentation on compact, scrim tap, Back closes (7.7) |
| `public/js/shared/tabs.js` | underline style, sticky, scrollable, `style` option |
| `public/js/shared/loadState.js` | skeletons, `emptyState()` |
| `public/js/shared/menu.js` (new) | 7.8 + `moreButton()` |
| `public/js/shared/sidePanel.js` (new) | 7.9 |
| `public/js/shared/dataList.js` (new) | 7.3 |
| `public/js/shared/pageHeader.js` (new) | 5.4, 7.12 |
| `public/js/shared/announcement.js` | placement and look (5.5) |
| `public/js/modules/collab/notifications.js` | only the placement of the bell (rail slot / Plus entry) through `core/nav.js`; its panel stays part A's |
| `public/locales/{fr,en}/common.json` | nav labels, Plus, theme auto, menu / sheet / dataList generic strings (`common.nav.*`, `common.plus.*`, `common.menu.more`, `common.sheet.close`, `common.list.actions`…) |
| `test/e2e/harness.js` | `waitForApp()` waits for `[data-nav]` links and the account button (not `#rail-items .rail-btn`); `signOut()` through the new account menu; helper `newPhonePage()` (touch, 390×844) |
| `test/e2e/ui-layout.e2e.js`, `test/e2e/contrast.js` | phone assertions for the tab bar (5 items, no sideways scroll, safe area), 12 px text floor, contrast in both themes on the shell |
| `test/navRoutes.test.js` (new) | redirect table |
| `docs/v2/ARCHITECTURE.md` §8 | navigation model, tokens, shared components |

Done when: every section still renders inside the new frame (their inner
markup unchanged), the old rail tests pass with the new selectors, the
tab bar has exactly five items at 390 px, the Plus sheet and the account menu
work with the keyboard and a screen reader, dialogs are sheets at 390 px,
`npm run lint`, `npm test`, `npm run test:e2e` pass.

To keep A, B, C independent the shell also publishes, before they start, the
**contracts** they consume: `pageHeader()`, `dataList()`, `openMenu()` /
`moreButton()`, `sidePanel()`, `emptyState()`, `setNavBadge()`,
`core/viewport.js`, the token names. A part that needs a change in a shared
file asks the orchestrator; it does not edit it.

### 11.2 Shared rules for A, B, C

- Use the new tokens and components only; delete the old classes you stop
  using in your own CSS files.
- Every new string: `fr` and `en`, French first, written for students (no
  "cliquez" on something a phone also shows; no "…" in labels).
- Each part adds phone (390×844, touch) and desktop (1440×900) e2e checks for
  its screens: no horizontal overflow, targets ≥ 44 px on the phone for its
  primary flows, AA contrast in both themes (existing helpers).
- No part edits `main.js`, `core/*`, `shared/dialog.js`, `shared/tabs.js`,
  `shared/menu.js`, `shared/dataList.js`, `shared/pageHeader.js`,
  `shared/sidePanel.js`, `shared/loadState.js`, `css/tokens.css`,
  `css/app.css`, `css/shared.css`, `locales/*/common.json`.

### 11.3 Part A: the Consoles page and the terminal

Owns:

- `public/js/modules/consoles/*` (index, diagramView, labPicker → replaced by
  `benchPicker.js`, quickOpen, livePanel, benchWall, journalDialog; new
  `deviceList.js`, `consoleScreen.js` for the phone console screen, `dock.js`)
- `public/js/shared/workspace.js`, `terminalPane.js`, `pane.js`,
  `presenceBar.js`, `paneActions.js`, `splitView.js`, `taskBar.js`,
  `vncPane.js`, `sessions.js`, `diagramLayers.js`, `broadcastDialog.js`,
  `historyDialog.js`, `scriptDialog.js`, `scriptLibrary.js`; new
  `shared/terminalKeys.js` (toolbar + line input, 9)
- `public/js/modules/collab/*` except the bell placement (benchPanel →
  Discussion side panel, notes, notifications panel)
- `public/js/modules/checks/*` (dialog and layers), `public/js/modules/recovery/*`
  (pane action UI)
- `public/css/consoles.css`, `terminal.css`, `collab.css`, `checks.css`,
  `recovery.css`
- `public/locales/{fr,en}/consoles.json`, `terminal.json`, `collab.json`,
  `checks.json`, `recovery.json`
- `test/e2e/student-console.e2e.js`, `shared-console.e2e.js`,
  `terminal.e2e.js`, `i18n-console.e2e.js`, `collab.e2e.js`, `checks.e2e.js`,
  `recovery.e2e.js`, `together.e2e.js` (console parts), new
  `test/e2e/phone-console.e2e.js`

Consumes from B: `mountBenchBar(host, { variant: 'strip' })` with the existing
API plus `openSheet()`; until B lands, the current bench bar is hosted as is.

Delivers 8 and 9.

### 11.4 Part B: team, bench, reservations, backups and jobs

Owns:

- `public/js/modules/teams/*` (index, benchBar → strip + sheet, data, tabs
  `mine.js`, `calendar.js`, `all.js`, new `tabs/bench.js`)
- `public/js/modules/jobs/*` (index, dialogs, layer, text)
- `public/css/teams.css`, `jobs.css`
- `public/locales/{fr,en}/teams.json`, `benches.json`, `jobs.json`
- `test/e2e/teams.e2e.js`, `jobs.e2e.js`, `wave3.e2e.js` (jobs parts), new
  `test/e2e/phone-team.e2e.js`

Delivers 7.13, 10.2–10.6. Keeps the strip's API stable for A.

### 11.5 Part C: home and overview, admin with infra and lab status, help, login, join / reset, my account

Owns:

- `public/js/modules/overview/*` (home absorbs the overview list; `index.js`
  becomes the Le labo block used by home), `admin/*` (index → grouped nav and
  hub, tabs restyled with `dataList`), `infra/*`, `proxmox/*`, `status/*`,
  `help/*` (content, tour), `account/*`
- `public/js/login.js`, `join.js`, `notFound.js`, and the `<body>` markup of
  `login.html`, `join.html`, `404.html` (the shell has already changed their
  `<head>`)
- `public/css/overview.css`, `admin.css`, `accounts.css`, `auth.css`,
  `help.css`, `login.css`
- `public/locales/{fr,en}/overview.json`, `admin.json`, `infra.json`,
  `accounts.json`, `auth.json`, `help.json`
- `test/e2e/overview.e2e.js`, `admin.e2e.js`, `accounts.e2e.js`,
  `login.e2e.js`, `help.e2e.js`, `anonymous.e2e.js`, `wave4.e2e.js`
  (overview / help parts), new `test/e2e/phone-admin.e2e.js`

Delivers 10.1, 10.7–10.12. When C is merged, the shell's `MODULES` entry for
`#/overview` is removed by the orchestrator (the redirect stays).

### 11.6 Shared test files

`test/e2e/ui-layout.e2e.js`, `ui-failures.e2e.js`, `shared-ui.e2e.js` and
`harness.js` belong to the shell. A part that changes the markup they rely on
(a section's failure block, a header) adjusts its own section's entries there
**in its own commit, touching only its lines**; the orchestrator merges these
three files by hand if two parts touch them.

### 11.7 Order

1. S (shell) → merge on `v2`, release candidate checked at 390 / 768 / 1440 in
   both themes.
2. A, B, C in parallel, each on `lot/ux-a`, `lot/ux-b`, `lot/ux-c` from the
   merged shell.
3. Merge B, then A (it consumes the strip), then C; remove the aliases of 6.5
   no file uses any more; final audit with the same scenes as section 2.

## 12. Acceptance checks

Measured with the audit scenes of section 2 (390×844 touch, 768×1024 touch,
1440×900, light and dark):

- Navigation: 5 items in the phone tab bar, no sideways scroll; 5 main
  entries + Plus in the rail; every old address of 4.2 lands where the table
  says.
- No horizontal overflow of the page or of a section at 390 px.
- On a coarse pointer, no interactive element under 44 × 44 px in the
  primary flows (open a console, type, take / release a bench, answer a
  request, back up, invite, reserve, validate an account).
- Consoles, desktop 1440×900: diagram area ≥ 70 % of the viewport height with
  no console open; nothing overlays the diagram unless the user opened it.
- Consoles, phone: device tiles ≥ 36 px at the initial zoom (or the list view
  is used); a console opens full screen with at least 20 terminal rows with
  the keyboard closed and 8 with it open; Tab, Ctrl+C, arrows, ? and a whole
  command can be sent without the phone keyboard's own keys.
- Text ≥ 12 px everywhere; AA contrast in both themes (`contrastFailures`
  empty for every section).
- Every new string exists in `fr` and `en` (the parity test passes).
- `npm run lint`, `npm test`, `npm run test:e2e` (three runs in a row) pass.

## 13. Using the components (as delivered by the shell)

What part S built, and how a part uses it. Everything is in
`public/css/tokens.css`, `public/css/app.css` (base components),
`public/css/shared.css` (components with behaviour, loaded by `main.js` at
start-up) and `public/js/shared/`, `public/js/core/`. A part does not
restyle these in its own CSS file; it asks for a variant.

### 13.1 Tokens

Use the roles of 6.5 (`var(--surface)`, `var(--text-2)`, `var(--accent-strong)`…)
and the spacing scale (`var(--sp-4)`), never a hexadecimal value or a pixel
value outside the scale. Type tokens are full `font` shorthands:
`font: var(--fs-title)`, `font: var(--fs-small)`; `--fs-body` and `--fs-title`
already change on a phone and on a touch screen. `--tap` is the minimum
height of anything interactive (32 px with a mouse, 44 px with a finger):
`min-height: var(--tap)`. `--gutter` is the side margin of the breakpoint.
The old names (`--ink`, `--line`, `--console`, `--paper`…) are aliases that
go away in the final cleanup: do not write new code with them.

The theme on screen is `data-theme="light|dark"` on `<html>`; the person's
choice (`light`, `dark`, `auto`) is `core/theme.js` (`setTheme`,
`themePref`), and `themechange` fires on `window` when the theme on screen
changes. `core/viewport.js`: `isCompact()` (< 720 px), `isCoarse()`,
`onViewportChange(fn)`; it keeps `--vvh` (visual viewport height) and
`data-keyboard="open"` on `<html>`. `data-chrome="immersive"` on `<html>`
hides the phone's tab bar (the full-screen console of part A sets it).

### 13.2 A section's frame

```js
import { pageHeader } from '../../shared/pageHeader.js';

const header = pageHeader({
  title: 'jobs.title',                                  // key or function: the <h1>
  context: () => t('jobs.context', { bench }),           // optional line under it
  primary: { id: 'backup', label: 'jobs.actions.backup', icon: 'download', run: backup },
  actions: [                                             // two buttons from 720 px, the rest in ⋯
    { id: 'inject', label: 'jobs.actions.inject', icon: 'upload', run: inject },
    { id: 'reset', label: 'jobs.actions.reset', icon: 'refresh', run: reset, danger: true },
    { id: 'search', label: 'jobs.actions.search', icon: 'search', run: search, bar: true }, // stays an icon on a phone
  ],
  back: '#/admin',                                       // optional: a back arrow
  tabs: true,                                            // optional: header.tabBar for mountTabs
  full: false,                                           // true: no 1280 px limit (Consoles)
});
const body = h('div.view-body', …);                      // the section's only scroll container
el.append(header.el, body);
const tabs = mountTabs(body, [...], { navigate, base: '#/jobs', bar: header.tabBar });
header.update({ context, primary, actions });           // later, any of them
header.setBadge('search', 2);
```

- `.view-body` scrolls; the header above it never moves, and the shell keeps
  each section's scroll position when the person goes elsewhere. Content is
  centred and at most 1280 px wide; `.view-body.full` drops the limit,
  `.view-body.flush` the padding (a canvas). `.stack` (24 px) and
  `.stack.tight` (12 px) space blocks vertically.
- On a phone the header is the 56 px app bar: the title, the back arrow, the
  actions with `bar: true` as icons (two at most), ⋯ with every other
  secondary action, and the primary as a full-width 48 px button under it.
- The announcement banner is placed by the shell right under `.page-header`
  (or the old `.view-head`) of the section on screen.
- Sections not rebuilt yet keep `header.view-head`; it is restyled (22 px
  title, no white band) but has no phone app bar.

### 13.3 Buttons, cards, badges, chips, avatars, forms

Classes, no JavaScript:

| need | markup |
|---|---|
| the action of the screen | `button.btn.primary` (`.lg` on a phone footer, `.block` full width) |
| another action | `button.btn`; `.ghost` without border; `.danger` (red text) leads to a destructive action; `.danger-solid` only confirms one |
| a dense row | `.btn.sm` (32 px, 44 on touch) |
| an icon alone | `button.icon-btn` with `aria-label` and `title`; `aria-pressed` for a toggle |
| busy | `aria-busy="true"` on the button: its first icon becomes a spinner |
| a block of content | `.card` › `.card-head` (`h2` + `.card-meta` + `.card-actions`), `.card-body`, `.card-foot`; `.card-section` for a group inside; `a.card.link` when the whole card leads somewhere; `.card.hero[data-tone="success|danger|warning"]` |
| a status | `span.badge[data-tone="success|warning|danger|info|neutral"]` (a word, never colour alone; `span.dot` inside for the LED) |
| a count | `span.count` (`data-tone="danger"` when it needs action) |
| a filter | `button.chip[aria-pressed]` in a `.chips` row |
| a person | `span.avatar` (24 px; `.md` 32, `.lg` 40; `.pilot` ring) with `style.background = user.color`; `.avatar-stack` + `.avatar-more` "+n" |
| 2–4 views or filters | `.seg` › `button.seg-btn[aria-pressed|aria-selected|aria-checked]`; `.seg.fill` full width, `.seg.fill-compact` full width on a phone only |
| a field | `input.field`, `select.field`, `textarea.field` in a `label` of a `.form-grid`; `small` or `.field-hint` under it, `.form-error` for the error, `span.optional` for "(facultatif)" |

### 13.4 Lists: `dataList()`

```js
import { dataList } from '../../shared/dataList.js';
const list = dataList({
  label: () => t('jobs.snapshots.title'),
  columns: [
    { id: 'name', label: 'jobs.cols.name', cell: (r) => r.name, primary: true },
    { id: 'when', label: 'jobs.cols.date', cell: (r) => fmtShort(r.at), meta: true },
    { id: 'state', label: 'jobs.cols.state', cell: (r) => stateBadge(r), badge: true },
    { id: 'devices', label: 'jobs.cols.devices', cell: (r) => r.devices.length, num: true, hideCompact: true },
  ],
  actions: (r) => [
    { id: 'zip', label: 'jobs.actions.zip', icon: 'download', run: () => zip(r), primary: true },
    { id: 'view', label: 'jobs.actions.view', icon: 'search', run: () => view(r) },
    { id: 'delete', label: 'jobs.actions.delete', icon: 'trash', run: () => remove(r), danger: true },
  ],
  empty: { icon: 'archive', title: 'jobs.snapshots.noneTitle', text: 'jobs.snapshots.none', action: { label: 'jobs.actions.backup', run: backup } },
  onOpen: (r) => openDetail(r),   // optional
  dense: false,                   // admin tables: 44 px rows, one card with dividers on a phone
});
list.render(rows);
```

One `<table>` (so the header and the body always line up). From 720 px: a
table, the primary action and the next safe one as buttons, the rest in ⋯.
Below: one card per row (title = `primary`, `badge` at the right, `meta`
lines, `hideCompact` left out), the primary action and ⋯ with the others.
Row selection is not part of it yet: a part that needs it adds a checkbox
column and a "Sélectionner" entry in its header's ⋯.

### 13.5 Menus, dialogs, sheets, side panels

```js
import { openMenu, moreButton } from '../../shared/menu.js';
const id = await openMenu(button, [
  { group: 'consoles.tools.title' },
  { id: 'checks', label: 'consoles.tools.checks', icon: 'check' },
  'separator',
  { id: 'reset', label: 'jobs.actions.reset', icon: 'refresh', danger: true, disabled: !may, hint: 'jobs.hints.reset' },
], { label: t('consoles.tools.title') });           // → the id, or null
toolbar.append(moreButton(() => items, { onSelect: (id) => … }));
```

A popover from 720 px (arrows, Home / End, a letter, Escape gives the focus
back), a sheet of 52 px rows on a phone. An item may carry `run` or `href`.

`shared/dialog.js` keeps its API (`openDialog`, `confirmDialog`,
`formDialog`) and gains `size`: `'sm'` (confirmations, the default of
`confirmDialog`), `'md'` (the default), `'lg'` (`wide: true`), `'full'`.
From 720 px a centred dialog; on a phone a bottom sheet (`lg` and `full`:
the whole height), with large footer buttons. A tap on the scrim closes a
dismissible dialog. On a phone, Back closes the sheet on top: `closed`
settles once the history is back in place, so `await dlg.closed; location.hash = …`
is safe. The footer of `confirmDialog` / `formDialog` is `.form-actions`; a
dialog of its own puts its buttons in a `.form-actions` at the end of its
`.modal-body` to get the same sticky footer.

```js
import { sideHost, sidePanel } from '../../shared/sidePanel.js';
const host = sideHost(canvasArea);                  // wraps the content that shrinks
const live = sidePanel(host, { title: 'consoles.live.title', footer: composer });
live.body.append(feed);  live.toggle();  live.setCount(2);  live.onToggle((open) => button.setAttribute('aria-pressed', open));
```

A 360 px column that resizes the content from 1200 px, a drawer over it with
a scrim from 720 px, a full-height sheet on a phone; one open per host.

### 13.6 Tabs, load states, toasts, navigation

- `mountTabs(…, { style: 'underline' })` is the default now (sub-pages);
  `style: 'segmented'` keeps a `.seg` (views of one screen). The strip
  scrolls sideways on a phone and keeps the chosen tab in view.
- `loading()` shows skeleton rows after 300 ms (nothing before);
  `loadFailure()` is unchanged in behaviour; `emptyState({ icon, title, text,
  action })` for every list or card that can be empty.
- `toast(message, kind, ms, { action: { label, run } })`, kind `info`,
  `success`, `warn` or `error`; every toast has ✕, an error with an action
  stays until it is dismissed.
- `core/nav.js`: `setNavBadge(path, { count } | { dot: true, tone } | null)`
  puts a badge on a destination of the rail and the tab bar (the phone's
  Plus shows a dot for what it holds); `registerPlusEntry({ id, icon, label,
  hint, run, order })` adds a row to the phone's Plus sheet; `navSlot('alerts')`
  is the rail's place for the bell. Items carry `data-nav="<path>"` in the
  rail and in the tab bar alike (`data-nav="plus"` for Plus): the guided tour
  and the tests target those.
- Icons added for the parts (`ICONS` in `core/dom.js`): `menu`, `back`,
  `chevronDown`, `chevronUp`, `collapse`, `expand`, `dock`, `clipboard`,
  `record`, `filter`, `sun`, `moon`, `auto`, `escape`, `tab`, `arrowUp`,
  `arrowDown`, `arrowLeft`, `arrowRight`, `enter`, `phone-rotate`, `info`,
  `error`, `success`, `logout`, `language`, `tour`.

### 13.7 Tests

`h.newPhonePage()` (or `h.newPage({ phone: true })`) opens a touch page of
390 × 844. `waitForApp()` waits for the navigation of either layout;
`openAccountMenu(page)` opens the account menu (the Plus sheet on a phone);
`signOut()` and `setLanguage()` go through it. `tinyText()` now reports text
under 12 px. A sheet or a menu animates in: wait for its animations to finish
before measuring it (`test/e2e/ui-layout.e2e.js`, `settled()`).
