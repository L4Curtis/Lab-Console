/**
 * Decoration layers of the lab diagram, registered by whoever provides them
 * (ARCHITECTURE §8). The consoles section draws presence itself; a later lot
 * (job progress, notes) adds its own layer with one call and no change to
 * the consoles section, the same way pane actions are added to console tiles:
 *
 *   const off = registerDiagramLayer('jobs', (device) => ({
 *     ring: 'job',                                     // .deco-ring.ring-job
 *     badges: [{ text: '42%', title: 'Backup running', kind: 'job' }],
 *     tooltip: ['Backup: 42 %'],
 *   }) | null);
 *   refreshDiagram();      // the data behind a layer changed: ask every layer again
 *   off();                 // remove the layer
 *
 * Every diagram view on the page, already drawn or drawn later, uses the
 * registered layers after its own ones, in the order they were registered.
 *
 * Links (the diagram's edges) have layers of their own, asked with the edge
 * as the server parsed it ({ id, source, target, points, labels }: `source`
 * and `target` are cell ids, a device's `id`) and the lab page it is on:
 *
 *   const off = registerLinkLayer('checks', (edge, lab) => ({
 *     tone: 'missing',                                 // .edge[data-tone="missing"] (the last layer's wins)
 *     title: 'Cable missing: R1 Fa0/0 – S1 Fa0/24',    // the link's tooltip lines (several layers add up)
 *     ends: { source: '10.0.12.1', target: 'down' },   // short texts written near each end
 *   }) | null);
 */
const layers = new Map(); // name → (device) => decoration | null
const linkLayers = new Map(); // name → (edge, lab) => decoration | null
const listeners = new Set();

const changed = () => { for (const fn of listeners) fn(); };

export function registerDiagramLayer(name, fn) {
  if (!name || typeof fn !== 'function') throw new TypeError('registerDiagramLayer(name, fn): fn is (device) => decoration | null');
  layers.delete(name); // re-registering moves the layer to the end
  layers.set(name, fn);
  changed();
  return () => {
    if (layers.get(name) !== fn) return;
    layers.delete(name);
    changed();
  };
}

/** The same for the diagram's links: fn(edge, lab) → { tone?, title?, ends?: { source?, target? } } | null */
export function registerLinkLayer(name, fn) {
  if (!name || typeof fn !== 'function') throw new TypeError('registerLinkLayer(name, fn): fn is (edge, lab) => decoration | null');
  linkLayers.delete(name);
  linkLayers.set(name, fn);
  changed();
  return () => {
    if (linkLayers.get(name) !== fn) return;
    linkLayers.delete(name);
    changed();
  };
}

/** The registered link layers, in order: [[name, fn]] */
export function linkLayersList() {
  return [...linkLayers];
}

/** Ask every layer again, in every diagram view */
export function refreshDiagram() {
  changed();
}

/** The registered layers, in order: [[name, fn]] */
export function diagramLayers() {
  return [...layers];
}

/** Called when a layer is added, removed or refreshed; returns the function that stops listening */
export function onDiagramLayersChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
