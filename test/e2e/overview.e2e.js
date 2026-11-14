/**
 * The overview of the benches and the personal home page, in real browsers
 * with two teams at once (SPEC "Lot overview, lot help"):
 *
 *   - after sign-in the page is the home page; a student with no team is told
 *     what to do, and the page follows the team, the bench and the backups as
 *     they happen, without a reload;
 *   - the overview shows every bench to everyone and moves live when the
 *     other team takes, frees or locks a bench, opens a console or backs up;
 *   - one team's backups and bench activity never reach the other's pages;
 *   - both pages work in English and on a narrow window.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, setLanguage } from './harness.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.05' } });

const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const home = (page) => page.locator('section.view-home');
const overview = (page) => page.locator('section.view-overview');
const card = (page, bench) => overview(page).locator(`article.ov-card[data-bench="${bench}"]`);
const goTo = async (page, hash, selector) => {
  await page.evaluate((to) => { location.hash = to; }, hash);
  await page.locator(selector).first().waitFor();
};
const showOverview = (page) => goTo(page, '#/overview', 'section.view-overview article.ov-card');
const showHome = (page) => goTo(page, '#/home', 'section.view-home .ov-home-grid');

const pages = [];
after(async () => {
  while (pages.length) await pages.pop().context().close();
});
async function newPage(who) {
  const page = await h.newPage();
  pages.push(page);
  await signInAs(page, who);
  return page;
}

test('after sign-in the page is the home page; with no team it says what to do, then follows the team and the bench live', async () => {
  const alice = await newPage('alice');
  assert.match(alice.url(), /#\/home$|\/$/, 'no section was asked for: the home page');
  await home(alice).waitFor();
  assert.equal(await alice.locator('#rail-items a.rail-btn.active').getAttribute('data-path'), 'home');
  assert.equal(await home(alice).locator('h1').textContent(), 'Accueil');
  assert.match(await home(alice).locator('.ov-greeting').textContent(), /^Bonjour Alice Martin$/);
  await home(alice).locator('[data-panel="team"]', { hasText: 'Vous n’êtes dans aucune équipe.' }).waitFor();
  await home(alice).locator('[data-panel="bench"]', { hasText: 'Vous ne travaillez sur aucune baie.' }).waitFor();
  assert.equal(await home(alice).locator('[data-panel="backups"]').count(), 0, 'no team, no backups to look for');
  assert.equal(await home(alice).locator('[data-panel="team"] a[data-action="team"]').getAttribute('href'), '#/team/mine');

  // The team and the bench appear without a reload
  assert.equal((await api(alice, 'POST', '/api/teams', { name: 'Les routeurs' })).status, 201);
  await home(alice).locator('[data-panel="team"] .ov-team-name', { hasText: 'Les routeurs' }).waitFor();
  await home(alice).locator('[data-panel="bench"]', { hasText: 'Votre équipe n’a pas de baie.' }).waitFor();
  assert.equal((await api(alice, 'POST', '/api/benches/B4M/take')).status, 200);
  const mine = home(alice).locator('[data-panel="bench"] article.ov-card[data-bench="B4M"]');
  await mine.waitFor();
  assert.equal(await mine.getAttribute('data-mine'), 'true');
  assert.equal(await mine.getAttribute('data-state'), 'taken');
  await mine.locator('.ov-holder', { hasText: 'Prise par l’équipe Les routeurs' }).waitFor();
  await mine.locator('.ov-people li', { hasText: 'Alice Martin' }).waitFor();
  await home(alice).locator('[data-panel="activity"] li', { hasText: 'Alice Martin a pris la baie pour l’équipe Les routeurs' }).waitFor();
  await home(alice).locator('[data-panel="backups"]', { hasText: 'Aucune sauvegarde pour l’instant.' }).waitFor();
  assert.deepEqual(alice.errors, []);
});

test('the overview shows both teams\' benches to both, moves when one of them frees, locks or opens a console, and keeps its own backups to itself', async () => {
  const alice = pages[0];
  const chloe = await newPage('chloe');
  assert.equal((await api(chloe, 'POST', '/api/teams', { name: 'Les switchs' })).status, 201);
  assert.equal((await api(chloe, 'POST', '/api/benches/B5M/take')).status, 200);

  await showOverview(alice);
  await showOverview(chloe);
  const diagramOrder = ['B4B', 'B4M', 'B4H', 'B5B', 'B5M', 'B5H', 'B6H', 'B6B'];
  assert.deepEqual(await overview(alice).locator('article.ov-card').evaluateAll((els) => els.map((e) => e.dataset.bench)), diagramOrder);

  // Each sees its own bench as theirs and the other's as taken by the other team
  await card(alice, 'B4M').locator('.ov-holder', { hasText: 'Les routeurs' }).waitFor();
  await card(alice, 'B5M').locator('.ov-holder', { hasText: 'Les switchs' }).waitFor();
  assert.equal(await card(alice, 'B4M').getAttribute('data-mine'), 'true');
  assert.equal(await card(alice, 'B5M').getAttribute('data-mine'), 'false');
  await card(chloe, 'B5M').locator('.ov-you').waitFor();
  assert.equal(await card(chloe, 'B4M').getAttribute('data-mine'), 'false');
  await overview(alice).locator('.ov-totals li[data-total="taken"]', { hasText: '2 prises' }).waitFor();
  await overview(alice).locator('.ov-totals li[data-total="free"]', { hasText: '6 libres' }).waitFor();

  // Live: Chloe gives her bench back, Alice's page follows without a reload, and the keyboard focus stays where Alice had it
  await card(alice, 'B4M').locator('a[data-action="open"]').focus();
  assert.equal((await api(chloe, 'POST', '/api/benches/B5M/release')).status, 200);
  await alice.waitForSelector('section.view-overview article.ov-card[data-bench="B5M"][data-state="free"]');
  assert.deepEqual(await alice.evaluate(() => ({ bench: document.activeElement.closest('article')?.dataset.bench, action: document.activeElement.dataset.action })), { bench: 'B4M', action: 'open' });
  await overview(alice).locator('.ov-totals li[data-total="free"]', { hasText: '7 libres' }).waitFor();
  assert.equal((await api(chloe, 'POST', '/api/benches/B5M/take')).status, 200);
  await alice.waitForSelector('section.view-overview article.ov-card[data-bench="B5M"][data-state="taken"]');

  // Live: Alice opens R1 and types; Chloe sees the console and its pilot, not what was typed
  const pane = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);
  await typeInConsole(pane, 'show clock private-to-alice');
  await waitForTerminal(pane, /show clock private-to-alice/);
  const seen = card(chloe, 'B4M').locator('.ov-consoles li[data-device="R1"]');
  await seen.waitFor();
  assert.match(await seen.textContent(), /piloté par Alice Martin/);
  await card(chloe, 'B4M').locator('.ov-lines', { hasText: '1 ligne ouverte sur 10' }).waitFor();
  assert.doesNotMatch(await overview(chloe).textContent(), /private-to-alice/);

  // Alice's backup is on her home page, and on nobody else's
  const key = (await api(alice, 'GET', '/api/consoles/labs')).body.labs.find((l) => l.name === 'B4M').devices.find((d) => d.name === 'R1').key;
  const started = await api(alice, 'POST', '/api/jobs/benches/B4M/backup', { devices: [key], label: 'Avant le TP noté' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await card(chloe, 'B4M').locator('.ov-job', { hasText: 'Sauvegarde' }).waitFor(); // everyone sees that a job runs
  await showHome(alice);
  const backup = home(alice).locator('[data-panel="backups"] li', { hasText: 'Avant le TP noté' });
  await backup.waitFor({ timeout: 90_000 });
  assert.match(await backup.textContent(), /B4M · 1 appareil · Alice Martin/);
  await home(alice).locator('[data-panel="activity"] li', { hasText: 'Alice Martin a ouvert la console de R1' }).waitFor();

  await showHome(chloe);
  await home(chloe).locator('[data-panel="backups"]', { hasText: 'Aucune sauvegarde pour l’instant.' }).waitFor();
  await home(chloe).locator('[data-panel="activity"] li', { hasText: 'Chloé Dubois a pris la baie pour l’équipe Les switchs' }).waitFor();
  const chloeText = await home(chloe).textContent();
  assert.doesNotMatch(chloeText, /Avant le TP noté|Les routeurs|Alice Martin/, 'nothing of the other team on her page');
  assert.doesNotMatch(await overview(chloe).textContent(), /Avant le TP noté/);
  await showOverview(chloe);
  assert.doesNotMatch(await overview(chloe).textContent(), /Avant le TP noté/);

  // Live: an admin locks a bench; both pages show the reason as it is typed
  await showOverview(alice);
  const ada = await newPage('ada');
  assert.equal((await api(ada, 'PUT', '/api/benches/B6B/lock', { reason: 'Préparée pour le <b>TP noté</b>' })).status, 200);
  for (const page of [alice, chloe]) {
    await page.waitForSelector('section.view-overview article.ov-card[data-bench="B6B"][data-state="locked"]');
    const lock = card(page, 'B6B').locator('.ov-lock');
    assert.match(await lock.textContent(), /Préparée pour le <b>TP noté<\/b>/, 'shown as text');
    assert.equal(await lock.locator('b').count(), 0);
  }
  assert.equal((await api(ada, 'DELETE', '/api/benches/B6B/lock')).status, 200);
  await alice.waitForSelector('section.view-overview article.ov-card[data-bench="B6B"][data-state="free"]');

  // The announcement is on the home page of everybody, once
  assert.equal((await api(ada, 'PUT', '/api/admin/announcement', { text: 'B6H hors service ce matin', level: 'warning' })).status, 200);
  await showHome(alice);
  await home(alice).locator('section.ov-announcement', { hasText: 'B6H hors service ce matin' }).waitFor();
  assert.equal(await alice.locator('.announcement-banner').isVisible(), false, 'the banner is not shown twice on the home page');
  await showOverview(alice);
  await alice.locator('.announcement-banner', { hasText: 'B6H hors service ce matin' }).waitFor({ state: 'visible' });
  assert.equal((await api(ada, 'DELETE', '/api/admin/announcement')).status, 200);
  await showHome(alice);
  await alice.waitForSelector('section.view-home .ov-announcement', { state: 'detached' });

  for (const page of [alice, chloe, ada]) assert.deepEqual(page.errors, []);
});

test('an invitation shows on the invitee\'s home page as it is sent; once in the team, the page shows the team\'s bench and backups', async () => {
  const alice = pages[0];
  const bilal = await newPage('bilal');
  await showHome(bilal);
  assert.equal(await home(bilal).locator('[data-panel="invitations"]').count(), 0);

  const team = (await api(alice, 'GET', '/api/teams')).body.mine;
  assert.equal((await api(alice, 'POST', `/api/teams/${team.id}/invitations`, { username: 'student2' })).status, 201);
  const invitation = home(bilal).locator('[data-panel="invitations"]');
  await invitation.locator('li', { hasText: 'Alice Martin vous invite dans l’équipe Les routeurs' }).waitFor();
  assert.equal(await invitation.locator('a[data-action="invitations"]').getAttribute('href'), '#/team/mine');
  assert.equal(await home(bilal).locator('[data-panel="bench"] article').count(), 0, 'an invitation gives no bench');
  await home(bilal).locator('[data-panel="backups"]').waitFor({ state: 'detached' });

  // He accepts: the team, its bench and its backups are his, the invitation is gone
  assert.equal((await api(bilal, 'POST', `/api/teams/${team.id}/accept`)).status, 200);
  await home(bilal).locator('[data-panel="team"] .ov-team-name', { hasText: 'Les routeurs' }).waitFor();
  await home(bilal).locator('[data-panel="bench"] article.ov-card[data-bench="B4M"][data-mine="true"]').waitFor();
  await home(bilal).locator('[data-panel="backups"] li', { hasText: 'Avant le TP noté' }).waitFor();
  assert.equal(await home(bilal).locator('[data-panel="invitations"]').count(), 0);
  assert.deepEqual(bilal.errors, []);
});

test('both pages speak English, and fit a wide and a narrow window', async () => {
  const [alice] = pages;
  await setLanguage(alice, 'en');
  await showHome(alice);
  assert.equal(await home(alice).locator('h1').textContent(), 'Home');
  assert.equal(await alice.locator('#rail-items a[data-path="overview"]').textContent(), 'Overview');
  await home(alice).locator('[data-panel="bench"] .ov-holder', { hasText: 'Taken by team Les routeurs since' }).waitFor();
  await home(alice).locator('[data-panel="backups"] li', { hasText: 'B4M · 1 device · Alice Martin' }).waitFor();
  await home(alice).locator('[data-panel="activity"] li', { hasText: 'Alice Martin took the bench for team Les routeurs' }).waitFor();
  await showOverview(alice);
  await overview(alice).locator('.ov-totals li[data-total="free"]', { hasText: 'free' }).waitFor();
  await card(alice, 'B5M').locator('.ov-holder', { hasText: 'Taken by team Les switchs since' }).waitFor();
  await alice.locator('.ov-filters button[data-filter="free"]').click();
  assert.deepEqual(await overview(alice).locator('article.ov-card').evaluateAll((els) => els.map((e) => e.dataset.state)).then((s) => [...new Set(s)]), ['free']);
  await alice.locator('.ov-filters button[data-filter="mine"]').click();
  assert.deepEqual(await overview(alice).locator('article.ov-card').evaluateAll((els) => els.map((e) => e.dataset.bench)), ['B4M']);
  await alice.locator('.ov-filters button[data-filter="all"]').click();
  await setLanguage(alice, 'fr');

  // 1280 px: several cards across; 400 px: one column, nothing wider than the window
  const columns = (page, selector) => page.locator(selector).evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await alice.setViewportSize({ width: 1280, height: 800 });
  await showOverview(alice);
  assert.ok(await columns(alice, 'section.view-overview article.ov-card') >= 3, 'three benches or more across at 1280 px');
  assert.ok(await overflow(alice) <= 0);
  await showHome(alice);
  assert.ok(await columns(alice, 'section.view-home .ov-home-grid > *') >= 2);
  assert.ok(await overflow(alice) <= 0);
  await alice.setViewportSize({ width: 400, height: 800 });
  await showOverview(alice);
  assert.equal(await columns(alice, 'section.view-overview article.ov-card'), 1);
  assert.ok(await overflow(alice) <= 0, 'no horizontal scroll on the overview at 400 px');
  await showHome(alice);
  assert.equal(await columns(alice, 'section.view-home .ov-home-grid > *'), 1);
  assert.ok(await overflow(alice) <= 0, 'no horizontal scroll on the home page at 400 px');
  assert.deepEqual(alice.errors, []);
});
