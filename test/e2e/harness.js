/**
 * Browser test harness: everything a scenario needs, started on ephemeral
 * ports and torn down whatever happens
 *
 *   import { test } from 'node:test';
 *   import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal } from './harness.js';
 *
 *   const h = useHarness();                  // before(): start, after(): tear down
 *                                            // (a file's own before() awaits h.ready first)
 *   test('a student reaches R1', async () => {
 *     const page = await h.newPage();
 *     await signInAs(page, 'alice');         // through the mock provider's user picker
 *     const pane = await openConsole(page, 'B4M', 'R1');
 *     await typeInConsole(pane, '');
 *     await waitForTerminal(pane, /R1>$/m);
 *   });
 *
 * What runs, all inside the test process, all on port 0:
 *   - the mock lab (dev/mock-lab.js, a fake SSH jump server and console
 *     server, devices named after the diagram so R1 answers "R1>"),
 *   - the mock OpenID Connect provider (dev/mock-oidc.js),
 *   - the real application (test/helpers/app.js), real sign-in included,
 *     with a temporary DATA_DIR,
 *   - the system Chromium (CHROMIUM_PATH, default /usr/bin/chromium), headless,
 *     through playwright-core. One per test file: files run serially.
 *
 * Tear-down closes the browser, the application, the provider and the lab,
 * and removes the data directory. It runs from the after() hook, so a failing
 * test does not skip it; a start-up that fails half-way closes what it had
 * started; SIGINT / SIGTERM (a cancelled run) close everything before the
 * process exits. Chromium is launched with a marker argument (`h.marker`) so
 * a test can check that no browser of this run is left behind.
 *
 * Helpers take a page (or a pane locator) and wait on conditions, never on
 * fixed delays.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before } from 'node:test';
import { chromium } from 'playwright-core';
import { startTestApp, adminCode, TEST_ADMIN, repoRoot } from '../helpers/app.js';
import { startMockOidc, DEFAULT_USERS } from '../../dev/mock-oidc.js';
import { startMockLab } from '../../dev/mock-lab.js';
import { parseDrawio } from '../../src/modules/consoles/drawio.js';

export { TEST_ADMIN };
export const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

/** Credentials of the mock jump server and of its console server login (the app's AutoLogin answers it) */
export const MOCK_SSH = Object.freeze({ username: 'e2e', password: 'e2e-jump' });
export const MOCK_TELNET = Object.freeze({ username: 'e2e-line', password: 'e2e-line-pass' });

const TIMEOUT = 15_000;

/** The mock provider's people by first name ('alice' → student1) and by user name */
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const PEOPLE = Object.freeze(Object.fromEntries(DEFAULT_USERS.flatMap((u) => [[fold(u.name.split(' ')[0]), u], [u.username, u]])));

export function person(who) {
  const user = PEOPLE[fold(String(who))];
  if (!user) throw new TypeError(`Unknown person "${who}": ${Object.keys(PEOPLE).join(', ')}`);
  return user;
}

/** Device hostnames per console line, read from the diagram the application serves */
function diagramNames(file) {
  const names = new Map();
  const { labs } = parseDrawio(fs.readFileSync(file, 'utf8'), { networkPrefix: '10.22.9' });
  for (const l of labs) for (const d of l.devices) names.set(`${d.target.host}:${d.target.port}`, d.name);
  return names;
}

// ── Process-wide safety net ────────────────────────────────────────────────

const live = new Set(); // harnesses not closed yet

function onSignal(signal) {
  Promise.allSettled([...live].map((h) => h.close())).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
}
let guarded = false;
function guardProcess() {
  if (guarded) return;
  guarded = true;
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Last resort when the process ends without the after() hook (uncaught error):
  // Playwright kills its browser on exit by itself; the data directories are ours
  process.once('exit', () => {
    for (const h of live) fs.rmSync(h.app?.dataDir ?? '', { recursive: true, force: true });
  });
}

/** Settle a promise within `ms`, so one stuck piece cannot block the rest of the tear-down */
const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not close within ${ms} ms`)), ms).unref()),
]);

// ── The harness ────────────────────────────────────────────────────────────

/**
 * Start everything. Options:
 *   oidc     true (default): start the mock provider and configure the app for it
 *   mockLab  true (default) or options for startMockLab (devices, busyPorts…)
 *   env      extra variables for the application
 * → { url, app, idp, lab, browser, marker, newPage({ locale }), session(page, who), adminCode(), close() }
 */
export async function startHarness({ oidc = true, mockLab = true, env = {} } = {}) {
  guardProcess();
  const h = {
    marker: `--lab-console-e2e=${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    app: null,
    idp: null,
    lab: null,
    browser: null,
    url: null,
    telnetLogin: false,
    lastAdminStep: -1,
    closed: null,
  };

  h.close = () => (h.closed ??= (async () => {
    const problems = [];
    const step = async (what, fn) => { try { await fn(); } catch (err) { problems.push(`${what}: ${err.message}`); } };
    await step('browser', () => h.browser && within(h.browser.close(), 10_000, 'Chromium'));
    await step('application', () => h.app && within(h.app.close(), 10_000, 'the application'));
    await step('mock provider', () => h.idp && within(h.idp.close(), 5_000, 'the mock provider'));
    await step('mock lab', () => h.lab && within(h.lab.close(), 5_000, 'the mock lab'));
    if (h.app?.dataDir) fs.rmSync(h.app.dataDir, { recursive: true, force: true });
    live.delete(h);
    if (problems.length) throw new Error(`harness tear-down: ${problems.join('; ')}`);
  })());

  live.add(h);
  try {
    const appEnv = {};
    if (oidc) {
      h.idp = await startMockOidc({ port: 0 });
      Object.assign(appEnv, {
        OIDC_ISSUER: h.idp.issuer,
        OIDC_CLIENT_ID: 'lab-console',
        OIDC_CLIENT_SECRET: 'mock-secret',
        OIDC_ADMIN_GROUPS: 'admins',
        OIDC_PROVIDER_NAME: 'Mock SSO',
      });
    }
    if (mockLab) {
      const options = { telnet: MOCK_TELNET, ...(mockLab === true ? {} : mockLab) };
      h.telnetLogin = Boolean(options.telnet);
      h.lab = await startMockLab({
        port: 0,
        ssh: MOCK_SSH,
        names: diagramNames(path.join(repoRoot, 'diagrams', 'diagram.drawio')),
        ...options,
      });
      Object.assign(appEnv, {
        SSH_HOST: '127.0.0.1',
        SSH_PORT: String(h.lab.port),
        SSH_USERNAME: MOCK_SSH.username,
        SSH_PASSWORD: MOCK_SSH.password,
        TELNET_USERNAME: options.telnet?.username ?? '',
        TELNET_PASSWORD: options.telnet?.password ?? '',
        ALLOWED_CONSOLE_HOSTS: '10.22.9.211,10.22.9.212',
      });
    }
    h.app = await startTestApp({ env: { ...appEnv, ...env } });
    h.url = h.app.url;
    h.browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox', h.marker],
      // Our own handlers close the application and remove its data too
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (err) {
    await h.close().catch(() => {});
    throw err;
  }

  /** A new browser context and page; `errors` collects what the page logged as errors */
  h.newPage = async ({ locale = 'fr-FR' } = {}) => {
    const context = await h.browser.newContext({ locale });
    context.setDefaultTimeout(TIMEOUT);
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (err) => page.errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(msg.text()); });
    harnessOf.set(page, h);
    return page;
  };

  /** Shortcut that skips the sign-in pages: a real session opened by the test helper, handed over as the cookie */
  h.session = async (page, who = 'admin') => {
    const signed = h.app.signIn(typeof who === 'string' ? person(who).username : who);
    await page.context().addCookies([{ name: h.app.deps.auth.cookieName, value: signed.token, url: h.url, httpOnly: true, sameSite: 'Lax' }]);
    return signed;
  };

  /**
   * The administrator's current code. An accepted time step is dead, so a
   * second sign-in within the same 30 s uses the next step (accepted: ±1),
   * and a third waits for the clock to move on
   */
  h.adminCode = async () => {
    for (;;) {
      const now = Math.floor(Date.now() / 30_000);
      const stepNo = Math.max(now, h.lastAdminStep + 1);
      if (stepNo <= now + 1) {
        h.lastAdminStep = stepNo;
        return adminCode(stepNo * 30_000);
      }
      await new Promise((resolve) => setTimeout(resolve, (now + 1) * 30_000 - Date.now() + 50));
    }
  };

  return h;
}

const harnessOf = new WeakMap(); // page → harness

function harness(page) {
  const h = harnessOf.get(page);
  if (!h) throw new Error('This page was not opened with harness.newPage()');
  return h;
}

/**
 * node:test wiring: starts the harness in before() and closes it in after().
 * Returns an object whose fields (url, app, idp, lab, newPage…) are those of
 * the harness once before() has run.
 *
 * Top-level before() hooks of a file run concurrently, so a file's own
 * before() that needs the harness awaits `h.ready` first
 */
export function useHarness(options) {
  let started;
  const ready = new Promise((resolve, reject) => { started = { resolve, reject }; });
  ready.catch(() => {}); // reported by the hook below
  const holder = { ready };
  before(async () => {
    try {
      const h = await startHarness(options);
      Object.assign(holder, h, { ready });
      started.resolve(holder);
    } catch (err) {
      started.reject(err);
      throw err;
    }
  });
  after(async () => {
    await ready.catch(() => {});
    await holder.close?.();
  });
  return holder;
}

// ── Page helpers ───────────────────────────────────────────────────────────

/** The application shell is ready: the rail, the user menu, and the section on screen has drawn its content */
export async function waitForApp(page) {
  await page.waitForSelector('#rail-items .rail-btn');
  await page.waitForSelector('.user-menu-btn');
  await page.waitForSelector('#views > section.view:not([hidden]) > *');
}

/** Sign in through the login page and the mock provider's user picker; → the provider's user */
export async function signInAs(page, who) {
  const h = harness(page);
  if (!h.idp) throw new Error('signInAs needs the mock provider (startHarness({ oidc: true }))');
  const user = person(who);
  if (!/\/login(\?|#|$)/.test(page.url())) await page.goto(`${h.url}/login`);
  await page.click('#sso-button');
  await page.waitForURL(`${h.idp.issuer}/authorize**`);
  await page.click(`a.user[href$="user=${encodeURIComponent(user.username)}"]`);
  await page.waitForURL((u) => u.href.startsWith(h.url) && !u.pathname.startsWith('/login'));
  await waitForApp(page);
  return user;
}

/** Sign in as the local administrator with the login page's form: user name, password and a computed code */
export async function signInAsAdmin(page, { username = TEST_ADMIN.username, password = TEST_ADMIN.password, code } = {}) {
  const h = harness(page);
  if (!/\/login(\?|#|$)/.test(page.url())) await page.goto(`${h.url}/login`);
  if (await page.locator('#login-local').getAttribute('open') === null) await page.click('#login-local summary');
  await page.fill('#local-username', username);
  await page.fill('#local-password', password);
  await page.fill('#local-code', code ?? await h.adminCode());
  await page.click('#local-submit');
  await waitForApp(page);
}

/** Sign out from the user menu in the rail, and land on the login page */
export async function signOut(page) {
  if (!await page.locator('#user-menu').isVisible()) await page.click('.user-menu-btn');
  await page.click('.user-menu-out');
  await page.waitForURL(/\/login(\?.*)?$/);
}

/** Click a language button (the rail's or the login page's) and wait until the page has switched */
export async function setLanguage(page, lang) {
  await page.locator(`button[data-lang="${lang}"]`).first().click();
  await page.waitForFunction((l) => document.documentElement.lang === l, lang);
}

/**
 * Open the console of `device` on `bench` from the diagram; → the pane's
 * locator, once the line is connected and, when the console server asks for
 * a login (the harness's mock lab does), once the application's auto-login
 * has answered it. The device itself stays silent until a key is pressed:
 * `await typeInConsole(pane, '')` then `waitForTerminal(pane, /^R1>$/m)`
 *
 * `login: false` for a line that does not ask (a mock lab started with
 * `mockLab: { telnet: null }`)
 */
export async function openConsole(page, bench, device, { login = Boolean(harness(page).telnetLogin) } = {}) {
  const h = harness(page);
  if (!page.url().startsWith(h.url) || /\/login/.test(new URL(page.url()).pathname)) {
    await page.goto(`${h.url}/#/consoles/${encodeURIComponent(bench)}`);
  } else {
    await page.evaluate((hash) => { location.hash = hash; }, `#/consoles/${encodeURIComponent(bench)}`);
  }
  await page.waitForFunction((name) => document.querySelector('section.view-consoles .canvas-title')?.textContent === name, bench);
  const tile = page.locator('section.view-consoles g.device', { has: page.locator('tspan.name', { hasText: new RegExp(`^${escapeRe(device)}$`) }) });
  await tile.waitFor();
  await tile.click();
  const pane = page.locator('article.pane.pane-console', {
    has: page.locator('.pane-title', { has: page.locator(`strong:text-is("${device}")`) }),
  }).filter({ has: page.locator(`.pane-meta span:text-is("${bench}")`) });
  await pane.waitFor();
  await page.waitForFunction((el) => el.dataset.state !== 'connecting', await pane.elementHandle(), { timeout: TIMEOUT });
  const state = await pane.getAttribute('data-state');
  if (state !== 'connected') throw new Error(`console ${bench}/${device} did not connect (${state}): ${await terminalText(pane)}`);
  // The server writes the password in the same tick as it forwards the
  // prompt, so a key typed after "Password:" is on screen reaches the device
  if (login) await waitForTerminal(pane, /Password:$/);
  return pane;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text on screen of a console pane (or of the first one on the page), one line per row, trailing spaces trimmed */
export async function terminalText(target) {
  const rows = paneOf(target).locator('.xterm-rows').first();
  return rows.evaluate((el) => [...el.children].map((row) => row.textContent.replace(/\u00a0/g, ' ').trimEnd()).join('\n').trimEnd());
}

/** Wait until the console shows text matching `pattern` (RegExp or string); → the whole text */
export async function waitForTerminal(target, pattern, { timeout = TIMEOUT } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(escapeRe(pattern));
  const rows = paneOf(target).locator('.xterm-rows').first();
  try {
    await rows.page().waitForFunction(({ el, source, flags }) => {
      const text = [...el.children].map((row) => row.textContent.replace(/\u00a0/g, ' ').trimEnd()).join('\n').trimEnd();
      return new RegExp(source, flags).test(text);
    }, { el: await rows.elementHandle(), source: re.source, flags: re.flags }, { timeout });
  } catch (err) {
    throw new Error(`the console never showed ${re}; it shows:\n${await terminalText(target)}`, { cause: err });
  }
  return terminalText(target);
}

/** Type a line into a console pane: focus its terminal, type, press Enter */
export async function typeInConsole(target, line) {
  const pane = paneOf(target);
  await pane.locator('.xterm').first().click();
  if (line) await pane.page().keyboard.type(line);
  await pane.page().keyboard.press('Enter');
}

const paneOf = (target) => (typeof target.locator === 'function' && typeof target.goto === 'function'
  ? target.locator('article.pane.pane-console').first()
  : target);
