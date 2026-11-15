/**
 * Accounts in a real browser (Chromium's virtual authenticator plays the
 * passkey): every local account signs in with a passkey (owner decision,
 * 15 Nov). An invitation from the administration page to a newcomer's first
 * session, the passkey registered as part of the sign-up, then one click; a
 * student whose account has no passkey yet (made before the rule, or a
 * sign-up left half-way) made to register one at the next sign-in, then
 * signing in with one click, conditional UI, or password then passkey; a
 * reset link that replaces the passkey; an administrator promoting a
 * student from the Users tab
 *
 * PUBLIC_URL is http://localhost:<port>: passkeys need a domain name in a
 * secure context, which localhost is
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, signOut, waitForApp, addVirtualAuthenticator, person } from './harness.js';
import { call, invite, signUp, createLocalAccount, passkeySignIn, PASSWORD } from '../helpers/accounts.js';
import { TestBrowser } from '../helpers/browser.js';

const h = useHarness({ mockLab: false, publicHost: 'localhost' });

/** Open the local form of the login page (closed when a provider exists) and post a user name and password */
async function passwordSignIn(page, username, password = PASSWORD) {
  if (!/\/login(\?|#|$)/.test(page.url())) await page.goto(`${h.url}/login`);
  if (await page.locator('#login-local').getAttribute('open') === null) await page.click('#login-local summary');
  await page.fill('#local-username', username);
  await page.fill('#local-password', password);
  await page.click('#local-submit');
}

/** The sign-in methods of the audit trail for this account, newest first */
const loginMethods = async (id) => (await h.app.deps.audit.query({ action: 'auth.login' })).filter((e) => e.actor.id === id).map((e) => e.details.method);

test('invitation sign-up: an administrator creates the link, a newcomer creates an account with its passkey, lands in the application, and comes back in one click', async () => {
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
  const authenticator = await addVirtualAuthenticator(page);
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

  // The account exists, but no session before its passkey: a student too
  await page.waitForSelector('#join-step:not([hidden])');
  assert.match(await page.textContent('#join-message'), /^Votre compte est créé\. Dernière étape/);
  assert.equal(await page.getAttribute('#join-message', 'data-tone'), 'success', 'what went well is not shown as a warning');
  assert.equal(await page.locator('#join-box').isHidden(), true);
  assert.equal(await page.textContent('#join-step h2'), 'Enregistrez une clé d’accès');
  assert.equal((await page.context().cookies()).some((c) => c.name === h.app.deps.auth.cookieName), false, 'no session yet');
  await page.click('#join-step-button');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Zoé Martin');
  assert.equal(await page.textContent('.user-menu-role'), 'Étudiant');
  assert.equal(await page.locator('#rail-items a[data-path="admin"]').count(), 0, 'no administration for a student');
  const credentials = await authenticator.credentials();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true, 'discoverable, so it can sign in alone');

  // Next time: one click, no password
  await signOut(page);
  await page.click('#passkey-button');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Zoé Martin');
  assert.deepEqual(await loginMethods('local:zoe'), ['passkey', 'signup+passkey-enrol']);

  // The link was for one person: a second visit is refused
  const again = await h.newPage();
  await addVirtualAuthenticator(again);
  await again.goto(url);
  await again.waitForSelector('#join-message:not([hidden])');
  assert.match(await again.textContent('#join-message'), /n[’']est pas valable/);
  assert.equal(await again.locator('#join-box').isHidden(), true);

  assert.deepEqual(admin.errors, []);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(again.errors, []);
  for (const p of [admin, page, again]) await p.context().close();
});

test('a student whose account has no passkey yet registers one at the next sign-in, then signs in with one click', async () => {
  // An account without a passkey, as those made before the rule, or a sign-up left half-way
  const { token } = await invite(h.app);
  assert.deepEqual((await signUp(h.app, token, { username: 'yann', name: 'Yann Le Goff' })).body, { step: 'passkey-enrol' });
  assert.equal(h.app.deps.services.accounts.get('local:yann').needsPasskey, true);

  const page = await h.newPage();
  const authenticator = await addVirtualAuthenticator(page);
  // Every passkey request of the tab, with its mediation, kept across page loads
  await page.addInitScript(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options) => {
      const seen = JSON.parse(sessionStorage.getItem('credential-gets') || '[]');
      seen.push(options?.mediation ?? 'optional');
      sessionStorage.setItem('credential-gets', JSON.stringify(seen));
      return get(options);
    };
  });
  const credentialGets = async () => {
    const seen = await page.evaluate(() => JSON.parse(sessionStorage.getItem('credential-gets') || '[]'));
    await page.evaluate(() => sessionStorage.removeItem('credential-gets'));
    return seen;
  };
  await page.goto(`${h.url}/login`);
  await page.waitForSelector('#passkey-button:visible');
  await passwordSignIn(page, 'yann');
  // The password was right, but it is not enough: a passkey first
  await page.waitForSelector('#login-step:not([hidden])');
  assert.equal(await page.textContent('#step-title'), 'Enregistrez une clé d’accès');
  assert.match(await page.textContent('#step-text'), /^Chaque compte local se connecte avec une clé d’accès/);
  assert.equal(await page.locator('#login-local').isHidden(), true);
  assert.equal((await page.context().cookies()).some((c) => c.name === h.app.deps.auth.cookieName), false, 'no session with the password alone');
  await page.click('#step-button');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-role'), 'Étudiant');
  const credentials = await authenticator.credentials();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true, 'discoverable, so it can sign in alone');

  // My account lists it, and it cannot be removed: it is the only way in
  await page.goto(`${h.url}/#/account`);
  await page.waitForSelector('section.view-account li[data-passkey]');
  assert.equal(await page.locator('section.view-account li[data-passkey]').count(), 1);
  assert.equal(await page.locator('section.view-account button[data-action="remove-passkey"]').isDisabled(), true, 'the last passkey stays');

  // One click, with the button (the local form stays closed: no conditional UI yet)
  await signOut(page);
  await credentialGets();
  await page.click('#passkey-button');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Yann Le Goff');
  assert.deepEqual(await credentialGets(), ['optional'], 'the button: a dialog, and no suggestion was offered while the form was closed');

  // Conditional UI: opening the local form offers the passkey among the user
  // name's suggestions, which the virtual authenticator picks by itself;
  // nothing is clicked but the form's summary
  await signOut(page);
  await credentialGets();
  assert.equal(await page.getAttribute('#local-username', 'autocomplete'), 'username webauthn');
  await page.click('#login-local summary');
  await waitForApp(page);
  assert.deepEqual(await credentialGets(), ['conditional'], 'the passkey came from the suggestions (mediation: conditional)');
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Yann Le Goff');

  // The password alone asks for the passkey, never more. Here the passkey is
  // held as a non-discoverable credential, so that the suggestions offer
  // nothing and the password form is really used
  const [credential] = await authenticator.credentials();
  await authenticator.remove();
  await addVirtualAuthenticator(page, { credentials: [{ ...credential, isResidentCredential: false }] });
  await signOut(page);
  await passwordSignIn(page, 'yann');
  await page.waitForSelector('#login-step:not([hidden])');
  assert.equal(await page.textContent('#step-title'), 'Confirmez avec votre clé d’accès');
  await page.click('#step-button');
  await waitForApp(page);
  assert.deepEqual(await loginMethods('local:yann'), ['local+passkey', 'passkey', 'passkey', 'local+passkey-enrol'], 'newest first: password + passkey, conditional UI, the button, enrolment');

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a reset link: a new password, the lost passkey replaced by a new one, then the application', async () => {
  const { id, key: lost } = await createLocalAccount(h.app, 'xena', { name: 'Xéna Roy' });
  const link = await call(h.app, 'admin', 'POST', `/api/accounts/users/${encodeURIComponent(id)}/reset-link`, { ttl: '1h' });
  assert.equal(link.status, 200);

  const page = await h.newPage();
  const authenticator = await addVirtualAuthenticator(page);
  await page.goto(link.body.url);
  await page.waitForSelector('#join-box:not([hidden])');
  assert.match(await page.textContent('#join-sub'), /^Choisissez un nouveau mot de passe pour xena, puis enregistrez une nouvelle clé d’accès/);
  await page.fill('#join-password', 'a brand new passphrase');
  await page.fill('#join-confirm', 'a brand new passphrase');
  await page.click('#join-submit');
  await page.waitForSelector('#join-step:not([hidden])');
  assert.match(await page.textContent('#join-message'), /^Mot de passe enregistré, anciennes clés d’accès supprimées/);
  assert.equal(await page.getAttribute('#join-message', 'data-tone'), 'success');
  assert.equal(h.app.deps.services.accounts.get(id).passkeys, 0, 'the lost one is gone already');
  await page.click('#join-step-button');
  await waitForApp(page);
  await page.click('.user-menu-btn');
  assert.equal(await page.textContent('.user-menu-name'), 'Xéna Roy');
  assert.equal((await authenticator.credentials()).length, 1);
  assert.equal(h.app.deps.services.accounts.get(id).passkeys, 1);
  assert.equal((await passkeySignIn(h.app, new TestBrowser(), lost)).status, 401, 'the lost passkey no longer signs in');

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('on a phone, a link for several people: the newcomer registers the passkey, then waits for approval without a session', async () => {
  const { url } = await invite(h.app, { uses: 5 });
  const page = await h.newPhonePage();
  const authenticator = await addVirtualAuthenticator(page);
  await page.goto(url);
  await page.waitForSelector('#join-box:not([hidden])');
  await page.fill('#join-username', 'wanda');
  await page.fill('#join-name', 'Wanda Petit');
  await page.fill('#join-password', PASSWORD);
  await page.fill('#join-confirm', PASSWORD);
  await page.click('#join-submit');
  await page.waitForSelector('#join-step:not([hidden])');
  assert.match(await page.textContent('#join-message'), /^Votre compte est créé\. Enregistrez la clé d’accès/);
  await page.click('#join-step-button');
  await page.waitForSelector('#join-done:not([hidden])');
  assert.match(await page.textContent('#join-message'), /^Votre compte et sa clé d’accès sont prêts\. Un administrateur doit valider le compte/);
  assert.equal(await page.getAttribute('#join-message', 'data-tone'), 'success');
  assert.equal(await page.locator('#join-step').isHidden(), true);
  assert.equal((await page.context().cookies()).some((c) => c.name === h.app.deps.auth.cookieName), false, 'no session before the approval');
  assert.equal((await authenticator.credentials()).length, 1);
  const account = h.app.deps.services.accounts.get('local:wanda');
  assert.equal(account.state, 'pending');
  assert.equal(account.passkeys, 1);
  // The way out keeps to the phone's full width
  const box = await page.locator('#join-done .btn').boundingBox();
  assert.ok(box.width >= 390 - 2 * 16 - 1 && box.height >= 44, `a full-width button of 44 px at least (${box.width} × ${box.height})`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a browser without passkeys is told before anything is sent: the link stays usable from another browser', async () => {
  const { url, token } = await invite(h.app);
  const page = await h.newPage();
  await page.addInitScript(() => { delete window.PublicKeyCredential; });
  const posted = [];
  page.on('request', (r) => { if (r.method() === 'POST') posted.push(r.url()); });
  await page.goto(url);
  await page.waitForSelector('#join-done:not([hidden])');
  assert.equal(await page.textContent('#join-title'), 'Clés d’accès indisponibles ici');
  assert.match(await page.textContent('#join-message'), /^Ce navigateur ne sait pas utiliser les clés d’accès/);
  assert.equal(await page.locator('#join-box').isHidden(), true);
  assert.deepEqual(posted, [], 'nothing sent');
  assert.equal((await call(h.app, null, 'POST', '/auth/invitation', { token })).status, 200, 'the link still works');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('an administrator promotes a student from the Users tab: confirmed, signed out at once, back as an administrator', async () => {
  const student = await h.newPage();
  await signInAs(student, 'bilal'); // recorded in the directory at this sign-in
  const admin = await h.newPage();
  await signInAs(admin, 'ada');
  await admin.goto(`${h.url}/#/admin/users`);
  await waitForApp(admin);
  const row = admin.locator('tr[data-account="oidc:mock-student2"]');
  const promote = async () => {
    await row.waitFor();
    assert.equal(await row.locator('select.role-select').inputValue(), '', 'the role comes from the groups');
    await row.locator('select.role-select').selectOption('admin');
    await admin.waitForSelector('dialog.modal >> text=Bilal Haddad devient Administrateur.');
    await admin.click('dialog.modal button[data-action="confirm"]');
  };
  await promote();
  // Making an administrator is confirmed: an SSO administrator signs in again at the provider, and comes back to this tab
  await admin.waitForSelector('dialog.modal >> text=Me reconnecter');
  await admin.click('dialog.modal button[data-action="confirm"]');
  await admin.waitForURL(`${h.idp.issuer}/authorize**`);
  await admin.click(`a.user[href$="user=${encodeURIComponent(person('ada').username)}"]`);
  await admin.waitForURL((u) => u.href.startsWith(h.url) && u.hash === '#/admin/users');
  await waitForApp(admin);
  assert.equal(await row.locator('select.role-select').inputValue(), '', 'nothing changed before the confirmation');
  // Confirmed for a few minutes: the same change goes through at once. The server's answer, not the
  // select's value (the page may show the choice before the change is saved): from then on the student's session is over
  const saved = admin.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/accounts/users/oidc%3Amock-student2') && r.status() !== 403);
  await promote();
  assert.equal((await saved).status(), 200);
  await admin.waitForFunction(() => document.querySelector('tr[data-account="oidc:mock-student2"] select.role-select')?.value === 'admin');

  // The next page load is the login page
  await student.reload();
  await student.waitForURL(/\/login/);
  await signInAs(student, 'bilal');
  await student.waitForSelector('#rail-items a[data-path="admin"]');
  await student.click('.user-menu-btn');
  assert.equal(await student.textContent('.user-menu-role'), 'Administrateur', 'the role set here wins over the groups');

  assert.deepEqual(admin.errors, []);
  for (const p of [admin, student]) await p.context().close();
});
