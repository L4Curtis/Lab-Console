/**
 * The announcement banner at the top of every page: the message an
 * administrator published (Administration › Announcement), live, as text.
 * The person may hide it for this page; a new announcement shows again
 */
import { h, icon } from '../core/dom.js';
import { live } from '../core/api.js';
import { t, onLocaleChange } from '../core/i18n.js';

export function mountAnnouncement(container = document.body) {
  const text = h('span.announcement-text');
  const close = h('button.icon-btn.announcement-close', { type: 'button' }, icon('close'));
  const banner = h('div.announcement-banner', { role: 'status', hidden: true }, icon('warning'), text, close);
  container.prepend(banner);
  let current = null;
  let dismissed = null;

  const label = () => {
    close.title = t('common.announcement.hide');
    close.setAttribute('aria-label', t('common.announcement.hide'));
  };
  close.addEventListener('click', () => {
    dismissed = current?.at ?? null;
    banner.hidden = true;
  });
  live.on('admin:announcement', (announcement) => {
    current = announcement;
    text.textContent = announcement?.text ?? '';
    banner.dataset.level = announcement?.level ?? 'info';
    banner.hidden = !announcement || dismissed === announcement.at;
  });
  onLocaleChange(label);
  label();
}
