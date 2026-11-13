/**
 * Changing the language while a console is open: the console stays connected
 * (same WebSocket, same terminal), only the texts around it change
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, waitForApp, openConsole, setLanguage } from './harness.js';

const h = useHarness({ oidc: false });
let page;

before(async () => {
  await h.ready;
  page = await h.newPage();
  await h.session(page, 'student1'); // a real session, its cookie handed to the browser
  await page.addInitScript(() => {
    window.__sockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native { constructor(...a) { super(...a); window.__sockets.push(this); } };
  });
  await page.goto(h.url);
  await waitForApp(page);
});

test('language switch: an open console stays connected and keeps its terminal', async () => {
  const pane = await openConsole(page, 'B4M', 'S1');
  const status = pane.locator('.pane-status');
  assert.equal(await page.evaluate(() => window.__sockets.filter((s) => s.url.includes('/ws/console')).length), 1);
  assert.equal(await status.textContent(), 'Connecté');
  await pane.locator('.xterm').evaluate((el) => { el.dataset.probe = 'same'; });

  await setLanguage(page, 'en');
  assert.equal(await status.textContent(), 'Connected', 'the status line follows the language');
  await setLanguage(page, 'fr');
  assert.equal(await status.textContent(), 'Connecté');

  const after = await page.evaluate(() => {
    const consoles = window.__sockets.filter((s) => s.url.includes('/ws/console'));
    return {
      sockets: consoles.length,
      state: consoles[0].readyState,
      same: document.querySelector('article.pane .xterm')?.dataset.probe,
      terminals: document.querySelectorAll('article.pane .xterm').length,
    };
  });
  assert.deepEqual(after, { sockets: 1, state: 1, same: 'same', terminals: 1 }, 'no new socket, the same terminal element, still open');
  assert.deepEqual(page.errors, []);
});
