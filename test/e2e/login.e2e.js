/**
 * The sign-in page and the user menu in a real browser: the identity
 * provider's button through the mock provider, the local administrator's
 * form with a computed code, the messages a refusal shows, both languages,
 * and sign-out from the rail
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAsAdmin, setLanguage, TEST_ADMIN } from './harness.js';

const h = useHarness({ mockLab: false });
const pages = [];
const failedRequests = []; // status and URL of every refused request, checked at the end

/** Sign out from the rail; requests the page still had in flight may meet the ended session (401), which is expected */
async function signOutFrom(page) {
  const from = failedRequests.length;
  await page.click('.user-menu-out');
  await page.waitForURL(/\/login$/);
  const during = failedRequests.splice(from);
  failedRequests.push(...during.filter((r) => !/^401 .*\/api\//.test(r)));
}

async function freshPage(locale = 'fr-FR') {
  const page = await h.newPage({ locale });
  pages.push(page);
  page.on('response', (res) => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`); });
  return page;
}

test('an anonymous visit lands on the login page, in French, with the provider button', async () => {
  const page = await freshPage();
  await page.goto(h.url);
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
  await page.goto(`${h.url}/#/infra`);
  await page.waitForURL(/\/login#\/infra$/); // the browser keeps the fragment across the redirect
  await page.click('#sso-button');
  await page.waitForURL(`${h.idp.issuer}/authorize**`);
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
  assert.equal(h.idp.signOuts.length > 0, true, 'the provider was told');
  const me = await page.evaluate(() => fetch('/auth/me').then((r) => r.json()));
  assert.equal(me.user, null);
  await page.context().close();
});

test('the local administrator: user name, password and code, then the application', async () => {
  const page = await freshPage('en-US');
  await page.goto(`${h.url}/login`);
  await page.click('#login-local summary');
  await page.fill('#local-username', TEST_ADMIN.username);
  await page.fill('#local-password', 'not-the-password');
  await page.fill('#local-code', await h.adminCode());
  await page.click('#local-submit');
  await page.waitForSelector('#local-error:visible');
  assert.equal(await page.textContent('#local-error'), 'Connexion refusée. Vérifiez l\'identifiant, le mot de passe et, pour l\'administrateur du serveur, le code.',
    'one generic message, in the page language (the server default is French)');
  assert.equal(await page.inputValue('#local-password'), '', 'the password field is emptied');

  // The page's own language switch
  await setLanguage(page, 'en');
  assert.equal(await page.textContent('#local-error'), 'Sign-in refused. Check the user name, the password and, for the server\'s administrator, the code.');
  assert.equal(await page.textContent('#local-submit'), 'Sign in');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');

  await signInAsAdmin(page); // the code is computed from the test secret, as an authenticator would
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-role'), 'Administrator');
  assert.equal(await page.textContent('.user-menu-via'), 'Local account');
  await signOutFrom(page);
  await page.context().close();
});

test('a session revoked by an administrator sends the page back to the login page', async () => {
  const page = await freshPage();
  const { id, token } = h.app.signIn('student2');
  await page.context().addCookies([{ name: h.app.deps.auth.cookieName, value: token, url: h.url, httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(`${h.url}/#/consoles`);
  await page.waitForSelector('.user-menu-btn');
  await page.waitForSelector('section.view-consoles svg'); // the screen is fully loaded
  const from = failedRequests.length;
  h.app.deps.auth.sessions.revoke(id);
  // The next API call meets the gate
  page.evaluate(() => import('/js/core/api.js').then(({ getJson }) => getJson('/api/modules')).catch(() => {}));
  await page.waitForURL(/\/login#\/consoles/); // the screen keeps its own route (#/consoles/<bench>)
  failedRequests.splice(from); // the refused calls that led here
  await page.waitForSelector('#sso-button:visible');
  await page.context().close();
});

test('a refusal from the sign-in flow is explained on the login page', async () => {
  const page = await freshPage();
  await page.goto(`${h.url}/login?error=not_allowed`);
  await page.waitForSelector('#login-message:visible');
  assert.match(await page.textContent('#login-message'), /aucun groupe autorisé/);
  await page.goto(`${h.url}/login?error=<script>`);
  await page.waitForSelector('#sso-button:visible');
  assert.equal(await page.locator('#login-message').isVisible(), false, 'an unknown reason shows nothing');
  await page.context().close();
});

test('no errors in the pages, and no request refused but the expected ones', () => {
  assert.deepEqual(pages.flatMap((p) => p.errors), []);
  const unexpected = failedRequests.filter((r) => !/^401 .*\/auth\/local$/.test(r));
  assert.deepEqual(unexpected, []);
});
