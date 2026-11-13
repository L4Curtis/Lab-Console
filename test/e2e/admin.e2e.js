/**
 * Administration in a real browser (SPEC, lot admin):
 *   - a lab parameter changed (and confirmed with password + code) is used
 *     by the next console a student opens;
 *   - a diagram imported, previewed, activated, then rolled back: students
 *     see each change in the consoles section;
 *   - an announcement published reaches an open student page at once
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAsAdmin, waitForApp, openConsole, typeInConsole, waitForTerminal, TEST_ADMIN, MOCK_TELNET } from './harness.js';

const h = useHarness();

const NEW_DIAGRAM = '<mxfile><diagram name="NEWLAB" id="new-lab"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
  + '<mxCell id="r" value="R1&lt;br&gt;.211 - 2013" style="shape=mxgraph.cisco.routers.router;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="60" height="40" as="geometry"/></mxCell>'
  + '<mxCell id="s" value="S4&lt;br&gt;.211 - 2019" style="shape=mxgraph.cisco.switches.workgroup_switch;" vertex="1" parent="1"><mxGeometry x="200" y="40" width="60" height="40" as="geometry"/></mxCell>'
  + '</root></mxGraphModel></diagram></mxfile>';

/** Save one lab parameter from the Lab parameters tab, confirming with the local administrator's password and code */
async function saveLabParameter(page, selector, value) {
  await page.evaluate(() => { location.hash = '#/admin/lab'; });
  await page.waitForSelector('section.view-admin #lab-telnet-password');
  await page.waitForFunction(() => document.querySelector('[data-field="ssh.host"] .origin-pill')?.textContent.length > 0);
  await page.fill(selector, value);
  await page.click('section.view-admin button[data-action="save"]');
  await page.fill('dialog.modal input[name="password"]', TEST_ADMIN.password);
  await page.fill('dialog.modal input[name="code"]', await h.adminCode());
  await page.click('dialog.modal button[data-action="confirm"]');
  await page.waitForSelector('dialog.modal', { state: 'detached' });
  await page.waitForSelector('.toast >> text=Paramètres enregistrés');
  const field = selector.replace(/^#lab-/, '').replace('-', '.');
  await page.waitForFunction((f) => document.querySelector(`[data-field="${f}"] .origin-pill`)?.dataset.origin === 'saved', field);
}

test('a lab parameter changed by an administrator is used by the next console', async () => {
  const admin = await h.newPage();
  await signInAsAdmin(admin);
  await saveLabParameter(admin, '#lab-telnet-password', 'not-the-line-password');
  assert.equal(await admin.textContent('[data-field="telnet.password"] .origin-pill'), 'modifié ici');
  assert.equal(await admin.inputValue('#lab-telnet-password'), '', 'a secret is never shown back');

  const student = await h.newPage();
  await h.session(student, 'alice');
  const pane = await openConsole(student, 'B4M', 'R1', { login: false });
  await waitForTerminal(pane, /% Login invalid/);

  // Back to the environment's password: the next line logs in again
  await admin.evaluate(() => { location.hash = '#/admin/lab'; });
  await admin.click('[data-field="telnet.password"] button[data-action="reset"]');
  await admin.click('section.view-admin button[data-action="save"]');
  await admin.fill('dialog.modal input[name="password"]', TEST_ADMIN.password);
  await admin.fill('dialog.modal input[name="code"]', await h.adminCode());
  await admin.click('dialog.modal button[data-action="confirm"]');
  await admin.waitForFunction(() => document.querySelector('[data-field="telnet.password"] .origin-pill')?.dataset.origin === 'environment');
  assert.equal(h.app.deps.settings.get('lab').telnet.password, MOCK_TELNET.password);

  await student.reload();
  await waitForApp(student);
  const again = await openConsole(student, 'B4M', 'R1');
  await typeInConsole(again, '');
  await waitForTerminal(again, /^R1>$/m);

  assert.deepEqual(admin.errors, []);
  assert.deepEqual(student.errors, []);
  await admin.context().close();
  await student.context().close();
});

test('a diagram is imported, previewed, activated, then rolled back; students follow', async () => {
  const admin = await h.newPage();
  await h.session(admin, 'ada');
  await admin.goto(`${h.url}/#/admin/diagram`);
  await waitForApp(admin);
  await admin.waitForSelector('tr[data-active="true"]');
  await admin.setInputFiles('#diagram-file', { name: 'nouveau.drawio', mimeType: 'application/xml', buffer: Buffer.from(NEW_DIAGRAM) });
  await admin.waitForSelector('.diagram-preview:not([hidden]) >> text=Aperçu : nouveau.drawio');
  await admin.waitForSelector('.diagram-preview .diff >> text=NEWLAB');
  await admin.waitForSelector('.diagram-preview .preview-canvas g.device');

  const student = await h.newPage();
  await h.session(student, 'bilal');
  await student.goto(`${h.url}/#/consoles`);
  await waitForApp(student);
  await student.waitForSelector('section.view-consoles >> text=B4M');

  await admin.click('.diagram-preview button[data-action="activate-preview"]');
  await admin.click('dialog.modal button[data-action="confirm"]');
  await admin.waitForSelector('.toast >> text=Schéma activé');
  // The student's diagram follows (labs:version pushed live)
  await student.waitForSelector('section.view-consoles .lab-picker >> text=NEWLAB');
  const pane = await openConsole(student, 'NEWLAB', 'S4');
  await typeInConsole(pane, '');
  await waitForTerminal(pane, /^S4>$/m);

  await admin.click('section.view-admin button[data-action="rollback"]');
  await admin.click('dialog.modal button[data-action="confirm"]');
  await admin.waitForSelector('.toast >> text=Schéma précédent rétabli');
  await admin.waitForSelector('tr[data-active="true"] >> text=fichier d’origine');
  // The bench list is back; the console opened meanwhile stays open in its pane
  await student.waitForSelector('section.view-consoles .lab-picker >> text=B4M');
  await student.waitForFunction(() => ![...document.querySelectorAll('section.view-consoles .lab-picker *')].some((n) => n.textContent === 'NEWLAB'));

  assert.deepEqual(admin.errors, []);
  assert.deepEqual(student.errors, []);
  await admin.context().close();
  await student.context().close();
});

test('an announcement reaches a student page that is already open, as text', async () => {
  const student = await h.newPage();
  await h.session(student, 'chloe');
  await student.goto(`${h.url}/#/consoles`);
  await waitForApp(student);
  assert.equal(await student.locator('.announcement-banner').isHidden(), true);

  const admin = await h.newPage();
  await h.session(admin, 'ada');
  await admin.goto(`${h.url}/#/admin/announcement`);
  await waitForApp(admin);
  await admin.fill('#announcement-text', 'Baie 5 en maintenance <b>ce matin</b>');
  await admin.selectOption('#announcement-level', 'warning');
  await admin.selectOption('#announcement-hours', '4');
  await admin.click('section.view-admin button[data-action="publish"]');
  await admin.waitForSelector('.toast >> text=Annonce publiée');

  const banner = student.locator('.announcement-banner');
  await banner.waitFor({ state: 'visible' });
  assert.equal(await banner.locator('.announcement-text').textContent(), 'Baie 5 en maintenance <b>ce matin</b>', 'shown as typed, never as HTML');
  assert.equal(await banner.getAttribute('data-level'), 'warning');
  assert.equal(await student.locator('.announcement-banner b').count(), 0);

  await admin.click('section.view-admin button[data-action="remove"]');
  await banner.waitFor({ state: 'hidden' });

  assert.deepEqual(admin.errors, []);
  assert.deepEqual(student.errors, []);
  await admin.context().close();
  await student.context().close();
});
