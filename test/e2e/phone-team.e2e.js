/**
 * The team, bench, reservation and backup screens on a phone (390 x 844,
 * touch), then at 768 and 1440 px, in both themes and both languages
 * (docs/v2/UX.md §10.2–10.6, §12): nothing overflows sideways, the controls
 * of the main flows are 44 px targets, the bench strip is one line and opens
 * the bench as a sheet, the calendar is a day agenda, the backup dialogs are
 * bottom sheets, text is at least 12 px and passes AA contrast
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, waitForApp, signInAs } from './harness.js';
import { contrastFailures, tinyText } from './contrast.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.05', JOB_COUNTDOWN_SECONDS: '4' } });
before(async () => { await h.ready; });

const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

async function open(who, { phone = true, locale = 'fr', theme, size } = {}) {
  const page = phone ? await h.newPhonePage({ locale }) : await h.newPage({ locale });
  if (size) await page.setViewportSize(size);
  await h.session(page, who);
  await page.goto(h.url);
  await waitForApp(page);
  if (theme) await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
  return page;
}
const go = (page, hash) => page.evaluate((x) => { location.hash = x; }, hash);
const settled = (page, selector = 'dialog[open]') => page.waitForFunction((sel) => {
  const el = document.querySelector(sel);
  return el && el.getAnimations({ subtree: true }).every((a) => a.playState === 'finished');
}, selector);
const overflow = (page) => page.evaluate(() => {
  const body = document.querySelector('section.view:not([hidden]) .view-body');
  return { page: document.documentElement.scrollWidth - innerWidth, body: body ? body.scrollWidth - body.clientWidth : 0 };
});
/** Visible controls of `scope` under 44 px, as names */
const small = (page, scope) => page.locator(scope).locator('button:visible, a[href]:visible, select:visible, input:visible:not([type="checkbox"]):not([type="radio"])').evaluateAll(
  (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; })
    .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30)}"`));

/** Alice in a team that holds B4M, Chloé in another team: the same whatever the order of the scenarios */
async function setup() {
  const alice = await open('alice');
  await api(alice, 'POST', '/api/teams', { name: 'Les mobiles' });
  await api(alice, 'POST', '/api/benches/B4M/take');
  const chloe = await open('chloe');
  await api(chloe, 'POST', '/api/teams', { name: 'Les tablettes' });
  return { alice, chloe };
}

test('Mon équipe on a phone: the form is a full-width 44 px target, rename and leave are in ⋯, an invitation is withdrawn from its menu', async () => {
  const { alice, chloe } = await setup();
  await chloe.context().close();
  const bilal = await h.newPage(); // the directory knows a classmate after their first sign-in through the provider
  await signInAs(bilal, 'bilal');
  await bilal.context().close();
  await go(alice, '#/team/mine');
  const view = alice.locator('section.view-team:not([hidden])');
  await view.locator('.team-mine').waitFor();
  assert.deepEqual(await overflow(alice), { page: 0, body: 0 });
  const invite = view.locator('.team-form button[data-action="invite"]');
  const box = await invite.boundingBox();
  assert.ok(box.height >= 44 && box.width >= 300, `Inviter: ${box.width} x ${box.height}`);

  // Renommer / Quitter l’équipe: in the app bar's ⋯, as a sheet
  await view.locator('.page-header .more-btn:visible').click();
  await settled(alice);
  assert.deepEqual(await alice.locator('dialog[open] [role="menuitem"]').evaluateAll((items) => items.map((i) => i.dataset.id)), ['rename', 'leave']);
  assert.deepEqual(await small(alice, 'dialog[open]'), [], 'every row of the sheet is a 44 px target');
  await alice.keyboard.press('Escape');

  await view.locator('.team-form input[name="username"]').fill('student2');
  await invite.click();
  const pending = view.locator('li[data-invitee="student2"]');
  await pending.waitFor();
  await pending.locator('.more-btn').click();
  await alice.locator('dialog[open] [data-id="withdraw"]').click();
  await pending.waitFor({ state: 'detached' });
  assert.deepEqual(await small(alice, 'section.view-team:not([hidden]) .team-page'), [], 'the controls of the page are 44 px targets');
  assert.deepEqual(alice.errors, []);
  await alice.context().close();
});

test('the bench on a phone: the primary action under the app bar, the strip is one line and opens the bench as a sheet that Back closes', async () => {
  const { alice, chloe } = await setup();
  await go(alice, '#/team/bench');
  const view = alice.locator('section.view-team:not([hidden])');
  await view.locator('.bench-status-card .bench-name', { hasText: 'B4M' }).waitFor();
  const release = view.locator('.page-header button[data-action="release"]:visible');
  const primary = await release.boundingBox();
  assert.ok(primary.height >= 48 && primary.width >= 340, `Libérer la baie: ${primary.width} x ${primary.height}`);
  assert.deepEqual(await overflow(alice), { page: 0, body: 0 });

  // Chloé asks to join: the request is on the page right away
  await go(chloe, '#/consoles/B4M');
  await chloe.locator('section.view-consoles .bench-bar [data-action="join"]').click();
  await view.locator('.bench-requests-card li', { hasText: 'Student 3' }).waitFor();

  // The strip on the consoles page: the state, the request, one line each
  await go(alice, '#/consoles/B4M');
  const strip = alice.locator('section.view-consoles .bench-bar');
  await strip.locator('.bench-status').waitFor();
  const lines = await strip.locator('.bench-line').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().height)));
  assert.equal(lines.length, 2, 'the state and the request, nothing else');
  assert.ok(lines.every((height) => height <= 64), `one line each (${lines.join(', ')} px)`);
  assert.deepEqual(await small(alice, 'section.view-consoles .bench-bar'), [], 'the strip is made of 44 px targets');
  assert.equal(await strip.locator('[data-action="release"]:visible').count(), 0, 'Libérer la baie is in ⋯ on a phone');

  // A tap on the state opens the bench: the same page as the Baie tab, as a sheet
  await strip.locator('.bench-main .bench-status').click();
  const sheet = alice.locator('dialog[open] .bench-sheet');
  await sheet.locator('.bench-status-card .bench-name', { hasText: 'B4M' }).waitFor();
  await settled(alice);
  assert.deepEqual(await alice.evaluate(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { bottom: Math.round(r.bottom), width: Math.round(r.width) }; }), { bottom: 844, width: 390 });
  await sheet.locator('.bench-requests-card li', { hasText: 'Student 3' }).locator('button[data-action="accept"]').click();
  await sheet.locator('.bench-people li[data-guest="true"]', { hasText: 'Student 3' }).waitFor();
  await alice.goBack();
  await sheet.waitFor({ state: 'detached' });
  assert.equal(await alice.evaluate(() => location.hash), '#/consoles/B4M');

  // Chloé is on the bench now, as a guest: she leaves it from the sheet of her own strip
  await chloe.locator('section.view-consoles .bench-bar .bench-status', { hasText: 'invité' }).waitFor();
  await api(chloe, 'POST', '/api/benches/B4M/leave');
  assert.deepEqual(alice.errors, []);
  assert.deepEqual(chloe.errors, []);
  await alice.context().close();
  await chloe.context().close();
});

test('reservations on a phone: one day at a time, a free hour opens the booking sheet, a swipe changes the day, our slot is cancelled in place', async () => {
  const { alice, chloe } = await setup();
  await chloe.context().close();
  await go(alice, '#/team/calendar/B5M');
  const view = alice.locator('section.view-team:not([hidden])');
  await view.locator('.cal-agenda .cal-hours').waitFor();
  assert.equal(await view.locator('.cal-scroll').isVisible(), false, 'no seven-day grid on a phone');
  assert.equal(await view.locator('.cal-day-chip').count(), 7);
  assert.deepEqual(await overflow(alice), { page: 0, body: 0 });

  // Next week, Wednesday: always in the future
  await view.locator('button[data-action="next"]').click();
  await view.locator('.cal-day-chip[data-day="2"]').click();
  assert.equal(await view.locator('.cal-day-chip[data-day="2"]').getAttribute('aria-pressed'), 'true');
  const free = view.locator('.cal-hour[data-hour="10"] .cal-free');
  const row = await free.boundingBox();
  assert.ok(row.height >= 52, `an hour is a ${row.height} px row`);
  await free.click();
  await alice.locator('dialog[open] button[data-action="confirm"]').click();
  const booked = view.locator('.cal-hour[data-hour="10"] .cal-booked[data-mine="true"]');
  await booked.waitFor();
  assert.match(await booked.textContent(), /Votre équipe/);
  assert.match(await booked.textContent(), /10:00.12:00/);
  assert.match(await view.locator('.cal-hour[data-hour="11"]').textContent(), /Votre équipe/, 'the two hours of the slot');

  // A swipe to the left: the next day
  await view.locator('.cal-hours').evaluate((list) => {
    const touch = (type, x) => list.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, changedTouches: [new Touch({ identifier: 1, target: list, clientX: x, clientY: 300 })], touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: list, clientX: x, clientY: 300 })] }));
    touch('touchstart', 300);
    touch('touchend', 120);
  });
  await view.locator('.cal-day-chip[data-day="3"][aria-pressed="true"]').waitFor();
  await view.locator('.cal-day-chip[data-day="2"]').click();

  // Cancel the slot where it is
  await booked.click();
  await alice.locator('dialog[open] button[data-action="confirm"]').click();
  await free.waitFor();
  assert.deepEqual(await small(alice, 'section.view-team:not([hidden]) .cal-agenda'), [], 'the agenda is made of 44 px targets');
  assert.deepEqual(alice.errors, []);
  await alice.context().close();
});

test('backups on a phone: cards instead of a table, the dialogs are bottom sheets with 44 px rows, the search is a sheet, a backup is followed and its ZIP offered', async () => {
  const { alice, chloe } = await setup();
  await chloe.context().close();
  await go(alice, '#/jobs/B4M');
  const view = alice.locator('section.view-jobs:not([hidden])');
  const backup = view.locator('.page-header button[data-action="backup"]:visible:not([disabled])');
  await backup.waitFor();
  const primary = await backup.boundingBox();
  assert.ok(primary.height >= 48 && primary.width >= 340, `Sauvegarder: ${primary.width} x ${primary.height}`);
  assert.deepEqual(await overflow(alice), { page: 0, body: 0 });

  await backup.click();
  const dlg = alice.locator('dialog.modal[open]');
  await dlg.locator('.jobs-devices li').first().waitFor();
  await settled(alice);
  assert.deepEqual(await alice.evaluate(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { bottom: Math.round(r.bottom), width: Math.round(r.width) }; }), { bottom: 844, width: 390 }, 'a bottom sheet');
  const rows = await dlg.locator('.jobs-devices li').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  assert.ok(rows.every((height) => height >= 44), `device rows: ${rows.join(', ')}`);
  assert.match(await dlg.locator('.jobs-devices li[data-device="S5"] .badge').textContent(), /partagé avec une autre baie/);
  const buttons = await dlg.locator('.form-actions button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  assert.ok(buttons.every((height) => height >= 48), `footer buttons: ${buttons.join(', ')}`);
  await dlg.locator('input[name="label"]').fill('depuis le téléphone');
  await dlg.locator('button[data-action="confirm"]').click();

  // Followed live; the ZIP is offered at once
  await view.locator('.jobs-current[data-state="done"]').waitFor({ timeout: 60_000 });
  const zip = view.locator('.jobs-download a[data-action="download-zip"]');
  const offer = await zip.boundingBox();
  assert.ok(offer.height >= 44, `Télécharger le ZIP: ${offer.height} px`);
  assert.deepEqual(await overflow(alice), { page: 0, body: 0 }, 'the running card and the callout fit');
  await view.locator('.jobs-detail summary').click();
  assert.equal(await view.locator('.jobs-device-list li').first().isVisible(), true);

  // The snapshots are cards, with the ZIP at hand and the rest in ⋯
  const card = view.locator('.jobs-snapshots tbody tr', { hasText: 'depuis le téléphone' });
  await card.waitFor();
  assert.equal(await card.evaluate((tr) => getComputedStyle(tr).display), 'grid', 'a card, not a table row');
  assert.deepEqual(await small(alice, 'section.view-jobs:not([hidden]) .jobs-snapshots'), []);
  await card.locator('.more-btn').click();
  await settled(alice);
  assert.deepEqual(await alice.locator('dialog[open] [role="menuitem"]').evaluateAll((items) => items.map((i) => i.dataset.id)), ['view', 'compare', 'inject', 'folder', 'delete'], 'the rest of the row\'s actions (no other backup to compare with yet)');
  await alice.keyboard.press('Escape');

  // The search is an icon of the app bar, and a sheet
  await view.locator('.page-header [data-action="search"]:visible').click();
  await alice.locator('dialog[open] input[type="search"]').fill('hostname');
  await alice.locator('dialog[open] button[type="submit"]').click();
  await alice.locator('dialog[open] .jobs-hits li').first().waitFor();
  await alice.keyboard.press('Escape');

  // Reset and injection are in ⋯, with the bench name to type
  await view.locator('.page-header .more-btn:visible').click();
  await alice.locator('dialog[open] [data-id="reset"]').click();
  await alice.locator('dialog.modal[open] input[name="confirm"]').waitFor();
  assert.equal(await alice.locator('dialog.modal[open] button[data-action="confirm"]').isDisabled(), true);
  await alice.keyboard.press('Escape');

  // The other two tabs
  for (const [tab, selector] of [['templates', '.jobs-templates'], ['runs', '.jobs-runs']]) {
    await view.locator(`[role="tab"][data-tab="${tab}"]`).click();
    await view.locator(selector).waitFor();
    assert.deepEqual(await overflow(alice), { page: 0, body: 0 }, tab);
  }
  assert.deepEqual(alice.errors, []);
  await alice.context().close();
});

const SCREENS = [
  { hash: '#/team/mine', ready: '.team-page .card', section: 'team' },
  { hash: '#/team/bench', ready: '.bench-status-card', section: 'team' },
  { hash: '#/team/calendar/B5M', ready: '.cal-toolbar', section: 'team' },
  { hash: '#/jobs/B4M', ready: '.jobs-snapshots', section: 'jobs' },
  { hash: '#/jobs/B4M/templates', ready: '.jobs-templates', section: 'jobs' },
  { hash: '#/jobs/B4M/runs', ready: '.jobs-runs', section: 'jobs' },
];
const SIZES = [
  { name: 'phone', phone: true },
  { name: 'tablet', phone: false, size: { width: 768, height: 1024 } },
  { name: 'desktop', phone: false, size: { width: 1440, height: 900 } },
];

for (const { name, phone, size } of SIZES) {
  test(`${name}: team, bench, reservations and backups, in both themes and both languages, do not overflow and read well`, async () => {
    const { alice, chloe } = await setup();
    await chloe.context().close();
    await alice.context().close();
    const failures = [];
    for (const locale of ['fr', 'en']) {
      const page = await open('alice', { phone, locale, size });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
        for (const { hash, ready, section } of SCREENS) {
          await go(page, hash);
          const view = page.locator(`section.view-${section}:not([hidden])`);
          await view.locator(ready).first().waitFor();
          await page.waitForFunction(() => !document.querySelector('section.view:not([hidden]) .skeleton'));
          const where = `${name} ${locale} ${theme} ${hash}`;
          const o = await overflow(page);
          if (o.page || o.body) failures.push(`${where}: sideways overflow ${JSON.stringify(o)}`);
          for (const f of await contrastFailures(page, { within: `section.view-${section}:not([hidden])` })) failures.push(`${where}: contrast ${JSON.stringify(f)}`);
          for (const f of await tinyText(page, { within: `section.view-${section}:not([hidden])` })) failures.push(`${where}: small text ${JSON.stringify(f)}`);
        }
      }
      assert.deepEqual(page.errors, []);
      await page.context().close();
    }
    assert.deepEqual(failures, []);
  });
}
