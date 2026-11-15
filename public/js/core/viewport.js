/**
 * The viewport as JavaScript needs it: which presentation to choose (a
 * popover or a bottom sheet), and the visual viewport's height for a phone
 * whose keyboard is open. Layout itself stays in CSS media queries; the
 * numbers here are those of css/tokens.css
 *
 *   isCompact()           width < 720 px, or a touch screen shorter than 500 px (a phone turned on its side): tab bar, sheets
 *   isCoarse()            a finger rather than a mouse
 *   onViewportChange(fn)  fn({ compact, coarse, keyboard, height }) on every change → unsubscribe
 *   startViewport()       sets --vvh (px) and data-keyboard="open" on <html>; main.js calls it once
 */
const COMPACT = '(max-width: 719.98px), (max-height: 499.98px) and (pointer: coarse)'; // the same query as css/*.css
const COARSE = '(pointer: coarse)';
const KEYBOARD_PX = 120; // the visual viewport shrank this much: the virtual keyboard is open

const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : { matches: false, addEventListener() {} });
const compactMq = mq(COMPACT);
const coarseMq = mq(COARSE);
const listeners = new Set();

export const isCompact = () => compactMq.matches;
export const isCoarse = () => coarseMq.matches;

function state() {
  const vv = globalThis.visualViewport;
  const height = Math.round(vv?.height ?? globalThis.innerHeight ?? 0);
  return { compact: isCompact(), coarse: isCoarse(), keyboard: Boolean(vv) && globalThis.innerHeight - vv.height > KEYBOARD_PX, height };
}

export function onViewportChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let started = false;
let frame = 0;
function update() {
  frame = 0;
  const now = state();
  const root = document.documentElement;
  root.style.setProperty('--vvh', `${now.height}px`);
  if (now.keyboard) root.dataset.keyboard = 'open';
  else delete root.dataset.keyboard;
  for (const fn of listeners) {
    try { fn(now); } catch (err) { console.error(err); }
  }
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

export function startViewport() {
  if (started) return;
  started = true;
  update();
  globalThis.visualViewport?.addEventListener('resize', schedule);
  globalThis.visualViewport?.addEventListener('scroll', schedule);
  addEventListener('resize', schedule);
  compactMq.addEventListener('change', schedule);
  coarseMq.addEventListener('change', schedule);
}
