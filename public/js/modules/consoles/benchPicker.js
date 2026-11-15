/**
 * The bench picker of the consoles section (UX.md §8.1, §8.3): a button
 * "● B4M ▾" (the dot is the bench's state) that opens
 *   - from 720 px, a popover with the racks as they stand in the room: page
 *     names like "B4H / B4M / B4B" read as bay 4, top / middle / bottom
 *     (Haut / Milieu / Bas), drawn stacked, a missing position as a blanking
 *     panel; each slot says its state, "vous" on our bench, a lock on a
 *     locked one. Arrows move between slots, Enter chooses
 *   - on a phone, a sheet: our bench first under "Votre baie", then every
 *     bench by rack, with its state, its team and its open consoles
 * Names that do not follow the pattern are listed in one group.
 *
 *   const picker = new BenchPicker({ onSelect: (lab) => …, openCount: (lab) => n });
 *   header.append(picker.button());          // as many buttons as layouts need; they stay in step
 *   picker.render(labs); picker.setActive(lab.id); picker.setLive(labIds); picker.refresh();
 */
import { h, icon, loadCss } from '../../core/dom.js';
import { t, onLocaleChange } from '../../core/i18n.js';
import { isCompact } from '../../core/viewport.js';
import { openDialog } from '../../shared/dialog.js';
import { benchSummary, isOccupant, onBenches } from '../teams/data.js';

const POSITION = /^(.*?\d+)\s*[-_ ]?\s*([HMB])$/i;
const ORDER = ['H', 'M', 'B'];
const TONE = { free: 'success', taken: 'neutral', mine: 'info', locked: 'danger' };

/** What a bench is for me now: free, taken by another team, ours, locked by an administrator */
export function benchState(name) {
  const s = benchSummary(name);
  if (s?.lock) return 'locked';
  if (isOccupant(s)) return 'mine';
  if (s?.holder) return 'taken';
  return 'free';
}

/** The racks: [{ bay, slots: { H, M, B } }], or null when the names are not rack positions */
function racksOf(labs) {
  const parsed = labs.map((lab) => ({ lab, m: lab.name.match(POSITION) }));
  if (parsed.length < 2 || !parsed.every((p) => p.m)) return null;
  const bays = new Map();
  for (const { lab, m } of parsed) {
    const bay = m[1].toUpperCase();
    if (!bays.has(bay)) bays.set(bay, {});
    bays.get(bay)[m[2].toUpperCase()] = lab;
  }
  return [...bays].map(([bay, slots]) => ({ bay, slots }));
}

export class BenchPicker {
  #labs = [];
  #active = null;
  #live = new Set();
  #buttons = [];
  #pop = null;

  constructor({ onSelect, openCount = () => 0 }) {
    this.onSelect = onSelect;
    this.openCount = openCount;
    loadCss('consoles');
    onLocaleChange(() => this.refresh());
    onBenches(() => this.refresh());
  }

  /** A picker button (the header has one, the phone's bench line another) */
  button(cls = '') {
    const b = h(`button.bench-picker.lab-picker${cls}`, { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', dataset: { action: 'pick-bench' }, onclick: () => this.open(b) },
      h('span.bench-dot', { 'aria-hidden': 'true' }), h('span.bench-picker-name'), icon('chevronDown'));
    this.#buttons.push(b);
    this.refresh();
    return b;
  }

  render(labs) {
    this.#labs = labs;
    this.refresh();
    if (this.#pop) this.#fillPop();
  }

  setActive(labId) {
    this.#active = labId;
    this.refresh();
  }

  /** Light the slot of the benches that have a console open in this browser */
  setLive(labIds) {
    this.#live = labIds;
    if (this.#pop) this.#fillPop();
  }

  get current() { return this.#labs.find((l) => l.id === this.#active) ?? null; }

  refresh() {
    const lab = this.current;
    const state = lab ? benchState(lab.name) : 'free';
    for (const b of this.#buttons) {
      b.dataset.state = state;
      b.querySelector('.bench-picker-name').textContent = lab?.name ?? t('consoles.picker.none');
      const label = lab ? t('consoles.picker.button', { name: lab.name, state: t(`consoles.picker.state.${state}`) }) : t('consoles.picker.label');
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = !this.#labs.length;
    }
  }

  open(anchor) {
    if (!this.#labs.length) return;
    if (isCompact()) this.#openSheet(anchor);
    else this.#openPop(anchor);
  }

  // ── From 720 px: the racks in a popover ──────────────────────────────────

  #openPop(anchor) {
    if (this.#pop) { this.#closePop(); return; }
    const pop = h('div.bench-pop', { role: 'dialog', 'aria-label': t('consoles.picker.label') });
    if ('popover' in pop) pop.popover = 'manual';
    document.body.append(pop);
    this.#pop = { el: pop, anchor };
    this.#fillPop();
    pop.showPopover?.();
    const a = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(a.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${a.bottom + 4}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) this.#closePop(); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.#closePop(true); } };
    document.addEventListener('pointerdown', outside, true);
    pop.addEventListener('keydown', key);
    this.#pop.stop = () => document.removeEventListener('pointerdown', outside, true);
    (pop.querySelector('[aria-current="true"]') ?? pop.querySelector('button'))?.focus();
  }

  #closePop(refocus = false) {
    if (!this.#pop) return;
    const { el, anchor, stop } = this.#pop;
    this.#pop = null;
    stop?.();
    try { el.hidePopover?.(); } catch { /* already hidden */ }
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus();
  }

  #fillPop() {
    const { el } = this.#pop;
    const racks = racksOf(this.#labs);
    const slot = (lab) => {
      const state = benchState(lab.name);
      const s = benchSummary(lab.name);
      const b = h('button.rack-slot', {
        type: 'button', dataset: { state, bench: lab.name }, 'aria-current': String(lab.id === this.#active),
        title: [lab.name, t(`consoles.picker.state.${state}`), s?.holder?.teamName ?? '', t('consoles.picker.devices', { count: lab.devices.length })].filter(Boolean).join(' · '),
        onclick: () => { this.#closePop(); this.onSelect(lab); },
      },
      h('span.slot-led', { 'aria-hidden': 'true', dataset: { live: String(this.#live.has(lab.id)) } }),
      h('span.slot-name', lab.name),
      state === 'mine' ? h('span.slot-you', t('consoles.picker.you')) : null,
      state === 'locked' ? icon('lock', 'slot-lock') : null);
      return b;
    };
    const body = racks
      ? h('div.racks', racks.map(({ bay, slots }) => h('div.rack', { role: 'group', 'aria-label': t('consoles.picker.bay', { bay }) },
        h('span.rack-plate', bay),
        ORDER.map((pos) => (slots[pos] ? slot(slots[pos]) : h('span.rack-slot.blank', { 'aria-hidden': 'true' }))))))
      : h('div.racks.flat', h('div.rack', this.#labs.map(slot)));
    const legend = h('p.bench-legend', ['free', 'taken', 'mine', 'locked'].map((s) => h('span', { dataset: { state: s } }, h('span.bench-dot', { 'aria-hidden': 'true' }), t(`consoles.picker.state.${s}`))));
    el.replaceChildren(h('h2.bench-pop-title', t('consoles.picker.label')), body, legend);
    this.#arrowKeys(el, Boolean(racks));
  }

  /** Arrows between the slots: up and down in a rack, left and right from rack to rack */
  #arrowKeys(el, asRacks) {
    el.onkeydown = (e) => {
      const slots = [...el.querySelectorAll('button.rack-slot')];
      const at = slots.indexOf(document.activeElement);
      if (at < 0 || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      let next;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = slots.length - 1;
      else if (!asRacks || e.key === 'ArrowUp' || e.key === 'ArrowDown') next = at + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1);
      else {
        // The slot at the same height in the next rack (or the nearest one)
        const rack = slots[at].closest('.rack');
        const racks = [...el.querySelectorAll('.rack')];
        const target = racks[racks.indexOf(rack) + (e.key === 'ArrowLeft' ? -1 : 1)];
        if (!target) return;
        const y = slots[at].getBoundingClientRect().top;
        const options = [...target.querySelectorAll('button.rack-slot')];
        const best = options.sort((a, b) => Math.abs(a.getBoundingClientRect().top - y) - Math.abs(b.getBoundingClientRect().top - y))[0];
        best?.focus();
        return;
      }
      slots[Math.max(0, Math.min(slots.length - 1, next))]?.focus();
    };
  }

  // ── On a phone: a sheet ──────────────────────────────────────────────────

  #openSheet(anchor) {
    const racks = racksOf(this.#labs);
    let dlg = null;
    const row = (lab) => {
      const state = benchState(lab.name);
      const s = benchSummary(lab.name);
      const open = this.openCount(lab);
      return h('li', h('button.bench-row', {
        type: 'button', dataset: { state, bench: lab.name }, 'aria-current': String(lab.id === this.#active),
        onclick: () => { dlg.close(); this.onSelect(lab); },
      },
      h('span.bench-row-main',
        h('strong.bench-row-name', lab.name),
        h('span.bench-row-meta', [s?.holder?.teamName, open ? t('consoles.picker.open', { count: open }) : t('consoles.picker.devices', { count: lab.devices.length })].filter(Boolean).join(' · '))),
      h('span.badge', { dataset: { tone: TONE[state] } }, state === 'locked' ? icon('lock') : h('span.dot'), t(`consoles.picker.state.${state}`)),
      lab.id === this.#active ? icon('check', 'bench-row-check') : null));
    };
    const groups = [];
    const ours = this.#labs.filter((l) => benchState(l.name) === 'mine');
    if (ours.length) groups.push([t('consoles.picker.ours'), ours]);
    if (racks) for (const { bay, slots } of racks) groups.push([t('consoles.picker.bay', { bay }), ORDER.map((p) => slots[p]).filter(Boolean)]);
    else groups.push([t('consoles.picker.label'), this.#labs]);
    const list = h('div.bench-sheet.modal-body', groups.map(([title, labs]) => h('section',
      h('h3.bench-group', title),
      h('ul.bench-rows', labs.map(row)))));
    anchor.setAttribute('aria-expanded', 'true');
    dlg = openDialog(list, { title: t('consoles.picker.label'), initialFocus: list.querySelector('[aria-current="true"]') ?? undefined });
    dlg.closed.then(() => anchor.setAttribute('aria-expanded', 'false'));
  }
}
