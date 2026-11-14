/**
 * The guided tour: a few steps that point at the real screen (pick a bench,
 * take it with the team, open a console, ask for the keyboard, back up)
 *
 *   maybeStartTour()   at start-up: opens the tour for someone who has never seen it
 *   startTour()        replay, from the user menu or the help page
 *
 * It is a card next to what it talks about, not a modal: the page behind
 * stays usable and no key is taken from a terminal. Escape, or "Skip the
 * tour", ends it. How it ended ('done' or 'skipped') is kept on the server,
 * per person (GET / PUT /api/help/tour), so it opens by itself on any page
 * load until a record exists (the first sign-in in practice; a tab closed
 * mid-tour brings it back); a replay changes nothing but that record
 */
import { h, loadCss } from '../../core/dom.js';
import { request, getJson } from '../../core/api.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';

/** `target` is a selector (the step is shown without a pointer when it never appears); `route` the address it needs */
const STEPS = [
  { id: 'bench', route: '#/consoles', target: '.lab-picker' },
  { id: 'team', route: '#/consoles', target: '.bench-bar' },
  { id: 'console', route: '#/consoles', target: '.diagram-canvas' },
  { id: 'keyboard', route: '#/consoles', target: '.pane-presence' },
  { id: 'backup', route: null, target: '.rail-btn[data-path="jobs"]' },
];
const TARGET_WAIT_MS = 2500;

let running = null; // the tour on screen, if any

const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && !el.hidden && !el.closest('[hidden]');

/** Wait until `selector` matches something on screen, at most TARGET_WAIT_MS */
function whenVisible(selector, signal) {
  return new Promise((resolve) => {
    const find = () => [...document.querySelectorAll(selector)].find(visible) ?? null;
    const now = find();
    if (now) { resolve(now); return; }
    const observer = new MutationObserver(() => { const el = find(); if (el) finish(el); });
    const timer = setTimeout(() => finish(null), TARGET_WAIT_MS);
    const finish = (el) => { observer.disconnect(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(el); };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  });
}

/** Remember how the tour ended. A failure is not worth interrupting anyone for */
async function remember(state) {
  try { await request('PUT', '/api/help/tour', { state }); } catch (err) { console.warn(`[tour] could not be recorded: ${err.message}`); }
}

/** Open the tour (a replay when the person has already seen it) */
export async function startTour() {
  if (running) return running.done;
  await Promise.all([loadNamespace('help'), loadCss('help')]);
  const abort = new AbortController();
  const opener = document.activeElement;
  let index = 0;
  let target = null;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });

  const count = h('p.tour-count');
  const title = h('h2#tour-title');
  const body = h('p#tour-body');
  const back = h('button.btn.small', { type: 'button', dataset: { action: 'tour-back' }, onclick: () => go(index - 1) });
  const next = h('button.btn.small.primary', { type: 'button', dataset: { action: 'tour-next' }, onclick: () => (index === STEPS.length - 1 ? end('done') : go(index + 1)) });
  const skip = h('button.btn.small.subtle.tour-skip', { type: 'button', dataset: { action: 'tour-skip' }, onclick: () => end('skipped') });
  const card = h('div.tour-card', { role: 'dialog', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-body', dataset: { tour: 'card' } },
    count, title, body, h('div.tour-actions', skip, back, next));
  document.body.append(card);

  function place() {
    const rect = target?.getBoundingClientRect();
    const w = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    const margin = 12;
    let left;
    let top;
    if (rect) {
      const options = [
        [rect.left, rect.bottom + margin],             // below
        [rect.right + margin, rect.top],               // right
        [rect.left, rect.top - ch - margin],           // above
        [rect.left - w - margin, rect.top],            // left
      ];
      const fits = ([x, y]) => x >= margin && y >= margin && x + w <= vw - margin && y + ch <= vh - margin;
      [left, top] = options.find(fits) ?? [(vw - w) / 2, vh - ch - margin * 2];
    } else {
      [left, top] = [(vw - w) / 2, Math.max(margin, (vh - ch) / 3)];
    }
    card.style.left = `${Math.max(margin, Math.min(left, vw - w - margin))}px`;
    card.style.top = `${Math.max(margin, Math.min(top, vh - ch - margin))}px`;
  }

  function write() {
    const step = STEPS[index];
    count.textContent = t('help.tour.step', { n: index + 1, total: STEPS.length });
    title.textContent = t(`help.tour.steps.${step.id}.title`);
    body.textContent = t(`help.tour.steps.${step.id}.body`);
    back.textContent = t('help.tour.back');
    back.hidden = index === 0;
    next.textContent = t(index === STEPS.length - 1 ? 'help.tour.finish' : 'help.tour.next');
    skip.textContent = t('help.tour.skip');
    card.setAttribute('aria-label', t('help.tour.label'));
    place();
  }

  let ticket = 0;
  async function go(to) {
    index = Math.max(0, Math.min(STEPS.length - 1, to));
    const mine = ++ticket;
    target?.classList.remove('tour-target');
    target = null;
    const step = STEPS[index];
    if (step.route && (location.hash || '#/consoles').split('/')[1] !== step.route.split('/')[1]) location.hash = step.route;
    write();
    card.dataset.step = step.id;
    const found = await whenVisible(step.target, abort.signal);
    if (mine !== ticket || abort.signal.aborted) return;
    target = found;
    target?.classList.add('tour-target');
    write();
    next.focus({ preventScroll: true });
  }

  function end(state) {
    if (abort.signal.aborted) return;
    abort.abort();
    ticket++;
    target?.classList.remove('tour-target');
    card.remove();
    removeEventListener('resize', place);
    offLocale();
    running = null;
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    remember(state).then(settle);
  }

  addEventListener('resize', place);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) end('skipped'); }, { signal: abort.signal });
  const offLocale = onLocaleChange(write);
  running = { done };
  await go(0);
  return done;
}

/** At start-up: opens the tour while no record exists (it is written when the tour ends) */
export async function maybeStartTour() {
  let state;
  try { ({ state } = await getJson('/api/help/tour')); } catch { return; } // no tour rather than a broken start
  if (state === null) await startTour();
}
