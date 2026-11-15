/**
 * One bench as the screens of the team section and the bench strip see it,
 * and what a person may do about it. The strip above the diagram and the
 * "Baie" tab show the same thing: both build on this file
 *
 *   const model = watchBench(() => render());      // called after every change
 *   model.setBench('B4M');                         // the bench on screen (null: none)
 *   model.detail                                   // GET /api/benches/B4M: holder, occupants, lock, requests, `you`
 *   model.slots                                    // the slots still to come
 *   model.job                                      // the job of this bench running now (summary), or null
 *   const act = benchActions(model);               // take, release, join, lock… each asks, calls the server, refreshes
 *   model.destroy();                               // a screen that goes away stops listening
 *
 * The server decides every permission again; `you` only hides buttons
 */
import { toast } from '../../core/dom.js';
import { live, request, callOrToast } from '../../core/api.js';
import { t } from '../../core/i18n.js';
import { confirmDialog, formDialog } from '../../shared/dialog.js';
import { onBenches, benchUrl } from './data.js';

export function watchBench(onChange) {
  let bench = null;
  let detail = null;
  let slots = [];
  let job = null;
  let running = [];
  let destroyed = false;
  const offs = [];
  const followed = new Map(); // bench → off of its requests topic

  const changed = () => { if (!destroyed) onChange?.(); };
  const pickJob = () => { job = running.find((j) => j.bench === bench) ?? null; };

  async function refresh() {
    if (!bench) return;
    const name = bench;
    const data = await callOrToast('GET', benchUrl(name), undefined, { quiet: true });
    if (name !== bench || destroyed) return;
    detail = data;
    changed();
  }

  async function loadSlots() {
    if (!bench) return;
    const name = bench;
    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const data = await callOrToast('GET', `/api/benches/reservations?bench=${encodeURIComponent(name)}&from=${from}`, undefined, { quiet: true });
    if (name !== bench || destroyed) return;
    slots = (data?.reservations ?? []).filter((r) => Date.parse(r.end) > Date.now());
    changed();
  }

  /** The requests of a bench reach its occupants only: one topic per bench */
  function follow(name) {
    if (followed.has(name)) return;
    followed.set(name, live.on(`benches:requests:${name}`, () => { if (name === bench) refresh(); }));
  }

  offs.push(onBenches(() => refresh()));
  offs.push(live.on('teams:changed', () => refresh()));
  offs.push(live.on('benches:request', (data) => { if (data?.bench === bench) refresh(); }));
  offs.push(live.on('benches:reservations', (data) => { if (data?.bench === bench) loadSlots(); }));
  offs.push(live.on('jobs:running', (data) => { running = data?.jobs ?? []; pickJob(); changed(); }));

  return {
    get bench() { return bench; },
    get detail() { return detail; },
    get slots() { return slots; },
    get job() { return job; },
    refresh,
    loadSlots,
    setBench(name) {
      if (name === bench) return;
      bench = name ?? null;
      detail = null;
      slots = [];
      pickJob();
      changed();
      if (!bench) return;
      follow(bench);
      refresh();
      loadSlots();
    },
    destroy() {
      destroyed = true;
      for (const off of [...offs, ...followed.values()]) off();
    },
  };
}

/** Inside a form dialog: an error stays in the dialog instead of a toast */
const requestOrThrow = (method, url, body) => request(method, url, body);

/**
 * The things a person does with a bench, for `model`'s bench on screen. Each
 * one returns what the server answered (or null / false when it was refused
 * or cancelled) and refreshes the model
 */
export function benchActions(model) {
  const bench = () => model.bench;

  async function act(method, rest, body) {
    const name = bench();
    const result = await callOrToast(method, benchUrl(name, rest), body);
    await model.refresh();
    return result;
  }

  // The jobs lot registers onRelease(); what it returns comes back here
  async function showOffer(name, offer) {
    const go = await confirmDialog({
      title: t('benches.offer.title', { bench: name }),
      body: t('benches.offer.body'),
      confirmLabel: t('benches.offer.go'),
      cancelLabel: t('benches.offer.skip'),
    });
    if (go && typeof offer.href === 'string' && offer.href.startsWith('#/')) location.hash = offer.href;
  }

  return {
    take: () => act('POST', '/take'),
    async join() {
      const result = await act('POST', '/join');
      if (result) toast(t('benches.join.sent'));
      return result;
    },
    cancelJoin: () => act('DELETE', '/join'),
    leave: () => act('POST', '/leave'),
    async touch() {
      const result = await act('POST', '/touch');
      if (result) toast(t('benches.touched'));
      return result;
    },
    accept: (r) => act('POST', `/requests/${encodeURIComponent(r.id)}/accept`),
    refuse: (r) => act('POST', `/requests/${encodeURIComponent(r.id)}/refuse`),

    async release() {
      const name = bench();
      const ok = await confirmDialog({
        title: t('benches.release.title', { bench: name }),
        body: t('benches.release.body'),
        confirmLabel: t('benches.release.confirm'),
      });
      if (!ok) return null;
      const result = await act('POST', '/release');
      if (!result) return null;
      toast(t('benches.release.done', { bench: name }));
      for (const offer of result.offers ?? []) await showOffer(name, offer);
      return result;
    },

    // Administrators
    async lock() {
      const name = bench();
      await formDialog({
        title: t('benches.lock.title', { bench: name }),
        intro: t('benches.lock.intro'),
        fields: [{ name: 'reason', label: t('benches.lock.reason'), required: true, placeholder: t('benches.lock.placeholder'), attrs: { maxlength: 200 } }],
        submitLabel: t('benches.lock.confirm'),
        onSubmit: async ({ reason }) => {
          await requestOrThrow('PUT', benchUrl(name, '/lock'), { reason });
          await model.refresh();
        },
      });
    },
    async unlock() {
      const ok = await confirmDialog({ title: t('benches.unlock.title', { bench: bench() }), body: t('benches.unlock.body'), confirmLabel: t('benches.unlock.confirm') });
      return ok ? act('DELETE', '/lock') : null;
    },
    async assign() {
      const name = bench();
      const data = await callOrToast('GET', '/api/teams');
      if (!data) return;
      const options = data.teams.map((team) => ({ value: team.id, label: team.name }));
      if (!options.length) { toast(t('benches.assign.noTeam'), 'warn'); return; }
      await formDialog({
        title: t('benches.assign.title', { bench: name }),
        intro: t('benches.assign.intro'),
        fields: [{ name: 'teamId', label: t('benches.assign.team'), type: 'select', options, value: model.detail?.holder?.teamId }],
        submitLabel: t('benches.assign.confirm'),
        onSubmit: async ({ teamId }) => {
          await requestOrThrow('POST', benchUrl(name, '/assign'), { teamId });
          await model.refresh();
        },
      });
    },
    async removeGuest(person) {
      const ok = await confirmDialog({ title: t('benches.guests.removeTitle', { name: person.name }), body: t('benches.guests.removeBody', { name: person.name, bench: bench() }), confirmLabel: t('benches.guests.remove'), danger: true });
      return ok ? act('DELETE', `/guests/${encodeURIComponent(person.id)}`) : null;
    },
    /** The last entries of the bench's history; null when the server refused */
    history: async () => (await callOrToast('GET', benchUrl(bench(), '/history'), undefined, { quiet: true }))?.history ?? null,
  };
}
