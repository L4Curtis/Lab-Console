/**
 * Help in the browser: the guided tour opens by itself at the first sign-in
 * (and only then), can be skipped, finished and replayed from the user menu,
 * points at the real screen, and speaks both languages; the help page lists
 * its sections with the figures the server decides
 *
 * Every other scenario opens its pages with the tour switched off
 * (`h.newPage()`); here it is `h.newPage({ tour: true })`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, signInAsAdmin, setLanguage, openConsole } from './harness.js';

const h = useHarness();

const card = (page) => page.locator('.tour-card');
const stepOf = (page) => card(page).getAttribute('data-step');
const tourState = (page) => page.evaluate(() => fetch('/api/help/tour', { credentials: 'same-origin' }).then((r) => r.json()).then((b) => b.state));
const button = (page, action) => card(page).locator(`button[data-action="tour-${action}"]`);
const ready = (page) => page.waitForSelector('#rail-items a[data-path="jobs"]');

test('the tour opens at the first sign-in, walks through the real screen, and never comes back by itself', async () => {
  const page = await h.newPage({ tour: true });
  await signInAs(page, 'alice');
  await card(page).waitFor();
  assert.equal(await tourState(page), null, 'nothing is recorded before the end');

  // 1. a bench: the picker is ringed
  assert.equal(await stepOf(page), 'bench');
  assert.match(await card(page).textContent(), /Étape 1 sur 5/);
  assert.match(await card(page).textContent(), /Choisir une baie/);
  await page.locator('.lab-picker.tour-target').waitFor();
  assert.equal(await button(page, 'back').isHidden(), true, 'nothing before the first step');

  // 2. the team: the bench bar
  await button(page, 'next').click();
  await page.waitForFunction(() => document.querySelector('.tour-card')?.dataset.step === 'team');
  await page.locator('.bench-bar.tour-target').waitFor();
  assert.match(await card(page).textContent(), /Prendre la baie avec votre équipe/);
  assert.equal(await page.locator('.lab-picker.tour-target').count(), 0, 'only the current step is ringed');

  // 3. a console: the diagram
  await button(page, 'next').click();
  await page.locator('.diagram-canvas.tour-target').waitFor();
  assert.match(await card(page).textContent(), /Ouvrir une console/);

  // Back works
  await button(page, 'back').click();
  await page.locator('.bench-bar.tour-target').waitFor();
  assert.match(await card(page).textContent(), /Étape 2 sur 5/);
  await button(page, 'next').click();
  await button(page, 'next').click();

  // 4. the keyboard; 5. the backups, ringed in the rail
  assert.match(await card(page).textContent(), /Demander la main/);
  await button(page, 'next').click();
  await page.locator('#rail-items a[data-path="jobs"].tour-target').waitFor();
  assert.match(await card(page).textContent(), /Le serveur n’est pas une sauvegarde/);
  assert.match(await button(page, 'next').textContent(), /Terminer/);
  await button(page, 'next').click();
  await card(page).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.tour-target').count(), 0, 'nothing stays ringed');
  assert.equal(await tourState(page), 'done');

  // A new page load, same person: no tour. The answer that decides it is awaited, then the page is looked at
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/help/tour') && r.request().method() === 'GET');
  await page.reload();
  assert.deepEqual(await (await answered).json(), { state: 'done' });
  await ready(page);
  assert.equal(await card(page).count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('it can be skipped, and Escape skips it too; a skipped tour is not shown again', async () => {
  const bilal = await h.newPage({ tour: true });
  await signInAs(bilal, 'bilal');
  await card(bilal).waitFor();
  await button(bilal, 'skip').click();
  await card(bilal).waitFor({ state: 'detached' });
  assert.equal(await tourState(bilal), 'skipped');
  const answered = bilal.waitForResponse((r) => r.url().endsWith('/api/help/tour') && r.request().method() === 'GET');
  await bilal.reload();
  await answered;
  await ready(bilal);
  assert.equal(await card(bilal).count(), 0, 'not shown again');

  const chloe = await h.newPage({ tour: true });
  await signInAs(chloe, 'chloe');
  await card(chloe).waitFor();
  await chloe.keyboard.press('Escape');
  await card(chloe).waitFor({ state: 'detached' });
  assert.equal(await tourState(chloe), 'skipped');
  assert.deepEqual(bilal.errors, []);
  await bilal.context().close();
  await chloe.context().close();
});

test('it is replayed from the user menu, ringing the pane\'s keyboard bar once a console is open; skipping a replay keeps "done"', async () => {
  const page = await h.newPage({ tour: true });
  await signInAs(page, 'ada');
  await card(page).waitFor();
  // Finished (here: recorded, then the card closed) …
  await page.evaluate(() => fetch('/api/help/tour', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"state":"done"}' }));
  await button(page, 'skip').click();
  await card(page).waitFor({ state: 'detached' });
  assert.equal(await tourState(page), 'done', 'skipping after finishing does not downgrade');
  await openConsole(page, 'B4M', 'R1');

  // … and replayed from the user menu
  await page.click('.user-menu-btn');
  await page.locator('#user-menu button[data-action="replay-tour"]').click();
  await card(page).waitFor();
  assert.equal(await page.locator('#user-menu').isHidden(), true, 'the menu closes');
  for (let n = 0; n < 3; n++) await button(page, 'next').click();
  assert.equal(await stepOf(page), 'keyboard');
  await page.locator('.pane-presence.tour-target').waitFor();

  await button(page, 'skip').click();
  await card(page).waitFor({ state: 'detached' });
  assert.equal(await tourState(page), 'done', 'a skipped replay does not undo a finished tour');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the tour speaks English, and a dialog keeps Escape for itself', async () => {
  const page = await h.newPage({ locale: 'en-GB', tour: true });
  await signInAsAdmin(page);              // the environment's administrator: a person of its own, who never saw the tour
  await card(page).waitFor();
  await setLanguage(page, 'en');
  assert.match(await card(page).textContent(), /Step 1 of 5/);
  assert.match(await card(page).textContent(), /Pick a bench/);
  assert.match(await button(page, 'skip').textContent(), /Skip the tour/);
  await button(page, 'next').click();
  await page.waitForFunction(() => document.querySelector('.tour-card')?.dataset.step === 'team');
  assert.match(await card(page).textContent(), /Take the bench with your team/);

  // The finder is a modal dialog: Escape closes it, not the tour
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+k');
  await page.locator('dialog.quick-open[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog.quick-open[open]').waitFor({ state: 'detached' });
  assert.equal(await card(page).count(), 1, 'the tour is still there');
  await button(page, 'skip').click();
  await card(page).waitFor({ state: 'detached' });
  await page.context().close();
});

test('the help page: its sections, the figures of the server, both languages', async () => {
  const page = await h.newPage();
  await signInAs(page, 'alice');
  await page.click('#rail-items a[data-path="help"]');
  const view = page.locator('section.view-help');
  await view.locator('h1', { hasText: /^Aide$/ }).waitFor();
  const ids = ['sections', 'team', 'share', 'backup', 'tasks', 'journal', 'trouble', 'keys'];
  for (const id of ids) await view.locator(`section.help-section[data-section="${id}"] h2`).waitFor();
  assert.equal(await view.locator('section.help-section').count(), ids.length);
  assert.equal(await view.locator('.help-toc a').count(), ids.length);

  // What the page promises is what the product says
  const text = await view.locator('.help-sections').textContent();
  assert.match(text, /Le serveur n’est pas une sauvegarde/);
  assert.match(text, /Télécharger le ZIP/);
  assert.match(text, /compte à rebours de 10 secondes/);
  assert.match(text, /Demander la main/);
  assert.match(text, /Équipement muet/);
  assert.match(text, /Ctrl K/);
  // …and the figures come from the server: 14 days of journal, 3 h before a bench is released, 8 h / 24 h of session
  await page.waitForFunction(() => /Gardé 14 jours/.test(document.querySelector('section.help-section[data-section="journal"]')?.textContent ?? ''));
  assert.match(await view.locator('section[data-section="team"]').textContent(), /pendant 3 h est libérée/);
  assert.match(await view.locator('section[data-section="journal"]').textContent(), /après 8 h sans activité, et au plus tard après 24 h/);

  // A section is reachable by its address, and the page links to the status page
  await page.evaluate(() => { location.hash = '#/help/trouble'; });
  await page.waitForFunction(() => {
    const r = document.querySelector('section.help-section[data-section="trouble"]')?.getBoundingClientRect();
    return r && r.top >= 0 && r.top < innerHeight / 2;
  });
  await view.locator('section[data-section="journal"] a[href="#/status/journaling"]').click();
  await page.waitForSelector('section.view-status');

  // English
  await page.evaluate(() => { location.hash = '#/help'; });
  await setLanguage(page, 'en');
  await view.locator('h1', { hasText: /^Help$/ }).waitFor();
  const en = await view.locator('.help-sections').textContent();
  assert.match(en, /The server is not a backup/);
  assert.match(en, /Ask for the keyboard/);
  assert.doesNotMatch(en, /help\.s\./, 'no key is shown as a key');
  assert.match(await view.locator('section[data-section="journal"]').textContent(), /Kept 14 days/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the help page replays the tour', async () => {
  const page = await h.newPage();
  await signInAs(page, 'bilal');
  await page.evaluate(() => { location.hash = '#/help'; });
  await page.locator('section.view-help button[data-action="replay-tour"]').click();
  await card(page).waitFor();
  await button(page, 'skip').click();
  await card(page).waitFor({ state: 'detached' });
  await page.context().close();
});
