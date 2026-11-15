/**
 * One bench of the lab, the way the home page's "Le labo" shows it (docs/v2/UX.md §10.1):
 * a name and a state, the team that holds it, how many consoles are open, the
 * next slot, and one button to open it. Pieces shared with the "Ma baie" card:
 *
 *   stateBadge(card)            a word and a dot: Libre, Prise, Verrouillée
 *   initialsOf(name)            "Alice Martin" → "AM"
 *   avatarStack(names, { max }) the first people of a list as avatars, then "+n"
 *   benchCard(card)             the compact card of the PC's grid
 *
 * `card` is one entry of GET /api/overview/benches. Text only (names come from
 * other people), every string through t()
 */
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { fmtSlot } from '../teams/data.js';
import { kindText } from '../jobs/text.js';
import { fmtTime } from '../../core/format.js';

const TONES = { free: 'success', taken: 'info', locked: 'danger' };

export const stateTone = (state) => TONES[state] ?? 'neutral';

/** Libre / Prise / Verrouillée, as a word (never a colour alone) */
export function stateBadge(card) {
  return h('span.badge', { dataset: { tone: stateTone(card.state), state: card.state } }, h('span.dot'), t(`overview.state.${card.state}`));
}

export const initialsOf = (name) => (String(name ?? '').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] ?? '').join('') || '?');

/** At most `max` avatars of the people in `names`, then "+n" */
export function avatarStack(names, { max = 3, label } = {}) {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return h('span.avatar-stack', { role: 'img', 'aria-label': label ?? names.join(', ') },
    shown.map((n) => h('span.avatar', { title: n, 'aria-hidden': 'true' }, initialsOf(n))),
    more > 0 ? h('span.avatar-more', { 'aria-hidden': 'true' }, `+${more}`) : null);
}

/** "Les routeurs", or nothing for a bench nobody holds */
export const holderText = (c) => (c.holder ? c.holder.teamName ?? '?' : '');

/**
 * How the console lines stand, when there is something to say: refused by the
 * console server (busy outside the application), silent, and, while the last
 * line check is fresh, found free. Null when all is ordinary
 */
export function lineStatus(c) {
  const { busy, silent, free, checkedAt } = c.lines;
  if (!busy && !silent && !free) return null;
  const pill = (kind, text, hint) => h(`span.badge.ov-pill.${kind}`, { dataset: { tone: { busy: 'warning', silent: 'danger', free: 'success' }[kind] }, title: hint }, text);
  return h('p.ov-meta.ov-lines',
    busy ? pill('busy', t('overview.card.busy', { count: busy }), t('overview.card.busyHint')) : null,
    silent ? pill('silent', t('overview.card.silent', { count: silent }), t('overview.card.silentHint')) : null,
    free ? pill('free', t('overview.card.freeLines', { count: free }), t('overview.card.freeHint')) : null,
    checkedAt ? h('small.ov-checked', { dataset: { checked: checkedAt } }, t('overview.card.checkedAt', { time: fmtTime(checkedAt) })) : null);
}

export function benchCard(c) {
  const el = h('article.ov-card', { dataset: { bench: c.bench, state: c.state, mine: String(c.you.occupant) } },
    h('header.ov-card-head',
      h('h3.ov-bench', c.bench),
      stateBadge(c),
      c.you.occupant ? h('span.badge.ov-you', { dataset: { tone: 'info' } }, t('overview.card.yours')) : null));
  if (c.holder) el.append(h('p.ov-holder', holderText(c)));
  if (c.lock) el.append(h('p.ov-lock', { role: 'status' }, h('strong', t('overview.card.locked')), ' ', c.lock.reason));
  el.append(h('p.ov-meta', t('overview.card.lines', { count: c.lines.open, total: c.lines.total })));
  const status = lineStatus(c);
  if (status) el.append(status);
  if (c.job) el.append(h('p.ov-meta.ov-job', { role: 'status' }, t('overview.card.job', { kind: kindText(c.job.kind), name: c.job.actor, done: c.job.devices.finished, total: c.job.devices.total })));
  if (c.slots[0]) el.append(h('p.ov-meta.ov-slot', { dataset: { mine: String(c.slots[0].mine) } }, t('overview.card.nextSlot', { slot: fmtSlot(c.slots[0]) })));
  el.append(h('a.btn.sm.ov-open', { href: `#/consoles/${encodeURIComponent(c.bench)}`, dataset: { action: 'open' } }, t('overview.card.open')));
  return el;
}
