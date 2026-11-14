/**
 * One bench as a card: the team that holds it, who is on it, the consoles
 * open and who pilots them, the job that runs, the lock, the next slots and
 * how its console lines stand (with the last line status of the bench
 * checks while it is fresh). The same card serves the overview of every
 * bench and, larger, the home page's "our bench"
 *
 *   benchCard(card, { actions })     card: one entry of GET /api/overview/benches
 *
 * Text only (names come from other people), every string through t()
 */
import { h, icon } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { fmtTime, fmtSlot, fmtDateTime } from '../teams/data.js';
import { kindText, stateText } from '../jobs/text.js';

const CONSOLE_STATES = { connected: 'connected', silent: 'silent' };

/** A room state as the card says it: anything that is not connected or silent is a line still opening */
const consoleState = (state) => CONSOLE_STATES[state] ?? 'connecting';

export function benchCard(c, { actions = [] } = {}) {
  const el = h('article.ov-card', { dataset: { bench: c.bench, state: c.state, mine: String(c.you.occupant) } });

  el.append(h('header.ov-card-head',
    h('h2.ov-bench', c.bench),
    h(`span.ov-state.${c.state}`, t(`overview.state.${c.state}`)),
    c.you.occupant ? h('span.ov-you', t('overview.card.yours')) : null,
    c.requests ? h('span.ov-requests', { title: t('overview.card.requestsHint') }, icon('team'), t('overview.card.requests', { count: c.requests })) : null));

  // Who holds it
  el.append(c.holder
    ? h('p.ov-holder', icon('team'), h('span', t('overview.card.heldBy', { team: c.holder.teamName ?? '?', time: fmtTime(c.holder.since) })))
    : h('p.ov-holder.muted', icon('check'), h('span', t('overview.card.free'))));
  if (c.lock) {
    el.append(h('p.ov-lock', { role: 'status' }, icon('lock'),
      h('span', h('strong', t('overview.card.locked')), ' ', c.lock.reason, ' ', h('span.muted', t('overview.card.lockedBy', { name: c.lock.by, time: fmtDateTime(c.lock.at) })))));
  }
  if (c.occupants.length) {
    el.append(h('ul.ov-people', { 'aria-label': t('overview.card.onBench') }, c.occupants.map((p) => h('li',
      { dataset: { guest: String(p.guest) } }, p.name, p.guest ? h('small', t('overview.card.guest')) : null))));
  }

  // The job that runs: everyone sees the kind, the state and how far it is
  if (c.job) {
    el.append(h('p.ov-job', { role: 'status' }, icon('play'),
      h('span', h('strong', `${kindText(c.job.kind)} · ${stateText(c.job.state)}`), ' ',
        t('overview.card.jobBy', { count: c.job.devices.total, name: c.job.actor, done: c.job.devices.finished, total: c.job.devices.total }))));
  }

  // The consoles open, their pilots, and the state of the lines
  const lines = h('p.ov-lines', icon('terminal'), h('span', t('overview.card.lines', { count: c.lines.open, total: c.lines.total })));
  if (c.lines.busy) lines.append(h('span.ov-pill.busy', { title: t('overview.card.busyHint') }, t('overview.card.busy', { count: c.lines.busy })));
  if (c.lines.silent) lines.append(h('span.ov-pill.silent', { title: t('overview.card.silentHint') }, t('overview.card.silent', { count: c.lines.silent })));
  // The last line status of the bench checks, while it is fresh: the lines it found free
  if (c.lines.free) lines.append(h('span.ov-pill.free', { title: t('overview.card.freeHint') }, t('overview.card.freeLines', { count: c.lines.free })));
  if (c.lines.checkedAt) lines.append(h('small.muted.ov-checked', { dataset: { checked: c.lines.checkedAt } }, t('overview.card.checkedAt', { time: fmtTime(c.lines.checkedAt) })));
  el.append(lines);
  if (c.consoles.length) {
    el.append(h('ul.ov-consoles', c.consoles.map((k) => h('li', { dataset: { device: k.device, state: consoleState(k.state) } },
      h('strong', k.device),
      h('span', k.pilot ? t('overview.card.pilot', { name: k.pilot }) : t('overview.card.noPilot')),
      h('small.muted', [
        t('overview.card.people', { count: k.people }),
        k.shared ? t('overview.card.shared') : null,
        k.task ? t('overview.card.task') : null,
        k.state === 'connected' ? null : t(`overview.console.${consoleState(k.state)}`),
      ].filter(Boolean).join(' · '))))));
  }

  // Next slots
  if (c.slots.length) {
    el.append(h('div.ov-slots', h('h3', t('overview.card.slots')), h('ul', c.slots.map((s) => h('li', { dataset: { mine: String(s.mine) } },
      fmtSlot(s), ' ', h('span.muted', s.mine ? t('overview.card.slotMine') : s.teamName ?? ''))))));
  }

  const footer = h('footer.ov-card-foot',
    c.holder && c.releaseAt ? h('span.muted.ov-release', t('overview.card.releaseAt', { time: fmtTime(c.releaseAt) })) : null,
    h('div.ov-actions',
      actions.map((a) => h('a.btn.small', { href: a.href, dataset: { action: a.id } }, a.label)),
      h('a.btn.small.primary', { href: `#/consoles/${encodeURIComponent(c.bench)}`, dataset: { action: 'open' } }, t('overview.card.open'))));
  el.append(footer);
  return el;
}
