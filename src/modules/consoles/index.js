/**
 * "Lab consoles" feature module: diagram API, shared console rooms, the
 * console WebSocket, the console journal and "tell me when it is free"
 *
 * Contract every platform module follows (see src/modules/index.js):
 *   { id, title, enabled, router?, upgrade?(req, socket, head) → boolean, shutdown?() }
 *
 * WebSocket protocol on /ws/console?device=<key>&cols=<n>&rows=<n>[&mode=wall]
 *   server → client  binary frame  raw terminal bytes
 *                    text frame    {"type":"status","phase","message","code","params"}   phase: ssh | telnet | connected | login | silent
 *                                  {"type":"error","message","code","params"}   (refused: the socket closes)
 *                                  {"type":"exit","message","code","params"}    (the line ended)
 *                                  {"type":"replay","bytes"} then one binary frame: the recent output
 *                                  {"type":"presence","users","pilot","you","canPilot","mayType","shared","task","pending","state"}
 *                                  {"type":"control","event","by","to",…}       request | granted | denied | released |
 *                                                                               timeout | idle | takeover | left | shared |
 *                                                                               unshared | cancelled | superseded | task | free
 *                                  {"type":"control-refused","action","code","params"}   an action of yours was refused
 *                    `message` is the English sentence; `code` is stable (`consoles.<reason>`) and
 *                    `params` fill its placeholders: the browser translates by code
 *   client → server  text frame    {"type":"input","data"} | {"type":"resize","cols","rows"} | {"type":"break"}
 *                                  {"type":"control","action":"request"|"grant"|"deny"|"release"|"take"|"share"|"unshare"|"hangup","to"?}
 *                                  {"type":"export-config"} | {"type":"inject",…} | {"type":"automation-cancel"}
 *                                  {"type":"paste","script",options} | {"type":"broadcast","batch","script",options}
 *                                  (src/lib/automationProtocol.js: through the room, paced; a paste needs the
 *                                  keyboard, a broadcast needs to be the pilot of this very console)
 *   `mode=wall` attaches read-only to a line someone already opened (bench wall tiles):
 *   no keyboard, no control (`control-refused` consoles.wall_read_only), no automation,
 *   not counted in the per-user limit, refused when the line is not open
 *
 * The browser only ever names a device *key* from the diagram. Host and port
 * are resolved here, from the server's own copy of the diagram, and checked
 * against the allow-list of the lab settings - the client cannot make the
 * jump server dial anything else
 */
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import { LabRegistry } from './labRegistry.js';
import { RoomManager, targetKey, targetAllowed } from './roomManager.js';
import { ConsoleJournal } from './journal.js';
import { LineWatch, sshProbe } from './lineWatch.js';
import { SshPool } from '../../lib/sshPool.js';
import { createRateLimiter } from '../../lib/security.js';
import { createAutomationHandler, MAX_SCRIPT_BYTES } from '../../lib/automationProtocol.js';
import { httpError } from '../../lib/httpError.js';
import { plainLines, plainText, searchLines } from '../../lib/terminalText.js';
import { HISTORY_LIMITS, readableSessions, sessionsOfConsole, daysOf, searchSessions, dayText } from './history.js';

const ACTIVITY_KEPT = 100;
const WATCHES_PER_USER = 10;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SESSION = /^\d{6}(?:-\d{1,4})?$/;

/**
 * @param options  test seam: room timings ({ graceMs, controlTimeoutMs, pilotIdleMs, silentMs, sweepMs }),
 *                 watch timings ({ watchRetryMs, watchMaxMs }), `now`
 */
export function createConsolesModule({ config, events, logger, infra, services = {}, store, repos, audit, settings, diagrams }, options = {}) {
  const log = logger.child('consoles');
  const now = options.now ?? (() => Date.now());
  const lab = () => settings.get('lab');
  const isTargetAllowed = (t) => targetAllowed(lab().consoles, t);

  // The active diagram is the data directory's (deps.diagrams); an activation or a new allow-list reloads it
  const registry = new LabRegistry({ diagramPath: diagrams?.currentPath ?? config.diagramPath, networkPrefix: config.consoles.networkPrefix, isTargetAllowed, logger: log });
  const stopFollowing = [
    diagrams?.on('change', () => registry.load()),
    settings.on('change', (ns) => { if (ns === 'lab') registry.load(); }),
  ];

  /**
   * Who may drive a console: the bench rule of the teams lot when it is
   * there, otherwise every signed-in user; never an account the directory
   * holds as disabled (a running task of theirs stops at its next byte).
   * The only place this is decided
   */
  const mayPilot = (user, device) => {
    const account = user?.id ? services.accounts?.get?.(user.id) : null;
    if (account && account.state !== 'active') return false;
    const benches = services.benches;
    return typeof benches?.canPilot === 'function' ? Boolean(benches.canPilot(user, device)) : Boolean(user);
  };

  const pool = new SshPool({ channelsPerConnection: config.rooms.channelsPerConnection, logger: log });
  const journal = new ConsoleJournal({
    store,
    days: repos?.journalDays ?? null,
    ...config.rooms.journal,
    now,
    teamOf: (bench) => services.benches?.holder?.(bench)?.teamId ?? null,
    logger: log,
  });
  const rooms = new RoomManager({
    settings, pool, journal, limits: config.limits, canPilot: mayPilot, options: options.rooms ?? {}, now, logger: log,
  });
  const watch = new LineWatch({
    probe: sshProbe({ pool, settings }),
    isOpen: (target) => Boolean(rooms.get(target)),
    notify: (userId, payload) => events.toUser(userId, 'consoles:free', payload),
    onFree: (target) => rooms.markFree(target),
    retryMs: options.watchRetryMs,
    maxMs: options.watchMaxMs,
    now,
    logger: log,
  });
  const allowOpen = createRateLimiter({ limit: config.limits.opensPerMinute, windowMs: 60_000 });

  // Admin switches: console devices that live outside the lab diagrams; the list is editable, read it each time
  const adminSwitches = () => infra.adminSwitches.map((s) => ({ ...s, allowed: isTargetAllowed(s.target) }));
  for (const s of adminSwitches()) {
    if (!s.allowed) log.warn(`admin switch ${s.labName}: ${s.target.host}:${s.target.port} is outside the allow-list (disabled)`);
  }
  const findDevice = (key) => (key.startsWith('admin:') ? adminSwitches().find((s) => s.key === key) : registry.getDevice(key)) ?? null;

  // ── Live feeds ────────────────────────────────────────────────────────────
  const activity = [];
  registry.on('change', (model) => events.publish('labs:version', { version: model.version, error: model.error }, { sticky: true }));
  rooms.on('change', (list) => events.publish('consoles:rooms', list, { sticky: true }));
  rooms.on('busy', (targets) => events.publish('consoles:busy', targets, { sticky: true }));
  rooms.on('activity', ({ actor, ...entry }) => {
    // Activity on a console keeps its bench from being released as idle (one write a minute at most)
    try { services.benches?.touch?.(entry.bench); } catch (err) { log.warn(`bench activity of ${entry.bench}: ${err.message}`); }
    if (entry.kind !== 'command') {
      activity.push(entry);
      if (activity.length > ACTIVITY_KEPT) activity.shift();
    }
    events.publish('consoles:activity', entry);
    auditActivity(actor, entry);
  });
  registry.load();
  registry.watch();
  events.publish('consoles:busy', [], { sticky: true });
  events.publish('consoles:rooms', [], { sticky: true });

  function auditActivity(actor, entry) {
    const details = { bench: entry.bench, device: entry.device, target: entry.target };
    const by = actor ?? 'system';
    if (entry.kind === 'open' || entry.kind === 'join' || entry.kind === 'freed') audit.log(by, `console.${entry.kind}`, details);
    else if (entry.kind === 'control' && entry.event !== 'request') audit.log(by, `console.control.${entry.event}`, details);
    else if (entry.kind === 'task' && entry.state === 'start') audit.log(by, 'console.task', { ...details, task: entry.label });
  }

  // Journal retention (daily) and global cap (hourly); both also run once at start
  const sweepJournal = () => journal.sweep().catch((err) => log.warn(`journal sweep: ${err.message}`));
  const capJournal = () => journal.enforceCap().catch((err) => log.warn(`journal cap: ${err.message}`));
  const journalSweep = setInterval(sweepJournal, 24 * 3_600_000);
  journalSweep.unref();
  const journalCap = setInterval(capJournal, 3_600_000);
  journalCap.unref();

  /** Targets that appear on several lab pages (a device shared between benches) */
  function sharedTargets() {
    const benchesOf = new Map();
    for (const l of registry.model.labs) {
      for (const d of l.devices) {
        const k = targetKey(d.target);
        if (!benchesOf.has(k)) benchesOf.set(k, new Set());
        benchesOf.get(k).add(l.name);
      }
    }
    return new Set([...benchesOf].filter(([, names]) => names.size > 1).map(([k]) => k));
  }

  // What other modules may use (ARCHITECTURE §7); read lazily, inside handlers
  services.consoles = {
    registry, rooms, sharedTargets, journal,
    /** The SSH connections the console lines share: { connections, channels, channelsPerConnection, lines: [{ key, channels, capacity, state }] } */
    pool: () => ({ ...pool.size, channelsPerConnection: config.rooms.channelsPerConnection, lines: pool.stats() }),
  };

  // ── HTTP API ──────────────────────────────────────────────────────────────
  const router = express.Router();
  const json = express.json({ limit: '2kb' });
  router.get('/labs', (_req, res) => {
    const { labs, warnings, version, error } = registry.model;
    res.set('Cache-Control', 'no-store').json({ labs, warnings, version, error, journal: { retentionDays: config.rooms.journal.retentionDays } });
  });
  router.get('/admin-switches', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ switches: adminSwitches() });
  });
  router.get('/rooms', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ rooms: rooms.list(), busy: rooms.busyOutside() });
  });
  router.get('/activity', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ activity: [...activity].reverse() });
  });

  // "Tell me when it is free"
  router.get('/notify', (req, res) => res.json({ watches: watch.list(req.user) }));
  router.post('/notify', json, (req, res) => {
    const key = typeof req.body?.device === 'string' ? req.body.device : '';
    const device = key && findDevice(key);
    if (!device) throw httpError(404, 'consoles.device_gone', 'This device no longer exists. Reload the page.');
    if (!isTargetAllowed(device.target)) throw httpError(403, 'consoles.not_allowed', `${device.name}'s console address is not on the platform's allow-list.`, { name: device.name });
    const mine = watch.list(req.user);
    if (mine.length >= WATCHES_PER_USER && !mine.some((w) => w.target === targetKey(device.target))) {
      throw httpError(429, 'consoles.too_many_watches', `You are already waiting for ${WATCHES_PER_USER} lines.`, { max: WATCHES_PER_USER });
    }
    res.json(watch.start(req.user, device));
  });
  router.delete('/notify/:target', (req, res) => {
    if (!watch.stop(req.user, req.params.target)) throw httpError(404, 'consoles.no_watch', 'You were not waiting for this line.');
    res.json({ ok: true });
  });

  // Console journal: the sessions this user may read, and one session as a file
  const teamOfUser = (user) => services.teams?.teamOf?.(user)?.id ?? null;
  // Read rights cover a console's whole day (owner decision): a day is readable when any of its sessions is
  router.get('/journal', async (req, res) => {
    const sessions = readableSessions(journal, await journal.list(), req.user, teamOfUser)
      .map(({ benchDir, deviceDir, day, session, bench, device, from, to, bytes, truncated, meta }) => ({
        id: `${benchDir}/${deviceDir}/${day}/${session}`, bench, device, day, from, to, bytes, truncated,
        people: [...new Set([...Object.values(meta.attended ?? {}), ...Object.values(meta.watched ?? {})].map((p) => p.name))],
        pilots: Object.values(meta.pilots ?? {}).map((p) => p.name),
      }));
    res.set('Cache-Control', 'no-store').json({ sessions, retentionDays: config.rooms.journal.retentionDays });
  });
  router.get('/journal/:bench/:device/:day/:session', (req, res) => {
    const { bench, device, day, session } = req.params;
    if (!DAY.test(day) || !SESSION.test(session) || store.safeName(bench) !== bench || store.safeName(device) !== device) {
      throw httpError(400, 'consoles.bad_journal', 'Unknown journal');
    }
    const meta = journal.meta(bench, device, day, session);
    if (!meta) throw httpError(404, 'consoles.no_journal', 'There is no such console journal.');
    if (!journal.canReadDay(req.user, journal.dayMetas(bench, device, day), teamOfUser)) {
      throw httpError(403, 'consoles.journal_forbidden', 'Only the people who were on this console that day, their team and the admins may read its journal.');
    }
    const { log: file } = journal.paths(bench, device, day, session);
    if (!fs.existsSync(file)) throw httpError(404, 'consoles.no_journal', 'There is no such console journal.');
    audit.log(req, 'console.journal.download', { bench: meta.bench, device: meta.device, day, session });
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="journal_${bench}_${device}_${day}_${session}.log"`,
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });

  // ── History of a console: its room's recent output, and the journal ───────
  //   GET /history?device=<key>[&q=<text>][&case=1]   the days of journal this person may read, and the lines holding q
  //   GET /history/download?device=<key>              the room's recent output, as a text file (people on the console only)
  //   GET /history/download?device=<key>&day=<day>    that day of the journal, as one text file
  // The room's output is read by whoever is attached to it (it is replayed to them anyway); a journal day by
  // the rule of the journal (canReadDay). A search is plain text, never a pattern
  const allowHistory = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const historyOf = (req) => {
    if (!allowHistory(req.user.id)) throw httpError(429, 'consoles.too_many_searches', 'Too many searches in the last minute. Wait a moment and try again.');
    const device = typeof req.query.device === 'string' ? findDevice(req.query.device) : null;
    if (!device) throw httpError(404, 'consoles.device_gone', 'This device no longer exists. Reload the page.');
    return { device, target: targetKey(device.target), room: rooms.get(targetKey(device.target)) };
  };
  const journalOf = async ({ device, target }, user) => {
    const ofConsole = sessionsOfConsole(await journal.list(), { target, bench: device.labName, device: device.name });
    return { ofConsole, readable: readableSessions(journal, ofConsole, user, teamOfUser) };
  };

  router.get('/history', async (req, res) => {
    const found = historyOf(req);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (query.length > HISTORY_LIMITS.query || (query && !query.trim())) throw httpError(400, 'consoles.bad_query', `A search is 1 to ${HISTORY_LIMITS.query} characters.`, { max: HISTORY_LIMITS.query });
    const matchCase = req.query.case === '1';
    const attached = Boolean(found.room?.isAttached(req.user.id));
    const lines = attached ? plainLines(found.room.scrollback) : [];
    const { ofConsole, readable } = await journalOf(found, req.user);
    res.set('Cache-Control', 'no-store').json({
      device: { bench: found.device.labName, name: found.device.name },
      live: { open: Boolean(found.room), attached, lines: lines.length, ...(query && attached ? searchLines(lines, query, { matchCase, limit: HISTORY_LIMITS.matches }) : {}) },
      journal: {
        exists: ofConsole.length > 0,
        allowed: readable.length > 0,
        days: daysOf(readable),
        ...(query && readable.length ? await searchSessions(journal, readable, query, { matchCase }) : {}),
      },
    });
  });

  router.get('/history/download', async (req, res) => {
    const found = historyOf(req);
    const { device } = found;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
    const fileName = (...parts) => `${parts.map((p) => String(p).replace(/[^\w.-]/g, '_')).join('_')}.txt`;
    const send = (name, text) => res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
    }).send(text);

    if (req.query.day === undefined) {
      if (!found.room) throw httpError(404, 'consoles.room_gone', `Nobody has ${device.name}'s console open any more.`, { name: device.name });
      if (!found.room.isAttached(req.user.id)) throw httpError(403, 'consoles.history_forbidden', 'Only the people on this console may read what it shows.');
      audit.log(req, 'console.history.download', { bench: device.labName, device: device.name, source: 'screen' });
      return send(fileName('history', device.labName, device.name, stamp), plainText(found.room.scrollback));
    }
    const day = String(req.query.day);
    if (!DAY.test(day)) throw httpError(400, 'consoles.bad_journal', 'Unknown journal');
    const { ofConsole, readable } = await journalOf(found, req.user);
    if (!ofConsole.some((s) => s.day === day)) throw httpError(404, 'consoles.no_journal', 'There is no such console journal.');
    const sessions = readable.filter((s) => s.day === day);
    if (!sessions.length) throw httpError(403, 'consoles.journal_forbidden', 'Only the people who were on this console that day, their team and the admins may read its journal.');
    audit.log(req, 'console.journal.download', { bench: device.labName, device: device.name, day, session: 'all' });
    return send(fileName('journal', device.labName, device.name, day), await dayText(journal, sessions));
  });

  // ── WebSocket terminals ───────────────────────────────────────────────────
  // Room for the largest script the automation accepts (256 KB), in its JSON envelope
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SCRIPT_BYTES + 16 * 1024 });

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/console') return false;
    wss.handleUpgrade(req, socket, head, (ws) => onTerminal(ws, req, url));
    return true;
  }

  function onTerminal(ws, req, url) {
    const user = req.user;
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const refuse = (message, code, params = {}) => { send({ type: 'error', message, code, params }); ws.close(1008, 'refused'); };
    const readOnly = url.searchParams.get('mode') === 'wall';

    const key = url.searchParams.get('device') || '';
    const device = findDevice(key);
    const joining = device && rooms.get(targetKey(device.target));
    // Opening lines is what hammers the jump server; watching an open one is not limited
    if (!joining && !readOnly && !allowOpen(user.id)) return refuse('Too many consoles opened in the last minute. Wait a moment and try again.', 'consoles.rate_limited');
    if (!device) return refuse('This device no longer exists. Reload the page.', 'consoles.device_gone');

    let room;
    try {
      room = rooms.open(device, user, { cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows')), readOnly });
    } catch (err) {
      if (err.code) return refuse(err.message, err.code, err.params);
      return refuse(err.message, 'consoles.invalid_target', { detail: err.message });
    }

    const client = {
      user,
      readOnly,
      send,
      sendBytes: (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true }),
      close: () => ws.close(1000, 'session ended'),
    };
    let detach;
    try {
      detach = room.attach(client);
    } catch (err) {
      return refuse(err.message, err.code ?? 'consoles.room_closed', err.params ?? {});
    }

    // Export config / inject script: through the room, so the pilot is asked and spectators are refused
    const automation = createAutomationHandler({
      cli: room.cli,
      send,
      canExport: true,
      log,
      label: `${device.labName}/${device.name}`,
      run: (label, fn) => room.runExclusive(user, label, fn),
      cancel: () => room.cancelTask(user),
      busy: () => Boolean(room.task),
      report: (msg) => room.broadcast(msg),
      permit: {
        // A paste is typing: whoever may type may paste (the pilot, or anyone while the keyboard is shared)
        paste: () => (room.mayType(user) ? null : {
          message: `You cannot type in ${device.name} right now: ask for the keyboard first.`,
          code: 'consoles.paste_not_allowed', params: { name: device.name },
        }),
        // Several consoles at once is for the person who holds the keyboard of each: the pilot, not a typist of a shared keyboard
        broadcast: () => (room.pilot === user.id && room.mayType(user) ? null : {
          message: `You do not hold the keyboard of ${device.name}: nothing was sent there.`,
          code: 'consoles.broadcast_not_pilot', params: { name: device.name },
        }),
      },
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      // A wall tile only watches: no keys, no break, no size, no control, no automation, whoever
      // the person is (their own tab may hold the keyboard: this socket still does not)
      if (readOnly) {
        if (msg.type === 'control') send({ type: 'control-refused', action: String(msg.action ?? ''), code: 'consoles.wall_read_only', params: {} });
        return;
      }
      if (msg.type === 'input') room.write(user, msg.data);
      else if (msg.type === 'resize') room.resize(user, Number(msg.cols), Number(msg.rows));
      else if (msg.type === 'break') room.sendBreak(user);
      else if (msg.type === 'control') onControl(room, user, msg, send);
      else automation(msg);
    });

    // Tab closed / network dropped → leave the room (the line stays for the others, then the grace period)
    ws.on('close', () => detach());
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  }

  function onControl(room, user, msg, send) {
    const to = typeof msg.to === 'string' ? msg.to : null;
    const actions = {
      request: () => room.requestControl(user),
      grant: () => room.grantControl(to ?? room.presence(user).pending?.from.id, user),
      deny: () => room.denyControl(to, user),
      release: () => room.releaseControl(user),
      take: () => room.takeControl(user),
      share: () => room.setShared(user, true),
      unshare: () => room.setShared(user, false),
      hangup: () => room.hangUp(user),
    };
    const act = Object.hasOwn(actions, msg.action) ? actions[msg.action] : null;
    if (!act) return;
    const result = act();
    if (result && !result.ok) send({ type: 'control-refused', action: msg.action, code: result.code, params: result.params ?? {} });
  }

  // Detect half-open connections (laptop lid closed, Wi-Fi lost)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    id: 'consoles',
    title: 'Lab consoles',
    enabled: true,
    router,
    upgrade,
    rooms,
    // The journal's list of days, from the disk for days the table does not know yet; then retention and cap
    async start() {
      await journal.reconcile().catch((err) => log.warn(`journal: the days on disk were not listed (${err.message})`));
      await sweepJournal();
      await capJournal();
    },
    shutdown() {
      clearInterval(heartbeat);
      clearInterval(journalSweep);
      clearInterval(journalCap);
      for (const stop of stopFollowing) stop?.();
      registry.close();
      watch.close();
      rooms.shutdown('Platform is restarting', { code: 'consoles.restarting' });
      pool.close();
      // A browser that never answers the closing handshake must not hold the process
      setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 1000).unref();
    },
  };
}
