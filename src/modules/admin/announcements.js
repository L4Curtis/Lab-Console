/**
 * The announcement banner: one message an administrator shows to everyone
 * signed in ("bench 5 is out of order this morning"), until it is removed or
 * until the time it was given ends
 *
 * Kept in data/admin/announcements.json ({ current, history }, the 20 last
 * ones) and pushed to every open page through the sticky SSE topic
 * `admin:announcement` (null when there is none). Text only: the browser
 * renders it as text, never as HTML.
 */
import { httpError } from '../../lib/httpError.js';

export const LEVELS = ['info', 'warning'];
const MAX_TEXT = 500;
const MAX_HOURS = 24 * 30;

export function createAnnouncements({ store, events, audit, logger, now = Date.now }) {
  const log = logger ?? { info() {} };
  const file = store.json('admin/announcements.json', { current: null, history: [] });
  let timer = null;

  const live = () => {
    const current = file.get().current;
    if (!current) return null;
    if (current.expiresAt && Date.parse(current.expiresAt) <= now()) return null;
    return current;
  };

  function publish() {
    clearTimeout(timer);
    const current = live();
    events?.publish('admin:announcement', current, { sticky: true });
    if (current?.expiresAt) {
      // The banner goes away by itself when its time is over
      timer = setTimeout(publish, Math.min(Date.parse(current.expiresAt) - now() + 50, 2 ** 31 - 1));
      timer.unref();
    }
  }

  /** { text, level, hours } → the announcement */
  async function set(input, req) {
    const text = typeof input?.text === 'string' ? input.text.trim().replace(/\r\n?/g, '\n') : '';
    if (!text) throw httpError(400, 'admin.announcement_empty', 'Write the announcement first');
    if (text.length > MAX_TEXT || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) throw httpError(400, 'admin.announcement_invalid', 'An announcement is plain text, 500 characters at most', { max: MAX_TEXT });
    const level = input.level ?? 'info';
    if (!LEVELS.includes(level)) throw httpError(400, 'admin.announcement_invalid', 'Unknown level');
    let expiresAt = null;
    if (input.hours !== undefined && input.hours !== null && input.hours !== '') {
      const hours = Number(input.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) throw httpError(400, 'admin.announcement_invalid', 'The duration is 1 hour to 30 days', { max: MAX_HOURS });
      expiresAt = new Date(now() + hours * 3_600_000).toISOString();
    }
    const announcement = { text, level, at: new Date(now()).toISOString(), expiresAt, by: { id: req.user.id, name: req.user.name || req.user.username } };
    await file.update((doc) => ({ current: announcement, history: [announcement, ...(doc.history ?? [])].slice(0, 20) }));
    audit.log(req, 'admin.announcement.publish', { level, expiresAt, length: text.length });
    log.info(`announcement published by ${req.user.id}`);
    publish();
    return announcement;
  }

  async function clear(req) {
    const had = live();
    await file.update((doc) => ({ ...doc, current: null }));
    if (had) audit.log(req, 'admin.announcement.remove', {});
    publish();
  }

  publish();
  return {
    current: live,
    history: () => file.get().history ?? [],
    set,
    clear,
    shutdown: () => clearTimeout(timer),
  };
}
