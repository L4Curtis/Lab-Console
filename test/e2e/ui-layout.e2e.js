/**
 * What the 'ui' audit measured, kept as assertions: table columns line up
 * with their headers, the consoles header fits at laptop widths in both
 * languages, nothing overflows the page on a phone, every section's text
 * has AA contrast in both themes, and the shell is usable with a keyboard
 * and a screen reader (skip link, page title, focus, unknown address, 404).
 * The navigation of the redesign (docs/v2/UX.md §4, §5): five items in the
 * phone's tab bar and the Plus sheet, the rail and its Plus menu, the
 * account menu (theme, language), old addresses, dialogs as bottom sheets
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, waitForApp, setLanguage, openAccountMenu } from './harness.js';
import { contrastFailures, tinyText } from './contrast.js';

const h = useHarness({ oidc: false, mockLab: false });

before(async () => { await h.ready; });

/** A page signed in as an administrator, at `width` x `height` */
async function open({ locale = 'fr', width = 1280, height = 800, theme, phone = false, who = 'admin' } = {}) {
  const page = phone ? await h.newPhonePage({ locale }) : await h.newPage({ locale });
  if (!phone) await page.setViewportSize({ width, height });
  await h.session(page, who);
  await page.goto(h.url);
  await waitForApp(page);
  if (theme) await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  return page;
}
/** A sheet or a dialog has finished coming in (its animation would move it while it is measured) */
const settled = (page, selector = 'dialog[open]') => page.waitForFunction((sel) => {
  const el = document.querySelector(sel);
  return el && el.getAnimations({ subtree: true }).every((a) => a.playState === 'finished');
}, selector);
/** The screens of the administration, as their addresses name them (UX.md §4.3) */
const ADMIN_TABS = ['users', 'invitations', 'sso', 'lab', 'diagram', 'switches', 'sessions', 'audit', 'announcement'];
const go = async (page, route, ready) => {
  await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
  await page.waitForSelector(ready ?? `section.view-${route.split('/')[0]}:not([hidden]) h1`);
};

test('administration > users: the header row and the body share their columns', async () => {
  const page = await open();
  await go(page, 'admin/users');
  await page.waitForSelector('section.view-admin table.dl-table tbody tr td');
  const cols = await page.evaluate(() => {
    const table = document.querySelector('section.view-admin table.dl-table');
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

test('a phone: nothing overflows the page, five items in the tab bar, every section starts at its top', async () => {
  const page = await open({ phone: true });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.equal(await overflow(), 0, 'home');
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.tabbar');
    const r = el.getBoundingClientRect();
    return {
      bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height), sideways: el.scrollWidth - el.clientWidth,
      rail: getComputedStyle(document.querySelector('.rail')).display,
      items: [...el.querySelectorAll('[data-nav]')].map((a) => {
        const b = a.getBoundingClientRect();
        const label = a.querySelector('.rail-label').getBoundingClientRect();
        return { nav: a.dataset.nav, width: Math.round(b.width), height: Math.round(b.height), label: Math.round(label.height), cut: a.querySelector('.rail-label').scrollWidth > a.querySelector('.rail-label').clientWidth };
      }),
    };
  });
  assert.equal(bar.rail, 'none', 'no rail on a phone');
  assert.deepEqual({ bottom: bar.bottom, width: bar.width, sideways: bar.sideways }, { bottom: 844, width: 390, sideways: 0 }, 'the tab bar sits at the bottom, full width, and never scrolls sideways');
  assert.deepEqual(bar.items.map((i) => i.nav), ['home', 'consoles', 'team', 'jobs', 'plus'], 'exactly five items: Admin is in Plus');
  for (const item of bar.items) {
    assert.ok(item.width >= 44 && item.height >= 44, `${item.nav}: a 44 px target (${item.width} × ${item.height})`);
    assert.ok(item.label <= 18 && !item.cut, `${item.nav}: the label holds on one line`);
  }

  // Admin on a phone: #/admin is the hub (the list of the screens), each screen opens full height
  await go(page, 'admin');
  assert.equal(await page.locator('section.view-admin[data-mode="hub"] .admin-nav .admin-link').count(), 12, 'the hub lists every screen of the administration');
  assert.equal(await overflow(), 0, 'the hub');
  for (const tab of ADMIN_TABS) {
    await go(page, `admin/${tab}`);
    await page.waitForSelector('section.view-admin[data-mode="tab"]');
    assert.equal(await overflow(), 0, `administration ${tab}`);
  }
  for (const route of ['jobs', 'team', 'status', 'help', 'account', 'home/lab', 'infra', 'consoles']) {
    await go(page, route);
    assert.equal(await overflow(), 0, route);
    // A long section scrolls inside itself: its heading is on screen, under nothing
    const heading = await page.evaluate((r) => {
      const h1 = document.querySelector(`section.view-${r} h1`).getBoundingClientRect();
      return { top: Math.round(h1.top), bottom: Math.round(h1.bottom), page: document.scrollingElement.scrollTop };
    }, route.split('/')[0]);
    assert.ok(heading.top >= 0 && heading.bottom < 844 - 56, `${route}: the heading is on screen (${heading.top}..${heading.bottom})`);
    assert.equal(heading.page, 0, `${route}: the page itself never scrolls`);
  }
  // The longest section scrolls to its end, and back to its top (on a phone the help's sections are folded: one is opened)
  await go(page, 'help/backup');
  const scrolled = await page.evaluate(() => {
    const view = document.querySelector('section.view-help');
    const scroller = [...view.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    scroller.scrollTop = scroller.scrollHeight;
    return { moved: scroller.scrollTop > 0, h1: Math.round(view.querySelector('h1').getBoundingClientRect().top) };
  });
  assert.ok(scrolled.moved, 'the help page scrolls');
  assert.ok(scrolled.h1 >= 0, 'its header stays where it is');

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
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a phone: Plus opens a sheet with the rest of the navigation and the account; Back closes it', async () => {
  const page = await open({ phone: true });
  await page.click('.tabbar [data-nav="plus"]');
  const sheet = page.locator('dialog[open] .plus-sheet');
  await sheet.waitFor();
  await settled(page);
  const box = await page.evaluate(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { bottom: Math.round(r.bottom), width: Math.round(r.width) }; });
  assert.deepEqual(box, { bottom: 844, width: 390 }, 'a bottom sheet, full width');
  assert.equal(await page.getAttribute('.tabbar [data-nav="plus"]', 'aria-expanded'), 'true');
  assert.deepEqual(await sheet.locator('.plus-rows [data-nav]').evaluateAll((rows) => rows.map((r) => r.dataset.nav)),
    ['admin', 'alerts', 'infra', 'status', 'help', 'account'], 'Admin first for an administrator, then Alertes and the sections out of the tab bar');
  assert.equal(await sheet.locator('.user-menu-name').textContent(), 'Ada Admin');
  const small = await sheet.locator('a, button').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim()));
  assert.deepEqual(small, [], 'every row and button of the sheet is a 44 px target');

  // Back closes the sheet and leaves the address alone
  const before = await page.evaluate(() => location.hash);
  await page.goBack();
  await sheet.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => location.hash), before);
  await page.waitForSelector('.tabbar [data-nav="plus"][aria-expanded="false"]');

  // A row leads to its section, which lights Plus
  await page.click('.tabbar [data-nav="plus"]');
  await sheet.locator('[data-nav="help"]').click();
  await page.waitForSelector('section.view-help:not([hidden]) h1');
  await sheet.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => location.hash), '#/help');
  assert.equal(await page.locator('.tabbar .active').getAttribute('data-nav'), 'plus');
  await page.goBack(); // the sheet left no entry behind: Back returns to the previous screen
  await page.waitForFunction((h) => location.hash === h, before);

  // Admin, from Plus: the administration's own list on a phone (#/admin is not redirected)
  await page.click('.tabbar [data-nav="plus"]');
  await sheet.locator('[data-nav="admin"]').click();
  await page.waitForSelector('section.view-admin:not([hidden]) h1');
  assert.equal(await page.evaluate(() => location.hash), '#/admin');

  // Theme and language from the sheet
  await page.click('.tabbar [data-nav="plus"]');
  await sheet.locator('[data-theme-choice="dark"]').click();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await sheet.locator('[data-theme-choice="light"]').click();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await setLanguage(page, 'en');
  assert.equal(await page.locator('.tabbar [data-nav="plus"] .rail-label').textContent(), 'More');
  await setLanguage(page, 'fr');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a phone: a dialog is a bottom sheet, Back and the scrim close it', async () => {
  const page = await open({ phone: true });
  const ask = () => page.evaluate(async () => {
    const { confirmDialog } = await window.appModule('/js/shared/dialog.js');
    window.__answer = 'pending';
    confirmDialog({ title: 'Libérer la baie B4M ?', body: 'Les consoles ouvertes seront fermées.', confirmLabel: 'Libérer' }).then((v) => { window.__answer = v; });
  });
  await ask();
  const dlg = page.locator('dialog.modal[open]');
  await dlg.waitFor();
  await settled(page);
  const m = await page.evaluate(() => {
    const d = document.querySelector('dialog.modal[open]').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('dialog.modal[open] .form-actions .btn')].map((b) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; });
    return { bottom: Math.round(d.bottom), width: Math.round(d.width), top: Math.round(d.top), buttons };
  });
  assert.deepEqual({ bottom: m.bottom, width: m.width }, { bottom: 844, width: 390 }, 'anchored at the bottom, full width');
  assert.ok(m.top > 400, `as tall as its content (top at ${m.top})`);
  assert.equal(m.buttons.length, 2);
  assert.ok(m.buttons.every((b) => b.height >= 48), 'large buttons');
  assert.equal(m.buttons[0].top, m.buttons[1].top, 'two short actions side by side');
  await page.goBack();
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__answer !== 'pending');
  assert.equal(await page.evaluate(() => window.__answer), false, 'Back answers no');

  await ask();
  await dlg.waitFor();
  await page.mouse.click(195, 100); // the scrim, above the sheet
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__answer !== 'pending');
  assert.equal(await page.evaluate(() => window.__answer), false, 'the scrim answers no');
  assert.equal(await page.evaluate(() => history.state?.sheet ?? null), null, 'no history entry is left behind');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the rail: five destinations and Plus, expanded from 1200 px and collapsible, collapsed below', async () => {
  const page = await open({ width: 1440, height: 900, who: 'student1' });
  const rail = () => page.evaluate(() => ({
    width: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
    items: [...document.querySelectorAll('#rail-items [data-nav]')].map((a) => a.dataset.nav),
  }));
  assert.deepEqual(await rail(), { width: 232, items: ['home', 'consoles', 'team', 'jobs', 'plus'] }, 'a student: four destinations and Plus');
  assert.equal(await page.locator('.tabbar').isVisible(), false);

  // Plus: a menu, from the keyboard
  await page.focus('.rail [data-nav="plus"]');
  await page.keyboard.press('Enter');
  const menu = page.locator('.menu-pop:has([role="menuitem"])');
  await menu.waitFor();
  assert.deepEqual(await menu.locator('[role="menuitem"]').evaluateAll((items) => items.map((i) => i.dataset.id)), ['infra', 'status', 'help']);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'infra', 'the first item has the focus');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'status');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.nav), 'plus', 'Escape gives the focus back');
  await page.keyboard.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForSelector('section.view-help:not([hidden]) h1');
  assert.equal(await page.locator('#rail-items .active').getAttribute('data-nav'), 'plus', 'a section of Plus lights Plus');

  // Collapsed by the person, and remembered
  await page.click('.rail-collapse');
  assert.equal((await rail()).width, 72);
  await page.reload();
  await waitForApp(page);
  assert.equal((await rail()).width, 72, 'the choice is remembered');
  await page.click('.rail-collapse');
  assert.equal((await rail()).width, 232);
  // A medium window: always collapsed, no toggle
  await page.setViewportSize({ width: 1024, height: 768 });
  assert.equal((await rail()).width, 72);
  assert.equal(await page.locator('.rail-collapse').isVisible(), false);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#rail-items .rail-label')].map((l) => ({ text: l.textContent, height: Math.round(l.getBoundingClientRect().height) })));
  assert.ok(labels.every((l) => l.height <= 16), `short labels on one line: ${JSON.stringify(labels)}`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the account menu: theme light / dark / auto and the language, from the keyboard', async () => {
  const page = await open({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const menu = await openAccountMenu(page);
  assert.equal(await page.getAttribute('.user-menu-btn', 'aria-expanded'), 'true');
  assert.equal(await menu.locator('[data-theme-choice="auto"]').getAttribute('aria-checked'), 'true', 'auto is the default');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', 'auto follows the system');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await menu.locator('[data-theme-choice="dark"]').click();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('labconsole.theme')), '"dark"');
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('user-menu-btn')), true, 'the focus is back on the button');
  await page.reload();
  await waitForApp(page);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', 'the choice survives a reload');
  await (await openAccountMenu(page)).locator('[data-theme-choice="auto"]').click();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('old addresses lead to the new ones without an extra history entry', async () => {
  const page = await open({ width: 1440, height: 900 });
  const visit = async (hash) => {
    await page.evaluate((x) => { location.hash = x; }, hash);
    await page.waitForFunction((x) => location.hash !== x, hash);
    return page.evaluate(() => location.hash);
  };
  const length = await page.evaluate(() => history.length);
  assert.equal(await visit('#/team'), '#/team/mine');
  assert.equal(await visit('#/admin'), '#/admin/users', 'from 720 px #/admin opens its first screen');
  assert.equal(await page.evaluate(() => history.length), length + 2, 'one entry per visit, none for the redirection');
  await page.waitForSelector('section.view-admin:not([hidden]) h1');
  assert.equal(await page.locator('#rail-items .active').getAttribute('data-nav'), 'admin');
  // An administrator's lab screens light Admin
  await go(page, 'status');
  assert.equal(await page.locator('#rail-items .active').getAttribute('data-nav'), 'admin');
  // The overview moved to the home page: its old address is replaced, and lights Home
  assert.equal(await visit('#/overview/free'), '#/home/lab/free');
  await page.waitForSelector('section.view-home:not([hidden]) h1');
  assert.equal(await page.locator('#rail-items .active').getAttribute('data-nav'), 'home', 'Le labo lights Home');
  await page.context().close();
});

for (const theme of ['light', 'dark']) {
  test(`text contrast is AA in every section (${theme} theme)`, async () => {
    const page = await open({ width: 1440, height: 900, theme });
    const routes = ['home', 'consoles', 'team', 'infra', 'jobs', 'status', 'help', 'account', 'admin'];
    const failures = [];
    for (const route of routes) {
      await go(page, route);
      failures.push(...(await contrastFailures(page, { within: `section.view-${route}` })).map((f) => ({ route, ...f })));
      failures.push(...(await tinyText(page, { within: `section.view-${route}` })).map((f) => ({ route, ...f })));
    }
    for (const tab of ADMIN_TABS) {
      await go(page, `admin/${tab}`);
      await page.waitForSelector(`section.view-admin [role="tabpanel"]:not([hidden]) > *`);
      failures.push(...(await contrastFailures(page, { within: 'section.view-admin' })).map((f) => ({ route: `admin ${tab}`, ...f })));
      failures.push(...(await tinyText(page, { within: 'section.view-admin' })).map((f) => ({ route: `admin ${tab}`, ...f })));
    }
    failures.push(...(await contrastFailures(page, { within: '.rail' })).map((f) => ({ route: 'rail', ...f })));
    failures.push(...(await tinyText(page, { within: '.rail' })).map((f) => ({ route: 'rail', ...f })));
    await openAccountMenu(page);
    await settled(page, '#user-menu');
    failures.push(...(await contrastFailures(page, { within: '#user-menu' })).map((f) => ({ route: 'account menu', ...f })));
    await page.keyboard.press('Escape');
    await page.click('.rail [data-nav="plus"]');
    await page.waitForSelector('.menu-pop:has([role="menuitem"])');
    await settled(page, '.menu-pop:has([role="menuitem"])');
    failures.push(...(await contrastFailures(page, { within: '.menu-pop:has([role="menuitem"])' })).map((f) => ({ route: 'plus menu', ...f })));
    assert.deepEqual(failures, []);
    await page.context().close();
  });

  test(`the phone's tab bar and Plus sheet: AA contrast, nothing under 12 px (${theme} theme)`, async () => {
    const page = await open({ phone: true, theme });
    const failures = [];
    failures.push(...(await contrastFailures(page, { within: '.tabbar' })).map((f) => ({ where: 'tab bar', ...f })));
    failures.push(...(await tinyText(page, { within: '.tabbar' })).map((f) => ({ where: 'tab bar', ...f })));
    await page.click('.tabbar [data-nav="plus"]');
    await page.waitForSelector('dialog[open] .plus-sheet');
    await settled(page);
    failures.push(...(await contrastFailures(page, { within: 'dialog[open]' })).map((f) => ({ where: 'plus sheet', ...f })));
    failures.push(...(await tinyText(page, { within: 'dialog[open]' })).map((f) => ({ where: 'plus sheet', ...f })));
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
  for (const route of ['home', 'consoles', 'team', 'infra', 'admin', 'jobs', 'status', 'account', 'help']) {
    await go(page, route);
    if (route !== 'home') await page.waitForFunction((r) => document.activeElement.closest('section')?.classList.contains(`view-${r}`), route);
    titles[route] = await page.title();
  }
  assert.equal(new Set(Object.values(titles)).size, 9, 'one title per section');
  assert.match(titles.admin, /^Administration · Lab Console$/);
  await page.waitForFunction(() => document.activeElement.tagName === 'H1'); // the router focuses the heading once the section is shown
  assert.equal(await page.evaluate(() => document.activeElement.closest('section').className), 'view view-help', 'the heading of the new section has the focus');
  await setLanguage(page, 'en');
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
  await go(page, 'admin/lab');
  await page.waitForSelector('#lab-consoles-portRange-max');
  assert.equal(await page.getAttribute('#lab-consoles-portRange-max', 'aria-label'), 'Port maximal');
  const unnamedNow = () => page.evaluate(() => [
    ...[...document.querySelectorAll('section.view-admin th')].filter((th) => th.getBoundingClientRect().width && !th.textContent.trim()).map((th) => `th ${th.dataset.col ?? '?'}`),
    ...[...document.querySelectorAll('section.view-admin input')].filter((i) => i.getBoundingClientRect().width && i.type !== 'hidden' && !i.labels?.length && !i.getAttribute('aria-label') && !i.title).map((i) => `input ${i.id || i.name}`),
  ]);
  const unnamed = [];
  for (const tab of ADMIN_TABS) {
    await go(page, `admin/${tab}`);
    // a tab fills its table once its data has arrived: give it a moment, then report what is still unnamed
    await page.waitForFunction(() => document.querySelector('section.view-admin [role="tabpanel"]:not([hidden])')?.children.length).catch(() => {});
    unnamed.push(...await unnamedNow());
  }
  assert.deepEqual(unnamed, []);
  await page.context().close();
});
