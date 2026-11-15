/**
 * Bench jobs in a real browser, on the mock lab:
 *   - a backup, then the ZIP offered at once with the plain message that the
 *     server is not a backup, downloaded;
 *   - a reset: what is erased and who is on the consoles, the bench name to
 *     type, the countdown (stopped once, then let run), the device back at
 *     its factory prompt;
 *   - an injection: the source, the exact script of each device in the
 *     preview, the bench name typed, the device configured again and read
 *     back identical
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { useHarness, signInAs, signInAsAdmin } from './harness.js';

const h = useHarness({ env: { JOB_TIME_SCALE: '0.05', JOB_COUNTDOWN_SECONDS: '4' } });

let r1;
let s1;

/** A request made by the page itself (its session cookie, its origin) → { status, body } */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const section = (page) => page.locator('section.view-jobs');
const dialog = (page) => page.locator('dialog.modal[open]');
/** A button of the page header (it is also in the phone's app bar: only the visible one) */
const headerButton = (page, action) => section(page).locator(`.page-header button[data-action="${action}"]:visible`);
/** An entry of the header's ⋯ menu (reset, import) */
async function fromHeaderMenu(page, id) {
  await section(page).locator('.page-header .more-btn:visible').click();
  await page.locator(`.menu-pop [data-id="${id}"]`).click();
}
/** An entry of the ⋯ menu of a row of the snapshots list */
async function fromRowMenu(row, id) {
  await row.locator('.more-btn:visible').click();
  await row.page().locator(`.menu-pop [data-id="${id}"]`).click();
}

before(async () => {
  await h.ready;
  const lab = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M');
  const target = (name) => { const d = lab.devices.find((x) => x.name === name); return `${d.target.host}:${d.target.port}`; };
  r1 = h.lab.device(target('R1'));
  s1 = h.lab.device(target('S1'));
});

/** Alice, in a team that holds B4M, on the jobs page of B4M */
async function aliceOnJobs() {
  const page = await h.newPage();
  await signInAs(page, 'alice');
  const team = await api(page, 'POST', '/api/teams', { name: 'Les sauvegardeurs' });
  assert.ok([201, 409].includes(team.status));
  const taken = await api(page, 'POST', '/api/benches/B4M/take');
  assert.ok([200, 409].includes(taken.status), JSON.stringify(taken.body));
  await page.evaluate(() => { location.hash = '#/jobs/B4M'; });
  await section(page).locator('.page-header button[data-action="backup"]:visible:not([disabled])').waitFor();
  return page;
}

/** Tick only these devices in the open dialog */
async function only(page, names) {
  for (const box of await dialog(page).locator('.jobs-devices li').all()) {
    const name = await box.getAttribute('data-device');
    await box.locator('input[type="checkbox"]').first().setChecked(names.includes(name));
  }
}

test('backup of R1 and S1, then the ZIP right away, with the reminder that the server is not a backup', async () => {
  r1.configure(['interface FastEthernet0/0', ' ip address 192.168.4.1 255.255.255.0', ' no shutdown']);
  const page = await aliceOnJobs();
  await headerButton(page, 'backup').click();
  await only(page, ['R1', 'S1']);
  // Shared devices are unticked by default: S5 is on a console line other benches use
  assert.equal(await dialog(page).locator('.jobs-devices li[data-device="S5"] input').isChecked(), false);
  await dialog(page).locator('input[name="label"]').fill('TP4 fin');
  await dialog(page).locator('button[data-action="confirm"]').click();

  // Followed live, device by device
  await section(page).locator('.jobs-current li[data-device="R1"]').waitFor({ state: 'attached' }); // the device list is folded: "Détail" opens it
  await section(page).locator('.jobs-current[data-state="done"]').waitFor({ timeout: 60_000 });
  const box = section(page).locator('.jobs-download');
  await box.waitFor();
  assert.match(await box.textContent(), /Le serveur n’est pas une sauvegarde/);
  const [download] = await Promise.all([page.waitForEvent('download'), box.locator('a[data-action="download-zip"]').click()]);
  const files = unzipSync(new Uint8Array(await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks))));
  const r1cfg = Object.entries(files).find(([n]) => n.endsWith('/R1.cfg'));
  assert.ok(r1cfg, Object.keys(files).join(', '));
  assert.match(strFromU8(r1cfg[1]), /ip address 192\.168\.4\.1 255\.255\.255\.0/);

  // The snapshot is listed for the team
  await section(page).locator('.jobs-snapshots tr', { hasText: 'TP4 fin' }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('reset: the dialog says what is erased and who is connected; the bench name unlocks it; the countdown can be stopped, then runs', async () => {
  const page = await aliceOnJobs();
  const openReset = async () => {
    await fromHeaderMenu(page, 'reset');
    await only(page, ['R1']);
  };
  await openReset();
  assert.match(await dialog(page).locator('.jobs-erased').textContent(), /flash:vlan\.dat/);
  assert.match(await dialog(page).locator('.jobs-erased').textContent(), /0x2102/);
  assert.equal(await dialog(page).locator('.jobs-devices li[data-device="R1"]').textContent().then((x) => /personne sur la console/.test(x)), true);
  const go = dialog(page).locator('button[data-action="confirm"]');
  assert.equal(await go.isDisabled(), true, 'locked until the bench name is typed');
  await dialog(page).locator('input[name="confirm"]').fill('b4m');
  assert.equal(await go.isDisabled(), true);
  await dialog(page).locator('input[name="confirm"]').fill('B4M');
  await go.click();

  // The countdown, and Stop
  await section(page).locator('.jobs-current[data-state="pending"] .jobs-countdown', { hasText: /Démarre dans \d secondes?/ }).waitFor();
  await section(page).locator('.jobs-current button[data-action="cancel"]').click();
  await section(page).locator('.jobs-current[data-state="cancelled"]').waitFor();
  assert.equal(r1.cfg.hostname, 'R1', 'nothing touched');

  // Again, and let it run: backup, erase, reload, factory prompt
  await openReset();
  await dialog(page).locator('input[name="confirm"]').fill('B4M');
  await dialog(page).locator('button[data-action="confirm"]').click();
  await section(page).locator('.jobs-current[data-state="pending"]').waitFor();
  await section(page).locator('.jobs-current[data-state="running"]').waitFor({ timeout: 15_000 });
  await section(page).locator('.jobs-current[data-state="done"]').waitFor({ timeout: 90_000 });
  assert.equal(r1.cfg.hostname, 'Router');
  assert.equal(r1.startup, null, 'no startup-config any more');
  await section(page).locator('.jobs-current button[data-action="report"]').click();
  await dialog(page).locator('.jobs-report-device[data-device="R1"][data-state="done"]').waitFor();
  assert.match(await dialog(page).textContent(), /registre de configuration\u00a0: 0x2102/);
  await page.keyboard.press('Escape');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('injection: the preview shows the exact script of each device; once the bench name is typed it is sent and read back identical', async () => {
  s1.configure(['vlan 40', ' name INJECT', 'exit']);
  const page = await aliceOnJobs();
  // A backup to inject from, taken through the API (the scenario above covers the dialog)
  const keys = h.app.deps.services.consoles.registry.model.labs.find((l) => l.name === 'B4M').devices.filter((d) => ['R1', 'S1'].includes(d.name)).map((d) => d.key);
  const started = await api(page, 'POST', '/api/jobs/benches/B4M/backup', { devices: keys, label: 'source' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await section(page).locator('.jobs-current[data-state="done"]').waitFor({ timeout: 60_000 });
  await section(page).locator('.jobs-snapshots tr', { hasText: 'source' }).first().waitFor();
  // Something changes on the bench afterwards
  s1.configure(['no vlan 40']);

  await fromRowMenu(section(page).locator('.jobs-snapshots tbody tr', { hasText: 'source' }).first(), 'inject');
  await only(page, ['S1']);
  await dialog(page).locator('button[data-action="confirm"]').click();
  const script = dialog(page).locator('details.jobs-script[data-device="S1"]');
  await script.waitFor();
  await script.locator('summary').click();
  const text = await script.locator('pre.jobs-code').textContent();
  assert.match(text, /^configure terminal$/m);
  assert.match(text, /^vlan 40\n name INJECT$/m);
  assert.match(text, /^hostname S1$/m);
  const go = dialog(page).locator('button[data-action="confirm"]');
  assert.equal(await go.isDisabled(), true, 'reset then inject: the bench name is typed first');
  await dialog(page).locator('input[name="confirm"]').fill('B4M');
  await go.click();
  await section(page).locator('.jobs-current[data-state="running"]').waitFor();
  await section(page).locator('.jobs-current[data-state="done"]').waitFor({ timeout: 90_000 });
  assert.match(await section(page).locator('.jobs-current li[data-device="S1"]').textContent(), /identique à la source/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('an administrator imports a template from a ZIP; a student has no such button', async () => {
  const admin = await h.newPage();
  await signInAsAdmin(admin);
  await admin.evaluate(() => { location.hash = '#/jobs/B4M/templates'; });
  await section(admin).locator('button[data-action="import-template"]').waitFor();
  const zip = zipSync({ 'R1.cfg': strToU8('hostname R1\n logging synchronous\n'), '_any.cfg': strToU8('service password-encryption\n') });
  await section(admin).locator('.jobs-templates input[type="file"]').setInputFiles({ name: 'TP-reseau.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  const row = section(admin).locator('.jobs-templates tbody tr[data-key="TP-reseau"]');
  await row.waitFor();
  assert.match(await row.textContent(), /R1/);
  await admin.screenshot({ path: '/srv/lab-console-dev/tmp/template-import.png' });
  const listed = await api(admin, 'GET', '/api/jobs/templates');
  await api(admin, 'DELETE', `/api/jobs/templates/${listed.body.templates.find((x) => x.name === 'TP-reseau').id}`);
  assert.deepEqual(admin.errors, []);
  await admin.context().close();

  const page = await aliceOnJobs();
  await page.evaluate(() => { location.hash = '#/jobs/B4M/templates'; });
  await section(page).locator('.jobs-templates').waitFor();
  assert.equal(await section(page).locator('button[data-action="import-template"]').count(), 0);
  await page.context().close();
});
