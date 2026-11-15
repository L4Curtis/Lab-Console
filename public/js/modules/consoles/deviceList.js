/**
 * The bench as a list (UX.md §8.3, "Liste"): one 64 px row per device, read
 * the way the diagram reads (routers, then switches, by number): its glyph,
 * name and console address, its state, who is on it. A tap opens the
 * console; a long press (or a right click) opens the device sheet
 *
 *   const list = new DeviceList({ onOpen, onMenu });
 *   el.append(list.el);
 *   list.render(lab, { stateOf: (device) => 'idle' | 'open' | 'live' | 'busy' | 'disabled', roomOf: (device) => summary | undefined });
 */
import { h, icon } from '../../core/dom.js';
import { t, tAttr } from '../../core/i18n.js';
import { avatar } from '../../shared/presenceBar.js';
import { deviceGlyph } from './diagramView.js';

const LONG_PRESS_MS = 500;
const TONE = { idle: 'success', open: 'info', live: 'info', busy: 'warning', disabled: 'neutral' };

/** The state of a device as a few words: Libre, Ouverte ici, Avec Alice (main)… */
export function deviceStateText(state, room) {
  if (state === 'live') return room?.pilot ? t('consoles.list.with', { name: room.pilot.name }) : t('consoles.list.live');
  return t(`consoles.list.${state}`);
}

export class DeviceList {
  constructor({ onOpen, onMenu }) {
    this.onOpen = onOpen;
    this.onMenu = onMenu;
    this.el = h('ul.device-list', tAttr('aria-label', 'consoles.view.list'));
  }

  render(lab, { stateOf, roomOf }) {
    if (!lab) { this.el.replaceChildren(); return; }
    const devices = [...lab.devices].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    this.el.replaceChildren(...devices.map((d) => this.#row(d, stateOf(d), roomOf(d))));
  }

  #row(device, state, room) {
    const people = room?.users ?? [];
    const label = t('consoles.diagram.device', { name: device.name, state: deviceStateText(state, room) });
    const b = h('button.device-row', { type: 'button', dataset: { state, device: device.name }, 'aria-label': label, disabled: state === 'disabled' ? true : null },
      h('span.device-row-glyph', { dataset: { kind: device.kind } }, deviceGlyph(device.kind)),
      h('span.device-row-main',
        h('strong.device-row-name', device.name),
        h('code.device-row-addr', `${device.target.host}:${device.target.port}`)),
      h('span.device-row-side',
        h('span.badge', { dataset: { tone: TONE[state] ?? 'neutral' } }, h('span.dot'), deviceStateText(state, room)),
        people.length ? h('span.avatar-stack', people.slice(0, 3).map((u) => avatar(u, u.pilot))) : null),
      icon('chevronRight', 'device-row-chevron'));
    let timer = 0;
    let pressed = false;
    b.addEventListener('click', () => { if (!pressed) this.onOpen(device); pressed = false; });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!pressed) this.onMenu?.(device); });
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !this.onMenu) return;
      pressed = false;
      clearTimeout(timer);
      timer = setTimeout(() => { pressed = true; this.onMenu(device); }, LONG_PRESS_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(type, () => clearTimeout(timer));
    return h('li', b);
  }
}
