/**
 * The announcement banner: one message an administrator shows to everyone
 * signed in ("bench 5 is out of order this morning"), until it is removed or
 * until the time it was given ends
 *
 * Kept in the database (table announcements, through repos.announcements:
 * the current one and the last ones; the 20 last are kept in memory, read by
 * load() in the module's start()) and pushed to every open page through the sticky SSE topic
 * `admin:announcement` (null when there is none). Text only: the browser
 * renders it as text, never as HTML.
 */
import { httpError } from '../../lib/httpError.js';

export const LEVELS = ['info', 'warning'];
const MAX_TEXT = 500;
const MAX_HOURS = 24 * 30;

const KEPT = 20;

export function createAnnouncements({ repos, events, audit, logger, now = Date.now }) {
  const log = logger ?? { info() {} };
  let recent = []; // newest first, with their ids and whether they were taken down
  let timer = null;

  const view = ({ text, level, at, expiresAt, by }) => ({ text, level, at, expiresAt, by });
  /** The newest one, unless it was taken down: an announcement is replaced by the next, or removed */
  const latest = () => (recent[0] && !recent[0].removedAt ? recent[0] : null);

  const live = () => {
    const current = latest();
    if (!current) return null;
    if (current.expiresAt && Date.parse(current.expiresAt) <= now()) return null;
    return view(current);
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
    const id = await repos.announcements.add(announcement);
    recent = [{ ...announcement, id, removedAt: null }, ...recent].slice(0, KEPT);
    audit.log(req, 'admin.announcement.publish', { level, expiresAt, length: text.length });
    log.info(`announcement published by ${req.user.id}`);
    publish();
    return announcement;
  }

  async function clear(req) {
    const had = live();
    const current = latest();
    if (current) {
      const at = new Date(now()).toISOString();
      await repos.announcements.remove(current.id, at);
      recent = recent.map((a) => (a.id === current.id ? { ...a, removedAt: at } : a));
    }
    if (had) audit.log(req, 'admin.announcement.remove', {});
    publish();
  }

  publish();
  return {
    /** Read the last announcements from the database (the module's start()) */
    async load() {
      recent = await repos.announcements.recent(KEPT);
      publish();
    },
    current: live,
    history: () => recent.map(view),
    set,
    clear,
    shutdown: () => clearTimeout(timer),
  };
}
