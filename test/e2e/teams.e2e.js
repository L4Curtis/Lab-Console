/**
 * Teams and benches in the browser, with two people at once: Alice creates
 * her team and takes B4M, Bilal (from another context) asks to join, Alice
 * accepts and Bilal gets the console. Then an admin locks a bench: students
 * see the reason and are refused, the admin still opens its consoles
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole } from './harness.js';

const h = useHarness();

const bar = (page) => page.locator('section.view-consoles .bench-bar');
const action = (page, name) => bar(page).locator(`button[data-action="${name}"]`);
const toastWith = (page, text) => page.locator('.toast', { hasText: text });

async function showBench(page, bench) {
  await page.evaluate((hash) => { location.hash = hash; }, `#/consoles/${bench}`);
  await page.waitForFunction((name) => document.querySelector('section.view-consoles .canvas-title')?.textContent === name, bench);
  await bar(page).waitFor();
}

test('Alice\'s team takes B4M, Bilal asks to join, Alice accepts and Bilal reaches R1', async () => {
  const alice = await h.newPage();
  await signInAs(alice, 'alice');

  // Alice creates her team in the Team section
  await alice.click('#rail-items a[href="#/team"]');
  const create = alice.locator('section.view-team form.team-form');
  await create.locator('input[name="name"]').fill('Les routeurs');
  await create.locator('button[data-action="create"]').click();
  await alice.waitForSelector('section.view-team .team-mine .team-name:text-is("Les routeurs")');

  // …and takes B4M for it
  await showBench(alice, 'B4M');
  await alice.waitForSelector('section.view-consoles .bench-bar .bench-status:has-text("Baie libre")');
  await action(alice, 'take').click();
  await bar(alice).locator('.bench-status', { hasText: 'Prise par l’équipe Les routeurs' }).waitFor();
  assert.equal(await bar(alice).getAttribute('data-mine'), 'true');

  // Bilal, in his own browser, sees who holds the bench and cannot open its consoles
  const bilal = await h.newPage();
  await signInAs(bilal, 'bilal');
  await showBench(bilal, 'B4M');
  await bar(bilal).locator('.bench-status', { hasText: 'Les routeurs' }).waitFor();
  assert.equal(await action(bilal, 'take').count(), 0, 'no take button on a bench held by another team');
  await bilal.locator('section.view-consoles g.device', { has: bilal.locator('tspan.name', { hasText: /^R1$/ }) }).click();
  await toastWith(bilal, 'occupée par une autre équipe').waitFor();
  assert.equal(await bilal.locator('article.pane.pane-console').count(), 0, 'no console opened');

  // He asks to join; the request appears at Alice's, live
  await action(bilal, 'join').click();
  await action(bilal, 'cancel-join').waitFor();
  const request = bar(alice).locator('.bench-requests li', { hasText: 'Bilal Haddad' });
  await request.waitFor();
  await request.locator('button[data-action="accept"]').click();

  // Bilal is told, becomes a guest and opens R1
  await toastWith(bilal, 'Vous avez rejoint la baie B4M').waitFor();
  await action(bilal, 'leave').waitFor();
  await bar(bilal).locator('.bench-people li[data-guest="true"]', { hasText: 'Bilal Haddad' }).waitFor();
  assert.equal(await bar(alice).locator('.bench-requests li').count(), 0, 'the request is answered');
  await openConsole(bilal, 'B4M', 'R1');

  // The bench history says what happened
  await action(alice, 'history').click();
  const history = alice.locator('dialog .bench-history');
  await history.waitFor();
  assert.match(await history.textContent(), /Alice Martin a pris la baie pour l’équipe Les routeurs/);
  assert.match(await history.textContent(), /Alice Martin a accepté Bilal Haddad sur la baie/);

  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bilal.errors, []);
  await bilal.context().close();
  await alice.context().close();
});

test('a locked bench refuses everyone but admins, and shows its reason', async () => {
  const ada = await h.newPage();
  await signInAs(ada, 'ada');
  await showBench(ada, 'B6B');
  await action(ada, 'lock').click();
  await ada.fill('dialog input[name="reason"]', 'Préparée pour le TP noté');
  await ada.click('dialog button[data-action="confirm"]');
  await bar(ada).locator('.bench-lock', { hasText: 'Préparée pour le TP noté' }).waitFor();

  // A student with a team: the reason is shown, nothing to take, consoles refused
  const chloe = await h.newPage();
  await signInAs(chloe, 'chloe');
  const created = await chloe.evaluate(() => fetch('/api/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Les switchs' }) }).then((r) => r.status));
  assert.equal(created, 201);
  await showBench(chloe, 'B6B');
  await bar(chloe).locator('.bench-lock', { hasText: 'Préparée pour le TP noté' }).waitFor();
  assert.equal(await bar(chloe).getAttribute('data-state'), 'locked');
  assert.equal(await action(chloe, 'take').count(), 0);
  assert.equal(await action(chloe, 'unlock').count(), 0, 'only admins lift a lock');
  await chloe.locator('section.view-consoles g.device', { has: chloe.locator('tspan.name', { hasText: /^R1$/ }) }).click();
  await toastWith(chloe, 'verrouillée').waitFor();
  assert.equal(await chloe.locator('article.pane.pane-console').count(), 0);
  // The server says the same, whatever the page shows
  const take = await chloe.evaluate(() => fetch('/api/benches/B6B/take', { method: 'POST' }).then(async (r) => ({ status: r.status, code: (await r.json()).code })));
  assert.deepEqual(take, { status: 423, code: 'benches.locked' });

  // The admin still works on it
  await openConsole(ada, 'B6B', 'R1');

  // Lifting the lock gives the bench back to the students
  await action(ada, 'unlock').click();
  await ada.click('dialog button[data-action="confirm"]');
  await action(chloe, 'take').waitFor();
  assert.equal(await bar(chloe).locator('.bench-lock').count(), 0);

  assert.deepEqual(ada.errors, []);
  assert.deepEqual(chloe.errors, []);
  await chloe.context().close();
  await ada.context().close();
});

test('the reservation calendar books a slot for the team and shows it on the bench', async () => {
  const chloe = await h.newPage();
  await signInAs(chloe, 'chloe');
  // Chloé's team, whether or not the scenario above created it
  await chloe.evaluate(async () => {
    const { mine } = await fetch('/api/teams').then((r) => r.json());
    if (!mine) await fetch('/api/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Les switchs' }) });
  });
  await chloe.goto(`${h.url}/#/team/calendar/B5M`);
  await chloe.waitForSelector('section.view-team .cal-grid .cal-col');
  // Next week, so that the hour is never in the past
  await chloe.click('section.view-team .cal-panel .panel-toolbar .icon-btn >> nth=1');
  await chloe.locator('section.view-team .cal-col').nth(2).locator('button.cal-cell[data-hour="10"]').click();
  await chloe.click('dialog button[data-action="confirm"]');
  const slot = chloe.locator('section.view-team .cal-slot[data-mine="true"]', { hasText: 'Les switchs' });
  await slot.waitFor();
  assert.match(await slot.textContent(), /10:00.12:00/);

  await showBench(chloe, 'B5M');
  await bar(chloe).locator('.bench-slot', { hasText: 'Les switchs' }).waitFor();
  assert.deepEqual(chloe.errors, []);
  await chloe.context().close();
});

test('the calendar places slots right on a daylight-saving day and lists the ones outside 08:00-20:00', async () => {
  // Paris, Sunday 28 March 2027: the clocks jump from 02:00 to 03:00, so this day lasts 23 hours
  const page = await h.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' });
  await signInAs(page, 'ada');
  const booked = await page.evaluate(async () => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
    const out = [await post('/api/teams', { name: 'Les admins' })];
    // 10:00-12:00 and 20:30-22:00 local time on that Sunday (UTC+2 once the clocks have moved)
    out.push(await post('/api/benches/reservations', { bench: 'B5M', start: '2027-03-28T08:00:00Z', end: '2027-03-28T10:00:00Z' }));
    out.push(await post('/api/benches/reservations', { bench: 'B5M', start: '2027-03-28T18:30:00Z', end: '2027-03-28T20:00:00Z' }));
    return out;
  });
  assert.deepEqual(booked, [201, 201, 201]);

  await page.clock.setFixedTime(new Date('2027-03-25T11:00:00Z'));
  await page.goto(`${h.url}/#/team/calendar/B5M`);
  await page.reload();
  const sunday = page.locator('section.view-team .cal-col').nth(6);
  const slot = sunday.locator('.cal-slot', { hasText: '10:00' });
  await slot.waitFor();
  // 10:00 is 2 hours into a 12-hour grid, whatever the length of the day
  const place = await slot.evaluate((el) => ({ top: parseFloat(el.style.top), height: parseFloat(el.style.height) }));
  assert.ok(Math.abs(place.top - 100 / 6) < 0.01, `top ${place.top}`);
  assert.ok(Math.abs(place.height - 100 / 6) < 0.01, `height ${place.height}`);
  assert.equal(await sunday.locator('.cal-slot').count(), 1, 'the evening slot is not in the grid');

  // …but the week does not look free: it is listed under the grid
  const outside = page.locator('section.view-team .cal-outside-list li');
  await outside.first().waitFor();
  assert.equal(await outside.count(), 1);
  assert.match(await outside.first().textContent(), /Les admins.*20:30.22:00/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the bench bar decorates the diagram: ours, taken, locked, nothing on a free bench', async () => {
  // The rooms lot's DiagramView provides decorate(layer, fn); until then a stand-in records the function the bar registers
  const ada = await h.newPage();
  await signInAs(ada, 'ada');
  const locked = await ada.evaluate(() => fetch('/api/benches/B5H/lock', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Préparée pour le TP noté' }) }).then((r) => r.status));
  assert.equal(locked, 200);

  const mount = (page, bench) => page.evaluate(async (name) => {
    const { mountBenchBar } = await import('/js/modules/teams/benchBar.js');
    const host = document.createElement('div');
    host.id = `decor-${name}`;
    document.body.append(host);
    const bar = mountBenchBar(host);
    const layers = {};
    bar.decorate({ decorate(layer, fn) { layers[layer] = fn; } });
    window.decorations = window.decorations ?? {};
    window.decorations[name] = (device) => layers.benches(device);
    await bar.ready;
    bar.setBench(name);
  }, bench);
  const ringOf = async (page, bench) => {
    await mount(page, bench);
    await page.waitForSelector(`#decor-${bench} .bench-status`);
    return page.evaluate((name) => window.decorations[name]({ labName: name }), bench);
  };

  const alice = await h.newPage(); // her team holds B4M since the first scenario
  await signInAs(alice, 'alice');
  assert.deepEqual(await ringOf(alice, 'B4M'), { ring: 'ours' });

  const chloe = await h.newPage();
  await signInAs(chloe, 'chloe');
  const taken = await ringOf(chloe, 'B4M');
  assert.equal(taken.ring, 'taken');
  assert.match(taken.tooltip, /Les routeurs/);
  const lockedRing = await ringOf(chloe, 'B5H');
  assert.equal(lockedRing.ring, 'locked');
  assert.equal(await ringOf(chloe, 'B6H'), null, 'a free bench has no ring');
  assert.equal(await chloe.evaluate(() => window.decorations.B4M({ labName: 'B6H' })), null, 'another bench\'s device is not decorated');

  for (const page of [ada, alice, chloe]) {
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});
