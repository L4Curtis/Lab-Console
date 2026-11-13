/**
 * Administration pages (SPEC, lot admin): lab parameters, the diagram and its
 * versions, the admin switches, sessions, the audit trail, the announcement
 * banner, the health of the lab chain and what is journaled
 *
 * Routes (/api/admin), open to every signed-in user:
 *   GET    /announcement               { announcement | null }   (also pushed: SSE `admin:announcement`)
 *   GET    /health                     states only; administrators get the details   ?fresh=1 (admins)
 *   GET    /journaling                 what is recorded and for how long
 * Administrators only:
 *   GET    /lab                        { settings (secrets as { set }), proxmox, confirm: { method }, ssoOutcome }
 *   PUT    /lab                        { values, confirmation } → applied to the consoles opened next
 *   POST   /lab/confirm-sso            { values } → { url }: an SSO administrator signs in again at the provider;
 *                                      the change is applied on return, its outcome comes with the next GET /lab
 *   GET    /confirm                    { method: 'totp' | 'passkey' | 'sso' | null }
 *   POST   /confirm/options            passkey options (navigator.credentials.get)
 *   POST   /confirm                    { password, code } | { response } → { ticket, expiresAt }
 *   GET    /diagrams                   versions, newest first, and which one is active
 *   POST   /diagrams?name=             the raw file (5 MB at most) → { version, warnings, diff, outsideAllowList }
 *   GET    /diagrams/:id/preview       { labs, warnings, diff, outsideAllowList }
 *   GET    /diagrams/:id/download      the file
 *   POST   /diagrams/:id/activate      the consoles follow at once
 *   POST   /diagrams/rollback          back to the diagram active before
 *   GET    /switches | PUT /switches   the admin switches list { switches: [{ id, name, bay, host, port }] }
 *   GET    /sessions                   every live session
 *   DELETE /sessions/:id               end one (its consoles and live streams with it)
 *   POST   /sessions/revoke-user       { userId }: end every session of an account
 *   GET    /audit                      ?since&until&actor&action&bench&limit (newest first)
 *   PUT    /announcement               { text, level: 'info' | 'warning', hours? }
 *   DELETE /announcement
 *
 * Every change is audited. Secrets never leave the server: the lab page shows
 * whether each one is set, and saving it asks the administrator to confirm
 * (confirm.js).
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { MAX_DIAGRAM_BYTES } from '../../lib/diagrams.js';
import { createConfirmations } from './confirm.js';
import { createHealth, summary } from './health.js';
import { createAnnouncements } from './announcements.js';

const AUDIT_LIMIT = 1000;
const ACTION = /^[a-z][a-z0-9_.-]{0,60}$/;

export function createAdminModule({ config, logger, events, store, audit, auth, settings, diagrams, infra, services }, { now = Date.now } = {}) {
  const log = logger?.child ? logger.child('admin') : logger ?? { info() {}, warn() {}, error() {} };
  const confirmations = createConfirmations({ auth, services, now });
  const health = createHealth({ settings, config, services, logger: log, now });
  const announcements = createAnnouncements({ store, events, audit, logger: log, now });
  const stopHealth = settings.on('change', (ns) => { if (ns === 'lab') health.forget(); });

  const router = express.Router();
  const small = express.json({ limit: '32kb' });
  const body = (req) => (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const isAdmin = (req) => req.user?.role === 'admin';
  const tellAdmins = (what) => events?.publish('admin:changed', { what, at: now() }, { audience: (user) => user?.role === 'admin' });

  // ── Open to everyone signed in ─────────────────────────────────────────────
  router.get('/announcement', (_req, res) => res.set('Cache-Control', 'no-store').json({ announcement: announcements.current() }));

  router.get('/health', async (req, res) => {
    const fresh = isAdmin(req) && req.query.fresh === '1';
    const result = await health.check({ fresh });
    res.set('Cache-Control', 'no-store').json(isAdmin(req) ? { ...summary(result), details: result } : summary(result));
  });

  router.get('/journaling', (_req, res) => {
    res.json({
      audit: { retentionDays: null, files: 'data/audit/<yyyy-mm>.jsonl' },
      consoleJournal: config.rooms?.journal ? { enabled: true, retentionDays: config.rooms.journal.retentionDays } : { enabled: false, retentionDays: null },
      sessions: { idleHours: 8, maxHours: 24 },
      announcements: { kept: 20 },
    });
  });

  // ── Administrators only ────────────────────────────────────────────────────
  const admin = express.Router();
  router.use(auth.requireRole('admin'), admin);

  // Lab parameters
  const proxmoxInfo = () => (config.proxmox?.enabled
    ? { enabled: true, url: config.proxmox.url, username: config.proxmox.username, realm: config.proxmox.realm, hasPassword: Boolean(config.proxmox.password), fingerprint: config.proxmox.fingerprint || '' }
    : { enabled: false });
  const labPage = (req) => ({ settings: settings.describe('lab'), proxmox: proxmoxInfo(), confirm: { method: confirmations.methodOf(req.user) } });

  admin.get('/lab', (req, res) => res.set('Cache-Control', 'no-store').json({ ...labPage(req), ssoOutcome: confirmations.takeSsoOutcome(req) }));
  admin.put('/lab', small, async (req, res) => {
    const input = body(req);
    // Order matters: the ticket is checked first, the values next, and the ticket is spent only
    // when both are good, so a typo in a port does not cost the administrator a new confirmation
    try {
      confirmations.verify(req, input.confirmation);
    } catch (err) {
      confirmations.spend(input.confirmation); // a ticket that did not fit cannot be tried again
      throw err;
    }
    settings.check('lab', input.values);
    confirmations.spend(input.confirmation);
    const outcome = await settings.update('lab', input.values, req);
    tellAdmins('lab');
    res.json({ ...labPage(req), changed: outcome.changed, reset: outcome.reset });
  });

  admin.post('/lab/confirm-sso', small, async (req, res) => {
    const values = body(req).values;
    settings.check('lab', values); // a typo is told now, not after a trip to the provider
    const started = await confirmations.beginSso(req, res, async () => {
      const outcome = await settings.update('lab', values, req);
      tellAdmins('lab');
      return { changed: outcome.changed, reset: outcome.reset };
    });
    audit.log(req, 'admin.confirm.sso', { started: true });
    res.json(started);
  });

  admin.get('/confirm', (req, res) => res.json({ method: confirmations.methodOf(req.user) }));
  admin.post('/confirm/options', async (req, res) => res.json(await confirmations.options(req, res)));
  admin.post('/confirm', small, async (req, res) => {
    const input = body(req);
    try {
      res.json(await confirmations.confirm(req, res, input));
    } catch (err) {
      if (err.code === 'admin.confirm_failed') audit.log(req, 'admin.confirm.fail', { method: confirmations.methodOf(req.user) });
      throw err;
    }
  });

  // Diagram
  /** Devices of a diagram whose console is outside the allow-list (they would show, but stay inert for students) */
  const outsideAllowList = (labs) => {
    const { allowedHosts, portRange } = settings.get('lab').consoles;
    return labs.flatMap((l) => l.devices
      .filter((d) => !(allowedHosts.includes(d.target.host) && d.target.port >= portRange.min && d.target.port <= portRange.max))
      .map((d) => ({ lab: l.name, name: d.name, target: `${d.target.host}:${d.target.port}` })));
  };
  admin.get('/diagrams', (_req, res) => res.set('Cache-Control', 'no-store').json(diagrams.list()));
  const raw = express.raw({ type: () => true, limit: MAX_DIAGRAM_BYTES + 64 * 1024 });
  admin.post('/diagrams', (req, res, next) => raw(req, res, (err) => {
    if (err?.status === 413 || err?.type === 'entity.too.large') return next(httpError(413, 'admin.diagram_too_large', 'The diagram is over 5 MB', { max: MAX_DIAGRAM_BYTES }));
    next(err);
  }), async (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let added;
    try {
      added = await diagrams.add(data, { name: typeof req.query.name === 'string' ? req.query.name : '', actor: req });
    } catch (err) {
      if (err.code?.startsWith?.('admin.diagram')) audit.log(req, 'admin.diagram.refuse', { reason: err.code, size: data.length });
      throw err;
    }
    audit.log(req, 'admin.diagram.import', { version: added.version.id, name: added.version.name, size: added.version.size, devices: added.version.devices });
    tellAdmins('diagrams');
    res.json({
      version: added.version,
      warnings: added.warnings,
      diff: await diagrams.compare(added.version.id),
      outsideAllowList: outsideAllowList(added.labs),
    });
  });
  admin.get('/diagrams/:id/preview', async (req, res) => {
    const model = await diagrams.model(req.params.id);
    res.set('Cache-Control', 'no-store').json({ version: diagrams.find(req.params.id), labs: model.labs, warnings: model.warnings, diff: await diagrams.compare(req.params.id), outsideAllowList: outsideAllowList(model.labs) });
  });
  admin.get('/diagrams/:id/download', (req, res) => {
    const file = diagrams.fileOf(req.params.id);
    const version = diagrams.find(req.params.id);
    const name = (version.name || 'diagram.drawio').replace(/[^\w.-]+/g, '_');
    res.set('Cache-Control', 'no-store').type('application/xml').attachment(name.endsWith('.drawio') ? name : `${name}.drawio`).sendFile(file);
  });
  admin.post('/diagrams/rollback', async (req, res) => {
    const before = diagrams.list().active;
    const result = await diagrams.rollback(req);
    audit.log(req, 'admin.diagram.rollback', { from: before, to: result.rolledBackTo });
    tellAdmins('diagrams');
    res.json(result);
  });
  admin.post('/diagrams/:id/activate', async (req, res) => {
    const before = diagrams.list().active;
    const result = await diagrams.activate(req.params.id, req);
    audit.log(req, 'admin.diagram.activate', { from: before, to: req.params.id });
    tellAdmins('diagrams');
    res.json(result);
  });

  // Admin switches
  admin.get('/switches', (_req, res) => res.set('Cache-Control', 'no-store').json(infra.describe()));
  admin.put('/switches', small, async (req, res) => {
    const result = await infra.replace(body(req).switches, req);
    tellAdmins('switches');
    res.json(result);
  });

  // Sessions
  admin.get('/sessions', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ sessions: auth.sessions.list().map((s) => ({ ...s, current: s.id === req.sessionId })) });
  });
  admin.delete('/sessions/:id', (req, res) => {
    const target = auth.sessions.list().find((s) => s.id === req.params.id);
    if (!target || !auth.sessions.revoke(req.params.id)) throw httpError(404, 'admin.session_unknown', 'No such session (it may have ended already)');
    audit.log(req, 'admin.session.revoke', { session: target.id, user: target.user.id, username: target.user.username });
    tellAdmins('sessions');
    res.json({ ok: true, own: target.id === req.sessionId });
  });
  admin.post('/sessions/revoke-user', small, (req, res) => {
    const userId = body(req).userId;
    if (typeof userId !== 'string' || !userId || userId.length > 300) throw httpError(400, 'server.bad_request', 'userId is required');
    const count = auth.sessions.revokeUser(userId);
    if (count) audit.log(req, 'admin.session.revoke_user', { user: userId, count });
    tellAdmins('sessions');
    res.json({ ok: true, count });
  });

  // Audit trail
  admin.get('/audit', async (req, res) => {
    const q = req.query;
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const date = (v, name) => {
      const s = text(v, 40);
      if (!s) return undefined;
      if (Number.isNaN(Date.parse(s))) throw httpError(400, 'admin.audit_bad_filter', 'Invalid date', { field: name });
      return new Date(s).toISOString();
    };
    const action = text(q.action, 61);
    if (action && !ACTION.test(action)) throw httpError(400, 'admin.audit_bad_filter', 'Invalid action', { field: 'action' });
    const limit = q.limit === undefined ? 200 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_LIMIT) throw httpError(400, 'admin.audit_bad_filter', 'The limit is 1 to 1000', { field: 'limit' });
    const entries = await audit.query({
      since: date(q.since, 'since'),
      until: date(q.until, 'until'),
      actorId: text(q.actor, 300),
      action,
      bench: text(q.bench, 80),
      limit,
    });
    res.set('Cache-Control', 'no-store').json({ entries, limit });
  });

  // Announcement
  admin.put('/announcement', small, async (req, res) => res.json({ announcement: await announcements.set(body(req), req) }));
  admin.delete('/announcement', async (req, res) => {
    await announcements.clear(req);
    res.json({ announcement: null });
  });

  services.admin = { announcement: () => announcements.current() };

  return {
    id: 'admin',
    title: 'Administration',
    enabled: true,
    router,
    shutdown() {
      announcements.shutdown();
      stopHealth();
    },
  };
}
