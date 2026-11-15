/**
 * Versioned addresses of the front end (src/lib/assets.js): the browser asks
 * for the application's own scripts, stylesheets and dictionaries under
 * /v/<build id>/ only, keeps them for a year, and everything still works:
 * the sign-in page, the console, a section loaded later. A section whose
 * scripts are gone (a tab opened before a release) offers a reload
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, waitForApp } from './harness.js';

const h = useHarness();
const OWN = /^\/(?:js|css|locales)\//;

/** Every same-origin request of the page, with the answer's status and Cache-Control */
function recordRequests(page) {
  const seen = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.origin !== h.url) return;
    seen.push({ path: url.pathname, status: res.status(), cacheControl: res.headers()['cache-control'] });
  });
  return seen;
}

test('sign-in page, application and console load only versioned files of this release, and work', async () => {
  const page = await h.newPage();
  const seen = recordRequests(page);
  await page.goto(h.url);
  await page.waitForURL(/\/login$/);
  await signInAs(page, 'alice');
  await waitForApp(page);

  const pane = await openConsole(page, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);
  await typeInConsole(pane, 'show ip interface brief');
  await waitForTerminal(pane, /^FastEthernet0\/0 +unassigned [\s\S]*\nR1>$/m);
  // A section loaded later, with its own stylesheet and dictionary
  await page.goto(`${h.url}/#/team`);
  await page.waitForSelector('section.view-team h1');

  const prefix = h.app.assets.prefix;
  const unversioned = seen.filter((r) => OWN.test(r.path)).map((r) => r.path);
  assert.deepEqual(unversioned, [], 'the application asked for its own files without the prefix');
  const versioned = seen.filter((r) => r.path.startsWith('/v/'));
  for (const kind of ['/js/main.js', '/js/login.js', '/js/core/i18n.js', '/js/shared/terminalPane.js', '/js/modules/teams/index.js',
    '/css/app.css', '/css/login.css', '/css/consoles.css', '/css/teams.css', '/locales/fr/common.json', '/locales/fr/teams.json']) {
    assert.ok(versioned.some((r) => r.path === prefix + kind), `${prefix}${kind} was not loaded`);
  }
  for (const r of versioned) {
    assert.ok(r.path.startsWith(`${prefix}/`), `${r.path} is not of this release`);
    assert.equal(r.status, 200, r.path);
    assert.equal(r.cacheControl, 'private, max-age=31536000, immutable', r.path);
  }
  // Vendor files keep their own address
  assert.ok(seen.some((r) => r.path.startsWith('/vendor/xterm/')), 'xterm came from /vendor');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a section whose scripts are no longer served offers to reload the page, and the reload works', async () => {
  const page = await h.newPage();
  await h.session(page, 'student1');
  await page.goto(`${h.url}/#/home`);
  await waitForApp(page);
  // What an old tab meets after a release: its build id answers 404 (here, for one section's code)
  let gone = true;
  await page.route('**/v/*/js/modules/teams/index.js', (route) => (gone
    ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found","code":"server.not_found","params":{}}' })
    : route.continue()));
  await page.goto(`${h.url}/#/team`);
  const failure = page.locator('section.view-team .load-failure[role="alert"]');
  await failure.waitFor();
  assert.match(await failure.textContent(), /nouvelle version/);
  assert.ok(page.errors.some((e) => /\[team\]/.test(e)), 'the failure is reported on the console');
  page.errors.length = 0;

  gone = false;
  await Promise.all([page.waitForEvent('load'), failure.locator('button[data-action="reload"]').click()]);
  await page.waitForSelector('section.view-team h1');
  assert.equal(await page.locator('.load-failure').count(), 0);
  assert.deepEqual(page.errors.filter((e) => !/Failed to fetch dynamically imported module/.test(e)), []);
  await page.context().close();
});
