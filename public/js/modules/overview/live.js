/**
 * A screen that stays up to date by itself: it reads an API, then reads it
 * again whenever one of the SSE topics it depends on moves (the topics the
 * benches, consoles, jobs and teams already publish, each with its own
 * audience, so nothing here widens who hears what)
 *
 *   const feed = followApi('/api/overview/benches', {
 *     topics: ['benches:state', 'consoles:rooms'],
 *     changed: { 'consoles:rooms': roomsSignature },   // optional: skip an event that moved nothing we show
 *     onData: (data) => render(data),
 *     onError: (err) => showError(err),
 *   });
 *   feed.show();   // the section is on screen: read now if something moved meanwhile
 *   feed.hide();   // views stay mounted when hidden: stop reading until shown again
 *   feed.refresh() // read again now (the retry button)
 *
 * A burst of events is read once, after a short pause; a read that is still
 * under way is followed by one more when something moved during it. The
 * sticky topics are replayed when the stream opens, which is the first read
 * of a fresh page and the catching up after a dropped connection
 */
import { getJson, live } from '../../core/api.js';

const PAUSE_MS = 250;

export function followApi(url, { topics, changed = {}, onData, onError = () => {} }) {
  let active = false;
  let stale = true;      // something moved since the last read
  let reading = false;
  let timer = null;
  const seen = new Map(); // topic → signature of the last event that moved something

  async function read() {
    timer = null;
    if (reading) return;
    reading = true;
    stale = false;
    try {
      onData(await getJson(url));
    } catch (err) {
      onError(err);
    } finally {
      reading = false;
      if (stale && active) schedule();
    }
  }

  function schedule(delay = PAUSE_MS) {
    stale = true;
    if (!active || timer) return;
    timer = setTimeout(read, delay);
  }

  for (const topic of topics) {
    live.on(topic, (data) => {
      const signature = changed[topic]?.(data);
      if (signature !== undefined) {
        if (seen.get(topic) === signature) return;
        seen.set(topic, signature);
      }
      schedule();
    });
  }

  return {
    show() {
      active = true;
      if (stale) schedule(0);
    },
    hide() {
      active = false;
      clearTimeout(timer);
      timer = null;
    },
    refresh() {
      schedule(0);
    },
  };
}

/**
 * What of the consoles' summaries the overview shows: who is on which line,
 * who pilots, in which state, with a task or a shared keyboard. The last
 * command typed and the time of the last activity change at every Enter and
 * move nothing on screen: they are left out
 */
export function roomsSignature(rooms) {
  return (rooms ?? []).map((r) => [
    r.target, r.state, r.pilot?.id ?? '', r.shared ? 1 : 0, r.task ? 1 : 0, (r.users ?? []).map((u) => u.id).sort().join(','),
  ].join('|')).sort().join(';');
}

/**
 * Which bench checks run, and of which kind: 'checks:running' moves at every
 * device a check reaches, the cards only care when a check starts or ends (a
 * line status that ends is what they show)
 */
export function checksSignature(data) {
  return (data?.checks ?? []).map((c) => `${c.bench}|${c.kind}|${c.id ?? ''}`).sort().join(';');
}
