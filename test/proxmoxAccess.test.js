/**
 * Who may drive Proxmox: administrators only. A student (any signed-in
 * account that is not an administrator) learns whether Proxmox is configured,
 * nothing about where it lives, and is refused every route and both console
 * WebSockets before anything is asked of the jump server. A failure on the way
 * to Proxmox is told with a code and a sentence that names no host.
 *
 * Proxmox is aimed at a port nobody listens on, through a jump server that
 * refuses: nothing real is contacted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startTestApp } from './helpers/app.js';

let lab;
before(async () => {
  lab = await startTestApp({ env: { PROXMOX_URL: 'https://10.99.0.1:8006', PROXMOX_USERNAME: 'test', PROXMOX_PASSWORD: 'test', SSH_HOST: '127.0.0.1', SSH_PORT: '1' } });
});
after(() => lab?.close());

const api = (who, method, path, body) => fetch(`${lab.url}/api/proxmox${path}`, {
  method,
  headers: { origin: lab.url, 'content-type': 'application/json', ...lab.as(who) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function upgrade(who, path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(lab.wsUrl + path, { headers: { origin: lab.url, ...lab.as(who) } });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err); });
  });
}

test('a student learns that Proxmox exists, not where it is', async () => {
  const res = await api('student1', 'GET', '/status');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { proxmox: true, admin: false });
  const admin = await (await api('admin', 'GET', '/status')).json();
  assert.equal(admin.admin, true);
  assert.equal(admin.host, '10.99.0.1:8006', 'an administrator sees how it is reached');
});

test('refusal: a student may not list, power, retag or clone VMs', async () => {
  for (const [method, path, body] of [
    ['GET', '/vms'], ['GET', '/nodes'], ['GET', '/jobs'],
    ['POST', '/vms/pve1/101/power', { action: 'stop' }],
    ['PUT', '/vms/pve1/101/vlan', { vlan: 20 }],
    ['POST', '/clone', { template: 9000, name: 'x' }],
  ]) {
    const res = await api('student1', method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).code, 'auth.forbidden', `${method} ${path}`);
  }
});

test('refusal: a student may not open a VM console', async () => {
  assert.equal(await upgrade('student1', '/ws/proxmox/serial?node=pve1&vmid=101'), 403);
  assert.equal(await upgrade('student1', '/ws/proxmox/vnc?node=pve1&vmid=101'), 403);
});

test('an administrator gets through; a failure on the way says nothing of the hosts behind', async () => {
  const res = await api('admin', 'POST', '/vms/pve1/101/power', { action: 'stop' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, 'infra.unreachable');
  assert.doesNotMatch(JSON.stringify(body), /10\.99|127\.0\.0\.1|jump/i);
  // Refusals of the request itself are still told as they are
  const bad = await api('admin', 'PUT', '/vms/pve1/101/vlan', { vlan: 99999 });
  assert.equal(bad.status, 400);
});
