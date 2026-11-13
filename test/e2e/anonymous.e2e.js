/**
 * A browser nobody signed in with: every screen sends it to /login, the API
 * refuses it, and the console WebSocket never opens, even with a real
 * device key and a matching origin
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';

const h = useHarness();

test('an anonymous browser is sent to /login and can neither read the labs nor open a console', async () => {
  const page = await h.newPage();
  for (const path of ['/', '/#/consoles/B4M', '/index.html']) {
    await page.goto(`${h.url}${path}`);
    await page.waitForURL((u) => u.pathname === '/login');
    await page.waitForSelector('#sso-button:visible');
  }

  // A device key a signed-in student would use, read on the server side
  const res = await fetch(`${h.url}/api/consoles/labs`, { headers: h.app.as('student1') });
  const { labs } = await res.json();
  const key = labs.find((l) => l.name === 'B4M').devices.find((d) => d.name === 'R1').key;

  const answer = await page.evaluate(probe, key);
  assert.equal(answer.status, 401);
  assert.equal(answer.body.code, 'auth.required');
  assert.deepEqual(answer.ws, { events: ['error'], code: 1006 }, 'the upgrade is refused before any frame');

  // The same calls from the same origin with a session do work: the refusals above are the gate's
  const signed = await h.newPage();
  await h.session(signed, 'student1');
  await signed.goto(`${h.url}/login`); // any page of the origin; the probe does not need the app shell
  const allowed = await signed.evaluate(probe, key);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.ws.events[0], 'open');
  await signed.context().close();
  await page.context().close();
});

/** In the page: GET the labs, then open the console WebSocket and wait for its first frame or its end */
async function probe(deviceKey) {
  const api = await fetch('/api/consoles/labs');
  const ws = await new Promise((resolve) => {
    const events = [];
    const socket = new WebSocket(`ws://${location.host}/ws/console?device=${encodeURIComponent(deviceKey)}&cols=80&rows=24`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => events.push('open');
    socket.onmessage = () => { events.push('message'); socket.close(); };
    socket.onerror = () => events.push('error');
    socket.onclose = (e) => resolve({ events, code: e.code });
  });
  return { status: api.status, body: await api.json(), ws };
}
