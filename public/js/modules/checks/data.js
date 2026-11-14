/**
 * What the browser knows of the bench checks (SPEC "Lot checks"), shared by
 * the diagram layers and the checks dialog:
 *
 *   - the last result of each kind per bench that this person may read
 *     (GET /api/checks/latest at start, then the 'checks:check' events,
 *     which the server sends only to the people who may read them);
 *   - the checks running, for everyone ('checks:running', sticky: which bench
 *     runs which check, device by device, no result);
 *   - the check running on a bench in full, for its readers ('checks:check').
 *
 *   onChecks(fn) → off()       fn() after any change
 *   lastOf(bench, kind)        the last finished check of that kind, or null
 *   runningOn(bench)           the check running there (full when readable, else a summary), or null
 *   allLast()                  every last result known, all benches
 *   allRunning()               every check running (summaries or full checks)
 *   remember(check)            a check fetched by other means (the dialog's GET)
 */
import { getJson, live } from '../../core/api.js';

const FINAL = new Set(['done', 'failed', 'partial', 'cancelled']);
const last = new Map();      // `${bench} ${kind}` → check
const running = new Map();   // bench → summary or full check
const listeners = new Set();
let started = null;

const changed = () => { for (const fn of listeners) fn(); };

function keep(check) {
  if (!check?.bench || !check.kind) return;
  if (FINAL.has(check.state)) {
    const prev = last.get(`${check.bench} ${check.kind}`);
    if (!prev || String(prev.endedAt ?? '') <= String(check.endedAt ?? '')) last.set(`${check.bench} ${check.kind}`, check);
    if (running.get(check.bench)?.id === check.id) running.delete(check.bench);
  } else {
    running.set(check.bench, check);
  }
}

/** Load what the server keeps and follow the events; once per page */
export function startChecks() {
  started ??= (async () => {
    live.on('checks:running', (data) => {
      const now = new Map((data?.checks ?? []).map((c) => [c.bench, c]));
      for (const bench of [...running.keys()]) if (!now.has(bench)) running.delete(bench);
      for (const [bench, summary] of now) {
        const full = running.get(bench);
        // A full view of the same check (with its steps) is better than the summary
        if (!full || full.id !== summary.id) running.set(bench, summary);
        else full.devices = full.devices.map((d) => ({ ...d, state: summary.devices.find((s) => s.key === d.key)?.state ?? d.state }));
      }
      changed();
    });
    live.on('checks:check', (check) => { keep(check); changed(); });
    try {
      const data = await getJson('/api/checks/latest');
      for (const c of data?.checks ?? []) keep(c);
    } catch { /* the module is off, or nothing yet */ }
    changed();
  })();
  return started;
}

export function onChecks(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A check the dialog fetched itself (GET /benches/:bench) */
export function remember(check) {
  keep(check);
  changed();
}

export const lastOf = (bench, kind) => last.get(`${bench} ${kind}`) ?? null;
export const runningOn = (bench) => running.get(bench) ?? null;
export const allLast = () => [...last.values()];
export const allRunning = () => [...running.values()];
export const checksApi = (bench, rest = '') => `/api/checks/benches/${encodeURIComponent(bench)}${rest}`;
