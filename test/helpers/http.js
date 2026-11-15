/**
 * Test helpers every API test shares: a JSON client per user on a test
 * application, waiting for a condition, and a team holding a bench
 *
 *   const api = apiClient(app);                       // app: startTestApp()
 *   const { status, body } = await api('student1', 'POST', '/api/teams', { name: 'Les routeurs' });
 *   await api(null, 'GET', '/api/jobs/runs', undefined, { headers: session.headers });   // an explicit session
 *   const zip = await api('admin', 'GET', '/api/jobs/snapshots/x/zip', undefined, { raw: true });   // { status, headers, buffer }
 *   await waitFor(() => runner.get(id)?.state === 'done', { ms: 30_000, what: 'the job to end' });
 */

/** → api(who, method, path, body, { raw, headers }): `who` is a test user ('student1', 'admin'…) or null (nobody) */
export function apiClient(app) {
  return async function api(who, method, path, body, { raw = false, headers = {} } = {}) {
    const h = { accept: 'application/json', ...(who ? app.as(who) : {}), ...headers };
    if (method !== 'GET') h.origin = app.url;
    let payload;
    if (body instanceof Uint8Array) { payload = body; h['content-type'] ??= 'application/zip'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(`${app.url}${path}`, { method, headers: h, body: payload });
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: data };
  };
}

/** Wait until `check()` (sync or async) is truthy; → its value. Throws after `ms`, naming `what` */
export async function waitFor(check, { ms = 6000, what = 'condition', every = 10 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what} not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** A team for `who` (created, or theirs already) holding `bench` */
export async function holdBench(api, who, bench = 'B4M', team = `team-${who}`) {
  const t = await api(who, 'POST', '/api/teams', { name: team });
  if (t.status !== 201 && t.status !== 409) throw new Error(`team: ${t.status} ${JSON.stringify(t.body)}`);
  const r = await api(who, 'POST', `/api/benches/${bench}/take`);
  if (r.status !== 200) throw new Error(`take: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
