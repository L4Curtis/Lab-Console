/**
 * Wave 3 together, in a real browser on the mock lab: what only the bench
 * jobs and the group work side by side give.
 *
 * A team writes a note on R1, backs its bench up from the Sauvegardes
 * section, and is told by a browser notification that the job is done while
 * it looks elsewhere (the jobs module publishes 'jobs:done' to the bench's
 * occupants, the collab module turns it into a notification). It then resets
 * R1: the device is back to its factory configuration, the note is still on
 * the diagram. Releasing the bench from the bench bar offers the backup the
 * jobs module hands back, and that offer opens the backup dialog
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs } from './harness.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.05', JOB_COUNTDOWN_SECONDS: '2' } });

const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const consoles = (page) => page.locator('section.view-consoles');
const jobs = (page) => page.locator('section.view-jobs');
const dialog = (page) => page.locator('dialog.modal[open]');
const panel = (page) => consoles(page).locator('aside.collab-panel');
const deviceTile = (page, name) => consoles(page).locator('g.device', { has: page.locator('tspan.name', { hasText: new RegExp(`^${name}$`) }) });

/** A Notification that records what it is asked to show, and a window the test can look away from (as in collab.e2e.js) */
function fakeNotifications() {
  window.__notes = [];
  window.__away = false;
  document.hasFocus = () => !window.__away;
  class FakeNotification {
    static permission = 'default';
    static async requestPermission() {
      FakeNotification.permission = 'granted';
      return 'granted';
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
const lookAway = (page, away) => page.evaluate((a) => { window.__away = a; }, away);
const jobNotes = (page) => page.evaluate(() => window.__notes.filter((n) => n.options.tag?.startsWith('job:')).map((n) => ({ title: n.title, body: n.options.body, tag: n.options.tag })));
const waitForJobNotes = (page, count) => page.waitForFunction((c) => window.__notes.filter((n) => n.options.tag?.startsWith('job:')).length >= c, count, { timeout: 90_000 });

async function showBench(page, bench) {
  await page.evaluate((hash) => { location.hash = hash; }, `#/consoles/${encodeURIComponent(bench)}`);
  await page.waitForFunction((name) => document.querySelector('section.view-consoles .canvas-title')?.textContent === name, bench);
  await deviceTile(page, 'R1').waitFor();
}
async function openPanel(page) {
  if (await panel(page).isHidden()) await consoles(page).locator('.collab-btn').click();
  await panel(page).waitFor({ state: 'visible' });
}
/** Tick only these devices in the open job dialog */
async function only(page, names) {
  for (const box of await dialog(page).locator('.jobs-devices li').all()) {
    const name = await box.getAttribute('data-device');
    await box.locator('input[type="checkbox"]').first().setChecked(names.includes(name));
  }
}

let page;
after(async () => {
  await page?.context().close();
});

test('a team backs up its bench and is notified when it is done; the note of R1 survives the reset of R1; the release offers a backup', async () => {
  const lab = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M');
  const r1Line = lab.devices.find((d) => d.name === 'R1').target;
  const r1 = h.lab.device(`${r1Line.host}:${r1Line.port}`);
  r1.configure(['interface FastEthernet0/0', ' ip address 192.168.4.1 255.255.255.0', ' no shutdown']);

  page = await h.newPage();
  await page.addInitScript(fakeNotifications);
  await signInAs(page, 'alice');
  assert.equal((await api(page, 'POST', '/api/teams', { name: 'Les intégrateurs' })).status, 201);
  assert.equal((await api(page, 'POST', '/api/benches/B4M/take')).status, 200);

  // The bell on: the browser's permission is asked, a first notification shows it works
  await page.locator('#notify-toggle').click();
  await page.waitForSelector('#notify-toggle[data-state="on"]');

  // A note on R1, written from the group panel of the bench
  await showBench(page, 'B4M');
  await openPanel(page);
  const row = panel(page).locator('li.collab-note[data-device="R1"]');
  await row.locator('button[data-action="note"]').click();
  await dialog(page).locator('.note-text-input').fill('Console sur le port 2013 : ne pas débrancher');
  await dialog(page).locator('button[data-action="save"]').click();
  await dialog(page).waitFor({ state: 'detached' });
  await deviceTile(page, 'R1').locator('.deco-badge.badge-note').waitFor();

  // The backup, from the Sauvegardes section; she looks elsewhere while it runs
  await page.evaluate(() => { location.hash = '#/jobs/B4M'; });
  await jobs(page).locator('.jobs-actions button[data-action="backup"]:not([disabled])').click();
  await only(page, ['R1']);
  await dialog(page).locator('input[name="label"]').fill('avant reset');
  await lookAway(page, true);
  await dialog(page).locator('button[data-action="confirm"]').click();
  await waitForJobNotes(page, 1);
  await jobs(page).locator('.jobs-current[data-state="done"]').waitFor({ timeout: 60_000 });
  const [backup] = await jobNotes(page);
  assert.equal(backup.title, 'Tâche terminée sur B4M');
  assert.match(backup.body, /Sauvegarde/);

  // In front of the page there is no notification: the page says it itself. The reset, then
  await lookAway(page, false);
  await jobs(page).locator('.jobs-actions button[data-action="reset"]:not([disabled])').click();
  await only(page, ['R1']);
  await dialog(page).locator('input[name="confirm"]').fill('B4M');
  await dialog(page).locator('button[data-action="confirm"]').click();
  await jobs(page).locator('.jobs-current[data-state="pending"]').waitFor();
  await lookAway(page, true);
  await jobs(page).locator('.jobs-current[data-state="done"]').waitFor({ timeout: 90_000 });
  await waitForJobNotes(page, 2);
  const reset = (await jobNotes(page))[1];
  assert.equal(reset.title, 'Tâche terminée sur B4M');
  assert.match(reset.body, /Réinitialisation/);
  assert.notEqual(reset.tag, backup.tag, 'one notification per job');
  assert.equal(r1.cfg.hostname, 'Router', 'R1 is back to its factory configuration');
  await lookAway(page, false);

  // The note is not configuration: after a reload it is still on R1, on the diagram and in the panel
  await page.reload();
  await showBench(page, 'B4M');
  await deviceTile(page, 'R1').locator('.deco-badge.badge-note').waitFor();
  await openPanel(page);
  await panel(page).locator('li.collab-note[data-device="R1"] .collab-note-text', { hasText: 'ne pas débrancher' }).waitFor();

  // Releasing the bench from the bench bar offers the jobs module's backup, which opens its dialog
  await consoles(page).locator('.bench-bar button[data-action="release"]').click();
  await dialog(page).locator('button[data-action="confirm"]').click();
  await dialog(page).locator('h2', { hasText: 'Sauvegarder B4M' }).waitFor();
  await dialog(page).locator('button[data-action="confirm"]', { hasText: 'Sauvegarder' }).click();
  await page.waitForFunction(() => location.hash === '#/jobs/B4M/backup');
  await dialog(page).locator('.jobs-devices li[data-device="R1"]').waitFor();
  await page.keyboard.press('Escape');

  assert.deepEqual(page.errors, []);
});
