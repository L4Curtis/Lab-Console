/**
 * What only the wave 2 lots together allow, in real browsers:
 *   - a student of the team that holds a bench pilots one of its consoles
 *     while an outsider joins it to watch, and cannot type;
 *   - a locked bench refuses to open its consoles, in the page and on the
 *     server, a console line it shares with a free bench included;
 *   - an invited newcomer signs up, is invited into a team by user name and
 *     lands in it
 * Each scenario sets up the teams and benches it needs, and gives them back
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, terminalText, waitForApp } from './harness.js';
import { invite, PASSWORD } from '../helpers/accounts.js';

const h = useHarness();

const bar = (page) => page.locator('section.view-consoles .bench-bar');
const toastWith = (page, text) => page.locator('.toast', { hasText: text });
const deviceTile = (page, name) => page.locator('section.view-consoles g.device', { has: page.locator('tspan.name', { hasText: new RegExp(`^${name}$`) }) });

/** A request made by the page itself (its session cookie, its origin) → { status, body } */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

/** Open a console WebSocket from the page and return the first error frame's code (or 'open') */
const socketAnswer = (page, key) => page.evaluate((device) => new Promise((resolve) => {
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/console?device=${encodeURIComponent(device)}&cols=80&rows=24`);
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const frame = JSON.parse(e.data);
    if (frame.type === 'error') { resolve(frame.code); ws.close(); }
    if (frame.type === 'replay') { resolve('open'); ws.close(); }
  };
  ws.onclose = () => resolve('closed');
}), key);

test('a member of the team holding B4M pilots R1; an outsider joins to watch and cannot type, nor open another line of B4M', async () => {
  const alice = await h.newPage();
  await signInAs(alice, 'alice');
  assert.equal((await api(alice, 'POST', '/api/teams', { name: 'Les commutateurs' })).status, 201);
  assert.equal((await api(alice, 'POST', '/api/benches/B4M/take')).status, 200);

  const pane = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);
  await typeInConsole(pane, 'show clock');
  await waitForTerminal(pane, /^R1>show clock$/m);

  const chloe = await h.newPage();
  await signInAs(chloe, 'chloe');
  await chloe.evaluate(() => { location.hash = '#/consoles/B4M'; });
  await bar(chloe).locator('.bench-status', { hasText: 'Les commutateurs' }).waitFor();
  // R1 is open: anyone may watch it, the page lets her in
  await chloe.waitForSelector('section.view-consoles g.device[data-state="live"]');
  await deviceTile(chloe, 'R1').click();
  const watching = chloe.locator('article.pane.pane-console', { has: chloe.locator('.pane-title strong:text-is("R1")') });
  await watching.waitFor();
  await waitForTerminal(watching, /^R1>show clock$/m); // what was on screen, replayed
  await chloe.waitForFunction((el) => el.dataset.role === 'spectator', await watching.elementHandle());
  await typeInConsole(watching, 'reload');
  await typeInConsole(pane, 'show users');
  await waitForTerminal(watching, /^R1>show users$/m);
  assert.doesNotMatch(await terminalText(pane), /reload/, 'the outsider\'s keys never reach the device');

  // R2 is not open: opening it needs the right to pilot, which she has not on a bench another team holds
  await deviceTile(chloe, 'R2').click();
  await toastWith(chloe, 'occupée par une autre équipe').waitFor();
  const r2 = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M').devices.find((d) => d.name === 'R2');
  assert.equal(await socketAnswer(chloe, r2.key), 'consoles.open_not_allowed', 'the server refuses it too');

  assert.deepEqual(alice.errors, []);
  assert.deepEqual(chloe.errors, []);
  await alice.context().close();
  await chloe.context().close();
});

test('a locked bench refuses to open its consoles, a line it shares with a free bench included: in the page and on the server; an admin still opens them', async () => {
  const ada = await h.newPage();
  await signInAs(ada, 'ada');
  assert.equal((await api(ada, 'PUT', '/api/benches/B5H/lock', { reason: 'Examen en cours' })).status, 200);

  const bilal = await h.newPage();
  await signInAs(bilal, 'bilal');
  await bilal.evaluate(() => { location.hash = '#/consoles/B5H'; });
  await bar(bilal).locator('.bench-lock', { hasText: 'Examen en cours' }).waitFor();
  const first = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B5H').devices[0];
  await deviceTile(bilal, first.name).click();
  await toastWith(bilal, 'verrouill').waitFor();
  assert.equal(await bilal.locator('article.pane.pane-console').count(), 0, 'no console opened');
  assert.equal(await socketAnswer(bilal, first.key), 'consoles.open_not_allowed');

  // R5 of B5H is the same console line as R5 of B4B, a free bench: the lock still closes it
  const labs = h.app.deps.services.consoles.registry.model.labs;
  const shared = labs.find((l) => l.name === 'B5H').devices.find((d) => d.name === 'R5');
  assert.ok(labs.find((l) => l.name === 'B4B').devices.some((d) => d.target.host === shared.target.host && d.target.port === shared.target.port), 'R5 is shared with B4B');
  assert.equal(h.app.deps.services.benches.holder('B4B'), null, 'B4B is free');
  await deviceTile(bilal, 'R5').click();
  await toastWith(bilal, 'verrouill').first().waitFor();
  assert.equal(await bilal.locator('article.pane.pane-console').count(), 0, 'no console opened');
  assert.equal(await socketAnswer(bilal, shared.key), 'consoles.open_not_allowed', 'the server refuses the shared line too');

  assert.equal(await socketAnswer(ada, first.key), 'open', 'admins work on locked benches');
  assert.equal(await socketAnswer(ada, shared.key), 'open');
  assert.equal((await api(ada, 'DELETE', '/api/benches/B5H/lock')).status, 200);
  assert.deepEqual(bilal.errors, []);
  await ada.context().close();
  await bilal.context().close();
});

test('an invited newcomer signs up, is invited into a team by user name, accepts and lands in it', async () => {
  // Bilal makes a team of his own and takes a free bench for it: nothing comes from another scenario
  const bilal = await h.newPage();
  await signInAs(bilal, 'bilal');
  assert.equal((await api(bilal, 'POST', '/api/teams', { name: 'Les routeurs' })).status, 201);
  assert.equal((await api(bilal, 'POST', '/api/benches/B6H/take')).status, 200);
  await bilal.click('#rail-items a[href="#/team"]');
  const inviteForm = bilal.locator('section.view-team form.team-form', { has: bilal.locator('input[name="username"]') });
  await inviteForm.waitFor();

  // Nobody is called nadia yet: the directory does not know the name
  await inviteForm.locator('input[name="username"]').fill('nadia');
  await inviteForm.locator('button[data-action="invite"]').click();
  await toastWith(bilal, 'Personne ne se connecte ici avec ce nom').waitFor();

  // An administrator's invitation link; Nadia creates her account with it
  const { url } = await invite(h.app, { note: 'Nadia' });
  const nadia = await h.newPage();
  await nadia.goto(url);
  await nadia.waitForSelector('#join-box:not([hidden])');
  await nadia.fill('#join-username', 'Nadia');
  await nadia.fill('#join-name', 'Nadia Benali');
  await nadia.fill('#join-password', PASSWORD);
  await nadia.fill('#join-confirm', PASSWORD);
  await nadia.click('#join-submit');
  await waitForApp(nadia);

  // Bilal invites her, typed in lower case: the invitation names the account as it is spelt
  await inviteForm.locator('input[name="username"]').fill('nadia');
  await inviteForm.locator('button[data-action="invite"]').click();
  await bilal.waitForSelector('section.view-team .team-mine >> text=Nadia');

  await nadia.click('#rail-items a[href="#/team"]');
  const pending = nadia.locator('section.view-team button[data-action="accept"]');
  await pending.waitFor();
  await pending.click();
  await nadia.waitForSelector('section.view-team .team-mine .team-name:text-is("Les routeurs")');
  assert.deepEqual(h.app.deps.services.teams.teamOf('local:Nadia').name, 'Les routeurs');

  // In her team, she may open the consoles of the bench it holds
  const pane = await openConsole(nadia, 'B6H', 'R3');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R3>$/m);
  assert.deepEqual(bilal.errors, []);
  assert.deepEqual(nadia.errors, []);

  // Give the bench and the team back
  assert.equal((await api(bilal, 'POST', '/api/benches/B6H/release')).status, 200);
  const team = h.app.deps.services.teams.teamOf('local:Nadia');
  assert.equal((await api(nadia, 'POST', `/api/teams/${team.id}/leave`)).status, 200);
  assert.equal((await api(bilal, 'POST', `/api/teams/${team.id}/leave`)).status, 200);
  await bilal.context().close();
  await nadia.context().close();
});
