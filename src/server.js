/**
 * Lab Console - HTTP + WebSocket entry point and composition root
 *
 * createApp() builds the platform services once (store, audit, events, auth,
 * services registry), hands them to every module, and wires the request
 * pipeline in the order of ARCHITECTURE §4. The order IS the security model:
 * whatever is mounted below the gate needs a signed-in user, so a new route
 * is protected unless someone deliberately mounts it above
 *
 * Run directly (`node src/server.js`) it loads the configuration and listens;
 * imported (tests, the e2e harness) it only exports createApp()
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { createLogger } from './lib/logger.js';
import { EventHub } from './lib/events.js';
import { securityHeaders, isOriginAllowed, requireSameOrigin, proxyTrust } from './lib/security.js';
import { createInfrastructure } from './lib/infrastructure.js';
import { createDiagrams } from './lib/diagrams.js';
import { createStore } from './lib/store.js';
import { createAudit } from './lib/audit.js';
import { createSettings } from './lib/settings.js';
import { HttpError, errorBody, sendError } from './lib/httpError.js';
import { createAuth } from './modules/auth/index.js';
import { createModules } from './modules/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

/**
 * Build the whole application without listening.
 *   config   the frozen object from src/config.js (or loadConfig() in tests)
 *   logger   optional replacement for createLogger, e.g. a silent one in tests
 *   createAuth, createModules   test seams: another identity (see
 *            test/helpers/fakes.js) or another module list, in the real pipeline
 * Returns { app, server, modules, deps, listen(), close() }
 */
export function createApp({ config, logger = createLogger, createAuth: makeAuth = createAuth, createModules: makeModules = createModules } = {}) {
  if (!config) throw new TypeError('createApp needs a config');
  const log = logger('server');
  const trust = proxyTrust(config.server);

  // ── Platform services, shared by every module (ARCHITECTURE §6) ────────────
  const store = createStore(config.dataDir, { logger: logger('store') });
  const events = new EventHub({ logger: logger('events') });
  const audit = createAudit({ store, logger: logger('audit'), clientIp: trust.clientIp });
  const infra = createInfrastructure({ file: config.infraConfigPath, store, audit, logger: logger('infra') });
  const settings = createSettings({ config, store, audit, logger: logger('settings') });
  // The active diagram lives in the data directory (seeded from DIAGRAM_PATH on the first start)
  const diagrams = createDiagrams({ config, store, logger: logger('diagrams') });
  const services = {};
  const auth = makeAuth({ config, logger: logger('auth'), events, store, audit, services });
  const deps = { config, logger: logger('app'), events, infra, store, audit, auth, settings, diagrams, services };
  const modules = makeModules(deps);

  const app = express();
  app.disable('x-powered-by');
  // req.ip / req.protocol follow the same rule as clientIp(): only our proxies are believed
  app.set('trust proxy', (address) => trust.isTrusted(address));

  // ── 1. Security headers on every response ──────────────────────────────────
  app.use(securityHeaders);

  // ── 2. Public static assets: what the login page needs, nothing more ───────
  // Self-hosted front-end dependencies (works on isolated lab networks)
  const vendor = (pkgPath) => express.static(path.join(root, 'node_modules', pkgPath), { maxAge: '7d', immutable: true });
  app.use('/vendor/xterm', vendor('@xterm/xterm'));
  app.use('/vendor/xterm-addon-fit', vendor('@xterm/addon-fit'));
  app.use('/vendor/novnc', vendor('@novnc/novnc'));
  // WebAuthn in the browser (the login page uses it: public, like the rest of /vendor)
  app.use('/vendor/simplewebauthn', vendor(path.join('@simplewebauthn', 'browser', 'esm')));
  app.use('/vendor/fonts/plex-sans', vendor('@fontsource/ibm-plex-sans'));
  app.use('/vendor/fonts/plex-mono', vendor('@fontsource/ibm-plex-mono'));
  // fallthrough off: a missing public asset is a 404, never a redirect to the login page
  const publicAssets = (dir) => express.static(path.join(publicDir, dir), { index: false, fallthrough: false });
  app.use('/css', publicAssets('css'));
  app.use('/locales', publicAssets('locales'));
  app.use('/js/core', publicAssets(path.join('js', 'core')));
  app.get(['/favicon.svg', '/favicon.ico'], (_req, res) => res.type('image/svg+xml').sendFile(path.join(publicDir, 'favicon.svg')));

  // ── 3. Liveness, for Docker and the reverse proxy: no detail ───────────────
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ── 4. Auth routes: /login and /auth/* ─────────────────────────────────────
  app.use(auth.router);

  // ── 5. The gate: everything below needs a user ─────────────────────────────
  app.use(auth.attach, auth.requireAuth);

  // ── 6. State-changing requests must come from the platform's own pages, so
  //       another website can't make a visitor's browser power off VMs (CSRF)
  app.use(requireSameOrigin(config.server.allowedOrigins));

  // ── 7. App shell and the rest of the front end ─────────────────────────────
  app.use(express.static(publicDir, { index: 'index.html' }));

  // ── 8. API ─────────────────────────────────────────────────────────────────
  app.get('/api/events', events.handler);
  app.get('/api/modules', (_req, res) =>
    res.json(modules.map(({ id, title, enabled }) => ({ id, title, enabled }))));
  for (const m of modules) if (m.router) app.use(`/api/${m.id}`, m.router);

  // ── 9. JSON 404 and error handler ──────────────────────────────────────────
  app.use('/api', (_req, res) => sendError(res, 404, 'server.not_found', 'Not found'));
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return res.status(err.status).json(errorBody(err.code, err.message, err.params));
    // Refusals raised by middleware (malformed JSON, body too large, missing static file…)
    const status = Number(err.status ?? err.statusCode);
    if (status >= 400 && status < 500) {
      if (status === 404) return sendError(res, 404, 'server.not_found', 'Not found');
      if (status === 413) return sendError(res, 413, 'server.too_large', 'Request body too large');
      return sendError(res, status, 'server.bad_request', 'Invalid request');
    }
    log.error(err.stack || String(err));
    sendError(res, 500, 'server.internal', 'Internal error');
  });

  // ── WebSocket upgrades: same origin, then a user, then the owning module ───
  const server = http.createServer(app);
  server.on('upgrade', async (req, socket, head) => {
    const deny = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.on('error', () => {}); // a browser that goes away mid-handshake is not an incident
    try {
      if (!isOriginAllowed(req, config.server.allowedOrigins)) {
        log.warn(`rejected WebSocket from origin ${req.headers.origin}`);
        return deny(403, 'Forbidden');
      }
      const user = await auth.authenticateUpgrade(req);
      if (!user) return deny(401, 'Unauthorized');
      if (socket.destroyed) return;
      req.user = user;
      for (const m of modules) if (m.upgrade?.(req, socket, head)) return;
      deny(404, 'Not Found');
    } catch (err) {
      log.error(`WebSocket upgrade failed: ${err.stack || err}`);
      deny(500, 'Internal Server Error');
    }
  });

  /** Start listening; resolves with the address really bound (PORT=0 picks a free port) */
  function listen({ port = config.server.port, host = config.server.host } = {}) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve({ host, port: server.address().port });
      });
    });
  }

  /** Stop everything this instance started: consoles, streams, sockets, pending writes */
  async function close() {
    for (const m of modules) m.shutdown?.();
    auth.shutdown?.();
    events.close();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await store.flush();
  }

  return { app, server, modules, deps, listen, close };
}

// ── Process entry point ──────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { config } = await import('./config.js'); // validates the environment, exits on error
  const log = createLogger('server');
  let lab;
  try {
    lab = createApp({ config });
    const { host, port } = await lab.listen();
    log.info(`Lab Console listening on http://${host}:${port}`);
    log.info(`Jump server ${config.ssh.username}@${config.ssh.host}:${config.ssh.port}`);
    log.info(`Sign-in: local administrator "${config.auth.localAdmin.username}"${config.auth.oidc.enabled ? ` and ${config.auth.oidc.providerName} (${config.auth.oidc.issuer})` : ' only (no identity provider configured)'}`);
  } catch (err) {
    console.error(`\n✖ Lab Console could not start: ${err.message}\n`);
    process.exit(1);
  }

  const shutdown = (signal) => {
    log.info(`${signal} received, closing consoles…`);
    lab.close().then(() => process.exit(0), () => process.exit(1));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
