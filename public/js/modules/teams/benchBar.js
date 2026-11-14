/**
 * The bench bar, above the diagram in the consoles view: who holds the bench
 * on screen, what I may do about it (take, release, ask to join, leave), the
 * requests waiting for my team, the lock and its reason, the next slots
 * booked and the bench's history
 *
 *   const bar = mountBenchBar(viewEl);     // appended to viewEl
 *   bar.setBench('B4M');                    // the lab on screen
 *   bar.decorate(diagram);                  // diagram rings, when the diagram offers decorate()
 *   bar.mayOpen(device, ['B4M', 'B4H'])     // false: the server would refuse this console
 *
 * It also turns the personal events into toasts wherever the user is: a
 * team invitation, an answer to a join request, the ten-minute warning
 * before another team's slot
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { live, request } from '../../core/api.js';
import { t, has, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { confirmDialog, formDialog, openDialog } from '../../shared/dialog.js';
import { onBenches, call, benchUrl, mayPilot, isOccupant, benchSummary, fmtTime, fmtSlot, fmtDateTime } from './data.js';

const SLOTS_SHOWN = 3;

export function mountBenchBar(host) {
  const el = h('section.bench-bar', { hidden: true });
  host.append(el);
  let bench = null;
  let detail = null;
  let slots = [];
  let ready = false;
  let diagram = null;
  const followed = new Set(); // benches whose requests topic is subscribed

  const start = Promise.all([loadNamespace('benches', 'teams'), loadCss('teams')]).then(() => {
    ready = true;
    bindNotifications();
    onLocaleChange(render);
    onBenches(() => { refresh(); diagram?.refresh?.(); });
    live.on('teams:changed', () => refresh());
    live.on('benches:reservations', (data) => { if (data?.bench === bench) loadSlots(); });
    if (bench) load();
  });

  async function load() {
    if (!ready || !bench) return;
    follow(bench);
    await Promise.all([refresh(), loadSlots()]);
  }

  async function refresh() {
    if (!ready || !bench) return;
    const name = bench;
    const data = await call('GET', benchUrl(name), undefined, { quiet: true });
    if (name !== bench) return;
    detail = data;
    render();
  }

  async function loadSlots() {
    const name = bench;
    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const data = await call('GET', `/api/benches/reservations?bench=${encodeURIComponent(name)}&from=${from}`, undefined, { quiet: true });
    if (name !== bench) return;
    slots = (data?.reservations ?? []).filter((r) => Date.parse(r.end) > Date.now());
    render();
  }

  /** The requests of a bench reach its occupants only: one topic per bench */
  function follow(name) {
    if (followed.has(name)) return;
    followed.add(name);
    live.on(`benches:requests:${name}`, () => { if (name === bench) refresh(); });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function act(method, rest, body) {
    const result = await call(method, benchUrl(bench, rest), body);
    await refresh();
    return result;
  }

  async function release() {
    const ok = await confirmDialog({
      title: t('benches.release.title', { bench }),
      body: t('benches.release.body'),
      confirmLabel: t('benches.release.confirm'),
    });
    if (!ok) return;
    const name = bench;
    const result = await act('POST', '/release');
    if (!result) return;
    toast(t('benches.release.done', { bench: name }));
    for (const offer of result.offers ?? []) await showOffer(name, offer);
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

  async function lockBench() {
    await formDialog({
      title: t('benches.lock.title', { bench }),
      intro: t('benches.lock.intro'),
      fields: [{ name: 'reason', label: t('benches.lock.reason'), required: true, placeholder: t('benches.lock.placeholder'), attrs: { maxlength: 200 } }],
      submitLabel: t('benches.lock.confirm'),
      onSubmit: async ({ reason }) => {
        await requestOrThrow('PUT', benchUrl(bench, '/lock'), { reason });
        await refresh();
      },
    });
  }

  async function unlockBench() {
    const ok = await confirmDialog({ title: t('benches.unlock.title', { bench }), body: t('benches.unlock.body'), confirmLabel: t('benches.unlock.confirm') });
    if (ok) await act('DELETE', '/lock');
  }

  async function assign() {
    const data = await call('GET', '/api/teams');
    if (!data) return;
    const options = data.teams.map((team) => ({ value: team.id, label: team.name }));
    if (!options.length) return toast(t('benches.assign.noTeam'), 'warn');
    await formDialog({
      title: t('benches.assign.title', { bench }),
      intro: t('benches.assign.intro'),
      fields: [{ name: 'teamId', label: t('benches.assign.team'), type: 'select', options, value: detail?.holder?.teamId }],
      submitLabel: t('benches.assign.confirm'),
      onSubmit: async ({ teamId }) => {
        await requestOrThrow('POST', benchUrl(bench, '/assign'), { teamId });
        await refresh();
      },
    });
  }

  async function removeGuest(person) {
    const ok = await confirmDialog({ title: t('benches.guests.removeTitle', { name: person.name }), body: t('benches.guests.removeBody', { bench }), confirmLabel: t('benches.guests.remove'), danger: true });
    if (ok) await act('DELETE', `/guests/${encodeURIComponent(person.id)}`);
  }

  async function showHistory() {
    const data = await call('GET', benchUrl(bench, '/history'));
    if (!data) return;
    const rows = data.history.map((e) => h('li',
      h('time', { datetime: e.ts }, fmtDateTime(e.ts)),
      h('span', historyText(e))));
    openDialog(h('div.modal-body.bench-history', rows.length ? h('ol', rows) : h('p.muted', t('benches.history.empty'))),
      { title: t('benches.history.title', { bench }), wide: true });
  }

  function historyText(e) {
    const params = { who: e.actor.name, team: e.details.team ?? '', guest: e.details.guest ?? '', device: e.details.device ?? '' };
    const known = HISTORY_KEYS[e.action];
    if (known) return t(known, params);
    // Bench jobs speak through the jobs dictionary (loaded at start-up for the diagram layer)
    const job = `jobs.audit.${e.action.slice(4).replace(/\./g, '_')}`;
    if (e.action.startsWith('job.') && has(job)) return t(job, params);
    if (e.action.startsWith('job.')) return t('benches.history.job', { ...params, action: e.action.slice(4) });
    return `${e.actor.name} · ${e.action}`;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!ready || !bench || !detail) { el.hidden = true; return; }
    el.hidden = false;
    const d = detail;
    const you = d.you;
    el.dataset.state = d.lock ? 'locked' : d.holder ? 'taken' : 'free';
    el.dataset.mine = String(you.occupant);

    const lock = d.lock ? h('div.bench-lock', { role: 'status' }, icon('lock'),
      h('span', h('strong', t('benches.lock.banner')), ' ', d.lock.reason),
      h('span.muted', t('benches.lock.by', { name: d.lock.by?.name ?? '', time: fmtDateTime(d.lock.at) })),
      you.admin ? h('button.btn.small', { type: 'button', dataset: { action: 'unlock' }, onclick: unlockBench }, t('benches.unlock.button')) : null) : null;

    const status = d.holder
      ? h('span.bench-status', icon('team'), h('span', t('benches.status.taken', { team: d.holder.teamName ?? '?', time: fmtTime(d.holder.since) })))
      : h('span.bench-status', icon('check'), h('span', t('benches.status.free')));

    const people = d.occupants.length ? h('ul.bench-people', { 'aria-label': t('benches.occupants') }, d.occupants.map((p) => h('li',
      { title: p.guest ? t('benches.guests.guest', { name: p.name }) : p.name, dataset: { guest: String(p.guest) } },
      p.name, p.guest ? h('small', t('benches.guests.tag')) : null,
      you.admin && p.guest ? h('button.icon-btn.small', { type: 'button', title: t('benches.guests.remove'), 'aria-label': t('benches.guests.remove'), onclick: () => removeGuest(p) }, icon('close')) : null))) : null;

    const idle = d.holder && d.releaseAt ? h('span.bench-idle.muted', t('benches.status.releaseAt', { time: fmtTime(d.releaseAt) })) : null;

    const button = (action, label, onclick, cls = '') => h(`button.btn.small${cls}`, { type: 'button', dataset: { action }, onclick }, label);
    const actions = h('div.bench-actions',
      you.canTake ? button('take', t('benches.actions.take'), () => act('POST', '/take'), '.primary') : null,
      !d.holder && !you.team && !you.admin && !d.lock ? h('a.btn.small', { href: '#/team', dataset: { action: 'need-team' } }, t('benches.actions.needTeam')) : null,
      you.canJoin && !you.pending ? button('join', t('benches.actions.join'), async () => { if (await act('POST', '/join')) toast(t('benches.join.sent')); }, '.primary') : null,
      you.pending ? button('cancel-join', t('benches.actions.cancelJoin'), () => act('DELETE', '/join')) : null,
      you.guest ? button('leave', t('benches.actions.leave'), () => act('POST', '/leave')) : null,
      you.occupant ? button('touch', t('benches.actions.touch'), async () => { if (await act('POST', '/touch')) toast(t('benches.touched')); }, '.subtle') : null,
      you.canRelease ? button('release', t('benches.actions.release'), release, you.member ? '' : '.danger') : null,
      you.admin ? button('assign', t('benches.actions.assign'), assign, '.subtle') : null,
      you.admin && !d.lock ? button('lock', t('benches.actions.lock'), lockBench, '.subtle') : null,
      you.occupant || you.admin ? button('history', t('benches.actions.history'), showHistory, '.subtle') : null);

    const requests = d.requests?.length ? h('ul.bench-requests', { 'aria-label': t('benches.join.waiting') }, d.requests.map((r) => h('li', { dataset: { user: r.username } },
      h('span', t('benches.join.asks', { name: r.name, time: fmtTime(r.at) })),
      you.canAnswer ? h('span.bench-request-actions',
        button('accept', t('benches.join.accept'), () => act('POST', `/requests/${encodeURIComponent(r.id)}/accept`), '.primary'),
        button('refuse', t('benches.join.refuse'), () => act('POST', `/requests/${encodeURIComponent(r.id)}/refuse`))) : null))) : null;

    const upcoming = slots.slice(0, SLOTS_SHOWN);
    const calendar = h('div.bench-slots',
      h('span.muted', upcoming.length ? t('benches.slots.next') : t('benches.slots.none')),
      upcoming.map((r) => h('span.bench-slot', { dataset: { team: r.teamId } }, `${r.teamName ?? '?'} · ${fmtSlot(r)}`)),
      h('a.btn.small.subtle', { href: `#/team/calendar/${encodeURIComponent(bench)}` }, icon('calendar'), t('benches.slots.calendar')));

    el.replaceChildren(lock ?? '', h('div.bench-main', status, people ?? '', idle ?? '', actions), requests ?? '', calendar);
  }

  // ── Notifications that follow the user everywhere ────────────────────────

  function bindNotifications() {
    live.on('teams:invitation', (data) => toast(t('teams.notify.invited', { team: data.team.name, name: data.by.name }), 'info', 10_000));
    live.on('benches:request', (data) => {
      const key = { accepted: 'benches.notify.accepted', refused: 'benches.notify.refused', released: 'benches.notify.released', removed: 'benches.notify.removed' }[data.state];
      if (key) toast(t(key, { bench: data.bench, name: data.by ?? '' }), data.state === 'accepted' ? 'info' : 'warn', 8000);
      if (data.bench === bench) refresh();
    });
    live.on('benches:warning', (data) => toast(t('benches.notify.warning', { bench: data.bench, team: data.team ?? '?', minutes: data.minutes, count: data.minutes }), 'warn', 20_000));
    live.on('benches:slot', (data) => toast(t('benches.notify.slot', { bench: data.bench, end: fmtTime(data.end) }), 'info', 12_000));
  }

  // ── Diagram decorations (rooms lot API, ARCHITECTURE §8), when available ──

  function decorate(view) {
    if (typeof view?.decorate !== 'function') return; // the diagram has no decoration layer yet: nothing to do
    diagram = view;
    view.decorate('benches', (device) => {
      if (!bench || !detail || device.labName && device.labName !== bench) return null;
      if (detail.lock) return { ring: 'locked', tooltip: t('benches.lock.banner') };
      if (detail.you.occupant) return { ring: 'ours' };
      if (detail.holder) return { ring: 'taken', tooltip: t('benches.status.taken', { team: detail.holder.teamName ?? '?', time: fmtTime(detail.holder.since) }) };
      return null;
    });
  }

  return {
    el,
    ready: start,
    setBench(name) {
      if (name === bench) return;
      bench = name;
      detail = null;
      slots = [];
      render();
      load();
    },
    decorate,
    /** False when the server would refuse this console to me: the bench is locked, or held by a team I am not with */
    mayOpen: (device, benchNames) => mayPilot(device, benchNames),
    /** Why a console is refused, for the toast */
    refusal(benchNames) {
      // Any of the device's benches may hold the lock: a console line shared with a locked bench is refused too
      const lockOf = (n) => (detail?.bench === n ? detail.lock : null) ?? benchSummary(n)?.lock ?? null;
      const locked = benchNames.find((n) => lockOf(n));
      if (locked) return t('benches.refused.locked', { bench: locked, reason: lockOf(locked).reason });
      return t('benches.refused.taken', { bench: benchNames[0] ?? '' });
    },
    isOccupant: () => isOccupant(detail),
  };
}

/** Inside a form dialog: an error stays in the dialog instead of a toast */
const requestOrThrow = (method, url, body) => request(method, url, body);

/** Bench history lines: audit action → sentence */
const HISTORY_KEYS = {
  'bench.take': 'benches.history.take',
  'bench.release': 'benches.history.release',
  'bench.release.idle': 'benches.history.releaseIdle',
  'bench.assign': 'benches.history.assign',
  'bench.join.request': 'benches.history.joinRequest',
  'bench.join.accept': 'benches.history.joinAccept',
  'bench.join.refuse': 'benches.history.joinRefuse',
  'bench.leave': 'benches.history.leave',
  'bench.guest.remove': 'benches.history.guestRemove',
  'bench.lock': 'benches.history.lock',
  'bench.unlock': 'benches.history.unlock',
  'bench.reserve': 'benches.history.reserve',
  'bench.reservation.cancel': 'benches.history.reservationCancel',
};
