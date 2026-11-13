/** HTTP + live-event access to the backend. */
import { tError } from './i18n.js';

let leaving = false;

/** The page is going away on purpose (sign-out): a request refused meanwhile must not send it elsewhere */
export function leavingPage() {
  leaving = true;
}

export async function getJson(url) {
  return request('GET', url);
}

/**
 * JSON request; errors carry the HTTP status and the server's `code` and
 * `params`. The message is the translation of `code` when the dictionaries
 * know it, else the server's own sentence (kept in `serverMessage`).
 */
export async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    // The session ended (signed out elsewhere, revoked, expired): back to the sign-in page, then here again
    if (res.status === 401 && data?.code === 'auth.required' && !leaving && location.pathname !== '/login') {
      leaving = true;
      location.assign(`/login${location.hash}`);
    }
    const fallback = data?.error || `${url} answered HTTP ${res.status}`;
    const err = new Error(data?.code ? tError(data.code, data.params, fallback) : fallback);
    err.status = res.status;
    err.code = data?.code ?? null;
    err.params = data?.params ?? {};
    err.serverMessage = fallback;
    throw err;
  }
  return data;
}

/**
 * One shared EventSource for the whole app; modules subscribe by topic.
 *   const off = live.on('consoles:busy', (targets) => …)
 *
 * Sticky topics are replayed by the server when a stream opens, and a named
 * event that has no listener yet is lost. So when a section subscribes to a
 * new topic after the stream is open (the announcement banner opens it at
 * start-up, before any section is mounted), the stream is opened again, once
 * for the topics added in the same turn, and every topic is replayed.
 */
class LiveEvents {
  #source = null;
  #handlers = new Map();
  #last = new Map();
  #reopen = null;

  on(topic, fn) {
    if (!this.#handlers.has(topic)) {
      this.#handlers.set(topic, new Set());
      if (this.#source) this.#scheduleReopen();
      else this.#open();
    }
    this.#handlers.get(topic).add(fn);
    if (this.#last.has(topic)) fn(this.#last.get(topic));
    return () => this.#handlers.get(topic).delete(fn);
  }

  #open() {
    this.#source = new EventSource('/api/events');
    for (const topic of this.#handlers.keys()) {
      this.#source.addEventListener(topic, (e) => {
        const data = JSON.parse(e.data);
        this.#last.set(topic, data);
        for (const h of this.#handlers.get(topic)) h(data);
      });
    }
  }

  #scheduleReopen() {
    if (this.#reopen) return;
    this.#reopen = setTimeout(() => {
      this.#reopen = null;
      this.#source.close();
      this.#open();
    }, 0);
  }
}
export const live = new LiveEvents();
