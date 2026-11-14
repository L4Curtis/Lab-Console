/**
 * Group work in real browsers (SPEC "Lot collab"):
 *   - the shared note of a device: written by an occupant, seen by anyone on
 *     the diagram and in the panel, refused to outsiders, a clash of two
 *     writers told and settled
 *   - the chat of a bench between two members of a team, closed to the others,
 *     shown as text
 *   - the notifications: turned on with the bell, shown only when the window
 *     is not the one looked at, for a request for the keyboard, a line that is
 *     free or can be joined, and a finished job of the person's own bench
 * Each scenario makes the team and the bench it needs and gives them back
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, setLanguage, person } from './harness.js';

const h = useHarness();

const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const view = (page) => page.locator('section.view-consoles');
const panel = (page) => view(page).locator('aside.collab-panel');
const deviceTile = (page, name) => view(page).locator('g.device', { has: page.locator('tspan.name', { hasText: new RegExp(`^${name}$`) }) });

async function showBench(page, bench) {
  await page.evaluate((hash) => { location.hash = hash; }, `#/consoles/${encodeURIComponent(bench)}`);
  await page.waitForFunction((name) => document.querySelector('section.view-consoles .canvas-title')?.textContent === name, bench);
  await deviceTile(page, 'R1').waitFor();
}

async function openPanel(page) {
  if (await panel(page).isHidden()) await view(page).locator('.collab-btn').click();
  await panel(page).waitFor({ state: 'visible' });
}

/**
 * A team of `members` ([page, who] pairs, the first one creates it) that takes `bench`.
 * It is given back, bench and team, when the scenario ends, whatever happened in it
 */
const cleanups = [];
const pages = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()().catch(() => {});
  while (pages.length) await pages.pop().context().close();
});
async function newPage() {
  const page = await h.newPage();
  pages.push(page);
  return page;
}

async function takeBench(name, bench, ...members) {
  const [[owner]] = members;
  const created = await api(owner, 'POST', '/api/teams', { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.team.id;
  for (const [page, who] of members.slice(1)) {
    assert.equal((await api(owner, 'POST', `/api/teams/${id}/invitations`, { username: person(who).username })).status, 201);
    assert.equal((await api(page, 'POST', `/api/teams/${id}/accept`)).status, 200);
  }
  assert.equal((await api(owner, 'POST', `/api/benches/${bench}/take`)).status, 200);
  cleanups.push(async () => {
    await api(owner, 'POST', `/api/benches/${bench}/release`);
    for (const [page] of [...members].reverse()) await api(page, 'POST', `/api/teams/${id}/leave`);
  });
}

const deviceOf = (bench, name) => h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === bench).devices.find((d) => d.name === name);
const deviceKey = (bench, name) => deviceOf(bench, name).key;
const lineOf = (bench, name) => `${deviceOf(bench, name).target.host}:${deviceOf(bench, name).target.port}`;

test('a note written by an occupant shows on the diagram for everyone; outsiders read it; two writers clash and settle it', async () => {
  const alice = await newPage();
  const bilal = await newPage();
  const chloe = await newPage();
  await signInAs(alice, 'alice');
  await signInAs(bilal, 'bilal');
  await signInAs(chloe, 'chloe');
  await takeBench('Les notes', 'B4M', [alice, 'alice'], [bilal, 'bilal']);
  await Promise.all([showBench(alice, 'B4M'), showBench(chloe, 'B4M')]);

  // Alice (an occupant) writes the note of R1 from the panel
  await openPanel(alice);
  const row = panel(alice).locator('li.collab-note[data-device="R1"]');
  await row.locator('button[data-action="note"]').click();
  const dialog = alice.locator('dialog.modal');
  await dialog.locator('.note-text-input').fill('R1 est le cœur.\nSerial0/0/0 vers R2 (DCE)');
  await dialog.locator('button[data-action="save"]').click();
  await dialog.waitFor({ state: 'detached' });
  await row.locator('.collab-note-text', { hasText: 'Serial0/0/0 vers R2' }).waitFor();

  // Chloe, who is on no team, sees the badge on the diagram, the text in the tooltip and in the panel
  await deviceTile(chloe, 'R1').locator('.deco-badge.badge-note').waitFor();
  assert.equal(await deviceTile(chloe, 'R2').locator('.deco-badge.badge-note').count(), 0, 'only R1 has a note');
  await deviceTile(chloe, 'R1').hover();
  await view(chloe).locator('.diagram-tip.show .tip-line', { hasText: 'R1 est le cœur.' }).waitFor();
  await openPanel(chloe);
  const read = panel(chloe).locator('li.collab-note[data-device="R1"]');
  await read.locator('.collab-note-text', { hasText: 'Serial0/0/0 vers R2' }).waitFor();
  assert.equal(await panel(chloe).locator('li.collab-note').count(), 1, 'she is offered no empty note to write');
  await read.locator('button[data-action="note"]').click();
  const readOnly = chloe.locator('dialog.modal');
  await readOnly.locator('.note-text', { hasText: 'R1 est le cœur.' }).waitFor();
  assert.equal(await readOnly.locator('textarea').count(), 0, 'no way to type in it');
  await readOnly.locator('.modal-head button').click();
  await readOnly.waitFor({ state: 'detached' });
  // ...and the server refuses her anyway
  const refused = await api(chloe, 'PUT', `/api/collab/notes/${encodeURIComponent(deviceKey('B4M', 'R1'))}`, { text: 'vandalism', rev: 1 });
  assert.equal(refused.status, 403);

  // Alice and Bilal open the note together; Bilal saves first, Alice is told and takes his version
  await row.locator('button[data-action="note"]').click();
  await dialog.locator('.note-text-input').waitFor();
  const saved = await api(bilal, 'PUT', `/api/collab/notes/${encodeURIComponent(deviceKey('B4M', 'R1'))}`, { text: 'Version de Bilal', rev: 1 });
  assert.equal(saved.status, 200);
  await dialog.locator('.note-text-input').fill('Version d’Alice');
  await dialog.locator('button[data-action="save"]').click();
  await dialog.locator('.note-problem', { hasText: 'Quelqu’un a modifié cette note' }).waitFor();
  assert.equal(await dialog.locator('.note-text-input').inputValue(), 'Version d’Alice', 'what she typed is kept');
  await dialog.locator('button', { hasText: 'Voir leur version' }).click();
  assert.equal(await dialog.locator('.note-text-input').inputValue(), 'Version de Bilal');
  await dialog.locator('.note-text-input').fill('Version de Bilal, relue par Alice');
  await dialog.locator('button[data-action="save"]').click();
  await dialog.waitFor({ state: 'detached' });
  await read.locator('.collab-note-text', { hasText: 'relue par Alice' }).waitFor();

  // A note is also reachable from a console tile
  const pane = await openConsole(alice, 'B4M', 'R2');
  await pane.locator('.pane-actions button[title="Note de l’équipement"], .pane-custom-actions button[title="Note de l’équipement"]').first().click();
  await dialog.locator('.note-text-input').waitFor();
  await dialog.locator('.modal-actions button', { hasText: 'Annuler' }).click();
  await dialog.waitFor({ state: 'detached' });

  // Emptying the note deletes it, for everyone
  await showBench(alice, 'B4M');
  await row.locator('button[data-action="note"]').click();
  await dialog.locator('.note-text-input').fill('');
  await dialog.locator('button[data-action="save"]').click();
  await dialog.waitFor({ state: 'detached' });
  await deviceTile(chloe, 'R1').locator('.deco-badge.badge-note').waitFor({ state: 'detached' });

  for (const page of [alice, bilal, chloe]) assert.deepEqual(page.errors, [], 'no page error');
});

test('the chat of a bench: two members talk, a newcomer is left out, markup stays text, English follows', async () => {
  const alice = await newPage();
  const bilal = await newPage();
  const chloe = await newPage();
  await signInAs(alice, 'alice');
  await signInAs(bilal, 'bilal');
  await signInAs(chloe, 'chloe');
  await takeBench('Le chat', 'B4M', [alice, 'alice'], [bilal, 'bilal']);
  await Promise.all([showBench(alice, 'B4M'), showBench(bilal, 'B4M'), showBench(chloe, 'B4M')]);
  await Promise.all([openPanel(alice), openPanel(bilal), openPanel(chloe)]);

  const say = async (page, text) => {
    await panel(page).locator('.chat-input').fill(text);
    await panel(page).locator('.chat-input').press('Enter');
  };
  const message = (page, text) => panel(page).locator('.chat-message .chat-text', { hasText: text });

  await panel(alice).locator('.chat-hint', { hasText: 'Aucun message' }).waitFor();
  await say(alice, 'Qui fait le câblage ?');
  await message(alice, 'Qui fait le câblage ?').waitFor();
  await message(bilal, 'Qui fait le câblage ?').waitFor();
  assert.equal(await panel(alice).locator('.chat-input').inputValue(), '', 'the field is emptied once sent');
  await say(bilal, 'Moi, je commence par R1');
  await message(alice, 'Moi, je commence par R1').waitFor();
  assert.equal(await panel(alice).locator('.chat-message[data-mine="true"]').count(), 1);

  // Chloe works on no bench: the panel tells her so, and she has received nothing
  await panel(chloe).locator('.chat-hint', { hasText: 'réservée aux personnes qui travaillent sur cette baie' }).waitFor();
  assert.equal(await panel(chloe).locator('.chat-form').isVisible(), false);
  assert.equal(await panel(chloe).locator('.chat-message').count(), 0);
  assert.equal((await api(chloe, 'GET', '/api/collab/chat/B4M')).status, 403);
  assert.equal((await api(chloe, 'POST', '/api/collab/chat/B4M', { text: 'coucou' })).status, 403);

  // Markup is text
  await say(alice, '<img src=x onerror="window.__pwned=1"> <b>gras</b>');
  await message(bilal, '<img src=x onerror="window.__pwned=1"> <b>gras</b>').waitFor();
  assert.equal(await panel(bilal).locator('.chat-log img, .chat-log b').count(), 0);
  assert.equal(await bilal.evaluate(() => window.__pwned), undefined);

  // The button counts what came while the panel was shut, and the count is cleared on opening
  await view(bilal).locator('.collab-btn').click();
  await panel(bilal).waitFor({ state: 'hidden' });
  await say(alice, 'Pensez à sauvegarder');
  const badge = view(bilal).locator('.collab-btn .live-badge');
  await badge.waitFor({ state: 'visible' });
  assert.equal(await badge.textContent(), '1');
  await openPanel(bilal);
  await message(bilal, 'Pensez à sauvegarder').waitFor();
  await badge.waitFor({ state: 'hidden' });

  // The conversation is read again when the page is reloaded
  await bilal.reload();
  await showBench(bilal, 'B4M');
  await openPanel(bilal);
  await message(bilal, 'Moi, je commence par R1').waitFor();

  // English, without losing anything
  await setLanguage(alice, 'en');
  await panel(alice).locator('h3', { hasText: 'Bench chat' }).waitFor();
  assert.equal(await panel(alice).locator('.chat-input').getAttribute('placeholder'), 'Write to the team (Enter to send)');

  // An administrator reads and can take a message down
  const ada = await newPage();
  await signInAs(ada, 'ada');
  await showBench(ada, 'B4M');
  await openPanel(ada);
  await message(ada, 'Pensez à sauvegarder').waitFor();
  assert.equal(await panel(ada).locator('.chat-form').isVisible(), false, 'admins read, they do not write');
  await panel(ada).locator('.chat-message', { hasText: 'Pensez à sauvegarder' }).locator('button[data-action="remove"]').click();
  await message(ada, 'Pensez à sauvegarder').waitFor({ state: 'detached' });
  await message(bilal, 'Pensez à sauvegarder').waitFor({ state: 'detached' });

  // The unread count is the one of the bench on screen, and a message taken down leaves it
  await view(ada).locator('.collab-btn').click();
  await panel(ada).waitFor({ state: 'hidden' });
  const adaBadge = view(ada).locator('.collab-btn .live-badge');
  await say(alice, 'Un de plus');
  await adaBadge.waitFor({ state: 'visible' });
  assert.equal(await adaBadge.textContent(), '1');
  const thread = (await api(ada, 'GET', '/api/collab/chat/B4M')).body.messages;
  const extra = thread.find((m) => m.text === 'Un de plus');
  assert.equal((await api(ada, 'DELETE', `/api/collab/chat/B4M/${extra.id}`)).status, 200);
  await adaBadge.waitFor({ state: 'hidden' });
  await say(alice, 'Encore un');
  await adaBadge.waitFor({ state: 'visible' });
  await showBench(ada, 'B4H');
  await adaBadge.waitFor({ state: 'hidden' }); // B4H has its own count: nothing was said there
  await showBench(ada, 'B4M');
  await adaBadge.waitFor({ state: 'visible' });
  assert.equal(await adaBadge.textContent(), '1');

  for (const page of [alice, bilal, chloe, ada]) assert.deepEqual(page.errors, [], 'no page error');
});

/** A Notification that records what it is asked to show, and a window the test can look away from */
function fakeNotifications({ permission = 'default', answer = 'granted' } = {}) {
  window.__notes = [];
  window.__away = false;
  document.hasFocus = () => !window.__away;
  class FakeNotification {
    static permission = permission;
    static async requestPermission() {
      FakeNotification.permission = answer;
      return answer;
    }
    constructor(title, options = {}) {
      this.title = title;
      this.options = options;
      window.__notes.push(this);
    }
    close() { this.closed = true; }
  }
  window.Notification = FakeNotification;
}
const shown = (page) => page.evaluate(() => window.__notes.map((n) => ({ title: n.title, body: n.options.body, tag: n.options.tag })));
const lookAway = (page, away) => page.evaluate((a) => { window.__away = a; }, away);
const tagsOf = async (page) => (await shown(page)).map((n) => n.tag);
const waitForTag = (page, tag) => page.waitForFunction((t) => window.__notes.some((n) => n.options.tag === t), tag);

test('notifications: the bell, then a request for the keyboard, a free line and a finished job - only while looking elsewhere, only for oneself', async () => {
  const alice = await newPage();
  await alice.addInitScript(fakeNotifications, { permission: 'default', answer: 'granted' });
  const bilal = await newPage();
  await signInAs(alice, 'alice');
  await signInAs(bilal, 'bilal');
  await takeBench('Les alertes', 'B4M', [alice, 'alice'], [bilal, 'bilal']);
  const events = h.app.deps.events;
  const aliceId = (await alice.evaluate(() => fetch('/auth/me').then((r) => r.json()))).user.id;

  // The bell: off, then on with the browser's permission, and a first notification to show it works
  const bell = alice.locator('#notify-toggle');
  await bell.waitFor();
  assert.equal(await bell.getAttribute('data-state'), 'off');
  await bell.click();
  await alice.waitForSelector('#notify-toggle[data-state="on"]');
  await waitForTag(alice, 'collab:test');
  assert.equal((await shown(alice))[0].title, 'Alertes activées');

  // 1. a request for the keyboard of a line Alice pilots
  const pane = await openConsole(alice, 'B4M', 'R1');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^R1>$/m);
  const bilalPane = await openConsole(bilal, 'B4M', 'R1', { login: false }); // joins a line that is already open
  await typeInConsole(pane, 'show clock'); // she is typing: the keyboard is hers and busy
  await waitForTerminal(pane, /^R1>show clock$/m);
  await lookAway(alice, true);
  await bilalPane.locator('button[data-action="request"]').click();
  await waitForTag(alice, `control:${lineOf('B4M', 'R1')}`).catch(async () => {
    throw new Error(`no keyboard notification; shown: ${JSON.stringify(await shown(alice))}`);
  });
  const asked = (await shown(alice)).find((n) => n.tag.startsWith('control:'));
  assert.equal(asked.title, 'Clavier demandé sur R1');
  assert.match(asked.body, /Bilal Haddad demande le clavier de R1 \(baie B4M\)/);
  await lookAway(alice, false);

  // 2. a line she waited for is free: the window in front says it on the page, not in a notification
  const r2 = { device: 'R2', bench: 'B4M', key: deviceKey('B4M', 'R2'), target: lineOf('B4M', 'R2') };
  const s1 = { device: 'S1', bench: 'B4M', key: deviceKey('B4M', 'S1'), target: lineOf('B4M', 'S1') };
  events.toUser(aliceId, 'consoles:free', { ...r2, state: 'free' });   // in front: nothing
  await lookAway(alice, true);
  events.toUser(aliceId, 'consoles:free', { ...r2, state: 'expired' }); // giving up is not news worth a notification
  events.toUser(aliceId, 'consoles:free', { ...s1, state: 'free' });
  await waitForTag(alice, `free:${s1.target}`);
  assert.equal((await tagsOf(alice)).includes(`free:${r2.target}`), false, 'looking at the page, or expired: no notification');
  const free = (await shown(alice)).find((n) => n.tag === `free:${s1.target}`);
  assert.equal(free.title, 'S1 est libre');
  assert.equal(free.body, 'La ligne de S1 (baie B4M) est libre\u00a0: vous pouvez l’ouvrir.');
  // The line was opened in the app by someone else: it can be joined, which ends the watch just as well
  events.toUser(aliceId, 'consoles:free', { ...r2, state: 'open' });
  await waitForTag(alice, `free:${r2.target}`);
  const joinable = (await shown(alice)).find((n) => n.tag === `free:${r2.target}`);
  assert.equal(joinable.title, 'R2 est ouverte');
  assert.equal(joinable.body, 'La console de R2 (baie B4M) est ouverte dans Lab Console\u00a0: vous pouvez la rejoindre.');

  // 3. a job of her bench is over; a job of another bench is not hers
  const bench = (name) => (u) => h.app.deps.services.benches.isOccupant(u, name);
  events.publish('jobs:done', { bench: 'B4H', jobId: 'other-bench', kind: 'backup', ok: true }, { audience: () => true });
  events.publish('jobs:done', { bench: 'B4M', jobId: 'j-ok', kind: 'backup', ok: true }, { audience: bench('B4M') });
  events.publish('jobs:done', { bench: 'B4M', jobId: 'j-ko', kind: 'inject', ok: false }, { audience: bench('B4M') });
  await waitForTag(alice, 'job:j-ko');
  const tags = await tagsOf(alice);
  assert.ok(tags.includes('job:j-ok'));
  assert.equal(tags.includes('job:other-bench'), false, 'not her bench');
  const ok = (await shown(alice)).find((n) => n.tag === 'job:j-ok');
  assert.equal(ok.title, 'Tâche terminée sur B4M');
  assert.equal(ok.body, 'Tâche «\u00a0Sauvegarde\u00a0» terminée sur la baie B4M.');
  const ko = (await shown(alice)).find((n) => n.tag === 'job:j-ko');
  assert.equal(ko.title, 'Tâche en échec sur B4M');
  assert.match(ko.body, /Injection/);

  // Clicking a job's notification brings her to the bench's jobs, where the report is
  await alice.evaluate(() => { location.hash = '#/team'; });
  await alice.evaluate(() => window.__notes.find((n) => n.options.tag === 'job:j-ok').onclick());
  await alice.waitForFunction(() => location.hash === '#/jobs/B4M');

  // Turned off, the bell keeps quiet, and the choice survives a reload
  await bell.click();
  await alice.waitForSelector('#notify-toggle[data-state="off"]');
  events.publish('jobs:done', { bench: 'B4M', jobId: 'while-off', kind: 'reset', ok: true }, { audience: () => true });
  await alice.reload();
  await alice.waitForSelector('#notify-toggle[data-state="off"]');
  await alice.evaluate(() => { window.__away = true; });
  await alice.locator('#notify-toggle').click();
  await alice.waitForSelector('#notify-toggle[data-state="on"]');
  assert.equal((await tagsOf(alice)).includes('job:while-off'), false);

  // In English
  await setLanguage(alice, 'en');
  events.publish('jobs:done', { bench: 'B4M', jobId: 'j-en', kind: 'backup', ok: true }, { audience: () => true });
  await waitForTag(alice, 'job:j-en');
  assert.equal((await shown(alice)).find((n) => n.tag === 'job:j-en').title, 'Job finished on B4M');

  for (const page of [alice, bilal]) assert.deepEqual(page.errors, [], 'no page error');
});

test('notifications: a browser that refuses them, or does not have them, gets an honest bell', async () => {
  const refusing = await newPage();
  await refusing.addInitScript(fakeNotifications, { permission: 'default', answer: 'denied' });
  await signInAs(refusing, 'chloe');
  await refusing.locator('#notify-toggle').click();
  await refusing.locator('.toast', { hasText: 'n’autorise pas les alertes' }).waitFor();
  await refusing.waitForSelector('#notify-toggle[data-state="denied"]');
  assert.equal(await refusing.locator('#notify-toggle').isDisabled(), true);
  assert.deepEqual(await shown(refusing), []);

  const without = await newPage();
  await without.addInitScript(() => { delete window.Notification; });
  await signInAs(without, 'bilal');
  await without.waitForSelector('#notify-toggle[data-state="unsupported"]');
  assert.equal(await without.locator('#notify-toggle').isDisabled(), true);

  for (const page of [refusing, without]) assert.deepEqual(page.errors, []);
});
