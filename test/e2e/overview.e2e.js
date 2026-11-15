/**
 * The home page and its "Le labo" block, in real browsers with two teams at
 * once (SPEC "Lot overview, lot help"; docs/v2/UX.md §10.1):
 *
 *   - after sign-in the page is the home page; a student with no team is told
 *     what to do, and the page follows the team, the bench and the backups as
 *     they happen, without a reload;
 *   - Le labo shows every bench to everyone and moves live when the other team
 *     takes, frees or locks a bench, opens a console or backs up; the old
 *     address of the overview still leads there, with its filter;
 *   - what needs a person now (an invitation, a request to join their bench)
 *     is on top of their page, with the action;
 *   - one team's backups and bench activity never reach the other's pages;
 *   - the page works in English, on a wide window and on a phone.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, setLanguage } from './harness.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.05' } });

const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const importZip = (page, query, bytes) => page.evaluate(async ({ query, bytes }) => {
  const res = await fetch(`/api/jobs/snapshots/import?${query}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Uint8Array(bytes) });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { query, bytes: [...bytes] });

const home = (page) => page.locator('section.view-home');
const lab = (page) => home(page).locator('.ov-lab');
const card = (page, bench) => lab(page).locator(`article.ov-card[data-bench="${bench}"]`);
const chip = (page, id) => lab(page).locator(`button.chip[data-filter="${id}"]`);
const goTo = async (page, hash, selector) => {
  await page.evaluate((to) => { location.hash = to; }, hash);
  await page.locator(selector).first().waitFor();
};
/** The old address of the overview: it must land on Le labo, in place */
const showLab = (page) => goTo(page, '#/overview', 'section.view-home .ov-lab article.ov-card');
const showHome = (page) => goTo(page, '#/home', 'section.view-home .ov-home');
/** The activity list shows five lines; the rest is behind "Voir plus" */
const allActivity = async (page) => {
  const more = home(page).locator('[data-panel="activity"] [data-action="more"]');
  if (await more.count()) await more.click();
};

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
  assert.match(await alice.locator('section.view-home .ph-context').textContent(), /^Bonjour Alice Martin$/);
  await home(alice).locator('[data-panel="bench"]', { hasText: 'Vous ne travaillez sur aucune baie.' }).waitFor();
  assert.equal(await home(alice).locator('[data-panel="backups"]').count(), 0, 'no team, no backups to look for');
  assert.equal(await home(alice).locator('[data-panel="bench"] a[data-action="team"]').getAttribute('href'), '#/team/mine', 'the one thing to do: create a team');

  // The team and the bench appear without a reload
  assert.equal((await api(alice, 'POST', '/api/teams', { name: 'Les routeurs' })).status, 201);
  await home(alice).locator('[data-panel="team"] .ov-team-name', { hasText: 'Les routeurs' }).waitFor();
  await home(alice).locator('[data-panel="bench"]', { hasText: 'Votre équipe n’a pas de baie.' }).waitFor();
  // Three free benches are offered, each with its own "Prendre": taking one is done from here
  assert.equal(await home(alice).locator('[data-panel="bench"] li[data-bench]').count(), 3);
  await home(alice).locator('[data-panel="bench"] li[data-bench="B4M"] button[data-action="take"]').click();
  const mine = home(alice).locator('[data-panel="bench"] article.ov-card[data-bench="B4M"]');
  await mine.waitFor();
  assert.equal(await mine.getAttribute('data-mine'), 'true');
  assert.equal(await mine.getAttribute('data-state'), 'taken');
  await mine.locator('.ov-holder', { hasText: 'Prise par l’équipe Les routeurs' }).waitFor();
  await mine.locator('.ov-hero-people li', { hasText: 'Alice Martin' }).waitFor();
  assert.equal(await mine.locator('a[data-action="open"]').getAttribute('href'), '#/consoles/B4M');
  assert.equal(await mine.locator('a[data-action="backup"]').getAttribute('href'), '#/jobs/B4M/backup');
  await home(alice).locator('[data-panel="activity"] li', { hasText: 'Alice Martin a pris la baie pour l’équipe Les routeurs' }).waitFor();
  await home(alice).locator('[data-panel="backups"]', { hasText: 'Aucune sauvegarde pour l’instant.' }).waitFor();
  assert.deepEqual(alice.errors, []);
});

test('Le labo shows both teams\' benches to both, moves when one of them frees, locks or opens a console, and keeps its own backups to itself', async () => {
  const alice = pages[0];
  const chloe = await newPage('chloe');
  assert.equal((await api(chloe, 'POST', '/api/teams', { name: 'Les switchs' })).status, 201);
  assert.equal((await api(chloe, 'POST', '/api/benches/B5M/take')).status, 200);

  await showLab(alice);
  assert.match(alice.url(), /#\/home\/lab$/, 'the old address was replaced by the new one');
  await showLab(chloe);
  const diagramOrder = ['B4B', 'B4M', 'B4H', 'B5B', 'B5M', 'B5H', 'B6H', 'B6B'];
  assert.deepEqual(await lab(alice).locator('article.ov-card').evaluateAll((els) => els.map((e) => e.dataset.bench)), diagramOrder);

  // Each sees its own bench as theirs and the other's as taken by the other team
  await card(alice, 'B4M').locator('.ov-holder', { hasText: 'Les routeurs' }).waitFor();
  await card(alice, 'B5M').locator('.ov-holder', { hasText: 'Les switchs' }).waitFor();
  assert.equal(await card(alice, 'B4M').getAttribute('data-mine'), 'true');
  assert.equal(await card(alice, 'B5M').getAttribute('data-mine'), 'false');
  await card(chloe, 'B5M').locator('.ov-you').waitFor();
  assert.equal(await card(chloe, 'B4M').getAttribute('data-mine'), 'false');
  await chip(alice, 'taken').filter({ hasText: 'Prises 2' }).waitFor();
  await chip(alice, 'free').filter({ hasText: 'Libres 6' }).waitFor();

  // Live: Chloe gives her bench back, Alice's page follows without a reload, and the keyboard focus stays where Alice had it
  await card(alice, 'B4M').locator('a[data-action="open"]').focus();
  assert.equal((await api(chloe, 'POST', '/api/benches/B5M/release')).status, 200);
  await alice.waitForSelector('section.view-home article.ov-card[data-bench="B5M"][data-state="free"]');
  assert.deepEqual(await alice.evaluate(() => ({ bench: document.activeElement.closest('article')?.dataset.bench, action: document.activeElement.dataset.action })), { bench: 'B4M', action: 'open' });
  await chip(alice, 'free').filter({ hasText: 'Libres 7' }).waitFor();
  assert.equal((await api(chloe, 'POST', '/api/benches/B5M/take')).status, 200);
  await alice.waitForSelector('section.view-home article.ov-card[data-bench="B5M"][data-state="taken"]');

  // Live: Alice opens R1 and types; Chloe sees the console and its pilot, not what was typed
  const pane = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);
  await typeInConsole(pane, 'show clock private-to-alice');
  await waitForTerminal(pane, /show clock private-to-alice/);
  await card(chloe, 'B4M').locator('.ov-meta', { hasText: '1 console ouverte sur 10' }).waitFor();
  assert.doesNotMatch(await lab(chloe).textContent(), /private-to-alice/);

  // Alice's backup is on her home page, and on nobody else's
  const key = (await api(alice, 'GET', '/api/consoles/labs')).body.labs.find((l) => l.name === 'B4M').devices.find((d) => d.name === 'R1').key;
  const started = await api(alice, 'POST', '/api/jobs/benches/B4M/backup', { devices: [key], label: 'Avant le TP noté' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await card(chloe, 'B4M').locator('.ov-job', { hasText: 'Sauvegarde en cours' }).waitFor(); // everyone sees that a job runs
  await showHome(alice);
  const backup = home(alice).locator('[data-panel="backups"] li', { hasText: 'Avant le TP noté' });
  await backup.waitFor({ timeout: 90_000 });
  assert.match(await backup.textContent(), /B4M · 1 équipement · Alice Martin/);
  await allActivity(alice);
  await home(alice).locator('[data-panel="activity"] li', { hasText: 'Alice Martin a ouvert la console de R1' }).waitFor();

  // A ZIP imported, then deleted: the list follows, nothing else moves on the page
  const imported = await importZip(alice, 'bench=B4M&label=Import%20du%20soir', zipSync({ 'R1.cfg': strToU8('hostname R1\ninterface FastEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n') }));
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const extra = home(alice).locator('[data-panel="backups"] li', { hasText: 'Import du soir' });
  await extra.waitFor();
  assert.equal((await api(alice, 'DELETE', `/api/jobs/snapshots/${imported.body.snapshot.id}`)).status, 200);
  await extra.waitFor({ state: 'detached' });
  await backup.waitFor();

  await showHome(chloe);
  await home(chloe).locator('[data-panel="backups"]', { hasText: 'Aucune sauvegarde pour l’instant.' }).waitFor();
  await home(chloe).locator('[data-panel="activity"] li', { hasText: 'Chloé Dubois a pris la baie pour l’équipe Les switchs' }).waitFor();
  const chloeText = await home(chloe).textContent();
  assert.doesNotMatch(chloeText, /Avant le TP noté|Alice Martin/, 'nothing of the other team on her page');
  // A holder's team name is public (Le labo says who holds each bench); the cards of her own are hers only
  assert.doesNotMatch(await home(chloe).locator('[data-panel="bench"], [data-panel="team"], [data-panel="backups"], [data-panel="activity"], [data-panel="slots"]').allTextContents().then((t) => t.join(' ')), /Les routeurs/);
  await showLab(chloe);
  assert.doesNotMatch(await lab(chloe).textContent(), /Avant le TP noté/);

  // Live: an admin locks a bench; both pages show the reason as it is typed
  await showLab(alice);
  const ada = await newPage('ada');
  assert.equal((await api(ada, 'PUT', '/api/benches/B6B/lock', { reason: 'Préparée pour le <b>TP noté</b>' })).status, 200);
  for (const page of [alice, chloe]) {
    await page.waitForSelector('section.view-home article.ov-card[data-bench="B6B"][data-state="locked"]');
    const lock = card(page, 'B6B').locator('.ov-lock');
    assert.match(await lock.textContent(), /Préparée pour le <b>TP noté<\/b>/, 'shown as text');
    assert.equal(await lock.locator('b').count(), 0);
  }
  assert.equal((await api(ada, 'DELETE', '/api/benches/B6B/lock')).status, 200);
  await alice.waitForSelector('section.view-home article.ov-card[data-bench="B6B"][data-state="free"]');

  // The announcement is the shell's banner, once, under the header of the home page
  assert.equal((await api(ada, 'PUT', '/api/admin/announcement', { text: 'B6H hors service ce matin', level: 'warning' })).status, 200);
  await showHome(alice);
  await alice.locator('.announcement-banner', { hasText: 'B6H hors service ce matin' }).waitFor({ state: 'visible' });
  assert.equal(await alice.locator('.announcement-banner:visible').count(), 1, 'the announcement is shown once');
  assert.equal((await api(ada, 'DELETE', '/api/admin/announcement')).status, 200);
  await alice.locator('.announcement-banner:visible').waitFor({ state: 'detached' });

  for (const page of [alice, chloe, ada]) assert.deepEqual(page.errors, []);
});

test('an invitation shows on the invitee\'s home page as it is sent, with its action; once in the team, the page shows the team\'s bench and backups', async () => {
  const alice = pages[0];
  const bilal = await newPage('bilal');
  await showHome(bilal);
  assert.equal(await home(bilal).locator('[data-attention="invitation"]').count(), 0);

  const team = (await api(alice, 'GET', '/api/teams')).body.mine;
  assert.equal((await api(alice, 'POST', `/api/teams/${team.id}/invitations`, { username: 'student2' })).status, 201);
  const invitation = home(bilal).locator('[data-attention="invitation"]');
  await invitation.filter({ hasText: 'Alice Martin vous invite dans l’équipe Les routeurs' }).waitFor();
  assert.equal(await home(bilal).locator('[data-panel="bench"] article').count(), 0, 'an invitation gives no bench');
  await home(bilal).locator('[data-panel="backups"]').waitFor({ state: 'detached' });

  // He accepts, from the page: the team, its bench and its backups are his, the invitation is gone
  await invitation.locator('button[data-action="accept-invitation"]').click();
  await home(bilal).locator('[data-panel="team"] .ov-team-name', { hasText: 'Les routeurs' }).waitFor();
  await home(bilal).locator('[data-panel="bench"] article.ov-card[data-bench="B4M"][data-mine="true"]').waitFor();
  await home(bilal).locator('[data-panel="backups"] li', { hasText: 'Avant le TP noté' }).waitFor();
  await invitation.waitFor({ state: 'detached' });
  assert.deepEqual(bilal.errors, []);
});

test('a request to join the bench is on the occupants\' page, to accept or refuse from there', async () => {
  const [alice] = pages;
  const [, chloe, , bilal] = pages;
  assert.equal((await api(chloe, 'POST', '/api/benches/B4M/join')).status, 202);
  for (const page of [alice, bilal]) {
    await showHome(page);
    const request = home(page).locator('[data-attention="request"]');
    await request.filter({ hasText: 'Chloé Dubois demande à rejoindre la baie B4M' }).waitFor();
    assert.ok(await request.locator('button[data-action="accept-request"]').isVisible());
  }
  // One of them accepts: the request goes away for both, and Chloé is on the bench
  await home(alice).locator('[data-attention="request"] button[data-action="accept-request"]').click();
  await home(alice).locator('[data-attention="request"]').waitFor({ state: 'detached' });
  await home(bilal).locator('[data-attention="request"]').waitFor({ state: 'detached' });
  await home(alice).locator('[data-panel="bench"] .ov-hero-people li', { hasText: 'Chloé Dubois' }).waitFor();
  assert.equal((await api(chloe, 'POST', '/api/benches/B4M/leave')).status, 200);
  await home(alice).locator('[data-panel="bench"] .ov-hero-people li', { hasText: 'Chloé Dubois' }).waitFor({ state: 'detached' });
  for (const page of [alice, bilal, chloe]) assert.deepEqual(page.errors, []);
});

test('an administrator\'s home page puts the lab first, then the shortcuts of the administration', async () => {
  const ada = pages.find((p) => p.url().includes('/')) && await newPage('ada');
  await showHome(ada);
  await home(ada).locator('[data-panel="admin"] a[data-action="invite"]').waitFor();
  assert.equal(await home(ada).locator('[data-panel="admin"] a[data-action="invite"]').getAttribute('href'), '#/admin/invitations');
  assert.equal(await home(ada).locator('[data-panel="admin"] a[data-action="announce"]').getAttribute('href'), '#/admin/announcement');
  assert.equal(await home(ada).locator('[data-panel="admin"] a[data-action="lab"]').getAttribute('href'), '#/admin/lab');
  const order = await home(ada).locator('.ov-home > *').evaluateAll((els) => els.map((e) => e.dataset.panel ?? e.className));
  assert.ok(order.indexOf('lab') < order.indexOf('admin'), `Le labo before the shortcuts: ${order}`);
  assert.equal(await home(ada).locator('[data-panel="bench"], [data-panel="backups"]').count(), 0, 'an administrator has no team, bench or backups here');
  assert.deepEqual(ada.errors, []);
});

test('Le labo follows its filter in the address, in both directions; the page speaks English', async () => {
  const [alice] = pages;
  await goTo(alice, '#/home/lab/free', 'section.view-home .ov-lab article.ov-card');
  assert.equal(await chip(alice, 'free').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await lab(alice).locator('article.ov-card').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.state))]), ['free']);
  assert.equal(await home(alice).locator('#ov-lab-title').evaluate((n) => document.activeElement === n), true, 'the heading of Le labo has the focus');
  await chip(alice, 'locked').click();
  assert.match(alice.url(), /#\/home\/lab\/locked$/);
  assert.deepEqual(await lab(alice).locator('article.ov-card').evaluateAll((els) => els.map((e) => e.dataset.bench)), []);
  await lab(alice).locator('.ov-status', { hasText: 'Aucune baie ne correspond.' }).waitFor();
  await chip(alice, 'mine').click();
  assert.deepEqual(await lab(alice).locator('article.ov-card').evaluateAll((els) => els.map((e) => e.dataset.bench)), ['B4M']);
  await chip(alice, 'all').click();

  await setLanguage(alice, 'en');
  await showHome(alice);
  assert.equal(await home(alice).locator('h1').textContent(), 'Home');
  assert.equal(await alice.locator('#rail-items a[data-path="home"]').textContent(), 'Home', 'the navigation follows the language');
  await home(alice).locator('[data-panel="bench"] .ov-holder', { hasText: 'Taken by team Les routeurs since' }).waitFor();
  await home(alice).locator('[data-panel="backups"] li', { hasText: 'B4M · 1 device · Alice Martin' }).waitFor();
  await allActivity(alice);
  await home(alice).locator('[data-panel="activity"] li', { hasText: 'Alice Martin took the bench for team Les routeurs' }).waitFor();
  await card(alice, 'B5M').locator('.ov-holder', { hasText: 'Les switchs' }).waitFor();
  await chip(alice, 'free').filter({ hasText: /^Free \d$/ }).waitFor();
  await setLanguage(alice, 'fr');
  assert.deepEqual(alice.errors, []);
});

test('Le labo and the home page fit a wide window and a phone: cards in a grid, then a list; nothing wider than the window', async () => {
  const [alice] = pages;
  const columns = (page, selector) => page.locator(selector).evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const sectionOverflow = (page) => page.locator('section.view-home .view-body').evaluate((n) => n.scrollWidth - n.clientWidth);
  await alice.setViewportSize({ width: 1280, height: 800 });
  await goTo(alice, '#/home/lab', 'section.view-home .ov-lab article.ov-card');
  assert.ok(await columns(alice, 'section.view-home .ov-lab article.ov-card') >= 3, 'three benches or more across at 1280 px');
  assert.ok(await columns(alice, 'section.view-home .ov-trio > *') >= 2, 'the cards of the bottom row side by side');
  assert.ok(await overflow(alice) <= 0 && await sectionOverflow(alice) <= 0);
  await alice.setViewportSize({ width: 400, height: 800 });
  await goTo(alice, '#/home/lab', 'section.view-home .ov-lab tbody tr');
  assert.equal(await alice.locator('section.view-home .ov-lab article.ov-card').count(), 0, 'a phone gets the list, not the grid');
  assert.equal(await columns(alice, 'section.view-home .ov-lab tbody tr'), 1);
  assert.equal(await columns(alice, 'section.view-home .ov-trio > *'), 1);
  assert.ok(await overflow(alice) <= 0 && await sectionOverflow(alice) <= 0, 'no horizontal scroll on the home page at 400 px');
  // A row of the list leads to the bench
  await alice.locator('section.view-home .ov-lab tbody tr[data-key="B5M"] a.ov-link').click();
  await alice.waitForURL(/#\/consoles\/B5M$/);
  assert.deepEqual(alice.errors, []);
});
