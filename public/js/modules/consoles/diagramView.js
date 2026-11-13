/**
 * Native SVG renderer for one lab page
 *
 * The server already parsed the .drawio file and routed every edge, so this
 * only draws; Each device is a real <g role="button"> element: clicks,
 * keyboard (Tab + Enter), hover and live status are plain DOM - no hit-testing
 * through a third-party viewer, no overlay tricks
 *
 *   const view = new DiagramView(container, { onOpen(device) {} })
 *   view.render(lab); view.setStates(device => 'idle' | 'open' | 'live' | 'busy' | 'disabled')
 *
 * Decorations (ARCHITECTURE §8): other features draw on the devices without
 * touching this file. A layer is a function of the device, asked again on
 * refresh(); what several layers return is combined, in the order the
 * layers were added:
 *
 *   view.decorate('presence', (device) => ({
 *     ring: 'pilot',                                   // a class: .deco-ring.ring-pilot (the last layer's wins)
 *     badges: [{ text: 'AM', color: '#3E8FC9', title: 'Alice Martin', kind: 'pilot' }],
 *     tooltip: ['Alice Martin has the keyboard'],      // extra lines of the device's tooltip
 *   }) | null)
 *   view.refresh()                                     // after the data behind a layer changed
 *   view.decorate('presence', null)                    // remove a layer
 *   view.destroy()                                     // the view is thrown away: stop listening
 *
 * Other lots do not hold the view: they register their layer once with
 * `registerDiagramLayer(name, fn)` (shared/diagramLayers.js), which every
 * view uses after its own layers, and call `refreshDiagram()`.
 */
import { svg, h, icon } from '../../core/dom.js';
import { t, tAttr, onLocaleChange } from '../../core/i18n.js';
import { diagramLayers, onDiagramLayersChange } from '../../shared/diagramLayers.js';

// Device glyphs, drawn in a 24×24 box centred in the device tile
const GLYPHS = {
  router: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M6.5 12h11 M15.2 9.8l2.3 2.2-2.3 2.2 M8.8 9.8L6.5 12l2.3 2.2 M12 6.5v11 M9.8 8.8L12 6.5l2.2 2.3 M9.8 15.2l2.2 2.3 2.2-2.3',
  switch: 'M3 6.5h18v11H3z M6.5 10.2h10 M14.3 8l2.2 2.2-2.2 2.2 M17.5 13.8h-10 M9.7 11.6l-2.2 2.2 2.2 2.2',
  l3switch: 'M3 6.5h18v11H3z M6.5 10.2h10 M14.3 8l2.2 2.2-2.2 2.2 M17.5 13.8h-10 M9.7 11.6l-2.2 2.2 2.2 2.2 M12 3v3.5 M12 17.5V21',
  firewall: 'M3.5 5h17v14h-17z M3.5 9.7h17 M3.5 14.3h17 M9 5v4.7 M15 5v4.7 M12 9.7v4.6 M9 14.3V19 M15 14.3V19',
  server: 'M5 3.5h14v7H5z M5 13.5h14v7H5z M8 7h.5 M8 17h.5',
  host: 'M3.5 4.5h17v11h-17z M9 20h6 M12 15.5V20',
  generic: 'M4 5h16v14H4z M8 10h8 M8 14h5',
};

// What a device's state says (consoles.state.<state>)
const stateText = (state) => t(`consoles.state.${state}`);

export class DiagramView {
  #lab = null;
  #k = 1; #tx = 0; #ty = 0;
  #autoFit = true;
  #deviceEls = new Map();
  #layers = new Map(); // name → (device) => decoration | null
  #stop = []; // what destroy() undoes: listeners on module-wide registries, the resize observer

  constructor(container, { onOpen }) {
    this.onOpen = onOpen;
    this.el = container;
    this.svg = svg('svg', { class: 'diagram-svg', role: 'img' });
    this.viewport = svg('g', { class: 'viewport' });
    this.svg.append(this.viewport);
    this.tooltip = h('div.diagram-tip', { role: 'tooltip' });
    this.zoomLabel = h('span.zoom-level', '100%');
    this.controls = h('div.zoom-controls',
      h('button.icon-btn', { type: 'button', ...tAttr('title', 'consoles.diagram.zoomOut'), onclick: () => this.zoomBy(1 / 1.25) }, icon('minus')),
      this.zoomLabel,
      h('button.icon-btn', { type: 'button', ...tAttr('title', 'consoles.diagram.zoomIn'), onclick: () => this.zoomBy(1.25) }, icon('plus')),
      h('button.icon-btn', { type: 'button', ...tAttr('title', 'consoles.diagram.fit'), onclick: () => this.fit(true) }, icon('fit')));
    container.append(this.svg, this.controls, this.tooltip);
    this.#bindPanZoom();
    const resize = new ResizeObserver(() => this.#autoFit && this.fit());
    resize.observe(container);
    this.#stop.push(
      onLocaleChange(() => this.#relabel()),
      onDiagramLayersChange(() => this.refresh()),
      () => resize.disconnect(),
    );
  }

  /** Stop listening to the language, the shared layer registry and the container's size */
  destroy() {
    for (const stop of this.#stop.splice(0)) stop();
  }

  render(lab) {
    this.#lab = lab;
    this.#deviceEls.clear();
    this.viewport.replaceChildren(
      svg('g', { class: 'layer-shapes' }, lab.shapes.map((s) => this.#shape(s))),
      svg('g', { class: 'layer-edges' }, lab.edges.map((e) => this.#edge(e))),
      svg('g', { class: 'layer-devices' }, lab.devices.map((d) => this.#device(d))),
    );
    this.#relabel();
    // One transparent hit area per device covering icon *and* label, so the
    // gap between them is clickable too
    for (const { el } of this.#deviceEls.values()) {
      const b = el.getBBox();
      el.prepend(svg('rect', { class: 'device-hit', x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12, rx: 8 }));
    }
    this.refresh();
    this.fit(true);
  }

  /** Add (or replace, or with `null` remove) a decoration layer */
  decorate(layer, fn) {
    if (fn === null) this.#layers.delete(layer);
    else if (typeof fn === 'function') this.#layers.set(layer, fn);
    else throw new TypeError('decorate(layer, fn): fn is (device) => decoration | null');
    this.refresh();
  }

  /** Ask every layer again and redraw the decorations (not the diagram) */
  refresh() {
    for (const entry of this.#deviceEls.values()) {
      const deco = this.#decorationOf(entry.device);
      entry.deco = deco;
      entry.decoEl?.remove();
      entry.el.classList.toggle('decorated', Boolean(deco.ring || deco.badges.length));
      if (!deco.ring && !deco.badges.length) { entry.decoEl = null; continue; }
      const d = entry.device;
      const pad = 5;
      const g = svg('g', { class: 'device-deco', 'aria-hidden': 'true' });
      if (deco.ring) g.append(svg('rect', { class: `deco-ring ring-${deco.ring}`, x: d.x - pad, y: d.y - pad, width: d.w + 2 * pad, height: d.h + 2 * pad, rx: Math.min(d.w, d.h) * 0.3 }));
      const r = 8;
      deco.badges.slice(0, 4).forEach((b, i) => {
        const cx = d.x + r + i * (r * 1.6) - pad;
        const cy = d.y - pad - 2;
        const badge = svg('g', { class: `deco-badge${b.kind ? ` badge-${b.kind}` : ''}` },
          svg('circle', { cx, cy, r, style: b.color ? `--badge:${b.color}` : null }),
          svg('text', { x: cx, y: cy + 3.2, 'text-anchor': 'middle' }, String(b.text ?? '').slice(0, 3)));
        if (b.title) badge.prepend(svg('title', {}, b.title));
        g.append(badge);
      });
      if (deco.badges.length > 4) {
        const cx = d.x + r + 4 * (r * 1.6) - pad;
        g.append(svg('g', { class: 'deco-badge badge-more' }, svg('circle', { cx, cy: d.y - pad - 2, r }), svg('text', { x: cx, y: d.y - pad + 1.2, 'text-anchor': 'middle' }, `+${deco.badges.length - 4}`)));
      }
      entry.el.append(g);
      entry.decoEl = g;
    }
  }

  #decorationOf(device) {
    const out = { ring: null, badges: [], tooltip: [] };
    for (const [name, fn] of [...this.#layers, ...diagramLayers()]) {
      let d = null;
      try { d = fn(device); } catch (err) { console.warn(`[diagram] layer ${name}: ${err.message}`); }
      if (!d) continue;
      if (d.ring) out.ring = d.ring;
      if (Array.isArray(d.badges)) out.badges.push(...d.badges);
      if (Array.isArray(d.tooltip)) out.tooltip.push(...d.tooltip.filter(Boolean));
    }
    return out;
  }

  /** Recolour status LEDs without re-rendering */
  setStates(stateOf) {
    for (const [key, { el, device }] of this.#deviceEls) {
      const state = stateOf(device);
      el.dataset.state = state;
    }
    this.#relabel();
  }

  /** Accessible names made of a device name and a state: written again when either changes */
  #relabel() {
    if (this.#lab) this.svg.setAttribute('aria-label', t('consoles.diagram.topology', { name: this.#lab.name }));
    for (const { el, device } of this.#deviceEls.values()) {
      el.setAttribute('aria-label', t('consoles.diagram.device', { name: device.name, state: stateText(el.dataset.state) }));
    }
  }

  /** Brief highlight, e.g. when the device's terminal is focused */
  pulse(key) {
    const g = this.#deviceEls.get(key)?.el;
    if (!g) return;
    g.classList.remove('pulse');
    void g.getBoundingClientRect();
    g.classList.add('pulse');
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  #device(d) {
    const kind = GLYPHS[d.kind] ? d.kind : 'generic';
    const s = Math.min(d.w, d.h);
    const g = svg('g', { class: `device kind-${kind}`, tabindex: 0, role: 'button', 'data-state': 'idle' },
      svg('rect', { class: 'device-tile', x: d.x, y: d.y, width: d.w, height: d.h, rx: s * 0.22 }),
      svg('path', { class: 'device-glyph', d: GLYPHS[kind], transform: `translate(${d.x + (d.w - s * 0.7) / 2} ${d.y + (d.h - s * 0.7) / 2}) scale(${(s * 0.7) / 24})` }),
      svg('circle', { class: 'device-led', cx: d.x + d.w - 1, cy: d.y + 1, r: 4.5 }),
      this.#label(d, true),
    );
    const open = () => this.onOpen(d);
    g.addEventListener('click', (e) => { if (!this.dragged) open(); e.stopPropagation(); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    g.addEventListener('pointerenter', () => this.#showTip(d, g));
    g.addEventListener('pointerleave', () => this.#hideTip());
    g.addEventListener('focus', () => this.#showTip(d, g));
    g.addEventListener('blur', () => this.#hideTip());
    this.#deviceEls.set(d.key, { el: g, device: d });
    return g;
  }

  #shape(s) {
    if (s.kind === 'device-unmapped') {
      const k = GLYPHS[s.deviceKind] ? s.deviceKind : 'generic';
      const m = Math.min(s.w, s.h);
      return svg('g', { class: 'device unmapped' },
        svg('rect', { class: 'device-tile', x: s.x, y: s.y, width: s.w, height: s.h, rx: m * 0.22 }),
        svg('path', { class: 'device-glyph', d: GLYPHS[k], transform: `translate(${s.x + (s.w - m * 0.7) / 2} ${s.y + (s.h - m * 0.7) / 2}) scale(${(m * 0.7) / 24})` }),
        this.#label(s, false));
    }
    const g = svg('g', { class: `shape shape-${s.kind}` });
    if (s.kind !== 'text') {
      const common = { class: 'shape-body', 'stroke-dasharray': s.style.dashed === '1' ? '6 4' : null };
      if (s.style.fillColor && s.style.fillColor !== 'none') common.style = `--shape-fill:${s.style.fillColor}`;
      g.append(s.kind === 'ellipse'
        ? svg('ellipse', { ...common, cx: s.x + s.w / 2, cy: s.y + s.h / 2, rx: s.w / 2, ry: s.h / 2 })
        : svg('rect', { ...common, x: s.x, y: s.y, width: s.w, height: s.h, rx: s.style.rounded === '1' ? 8 : 2 }));
    }
    g.append(this.#label(s, false));
    return g;
  }

  #edge(e) {
    const pts = e.points.map((p) => `${p.x},${p.y}`).join(' ');
    return svg('g', { class: `edge${e.dashed ? ' dashed' : ''}` },
      svg('polyline', { points: pts }),
      e.labels.map((l) => svg('text', { class: 'edge-label', x: l.x, y: l.y }, l.text)));
  }

  /** Places a label around (or inside) a node like draw.io's label position styles */
  #label(n, isDevice) {
    const { lines, position, verticalPosition } = n.label;
    const gap = 7;
    let x, anchor;
    if (position === 'left') { x = n.x - gap; anchor = 'end'; }
    else if (position === 'right') { x = n.x + n.w + gap; anchor = 'start'; }
    else { x = n.x + n.w / 2; anchor = 'middle'; }

    const lh = 15;
    const total = lines.length * lh;
    let y0;
    if (verticalPosition === 'bottom') y0 = n.y + n.h + gap + 10;
    else if (verticalPosition === 'top') y0 = n.y - gap - total + 11;
    else y0 = n.y + n.h / 2 - total / 2 + 11;

    return svg('text', { class: isDevice ? 'device-label' : 'shape-label', 'text-anchor': anchor },
      lines.map((line, i) => svg('tspan', { x, y: y0 + i * lh, class: isDevice ? (i === 0 ? 'name' : 'addr') : null }, line)));
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────

  #showTip(d, g) {
    const state = g.dataset.state;
    const extra = this.#deviceEls.get(d.key)?.deco?.tooltip ?? [];
    this.tooltip.replaceChildren(
      h('strong', d.name),
      h('code', `${d.target.host}:${d.target.port}`),
      h(`span.tip-state.${state}`, stateText(state)),
      ...extra.map((line) => h('span.tip-line', line)));
    const box = g.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    this.tooltip.style.left = `${box.left - host.left + box.width / 2}px`;
    this.tooltip.style.top = `${box.top - host.top - 10}px`;
    this.tooltip.classList.add('show');
  }
  #hideTip() { this.tooltip.classList.remove('show'); }

  // ── Pan & zoom ───────────────────────────────────────────────────────────

  fit(force = false) {
    if (!this.#lab) return;
    if (force) this.#autoFit = true;
    const { width, height } = this.el.getBoundingClientRect();
    if (!width || !height) return;
    const b = this.#lab.bounds;
    const k = Math.min(width / b.w, height / b.h, 1.6);
    this.#set(k, (width - b.w * k) / 2 - b.x * k, (height - b.h * k) / 2 - b.y * k);
  }

  zoomBy(factor, cx, cy) {
    const r = this.el.getBoundingClientRect();
    cx ??= r.width / 2; cy ??= r.height / 2;
    const k = Math.max(0.2, Math.min(4, this.#k * factor));
    const f = k / this.#k;
    this.#autoFit = false;
    this.#set(k, cx - (cx - this.#tx) * f, cy - (cy - this.#ty) * f);
  }

  #set(k, tx, ty) {
    this.#k = k; this.#tx = tx; this.#ty = ty;
    this.viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
    this.zoomLabel.textContent = `${Math.round(k * 100)}%`;
    this.#hideTip();
  }

  #bindPanZoom() {
    let start = null;
    this.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, tx: this.#tx, ty: this.#ty, id: e.pointerId };
      this.dragged = false;
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!this.dragged && Math.hypot(dx, dy) < 5) return; // a click, not a drag
      if (!this.dragged) { this.dragged = true; this.svg.setPointerCapture(e.pointerId); this.svg.classList.add('panning'); }
      this.#autoFit = false;
      this.#set(this.#k, start.tx + dx, start.ty + dy);
    });
    const end = () => {
      start = null;
      this.svg.classList.remove('panning');
      setTimeout(() => { this.dragged = false; }, 0); // let the click handler see the drag flag first
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }
}
