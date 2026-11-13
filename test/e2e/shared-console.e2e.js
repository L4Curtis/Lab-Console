/**
 * Shared consoles in two browsers: alice opens R1, bob joins and sees what
 * was already on screen, asks for the keyboard, alice gives it, bob types
 * and alice sees it. Then the lines that do not work, each with its own
 * message: refused by the console server (dead line), busy outside the
 * application (with "tell me when it is free"), and a silent device
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, openConsole, typeInConsole, waitForTerminal, terminalText, setLanguage } from './harness.js';

const R1 = '10.22.9.211:2013';
const h = useHarness({
  oidc: false,
  mockLab: {
    downPorts: [2014],                                 // B4M R2: the line is dead
    busyPorts: [2019],                                 // B4M S4: someone outside the application holds it
    devices: { '10.22.9.211:2015': { start: 'silent' } }, // B4M R3: powered off
  },
});

async function signedIn(who) {
  const page = await h.newPage();
  await h.session(page, who);
  await page.goto(`${h.url}/#/consoles/B4M`);
  await page.waitForSelector('section.view-consoles g.device');
  // The journal notice is shown once; out of the way for the scenario
  if (await page.locator('.journal-notice').isVisible()) {
    assert.match(await page.textContent('.journal-notice'), /journalisées/);
    await page.click('.journal-notice button.icon-btn');
  }
  return page;
}

/** Click a device on the diagram and wait until its tile has ended (refused lines) */
async function openFailing(page, device) {
  const tile = page.locator('section.view-consoles g.device', { has: page.locator('tspan.name', { hasText: new RegExp(`^${device}$`) }) });
  await tile.click();
  const pane = page.locator('article.pane.pane-console', { has: page.locator(`.pane-title strong:text-is("${device}")`) });
  await pane.waitFor();
  return pane;
}

test('alice opens R1, bob joins and sees the history, asks for the keyboard, alice gives it, bob types', async () => {
  const alice = await signedIn('alice');
  const paneA = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(paneA, '');
  await waitForTerminal(paneA, /^R1>$/m);
  await typeInConsole(paneA, 'show clock');
  await waitForTerminal(paneA, /^R1>show clock$/m);
  await alice.waitForFunction(() => document.querySelector('.pane-console .presence-status')?.textContent.includes('Vous avez la main'));

  const bob = await signedIn('bilal');
  // On bob's diagram, R1 is open by someone else, with alice's initials on it
  await bob.waitForSelector('g.device[data-state="live"] .deco-badge.badge-pilot');
  // Sessions opened by the test helper are "Student 1", "Student 2"…; the login is long done on this line
  const paneB = await openConsole(bob, 'B4M', 'R1', { login: false });
  await waitForTerminal(paneB, /^R1>show clock$/m); // the history, replayed
  await bob.waitForFunction(() => /Student 1 a la main/.test(document.querySelector('.pane-console .presence-status')?.textContent ?? ''));
  assert.equal(await paneB.getAttribute('data-role'), 'spectator');

  // A spectator's keys go nowhere
  await typeInConsole(paneB, 'reload');
  await paneB.locator('button[data-action="request"]').click();
  // Alice is asked, with a countdown, and gives the keyboard
  const prompt = paneA.locator('.presence-prompt');
  await prompt.waitFor();
  assert.match(await prompt.textContent(), /Student 2 demande la main/);
  assert.match(await prompt.textContent(), /elle passe dans \d+ s sans réponse/);
  await prompt.locator('button[data-action="grant"]').click();
  await bob.waitForFunction(() => document.querySelector('article.pane-console')?.dataset.role === 'pilot');
  await alice.waitForFunction(() => document.querySelector('article.pane-console')?.dataset.role === 'spectator');

  await typeInConsole(paneB, 'show users');
  await waitForTerminal(paneA, /^R1>show users$/m);
  assert.doesNotMatch(await terminalText(paneA), /reload/, 'bob\'s keys as a spectator never reached R1');
  assert.equal(h.lab.device(R1).cfg.hostname, 'R1');

  // The live panel lists the console with both people and the last command
  await alice.click('.live-btn');
  const row = alice.locator('.live-room', { hasText: 'R1' });
  await row.waitFor();
  await alice.waitForFunction(() => document.querySelector('.live-room .live-command')?.textContent === 'show users');
  assert.equal(await row.locator('.avatar').count(), 2);
  assert.match(await alice.textContent('.live-feed'), /a rejoint R1 \(B4M\)/);

  // The bench wall shows R1, read-only
  await alice.click('.wall-btn');
  await alice.waitForSelector('.wall-tile[data-target="10.22.9.211:2013"] .xterm-rows');
  await alice.waitForFunction(() => /show users/.test(document.querySelector('.wall-tile .xterm-rows')?.textContent ?? ''));
  await alice.keyboard.press('Escape');

  // A later lot adds a button to every console tile with one call (ARCHITECTURE §8)
  await alice.evaluate(async () => {
    const { registerPaneAction } = await import('/js/shared/paneActions.js');
    window.probeRuns = [];
    registerPaneAction({ id: 'probe', icon: 'check', title: () => 'Probe', when: (s) => s.kind === 'console', enabled: (pane) => pane.mayType, run: (pane) => window.probeRuns.push(pane.session.title) });
  });
  const probe = paneA.locator('button[data-action="probe"]');
  await probe.waitFor();
  assert.equal(await probe.isDisabled(), true, 'alice gave the keyboard away: the action is off for her');
  await paneA.locator('button[data-action="request"]').click();
  await paneB.locator('.presence-prompt button[data-action="grant"]').click();
  await alice.waitForFunction(() => !document.querySelector('button[data-action="probe"]').disabled);
  await probe.click();
  assert.deepEqual(await alice.evaluate(() => window.probeRuns), ['R1']);

  // English too
  await setLanguage(bob, 'en');
  await bob.waitForFunction(() => /Student 1 has the keyboard/.test(document.querySelector('.pane-console .presence-status')?.textContent ?? ''));

  // A later lot draws on the diagram with one call too, without holding the view (ARCHITECTURE §8)
  await alice.evaluate(async () => {
    const { registerDiagramLayer } = await import('/js/shared/diagramLayers.js');
    window.offProbeLayer = registerDiagramLayer('probe', (d) => (d.name === 'R2' ? { ring: 'probe', badges: [{ text: 'PR', kind: 'probe', title: 'probe' }] } : null));
  });
  await alice.waitForSelector('g.device .deco-badge.badge-probe');
  await alice.waitForSelector('g.device .deco-ring.ring-probe');
  assert.equal(await alice.locator('g.device[data-state="open"] .deco-badge.badge-pilot').count(), 1, 'presence is still drawn');
  await alice.evaluate(() => window.offProbeLayer());
  await alice.waitForFunction(() => !document.querySelector('.deco-badge.badge-probe'));

  // "Free the line" follows the task rule: on an unowned line anyone who may pilot sees it, not while a job runs
  await paneA.locator('button[data-action="release"]').click();
  const hangupB = paneB.locator('button[data-action="hangup"]');
  await hangupB.waitFor();
  const room = h.app.deps.services.consoles.rooms.get(R1);
  let finish;
  const job = room.runExclusive('system', 'backup', () => new Promise((resolve) => { finish = resolve; }));
  await bob.waitForFunction(() => /backup/.test(document.querySelector('.pane-console .presence-status')?.textContent ?? ''));
  assert.equal(await hangupB.count(), 0, 'a bystander cannot cut a job in half');
  assert.equal(await paneA.locator('button[data-action="hangup"]').count(), 0);
  finish('saved');
  assert.equal(await job, 'saved');
  await hangupB.waitFor();

  assert.deepEqual(alice.errors, []);
  assert.deepEqual(bob.errors, []);
  await alice.context().close();
  await bob.context().close();
});

test('a dead line, a line busy outside the application and a silent device each say what is wrong', async () => {
  const page = await signedIn('chloe');

  const dead = await openFailing(page, 'R2');
  await page.waitForFunction((el) => el.dataset.state === 'closed', await dead.elementHandle());
  assert.match(await dead.locator('.pane-banner').textContent(), /Le serveur de consoles refuse la ligne de R2/);

  const busy = await openFailing(page, 'S4');
  await page.waitForFunction((el) => el.dataset.state === 'closed', await busy.elementHandle());
  assert.match(await busy.locator('.pane-banner').textContent(), /quelqu’un y est connecté en dehors de Lab Console/);
  await page.waitForSelector('g.device[data-state="busy"]');
  // Tell me when it is free; then the person outside lets go
  await busy.locator('.pane-banner button', { hasText: 'Prévenez-moi quand elle est libre' }).click();
  await page.waitForSelector('.toast', { hasText: 'C’est noté' });
  const watches = await page.evaluate(() => fetch('/api/consoles/notify').then((r) => r.json()));
  assert.equal(watches.watches[0].device, 'S4');

  const silent = await openConsole(page, 'B4M', 'R3');
  await typeInConsole(silent, '');
  await page.waitForFunction((el) => el.dataset.silent === 'true', await silent.elementHandle(), { timeout: 15_000 });
  assert.equal(await silent.locator('.pane-status').textContent(), 'Équipement muet');
  await waitForTerminal(silent, /R3 ne répond pas/);

  assert.deepEqual(page.errors, []);
  await page.context().close();
});
