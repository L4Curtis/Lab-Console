/** HTTP + live-event access to the backend. */
import { tError } from './i18n.js';

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
 */
class LiveEvents {
  #source = null;
  #handlers = new Map();
  #last = new Map();

  on(topic, fn) {
    this.#connect();
    if (!this.#handlers.has(topic)) {
      this.#handlers.set(topic, new Set());
      this.#source.addEventListener(topic, (e) => {
        const data = JSON.parse(e.data);
        this.#last.set(topic, data);
        for (const h of this.#handlers.get(topic)) h(data);
      });
    }
    this.#handlers.get(topic).add(fn);
    if (this.#last.has(topic)) fn(this.#last.get(topic));
    return () => this.#handlers.get(topic).delete(fn);
  }

  #connect() {
    if (!this.#source) this.#source = new EventSource('/api/events');
  }
}
export const live = new LiveEvents();
