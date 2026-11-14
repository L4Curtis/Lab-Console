/**
 * Bench checks in a real browser, on the mock lab cabled as the diagram draws
 * B4M:
 *   - line status: Alice's team holds B4M; one line is held outside the
 *     application; the dialog lists free and busy lines and the diagram
 *     marks them; Bilal, who does not hold the bench, reads the line status
 *     but cannot run a check;
 *   - cabling: a cable pulled out and another plugged into the wrong port;
 *     the report says so link by link and the diagram colours those links
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs } from './harness.js';

const h = useHarness();

let target;
const dialog = (page) => page.locator('dialog.modal[open].checks-modal');

/** A request made by the page itself (its session cookie, its origin) → { status, body } */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

before(async () => {
  await h.ready;
  const lab = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M');
  target = (name) => { const d = lab.devices.find((x) => x.name === name); return { key: `${d.target.host}:${d.target.port}`, port: d.target.port }; };
});

/** `who` signed in, on the consoles of B4M, with the checks dialog open */
async function onChecks(who, { take = false } = {}) {
  const page = await h.newPage();
  await signInAs(page, who);
  if (take) {
    const team = await api(page, 'POST', '/api/teams', { name: 'Les câbleurs' });
    assert.ok([201, 409].includes(team.status), JSON.stringify(team.body));
    const taken = await api(page, 'POST', '/api/benches/B4M/take');
    assert.ok([200, 409].includes(taken.status), JSON.stringify(taken.body));
  }
  await page.evaluate(() => { location.hash = '#/consoles/B4M'; });
  await page.waitForFunction(() => document.querySelector('section.view-consoles .canvas-title')?.textContent === 'B4M');
  await page.locator('section.view-consoles button[data-action="checks"]').click();
  await dialog(page).waitFor();
  return page;
}

test('line status: free lines and a line held outside the application, in the dialog and on the diagram', async () => {
  h.lab.setBusy(target('R2').port);
  try {
    const page = await onChecks('alice', { take: true });
    const run = dialog(page).locator('button[data-action="lines"]');
    await page.waitForFunction((el) => !el.disabled, await run.elementHandle());
    await run.click();
    // Followed device by device, then the result
    const result = dialog(page).locator('.checks-result[data-kind="lines"]');
    await result.waitFor({ timeout: 60_000 });
    await result.locator('tr[data-device="R2"][data-line="busy"]').waitFor();
    assert.match(await result.locator('tr[data-device="R2"]').textContent(), /occupée hors de l’application/);
    assert.equal(await result.locator('tr[data-device="R1"]').getAttribute('data-line'), 'free');
    assert.match(await result.locator('tr[data-device="R1"]').textContent(), /libre/);
    // The check opened no line for good: nothing left open in the application
    assert.equal(h.app.deps.services.consoles.rooms.list().length, 0);

    // Too soon for another one
    const again = await api(page, 'POST', '/api/checks/benches/B4M/lines');
    assert.equal(again.status, 429);

    // On the diagram: a busy badge on R2, free ones elsewhere
    await dialog(page).locator('.modal-head button').click();
    const r2 = page.locator('section.view-consoles g.device', { has: page.locator('tspan.name', { hasText: /^R2$/ }) });
    await r2.locator('.deco-badge.badge-line-busy').waitFor();
    assert.ok(await page.locator('section.view-consoles .deco-badge.badge-line-free').count() >= 5);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  } finally {
    h.lab.setBusy(target('R2').port, false);
  }

  // Someone who does not hold the bench reads the line status but runs nothing
  const other = await onChecks('bilal');
  await dialog(other).locator('.checks-result[data-kind="lines"] tr[data-device="R2"][data-line="busy"]').waitFor();
  await dialog(other).locator('.checks-notice:not([hidden])').waitFor();
  for (const kind of ['lines', 'cabling', 'ping', 'interfaces']) assert.equal(await dialog(other).locator(`button[data-action="${kind}"]`).isDisabled(), true, kind);
  const refused = await api(other, 'POST', '/api/checks/benches/B4M/cabling');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'checks.not_occupant');
  assert.deepEqual(other.errors, []);
  await other.context().close();
});

test('cabling: a cable pulled out and one on the wrong port, in the report and on the diagram', async () => {
  const s1 = target('S1').key;
  assert.ok(h.lab.cabling.unplug(s1, 'FastEthernet0/1'), 'S1 Fa0/1 – S2 Fa0/1 pulled out');
  assert.ok(h.lab.cabling.move(s1, 'FastEthernet0/5', 'FastEthernet0/9'), 'S1 Fa0/5 – S4 moved to Fa0/9');

  const page = await onChecks('alice', { take: true });
  const run = dialog(page).locator('button[data-action="cabling"]');
  await page.waitForFunction((el) => !el.disabled, await run.elementHandle());
  await run.click();
  // While it runs: the devices, and a stop button
  await dialog(page).locator('.checks-current button[data-action="cancel"]').waitFor();
  const result = dialog(page).locator('.checks-result[data-kind="cabling"]');
  await result.waitFor({ timeout: 90_000 });

  const row = (a, b) => result.locator(`tr[data-link="${a}-${b}"], tr[data-link="${b}-${a}"]`);
  const missing = row('S1', 'S2').filter({ hasText: 'Fa0/1' });
  assert.equal(await missing.getAttribute('data-status'), 'missing');
  assert.match(await missing.textContent(), /manquant/);
  const moved = row('S1', 'S4').filter({ hasText: 'Fa0/5' });
  assert.equal(await moved.getAttribute('data-status'), 'wrong_port');
  assert.match(await moved.textContent(), /Fa0\/9/);
  assert.equal(await row('S2', 'S3').filter({ hasText: 'Fa0/5' }).getAttribute('data-status'), 'ok');
  assert.match(await result.locator('.checks-summary').textContent(), /1 sur un autre port/);

  // On the diagram: the links coloured by their verdict
  await dialog(page).locator('.modal-head button').click();
  const canvas = page.locator('section.view-consoles .diagram-canvas');
  await canvas.locator('.edge[data-tone="cabling-missing"]').first().waitFor();
  await canvas.locator('.edge[data-tone="cabling-wrong_port"]').first().waitFor();
  assert.ok(await canvas.locator('.edge[data-tone="cabling-ok"]').count() >= 5);
  // A device with a cabling problem is ringed
  const s1Tile = page.locator('section.view-consoles g.device', { has: page.locator('tspan.name', { hasText: /^S1$/ }) });
  await s1Tile.locator('.deco-ring.ring-check-bad').waitFor();

  // A reload: the result comes back from the server
  await page.reload();
  await page.waitForFunction(() => document.querySelector('section.view-consoles .canvas-title')?.textContent === 'B4M');
  await page.locator('section.view-consoles .edge[data-tone="cabling-missing"]').first().waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
