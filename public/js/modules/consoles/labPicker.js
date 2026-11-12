/**
 * Lab selector drawn as rack elevations
 *
 * Page names like "B4H / B4M / B4B" read as bay 4, top/middle/bottom
 * (Haut/Milieu/Bas), so they are shown stacked the way they sit in the room
 * A missing position becomes a blanking panel
 * Any naming that doesn't follow that pattern falls back to plain tabs
 */
import { h } from '../../core/dom.js';
import { t, tAttr, onLocaleChange } from '../../core/i18n.js';

const POSITION = /^(.*?\d+)\s*[-_ ]?\s*([HMB])$/i;
const ORDER = ['H', 'M', 'B'];

export class LabPicker {
  #buttons = new Map();
  #labels = new Map(); // button → lab

  constructor(container, { onSelect }) {
    this.onSelect = onSelect;
    this.el = h('nav.lab-picker', tAttr('aria-label', 'consoles.picker.label'));
    container.append(this.el);
    onLocaleChange(() => this.#relabel());
  }

  render(labs) {
    this.#buttons.clear();
    this.#labels.clear();
    const parsed = labs.map((lab) => ({ lab, m: lab.name.match(POSITION) }));
    const asRacks = parsed.length > 1 && parsed.every((p) => p.m);
    this.el.classList.toggle('as-racks', asRacks);

    if (!asRacks) {
      this.el.replaceChildren(h('div.lab-tabs', labs.map((lab) => this.#button(lab, 'lab-tab'))));
      this.#relabel();
      return;
    }
    const bays = new Map();
    for (const { lab, m } of parsed) {
      const bay = m[1].toUpperCase();
      if (!bays.has(bay)) bays.set(bay, {});
      bays.get(bay)[m[2].toUpperCase()] = lab;
    }
    this.el.replaceChildren(...[...bays].map(([bay, slots]) =>
      h('div.rack', { role: 'group', dataset: { bay } },
        h('span.rack-plate', bay),
        ORDER.map((pos) => slots[pos] ? this.#button(slots[pos], 'rack-slot') : h('span.rack-slot.blank', { 'aria-hidden': 'true' })))));
    this.#relabel();
  }

  #button(lab, cls) {
    const b = h(`button.${cls}`, { type: 'button', onclick: () => this.onSelect(lab) },
      h('span.slot-led', { 'aria-hidden': 'true' }), h('span', lab.name));
    this.#buttons.set(lab.id, b);
    this.#labels.set(b, lab);
    return b;
  }

  /** Titles and rack names contain a number or a name: written again when the language changes */
  #relabel() {
    for (const [b, lab] of this.#labels) b.title = t('consoles.picker.devices', { name: lab.name, count: lab.devices.length });
    for (const rack of this.el.querySelectorAll('.rack')) rack.setAttribute('aria-label', t('consoles.picker.bay', { bay: rack.dataset.bay }));
  }

  setActive(labId) {
    for (const [id, b] of this.#buttons) {
      b.classList.toggle('active', id === labId);
      b.setAttribute('aria-current', id === labId ? 'page' : 'false');
    }
  }

  /** Light the slot LED of labs that have a console open in this browser */
  setLive(labIds) {
    for (const [id, b] of this.#buttons) b.classList.toggle('live', labIds.has(id));
  }
}
