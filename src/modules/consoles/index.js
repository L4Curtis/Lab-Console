/**
 * "Lab consoles" feature module: diagram API + terminal WebSocket endpoint
 *
 * Contract every platform module follows (see src/modules/index.js):
 *   { id, title, enabled, router?, upgrade?(req, socket, head) → boolean, shutdown?() }
 *
 * WebSocket protocol on /ws/console?device=<key>&cols=<n>&rows=<n>
 *   server → client  binary frame  raw terminal bytes
 *                    text frame    {"type":"status","phase","message","code","params"}
 *                                  {"type":"error","message","code","params"}   (session will not start)
 *                                  {"type":"exit","message","code","params"}    (session ended)
 *                    `message` is the English sentence; `code` is stable (`consoles.<reason>`) and
 *                    `params` fill its placeholders: the browser translates by code
 *   client → server  text frame    {"type":"input","data"} | {"type":"resize","cols","rows"} | {"type":"break"}
 *
 * The browser only ever names a device *key* from the diagram. Host and port
 * are resolved here, from the server's own copy of the diagram, and checked
 * against the allow-list - the client cannot make the jump server dial anything else
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { LabRegistry } from './labRegistry.js';
import { SessionManager } from './sessionManager.js';
import { ConsoleSession } from './consoleSession.js';
import { isOriginAllowed, createRateLimiter, clientIp } from '../../lib/security.js';
import { createAutomationHandler } from '../../lib/automationProtocol.js';

export function createConsolesModule({ config, events, logger, infra, services }) {
  const log = logger.child('consoles');
  const { allowedHosts, portRange, networkPrefix } = config.consoles;

  const isTargetAllowed = (t) =>
    allowedHosts.includes(t.host) && Number.isInteger(t.port) && t.port >= portRange.min && t.port <= portRange.max;

  const registry = new LabRegistry({ diagramPath: config.diagramPath, networkPrefix, isTargetAllowed, logger: log });
  const sessions = new SessionManager({ limits: config.limits, logger: log });
  const allowOpen = createRateLimiter({ limit: config.limits.opensPerMinute, windowMs: 60_000 });

  // Admin switches: console devices that live outside the lab diagrams
  const adminSwitches = new Map(infra.adminSwitches.map((s) => [s.key, { ...s, allowed: isTargetAllowed(s.target) }]));
  for (const s of adminSwitches.values()) {
    if (!s.allowed) log.warn(`admin switch ${s.labName}: ${s.target.host}:${s.target.port} is outside the allow-list (disabled)`);
  }

  registry.on('change', (model) => events.publish('labs:version', { version: model.version, error: model.error }, { sticky: true }));
  sessions.on('busy', (targets) => events.publish('consoles:busy', targets, { sticky: true }));
  registry.load();
  registry.watch();
  events.publish('consoles:busy', [], { sticky: true });

  // What other modules may use (ARCHITECTURE §7); read lazily, inside handlers
  if (services) services.consoles = { registry };

  // ── HTTP API ──────────────────────────────────────────────────────────────
  const router = express.Router();
  router.get('/labs', (_req, res) => {
    const { labs, warnings, version, error } = registry.model;
    res.set('Cache-Control', 'no-store').json({ labs, warnings, version, error });
  });
  router.get('/admin-switches', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ switches: [...adminSwitches.values()] });
  });

  // ── WebSocket terminals ───────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/console') return false;
    if (!isOriginAllowed(req, config.server.allowedOrigins)) {
      log.warn(`rejected WebSocket from origin ${req.headers.origin}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onTerminal(ws, req, url));
    return true;
  }

  function onTerminal(ws, req, url) {
    const clientId = clientIp(req, config.server);
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const refuse = (message, code, params = {}) => { send({ type: 'error', message, code, params }); ws.close(1008, 'refused'); };

    if (!allowOpen(clientId)) return refuse('Too many consoles opened in the last minute. Wait a moment and try again.', 'consoles.rate_limited');

    const key = url.searchParams.get('device') || '';
    const device = key.startsWith('admin:') ? adminSwitches.get(key) : registry.getDevice(key);
    if (!device) return refuse('This device no longer exists. Reload the page.', 'consoles.device_gone');
    if (!device.allowed) return refuse(`${device.name}'s console address is not on the platform's allow-list.`, 'consoles.not_allowed', { name: device.name });

    const verdict = sessions.canOpen(device, clientId);
    if (!verdict.ok) return refuse(verdict.reason, verdict.code, verdict.params);

    let session;
    try {
      session = new ConsoleSession({
        target: device.target,
        cols: Number(url.searchParams.get('cols')),
        rows: Number(url.searchParams.get('rows')),
        ssh: config.ssh,
        telnet: config.telnet,
        logger: log,
      });
    } catch (err) {
      return refuse(err.message, 'consoles.invalid_target', { detail: err.message });
    }
    sessions.register(session, device, clientId);

    session.on('data', (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true }));
    session.on('status', (s) => send({ type: 'status', ...s }));
    session.on('close', ({ reason, info }) => {
      session.cli.cancel();
      send({ type: 'exit', message: reason, ...info });
      ws.close(1000, 'session ended');
    });

    // Export config / inject script: every console here is a Cisco-style device
    const automation = createAutomationHandler({ cli: session.cli, send, canExport: true, log, label: `${device.labName}/${device.name}` });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (automation(msg)) return;
      if (msg.type === 'input') session.write(msg.data);
      else if (msg.type === 'resize') session.resize(Number(msg.cols), Number(msg.rows));
      else if (msg.type === 'break') session.sendBreak();
    });

    // Tab closed / network dropped → hang up telnet so the console line is freed
    ws.on('close', () => session.close('Browser disconnected', null, { code: 'consoles.browser_gone' }));
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    session.start();
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
    shutdown() {
      clearInterval(heartbeat);
      registry.close();
      sessions.closeAll('Platform is restarting', { code: 'consoles.restarting' });
      // A browser that never answers the closing handshake must not hold the process
      setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 1000).unref();
    },
  };
}
