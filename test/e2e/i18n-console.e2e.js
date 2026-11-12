/**
 * Changing the language while a console is open: the console stays connected
 * (same WebSocket, same terminal), only the texts around it change
 *
 * Starts the application and the mock lab (dev/mock-lab.js, a fake jump
 * server) on ephemeral ports, and drives the system Chromium
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startTestApp, repoRoot } from '../helpers/app.js';

let lab;
let browser;
let page;
let mock;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

before(async () => {
  const sshPort = await freePort();
  mock = spawn(process.execPath, ['dev/mock-lab.js'], {
    cwd: repoRoot,
    env: { ...process.env, MOCK_SSH_PORT: String(sshPort), SSH_USERNAME: 'test', SSH_PASSWORD: 'test', TELNET_USERNAME: '', TELNET_PASSWORD: '', ENV_FILE: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.stdout.on('data', (d) => { if (String(d).includes('Mock jump server')) resolve(); });
  });
  lab = await startTestApp({ env: { SSH_PORT: String(sshPort), SSH_HOST: '127.0.0.1', ALLOWED_CONSOLE_HOSTS: '10.22.9.211,10.22.9.212' } });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  page = await browser.newPage();
  await page.goto(lab.url);
  await page.waitForSelector('section.view-consoles .device');
});
after(async () => {
  await browser?.close();
  await lab?.close();
  mock?.kill();
});

test('language switch: an open console stays connected and keeps its terminal', async () => {
  await page.evaluate(() => { window.__sockets = []; const Native = window.WebSocket; window.WebSocket = class extends Native { constructor(...a) { super(...a); window.__sockets.push(this); } }; });
  await page.locator('section.view-consoles .device[data-state="idle"]').first().click();
  await page.waitForSelector('article.pane .xterm-rows');
  await page.waitForFunction(() => window.__sockets.length === 1 && window.__sockets[0].readyState === 1);
  const status = () => page.locator('.pane-status').first().textContent();
  await page.waitForFunction(() => /^(Connecté|Connected)$/.test(document.querySelector('.pane-status')?.textContent || '')).catch(async () => { throw new Error('status: ' + await status()); });
  assert.match(await status(), /^Connecté$/);
  const terminal = await page.evaluate(() => { const el = document.querySelector('article.pane .xterm'); el.dataset.probe = 'same'; return document.querySelectorAll('article.pane .xterm').length; });

  await page.click('.lang-btn[data-lang="en"]');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.match(await status(), /^Connected$/, 'the status line follows the language');
  await page.click('.lang-btn[data-lang="fr"]');
  await page.waitForFunction(() => document.documentElement.lang === 'fr');
  assert.match(await status(), /^Connecté$/);

  const after = await page.evaluate(() => ({
    sockets: window.__sockets.length,
    state: window.__sockets[0].readyState,
    same: document.querySelector('article.pane .xterm')?.dataset.probe,
    terminals: document.querySelectorAll('article.pane .xterm').length,
  }));
  assert.deepEqual(after, { sockets: 1, state: 1, same: 'same', terminals: terminal }, 'no new socket, the same terminal element, still open');
});
