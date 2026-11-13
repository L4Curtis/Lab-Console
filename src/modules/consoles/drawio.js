/**
 * draw.io (.drawio / mxGraph XML) → normalized lab model
 *
 * Pure module: no I/O, no config import, so it is shared by the server and the
 * `npm run check-diagram` CLI
 *
 * Output per page ("lab"):
 *   { id, name, bounds, devices[], shapes[], edges[] }
 * where every coordinate is absolute and every edge is already routed, so the
 * browser only has to draw - all diagram logic lives in one testable place
 *
 * How a node becomes a clickable console device (first match wins):
 *   1. Explicit data (draw.io › Edit Data on the shape): `console_host` + `console_port`
 *      (aliases: `host`/`ip` + `port`)
 *   2. Label convention used by the lab diagrams: "R1<br>.211 - 2001"
 *      → host `${networkPrefix}.211`, port 2001; A full IP ("10.22.9.211 - 2001") also works
 */
import zlib from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';

const LABEL_TARGET_SHORT = /(?:^|\s)\.(\d{1,3})\s*[-–—:]\s*(\d{2,5})\b/;
const LABEL_TARGET_FULL = /\b(\d{1,3}(?:\.\d{1,3}){3})\s*[-–—:]\s*(\d{2,5})\b/;

/** Everything the pages of one file may inflate to, in all (a 5 MB upload is no bomb, a 5 MB page that fills the memory is) */
export const MAX_INFLATED_BYTES = 20 * 1024 * 1024;
const FORBIDDEN = /<!\s*(DOCTYPE|ENTITY)/i;

/**
 * A file the parser will not read at all, whatever the rest says: `code` is
 * 'doctype' (it declares a DOCTYPE or entities, in the file or in a
 * compressed page) or 'too_large' (its pages inflate to more than the budget)
 */
export class DrawioRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrawioRefusal';
    this.code = code;
  }
}

/**
 * XML text → document. A DOCTYPE or an entity declaration is refused on the
 * text and again on the document the parser built: a page hidden in CDATA, in
 * comments or behind character references only shows up once it is decoded
 */
function parseXml(text) {
  if (FORBIDDEN.test(text)) throw new DrawioRefusal('doctype', 'A diagram may not declare a DOCTYPE or entities');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml');
  if (doc.doctype || Array.from(doc.childNodes ?? []).some((node) => node.nodeType === 10)) {
    throw new DrawioRefusal('doctype', 'A diagram may not declare a DOCTYPE or entities');
  }
  return doc;
}

/** Parse a whole .drawio file */
export function parseDrawio(xmlText, { networkPrefix = '10.22.9', maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const doc = parseXml(xmlText);
  const root = doc.documentElement;
  if (!root) throw new Error('Not an XML document');
  const budget = { left: maxInflatedBytes };

  // A bare <mxGraphModel> (single-page export) is accepted too
  const diagrams = root.nodeName === 'mxGraphModel' ? [root] : elements(root, 'diagram');
  if (!diagrams.length) throw new Error('No <diagram> pages found in the draw.io file');

  const labs = diagrams.map((d, index) => {
    const model = d.nodeName === 'mxGraphModel' ? d : resolveModel(d, budget);
    const id = d.getAttribute?.('id') || `page-${index + 1}`;
    const name = d.getAttribute?.('name') || `Lab ${index + 1}`;
    return buildLab({ id, name, index, model, networkPrefix });
  });

  return { labs, warnings: findWarnings(labs) };
}

// ─── Page decoding ──────────────────────────────────────────────────────────

/** A <diagram> either contains <mxGraphModel> or a compressed (deflate+base64+URI) payload */
function resolveModel(diagramEl, budget) {
  const inline = elements(diagramEl, 'mxGraphModel')[0];
  if (inline) return inline;
  // The text as the parser reads it: CDATA, comments and character references are resolved
  const payload = (diagramEl.textContent || '').trim();
  if (!payload) return null;
  let xml;
  try {
    const inflated = zlib.inflateRawSync(Buffer.from(payload, 'base64'), { maxOutputLength: Math.max(budget.left, 1) });
    budget.left -= inflated.length;
    xml = decodeURIComponent(inflated.toString('utf8'));
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new DrawioRefusal('too_large', 'The pages inflate to more than the limit');
    throw new Error(`Page "${diagramEl.getAttribute('name')}" is compressed and could not be decoded`, { cause: err });
  }
  return parseXml(xml).documentElement;
}

// ─── Cell extraction ────────────────────────────────────────────────────────

function buildLab({ id, name, index, model, networkPrefix }) {
  const cells = new Map();
  if (model) {
    const rootEl = elements(model, 'root')[0] || model;
    for (const el of childElements(rootEl)) {
      const cell = readCell(el);
      if (cell) cells.set(cell.id, cell);
    }
  }

  // Resolve absolute vertex geometry (children of groups/containers are relative)
  const absCache = new Map();
  const absBox = (cell) => {
    if (absCache.has(cell.id)) return absCache.get(cell.id);
    const g = cell.geo || { x: 0, y: 0, w: 0, h: 0 };
    let box = { x: g.x, y: g.y, w: g.w, h: g.h };
    const parent = cells.get(cell.parent);
    if (parent && parent.vertex) {
      const p = absBox(parent);
      box = { ...box, x: box.x + p.x, y: box.y + p.y };
    }
    absCache.set(cell.id, box);
    return box;
  };

  const devices = [];
  const shapes = [];
  const edges = [];

  for (const cell of cells.values()) {
    if (!cell.vertex || !cell.geo) continue;
    const parent = cells.get(cell.parent);
    if (parent?.edge) continue; // edge labels are handled with their edge
    if (cell.style.edgeLabel !== undefined) continue;

    const box = absBox(cell);
    const lines = labelLines(cell.label);
    const label = {
      lines,
      position: cell.style.labelPosition || 'center',
      verticalPosition: cell.style.verticalLabelPosition || (isDeviceShape(cell.style) ? 'bottom' : 'middle'),
      align: cell.style.align || 'center',
      fontColor: cell.style.fontColor,
    };

    const target = resolveTarget(cell, lines, networkPrefix);
    const kind = deviceKind(cell.style);
    if (target) {
      devices.push({
        id: cell.id,
        key: `${id}:${cell.id}`, // what the browser sends back — never a host/port
        name: cell.attrs.console_name || lines[0] || 'device',
        kind,
        ...round(box),
        label,
        target,
      });
    } else {
      shapes.push({
        id: cell.id,
        kind: isDeviceShape(cell.style) ? 'device-unmapped' : genericKind(cell.style),
        deviceKind: kind,
        ...round(box),
        label,
        style: pick(cell.style, ['fillColor', 'strokeColor', 'rounded', 'dashed', 'opacity', 'fontSize']),
      });
    }
  }

  for (const cell of cells.values()) {
    if (!cell.edge) continue;
    const routed = routeEdge(cell, cells, absBox);
    if (!routed) continue;
    const labels = [];
    // The edge's own value is drawn at its relative geometry (default: middle)
    if (cell.label) labels.push(placeLabel(routed, cell.geo, cell.label));
    for (const child of cells.values()) {
      if (child.parent === cell.id && child.vertex && child.label) {
        labels.push(placeLabel(routed, child.geo, child.label));
      }
    }
    edges.push({
      id: cell.id,
      points: routed.map(roundPoint),
      dashed: cell.style.dashed === '1',
      color: cell.style.strokeColor,
      labels,
    });
  }

  return { id, name, index, bounds: computeBounds(devices, shapes, edges), devices, shapes, edges };
}

function readCell(el) {
  let cellEl = el;
  let attrs = {};
  // <UserObject>/<object> wrap an <mxCell> and carry custom data + the label
  if (el.nodeName === 'UserObject' || el.nodeName === 'object') {
    cellEl = elements(el, 'mxCell')[0];
    if (!cellEl) return null;
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  } else if (el.nodeName !== 'mxCell') {
    return null;
  }
  const id = attrs.id || cellEl.getAttribute('id');
  if (!id) return null;

  const geoEl = childElements(cellEl).find((c) => c.nodeName === 'mxGeometry');
  return {
    id,
    parent: cellEl.getAttribute('parent'),
    vertex: cellEl.getAttribute('vertex') === '1',
    edge: cellEl.getAttribute('edge') === '1',
    source: cellEl.getAttribute('source'),
    target: cellEl.getAttribute('target'),
    label: attrs.label ?? cellEl.getAttribute('value') ?? '',
    attrs,
    style: parseStyle(cellEl.getAttribute('style') || ''),
    geo: geoEl ? readGeometry(geoEl) : null,
  };
}

function readGeometry(el) {
  const num = (n) => Number(el.getAttribute(n) || 0);
  const geo = {
    x: num('x'), y: num('y'), w: num('width'), h: num('height'),
    relative: el.getAttribute('relative') === '1',
    points: [], sourcePoint: null, targetPoint: null, offset: null,
  };
  for (const c of childElements(el)) {
    const as = c.getAttribute('as');
    if (c.nodeName === 'mxPoint' && as) geo[as] = readPoint(c);
    if (c.nodeName === 'Array' && as === 'points') {
      geo.points = childElements(c).filter((p) => p.nodeName === 'mxPoint').map(readPoint);
    }
  }
  return geo;
}
const readPoint = (el) => ({ x: Number(el.getAttribute('x') || 0), y: Number(el.getAttribute('y') || 0) });

// ─── Device resolution ──────────────────────────────────────────────────────

function resolveTarget(cell, lines, networkPrefix) {
  const a = cell.attrs;
  const host = a.console_host || a.host || a.ip;
  const port = a.console_port || a.port;
  if (host && port) return { host: String(host).trim(), port: Number(port), source: 'data' };

  const text = lines.join('\n');
  const full = text.match(LABEL_TARGET_FULL);
  if (full) return { host: full[1], port: Number(full[2]), source: 'label' };
  const short = text.match(LABEL_TARGET_SHORT);
  if (short) return { host: `${networkPrefix}.${short[1]}`, port: Number(short[2]), source: 'label' };
  return null;
}

function isDeviceShape(style) {
  return /^mxgraph\.(cisco|cisco19|cisco_safe|network|networks)/.test(style.shape || '');
}
function deviceKind(style) {
  const hint = `${style.prIcon || ''} ${style.shape || ''}`.toLowerCase();
  if (/firewall|asa/.test(hint)) return 'firewall';
  if (/l3_switch|layer_3|multilayer/.test(hint)) return 'l3switch';
  if (/switch/.test(hint)) return 'switch';
  if (/router/.test(hint)) return 'router';
  if (/server/.test(hint)) return 'server';
  if (/pc|workstation|laptop|computer/.test(hint)) return 'host';
  return 'generic';
}
function genericKind(style) {
  if (style.text !== undefined) return 'text';
  if (style.ellipse !== undefined || style.shape === 'ellipse') return 'ellipse';
  return 'rect';
}

// ─── Edge routing ───────────────────────────────────────────────────────────

function routeEdge(cell, cells, absBox) {
  const g = cell.geo || { points: [] };
  const src = cells.get(cell.source);
  const dst = cells.get(cell.target);
  const sBox = src?.geo ? absBox(src) : null;
  const tBox = dst?.geo ? absBox(dst) : null;
  const waypoints = g.points || [];
  const s = cell.style;

  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const fixed = (b, px, py, dx, dy) =>
    px !== undefined && py !== undefined
      ? { x: b.x + b.w * Number(px) + Number(dx || 0), y: b.y + b.h * Number(py) + Number(dy || 0) }
      : null;

  // Constraint points first (exitX/entryX); perimeter projection is resolved after
  let start = sBox ? fixed(sBox, s.exitX, s.exitY, s.exitDx, s.exitDy) : g.sourcePoint;
  let end = tBox ? fixed(tBox, s.entryX, s.entryY, s.entryDx, s.entryDy) : g.targetPoint;
  if (!sBox && !start) return null;
  if (!tBox && !end) return null;

  if (!start) start = perimeter(sBox, waypoints[0] || end || center(tBox));
  if (!end) end = perimeter(tBox, waypoints.at(-1) || start);

  if (s.edgeStyle === 'orthogonalEdgeStyle' && waypoints.length === 0) {
    return orthogonal(start, end, s.exitX, s.entryX);
  }
  return [start, ...waypoints, end];
}

/** Intersection of the segment centre→toward with the rectangle's border */
function perimeter(b, toward) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = toward.x - cx, dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? (b.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (b.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Simple elbow routing, good enough for the lab diagrams' few orthogonal links */
function orthogonal(a, b, exitX, entryX) {
  const horizontalFirst = exitX === '0' || exitX === '1' || (exitX === undefined && Math.abs(b.x - a.x) >= Math.abs(b.y - a.y));
  const horizontalLast = entryX === '0' || entryX === '1';
  if (horizontalFirst && horizontalLast) {
    const mx = (a.x + b.x) / 2;
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  if (!horizontalFirst && !horizontalLast) {
    const my = (a.y + b.y) / 2;
    return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
  }
  return horizontalFirst ? [a, { x: b.x, y: a.y }, b] : [a, { x: a.x, y: b.y }, b];
}

/**
 * Position a label along a polyline exactly like mxGraphView.getPoint():
 * geometry.x ∈ [-1, 1] runs from source to target, geometry.y is a perpendicular
 * offset and geometry.offset an extra absolute shift
 */
function placeLabel(points, geo, rawLabel) {
  const gx = geo?.relative ? geo.x : 0;
  const gy = geo?.relative ? geo.y : 0;
  const off = geo?.offset || { x: 0, y: 0 };
  const segs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = segs.reduce((a, b) => a + b, 0);
  const dist = ((gx + 1) / 2) * total;

  let acc = 0, i = 0;
  while (i < segs.length - 1 && dist >= acc + segs[i]) acc += segs[i++];
  const seg = segs[i] || 0;
  const f = seg ? (dist - acc) / seg : 0;
  const p0 = points[i], pe = points[i + 1] || p0;
  const dx = pe.x - p0.x, dy = pe.y - p0.y;
  const nx = seg ? dy / seg : 0, ny = seg ? dx / seg : 0;
  return {
    text: labelLines(rawLabel).join(' '),
    x: round1(p0.x + dx * f + nx * gy + off.x),
    y: round1(p0.y + dy * f - ny * gy + off.y),
  };
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/** Two different devices pointing at the same console line is almost always a typo */
function findWarnings(labs) {
  const warnings = [];
  const byTarget = new Map();
  for (const lab of labs) {
    for (const d of lab.devices) {
      const k = `${d.target.host}:${d.target.port}`;
      if (!byTarget.has(k)) byTarget.set(k, []);
      byTarget.get(k).push({ lab: lab.name, name: d.name });
    }
  }
  for (const [k, uses] of byTarget) {
    const names = new Set(uses.map((u) => u.name));
    if (names.size > 1) {
      const devices = uses.map((u) => `${u.lab}/${u.name}`).join(', ');
      warnings.push({ code: 'consoles.warn_different_devices', params: { target: k, devices }, message: `Console ${k} is used by different devices: ${devices}` });
    } else if (uses.length > 1) {
      const labs = uses.map((u) => u.lab).join(', ');
      warnings.push({ code: 'consoles.warn_several_pages', params: { target: k, name: uses[0].name, labs }, message: `Console ${k} (${uses[0].name}) appears on several pages: ${labs} — treated as shared equipment` });
    }
  }
  return warnings;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function parseStyle(style) {
  const out = {};
  for (const part of style.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) out[part] = ''; // bare tokens: "text", "ellipse", "edgeLabel"…
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** HTML label → plain text lines. */
export function labelLines(raw = '') {
  return String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|p|li|tr|h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function computeBounds(devices, shapes, edges) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of [...devices, ...shapes]) {
    add(n.x, n.y); add(n.x + n.w, n.y + n.h);
    // Reserve room for outside labels (approximate text metrics)
    const longest = Math.max(0, ...n.label.lines.map((l) => l.length)) * 7.5;
    const tall = n.label.lines.length * 16;
    if (n.label.position === 'left') add(n.x - longest - 12, n.y);
    if (n.label.position === 'right') add(n.x + n.w + longest + 12, n.y);
    if (n.label.verticalPosition === 'bottom') add(n.x + n.w / 2, n.y + n.h + tall + 8);
    if (n.label.verticalPosition === 'top') add(n.x + n.w / 2, n.y - tall - 8);
  }
  for (const e of edges) for (const p of e.points) add(p.x, p.y);
  if (minX === Infinity) return { x: 0, y: 0, w: 800, h: 600 };
  const pad = 40;
  return { x: Math.floor(minX - pad), y: Math.floor(minY - pad), w: Math.ceil(maxX - minX + pad * 2), h: Math.ceil(maxY - minY + pad * 2) };
}

const round1 = (n) => Math.round(n * 10) / 10;
const roundPoint = (p) => ({ x: round1(p.x), y: round1(p.y) });
const round = (b) => ({ x: round1(b.x), y: round1(b.y), w: round1(b.w), h: round1(b.h) });
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const childElements = (el) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1);
const elements = (el, name) => Array.from(el.getElementsByTagName(name));
