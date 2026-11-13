/**
 * "Infrastructure" feature module: Proxmox VE VMs + their consoles
 * (Admin switch consoles are served by the consoles module under admin: keys)
 * Open to everyone, like the lab consoles; All Proxmox traffic - REST and
 * console WebSockets - goes through the SSH jump server (see client.js)
 *
 * HTTP                                          Proxmox API used
 *   GET  /api/proxmox/status                    -
 *   GET  /api/proxmox/vms                       GET /cluster/resources, …/qemu/{id}/config
 *   GET  /api/proxmox/nodes · /jobs             GET /nodes
 *   POST /api/proxmox/vms/:node/:vmid/power     POST …/status/{start|shutdown|stop}
 *   PUT  /api/proxmox/vms/:node/:vmid/vlan      PUT  …/config {net0}
 *   POST /api/proxmox/clone                     GET /cluster/nextid, POST …/clone, PUT …/config
 *
 * WebSocket (same origin only)
 *   /ws/proxmox/serial?node&vmid&cols&rows      POST …/termproxy  + vncwebsocket
 *   /ws/proxmox/vnc?node&vmid                   POST …/vncproxy   + vncwebsocket
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { SshTunnel } from '../../lib/sshTunnel.js';
import { isOriginAllowed } from '../../lib/security.js';
import { ProxmoxClient } from './client.js';
import { ProxmoxService } from './service.js';
import { bridgeSerial, bridgeVnc } from './consoleProxy.js';

const MAX_VM_CONSOLES = 20;

export function createProxmoxModule({ config, events, logger, settings }) {
  const log = logger.child('proxmox');
  const cfg = config.proxmox;
  const router = express.Router();
  const base = { id: 'proxmox', title: 'Infrastructure', enabled: true, router };

  if (!cfg.enabled) {
    router.get('/status', (_req, res) => res.json({ proxmox: false }));
    router.use((_req, res) => res.status(503).json({ error: 'Proxmox is not configured (PROXMOX_URL is empty)' }));
    return base;
  }

  const tunnel = new SshTunnel({ ssh: settings?.get('lab').ssh ?? config.ssh, logger: log.child('tunnel') });
  // The jump server's parameters may change from the administration pages: reconnect with the new ones
  const stopFollowing = settings?.on('change', (ns, values) => {
    if (ns !== 'lab') return;
    tunnel.ssh = values.ssh;
    tunnel.close();
    log.info('lab parameters changed: the Proxmox tunnel reconnects on next use');
  });
  const client = new ProxmoxClient({ ...cfg, tunnel, logger: log });
  const service = new ProxmoxService({ client, events, logger: log });

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    if (status >= 500) log.error(err.message);
    res.status(status).json({ error: err.message });
  });
  const json = express.json({ limit: '4kb' });
  const vlanOf = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  router.get('/status', (_req, res) => res.json({ proxmox: true, host: `${client.host}:${client.port}`, via: config.ssh.host, tunnel: tunnel.state }));
  router.get('/vms', wrap(async (_req, res) => res.json({ vms: await service.listVms() })));
  router.get('/nodes', wrap(async (_req, res) => res.json({ nodes: await service.listNodes() })));
  router.get('/jobs', (_req, res) => res.json({ jobs: service.jobs() }));

  router.post('/vms/:node/:vmid/power', json, wrap(async (req, res) => {
    res.json(await service.power(req.params.node, req.params.vmid, String(req.body?.action || '')));
  }));
  router.put('/vms/:node/:vmid/vlan', json, wrap(async (req, res) => {
    res.json(await service.setVlan(req.params.node, req.params.vmid, vlanOf(req.body?.vlan)));
  }));
  router.post('/clone', json, wrap(async (req, res) => {
    const b = req.body || {};
    res.status(202).json(await service.cloneTemplate({
      template: Number(b.template),
      name: String(b.name || '').trim(),
      node: b.node ? String(b.node) : undefined,
      vlan: vlanOf(b.vlan),
    }));
  }));

  // ── WebSocket consoles ────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let open = 0;

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const kind = { '/ws/proxmox/serial': 'serial', '/ws/proxmox/vnc': 'vnc' }[url.pathname];
    if (!kind) return false;
    const deny = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
    if (!isOriginAllowed(req, config.server.allowedOrigins)) return deny(403, 'Forbidden'), true;
    if (open >= MAX_VM_CONSOLES) return deny(503, 'Service Unavailable'), true;

    wss.handleUpgrade(req, socket, head, async (browser) => {
      open++;
      browser.on('close', () => { open--; });
      const node = url.searchParams.get('node') || '';
      const vmid = url.searchParams.get('vmid') || '';
      try {
        if (kind === 'serial') {
          await bridgeSerial({
            service, client, node, vmid, browser, log,
            cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows')),
          });
        } else {
          await bridgeVnc({ service, client, node, vmid, browser, log });
        }
      } catch (err) {
        log.warn(`${kind} console for ${node}/${vmid} failed: ${err.message}`);
        if (browser.readyState === browser.OPEN) {
          // Serial panes read JSON errors; noVNC panes read the close reason
          if (kind === 'serial') browser.send(JSON.stringify({ type: 'error', message: err.message }));
          browser.close(4000, err.message.slice(0, 120));
        }
      }
    });
    return true;
  }

  return { ...base, upgrade, shutdown: () => { stopFollowing?.(); client.close(); tunnel.close(); } };
}
