/**
 * The password recovery assistant in a real browser, on the mock lab: R1 of
 * B4M (a 2811) left with a console line password and an enable secret
 * nobody knows. Alice, whose team holds the bench, opens its console, then
 * the assistant from the tile, chooses the family and walks through every
 * step: she confirms she is at the device, power-cycles it when told (the
 * simulator stands in for her hands), the application sends BREAK into
 * ROMMON, sets 0x2142, boots, answers no to the dialog, puts 0x2102 back.
 * The device ends at a clean `Router#` with its startup-config untouched.
 * Bilal, who is not in her team, sees the badge but no Start button
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal } from './harness.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.1' } });

let r1;
const SECRET = 'left-by-a-group';

/** A request made by the page itself (its session cookie, its origin) → { status, body } */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const dialog = (page) => page.locator('dialog.modal[open] .recovery-dialog');

async function until(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  await h.ready;
  const lab = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M');
  const d = lab.devices.find((x) => x.name === 'R1');
  r1 = h.lab.device(`${d.target.host}:${d.target.port}`);
  // A group left it locked, saved, and switched it off and on: it now asks for the line password
  r1.configure(['enable secret lost-secret', 'line con 0', ` password ${SECRET}`, ' login']);
  r1.save();
  r1.powerCycle();
  await until(() => ['pressreturn', 'idle', 'linepass', 'exec'].includes(r1.state) && !r1.inBoot, 'R1 to boot');
});

test('a router locked by a console password, walked through the assistant from its console tile', async () => {
  const alice = await h.newPage();
  await signInAs(alice, 'alice');
  assert.ok([201, 409].includes((await api(alice, 'POST', '/api/teams', { name: 'Les récupérateurs' })).status));
  const taken = await api(alice, 'POST', '/api/benches/B4M/take');
  assert.ok([200, 409].includes(taken.status), JSON.stringify(taken.body));

  const pane = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /Password: ?$/m);

  // The assistant, from the tile
  await pane.locator('button[data-action="recovery"]').click();
  const dlg = dialog(alice);
  await dlg.locator('button[data-action="start"]:not([disabled])').waitFor();
  assert.match(await dlg.textContent(), /ni effacée ni modifiée/);
  await dlg.locator('select[name="family"]').selectOption('isr_g1');
  await dlg.locator('button[data-action="start"]').click();

  // The console is read first; then the power cycle waits for her
  const power = dlg.locator('li[data-step="power_cycle"][data-state="awaiting"]');
  await power.waitFor();
  assert.equal(await dlg.locator('li[data-step="look"]').getAttribute('data-state'), 'done');
  assert.match(await power.textContent(), /éteignez le routeur/);
  assert.equal(r1.powerCycles, 1, 'nothing happens before she confirms');

  // Bilal, outside her team, sees who is at it and cannot start anything
  const bilal = await h.newPage();
  await signInAs(bilal, 'bilal');
  const key = await alice.evaluate(() => document.querySelector('dialog.modal[open] .recovery-dialog').dataset.device);
  const seen = await api(bilal, 'GET', `/api/recovery/devices/${encodeURIComponent(key)}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.canStart, false);
  assert.equal(seen.body.refusal.code, 'recovery.not_occupant');
  assert.equal(seen.body.running.steps, undefined, 'he only learns who is at it');
  assert.equal((await api(bilal, 'POST', `/api/recovery/runs/${seen.body.running.id}/confirm`, { step: 'power_cycle' })).status, 403);
  await bilal.context().close();

  // She is at the device: confirm; the assistant tells her "now", she power-cycles
  await power.locator('button[data-action="confirm"]').click();
  await dlg.locator('li[data-step="power_cycle"] .recovery-progress', { hasText: /maintenant/ }).waitFor();
  r1.powerCycle();
  await waitForTerminal(pane, /rommon \d+ >/, { timeout: 60_000 });

  // Each following step waits for her confirmation, then runs
  for (const step of ['confreg', 'boot', 'restore_register']) {
    const item = dlg.locator(`li[data-step="${step}"][data-state="awaiting"]`);
    await item.waitFor({ timeout: 90_000 });
    await item.locator('button[data-action="confirm"]').click();
    await dlg.locator(`li[data-step="${step}"][data-state="done"]`).waitFor({ timeout: 120_000 });
  }

  // A clean prompt, the startup-config untouched, the register back to 0x2102
  const end = dlg.locator('.recovery-end[data-end="done"]');
  await end.waitFor({ timeout: 60_000 });
  assert.match(await end.textContent(), /Router#/);
  assert.equal(await end.locator('a[data-action="jobs"]').getAttribute('href'), '#/jobs/B4M');
  await waitForTerminal(pane, /^Router#\s*$/m);
  assert.equal(r1.nextConfReg, '0x2102');
  assert.ok(r1.startup.blocks.find((b) => b.head === 'line con 0').lines.includes(`password ${SECRET}`), 'the startup-config is bypassed, not changed');
  assert.deepEqual(alice.errors, []);
  await alice.context().close();
});
