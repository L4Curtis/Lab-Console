/**
 * Wave 4 together, in a real browser on the mock lab (B4M, cabled as the
 * diagram draws it, one cable pulled out, R1 left locked by a console
 * password nobody knows):
 *   - Alice's team (Alice and Bilal) holds B4M; Alice runs the cabling check
 *     from the consoles' "Vérifications": the pulled cable is missing in the
 *     report and on the diagram's link;
 *   - she runs the line status: the overview's card of B4M shows the lines
 *     the check found free, and when it ran (checks lot → overview lot);
 *   - Bilal, her teammate, opens R1's console, sees "Password:", and walks
 *     through the password recovery from the console tile, while Alice's
 *     overview shows R1 open with a task on it; the help page describes the
 *     assistant he used (help lot, written at the integration)
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal } from './harness.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.1' } });

let device;
const SECRET = 'left-by-a-group';

/** A request made by the page itself (its session cookie, its origin) → { status, body } */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const checks = (page) => page.locator('dialog.modal[open].checks-modal');
const recovery = (page) => page.locator('dialog.modal[open] .recovery-dialog');

async function until(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Run one kind of check from the dialog and wait for its result */
async function runCheck(page, kind) {
  await page.evaluate(() => { location.hash = '#/consoles/B4M'; });
  await page.waitForFunction(() => document.querySelector('section.view-consoles .canvas-title')?.textContent === 'B4M');
  await page.locator('section.view-consoles button[data-action="checks"]').click();
  await checks(page).waitFor();
  const run = checks(page).locator(`button[data-action="${kind}"]`);
  await page.waitForFunction((el) => !el.disabled, await run.elementHandle());
  const before = await checks(page).locator(`.checks-result[data-kind="${kind}"]`).getAttribute('data-check').catch(() => null);
  await run.click();
  const result = checks(page).locator(`.checks-result[data-kind="${kind}"]${before ? `:not([data-check="${before}"])` : ''}`);
  await result.waitFor({ timeout: 90_000 });
  return result;
}

before(async () => {
  await h.ready;
  const lab = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M');
  device = (name) => { const d = lab.devices.find((x) => x.name === name); return { key: `${d.target.host}:${d.target.port}`, sim: h.lab.device(`${d.target.host}:${d.target.port}`) }; };
  // A cable pulled out: S1 Fa0/1 – S2 Fa0/1
  assert.ok(h.lab.cabling.unplug(device('S1').key, 'FastEthernet0/1'));
  // A group left R1 locked, saved, and switched it off and on: it now asks for the line password
  const r1 = device('R1').sim;
  r1.configure(['enable secret lost-secret', 'line con 0', ` password ${SECRET}`, ' login']);
  r1.save();
  r1.powerCycle();
  await until(() => ['pressreturn', 'idle', 'linepass', 'exec'].includes(r1.state) && !r1.inBoot, 'R1 to boot');
});

test('a team checks its cabling and its lines, sees them on the diagram and the overview, then a teammate recovers a locked router from its console tile', async () => {
  const r1 = device('R1').sim;

  // Alice and Bilal, one team, on B4M
  const alice = await h.newPage();
  await signInAs(alice, 'alice');
  const bilal = await h.newPage();
  await signInAs(bilal, 'bilal');
  assert.equal((await api(alice, 'POST', '/api/teams', { name: 'Les dépanneurs' })).status, 201);
  const team = (await api(alice, 'GET', '/api/teams')).body.mine;
  assert.equal((await api(alice, 'POST', `/api/teams/${team.id}/invitations`, { username: 'student2' })).status, 201);
  assert.equal((await api(bilal, 'POST', `/api/teams/${team.id}/accept`)).status, 200);
  assert.equal((await api(alice, 'POST', '/api/benches/B4M/take')).status, 200);

  // 1. The cabling check: the pulled cable is missing, in the report and on the diagram
  const cabling = await runCheck(alice, 'cabling');
  const pulled = cabling.locator('tr[data-link="S1-S2"], tr[data-link="S2-S1"]').filter({ hasText: 'Fa0/1' });
  assert.equal(await pulled.getAttribute('data-status'), 'missing');
  await checks(alice).locator('.modal-head button').click();
  const canvas = alice.locator('section.view-consoles .diagram-canvas');
  await canvas.locator('.edge[data-tone="cabling-missing"]').first().waitFor();

  // 2. The line status: R1 answers with a password prompt; the overview's card says what the check found
  const lines = await runCheck(alice, 'lines');
  assert.equal(await lines.locator('tr[data-device="R1"]').getAttribute('data-line'), 'free');
  assert.match(await lines.locator('tr[data-device="R1"]').textContent(), /demande un mot de passe/);
  const found = await lines.locator('tr[data-line="free"]').count();
  assert.ok(found >= 5, `${found} free lines`);
  await checks(alice).locator('.modal-head button').click();
  await alice.evaluate(() => { location.hash = '#/overview'; });
  const card = alice.locator('section.view-overview article.ov-card[data-bench="B4M"]');
  await card.locator('.ov-pill.free').waitFor();
  assert.match(await card.locator('.ov-pill.free').textContent(), new RegExp(`^${found} libres$`));
  assert.match(await card.locator('.ov-checked').textContent(), /^lignes vérifiées à \d{2}:\d{2}$/);
  assert.match(await card.locator('.ov-holder').textContent(), /Les dépanneurs/);

  // 3. Bilal, her teammate, finds R1 locked and opens the assistant from its console tile
  const pane = await openConsole(bilal, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /Password: ?$/m);
  await pane.locator('button[data-action="recovery"]').click();
  const dlg = recovery(bilal);
  await dlg.locator('button[data-action="start"]:not([disabled])').waitFor();
  await dlg.locator('select[name="family"]').selectOption('isr_g1');
  await dlg.locator('button[data-action="start"]').click();
  const power = dlg.locator('li[data-step="power_cycle"][data-state="awaiting"]');
  await power.waitFor();

  // Alice's overview follows: R1 is open, with a task on it; a check run meanwhile leaves R1 alone
  await card.locator('.ov-consoles li[data-device="R1"]', { hasText: /tâche en cours/ }).waitFor();
  const second = await api(alice, 'POST', '/api/checks/benches/B4M/cabling');
  assert.equal(second.status, 202, 'a check may start: it leaves R1, whose line is in use, alone');
  await until(() => !h.app.deps.services.checks.running('B4M'), 'the second check to end');
  const skipped = (await api(alice, 'GET', '/api/checks/benches/B4M')).body.results.cabling;
  assert.equal(skipped.devices.find((d) => d.name === 'R1').code, 'checks.line_in_use', 'nothing typed on the line under recovery');

  // He confirms, power-cycles when told, and follows every step to a clean prompt
  await power.locator('button[data-action="confirm"]').click();
  await dlg.locator('li[data-step="power_cycle"] .recovery-progress', { hasText: /maintenant/ }).waitFor({ timeout: 60_000 });
  r1.powerCycle();
  await waitForTerminal(pane, /rommon \d+ >/, { timeout: 60_000 });
  for (const step of ['confreg', 'boot', 'restore_register']) {
    const item = dlg.locator(`li[data-step="${step}"][data-state="awaiting"]`);
    await item.waitFor({ timeout: 90_000 });
    await item.locator('button[data-action="confirm"]').click();
    await dlg.locator(`li[data-step="${step}"][data-state="done"]`).waitFor({ timeout: 120_000 });
  }
  const end = dlg.locator('.recovery-end[data-end="done"]');
  await end.waitFor({ timeout: 60_000 });
  assert.match(await end.textContent(), /Router#/);
  assert.equal(r1.nextConfReg, '0x2102');
  assert.ok(r1.startup.blocks.find((b) => b.head === 'line con 0').lines.includes(`password ${SECRET}`), 'the startup-config is bypassed, not changed');

  // The help page describes what he used
  await bilal.evaluate(() => { location.hash = '#/help/recovery'; });
  const section = bilal.locator('section.view-help section.help-section[data-section="recovery"]');
  await section.waitFor();
  assert.match(await section.textContent(), /Récupération du mot de passe/);
  assert.match(await section.textContent(), /ni effacée ni modifiée/);

  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bilal.errors, []);
  await alice.context().close();
  await bilal.context().close();
});
