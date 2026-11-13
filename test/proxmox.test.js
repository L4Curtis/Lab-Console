/**
 * Proxmox client/service tests - everything goes through an SSH tunnel
 *
 * Topology built in-process:
 *   ProxmoxClient ──SSH──► mock jump server ──forward 10.22.9.71:8006──► mock Proxmox (HTTPS)
 * The client is configured with https://10.22.9.71:8006, an address this
 * machine cannot reach: the tests can only pass through the tunnel
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import ssh2 from 'ssh2';
import { startMockProxmox } from '../dev/mock-proxmox.js';
import { SshTunnel } from '../src/lib/sshTunnel.js';
import { ProxmoxClient } from '../src/modules/proxmox/client.js';
import { ProxmoxService } from '../src/modules/proxmox/service.js';
import { vncAuthResponse } from '../src/modules/proxmox/consoleProxy.js';

const warnings = [];
const log = { info() {}, warn(m) { warnings.push(m); }, error() {}, child() { return log; } };
const events = { publish() {} };
let pve, jump;

/** Minimal jump server: password auth + direct-tcpip forwarding of one lab address */
function startJump(forwardTo) {
  const stats = { connections: 0, channels: 0, clients: new Set() };
  const server = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (client) => {
    stats.clients.add(client);
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'jp' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
      stats.connections++;
      client.on('tcpip', (accept, reject, info) => {
        if (`${info.destIP}:${info.destPort}` !== '10.22.9.71:8006') return reject();
        const up = net.connect(forwardTo);
        up.once('connect', () => { stats.channels++; const ch = accept(); ch.pipe(up).pipe(ch); ch.on('close', () => up.destroy()); });
        up.once('error', () => reject());
      });
    });
    client.on('close', () => stats.clients.delete(client));
    client.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, stats, port: server.address().port })));
}

before(async () => {
  pve = await startMockProxmox({ port: 0, tls: true, quiet: true, taskMs: 150, user: 'labportal@pam', password: 'pw' });
  jump = await startJump(Number(new URL(pve.url).port));
});
const opened = [];
after(async () => {
  for (const c of opened) { c.close(); c.tunnel.close(); }
  for (const cl of jump.stats.clients) cl.end();
  jump.server.close();
  await pve.close();
});

const sshCfg = () => ({ host: '127.0.0.1', port: jump.port, username: 'jump', password: 'jp', readyTimeoutMs: 5000, keepaliveIntervalMs: 0 });
function client(over = {}) {
  const tunnel = over.tunnel || new SshTunnel({ ssh: sshCfg(), logger: log });
  const c = new ProxmoxClient({
    url: 'https://10.22.9.71:8006', username: 'labportal', realm: 'pam', password: 'pw',
    fingerprint: pve.fingerprint, tunnel, logger: log, ...over,
  });
  opened.push(c);
  return c;
}

test('REST calls reach Proxmox only through the jump server, on ONE reused SSH connection', async () => {
  const c0 = jump.stats.connections, ch0 = jump.stats.channels, logins0 = pve.stats.logins;
  const c = client();
  await c.get('/nodes');
  await Promise.all(Array.from({ length: 12 }, () => c.get('/cluster/resources', { type: 'vm' })));
  await c.put('/nodes/pve1/qemu/501/config', { description: 'x' }); // CSRF header over the tunnel
  assert.equal(jump.stats.connections - c0, 1, 'one SSH connection for all calls');
  assert.ok(jump.stats.channels - ch0 <= 6, `keep-alive reuses channels (opened ${jump.stats.channels - ch0} for 14 calls)`);
  assert.equal(pve.stats.logins - logins0, 1, 'one ticket for all calls');
});

test('expired ticket → one transparent re-login on 401', async () => {
  const c = client();
  await c.get('/nodes');
  for (const t of pve.tickets.values()) t.exp = 0;
  const before = pve.stats.logins;
  assert.ok((await c.get('/nodes')).length > 0);
  assert.equal(pve.stats.logins - before, 1);
});

test('proactive ticket refresh before the 2 h expiry', async () => {
  const c = client({ refreshAfterMs: 40 });
  await c.get('/nodes');
  const before = pve.stats.logins;
  await new Promise((r) => setTimeout(r, 60));
  await c.get('/nodes');
  assert.equal(pve.stats.logins - before, 1);
});

test('tunnel re-opens by itself after the jump server drops the SSH connection', async () => {
  const c = client();
  await c.get('/nodes');
  for (const cl of jump.stats.clients) cl.end(); // jump server kills every session
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await c.get('/nodes')).length > 0);
});

test('wrong certificate fingerprint: refused before any HTTP request (password never sent)', async () => {
  const before = pve.stats.requests;
  await assert.rejects(client({ fingerprint: 'AA:' + pve.fingerprint.slice(3) }).get('/nodes'), /fingerprint mismatch/);
  assert.equal(pve.stats.requests, before);
});

test('no fingerprint configured: works, and logs the fingerprint to pin', async () => {
  await client({ fingerprint: '' }).get('/nodes');
  assert.ok(warnings.some((w) => w.includes(pve.fingerprint)));
});

test('unreachable lab address gives a clear jump-server error', async () => {
  const c = client({ url: 'https://10.22.9.99:8006' });
  await assert.rejects(c.get('/nodes'), /Jump server could not open 10\.22\.9\.99:8006/);
});

test('console WebSocket (termproxy) runs over the tunnel too', async () => {
  const c = client();
  const svc = new ProxmoxService({ client: c, events, logger: log });
  const ch0 = jump.stats.channels;
  const t = await svc.openTermProxy('pve1', 502);
  const ws = await c.openWebSocket(`/nodes/pve1/qemu/502/vncwebsocket`, { port: t.port, vncticket: t.ticket });
  const first = new Promise((r) => ws.once('message', (d) => r(d.toString())));
  ws.resume();
  ws.send(`${t.user}:${t.ticket}\n`);
  assert.equal(await first, 'OK');
  assert.ok(jump.stats.channels > ch0);
  ws.close();
});

test('VNC: the server-speaks-first greeting is not lost over the tunnel', async () => {
  // Through an SSH channel, "101 Switching Protocols" and "RFB 003.008\n" arrive
  // in one chunk; the first message must survive until a listener is attached
  const c = client();
  const svc = new ProxmoxService({ client: c, events, logger: log });
  const t = await svc.openVncProxy('pve1', 501);
  const ws = await c.openWebSocket('/nodes/pve1/qemu/501/vncwebsocket', { port: t.port, vncticket: t.ticket });
  await new Promise((r) => setTimeout(r, 50)); // e.g. an await between open and listening
  const first = new Promise((r) => ws.once('message', (d) => r(d.toString())));
  ws.resume();
  assert.equal(await Promise.race([first, new Promise((r) => setTimeout(() => r('LOST'), 2000))]), 'RFB 003.008\n');
  ws.close();
});

test('lists every QEMU VM (no pool filter), with net0 VLAN and serial info', async () => {
  const vms = await new ProxmoxService({ client: client(), events, logger: log, taskPollMs: 50 }).listVms({ fresh: true });
  assert.ok(vms.some((v) => v.name === 'infra-dns'));
  const h2 = vms.find((v) => v.name === '5H2');
  assert.deepEqual([h2.vlan, h2.bridge, h2.hasSerial], [2002, 'vmbr0', true]);
  assert.ok(vms.find((v) => v.name === 'tpl-debian12').template);
});

test('VLAN change on net0 keeps the MAC; untagging works; bad tags refused', async () => {
  const c = client();
  const svc = new ProxmoxService({ client: c, events, logger: log });
  const mac = (await c.get('/nodes/pve1/qemu/503/config')).net0.match(/=([0-9A-F:]{17})/i)[1];
  await svc.setVlan('pve1', 503, 2011);
  let net0 = (await c.get('/nodes/pve1/qemu/503/config')).net0;
  assert.match(net0, /tag=2011/);
  assert.ok(net0.includes(mac));
  await svc.setVlan('pve1', 503, null);
  net0 = (await c.get('/nodes/pve1/qemu/503/config')).net0;
  assert.doesNotMatch(net0, /tag=/);
  await assert.rejects(svc.setVlan('pve1', 503, 5000), /1 to 4094/);
});

test('clone a template with name, node and VLAN; power start / stop / force stop', async () => {
  const svc = new ProxmoxService({ client: client(), events, logger: log, taskPollMs: 50 });
  const { jobId } = await svc.cloneTemplate({ template: 9000, name: 'vpc-test', node: 'pve2', vlan: 2005 });
  let job;
  for (let i = 0; i < 60 && job?.state !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 80));
    job = svc.jobs().find((j) => j.id === jobId);
    assert.notEqual(job.state, 'error', job.message);
  }
  const vm = (await svc.listVms({ fresh: true })).find((v) => v.name === 'vpc-test');
  assert.deepEqual([vm.node, vm.vlan, vm.status], ['pve2', 2005, 'stopped']);

  const waitStatus = async (want) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 80));
      // the mock applies a power change when its task is polled, like real Proxmox finishing it
      const v = (await svc.listVms({ fresh: true })).find((x) => x.vmid === vm.vmid);
      if (v.status === want) return true;
    }
    return false;
  };
  await svc.power(vm.node, vm.vmid, 'start');
  assert.ok(await waitStatus('running'));
  await svc.power(vm.node, vm.vmid, 'force-stop');
  assert.ok(await waitStatus('stopped'));
  await assert.rejects(svc.power(vm.node, vm.vmid, 'explode'), /Unknown power action/);
});

test('VNC auth response is standard DES (RFB spec test vector)', () => {
  const res = vncAuthResponse('password', Buffer.from([...Array(16).keys()]));
  assert.equal(res.toString('hex'), 'b866924125c8eebb9debc1db61c538e2');
});

test('the tunnel follows the lab parameters: a new jump server password applies without a restart', async (t) => {
  const { memoryDatabase } = await import('./helpers/db.js');
  const memory = await memoryDatabase();
  t.after(memory.close);
  const { default: express } = await import('express');
  const { createProxmoxModule } = await import('../src/modules/proxmox/index.js');
  const { createSettings } = await import('../src/lib/settings.js');
  const config = {
    server: { allowedOrigins: [] },
    ssh: { ...sshCfg(), password: 'wrong' },
    telnet: { username: '', password: '', autoLogin: true, wakeIdleMs: 0 },
    consoles: { networkPrefix: '10.22.9', allowedHosts: ['10.22.9.211'], portRange: { min: 2000, max: 2099 } },
    proxmox: { enabled: true, url: 'https://10.22.9.71:8006', username: 'labportal', realm: 'pam', password: 'pw', fingerprint: pve.fingerprint },
  };
  const settings = await createSettings({ config, repo: memory.repos.settings });
  const mod = createProxmoxModule({ config, events, logger: log, settings });
  const app = express().use('/api/proxmox', mod.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/proxmox/nodes`;
  try {
    assert.equal((await fetch(url)).status, 502, 'the jump server refuses the old password');
    await settings.update('lab', { ssh: { password: 'jp' } }, 'system');
    const res = await fetch(url);
    assert.equal(res.status, 200, 'reconnected with the new one');
    assert.ok((await res.json()).nodes.length > 0);
  } finally {
    mod.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
