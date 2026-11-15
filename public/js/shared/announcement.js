/**
 * The announcement an administrator published (Administration › Annonce),
 * live, as text (docs/v2/UX.md §5.5): one line at the top of the section on
 * screen, under its header, never above it and never over the content.
 * Clamped to two lines with "Lire" to show the rest; ✕ hides that
 * announcement in this browser (a new one shows again)
 *
 *   const banner = mountAnnouncement();   // main.js, once
 *   banner.place(sectionEl);              // main.js, whenever a section comes on screen
 */
import { h, icon, prefs } from '../core/dom.js';
import { live } from '../core/api.js';
import { t, onLocaleChange } from '../core/i18n.js';

const PREF = 'announcementDismissed';

export function mountAnnouncement(container = document.body) {
  const text = h('span.announcement-text');
  const more = h('button.btn.ghost.sm.announcement-more', { type: 'button', hidden: true });
  const close = h('button.icon-btn.announcement-close', { type: 'button' }, icon('close'));
  const lead = icon('info');
  const banner = h('div.announcement-banner', { role: 'status', hidden: true }, lead, text, more, close);
  container.prepend(banner);
  let current = null;

  const label = () => {
    close.title = t('common.announcement.hide');
    close.setAttribute('aria-label', t('common.announcement.hide'));
    more.textContent = banner.classList.contains('expanded') ? t('common.announcement.less') : t('common.announcement.more');
  };
  /** "Lire" only when the text does not fit in its two lines */
  const measure = () => {
    if (banner.hidden || banner.classList.contains('expanded')) return;
    more.hidden = text.scrollHeight <= text.clientHeight + 1;
  };
  more.addEventListener('click', () => {
    banner.classList.toggle('expanded');
    more.setAttribute('aria-expanded', String(banner.classList.contains('expanded')));
    label();
  });
  close.addEventListener('click', () => {
    if (current?.at) prefs.set(PREF, current.at);
    banner.hidden = true;
  });
  live.on('admin:announcement', (announcement) => {
    current = announcement;
    text.textContent = announcement?.text ?? '';
    const level = announcement?.level ?? 'info';
    banner.dataset.level = level;
    lead.innerHTML = icon(level === 'warning' ? 'warning' : 'info').innerHTML; // static markup of the icon set
    banner.classList.remove('expanded');
    banner.hidden = !announcement || prefs.get(PREF, null) === announcement.at;
    label();
    requestAnimationFrame(measure);
  });
  onLocaleChange(label);
  addEventListener('resize', () => requestAnimationFrame(measure));
  label();

  return {
    el: banner,
    /** Put the banner at the top of `section`, under its header when it has one */
    place(section) {
      if (!section) return;
      const header = section.querySelector(':scope > .page-header, :scope > .view-head');
      if (header) header.after(banner);
      else section.prepend(banner);
      requestAnimationFrame(measure);
    },
  };
}
