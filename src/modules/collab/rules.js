/**
 * What the collab module accepts, in one place: text that people type, and
 * the per-user brake on writing
 *
 * Everything people write here is plain text. It is stored as typed (after
 * the checks below) and shown by the browser as text, never as markup, so
 * there is nothing to strip: what is not acceptable is refused
 */
import { httpError } from '../../lib/httpError.js';

// Control characters other than newline and tab, and the characters that reorder what is shown
// (bidirectional overrides and isolates): a person cannot make a line read differently from what it says
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export const LIMITS = Object.freeze({
  noteChars: 2000,
  chatChars: 500,
  chatLines: 6,
  chatHistory: 200,        // messages kept per team and bench
  chatPerWindow: 10,       // messages a person may send...
  chatWindowMs: 20_000,    // ...in this time
  notePerWindow: 20,       // saves a person may make...
  noteWindowMs: 60_000,    // ...in this time
});

/**
 * A text from a request body, checked and normalised: line ends become \n,
 * the ends are trimmed. Throws a 400 `collab.bad_text` (not a string, or a
 * forbidden character), `collab.too_long` or `collab.too_many_lines`
 */
export function cleanText(raw, { max, maxLines = Infinity }) {
  if (typeof raw !== 'string') throw httpError(400, 'collab.bad_text', 'The text must be a string');
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (FORBIDDEN.test(text)) throw httpError(400, 'collab.bad_text', 'The text contains characters that are not allowed');
  if ([...text].length > max) throw httpError(400, 'collab.too_long', `The text is longer than ${max} characters`, { max });
  if (text.split('\n').length > maxLines) throw httpError(400, 'collab.too_many_lines', `The text has more than ${maxLines} lines`, { max: maxLines });
  return text;
}

/**
 * At most `limit` actions per person in any `windowMs`. hit(userId) returns 0
 * when the action may go ahead (and counts it), or the seconds to wait.
 * `now` is a seam for the tests
 */
export function createUserLimiter({ limit, windowMs, now = () => Date.now() }) {
  const times = new Map(); // userId → ms of the actions still inside the window
  return {
    hit(userId) {
      const at = now();
      const recent = (times.get(userId) ?? []).filter((ms) => at - ms < windowMs);
      if (recent.length >= limit) {
        times.set(userId, recent);
        return Math.max(1, Math.ceil((recent[0] + windowMs - at) / 1000));
      }
      recent.push(at);
      times.set(userId, recent);
      if (times.size > 1000) for (const [id, list] of times) if (!list.some((ms) => at - ms < windowMs)) times.delete(id);
      return 0;
    },
  };
}

/** The 429 for a person who writes too fast */
export const rateLimited = (seconds) => httpError(429, 'collab.rate_limited', `Too fast: wait ${seconds} s`, { seconds });
