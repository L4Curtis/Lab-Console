/**
 * The consoles on a phone (docs/v2/UX.md §8.3, §9), on a touch screen of
 * 390 × 844:
 *   - the bench as a list; a device opens its console on the whole screen,
 *     at its own address, the tab bar hidden; the line field types a whole
 *     command; the key toolbar sends Tab (the device completes the word),
 *     Ctrl as a sticky modifier, the arrows; Back returns to the bench with
 *     the console still connected (the dock says so);
 *   - someone who only watches sees "Demander la main" and no field;
 *   - nothing overflows, the keys and the field are finger-sized, the
 *     terminal keeps at least 20 rows with the keyboard closed
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, openConsole, waitForTerminal, terminalText, waitForBench } from './harness.js';

const h = useHarness({ oidc: false });

async function onPhone(who, bench = 'B4M') {
  const page = await h.newPhonePage();
  await h.session(page, who);
  await page.goto(`${h.url}/#/consoles/${bench}`);
  await waitForBench(page, bench);
  return page;
}

const field = (page) => page.locator('.pane.solo .term-line');
const key = (page, id) => page.locator(`.pane.solo .term-key[data-key="${id}"]`);
const send = async (page, text) => {
  await field(page).fill(text);
  await page.locator('.pane.solo .term-send').click();
};

test('a phone opens R1 from the list, types with the line field and the key toolbar, and goes back to the bench with the console still open', async () => {
  const page = await onPhone('student1');
  // The list: one row per device, finger-sized
  await page.click('.cs-view [data-view="list"]');
  const rows = page.locator('.device-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 10);
  const row = await rows.first().boundingBox();
  assert.ok(row.height >= 64 && row.width <= 390, `a 64 px row (${row.width} × ${row.height})`);

  // A tap opens the console screen, at its own address, without the tab bar
  const pane = await openConsole(page, 'B4M', 'R1');
  await page.waitForFunction(() => location.hash === '#/consoles/B4M/R1');
  assert.equal(await page.locator('section.view-consoles').getAttribute('data-screen'), 'console');
  assert.equal(await page.locator('.tabbar').isVisible(), false, 'the console has the whole screen');
  assert.equal(await page.locator('.pane-head .pane-back').isVisible(), true);

  // The line field: a whole command at once (Enter wakes the line first)
  await send(page, '');
  await waitForTerminal(pane, /^R1>$/m);
  await send(page, 'show ip interface brief');
  const text = await waitForTerminal(pane, /^FastEthernet0\/0 +unassigned[\s\S]*\nR1>$/m);
  assert.match(text, /^R1>show ip interface brief$/m);
  assert.equal(await field(page).inputValue(), '', 'the field is cleared after sending');

  // Tab from the toolbar: the line so far, then Tab; the device completes the word
  await field(page).fill('sh');
  await key(page, 'tab').click();
  await waitForTerminal(pane, /^R1>show$/m); // "show ": the screen's rows are read without their trailing spaces
  assert.equal(await field(page).inputValue(), '', 'what was typed went to the device');
  await send(page, 'clock');
  await waitForTerminal(pane, /^R1>show clock\n.*\d{2}:\d{2}:\d{2}/m);

  // While the field holds text, the keys that would make it disagree with the device wait
  await field(page).fill('conf');
  assert.equal(await key(page, 'up').isDisabled(), true);
  assert.equal(await key(page, 'ctrlZ').isDisabled(), true);
  // Ctrl+C from the toolbar drops the field and interrupts the line
  await key(page, 'ctrlC').click();
  assert.equal(await field(page).inputValue(), '');
  await waitForTerminal(pane, /^R1>\^C\nR1>$/m);

  // Ctrl is sticky: pressed, then a letter typed in the field, it is Ctrl+that letter
  await send(page, 'enable');
  await waitForTerminal(pane, /^R1#$/m);
  await send(page, 'configure terminal');
  await waitForTerminal(pane, /^R1\(config\)#$/m);
  await key(page, 'ctrl').click();
  assert.equal(await key(page, 'ctrl').getAttribute('aria-pressed'), 'true');
  await field(page).focus();
  await page.keyboard.type('z');
  await waitForTerminal(pane, /^R1\(config\)#\^Z\nR1#$/m);
  assert.equal(await key(page, 'ctrl').getAttribute('aria-pressed'), 'false', 'used once, Ctrl lets go');
  assert.equal(await field(page).inputValue(), '', 'the letter went with Ctrl, not into the field');

  // Finger-sized keys and field, nothing sideways, room for the console
  const sizes = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const keys = [...document.querySelectorAll('.pane.solo .term-key')].slice(0, 6).map((k) => ({ w: Math.round(box(k).width), h: Math.round(box(k).height) }));
    const pane = [...document.querySelectorAll('.pane.solo')][0];
    return { keys, field: Math.round(box(document.querySelector('.pane.solo .term-line')).height), overflow: document.documentElement.scrollWidth - innerWidth, rows: pane.querySelector('.xterm-rows').children.length };
  });
  assert.ok(sizes.keys.every((k) => k.w >= 44 && k.h >= 44), JSON.stringify(sizes.keys));
  assert.ok(sizes.field >= 44, `the field is ${sizes.field} px high`);
  // What a first-year student needs most is in view without a swipe; the keys after it say a word, not a symbol
  const bar = await page.locator('.pane.solo .term-toolbar').boundingBox();
  for (const id of ['tab', 'help', 'ctrl', 'ctrlC', 'ctrlZ', 'up', 'down']) {
    const box = await key(page, id).boundingBox();
    assert.ok(box.x >= bar.x && box.x + box.width <= bar.x + bar.width + 0.5, `${id} is in view (${Math.round(box.x)} to ${Math.round(box.x + box.width)} of ${Math.round(bar.width)})`);
  }
  for (const id of ['break', 'space', 'paste', 'mode']) assert.ok((await key(page, id).textContent()).trim().length > 2, `${id} carries a word`);
  assert.equal(sizes.overflow, 0);
  assert.ok(sizes.rows >= 20, `${sizes.rows} rows of terminal with the keyboard closed`);

  // Back: the bench again, the console still connected, the dock leads back to it
  await page.locator('.pane-head .pane-back').click();
  await page.waitForFunction(() => location.hash === '#/consoles/B4M');
  await page.waitForFunction(() => !document.querySelector('section.view-consoles').dataset.screen);
  assert.equal(await page.locator('.tabbar').isVisible(), true);
  assert.equal(await pane.getAttribute('data-state'), 'connected');
  const dock = page.locator('.dock');
  await dock.waitFor();
  assert.match(await dock.textContent(), /R1.*1 console ouverte/);
  await dock.click();
  await page.waitForFunction(() => location.hash === '#/consoles/B4M/R1');
  assert.match(await terminalText(pane), /R1#/);
  // The browser's Back too
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#/consoles/B4M' && !document.querySelector('section.view-consoles').dataset.screen);

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a phone that only watches a console sees "Demander la main" and no field; asking works', async () => {
  const pilot = await onPhone('student2', 'B5M');
  const own = await openConsole(pilot, 'B5M', 'R1');
  await send(pilot, '');
  await waitForTerminal(own, /^R1>$/m);

  const watcher = await onPhone('student3', 'B5M');
  const pane = await openConsole(watcher, 'B5M', 'R1', { login: false });
  await watcher.waitForFunction((el) => el.dataset.role === 'spectator', await pane.elementHandle());
  const ask = watcher.locator('.pane.solo .term-ask');
  await ask.waitFor();
  assert.match(await ask.textContent(), /Demander la main/);
  assert.equal(await field(watcher).isVisible(), false, 'no field for someone who may not type');
  assert.equal(await watcher.locator('.pane.solo .term-toolbar').isVisible(), false);
  const box = await ask.boundingBox();
  assert.ok(box.height >= 48, `a 48 px button (${box.height})`);

  await ask.click();
  await watcher.waitForFunction(() => /Demande envoyée/.test(document.querySelector('.pane.solo .term-ask')?.textContent ?? ''));
  // The pilot is asked on her own phone, in the presence row, and gives the keyboard
  const prompt = pilot.locator('.pane.solo .presence-prompt');
  await prompt.waitFor();
  await prompt.locator('button[data-action="grant"]').click();
  await field(watcher).waitFor();
  await send(watcher, 'show clock');
  await waitForTerminal(own, /^R1>show clock$/m);

  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(watcher.errors, []);
  await pilot.context().close();
  await watcher.context().close();
});

test('the diagram on a phone: devices big enough to tap, a long press opens the device sheet', async () => {
  const page = await onPhone('admin', 'B4H');
  await page.click('.cs-view [data-view="diagram"]');
  const tiles = await page.evaluate(() => [...document.querySelectorAll('section.view-consoles g.device .device-tile')].map((t) => Math.round(Math.min(t.getBoundingClientRect().width, t.getBoundingClientRect().height))));
  assert.ok(tiles.length > 0 && tiles.every((s) => s >= 36), `device tiles on screen: ${tiles.join(', ')} px`);
  const hits = await page.evaluate(() => [...document.querySelectorAll('section.view-consoles g.device .device-hit')].map((t) => Math.round(Math.min(t.getBoundingClientRect().width, t.getBoundingClientRect().height))));
  assert.ok(hits.every((s) => s >= 44), `hit areas: ${hits.join(', ')} px`);

  // A long press on a row of the list: the device sheet, with what can be done (nothing opened)
  await page.click('.cs-view [data-view="list"]');
  const row = page.locator('.device-row[data-device="R2"]');
  await row.dispatchEvent('contextmenu'); // what a long press is to the browser (and a right click with a mouse)
  const sheet = page.locator('dialog[open] .device-sheet');
  await sheet.waitFor();
  assert.match(await page.locator('dialog[open] .modal-head h2').textContent(), /R2 · B4H/);
  assert.equal(await sheet.locator('button[data-action="open"]').isVisible(), true);
  assert.equal(await page.locator('article.pane').count(), 0, 'the console is not opened by the sheet itself');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a phone turned on its side keeps the console on the whole screen, turning back and forth, and after a direct load', async () => {
  const page = await onPhone('student1');
  await openConsole(page, 'B4M', 'R2');
  await page.waitForFunction(() => location.hash === '#/consoles/B4M/R2');
  const screen = () => page.locator('section.view-consoles').getAttribute('data-screen');

  // Turned: 844 × 390 is a short touch screen, compact like the upright phone; the console keeps the screen
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => document.querySelector('section.view-consoles').dataset.screen === 'console');
  assert.equal(await page.locator('.tabbar').isVisible(), false, 'no tab bar over a console');
  assert.equal(await page.locator('.rotate-hint').isVisible(), false, 'nothing asks to turn a phone that is turned');
  assert.equal(await field(page).isVisible(), true, 'the line field and the keys are there');
  const area = await page.locator('.pane.solo .pane-body').boundingBox();
  assert.ok(area.height >= 150, `the terminal keeps ${area.height} px of 390`);
  assert.ok(area.width >= 800, 'and the whole width');

  // Upright again, then turned again: still the console
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('section.view-consoles').dataset.screen === 'console');
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await screen(), 'console');
  assert.equal(await page.evaluate(() => location.hash), '#/consoles/B4M/R2');

  // A direct load of the address, turned
  await page.reload();
  await page.waitForFunction(() => document.querySelector('section.view-consoles')?.dataset.screen === 'console');
  await page.locator('.pane.solo').waitFor();

  // Back to the bench: its screen, with no journal notice, a slim tab bar, and room for the diagram
  await page.locator('.pane-head .pane-back').click();
  await page.waitForFunction(() => !document.querySelector('section.view-consoles').dataset.screen);
  assert.equal(await page.locator('.cs-notice').isVisible(), false);
  assert.equal(await page.locator('.tabbar').isVisible(), true);
  await page.click('.cs-view [data-view="diagram"]');
  const canvas = await page.locator('.diagram-canvas').boundingBox();
  assert.ok(canvas.height >= 150, `the diagram keeps ${canvas.height} px of 390`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a phone opens the bench as a list until it chooses a view; the journal notice and the turn-your-phone line show once', async () => {
  const page = await onPhone('student1');
  const pressed = (view) => page.locator(`.cs-view [data-view="${view}"]`).getAttribute('aria-pressed');
  await page.locator('.device-row').first().waitFor();
  assert.equal(await pressed('list'), 'true', 'Liste, not a diagram that runs off the screen');
  assert.equal(await pressed('diagram'), 'false');
  assert.equal(await page.locator('.cs-notice').isVisible(), true, 'the journal notice, the first time');

  // The next visit: the notice is gone for good, the view is still the default one
  await page.reload();
  await waitForBench(page, 'B4M');
  assert.equal(await page.locator('.cs-notice').isVisible(), false, 'shown once per browser');
  assert.equal(await pressed('list'), 'true');

  // The line about turning the phone: once, on the first console opened upright
  await openConsole(page, 'B4M', 'R3');
  assert.equal(await page.locator('.rotate-hint').isVisible(), true);
  await page.locator('.pane-head .pane-back').click();
  await page.locator('.device-row[data-device="R4"]').click();
  await page.waitForFunction(() => location.hash === '#/consoles/B4M/R4');
  await page.reload();
  await page.locator('.pane.solo').waitFor();
  assert.equal(await page.locator('.rotate-hint').isVisible(), false, 'not again after a visit');

  // A view chosen is a view kept
  await page.locator('.pane-head .pane-back').click();
  await page.click('.cs-view [data-view="diagram"]');
  await page.reload();
  await waitForBench(page, 'B4M');
  assert.equal(await pressed('diagram'), 'true');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('on a laptop a diagram column too narrow to read shows the list, until a view is chosen', async () => {
  const page = await h.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await h.session(page, 'student1');
  await page.goto(`${h.url}/#/consoles/B4M`);
  await waitForBench(page, 'B4M');
  const pressed = (view) => page.locator(`.cs-view [data-view="${view}"]`).getAttribute('aria-pressed');
  assert.equal(await pressed('diagram'), 'true', 'the whole width: the diagram');
  const pane = await openConsole(page, 'B4M', 'R5');
  await page.waitForFunction(() => document.querySelector('.cs-view [data-view="list"]').getAttribute('aria-pressed') === 'true');
  const width = await page.locator('.diagram-pane').evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(width < 400, `the column is ${width} px`);
  assert.equal(await page.locator('.device-list').isVisible(), true);

  // Asking for the diagram is a choice: it stays, narrow as it is
  await page.click('.cs-view [data-view="diagram"]');
  await pane.locator('.xterm').first().waitFor();
  await page.locator('section.view-consoles g.device').first().waitFor();
  assert.equal(await pressed('diagram'), 'true');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a column of 400 px or more beside an open console never fits the diagram under 70 %', async () => {
  const page = await h.newPage(); // 1440 px: the column is about 410 px with a console open
  await h.session(page, 'student1');
  await page.goto(`${h.url}/#/consoles/B4M`);
  await waitForBench(page, 'B4M');
  await openConsole(page, 'B4M', 'S1');
  await page.locator('section.view-consoles g.device').first().waitFor();
  const width = await page.locator('.diagram-pane').evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(width >= 400, `the column is ${width} px`);
  const zoom = Number.parseInt(await page.locator('.zoom-level').textContent(), 10);
  assert.ok(zoom >= 70, `the diagram is fitted at ${zoom} %`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Outils › Mur de consoles says why it is off while no console is open, and nothing once one is', async () => {
  const page = await h.newPage();
  await h.session(page, 'student2');
  await page.goto(`${h.url}/#/consoles/B4H`);
  await waitForBench(page, 'B4H');
  const wall = () => page.locator('.menu-pop [role^="menuitem"][data-id="wall"]');
  await page.locator('section.view-consoles .tools-btn').click();
  assert.equal(await wall().getAttribute('aria-disabled'), 'true');
  assert.match(await wall().textContent(), /Aucune console de cette baie n’est ouverte/);
  await page.keyboard.press('Escape');
  await openConsole(page, 'B4H', 'S1');
  await page.locator('section.view-consoles .tools-btn').click();
  await wall().waitFor();
  assert.equal(await wall().getAttribute('aria-disabled'), null);
  assert.doesNotMatch(await wall().textContent(), /Aucune console/, 'enabled: no sentence that says it is off');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
