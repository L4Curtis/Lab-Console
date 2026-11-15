/**
 * The bench strip, above the diagram of the consoles page: one line that
 * says who holds the bench on screen and offers the one action that matters
 * now; a second line only when something waits (a request to join, a job
 * running). Everything else is in its ⋯ menu or on the "Baie" tab of the
 * team section (docs/v2/UX.md §7.13)
 *
 *   const bar = mountBenchBar(viewEl);     // appended to viewEl; { variant: 'strip' } is the only one
 *   bar.setBench('B4M');                    // the lab on screen
 *   bar.decorate(diagram);                  // diagram rings, when the diagram offers decorate()
 *   bar.mayOpen(device, ['B4M', 'B4H'])     // false: the server would refuse this console
 *   bar.refusal(['B4M'])                    // why, for a toast
 *   bar.isOccupant()                        // am I on this bench
 *   bar.openSheet()                         // the bench's page as a sheet (what a tap on the strip does on a phone)
 *   bar.ready                               // resolves when the dictionaries are loaded
 *
 * It also turns the personal events into toasts wherever the user is: a
 * team invitation, an answer to a join request, the ten-minute warning
 * before another team's slot
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { live } from '../../core/api.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';
import { moreButton } from '../../shared/menu.js';
import { isCompact } from '../../core/viewport.js';
import { mayPilot, isOccupant, benchSummary, avatarStack } from './data.js';
import { fmtTime } from '../../core/format.js';
import { watchBench, benchActions } from './benchModel.js';
import { createBenchPanel, releaseSoon, showHistory } from './benchPanel.js';
import { kindText } from '../jobs/text.js';

const FINAL = new Set(['done', 'failed', 'cancelled', 'partial', 'skipped']);

export function mountBenchBar(host) {
  const el = h('section.bench-bar', { hidden: true, 'aria-label': t('benches.strip.label') });
  host.append(el);
  let diagram = null;
  let ready = false;
  let shown = null; // the detail last drawn on the diagram

  const model = watchBench(() => { if (ready) render(); });
  const act = benchActions(model);

  const start = Promise.all([loadNamespace('benches', 'teams', 'jobs', 'ios'), loadCss('teams')]).then(() => {
    ready = true;
    el.setAttribute('aria-label', t('benches.strip.label'));
    bindNotifications();
    onLocaleChange(() => { el.setAttribute('aria-label', t('benches.strip.label')); render(true); });
    render();
  });

  // ── Actions of the strip ──────────────────────────────────────────────────

  const button = (action, label, onclick, cls = '', iconName = null) => h(`button.btn.sm${cls}`, { type: 'button', dataset: { action }, onclick }, iconName ? icon(iconName) : null, label);

  /** The one button the strip puts forward, by urgency */
  function mainButton(d) {
    const you = d.you;
    if (d.lock && you.admin) return button('unlock', t('benches.unlock.button'), () => act.unlock(), '.bench-optional', 'lock');
    if (releaseSoon(d)) return button('touch', t('benches.actions.touch'), () => act.touch(), '.primary', 'check');
    if (you.canTake) return button('take', t('benches.actions.take'), () => act.take(), '.primary', 'check');
    if (you.pending) return button('cancel-join', t('benches.actions.cancelJoin'), () => act.cancelJoin());
    if (you.canJoin) return button('join', t('benches.actions.join'), () => act.join(), '.primary', 'team');
    if (you.canRelease) return button('release', t('benches.actions.release'), () => act.release(), '.bench-optional');
    if (!d.holder && !you.team && !you.admin && !d.lock) return h('a.btn.sm.primary', { href: '#/team/mine', dataset: { action: 'need-team' } }, icon('team'), t('benches.actions.needTeam'));
    return null;
  }

  /** What ⋯ holds: the rest of what a person may do, then the way to the bench's page */
  function menuItems() {
    const d = model.detail;
    if (!d) return [];
    const you = d.you;
    const mainId = mainButton(d)?.dataset?.action;
    const items = [];
    if (you.occupant || you.admin) items.push({ id: 'history', label: 'benches.actions.history', icon: 'history', run: () => showHistory(act, d.bench) });
    items.push({ id: 'calendar', label: 'benches.actions.calendar', icon: 'calendar', href: `#/team/calendar/${encodeURIComponent(d.bench)}` });
    if (you.occupant && mainId !== 'touch') items.push({ id: 'touch', label: 'benches.actions.touch', icon: 'check', run: () => act.touch() });
    if (you.guest) items.push({ id: 'leave', label: 'benches.actions.leave', icon: 'logout', run: () => act.leave() });
    // On a phone the strip keeps its room for what is urgent: releasing the bench is in ⋯
    if (you.canRelease && (mainId !== 'release' || isCompact())) items.push({ id: 'release', label: 'benches.actions.release', icon: 'power', run: () => act.release() });
    if (you.admin) {
      items.push('separator');
      items.push({ id: 'assign', label: 'benches.actions.assign', icon: 'team', run: () => act.assign() });
      if (!d.lock) items.push({ id: 'lock', label: 'benches.actions.lock', icon: 'lock', run: () => act.lock() });
      else if (mainId !== 'unlock' || isCompact()) items.push({ id: 'unlock', label: 'benches.unlock.button', icon: 'lock', run: () => act.unlock() });
    }
    items.push('separator');
    items.push({ id: 'details', label: 'benches.actions.details', icon: 'info', href: `#/team/bench/${encodeURIComponent(d.bench)}` });
    return items;
  }

  /** The bench's page as a sheet: a phone has no room for it beside the diagram */
  function openSheet() {
    const name = model.bench;
    if (!name) return null;
    let panel = null;
    const sheetModel = watchBench(() => panel?.render());
    const sheetAct = benchActions(sheetModel);
    panel = createBenchPanel({ model: sheetModel, act: sheetAct, inlinePrimary: true, inSheet: true, onLeave: () => dlg.close() });
    const dlg = openDialog(h('div.modal-body.bench-sheet', panel.el), { title: () => t('benches.sheet.title', { bench: name }), size: 'lg' });
    sheetModel.setBench(name);
    dlg.closed.then(() => { sheetModel.destroy(); panel.destroy(); });
    return dlg;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function statusText(d) {
    const you = d.you;
    const team = d.holder?.teamName ?? '?';
    const time = d.releaseAt ? fmtTime(d.releaseAt) : '';
    if (d.lock) return [t('benches.strip.locked', { bench: d.bench, reason: d.lock.reason }), t('benches.strip.lockedShort', { reason: d.lock.reason })];
    if (!d.holder) return [t('benches.strip.free', { bench: d.bench }), t('benches.strip.freeShort')];
    if (you.member) return [t('benches.strip.mine', { bench: d.bench, team }), t('benches.strip.mineShort', { time })];
    if (you.guest) return [t('benches.strip.guest', { bench: d.bench, team }), t('benches.strip.guestShort', { team })];
    return [t('benches.strip.taken', { bench: d.bench, team }), t('benches.strip.takenShort', { team })];
  }

  function mainLine(d) {
    const [long, short] = statusText(d);
    const soon = releaseSoon(d);
    const tone = d.lock ? 'danger' : soon ? 'warning' : null;
    const lock = d.lock ? t('benches.lock.by', { name: d.lock.by?.name ?? '', time: fmtTime(d.lock.at) }) : null;
    const status = h('span.bench-status', { title: lock ?? (d.holder && d.releaseAt ? t('benches.status.releaseAt', { time: fmtTime(d.releaseAt) }) : null), role: d.lock ? 'status' : null },
      h('span.bench-dot', { 'aria-hidden': 'true' }),
      h('span.bench-text.long', long), h('span.bench-text.short', short));
    const people = d.occupants.length ? h('span.bench-people', avatarStack(d.occupants)) : null;
    const idle = d.holder && d.releaseAt && !soon ? h('span.bench-idle.long', t('benches.strip.autoRelease', { time: fmtTime(d.releaseAt) })) : null;
    const soonText = soon ? h('span.bench-idle.bench-soon', t('benches.strip.releaseSoon', { count: soon })) : null;
    const main = mainButton(d);
    const more = moreButton(() => menuItems(), { onSelect: () => {}, label: () => t('benches.strip.more') });
    const open = h('button.icon-btn.bench-open', { type: 'button', dataset: { action: 'sheet' }, title: t('benches.strip.details'), 'aria-label': t('benches.strip.details'), onclick: () => openSheet() }, icon('chevronUp'));
    const line = h('div.bench-line.bench-main', { dataset: { tone: tone ?? '' } }, status, people, idle, soonText, h('span.bench-actions', main, more), open);
    // A tap on the strip opens the bench's page on a phone; the buttons keep their own meaning
    line.addEventListener('click', (e) => { if (isCompact() && !e.target.closest('button, a')) openSheet(); });
    return line;
  }

  function requestLines(d) {
    if (!d.requests?.length) return null;
    return h('ul.bench-requests', { 'aria-label': t('benches.join.waiting') }, d.requests.map((r) => h('li.bench-line', { dataset: { user: r.username, tone: 'warning' } },
      h('span.bench-text', t('benches.join.asks', { name: r.name, time: fmtTime(r.at) })),
      d.you.canAnswer ? h('span.bench-actions',
        button('accept', t('benches.join.accept'), () => act.accept(r), '.primary'),
        button('refuse', t('benches.join.refuse'), () => act.refuse(r))) : null)));
  }

  function jobLine() {
    const job = model.job;
    if (!job || FINAL.has(job.state)) return null;
    const done = job.devices.filter((x) => FINAL.has(x.state)).length;
    const total = job.devices.length || 1;
    const text = job.state === 'pending'
      ? t('benches.job.pending', { kind: kindText(job.kind), name: job.actor?.name ?? '' })
      : t('benches.job.running', { kind: kindText(job.kind), name: job.actor?.name ?? '', done, total });
    const bar = h('progress.bench-progress', { max: String(total), value: String(job.state === 'pending' ? 0 : done), 'aria-label': text });
    return h('div.bench-line.bench-job', { dataset: { tone: 'info', state: job.state } },
      icon('archive'), h('span.bench-text', text),
      h('span.bench-actions', bar, h('a.btn.sm', { href: `#/jobs/${encodeURIComponent(job.bench)}`, dataset: { action: 'job' } }, t('benches.job.see'))));
  }

  let drawn = ''; // what the strip shows, to leave it alone (focus included) when an event brings nothing new
  function render(force = false) {
    const d = model.detail;
    if (!ready || !model.bench || !d) { el.hidden = true; drawn = ''; return; }
    const signature = JSON.stringify([d, model.job, releaseSoon(d), isCompact()]);
    if (!force && signature === drawn && !el.hidden) return;
    drawn = signature;
    el.hidden = false;
    el.dataset.state = d.lock ? 'locked' : d.holder ? 'taken' : 'free';
    el.dataset.mine = String(d.you.occupant);
    el.replaceChildren(mainLine(d), requestLines(d) ?? '', jobLine() ?? '');
    if (shown !== d) { shown = d; diagram?.refresh?.(); }
  }

  // ── Notifications that follow the user everywhere ────────────────────────

  function bindNotifications() {
    live.on('teams:invitation', (data) => toast(t('teams.notify.invited', { team: data.team.name, name: data.by.name }), 'info', 10_000));
    live.on('benches:request', (data) => {
      const key = { accepted: 'benches.notify.accepted', refused: 'benches.notify.refused', released: 'benches.notify.released', removed: 'benches.notify.removed' }[data.state];
      if (key) toast(t(key, { bench: data.bench, name: data.by ?? '' }), data.state === 'accepted' ? 'info' : 'warn', 8000);
    });
    live.on('benches:warning', (data) => toast(t('benches.notify.warning', { bench: data.bench, team: data.team ?? '?', minutes: data.minutes, count: data.minutes }), 'warn', 20_000));
    live.on('benches:slot', (data) => toast(t('benches.notify.slot', { bench: data.bench, end: fmtTime(data.end) }), 'info', 12_000));
  }

  // ── Diagram decorations (rooms lot API, ARCHITECTURE §8), when available ──

  function decorate(view) {
    if (typeof view?.decorate !== 'function') return; // the diagram has no decoration layer yet: nothing to do
    diagram = view;
    view.decorate('benches', (device) => {
      const detail = model.detail;
      if (!model.bench || !detail || device.labName && device.labName !== model.bench) return null;
      if (detail.lock) return { ring: 'locked', tooltip: t('benches.lock.banner') };
      if (detail.you.occupant) return { ring: 'ours' };
      if (detail.holder) return { ring: 'taken', tooltip: t('benches.status.taken', { team: detail.holder.teamName ?? '?', time: fmtTime(detail.holder.since) }) };
      return null;
    });
  }

  return {
    el,
    ready: start,
    setBench: (name) => model.setBench(name),
    decorate,
    openSheet,
    /** False when the server would refuse this console to me: the bench is locked, or held by a team I am not with */
    mayOpen: (device, benchNames) => mayPilot(device, benchNames),
    /** Why a console is refused, for the toast */
    refusal(benchNames) {
      // Any of the device's benches may hold the lock: a console line shared with a locked bench is refused too
      const lockOf = (n) => (model.detail?.bench === n ? model.detail.lock : null) ?? benchSummary(n)?.lock ?? null;
      const locked = benchNames.find((n) => lockOf(n));
      if (locked) return t('benches.refused.locked', { bench: locked, reason: lockOf(locked).reason });
      return t('benches.refused.taken', { bench: benchNames[0] ?? '' });
    },
    isOccupant: () => isOccupant(model.detail),
  };
}
