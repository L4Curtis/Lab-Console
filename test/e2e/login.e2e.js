/**
 * The sign-in page and the user menu in a real browser: the identity
 * provider's button through the mock provider, the local administrator's
 * form with a computed code, the messages a refusal shows, both languages,
 * and sign-out from the rail
 *
 * Self-contained: it starts the mock provider and the application on
 * ephemeral ports and drives the system Chromium through playwright-core
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startTestApp, TEST_ADMIN, adminCode } from '../helpers/app.js';
import { startMockOidc } from '../../dev/mock-oidc.js';

let idp;
let lab;
let browser;
const pageErrors = [];
const failedRequests = []; // status and URL of every refused request, checked at the end

before(async () => {
  idp = await startMockOidc({ port: 0 });
  lab = await startTestApp({
    env: { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'lab-console', OIDC_CLIENT_SECRET: 'mock-secret', OIDC_ADMIN_GROUPS: 'admins', OIDC_PROVIDER_NAME: 'Mock SSO' },
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close();
  await lab?.close();
  await idp?.close();
});

/** Sign out from the rail; requests the page still had in flight may meet the ended session (401), which is expected */
async function signOutFrom(page) {
  const from = failedRequests.length;
  await page.click('.user-menu-out');
  await page.waitForURL(/\/login$/);
  const during = failedRequests.splice(from);
  failedRequests.push(...during.filter((r) => !/^401 .*\/api\//.test(r)));
}

async function freshPage(locale = 'fr-FR') {
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`); });
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) pageErrors.push(msg.text()); });
  return page;
}

test('an anonymous visit lands on the login page, in French, with the provider button', async () => {
  const page = await freshPage();
  await page.goto(lab.url);
  await page.waitForURL(/\/login$/);
  await page.waitForSelector('#sso-button:visible');
  assert.equal(await page.textContent('#sso-button'), 'Se connecter avec Mock SSO');
  assert.equal(await page.getAttribute('html', 'lang'), 'fr');
  assert.equal(await page.title(), 'Connexion · Lab Console');
  assert.equal(await page.locator('#login-local').getAttribute('open'), null, 'the local form is discreet when a provider exists');
  assert.equal(await page.locator('#login-message').isVisible(), false);
  await page.context().close();
});

test('the identity provider: pick a student, come back signed in, see the user menu, sign out', async () => {
  const page = await freshPage();
  await page.goto(`${lab.url}/#/infra`);
  await page.waitForURL(/\/login#\/infra$/); // the browser keeps the fragment across the redirect
  await page.click('#sso-button');
  await page.waitForURL(`${idp.issuer}/authorize**`);
  await page.click('a.user:has-text("Alice Martin")');
  await page.waitForSelector('.user-menu-btn');
  assert.equal(new URL(page.url()).hash, '#/infra', 'back where the student was heading');

  assert.equal(await page.textContent('.user-badge'), 'AM');
  await page.click('.user-menu-btn');
  await page.waitForSelector('#user-menu:visible');
  assert.equal(await page.textContent('.user-menu-name'), 'Alice Martin');
  assert.equal(await page.textContent('.user-menu-role'), 'Étudiant');
  assert.equal(await page.textContent('.user-menu-via'), 'Via Mock SSO');
  assert.equal(await page.getAttribute('.user-menu-btn', 'aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#user-menu').isVisible(), false, 'Escape closes the menu');

  await page.click('.user-menu-btn');
  await signOutFrom(page); // through the provider's end-session endpoint
  assert.equal(idp.signOuts.length > 0, true, 'the provider was told');
  const me = await page.evaluate(() => fetch('/auth/me').then((r) => r.json()));
  assert.equal(me.user, null);
  await page.context().close();
});

test('the local administrator: user name, password and code, then the application', async () => {
  const page = await freshPage('en-US');
  await page.goto(`${lab.url}/login`);
  await page.click('#login-local summary');
  await page.fill('#local-username', TEST_ADMIN.username);
  await page.fill('#local-password', 'not-the-password');
  await page.fill('#local-code', adminCode());
  await page.click('#local-submit');
  await page.waitForSelector('#local-error:visible');
  assert.equal(await page.textContent('#local-error'), 'Connexion refusée. Vérifiez l\'identifiant, le mot de passe et le code.',
    'one generic message, in the page language (the server default is French)');
  assert.equal(await page.inputValue('#local-password'), '', 'the password field is emptied');

  // The page's own language switch
  await page.click('[data-lang="en"]');
  assert.equal(await page.textContent('#local-error'), 'Sign-in refused. Check the user name, the password and the code.');
  assert.equal(await page.textContent('#local-submit'), 'Sign in');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');

  await page.fill('#local-password', TEST_ADMIN.password);
  await page.fill('#local-code', adminCode());
  await page.click('#local-submit');
  await page.waitForSelector('.user-menu-btn');
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-role'), 'Administrator');
  assert.equal(await page.textContent('.user-menu-via'), 'Local account');
  await signOutFrom(page);
  await page.context().close();
});

test('a session revoked by an administrator sends the page back to the login page', async () => {
  const page = await freshPage();
  const { id, token } = lab.signIn('student2');
  await page.context().addCookies([{ name: lab.deps.auth.cookieName, value: token, url: lab.url, httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(`${lab.url}/#/consoles`);
  await page.waitForSelector('.user-menu-btn');
  await page.waitForSelector('section.view-consoles svg'); // the screen is fully loaded
  const from = failedRequests.length;
  lab.deps.auth.sessions.revoke(id);
  // The next API call meets the gate
  page.evaluate(() => import('/js/core/api.js').then(({ getJson }) => getJson('/api/modules')).catch(() => {}));
  await page.waitForURL(/\/login#\/consoles/); // the screen keeps its own route (#/consoles/<bench>)
  failedRequests.splice(from); // the refused calls that led here
  await page.waitForSelector('#sso-button:visible');
  await page.context().close();
});

test('a refusal from the sign-in flow is explained on the login page', async () => {
  const page = await freshPage();
  await page.goto(`${lab.url}/login?error=not_allowed`);
  await page.waitForSelector('#login-message:visible');
  assert.match(await page.textContent('#login-message'), /aucun groupe autorisé/);
  await page.goto(`${lab.url}/login?error=<script>`);
  await page.waitForSelector('#sso-button:visible');
  assert.equal(await page.locator('#login-message').isVisible(), false, 'an unknown reason shows nothing');
  await page.context().close();
});

test('no errors in the pages, and no request refused but the expected ones', () => {
  assert.deepEqual(pageErrors, []);
  const unexpected = failedRequests.filter((r) => !/^401 .*\/auth\/local$/.test(r));
  assert.deepEqual(unexpected, []);
});
