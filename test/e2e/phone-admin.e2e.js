/**
 * Part C of the ergonomics redesign on a phone (390 × 844, touch) and on a
 * PC (docs/v2/UX.md §10.1, §10.7–§10.12): the administration as a hub of
 * screens, Accueil with what needs me, Aide folded, Mon compte as cards, the
 * public pages without a card. Every primary flow has 44 px targets, nothing is
 * wider than the screen, and the same screens still work at 1440 px
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs } from './harness.js';
import { invite, signUp } from '../helpers/accounts.js';
import { contrastFailures } from './contrast.js';

// localhost: local accounts sign in with a passkey, which needs a domain name (invitations are refused without one)
const h = useHarness({ publicHost: 'localhost' });
const pages = [];
after(async () => { while (pages.length) await pages.pop().context().close(); });

const phone = async (who, options = {}) => {
  const page = await h.newPhonePage(options);
  pages.push(page);
  await h.session(page, who);
  return page;
};
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** The visible interactive elements of `scope` that a finger cannot hit: under 44 px in either direction */
const tooSmall = (page, scope) => page.locator(scope).evaluate((root) => [...root.querySelectorAll('button, a[href], select, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]), textarea, [role="tab"], summary')]
  .filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest('[hidden], .sr-only') && getComputedStyle(el).visibility !== 'hidden';
  })
  .map((el) => ({ el, r: el.getBoundingClientRect() }))
  .filter(({ r }) => r.width < 44 || r.height < 44)
  .map(({ el, r }) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`));
const goTo = async (page, hash, selector) => {
  await page.evaluate((to) => { location.hash = to; }, hash);
  await page.locator(selector).first().waitFor();
};
const ADMIN_TABS = ['users', 'invitations', 'sso', 'lab', 'diagram', 'switches', 'sessions', 'audit', 'announcement'];

test('the administration on a phone: the hub, a screen with its way back, an invitation and a validation by thumb', async () => {
  // An account waiting for approval: signed up through a link for two people
  const { token } = await invite(h.app, { uses: 2 });
  assert.equal((await signUp(h.app, token, { username: 'zoe', name: 'Zoé Martin' })).status, 200);
  const bilal = await h.newPage();
  await signInAs(bilal, 'bilal'); // recorded in the directory at this sign-in
  await bilal.context().close();
  const ada = await phone('ada');
  await ada.goto(`${h.url}/#/admin`);
  await ada.locator('section.view-admin[data-mode="hub"] .admin-nav').waitFor();
  assert.equal(await ada.locator('.admin-nav .admin-link').count(), 12, 'the hub lists every screen of the administration, in three groups');
  assert.deepEqual(await ada.locator('.admin-nav .admin-group-title').allTextContents(), ['Comptes', 'Labo', 'Suivi']);
  assert.deepEqual(await tooSmall(ada, 'section.view-admin .admin-nav'), [], 'rows of the hub are 44 px or more');
  await ada.locator('.admin-link[data-entry="users"] .count', { hasText: '1' }).waitFor(); // the hub says how many accounts wait
  assert.equal(await ada.locator('.admin-link[data-entry="infra"]').getAttribute('href'), '#/infra', 'the lab screens of other sections are in the hub');
  assert.equal(await ada.locator('.admin-link[data-entry="teams"]').getAttribute('href'), '#/team/all');
  assert.equal(await overflow(ada), 0);

  // A screen opens full height, with ← to the hub
  await ada.locator('.admin-link[data-entry="users"]').tap();
  await ada.locator('section.view-admin[data-mode="tab"]').waitFor();
  assert.equal(await ada.locator('section.view-admin h1').textContent(), 'Utilisateurs');
  assert.equal(await ada.locator('.admin-nav').isVisible(), false);
  const row = ada.locator('section.view-admin tr[data-account="local:zoe"]');
  await row.waitFor();
  assert.equal(await row.getAttribute('data-state'), 'pending');
  assert.equal(await ada.locator('section.view-admin [data-panel="waiting"]').isVisible(), true, 'the accounts waiting come first, with a notice');
  assert.equal(await ada.locator('section.view-admin tbody tr').first().getAttribute('data-account'), 'local:zoe');
  assert.deepEqual(await tooSmall(ada, 'section.view-admin .page-header'), [], 'the primary action and the back arrow are hit-sized');
  assert.deepEqual(await tooSmall(ada, 'section.view-admin .data-list'), [], 'the card of an account: its actions are 44 px or more');
  assert.equal(await overflow(ada), 0);

  // The role of an SSO or local account is chosen in the card's ⋯ (a sheet), not in a select squeezed into the row
  const bilalRow = ada.locator('section.view-admin tr[data-account="oidc:mock-student2"]');
  await bilalRow.waitFor();
  await bilalRow.locator('.icon-btn[aria-haspopup]').tap();
  await ada.locator('.menu-item[data-id="role"]').tap();
  const sheet = ada.locator('dialog.modal[open]');
  await sheet.waitFor();
  await ada.waitForFunction(() => document.querySelector('dialog.modal[open]').getAnimations({ subtree: true }).every((a) => a.playState === 'finished')); // it slides in
  assert.ok(await sheet.evaluate((d) => Math.abs(d.getBoundingClientRect().bottom - innerHeight) < 2), 'a bottom sheet');
  await sheet.locator('select[name="role"]').waitFor();
  await ada.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });

  // Validate the account with a thumb: the card's button
  await row.locator('button[data-action="approve"]').tap();
  await ada.locator('.toast', { hasText: 'Compte validé' }).waitFor();
  await ada.waitForFunction(() => document.querySelector('tr[data-account="local:zoe"]')?.dataset.state === 'active');
  assert.equal(await ada.locator('section.view-admin [data-panel="waiting"]').isVisible(), false);

  // The primary action of the header leads to the invitation form, a sheet again
  await ada.locator('section.view-admin .ph-primary-slot button[data-action="invite"]').tap();
  await ada.waitForURL(/#\/admin\/invitations$/);
  const form = ada.locator('dialog.modal[open]');
  await form.waitFor();
  assert.deepEqual(await tooSmall(ada, 'dialog.modal[open] .modal-body'), [], 'the form of a new invitation: 44 px targets');
  assert.deepEqual(await tooSmall(ada, 'dialog.modal[open] .modal-head'), [], 'the close button of the sheet: 44 px on a touch screen');
  await form.locator('input[name="note"]').fill('Camille');
  await form.locator('button[data-action="confirm"]').tap();
  const link = ada.locator('dialog.modal[open] input.link-field');
  await link.waitFor();
  assert.match(await link.inputValue(), /\/join#/);
  await ada.keyboard.press('Escape');
  await ada.locator('section.view-admin tr[data-invitation]', { hasText: 'Camille' }).waitFor();

  // Back to the hub with the arrow
  await ada.locator('section.view-admin .ph-back').tap();
  await ada.waitForURL(/#\/admin$/);
  await ada.locator('section.view-admin[data-mode="hub"]').waitFor();
  assert.deepEqual(ada.errors, []);
});

test('every screen of the administration, of Machines et switchs and of État du labo fits a phone, in both themes', async () => {
  const ada = pages.find((p) => p.url().includes('/#/admin')) ?? await phone('ada');
  await ada.goto(`${h.url}/#/admin`);
  for (const theme of ['light', 'dark']) {
    await ada.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    for (const tab of ADMIN_TABS) {
      await goTo(ada, `#/admin/${tab}`, `section.view-admin[data-mode="tab"] [role="tabpanel"]:not([hidden]) > *`);
      assert.equal(await overflow(ada), 0, `admin ${tab}`);
      assert.deepEqual(await contrastFailures(ada, { within: 'section.view-admin' }), [], `admin ${tab} (${theme})`);
    }
    for (const route of ['infra', 'status', 'account', 'help', 'home']) {
      await goTo(ada, `#/${route}`, `section.view-${route}:not([hidden]) h1`);
      await ada.waitForTimeout(0);
      assert.equal(await overflow(ada), 0, route);
      assert.deepEqual(await contrastFailures(ada, { within: `section.view-${route}` }), [], `${route} (${theme})`);
    }
  }
  // Machines et switchs and État du labo belong to the administration for an administrator: ← to the hub
  await goTo(ada, '#/infra', 'section.view-infra:not([hidden]) h1');
  assert.equal(await ada.locator('section.view-infra .ph-back').isVisible(), true);
  assert.equal(await ada.locator('section.view-infra [role="tab"]').count(), 2, 'underline tabs: Machines virtuelles, Switchs d’admin');
  await ada.locator('section.view-infra .empty-state').waitFor(); // Proxmox is not configured here: the page says so, with no table
  await goTo(ada, '#/status', 'section.view-status:not([hidden]) .health-summary');
  assert.equal(await ada.locator('section.view-status .health-summary').getAttribute('data-state'), 'ok');
  assert.equal(await ada.locator('section.view-status .ph-back').isVisible(), true);
  assert.deepEqual(ada.errors, []);
});

test('Accueil on a phone: what needs me on top with 44 px buttons, my bench, Le labo as a list', async () => {
  const alice = await phone('alice');
  await alice.goto(`${h.url}/#/home`);
  await alice.locator('section.view-home .ov-home').waitFor();
  assert.equal((await api(alice, 'POST', '/api/teams', { name: 'Les piles' })).status, 201);
  assert.equal((await api(alice, 'POST', '/api/benches/B4M/take')).status, 200);
  const team = (await api(alice, 'GET', '/api/teams')).body.mine;
  const bob = await h.newPhonePage();
  pages.push(bob);
  await signInAs(bob, 'bilal');
  await bob.goto(`${h.url}/#/home`);
  await bob.locator('section.view-home .ov-home').waitFor();
  assert.equal((await api(alice, 'POST', `/api/teams/${team.id}/invitations`, { username: 'student2' })).status, 201);
  const attention = bob.locator('section.view-home [data-attention="invitation"]');
  await attention.waitFor();
  assert.deepEqual(await tooSmall(bob, 'section.view-home [data-panel="attention"]'), [], 'the answer to an invitation is a 44 px button');
  await attention.locator('button[data-action="accept-invitation"]').tap();
  await bob.locator('section.view-home [data-panel="bench"] .ov-hero').waitFor();

  // The hero: one primary action, full width; the filters scroll in a row; the lab is a list
  const hero = bob.locator('section.view-home .ov-hero');
  const primary = hero.locator('a[data-action="open"]');
  assert.equal(await primary.getAttribute('href'), '#/consoles/B4M');
  const box = await primary.boundingBox();
  assert.ok(box.height >= 44 && box.width > 300, `Ouvrir les consoles: full width and a thumb high (${box.width} × ${box.height})`);
  assert.equal(await bob.locator('section.view-home .ov-lab article.ov-card').count(), 0, 'a list, not a grid');
  assert.equal(await bob.locator('section.view-home .ov-lab tbody tr').count(), 8);
  assert.deepEqual(await tooSmall(bob, 'section.view-home'), [], 'every control of Accueil is a thumb high');
  assert.equal(await overflow(bob), 0);
  // A filter by address, then a row opens its bench
  await goTo(bob, '#/home/lab/taken', 'section.view-home .ov-lab tbody tr');
  assert.equal(await bob.locator('section.view-home .ov-lab tbody tr').count(), 1);
  await bob.locator('section.view-home .ov-lab tbody tr a.ov-link').tap();
  await bob.waitForURL(/#\/consoles\/B4M$/);
  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bob.errors, []);
});

test('Aide on a phone: folded sections, a contents sheet, the phone section instead of the shortcuts; the tour is shorter', async () => {
  const page = await phone('chloe', { tour: true });
  await page.route('**/api/help/tour', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { state: 'done' } }) : route.fulfill({ json: { state: 'done' } })));
  await page.goto(`${h.url}/#/help`);
  const view = page.locator('section.view-help');
  await view.locator('h1').waitFor();
  assert.equal(await view.locator('section.help-section').count(), 11, 'the shortcuts of a keyboard are not offered on a touch screen');
  assert.equal(await view.locator('section.help-section[data-section="keys"]').count(), 0);
  await view.locator('section.help-section[data-section="phone"]').waitFor();
  assert.equal(await view.locator('.help-text:visible').count(), 0, 'every section is folded');
  assert.deepEqual(await tooSmall(page, 'section.view-help'), [], 'the headings of the sections and the contents button are 44 px high');

  // The contents sheet leads to a section, which unfolds
  await view.locator('button[data-action="summary"]').tap();
  await page.locator('.menu-item[data-id="backup"]').tap();
  await page.waitForURL(/#\/help\/backup$/);
  await view.locator('section.help-section[data-section="backup"] .help-text').waitFor({ state: 'visible' });
  assert.equal(await view.locator('.help-text:visible').count(), 1, 'only that one');
  await view.locator('button[data-toggle="phone"]').tap();
  assert.match(await view.locator('section.help-section[data-section="phone"] .help-text').textContent(), /Mode « ligne »/);
  assert.equal(await overflow(page), 0);

  // The tour: five steps, ending with Plus
  await view.locator('.ph-icon-action').first().tap(); // ⋯
  await page.locator('.menu-item[data-id="replay-tour"]').tap();
  const card = page.locator('.tour-card');
  await card.waitFor();
  assert.match(await card.locator('.tour-count').textContent(), /Étape 1 sur 5/);
  for (let n = 0; n < 4; n++) await card.locator('button[data-action="tour-next"]').tap();
  await page.waitForFunction(() => document.querySelector('.tour-card')?.dataset.step === 'plus');
  assert.match(await card.textContent(), /Plus/);
  await card.locator('button[data-action="tour-skip"]').tap();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual(page.errors, []);
});

test('Mon compte on a phone: cards one under the other, preferences within reach, sessions as cards', async () => {
  const page = await phone('alice');
  await page.goto(`${h.url}/#/account`);
  const view = page.locator('section.view-account');
  await view.locator('section[data-card="preferences"]').waitFor();
  assert.deepEqual(await view.locator('section[data-card]').evaluateAll((els) => els.map((e) => e.dataset.card)), ['profile', 'sessions', 'preferences'], 'an SSO account has no password nor passkeys here');
  assert.deepEqual(await tooSmall(page, 'section.view-account'), []);
  assert.equal(await overflow(page), 0);
  assert.equal(await view.locator('section[data-card="sessions"] tbody tr[data-current="true"]').count(), 1);
  // The same controls as the account menu: the theme applies at once
  await view.locator('[data-theme-choice="dark"]').tap();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await view.locator('[data-theme-choice="light"]').tap();
  assert.deepEqual(page.errors, []);
});

test('the public pages on a phone: sign-in without a card, 48 px fields, the invalid link and the 404 with their way out', async () => {
  const page = await h.newPhonePage();
  pages.push(page);
  await page.goto(`${h.url}/login`);
  await page.locator('.login-card h1').waitFor();
  assert.equal(await page.locator('.login-card').evaluate((el) => getComputedStyle(el).borderTopWidth), '0px', 'no card on a phone');
  const sso = await page.locator('#sso-button').boundingBox();
  assert.ok(sso.height >= 48 && sso.width > 340, `the provider button is large and full width (${sso.width} × ${sso.height})`);
  await page.locator('#login-local summary').tap();
  for (const id of ['#local-username', '#local-password', '#local-code']) {
    const box = await page.locator(id).boundingBox();
    assert.ok(box.height >= 48, `${id} is 48 px high (${box.height})`);
    assert.equal(await page.locator(id).evaluate((el) => getComputedStyle(el).fontSize), '16px', `${id}: 16 px text, no zoom on focus`);
  }
  assert.equal(await overflow(page), 0);
  assert.deepEqual(await contrastFailures(page), []);

  await page.goto(`${h.url}/join#notavalidtoken`);
  await page.locator('#join-page[data-state="invalid"]').waitFor();
  assert.equal(await page.locator('#join-title').textContent(), 'Ce lien ne fonctionne pas');
  assert.equal(await page.locator('.join-done a').getAttribute('href'), '/login');
  assert.match(await page.locator('.join-done a').textContent(), /Retour à la connexion/);
  assert.equal(await page.locator('#join-box').isHidden(), true);

  await h.session(page, 'alice'); // an anonymous visitor is sent to the sign-in page: the 404 page is for people who are in
  await page.goto(`${h.url}/nowhere-at-all`);
  await page.locator('#nf-title').waitFor();
  assert.equal(await page.locator('main a.btn').getAttribute('href'), '/');
  assert.equal(await overflow(page), 0);
  assert.deepEqual(page.errors.filter((e) => !/404|Failed to load/i.test(String(e))), []);
});

test('on a PC the administration has its list at the left and the same screens, in English too', async () => {
  const page = await h.newPage();
  pages.push(page);
  await h.session(page, 'ada');
  await page.goto(`${h.url}/#/admin`);
  await page.waitForURL(/#\/admin\/users$/);
  await page.locator('section.view-admin .admin-nav').waitFor();
  assert.equal(await page.locator('section.view-admin .ph-back').isVisible(), false, 'no back arrow beside a list');
  assert.equal(await page.locator('section.view-admin .admin-link[aria-current="page"]').getAttribute('data-entry'), 'users');
  const width = await page.locator('section.view-admin .admin-nav').evaluate((n) => Math.round(n.getBoundingClientRect().width));
  assert.ok(width >= 200 && width <= 260, `a list of about 220 px (${width})`);
  await page.locator('.admin-link[data-entry="status"]').click();
  await page.locator('section.view-status .health-summary').waitFor();
  assert.equal(await page.locator('section.view-status .admin-link[data-entry="status"]').getAttribute('aria-current'), 'page', 'the lab status keeps the administration list');
  assert.equal(await page.locator('#rail-items .active').getAttribute('data-nav'), 'admin');
  await page.evaluate(() => { localStorage.setItem('labconsole.locale', '"en"'); });
  await page.reload();
  await page.locator('section.view-status h1').waitFor();
  assert.equal(await page.locator('section.view-status h1').textContent(), 'Lab status');
  assert.deepEqual(await page.locator('section.view-status .admin-group-title').allTextContents(), ['Accounts', 'Lab', 'Monitoring']);
  await page.locator('.admin-link[data-entry="users"]').click();
  await page.locator('section.view-admin h1', { hasText: 'Users' }).waitFor();
  assert.deepEqual(page.errors, []);
});

test('on a laptop of 1280 px the users table needs no sideways scroll: Valider stays in view, the sign-in columns are under the name', async () => {
  const { token } = await invite(h.app, { uses: 2 });
  assert.equal((await signUp(h.app, token, { username: 'ines', name: 'Inès Roux' })).status, 200);
  for (const theme of ['light', 'dark']) {
    const page = await h.newPage();
    pages.push(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await h.session(page, 'ada');
    await page.goto(`${h.url}/#/admin/users`);
    await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
    const row = page.locator('section.view-admin tr[data-account="local:ines"]');
    await row.waitFor();
    await page.evaluate(() => document.fonts.ready); // the table is laid out with the real font
    const list = page.locator('section.view-admin .admin-page .data-list');
    const [scroll, client] = await list.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(scroll <= client, `${theme}: the table is ${scroll} px in a card of ${client}`);
    const card = await list.boundingBox();
    const approve = await row.locator('button[data-action="approve"]').boundingBox();
    assert.ok(approve.x + approve.width <= card.x + card.width, `${theme}: Valider ends at ${approve.x + approve.width}, the card at ${card.x + card.width}`);
    assert.match(await row.locator('.account-signin').textContent(), /Dernière connexion : .*Clés d’accès : 0/, `${theme}: what the dropped columns held`);
    assert.deepEqual(page.errors, []);
  }
});
