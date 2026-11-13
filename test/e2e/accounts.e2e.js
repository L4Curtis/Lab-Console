/**
 * Accounts in a real browser: an invitation from the administration page to
 * a newcomer's first session; a promoted account registering its passkey at
 * the next sign-in, then signing in with one click (Chromium's virtual
 * authenticator); an administrator promoting a student from the Users tab
 *
 * PUBLIC_URL is http://localhost:<port>: passkeys need a domain name in a
 * secure context, which localhost is
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, signOut, waitForApp, addVirtualAuthenticator } from './harness.js';
import { call, invite, signUp, PASSWORD } from '../helpers/accounts.js';

const h = useHarness({ mockLab: false, publicHost: 'localhost' });

/** Open the local form of the login page (closed when a provider exists) and post a user name and password */
async function passwordSignIn(page, username, password = PASSWORD) {
  if (!/\/login(\?|#|$)/.test(page.url())) await page.goto(`${h.url}/login`);
  if (await page.locator('#login-local').getAttribute('open') === null) await page.click('#login-local summary');
  await page.fill('#local-username', username);
  await page.fill('#local-password', password);
  await page.click('#local-submit');
}

test('invitation sign-up: an administrator creates the link, a newcomer creates an account and lands in the application', async () => {
  const admin = await h.newPage();
  await h.session(admin, 'ada');
  await admin.goto(`${h.url}/#/admin/invitations`);
  await waitForApp(admin);
  await admin.click('section.view-admin button[data-action="create"]');
  await admin.fill('dialog.modal input[name="note"]', 'Zoé');
  await admin.click('dialog.modal button[data-action="confirm"]');
  const field = admin.locator('dialog.modal input.link-field');
  await field.waitFor();
  const url = await field.inputValue();
  assert.match(url, new RegExp(`^${h.url}/join#[A-Za-z0-9_-]{43}$`));
  await admin.click('dialog.modal .form-actions button');
  await admin.waitForSelector('tr[data-invitation] >> text=Zoé');

  const page = await h.newPage();
  await page.goto(url);
  await page.waitForSelector('#join-box:not([hidden])');
  assert.equal(new URL(page.url()).hash, '', 'the token left the address bar');
  assert.equal(await page.textContent('#join-sub'), 'Invitation pour un compte Étudiant.');
  await page.fill('#join-username', 'zoe');
  await page.fill('#join-name', 'Zoé Martin');
  await page.fill('#join-password', PASSWORD);
  await page.fill('#join-confirm', 'not the same at all');
  await page.click('#join-submit');
  assert.equal(await page.textContent('#join-error'), 'Les deux mots de passe ne sont pas identiques.');
  await page.fill('#join-confirm', PASSWORD);
  await page.click('#join-submit');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Zoé Martin');
  assert.equal(await page.textContent('.user-menu-role'), 'Étudiant');
  assert.equal(await page.locator('#rail-items a[data-path="admin"]').count(), 0, 'no administration for a student');

  // The link was for one person: a second visit is refused
  const again = await h.newPage();
  await again.goto(url);
  await again.waitForSelector('#join-message:not([hidden])');
  assert.match(await again.textContent('#join-message'), /n'est pas valable/);
  assert.equal(await again.locator('#join-box').isHidden(), true);

  assert.deepEqual(admin.errors, []);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(again.errors, []);
  for (const p of [admin, page, again]) await p.context().close();
});

test('a promoted account registers a passkey at its next sign-in, then signs in with one click', async () => {
  const { token } = await invite(h.app);
  assert.equal((await signUp(h.app, token, { username: 'yann', name: 'Yann Le Goff' })).status, 200);
  assert.equal((await call(h.app, 'admin', 'PATCH', `/api/accounts/users/${encodeURIComponent('local:yann')}`, { role: 'admin' })).status, 200);

  const page = await h.newPage();
  const authenticator = await addVirtualAuthenticator(page);
  await page.goto(`${h.url}/login`);
  await page.waitForSelector('#passkey-button:visible');
  await passwordSignIn(page, 'yann');
  // The password was right, but it is not enough: a passkey first
  await page.waitForSelector('#login-step:not([hidden])');
  assert.equal(await page.textContent('#step-title'), "Enregistrez une clé d'accès");
  assert.equal(await page.locator('#login-local').isHidden(), true);
  await page.click('#step-button');
  await waitForApp(page);
  await page.waitForSelector('#rail-items a[data-path="admin"]');
  const credentials = await authenticator.credentials();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true, 'discoverable, so it can sign in alone');

  // My account lists it
  await page.goto(`${h.url}/#/account`);
  await page.waitForSelector('section.view-account li[data-passkey]');
  assert.equal(await page.locator('section.view-account li[data-passkey]').count(), 1);

  // One click, with the button (the local form stays closed: no conditional UI yet)
  await signOut(page);
  await page.click('#passkey-button');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Yann Le Goff');
  assert.equal(await page.textContent('.user-menu-role'), 'Administrateur');

  // Conditional UI: opening the local form offers the passkey among the user
  // name's suggestions, which the virtual authenticator picks by itself
  await signOut(page);
  await page.click('#login-local summary');
  await waitForApp(page);

  // The password alone asks for the passkey, never more. Here the passkey is
  // held as a non-discoverable credential, so that the suggestions offer
  // nothing and the password form is really used
  const [credential] = await authenticator.credentials();
  await authenticator.remove();
  await addVirtualAuthenticator(page, { credentials: [{ ...credential, isResidentCredential: false }] });
  await signOut(page);
  await passwordSignIn(page, 'yann');
  await page.waitForSelector('#login-step:not([hidden])');
  assert.equal(await page.textContent('#step-title'), 'Confirmez avec votre clé d\'accès');
  await page.click('#step-button');
  await waitForApp(page);
  const methods = (await h.app.deps.audit.query({ action: 'auth.login' })).filter((e) => e.actor.id === 'local:yann').map((e) => e.details.method);
  assert.deepEqual(methods, ['local+passkey', 'passkey', 'passkey', 'local+passkey-enrol', 'signup'], 'newest first: password + passkey, conditional UI, the button, enrolment, sign-up');

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('an administrator promotes a student from the Users tab: signed out at once, back as an administrator', async () => {
  const student = await h.newPage();
  await signInAs(student, 'bilal'); // recorded in the directory at this sign-in
  const admin = await h.newPage();
  await h.session(admin, 'ada');
  await admin.goto(`${h.url}/#/admin/users`);
  await waitForApp(admin);
  const row = admin.locator('tr[data-account="oidc:mock-student2"]');
  await row.waitFor();
  assert.equal(await row.locator('select.role-select').inputValue(), '', 'the role comes from the groups');
  await row.locator('select.role-select').selectOption('admin');
  await admin.waitForSelector('dialog.modal >> text=Bilal Haddad devient Administrateur.');
  await admin.click('dialog.modal button[data-action="confirm"]');
  await admin.waitForFunction(() => document.querySelector('tr[data-account="oidc:mock-student2"] select.role-select')?.value === 'admin');

  // The student's session is over: the next page load is the login page
  await student.reload();
  await student.waitForURL(/\/login/);
  await signInAs(student, 'bilal');
  await student.waitForSelector('#rail-items a[data-path="admin"]');
  await student.click('.user-menu-btn');
  assert.equal(await student.textContent('.user-menu-role'), 'Administrateur', 'the role set here wins over the groups');

  assert.deepEqual(admin.errors, []);
  for (const p of [admin, student]) await p.context().close();
});
