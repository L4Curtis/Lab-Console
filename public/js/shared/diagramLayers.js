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
 */
const layers = new Map(); // name → (device) => decoration | null
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
