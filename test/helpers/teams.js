/**
 * Test helpers for the teams and benches modules: the application with a
 * fake clock, a JSON client per user, and SSE listeners that keep what each
 * user received
 *
 *   const t = await startTeamsApp();         // { lab, clock, api(who, method, path, body), listen(who), benches, close() }
 *   const { status, body } = await t.api('student1', 'POST', '/api/teams', { name: 'Les routeurs' });
 *   const sse = await t.listen('student2');  await sse.until((e) => e.topic === 'teams:invitation');
 */
import { startTestApp } from './app.js';
import { createConsolesModule } from '../../src/modules/consoles/index.js';
import { createTeamsModules } from '../../src/modules/teams/index.js';

/** 13 Nov 2026, 09:00 UTC: a Friday morning, on a quarter of an hour */
export const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Wait until `check()` is truthy (work that follows a response, such as a dissolved team's bench) */
export async function waitFor(check, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms: ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function startTeamsApp({ env = {} } = {}) {
  const clock = { ms: T0 };
  let modules = [];
  const lab = await startTestApp({
    env,
    modules: (deps) => {
      modules = [createConsolesModule(deps), ...createTeamsModules(deps, { now: () => clock.ms, tickMs: 0 })];
      return modules;
    },
  });
  const benchesModule = modules.find((m) => m.id === 'benches');
  const listeners = [];

  async function api(who, method, path, body) {
    const headers = { accept: 'application/json', ...(who ? lab.as(who) : {}) };
    if (method !== 'GET') headers.origin = lab.url;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${lab.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: data };
  }

  /** An SSE stream opened as `who`; every event it receives is kept in `events` */
  async function listen(who) {
    const controller = new AbortController();
    const res = await fetch(`${lab.url}/api/events`, { headers: lab.as(who), signal: controller.signal });
    const events = [];
    const waiters = new Set();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const m = /^event: (.*)\ndata: (.*)$/s.exec(block);
            if (!m) continue;
            events.push({ topic: m[1], data: JSON.parse(m[2]) });
            for (const w of waiters) w();
          }
        }
      } catch { /* aborted */ }
    })();
    const stream = {
      events,
      topics: () => events.map((e) => e.topic),
      /** Resolves with the first event matching `pred` (already received or to come) */
      until(pred, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
          const check = () => {
            const found = events.find(pred);
            if (!found) return false;
            waiters.delete(check);
            clearTimeout(timer);
            resolve(found);
            return true;
          };
          const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no matching event; got ${events.map((e) => e.topic).join(', ')}`)); }, timeoutMs);
          waiters.add(check);
          check();
        });
      },
      async close() { controller.abort(); await pump; },
    };
    listeners.push(stream);
    return stream;
  }

  /** Let the events already published reach the streams: a marker sent to everyone arrives after them */
  async function settle(...streams) {
    const id = Math.random().toString(36).slice(2);
    lab.deps.events.publish('test:marker', { id });
    await Promise.all(streams.map((s) => s.until((e) => e.topic === 'test:marker' && e.data.id === id)));
  }

  return {
    lab,
    clock,
    api,
    listen,
    settle,
    benches: benchesModule.benches,
    teams: modules.find((m) => m.id === 'teams').teams,
    tick: () => benchesModule.tick(),
    services: lab.deps.services,
    async close() {
      for (const l of listeners) await l.close();
      await lab.close();
    },
  };
}
