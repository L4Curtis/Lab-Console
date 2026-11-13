/**
 * Administration › Announcement: one message shown in a banner to everyone
 * signed in, at once (open pages included), until it is removed or its time
 * is over. Plain text only
 */
import { h, toast } from '../../../core/dom.js';
import { request, getJson } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { formatDate, errorText } from '../common.js';

export function mount(el) {
  const text = h('textarea.field', { id: 'announcement-text', rows: 3, maxlength: 500 });
  const level = h('select.field', { id: 'announcement-level' }, ['info', 'warning'].map((v) => h('option', { value: v, dataset: { level: v } })));
  const hours = h('select.field', { id: 'announcement-hours' }, ['', '1', '4', '12', '24', '72', '168'].map((v) => h('option', { value: v, dataset: { hours: v } })));
  const publish = h('button.btn.primary', { type: 'submit', dataset: { action: 'publish' } });
  const remove = h('button.btn.danger', { type: 'button', dataset: { action: 'remove' } });
  const current = h('div.announcement-current');
  const status = h('p.form-error', { role: 'alert' });
  const form = h('form.sso-form',
    h('div.sso-row', h('label', { for: 'announcement-text', dataset: { text: 'text' } }), text, h('small.hint', { dataset: { text: 'textHint' } })),
    h('div.announcement-options',
      h('div.sso-row', h('label', { for: 'announcement-level', dataset: { text: 'level' } }), level),
      h('div.sso-row', h('label', { for: 'announcement-hours', dataset: { text: 'duration' } }), hours)),
    status,
    h('div.form-actions', remove, publish));
  el.append(h('div.panel.sso-panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), current, form));

  let shown = null;

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.announcement.${node.dataset.text}`);
    for (const o of level.options) o.textContent = t(`admin.announcement.levels.${o.dataset.level}`);
    for (const o of hours.options) o.textContent = o.dataset.hours ? t('admin.announcement.hours', { count: Number(o.dataset.hours) }) : t('admin.announcement.untilRemoved');
    publish.textContent = t('admin.announcement.publish');
    remove.textContent = t('admin.announcement.remove');
    remove.disabled = !shown;
    current.replaceChildren(shown
      ? h('p.notice', { dataset: { level: shown.level } }, h('strong', t('admin.announcement.current')), ' ', shown.text, ' ',
        h('span.muted', shown.expiresAt ? t('admin.announcement.until', { date: formatDate(shown.expiresAt) }) : t('admin.announcement.noEnd')))
      : h('p.muted.small-note', t('admin.announcement.nothing')));
  }

  async function load() {
    try {
      ({ announcement: shown } = await getJson('/api/admin/announcement'));
      if (shown) { text.value = shown.text; level.value = shown.level; }
      status.textContent = '';
    } catch (err) {
      status.textContent = errorText(err);
    }
    render();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    publish.disabled = true;
    status.textContent = '';
    try {
      ({ announcement: shown } = await request('PUT', '/api/admin/announcement', { text: text.value, level: level.value, hours: hours.value || null }));
      toast(t('admin.announcement.published'));
    } catch (err) {
      status.textContent = errorText(err);
    } finally {
      publish.disabled = false;
      render();
    }
  });
  remove.addEventListener('click', async () => {
    try {
      await request('DELETE', '/api/admin/announcement');
      shown = null;
      text.value = '';
      toast(t('admin.announcement.removed'));
    } catch (err) {
      status.textContent = errorText(err);
    }
    render();
  });

  onLocaleChange(render);
  render();
  return { show: load };
}
