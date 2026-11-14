/**
 * The script library in the browser (server side: src/modules/scripts/).
 *
 *   const script = await openScriptLibrary();            // pick one: { id, title, body, … } or null
 *   await openScriptLibrary({ pick: false });            // only look after it: create, edit, delete
 *   await saveToLibrary({ body });                       // keep a text under a title, on a shelf
 *
 * Three shelves: mine (nobody else sees it), my team's, and the ones the
 * administrators publish. The server decides who sees and changes what; this
 * only hides the buttons a person cannot use. Used by the inject dialog, the
 * "send to several consoles" dialog and the consoles section's own button
 */
import { h, icon, toast, loadCss } from '../core/dom.js';
import { getJson, request } from '../core/api.js';
import { t, tNode, tAttr, loadNamespace, onLocaleChange, getLocale } from '../core/i18n.js';
import { openDialog, formDialog, confirmDialog } from './dialog.js';

const SHELVES = ['personal', 'team', 'published'];

/** The shelves a person may put a script on, as <select> options */
function shelfOptions(data) {
  return SHELVES
    .filter((scope) => scope === 'personal' || (scope === 'team' && data.team) || (scope === 'published' && data.canPublish))
    .map((scope) => ({ value: scope, label: t(`scripts.scope.${scope}`, { team: data.team?.name ?? '' }) }));
}

/** Keep `body` in the library: asks for a title, a description and the shelf. → the saved script, or null */
export async function saveToLibrary({ body, title = '' }) {
  await Promise.all([loadNamespace('scripts'), loadCss('terminal')]);
  const data = await getJson('/api/scripts');
  const saved = await formDialog({
    title: t('scripts.save.title'),
    fields: [
      { name: 'title', label: t('scripts.fields.title'), required: true, value: title, attrs: { maxlength: data.limits.title } },
      { name: 'description', label: t('scripts.fields.description'), type: 'textarea', hint: t('scripts.fields.descriptionHint'), attrs: { rows: 2, maxlength: data.limits.description } },
      { name: 'scope', label: t('scripts.fields.shelf'), type: 'select', options: shelfOptions(data), value: 'personal' },
    ],
    submitLabel: t('scripts.save.submit'),
    onSubmit: async (values) => (await request('POST', '/api/scripts', { ...values, body })).script,
  });
  if (saved) toast(t('scripts.save.done', { title: saved.title }));
  return saved;
}

export async function openScriptLibrary({ pick = true } = {}) {
  await Promise.all([loadNamespace('scripts'), loadCss('terminal')]);
  let data = { scripts: [], team: null, canPublish: false, limits: {} };
  let filter = '';
  let failure = '';

  const search = h('input.field', { type: 'search', autocomplete: 'off', ...tAttr('placeholder', 'scripts.library.search'), ...tAttr('aria-label', 'scripts.library.search') });
  const create = h('button.btn.small', { type: 'button', onclick: () => edit(null) }, icon('plus'), tNode('scripts.library.new'));
  const list = h('div.lib-list');
  const body = h('div.modal-body.lib', h('div.lib-bar', search, create), list);
  const dlg = openDialog(body, { title: t(pick ? 'scripts.library.titlePick' : 'scripts.library.title'), wide: true, initialFocus: search });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); render(); });

  const when = (iso) => new Date(iso).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

  async function load() {
    try {
      data = await getJson('/api/scripts');
      failure = '';
    } catch (err) {
      failure = err.message;
    }
    render();
  }

  /** An administrator sees every team's scripts: say whose */
  const teamNote = (s) => (s.team && s.team.id !== data.team?.id
    ? ` · ${s.team.name ? t('scripts.library.otherTeam', { team: s.team.name }) : t('scripts.library.noTeam')}` : '');

  function row(s) {
    const use = h('button.btn.small.primary', { type: 'button', dataset: { action: 'use' }, onclick: () => choose(s) }, tNode('scripts.library.use'));
    const buttons = [
      pick ? use : null,
      s.canEdit ? h('button.icon-btn', { type: 'button', dataset: { action: 'edit' }, ...tAttr('title', 'scripts.library.edit'), onclick: () => edit(s) }, icon('edit')) : null,
      s.canEdit ? h('button.icon-btn', { type: 'button', dataset: { action: 'delete' }, ...tAttr('title', 'scripts.library.delete'), onclick: () => remove(s) }, icon('trash')) : null,
    ];
    return h('li.lib-item', { dataset: { id: s.id } },
      h('div.lib-main',
        h('strong.lib-title', s.title),
        s.description ? h('span.lib-description', s.description) : null,
        h('span.lib-meta', t('scripts.library.meta', { count: s.lines, name: s.author.name, date: when(s.updatedAt) }), teamNote(s))),
      h('div.lib-actions', buttons));
  }

  function render() {
    if (failure) { list.replaceChildren(h('p.form-error', { role: 'alert' }, failure)); return; }
    const shown = data.scripts.filter((s) => !filter || `${s.title} ${s.description}`.toLowerCase().includes(filter));
    const groups = SHELVES.map((scope) => {
      const mine = shown.filter((s) => s.scope === scope);
      if (!mine.length) return null;
      return h('section.lib-shelf', { dataset: { scope } },
        h('h3', t(`scripts.scope.${scope === 'team' && !data.team ? 'teamAdmin' : scope}`, { team: data.team?.name ?? '' })),
        h('ul', mine.map(row)));
    }).filter(Boolean);
    list.replaceChildren(...(groups.length ? groups : [h('p.muted', t(data.scripts.length ? 'scripts.library.noMatch' : 'scripts.library.empty'))]));
  }

  async function choose(s) {
    try {
      dlg.close((await getJson(`/api/scripts/${encodeURIComponent(s.id)}`)).script);
    } catch (err) {
      toast(err.message, 'error');
      load();
    }
  }

  /** The editor of one script (a new one when `s` is null) */
  async function edit(s) {
    let current = s;
    if (s) {
      try {
        current = (await getJson(`/api/scripts/${encodeURIComponent(s.id)}`)).script;
      } catch (err) {
        toast(err.message, 'error');
        load();
        return;
      }
    }
    const limits = data.limits;
    const done = await formDialog({
      title: t(current ? 'scripts.edit.title' : 'scripts.edit.titleNew'),
      wide: true,
      fields: [
        { name: 'title', label: t('scripts.fields.title'), required: true, value: current?.title ?? '', attrs: { maxlength: limits.title } },
        { name: 'description', label: t('scripts.fields.description'), type: 'textarea', value: current?.description ?? '', attrs: { rows: 2, maxlength: limits.description } },
        ...(current ? [] : [{ name: 'scope', label: t('scripts.fields.shelf'), type: 'select', options: shelfOptions(data), value: 'personal' }]),
        { name: 'body', label: t('scripts.fields.body'), type: 'textarea', required: true, value: current?.body ?? '', hint: t('scripts.fields.bodyHint', { kb: limits.bodyKb }), attrs: { rows: 12, spellcheck: 'false', class: 'field script-input' } },
      ],
      submitLabel: t('scripts.edit.submit'),
      onSubmit: (values) => (current
        ? request('PATCH', `/api/scripts/${encodeURIComponent(current.id)}`, { ...values, updatedAt: current.updatedAt })
        : request('POST', '/api/scripts', values)),
    });
    if (done) toast(t('scripts.edit.done'));
    await load();
  }

  async function remove(s) {
    const sure = await confirmDialog({
      title: t('scripts.delete.title', { title: s.title }),
      body: t(s.scope === 'personal' ? 'scripts.delete.personal' : 'scripts.delete.shared'),
      confirmLabel: t('scripts.library.delete'),
      danger: true,
    });
    if (!sure) return;
    try {
      await request('DELETE', `/api/scripts/${encodeURIComponent(s.id)}`);
      toast(t('scripts.delete.done', { title: s.title }));
    } catch (err) {
      toast(err.message, 'error');
    }
    await load();
  }

  const offLocale = onLocaleChange(render);
  dlg.closed.then(offLocale);
  await load();
  return dlg.closed.then((value) => value ?? null);
}
