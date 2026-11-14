# Lab Console: a guide for students and teachers

**English** · [Français](fr/ETUDIANTS.md)

Lab Console gives you the consoles of the lab's routers and switches in your
browser. The **Aide** (Help) page of the application says the same things, and
a short guided tour starts at your first sign-in (replay it from the user menu).

## Signing in

Use the sign-in button of your school's identity provider. If your teacher
gave you an invitation link, open it, choose a user name and a password, then
sign in with **Local account**. A passkey can be added on **My account** to sign
in with one click. There is no e-mail: if you forget a password, ask an
administrator for a reset link.

## Consoles

1. Pick a lab and a bench, then click a device on the diagram: its console
   opens next to it. Open several to work side by side. `Ctrl K` (or `/`)
   finds a device in any lab.
2. A console line is shared. If someone else has it open you join it and see
   the same screen; **one person types** (the pilot), the others watch. Ask for
   the keyboard with the button of the tile: the pilot answers, or it passes
   after 30 seconds, or at once if the pilot has been idle for 2 minutes.
3. A line closes 30 seconds after the last person leaves, or after an hour
   without typing.
4. `Ctrl Shift C` copies, `Ctrl V` pastes (a long paste is sent line by line so
   the device does not lose characters). *Send BREAK* is a button; `Ctrl+]`
   never reaches the device.
5. **History** searches what a console printed. **Export config** saves the
   running-config. **Inject script** and **send to several consoles** send
   lines to your devices. The **script library** keeps your scripts, your
   team's and the published ones.

## Teams and benches

- In **Team**, create a team and invite classmates by user name (up to 8
  members, pending invitations counted).
- A member **takes a bench** for the team. While a team holds it, only its
  members, their accepted guests and administrators open or drive its consoles;
  anyone can still watch a line already open. An unused bench is released
  after 3 hours (the setting may differ).
- A teacher can lock a bench, with a reason. The **calendar** of a bench lets
  a team reserve slots and warns before another team's slot.
- Each device has a **note** everyone reads on the diagram and the bench's
  occupants write; each bench has a small **chat** for its occupants.
  Notifications (the bell) tell you when someone asks for the keyboard, a line
  is free or a job is finished, only while the window is not in front.

## Backups, injection and reset (Sauvegardes)

Jobs work on the whole bench, run on the server and everyone sees them live.

- **Backup**: running-config, VLANs and VTP of every device, kept as a
  snapshot of your team. **Download the ZIP right away**: the server is not
  your backup. Snapshots can be listed, read, compared (two snapshots, or one
  against the live devices) and searched.
- **Injection**: shows the exact script of each device, then reads the device
  back and compares.
- **Reset**: says what will be erased and who is on the consoles, wants the
  bench name typed and counts down 10 seconds during which anyone may cancel.
  A device is never erased without a verified backup.
- Teachers publish **TP templates** from a backup (or import a ZIP). Only Cisco
  IOS / IOS XE devices are touched.
- When a bench is released, its team may take a backup for 30 minutes.

## Checks and password recovery

- **Vérifications** (button above the diagram): line status, cabling against
  the diagram, ping matrix between the routers, interface addresses. Read-only
  commands; a line someone uses is never touched.
- **Password recovery** (button on a console tile): a guided procedure for a
  device locked by an unknown password. It needs someone on site to power the
  device off and on. The startup-config is bypassed for one boot, never erased.
  It has not been tried on every real model yet, and says so.

## Home, overview and help

**Accueil** is the page after sign-in: your team, your invitations, your bench
and its latest backups and activity, your next slots. **Vue d'ensemble** shows
one live card per bench. **Aide** explains each section.

## Good habits

- Download your backups. Do not rely on a console staying as you left it.
- Only the team holding a bench may change its devices: ask before you join a
  line that belongs to someone else.
- Never type a password you care about in a console: the output of the devices
  (not what you type) is kept in the journal for 14 days by default, and read
  by the people who were on that console that day, their team and the
  administrators.
- Passwords of the lab are never shown to you; do not look for them.
