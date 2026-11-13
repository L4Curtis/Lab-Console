/**
 * The whole way through for a student: sign in with the identity provider,
 * open a console on the (mock) lab, talk to the device, sign out, and find
 * the door closed when coming back
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, signOut } from './harness.js';

const h = useHarness();

test('a student signs in, opens R1 on B4M, types a command, signs out and is sent back to the login page', async () => {
  const page = await h.newPage();
  await page.goto(h.url);
  await page.waitForURL(/\/login$/);

  const user = await signInAs(page, 'alice');
  assert.equal(user.name, 'Alice Martin');
  assert.equal(await page.textContent('.user-badge'), 'AM');

  const pane = await openConsole(page, 'B4M', 'R1');
  // The console server's login was answered by the application: the device is next
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);
  await typeInConsole(pane, 'show ip interface brief');
  const text = await waitForTerminal(pane, /^FastEthernet0\/0 +unassigned [\s\S]*\nR1>$/m);
  assert.match(text, /^R1>show ip interface brief$/m, 'the device echoed the command');
  assert.match(text, /^Interface +IP-Address +OK\? Method Status +Protocol$/m);
  assert.equal(h.lab.device('10.22.9.211:2013').cfg.hostname, 'R1', 'the console line of B4M R1 in the diagram');

  await signOut(page);
  await page.goto(`${h.url}/#/consoles/B4M`);
  await page.waitForURL(/\/login#\/consoles\/B4M$/);
  await page.waitForSelector('#sso-button:visible');
  const me = await page.evaluate(() => fetch('/auth/me').then((r) => r.json()));
  assert.equal(me.user, null, 'the session is gone on the server');
  assert.ok(h.idp.signOuts.length > 0, 'the provider was told');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
