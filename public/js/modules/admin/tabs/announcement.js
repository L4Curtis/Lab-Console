/**
 * Administration › Announcement: one message shown in a banner to everyone
 * signed in, at once (open pages included), until it is removed or its time
 * is over. Plain text only
 */
import { h, icon, toast } from '../../../core/dom.js';
import { request, getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { fmtLong } from '../../../core/format.js';

export function mount(el, ctx) {
  const text = h('textarea.field', { id: 'announcement-text', rows: 4, maxlength: 500 });
  const level = h('select.field', { id: 'announcement-level' }, ['info', 'warning'].map((v) => h('option', { value: v, dataset: { level: v } })));
  const hours = h('select.field', { id: 'announcement-hours' }, ['', '1', '4', '12', '24', '72', '168'].map((v) => h('option', { value: v, dataset: { hours: v } })));
  const current = h('div.announcement-current');
  const status = h('p.form-error', { role: 'alert' });
  const form = h('form.card.sso-form', { novalidate: true },
    h('div.form-grid',
      h('div.fld', h('label', { for: 'announcement-text', dataset: { text: 'text' } }), text, h('small.hint', { dataset: { text: 'textHint' } })),
      h('div.announcement-options',
        h('div.fld', h('label', { for: 'announcement-level', dataset: { text: 'level' } }), level),
        h('div.fld', h('label', { for: 'announcement-hours', dataset: { text: 'duration' } }), hours)),
      status));
  el.append(h('div.admin-page.sso-panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), current, form));

  let shown = null;

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.announcement.${node.dataset.text}`);
    for (const o of level.options) o.textContent = t(`admin.announcement.levels.${o.dataset.level}`);
    for (const o of hours.options) o.textContent = o.dataset.hours ? t('admin.announcement.hours', { count: Number(o.dataset.hours) }) : t('admin.announcement.untilRemoved');
    current.replaceChildren(shown
      ? h('div.announcement-preview', { dataset: { level: shown.level }, role: 'status' }, icon(shown.level === 'warning' ? 'warning' : 'info'),
        h('div', h('strong', t('admin.announcement.current')), h('p.announcement-text', shown.text),
          h('span.muted', shown.expiresAt ? t('admin.announcement.until', { date: fmtLong(shown.expiresAt) }) : t('admin.announcement.noEnd'))))
      : h('p.muted.small-note', t('admin.announcement.nothing')));
    ctx.setHeader(ctx.tab, {
      context: () => (shown ? t('admin.announcement.live') : t('admin.announcement.nothing')),
      primary: { id: 'publish', label: 'admin.announcement.publish', icon: 'send', run: () => form.requestSubmit() },
      actions: [{ id: 'remove', label: 'admin.announcement.remove', icon: 'trash', danger: true, disabled: !shown, run: removeNow }],
    });
  }

  async function load() {
    try {
      ({ announcement: shown } = await getJson('/api/admin/announcement'));
      if (shown) { text.value = shown.text; level.value = shown.level; }
      status.textContent = '';
    } catch (err) {
      status.textContent = err.message;
    }
    render();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    try {
      ({ announcement: shown } = await request('PUT', '/api/admin/announcement', { text: text.value, level: level.value, hours: hours.value || null }));
      toast(t('admin.announcement.published'));
    } catch (err) {
      status.textContent = err.message;
    } finally {
      render();
    }
  });
  async function removeNow() {
    try {
      await request('DELETE', '/api/admin/announcement');
      shown = null;
      text.value = '';
      toast(t('admin.announcement.removed'));
    } catch (err) {
      status.textContent = err.message;
    }
    render();
  }

  onLocaleChange(render);
  render();
  return { show: load };
}
