/**
 * A tiny browser for tests: a cookie jar and redirects followed by hand, so
 * a test can walk through a whole sign-in (application → identity provider →
 * application) and look at every hop
 *
 *   const browser = new TestBrowser();
 *   const { res, hops } = await browser.go(`${lab.url}/auth/login`);   // follows redirects
 *   const res = await browser.fetch(url, { method: 'POST', ... });     // one request, cookies applied
 *   browser.cookie(lab.url, 'lc_sid')
 *
 * Cookies are kept per origin (host and port) and sent back to the same
 * origin only. Enough for these tests; not a general implementation
 */
import { adminCode, TEST_ADMIN } from './app.js';

export class TestBrowser {
  #jar = new Map(); // origin → Map(name → value)

  #store(url, res) {
    const origin = new URL(url).origin;
    if (!this.#jar.has(origin)) this.#jar.set(origin, new Map());
    const cookies = this.#jar.get(origin);
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = attributes.some((a) => /^max-age=0$/i.test(a));
      if (expired || value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  cookie(url, name) {
    return this.#jar.get(new URL(url).origin)?.get(name) ?? null;
  }

  cookieHeader(url) {
    const cookies = this.#jar.get(new URL(url).origin);
    return cookies ? [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  }

  /** One request, without following redirects */
  async fetch(url, { headers = {}, ...options } = {}) {
    const cookie = this.cookieHeader(url);
    const res = await fetch(url, { ...options, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
    this.#store(url, res);
    return res;
  }

  /** GET `url` and follow redirects; → { res, url, hops: [every URL visited] } */
  async go(url, { maxHops = 10 } = {}) {
    const hops = [url];
    let res = await this.fetch(url);
    while (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hops.length > maxHops) throw new Error(`too many redirects: ${hops.join(' → ')}`);
      await res.arrayBuffer();
      url = new URL(res.headers.get('location'), url).href;
      hops.push(url);
      res = await this.fetch(url);
    }
    return { res, url, hops };
  }
}

/**
 * Sign in through the mock identity provider (dev/mock-oidc.js) as one of its
 * users; → { browser, landed, hops, res }. `landed` is the URL the browser
 * ended on: the application on success, /login?error=… on a refusal
 */
export async function signInWithOidc(lab, username, { browser = new TestBrowser(), next } = {}) {
  const start = await browser.fetch(`${lab.url}/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await start.arrayBuffer();
  const authorize = start.headers.get('location');
  if (start.status !== 302 || !authorize) throw new Error(`/auth/login answered ${start.status}`);
  const picker = await browser.fetch(authorize);
  const html = await picker.text();
  const request = /\/authorize\/pick\?req=([\w-]+)/.exec(html)?.[1];
  if (!request) throw new Error(`no user picker at ${authorize}: ${html.slice(0, 200)}`);
  const pick = `${new URL(authorize).origin}/authorize/pick?req=${request}&user=${encodeURIComponent(username)}`;
  const { res, url, hops } = await browser.go(pick);
  await res.arrayBuffer();
  return { browser, landed: url, hops, res };
}

/** Post the local sign-in form; → the fetch Response (cookies land in `browser`) */
export function postLocalSignIn(lab, { username = TEST_ADMIN.username, password = TEST_ADMIN.password, code = adminCode(), next, ip } = {}, browser = new TestBrowser()) {
  return browser.fetch(`${lab.url}/auth/local`, {
    method: 'POST',
    headers: { origin: lab.url, 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ username, password, code, ...(next ? { next } : {}) }),
  });
}
