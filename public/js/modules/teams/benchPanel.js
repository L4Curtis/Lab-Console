/**
 * What there is to know and to do about one bench: its state, the requests
 * to join it, who is on it, the next slots, its history, the administrators'
 * tools (docs/v2/UX.md §10.3). The "Baie" tab shows it in a page; the bench
 * strip opens it as a sheet on a phone
 *
 *   const panel = createBenchPanel({ model, act, inlinePrimary: true, onLeave: () => sheet.close() });
 *   host.append(panel.el);                 // call panel.render() after every change of `model`; panel.destroy() when it goes away
 *   primaryOf(model.detail, act)           // { id, label, icon, run } the one action of the bench, or null
 *   showHistory(act, 'B4M')                // the whole history in a dialog
 */
import { h, icon } from '../../core/dom.js';
import { t, onLocaleChange } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';
import { fmtTime, fmtDateTime } from '../../core/format.js';
import { historyText, fmtSlot, personAvatar } from './data.js';

const INLINE_HISTORY = 20;
const SOON_MS = 30 * 60_000;

/** The state of a bench for a badge: [tone, word] */
export function stateBadge(detail) {
  if (detail.lock) return ['danger', t('benches.state.locked')];
  if (!detail.holder) return ['success', t('benches.state.free')];
  return detail.you?.occupant ? ['info', t('benches.state.mine')] : ['warning', t('benches.state.taken')];
}

/** Minutes before the bench is released for lack of activity, when that is close: else null */
export function releaseSoon(detail, now = Date.now()) {
  if (!detail.holder || !detail.releaseAt || !detail.you?.occupant) return null;
  const left = Date.parse(detail.releaseAt) - now;
  return left > 0 && left < SOON_MS ? Math.max(1, Math.ceil(left / 60_000)) : null;
}

/** The one action a person has on a bench, or null: release it, take it, ask to join, withdraw the request, leave it */
export function primaryOf(detail, act) {
  const you = detail?.you;
  if (!you) return null;
  // A team holds one bench at a time: from another free one, the way to its own (on the page the person is on)
  if (you.teamBench && !detail.holder && !detail.lock) {
    const page = location.hash.startsWith('#/consoles') ? 'consoles' : 'team/bench';
    return { id: 'goto', label: () => t('benches.actions.goto', { bench: you.teamBench }), icon: 'chevronRight', run: () => { location.hash = `#/${page}/${encodeURIComponent(you.teamBench)}`; } };
  }
  if (you.canTake) return { id: 'take', label: 'benches.actions.take', icon: 'check', run: () => act.take() };
  if (you.canJoin && !you.pending) return { id: 'join', label: 'benches.actions.join', icon: 'team', run: () => act.join() };
  if (you.pending) return { id: 'cancel-join', label: 'benches.actions.cancelJoin', icon: 'close', run: () => act.cancelJoin(), secondary: true };
  if (you.guest) return { id: 'leave', label: 'benches.actions.leave', icon: 'logout', run: () => act.leave(), secondary: true };
  return null;
}

/**
 * Giving the bench back is never the page's main action (it was a big blue button that the first tap
 * of a thumb reached): a secondary danger button at the bottom of the bench's card, and a danger
 * confirmation behind it
 */
export const releaseOf = (detail, act) => (detail?.you?.canRelease
  ? { id: 'release', label: 'benches.actions.release', icon: 'power', run: () => act.release() }
  : null);

/** The whole history of the bench, in a dialog */
export async function showHistory(act, bench) {
  const entries = await act.history();
  if (!entries) return;
  const rows = entries.map((e) => h('li', h('time', { datetime: e.ts }, fmtDateTime(e.ts)), h('span', historyText(e))));
  openDialog(h('div.modal-body.bench-history', rows.length ? h('ol', rows) : h('p.muted', t('benches.history.empty'))),
    { title: t('benches.history.title', { bench }), size: 'lg' });
}

export function createBenchPanel({ model, act, inlinePrimary = false, inSheet = false, onLeave = null }) {
  const el = h(`div.bench-panel${inSheet ? '.in-sheet' : ''}`);
  let history = null; // { bench, entries } | null
  let wanted = 0;

  async function loadHistory() {
    const d = model.detail;
    if (!d || !(d.you.occupant || d.you.admin)) { history = null; return; }
    const ticket = ++wanted;
    const entries = await act.history();
    if (ticket !== wanted || model.bench !== d.bench) return;
    history = entries ? { bench: d.bench, entries } : null;
    render(false);
  }

  const row = (...nodes) => h('div.bench-row', ...nodes);

  function statusCard(d) {
    const you = d.you;
    const [tone, word] = stateBadge(d);
    const soon = releaseSoon(d);
    const primary = inlinePrimary ? primaryOf(d, act) : null;
    const release = releaseOf(d, act);
    const heroTone = d.lock ? 'danger' : !d.holder ? 'success' : soon ? 'warning' : null;
    const lines = [];
    if (d.lock) {
      lines.push(h('div.bench-lock', { role: 'status' }, icon('lock'),
        h('div', h('strong', t('benches.lock.banner')), ' ', d.lock.reason,
          h('p.card-meta', t('benches.lock.by', { name: d.lock.by?.name ?? '', time: fmtDateTime(d.lock.at) })))));
    }
    // A locked bench nobody holds is not "free": the lock above says what it is
    if (d.holder || !d.lock) {
      lines.push(h('p.bench-status', d.holder
        ? t('benches.status.taken', { team: d.holder.teamName ?? '?', time: fmtTime(d.holder.since) })
        : t('benches.status.free')));
    }
    if (d.holder && d.releaseAt) {
      lines.push(row(
        h('p.bench-idle.card-meta', soon ? t('benches.strip.releaseSoon', { count: soon }) : t('benches.status.releaseAt', { time: fmtTime(d.releaseAt) })),
        you.occupant ? h('button.btn.sm', { type: 'button', dataset: { action: 'touch' }, onclick: () => act.touch() }, icon('check'), t('benches.actions.touch')) : null));
    }
    if (!d.holder && !you.team && !you.admin && !d.lock) {
      lines.push(h('p', h('a.btn.sm', { href: '#/team/mine', dataset: { action: 'need-team' } }, icon('team'), t('benches.actions.needTeam'))));
    }
    return h(`section.card.hero.bench-status-card`, { dataset: { tone: heroTone ?? '', state: d.lock ? 'locked' : d.holder ? 'taken' : 'free' } },
      h('div.card-head', h('h2.bench-name', d.bench), h('span.badge', { dataset: { tone } }, h('span.dot'), word),
        d.lock && you.admin ? h('button.btn.sm', { type: 'button', dataset: { action: 'unlock' }, onclick: () => act.unlock() }, icon('lock'), t('benches.unlock.button')) : null),
      h('div.card-body', lines),
      primary || release ? h('div.card-foot',
        primary ? h(`button.btn.${primary.secondary ? 'sm' : 'primary.lg'}`, { type: 'button', dataset: { action: primary.id }, onclick: primary.run }, icon(primary.icon), typeof primary.label === 'function' ? primary.label() : t(primary.label)) : null,
        release ? h('button.btn.sm.danger', { type: 'button', dataset: { action: release.id }, onclick: release.run }, icon(release.icon), t(release.label)) : null) : null);
  }

  function requestsCard(d) {
    if (!d.requests?.length) return null;
    return h('section.card.bench-requests-card', { 'aria-label': t('benches.join.waiting') },
      h('div.card-head', h('h2', t('benches.join.waiting')), h('span.count', { dataset: { tone: 'danger' } }, String(d.requests.length))),
      h('ul.bench-requests.team-list', d.requests.map((r) => h('li', { dataset: { user: r.username } },
        personAvatar({ id: r.id, name: r.name }),
        h('span.bench-request-text', t('benches.join.asks', { name: r.name, time: fmtTime(r.at) })),
        d.you.canAnswer ? h('span.bench-request-actions',
          h('button.btn.sm.primary', { type: 'button', dataset: { action: 'accept' }, onclick: () => act.accept(r) }, t('benches.join.accept')),
          h('button.btn.sm', { type: 'button', dataset: { action: 'refuse' }, onclick: () => act.refuse(r) }, t('benches.join.refuse'))) : null))));
  }

  function occupantsCard(d) {
    return h('section.card', { 'aria-label': t('benches.occupants') },
      h('div.card-head', h('h2', t('benches.occupants')), h('span.card-meta', String(d.occupants.length))),
      d.occupants.length
        ? h('ul.bench-people.team-list', d.occupants.map((p) => h('li', { dataset: { guest: String(p.guest), user: p.username } },
          personAvatar(p, '.md'),
          h('span.bench-person', h('strong', p.name), p.guest ? h('span.badge', { dataset: { tone: 'neutral' } }, t('benches.guests.tag')) : null),
          d.you.admin && p.guest ? h('button.icon-btn', { type: 'button', title: t('benches.guests.remove'), 'aria-label': `${t('benches.guests.remove')} · ${p.name}`, onclick: () => act.removeGuest(p) }, icon('close')) : null)))
        : h('p.card-meta', t('benches.occupantsNone')));
  }

  function slotsCard(d) {
    const upcoming = model.slots.slice(0, 3);
    return h('section.card', { 'aria-label': t('benches.slots.title') },
      h('div.card-head', h('h2', t('benches.slots.title')),
        h('a.btn.sm', { href: `#/team/calendar/${encodeURIComponent(d.bench)}`, onclick: () => onLeave?.() }, icon('calendar'), t('benches.slots.calendar'))),
      upcoming.length
        ? h('ul.bench-slots.team-list', upcoming.map((r) => h('li', { dataset: { team: r.teamId } }, h('strong', r.teamName ?? '?'), h('span.card-meta', fmtSlot(r)))))
        : h('p.card-meta', t('benches.slots.none')));
  }

  function historyCard(d) {
    if (!history || history.bench !== d.bench) return null;
    const entries = history.entries.slice(0, INLINE_HISTORY);
    return h('section.card.bench-history-card', { 'aria-label': t('benches.history.heading') },
      h('div.card-head', h('h2', t('benches.history.heading')),
        history.entries.length > INLINE_HISTORY ? h('button.btn.sm', { type: 'button', dataset: { action: 'history' }, onclick: () => showHistory(act, d.bench) }, t('benches.history.all')) : null),
      entries.length
        ? h('ol.bench-history-list.team-list', entries.map((e) => h('li', h('time', { datetime: e.ts }, fmtDateTime(e.ts)), h('span', historyText(e)))))
        : h('p.card-meta', t('benches.history.empty')));
  }

  function adminCard(d) {
    if (!d.you.admin) return null;
    return h('section.card', { 'aria-label': t('benches.admin.title') },
      h('div.card-head', h('h2', t('benches.admin.title'))),
      h('div.bench-admin',
        h('button.btn', { type: 'button', dataset: { action: 'assign' }, onclick: () => act.assign() }, icon('team'), t('benches.actions.assign')),
        !d.lock ? h('button.btn', { type: 'button', dataset: { action: 'lock' }, onclick: () => act.lock() }, icon('lock'), t('benches.actions.lock')) : null));
  }

  let drawn = '';
  function render(withHistory = true, force = false) {
    const d = model.detail;
    if (!d) { el.replaceChildren(); drawn = ''; return; }
    const signature = JSON.stringify([d, model.slots, history, releaseSoon(d)]);
    if (!force && signature === drawn) { if (withHistory) loadHistory(); return; }
    drawn = signature;
    const main = [statusCard(d), requestsCard(d), occupantsCard(d)].filter(Boolean);
    const side = [slotsCard(d), historyCard(d), adminCard(d)].filter(Boolean);
    el.dataset.state = d.lock ? 'locked' : d.holder ? 'taken' : 'free';
    el.replaceChildren(h('div.bench-col.bench-col-main', main), h('div.bench-col.bench-col-side', side));
    if (withHistory) loadHistory();
  }

  const stop = onLocaleChange(() => render(false, true));
  return { el, render, destroy: stop };
}
