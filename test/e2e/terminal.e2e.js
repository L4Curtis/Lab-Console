/**
 * The terminal tools in real browsers, against a simulated lab whose devices
 * are slow (a 9600-baud console that drops what arrives too fast):
 *   - a multi-line paste is paced by the server, a spectator's is not sent,
 *     a one-line paste is typed as usual;
 *   - the same lines are sent to several consoles at once, only the ones the
 *     person holds the keyboard of, each with its own result;
 *   - the inject dialog takes a script from the library, and keeps one in it;
 *   - the history of a console is searched and downloaded.
 * Each scenario uses its own consoles: the simulated devices keep their state
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, openConsole, typeInConsole, waitForTerminal, terminalText } from './harness.js';

const h = useHarness({ oidc: false, mockLab: { slowConsole: true } });

async function signedIn(who, bench) {
  const page = await h.newPage();
  await h.session(page, who);
  await page.goto(`${h.url}/#/consoles/${bench}`);
  await page.waitForSelector('section.view-consoles g.device');
  if (await page.locator('.journal-notice').isVisible()) await page.click('.journal-notice button.icon-btn');
  return page;
}

const action = (pane, name) => pane.locator(`.pane-custom-actions button[data-action="${name}"]`);
const taskBar = (pane) => pane.locator('.pane-task');
const toast = (page, text) => page.locator('.toast', { hasText: text });

/** Paste `text` into a console the way the browser does: a paste event on the terminal's own input */
const paste = (pane, text) => pane.locator('.xterm-helper-textarea').evaluate((textarea, value) => {
  const data = new DataTransfer();
  data.setData('text/plain', value);
  textarea.focus();
  textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, text);

/** A request made by the page itself */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

/** Open a console someone else already has open: the line is logged in already */
async function join(page, bench, device) {
  const pane = await openConsole(page, bench, device, { login: false });
  await waitForTerminal(pane, new RegExp(`${device}[>#]`));
  return pane;
}

const CONFIG = [
  'enable', 'configure terminal', 'hostname PASTED', 'interface loopback 10', ' description pasted',
  ' ip address 10.10.10.1 255.255.255.255', ' no shutdown', 'exit', 'interface loopback 11', ' description second',
  ' ip address 10.10.11.1 255.255.255.255', ' no shutdown', 'end',
].join('\n');

test('a multi-line paste is paced by the server and reaches every line; a spectator\'s paste is not sent; a one-line paste is typed', async () => {
  const alice = await signedIn('alice', 'B4M');
  const pane = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);

  // One line: the terminal types it, nothing more (no Enter)
  await paste(pane, 'show clock');
  await waitForTerminal(pane, /^R1>show clock$/m);
  assert.equal(await taskBar(pane).isVisible(), false, 'no task for a single line');
  await pane.page().keyboard.press('Control+U');
  await pane.page().keyboard.press('Enter');

  // Several lines: handed to the server, shown as a task, run line by line
  await paste(pane, `${CONFIG}\n`);
  await taskBar(pane).filter({ hasText: /Lignes envoyées : 13 sur 13/ }).waitFor();
  await waitForTerminal(pane, /PASTED#/);
  const device = h.lab.device('10.22.9.211:2013');
  assert.equal(device.cfg.hostname, 'PASTED');
  assert.deepEqual(device.cfg.interfaces.get('Loopback11').lines, ['description second', 'ip address 10.10.11.1 255.255.255.255'], 'the last interface made it: nothing was dropped');
  assert.equal(device.dropped, 0);

  // A spectator pastes: nothing reaches the device, and she is told why
  const bilal = await signedIn('bilal', 'B4M');
  const watching = await join(bilal, 'B4M', 'R1');
  await bilal.waitForFunction((el) => el.dataset.role === 'spectator', await watching.elementHandle());
  await paste(watching, 'hostname WATCHER\nshow clock\n');
  await toast(bilal, 'demandez la main pour taper').waitFor();
  await typeInConsole(pane, '');
  await typeInConsole(pane, 'show clock');
  await waitForTerminal(watching, /^PASTED#show clock$/m); // later output reached her: the paste would have shown before it
  assert.equal(device.cfg.hostname, 'PASTED');
  assert.doesNotMatch(await terminalText(pane), /WATCHER/);
  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bilal.errors, []);

  // The history: what the console showed, as text, and a file to keep
  await action(pane, 'history').click();
  const dialog = alice.locator('dialog.modal[open]');
  await dialog.locator('input[type="search"]').fill('description second');
  await dialog.locator('button[data-action="search"]').click();
  const hit = dialog.locator('section[data-source="screen"] .hist-matches li', { hasText: 'description second' });
  await hit.first().waitFor();
  assert.ok(await hit.first().locator('mark').count() > 0, 'the match is marked');
  assert.match(await dialog.locator('section[data-source="screen"] .hist-count').textContent(), /lignes? trouvée/);
  const [download] = await Promise.all([
    alice.waitForEvent('download'),
    dialog.locator('section[data-source="screen"] a[data-action="download-screen"]').click(),
  ]);
  assert.match(download.suggestedFilename(), /^history_B4M_R1_\d{8}_\d{4}\.txt$/);
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(await download.path(), 'utf8');
  assert.match(text, /description second/);
  assert.doesNotMatch(text, /\x1b/);
  // The journal of the day is there too, once it has been written
  await dialog.locator('section[data-source="journal"] a[data-action="download-day"]').waitFor();
  await alice.keyboard.press('Escape');

  await bilal.context().close();
  await alice.context().close();
});

test('the same lines go to every console the person holds the keyboard of, each with its own result; the one they only watch is refused', async () => {
  const alice = await signedIn('alice', 'B6B');
  const first = await openConsole(alice, 'B6B', 'R1');
  await typeInConsole(first, '');
  await waitForTerminal(first, /^R1>$/m);
  const second = await openConsole(alice, 'B6B', 'R2');
  await typeInConsole(second, '');
  await waitForTerminal(second, /^R2>$/m);

  // Bilal holds the keyboard of R3; Alice only watches it
  const bilal = await signedIn('bilal', 'B6B');
  const theirs = await openConsole(bilal, 'B6B', 'R3');
  await typeInConsole(theirs, '');
  await waitForTerminal(theirs, /^R3>$/m);
  const watched = await join(alice, 'B6B', 'R3');
  await alice.waitForFunction((el) => el.dataset.role === 'spectator', await watched.elementHandle());
  assert.equal(await action(watched, 'broadcast').isDisabled(), true, 'not offered from a console she does not pilot');

  await action(first, 'broadcast').click();
  const dialog = alice.locator('dialog.modal[open]');
  await dialog.getByRole('heading', { name: 'Envoyer à plusieurs consoles' }).waitFor();
  const targets = dialog.locator('.bc-target');
  assert.equal(await targets.count(), 3);
  assert.deepEqual(await targets.locator('input').evaluateAll((boxes) => boxes.map((b) => [b.checked, b.disabled])), [[true, false], [true, false], [false, true]]);
  assert.match(await targets.nth(2).textContent(), /R3.*vous n’avez pas la main/s);

  const send = dialog.locator('button[data-action="send"]');
  assert.equal(await send.isDisabled(), true, 'nothing to send yet');
  await dialog.locator('textarea').fill('show clock\nshow ip interface brief');
  assert.equal((await send.textContent()).trim(), 'Envoyer à 2 consoles');
  await send.click();

  const results = dialog.locator('.bc-result');
  await dialog.locator('.bc-summary', { hasText: '2 consoles : 2 sans erreur' }).waitFor().catch(async (err) => { throw new Error(`${err.message}\n${await dialog.innerText()}`); });
  assert.equal(await results.count(), 2);
  for (const name of ['R1', 'R2']) {
    const row = results.filter({ hasText: new RegExp(`^${name}`) });
    assert.match(await row.textContent(), /Lignes envoyées : 2 sur 2/);
  }
  await waitForTerminal(first, /^Serial0\/0\/1 +unassigned.*\nR1>$/m);
  await waitForTerminal(second, /^Serial0\/0\/1 +unassigned.*\nR2>$/m);
  assert.doesNotMatch(await terminalText(theirs), /show clock/, 'the console of the other pilot saw nothing');
  await dialog.locator('button[data-action="close"]').click();

  // The server decides, not the page: a request sent to the console she only watches comes back refused
  await alice.evaluate(async () => {
    const { workspace } = await import('/js/shared/workspace.js');
    const pane = [...workspace.panes.values()].find((p) => p.session.title === 'R3');
    pane.sendBroadcast({ batch: 'forced', script: 'show clock\n', options: {} });
  });
  await taskBar(watched).filter({ hasText: /Vous n’avez pas la main sur R3/ }).waitFor();
  await typeInConsole(theirs, 'show users');
  await waitForTerminal(theirs, /R3>show users/);
  assert.doesNotMatch(await terminalText(theirs), /show clock/);
  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bilal.errors, []);
  await alice.context().close();
  await bilal.context().close();
});

test('the inject dialog takes a script from the library and keeps one in it; someone else\'s personal script is not offered', async () => {
  const ada = await signedIn('ada', 'B4M');
  assert.equal((await api(ada, 'POST', '/api/scripts', { scope: 'published', title: 'Bouclage', description: 'Une interface de bouclage', body: 'enable\nconfigure terminal\nhostname LIBRARY\ninterface loopback 20\n ip address 10.20.20.1 255.255.255.255\nend\n' })).status, 201);
  const bilal = await signedIn('bilal', 'B4M');
  assert.equal((await api(bilal, 'POST', '/api/scripts', { scope: 'personal', title: 'Secret de Bilal', body: 'show clock\n' })).status, 201);

  const alice = await signedIn('alice', 'B4M');
  const pane = await openConsole(alice, 'B4M', 'R3');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R3>$/m);
  await action(pane, 'inject').click();
  const inject = alice.locator('dialog.modal[open]');
  await inject.locator('button[data-action="library"]').click();

  // Over the inject dialog: the library, with what Alice may see
  const library = alice.locator('dialog.modal[open]').last();
  await library.getByRole('heading', { name: 'Choisir un script' }).waitFor();
  const item = library.locator('.lib-item', { hasText: 'Bouclage' });
  await item.waitFor();
  assert.match(await item.textContent(), /Une interface de bouclage/);
  assert.equal(await library.locator('.lib-item').count(), 1, 'someone else\'s personal script is not there');
  assert.equal(await item.locator('[data-action="delete"]').count(), 0, 'a published script is not hers to delete');
  await item.locator('[data-action="use"]').click();
  await inject.locator('.script-file', { hasText: 'Bibliothèque : Bouclage' }).waitFor();
  assert.match(await inject.locator('textarea').inputValue(), /^enable\nconfigure terminal\nhostname LIBRARY/);

  // She adds a line of her own and keeps the result under her own name
  await inject.locator('textarea').fill(`${await inject.locator('textarea').inputValue()}show interfaces loopback 20\n`);
  await inject.locator('button[data-action="keep"]').click();
  const save = alice.locator('dialog.modal[open]').last();
  await save.locator('input[name="title"]').fill('Bouclage 20 et contrôle');
  await save.locator('button[data-action="confirm"]').click();
  await toast(alice, 'est dans la bibliothèque').waitFor();
  const mine = (await api(alice, 'GET', '/api/scripts')).body.scripts;
  assert.deepEqual(mine.map((s) => `${s.scope}: ${s.title}`).sort(), ['personal: Bouclage 20 et contrôle', 'published: Bouclage']);
  assert.equal((await api(bilal, 'GET', '/api/scripts')).body.scripts.some((s) => s.title === 'Bouclage 20 et contrôle'), false, 'kept for herself only');

  // And it runs on the console
  await inject.locator('button[type="submit"]').click();
  await taskBar(pane).filter({ hasText: /Lignes envoyées : 7 sur 7/ }).waitFor();
  assert.equal(h.lab.device('10.22.9.211:2015').cfg.hostname, 'LIBRARY');

  // The section's own button manages the library: she deletes her script
  await alice.locator('section.view-consoles button[data-action="scripts"]').click();
  const manage = alice.locator('dialog.modal[open]');
  await manage.getByRole('heading', { name: 'Bibliothèque de scripts' }).waitFor();
  assert.equal(await manage.locator('[data-action="use"]').count(), 0, 'nothing to pick when only managing');
  await manage.locator('.lib-item', { hasText: 'Bouclage 20 et contrôle' }).locator('[data-action="delete"]').click();
  await alice.locator('dialog.modal[open]').last().locator('button[data-action="confirm"]').click();
  await manage.locator('.lib-item', { hasText: 'Bouclage 20' }).waitFor({ state: 'detached' });
  assert.equal((await api(alice, 'GET', '/api/scripts')).body.scripts.length, 1);
  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bilal.errors, []);
  await ada.context().close();
  await bilal.context().close();
  await alice.context().close();
});
