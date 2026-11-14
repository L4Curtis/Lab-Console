/**
 * A section whose data cannot be read says so, in the user's language, and
 * offers to try again; while the data is on its way it says "Chargement…".
 * Same pattern everywhere (public/js/shared/loadState.js): a server error and
 * a cut network both end in a message and a "Réessayer" button that works
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, waitForApp } from './harness.js';

const h = useHarness({ oidc: false, mockLab: false });
before(async () => { await h.ready; });

const SECTIONS = [
  { route: 'jobs', api: '**/api/jobs/**', failure: 'section.view-jobs .load-failure', content: 'section.view-jobs [data-action="backup"]' },
  { route: 'account', api: '**/api/accounts/me', failure: 'section.view-account .load-failure', content: 'section.view-account .account-card' },
  { route: 'status', api: '**/api/admin/health*', failure: 'section.view-status .load-failure', content: 'section.view-status .health-card' },
  { route: 'team', api: '**/api/teams', failure: 'section.view-team .load-failure', content: 'section.view-team .team-card' },
  { route: 'consoles', api: '**/api/consoles/labs', failure: 'section.view-consoles .canvas-hint [data-action="retry"]', content: 'section.view-consoles .rack-slot' },
];

for (const { route, api, failure, content } of SECTIONS) {
  for (const [how, fail] of [['an HTTP 500', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"server.internal","error":"Internal error"}' })], ['a cut network', (r) => r.abort('connectionrefused')]]) {
    test(`${route}: ${how} gives a message and a working retry`, async () => {
      const page = await h.newPage({ locale: 'fr' });
      await h.session(page, 'admin');
      await page.goto(h.url);
      await waitForApp(page);
      await page.route(api, fail);
      await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
      const retry = page.locator(failure).first();
      await retry.waitFor();
      const text = await page.locator(`section.view-${route}:not([hidden])`).innerText();
      assert.doesNotMatch(text, /Failed to fetch|Internal error/, 'nothing in English');
      assert.doesNotMatch(text, /\.\./, 'no doubled full stop');
      assert.match(text, how === 'a cut network' ? /Impossible de joindre le serveur/ : /Erreur interne du serveur/);
      if (route === 'consoles') assert.equal(await page.locator('section.view-consoles .checks-btn').isVisible(), false, 'no controls for a diagram that is not there');
      await page.unroute(api);
      await page.locator(`section.view-${route} [data-action="retry"]`).first().click();
      await page.waitForSelector(content);
      assert.equal(await page.locator(`section.view-${route} .load-failure`).count(), 0, 'the failure is gone');
      await page.context().close();
    });
  }
}

test('while a section loads it says "Chargement…"', async () => {
  const page = await h.newPage({ locale: 'fr' });
  await h.session(page, 'admin');
  await page.goto(h.url);
  await waitForApp(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/accounts/me', async (route) => { await held; await route.continue(); });
  await page.evaluate(() => { location.hash = '#/account'; });
  await page.waitForSelector('section.view-account .load-state');
  assert.equal(await page.locator('section.view-account .load-state').textContent(), 'Chargement…');
  release();
  await page.waitForSelector('section.view-account .account-card');
  assert.equal(await page.locator('section.view-account .load-state').count(), 0);
  await page.context().close();
});

test('a download that is refused says why in French; one that works still downloads', async () => {
  const page = await h.newPage({ locale: 'fr' });
  await h.session(page, 'admin');
  await page.goto(h.url);
  await waitForApp(page);
  const link = (href) => page.evaluate((url) => {
    const a = document.createElement('a');
    a.href = url; a.download = ''; a.id = 'probe'; a.textContent = 'probe';
    document.querySelector('.views').append(a);
  }, href);
  await link('/api/accounts/nothing-here');
  await page.click('#probe');
  await page.locator('.toast', { hasText: 'Introuvable.' }).waitFor();
  assert.equal(await page.locator('.toast', { hasText: /"code"|not_found/ }).count(), 0, 'no raw JSON');
  await page.evaluate(() => document.getElementById('probe').remove());
  await link('/api/health');
  const [file] = await Promise.all([page.waitForEvent('download'), page.click('#probe')]);
  assert.match(file.suggestedFilename(), /^health/);
  await page.context().close();
});
