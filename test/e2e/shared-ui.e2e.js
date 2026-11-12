/**
 * Front-end runtime in a real browser: the app shell boots with the session
 * and the language, and the shared helpers behave (dialogs: focus trap,
 * Escape, ARIA, typed confirmation; tabs: lazy loading, keyboard, address)
 *
 * Self-contained on purpose: it starts the application itself (ephemeral
 * port, an administrator's session opened by the test helper and handed to
 * the browser as its cookie) and drives the system Chromium through
 * playwright-core. Nothing here needs the mock lab
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startTestApp } from '../helpers/app.js';

let lab;
let browser;
let page;
const pageErrors = [];

before(async () => {
  lab = await startTestApp();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: lab.deps.auth.cookieName, value: lab.signIn('admin').token, url: lab.url, httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  await page.goto(lab.url);
  await page.waitForSelector('#rail-items .rail-btn');
});
after(async () => {
  await browser?.close();
  await lab?.close();
});

/** Our dialogs are removed from the page once closed (the app shell has a <dialog> of its own) */
const gone = () => page.locator('dialog.modal').waitFor({ state: 'detached' });
const activeText = () => page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.tagName);

test('boot: session and language are loaded before the screens, without errors', async () => {
  assert.equal(await page.getAttribute('html', 'lang'), 'fr', 'DEFAULT_LOCALE on a first visit');
  const state = await page.evaluate(async () => {
    const { session } = await import('/js/core/session.js');
    const { t, getLocale } = await import('/js/core/i18n.js');
    return { user: session.user.id, isAdmin: session.isAdmin, loaded: session.loaded, locale: getLocale(), cancel: t('common.actions.cancel') };
  });
  assert.deepEqual(state, { user: 'oidc:admin', isAdmin: true, loaded: true, locale: 'fr', cancel: 'Annuler' });
  assert.equal(await page.locator('#rail-items .rail-btn').count(), 2, 'the existing sections are still there');
  await page.waitForSelector('section.view-consoles svg');
  assert.ok(await page.locator('section.view-consoles svg').count() > 0, 'the consoles screen rendered its diagram');
  assert.deepEqual(pageErrors, []);
});

test('i18n: setLocale persists, updates <html lang> and static markup, and survives a reload', async () => {
  const result = await page.evaluate(async () => {
    const { setLocale, t } = await import('/js/core/i18n.js');
    const probe = document.createElement('span');
    probe.id = 'i18n-probe';
    probe.dataset.i18n = 'common.actions.close';
    probe.dataset.i18nTitle = 'common.actions.cancel';
    document.body.append(probe);
    await setLocale('en');
    return { text: probe.textContent, title: probe.title, lang: document.documentElement.lang, cancel: t('common.actions.cancel'), stored: localStorage.getItem('labconsole.locale') };
  });
  assert.deepEqual(result, { text: 'Close', title: 'Cancel', lang: 'en', cancel: 'Cancel', stored: '"en"' });
  await page.reload();
  await page.waitForSelector('#rail-items .rail-btn');
  assert.equal(await page.getAttribute('html', 'lang'), 'en', 'the choice wins over the server default');
  await page.evaluate(async () => { const { setLocale } = await import('/js/core/i18n.js'); await setLocale('fr'); });
});

test('loadCss: one <link> per stylesheet, resolved once the rules apply', async () => {
  const result = await page.evaluate(async () => {
    const { loadCss } = await import('/js/core/dom.js');
    const [a, b] = await Promise.all([loadCss('shared'), loadCss('shared')]);
    const missing = await loadCss('does-not-exist');
    return { a, b, missing, links: document.querySelectorAll('link[href="/css/shared.css"]').length };
  });
  assert.deepEqual(result, { a: true, b: true, missing: false, links: 1 });
});

test('confirmDialog: modal, labelled, Escape answers no, focus comes back', async () => {
  await page.evaluate(async () => {
    const { confirmDialog } = await import('/js/shared/dialog.js');
    document.getElementById('theme-toggle').focus();
    window.__answer = 'pending';
    confirmDialog({ title: 'Libérer la baie B4M ?', body: 'Les consoles ouvertes seront fermées.', confirmLabel: 'Libérer' }).then((v) => { window.__answer = v; });
  });
  const dlg = page.locator('dialog.modal[open]');
  await dlg.waitFor();
  assert.equal(await dlg.getAttribute('aria-modal'), 'true');
  const labelledBy = await dlg.getAttribute('aria-labelledby');
  assert.equal(await page.locator(`#${labelledBy}`).textContent(), 'Libérer la baie B4M ?');
  const describedBy = await dlg.getAttribute('aria-describedby');
  assert.equal(await page.locator(`#${describedBy}`).textContent(), 'Les consoles ouvertes seront fermées.');
  assert.equal(await dlg.evaluate((el) => el.matches(':modal')), true, 'the page behind is inert');
  assert.equal(await activeText(), 'Libérer', 'focus starts on the confirm button');
  assert.equal(await dlg.locator('[data-action="cancel"]').textContent(), 'Annuler', 'default labels are translated');
  assert.equal(await dlg.locator('.modal-head .icon-btn').getAttribute('aria-label'), 'Fermer');

  await page.keyboard.press('Escape');
  await gone();
  assert.equal(await page.evaluate(() => window.__answer), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'theme-toggle', 'focus returns to the opener');
  assert.equal(await page.locator('dialog.modal').count(), 0, 'the dialog is removed from the page');
});

test('confirmDialog: Enter confirms, Cancel and the close button refuse', async () => {
  const ask = () => page.evaluate(async () => {
    const { confirmDialog } = await import('/js/shared/dialog.js');
    window.__answer = 'pending';
    confirmDialog({ title: 'Question', body: ['Ligne 1', 'Ligne 2'] }).then((v) => { window.__answer = v; });
  });
  const answer = async () => { await gone(); return page.evaluate(() => window.__answer); };

  await ask();
  assert.equal(await page.locator('dialog[open] .dialog-text p').count(), 2);
  await page.keyboard.press('Enter');
  assert.equal(await answer(), true);
  await ask();
  await page.locator('dialog[open] [data-action="cancel"]').click();
  assert.equal(await answer(), false);
  await ask();
  await page.locator('dialog[open] .modal-head .icon-btn').click();
  assert.equal(await answer(), false);
});

test('confirmDialog: Tab and Shift+Tab stay inside the dialog', async () => {
  await page.evaluate(async () => {
    const { confirmDialog } = await import('/js/shared/dialog.js');
    confirmDialog({ title: 'Piège', body: 'x', confirmLabel: 'Oui', cancelLabel: 'Non' });
  });
  await page.locator('dialog[open]').waitFor();
  const inside = () => page.evaluate(() => document.querySelector('dialog[open]').contains(document.activeElement));
  const seen = [];
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await inside(), true, `Tab #${i + 1}`);
    seen.push(await page.evaluate(() => document.activeElement.dataset.action || document.activeElement.className));
  }
  assert.deepEqual(seen.slice(0, 3), ['icon-btn', 'cancel', 'confirm'], 'wraps from the last control to the first');
  assert.equal(new Set(seen).size, 3);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await inside(), true, `Shift+Tab #${i + 1}`);
  }
  await page.keyboard.press('Escape');
  await gone();
});

test('confirmDialog danger + requireText: alertdialog, focus on the input, locked until the exact text is typed', async () => {
  await page.evaluate(async () => {
    const { confirmDialog } = await import('/js/shared/dialog.js');
    window.__answer = 'pending';
    confirmDialog({ title: 'Réinitialiser la baie', body: 'Tout sera effacé.', confirmLabel: 'Réinitialiser', danger: true, requireText: 'B4M' }).then((v) => { window.__answer = v; });
  });
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor();
  assert.equal(await dlg.getAttribute('role'), 'alertdialog');
  const confirm = dlg.locator('[data-action="confirm"]');
  const input = dlg.locator('input.field');
  assert.equal(await confirm.isDisabled(), true);
  assert.ok((await confirm.getAttribute('class')).includes('danger-solid'));
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
  assert.equal(await dlg.locator('.require-text span').textContent(), 'Tapez B4M pour confirmer');
  assert.equal(await input.getAttribute('aria-describedby'), await dlg.locator('.require-text span').getAttribute('id'));

  await input.fill('b4m');
  assert.equal(await confirm.isDisabled(), true, 'case matters');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__answer), 'pending', 'Enter does nothing while locked');
  await input.fill('B4');
  assert.equal(await confirm.isDisabled(), true);
  await input.fill('B4M');
  assert.equal(await confirm.isDisabled(), false);
  await page.keyboard.press('Enter');
  await gone();
  assert.equal(await page.evaluate(() => window.__answer), true);
});

test('confirmDialog danger without typed text: focus starts on Cancel', async () => {
  await page.evaluate(async () => {
    const { confirmDialog } = await import('/js/shared/dialog.js');
    confirmDialog({ title: 'Supprimer', body: 'x', danger: true });
  });
  await page.locator('dialog[open]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'cancel');
  await page.keyboard.press('Escape');
  await gone();
});

test('dialog text is text: markup in a title or a body is never interpreted', async () => {
  await page.evaluate(async () => {
    const { confirmDialog } = await import('/js/shared/dialog.js');
    confirmDialog({ title: '<img src=x onerror="window.__xss=1">', body: '<b id="injected">bold</b>', requireText: '<i>x</i>' });
  });
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor();
  assert.equal(await dlg.locator('#injected, img, i').count(), 0);
  assert.equal(await dlg.locator('h2').textContent(), '<img src=x onerror="window.__xss=1">');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.keyboard.press('Escape');
  await gone();
});

test('formDialog: typed values, validation, async submit with error, cancel gives null', async () => {
  await page.evaluate(async () => {
    const { formDialog } = await import('/js/shared/dialog.js');
    window.__calls = [];
    window.__answer = 'pending';
    formDialog({
      title: 'Nouvelle sauvegarde',
      intro: 'Donne-lui un nom.',
      submitLabel: 'Sauvegarder',
      fields: [
        { name: 'label', label: 'Nom', required: true, placeholder: 'tp3-ospf', hint: 'Lettres et chiffres' },
        { name: 'copies', label: 'Copies', type: 'number', value: 2, attrs: { min: 1, max: 5 } },
        { name: 'scope', label: 'Portée', type: 'select', value: 'bench', options: [{ value: 'device', label: 'Un équipement' }, { value: 'bench', label: 'Toute la baie' }] },
        { name: 'notes', label: 'Notes', type: 'textarea' },
        { name: 'save', label: 'copy run start', type: 'checkbox', value: true },
        { name: 'secret', label: 'Mot de passe enable', type: 'password' },
      ],
      validate: (v) => (v.label.length < 3 ? 'Nom trop court' : null),
      onSubmit: async (v) => {
        window.__calls.push(v);
        if (window.__calls.length === 1) throw new Error('La baie est occupée');
      },
    }).then((v) => { window.__answer = v; });
  });
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.name), 'label', 'focus on the first field');
  assert.equal(await dlg.locator('label:has([name="label"]) small').textContent(), 'Lettres et chiffres');
  assert.equal(await dlg.locator('[name="scope"]').inputValue(), 'bench');
  const submit = dlg.locator('[data-action="confirm"]');
  const error = dlg.locator('.form-error');
  assert.equal(await error.getAttribute('role'), 'alert');

  await submit.click();
  assert.equal(await page.evaluate(() => window.__calls.length), 0, 'the browser refuses an empty required field');
  await dlg.locator('[name="label"]').fill('  ab ');
  await submit.click();
  assert.equal(await error.textContent(), 'Nom trop court');
  await dlg.locator('[name="label"]').fill('  tp3-ospf ');
  await dlg.locator('[name="secret"]').fill(' cisco ');
  await dlg.locator('[name="notes"]').fill('ligne 1\nligne 2');
  await page.keyboard.press('Enter'); // from the notes textarea: a new line, not a submit
  await dlg.locator('[name="label"]').press('Enter');
  await page.waitForFunction(() => document.querySelector('dialog[open] .form-error').textContent !== '');
  assert.equal(await error.textContent(), 'La baie est occupée', 'a failed submit keeps the dialog open with the reason');
  assert.equal(await submit.isDisabled(), false);

  await submit.click();
  await gone();
  const expected = { label: 'tp3-ospf', copies: 2, scope: 'bench', notes: 'ligne 1\nligne 2\n', save: true, secret: ' cisco ' };
  assert.deepEqual(await page.evaluate(() => window.__answer), expected, 'text is trimmed, passwords are not, numbers are numbers');
  assert.deepEqual(await page.evaluate(() => window.__calls), [expected, expected]);

  await page.evaluate(async () => {
    const { formDialog } = await import('/js/shared/dialog.js');
    window.__answer = 'pending';
    formDialog({ title: 'x', fields: [{ name: 'a', label: 'A' }] }).then((v) => { window.__answer = v; });
  });
  await page.locator('dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await gone();
  assert.equal(await page.evaluate(() => window.__answer), null);
});

test('openDialog: custom content, close(value), not dismissible when asked', async () => {
  await page.evaluate(async () => {
    const { openDialog } = await import('/js/shared/dialog.js');
    const { h } = await import('/js/core/dom.js');
    const dlg = openDialog(h('div.modal-body', h('p', 'Compte à rebours'), h('button.btn#stop', { type: 'button', onclick: () => dlg.close('stopped') }, 'Arrêter')),
      { label: 'Compte à rebours', dismissible: false, initialFocus: '#stop' });
    window.__answer = 'pending';
    dlg.closed.then((v) => { window.__answer = v; });
  });
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor();
  assert.equal(await dlg.getAttribute('aria-label'), 'Compte à rebours');
  assert.equal(await dlg.locator('.modal-head').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'stop');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await dlg.count(), 1, 'Escape is refused');
  await page.locator('#stop').click();
  await gone();
  assert.equal(await page.evaluate(() => window.__answer), 'stopped');
});

test('tabs: lazy mount, show/hide, keyboard, address, role filter, language', async () => {
  await page.evaluate(async () => {
    const { mountTabs } = await import('/js/shared/tabs.js');
    const { t } = await import('/js/core/i18n.js');
    const host = document.createElement('div');
    host.id = 'tabs-host';
    document.body.append(host);
    const log = [];
    const nav = [];
    const screen = (name) => async () => ({
      mount(el, ctx) {
        log.push(`mount:${name}`);
        el.append(Object.assign(document.createElement('p'), { textContent: `${name}:${ctx.tab}:${ctx.bench}` }));
        return { show: (params) => log.push(`show:${name}:${params.join('/')}`), hide: () => log.push(`hide:${name}`) };
      },
    });
    window.__tabs = mountTabs(host, [
      { id: 'sessions', title: () => t('common.actions.close'), load: screen('sessions') },
      { id: 'audit', title: 'Journal', load: screen('audit') },
      { id: 'secret', title: 'Secret', load: screen('secret'), when: () => false },
      { id: 'broken', title: 'Cassé', load: async () => { throw new Error('chunk missing'); } },
    ], { navigate: (hash) => nav.push(hash), base: '#/admin', label: 'Administration', ctx: { bench: 'B4M' } });
    window.__log = log;
    window.__nav = nav;
  });
  const log = () => page.evaluate(() => window.__log.splice(0));
  const tab = (id) => page.locator(`#tabs-host [role="tab"][data-tab="${id}"]`);
  const panelOf = async (id) => page.locator(`#${await tab(id).getAttribute('aria-controls')}`);

  assert.deepEqual(await page.locator('#tabs-host [role="tab"]').allTextContents(), ['Fermer', 'Journal', 'Cassé'], 'the hidden tab is not rendered');
  assert.equal(await page.locator('#tabs-host [role="tablist"]').getAttribute('aria-label'), 'Administration');
  assert.deepEqual(await log(), [], 'nothing is loaded before the section is shown');

  await page.evaluate(() => window.__tabs.show([]));
  assert.deepEqual(await log(), ['mount:sessions', 'show:sessions:']);
  assert.equal(await tab('sessions').getAttribute('aria-selected'), 'true');
  assert.equal(await tab('audit').getAttribute('aria-selected'), 'false');
  assert.equal(await (await panelOf('sessions')).textContent(), 'sessions:sessions:B4M');
  assert.equal(await (await panelOf('sessions')).getAttribute('role'), 'tabpanel');
  assert.equal(await (await panelOf('sessions')).getAttribute('aria-labelledby'), await tab('sessions').getAttribute('id'));
  assert.equal(await (await panelOf('audit')).isHidden(), true);
  assert.deepEqual(await page.evaluate(() => window.__nav), [], 'showing from the address does not rewrite it');

  await tab('audit').click();
  await page.waitForFunction(() => window.__log.includes('show:audit:'));
  assert.deepEqual(await log(), ['hide:sessions', 'mount:audit', 'show:audit:']);
  assert.deepEqual(await page.evaluate(() => window.__nav.splice(0)), ['#/admin/audit']);
  assert.equal(await (await panelOf('sessions')).isHidden(), true);
  assert.equal(await (await panelOf('audit')).isVisible(), true);

  await tab('sessions').click();
  await page.waitForFunction(() => window.__log.includes('show:sessions:'));
  assert.deepEqual(await log(), ['hide:audit', 'show:sessions:'], 'a tab is mounted once and keeps its state');

  // Address-driven: #/admin/audit/2026-11 → show(['audit', '2026-11'])
  await page.evaluate(() => window.__tabs.show(['audit', '2026-11']));
  assert.deepEqual(await log(), ['hide:sessions', 'show:audit:2026-11']);
  assert.equal(await page.evaluate(() => window.__tabs.current), 'audit');
  await page.evaluate(() => window.__tabs.show(['nope']));
  assert.deepEqual(await log(), ['show:audit:'], 'an unknown tab keeps the current one');
  await page.evaluate(() => window.__tabs.hide());
  assert.deepEqual(await log(), ['hide:audit']);
  await page.evaluate(() => window.__tabs.show(['audit']));
  await log();

  // Keyboard: arrows move and select, only the selected tab is in the Tab order
  await tab('audit').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'sessions');
  assert.equal(await tab('sessions').getAttribute('aria-selected'), 'true');
  assert.deepEqual([await tab('sessions').getAttribute('tabindex'), await tab('audit').getAttribute('tabindex')], ['0', '-1']);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'broken', 'wraps around');
  await page.waitForSelector('#tabs-host .tab-error');
  assert.equal(await page.locator('#tabs-host .tab-error').textContent(), 'Impossible de charger cet écran. Rechargez la page.');
  assert.equal(await page.locator('#tabs-host .tab-error').getAttribute('role'), 'alert');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'sessions');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'broken');

  // A title given as a function follows the language
  await page.evaluate(async () => { const { setLocale } = await import('/js/core/i18n.js'); await setLocale('en', { persist: false }); });
  assert.deepEqual(await page.locator('#tabs-host [role="tab"]').allTextContents(), ['Close', 'Journal', 'Cassé']);
  await page.evaluate(async () => { const { setLocale } = await import('/js/core/i18n.js'); await setLocale('fr', { persist: false }); window.__tabs.destroy(); });
  assert.equal(await page.locator('#tabs-host [role="tab"]').count(), 0);
});

test('no error was logged by the page during the whole run', () => {
  // Two failures are provoked on purpose above: the broken tab and the missing stylesheet
  const expected = ['[tabs] broken', 'does-not-exist.css'];
  assert.deepEqual(pageErrors.filter((m) => !expected.some((e) => m.includes(e))), []);
});
