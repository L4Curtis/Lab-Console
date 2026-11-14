/**
 * What the 'ui' audit measured, kept as assertions: table columns line up
 * with their headers, the consoles header fits at laptop widths in both
 * languages, nothing overflows the page on a phone, every section's text
 * has AA contrast in both themes, and the shell is usable with a keyboard
 * and a screen reader (skip link, page title, focus, unknown address, 404)
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, waitForApp } from './harness.js';
import { contrastFailures, tinyText } from './contrast.js';

const h = useHarness({ oidc: false, mockLab: false });

before(async () => { await h.ready; });

/** A page signed in as an administrator, at `width` x `height` */
async function open({ locale = 'fr', width = 1280, height = 800, theme } = {}) {
  const page = await h.newPage({ locale });
  await page.setViewportSize({ width, height });
  await h.session(page, 'admin');
  await page.goto(h.url);
  await waitForApp(page);
  if (theme) await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  return page;
}
const go = async (page, route, ready) => {
  await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
  await page.waitForSelector(ready ?? `section.view-${route.split('/')[0]}:not([hidden]) h1`);
};

test('administration > users: the header row and the body share their columns', async () => {
  const page = await open();
  await go(page, 'admin');
  await page.waitForSelector('table.accounts-table tbody tr td');
  const cols = await page.evaluate(() => {
    const table = document.querySelector('table.accounts-table');
    const head = [...table.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().left));
    const body = [...table.querySelector('tbody tr').children].map((td) => Math.round(td.getBoundingClientRect().left));
    return { head, body, nested: document.querySelectorAll('thead > tbody').length };
  });
  assert.equal(cols.nested, 0, 'the body is not inside the head');
  assert.deepEqual(cols.head, cols.body);
  await page.context().close();
});

for (const locale of ['fr', 'en']) {
  for (const width of [1280, 1440]) {
    test(`consoles header at ${width} px (${locale}): one line per button, every bench of the picker reachable`, async () => {
      const page = await open({ locale, width });
      await go(page, 'consoles', 'section.view-consoles .rack-slot');
      const m = await page.evaluate(() => {
        const box = (e) => e.getBoundingClientRect();
        const picker = document.querySelector('.lab-picker');
        return {
          buttons: [...document.querySelectorAll('.view-consoles .head-actions .find-btn')].map((b) => ({ text: b.textContent.trim(), height: Math.round(box(b).height), width: Math.round(box(b).width) })),
          kbd: Math.round(box(document.querySelector('.find-btn kbd')).height),
          pickerClipped: picker.scrollWidth - picker.clientWidth,
          slots: [...document.querySelectorAll('.rack-slot:not(.blank)')].map((s) => Math.round(box(s).height)),
        };
      });
      assert.equal(m.buttons.length, 4);
      for (const b of m.buttons) assert.ok(b.height <= 36, `"${b.text}" stays on one line (${b.height} px high)`);
      assert.ok(m.buttons.every((b) => b.width >= 34), 'the icon button is not squeezed');
      assert.ok(m.kbd <= 24, 'Ctrl K stays in one piece');
      assert.ok(m.pickerClipped <= 0, `the picker is not cut off (${m.pickerClipped} px hidden)`);
      assert.ok(m.slots.every((height) => height >= 22), 'a bench button can be hit');
      await page.context().close();
    });
  }
}

test('a phone: nothing overflows the page, the rail is a bar at the bottom, the notice is not on the diagram', async () => {
  const page = await open({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.equal(await overflow(), 0, 'home');
  const rail = await page.evaluate(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; });
  assert.ok(rail.top > 700 && rail.width === 390, 'the rail is a bar under the page');

  await go(page, 'admin');
  const tabs = page.locator('section.view-admin .admin-tabs [role="tab"]');
  for (let i = 0; i < await tabs.count(); i++) {
    await tabs.nth(i).evaluate((tab) => { tab.scrollIntoView(); tab.click(); }); // the strip scrolls sideways: a finger would swipe it
    assert.equal(await overflow(), 0, `administration tab ${i}`);
  }
  for (const route of ['jobs', 'team', 'status', 'help', 'account', 'overview']) {
    await go(page, route);
    assert.equal(await overflow(), 0, route);
  }

  await page.evaluate(() => localStorage.removeItem('labconsole.journalNoticeSeen'));
  await go(page, 'consoles', 'section.view-consoles .rack-slot');
  await page.reload();
  await waitForApp(page);
  await go(page, 'consoles', 'section.view-consoles .rack-slot');
  const notice = await page.evaluate(() => {
    const el = document.querySelector('.journal-notice');
    return el && !el.hidden ? { position: getComputedStyle(el).position, height: Math.round(el.getBoundingClientRect().height) } : null;
  });
  if (notice) assert.deepEqual({ position: notice.position, short: notice.height < 120 }, { position: 'static', short: true });
  await page.context().close();
});

for (const theme of ['light', 'dark']) {
  test(`text contrast is AA in every section (${theme} theme)`, async () => {
    const page = await open({ width: 1440, height: 900, theme });
    const routes = ['home', 'consoles', 'overview', 'team', 'infra', 'jobs', 'status', 'help', 'account', 'admin'];
    const failures = [];
    for (const route of routes) {
      await go(page, route);
      failures.push(...(await contrastFailures(page, { within: `section.view-${route}` })).map((f) => ({ route, ...f })));
      failures.push(...(await tinyText(page, { within: `section.view-${route}` })).map((f) => ({ route, ...f })));
    }
    await go(page, 'admin');
    const tabs = page.locator('section.view-admin .admin-tabs [role="tab"]');
    for (let i = 0; i < await tabs.count(); i++) {
      await tabs.nth(i).click();
      failures.push(...(await contrastFailures(page, { within: 'section.view-admin' })).map((f) => ({ route: `admin tab ${i}`, ...f })));
    }
    failures.push(...(await contrastFailures(page, { within: '.rail' })).map((f) => ({ route: 'rail', ...f })));
    assert.deepEqual(failures, []);
    await page.context().close();
  });
}

test('the login page has AA contrast too', async () => {
  const page = await h.newPage({ locale: 'fr' });
  await page.goto(`${h.url}/login`);
  await page.waitForSelector('.login-card h1');
  assert.deepEqual(await contrastFailures(page), []);
  await page.context().close();
});

test('keyboard and screen reader: skip link, page title, focus, unknown address, 404 page', async () => {
  const page = await open();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'skip-link', 'the first stop of the page jumps over the rail');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'views', 'it lands on the content');

  const titles = {};
  for (const route of ['home', 'consoles', 'overview', 'team', 'infra', 'admin', 'jobs', 'status', 'help']) {
    await go(page, route);
    if (route !== 'home') await page.waitForFunction((r) => document.activeElement.closest('section')?.classList.contains(`view-${r}`), route);
    titles[route] = await page.title();
  }
  assert.equal(new Set(Object.values(titles)).size, 9, 'one title per section');
  assert.match(titles.admin, /^Administration · Lab Console$/);
  await page.waitForFunction(() => document.activeElement.tagName === 'H1'); // the router focuses the heading once the section is shown
  assert.equal(await page.evaluate(() => document.activeElement.closest('section').className), 'view view-help', 'the heading of the new section has the focus');
  await page.locator('button[data-lang="en"]').first().click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.match(await page.title(), /^Help · Lab Console$/, 'the title follows the language');

  await page.evaluate(() => { location.hash = '#/nonexistent'; });
  await page.waitForFunction(() => location.hash === '#/home');
  assert.equal(await page.locator('#rail-items a.active').getAttribute('data-path'), 'home');

  const response = await page.goto(`${h.url}/nope`);
  assert.equal(response.status(), 404);
  await page.waitForSelector('h1');
  assert.equal(await page.locator('h1').textContent(), 'Page not found');
  await page.context().close();
});

test('every table column has a name, the second port-range value too', async () => {
  const page = await open();
  await go(page, 'admin');
  const tabs = page.locator('section.view-admin .admin-tabs [role="tab"]');
  await page.locator('section.view-admin [data-tab="lab"]').click();
  await page.waitForSelector('#lab-consoles-portRange-max');
  assert.equal(await page.getAttribute('#lab-consoles-portRange-max', 'aria-label'), 'Port maximal');
  const unnamedNow = () => page.evaluate(() => [
    ...[...document.querySelectorAll('section.view-admin th')].filter((th) => th.getBoundingClientRect().width && !th.textContent.trim()).map((th) => `th ${th.dataset.col ?? '?'}`),
    ...[...document.querySelectorAll('section.view-admin input')].filter((i) => i.getBoundingClientRect().width && i.type !== 'hidden' && !i.labels?.length && !i.getAttribute('aria-label') && !i.title).map((i) => `input ${i.id || i.name}`),
  ]);
  const unnamed = [];
  for (let i = 0; i < await tabs.count(); i++) {
    await tabs.nth(i).click();
    // a tab fills its table once its data has arrived: give it a moment, then report what is still unnamed
    await page.waitForFunction(() => document.querySelector('section.view-admin [role="tabpanel"]:not([hidden])')?.children.length).catch(() => {});
    unnamed.push(...await unnamedNow());
  }
  assert.deepEqual(unnamed, []);
  await page.context().close();
});
