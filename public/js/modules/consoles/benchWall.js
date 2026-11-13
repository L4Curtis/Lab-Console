/**
 * The bench wall: every console open on one bench, side by side, as small
 * live read-only terminals. An instructor (or a team) sees the whole bench
 * at a glance without taking a keyboard or a console slot: each tile joins
 * its line with `mode=wall` (watch only, not counted in the per-user limit).
 * Lines opened while the wall is up appear on it; closed ones say so
 */
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { h } from '../../core/dom.js';
import { live } from '../../core/api.js';
import { t, tNode } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';
import { serverText } from '../../shared/serverText.js';
import { THEME } from '../../shared/terminalPane.js';

/**
 * @param lab      the bench (a lab of /api/consoles/labs)
 * @param onOpen   (device) => void: open that console in the workspace (a tile's button)
 */
export function openBenchWall(lab, { onOpen }) {
  const tiles = new Map(); // target → tile
  const grid = h('div.wall-grid');
  const empty = h('p.muted.wall-empty', tNode('consoles.wall.empty'));
  const body = h('div.wall.modal-body', h('p.wall-intro', tNode('consoles.wall.intro')), empty, grid);
  const dlg = openDialog(body, { title: t('consoles.wall.title', { bench: lab.name }), wide: true });
  dlg.el.classList.add('wall-dialog');

  const deviceOf = (target) => lab.devices.find((d) => `${d.target.host}:${d.target.port}` === target);
  const off = live.on('consoles:rooms', (rooms) => {
    const here = rooms.filter((r) => deviceOf(r.target));
    for (const r of here) {
      if (!tiles.has(r.target)) tiles.set(r.target, tile(deviceOf(r.target), onOpen, () => dlg.close()));
      tiles.get(r.target).update(r);
    }
    const order = [...tiles.values()].sort((a, b) => a.device.name.localeCompare(b.device.name));
    grid.replaceChildren(...order.map((x) => x.el));
    empty.hidden = tiles.size > 0;
    for (const x of tiles.values()) x.fit();
  });

  dlg.closed.then(() => {
    off();
    for (const x of tiles.values()) x.dispose();
  });
  return dlg;
}

function tile(device, onOpen, closeWall) {
  const term = new Terminal({ fontSize: 11, lineHeight: 1.1, disableStdin: true, cursorBlink: false, scrollback: 500, theme: THEME, fontFamily: '"IBM Plex Mono", ui-monospace, monospace' });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const pilot = h('span.wall-pilot');
  const state = h('span.wall-state');
  const screen = h('div.wall-screen');
  const el = h('article.wall-tile', { dataset: { target: `${device.target.host}:${device.target.port}` } },
    h('header', h('strong', device.name), pilot, state,
      h('button.btn.small', { type: 'button', onclick: () => { closeWall(); onOpen(device); } }, tNode('consoles.wall.open'))),
    screen);
  let ws = null;
  let opened = false;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ device: device.key, mode: 'wall', cols: 80, rows: 24 });
    ws = new WebSocket(`${proto}://${location.host}/ws/console?${q}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return term.write(new Uint8Array(e.data));
      const msg = JSON.parse(e.data);
      if (msg.type === 'exit' || msg.type === 'error') {
        el.dataset.ended = 'true';
        state.textContent = serverText(msg);
      }
    };
  };

  return {
    el,
    device,
    update(r) {
      pilot.textContent = r.pilot ? t('consoles.live.pilot', { name: r.pilot.name }) : t('consoles.live.noPilot');
      if (!opened) {
        opened = true;
        // The terminal needs its element in the page to measure itself
        requestAnimationFrame(() => { term.open(screen); try { fit.fit(); } catch { /* hidden */ } connect(); });
      }
    },
    fit() { try { fit.fit(); } catch { /* not laid out yet */ } },
    dispose() {
      if (ws) { ws.onmessage = null; ws.close(); }
      term.dispose();
    },
  };
}
