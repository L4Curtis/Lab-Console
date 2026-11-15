/**
 * The console screen of a phone (UX.md §8.3, `#/consoles/<bench>/<device>`):
 * one console on the whole screen, the tab bar hidden, a back arrow to the
 * bench. With two consoles or more, a row of chips switches between them (a
 * horizontal swipe on that row too) and the address follows. The consoles
 * stay connected when the person goes back to the bench
 *
 *   const screen = consoleScreen({ section, onLeave: () => … , onSwitch: (pane) => … });
 *   screen.enter(pane);  screen.leave();  screen.active
 *
 * The first time a console opens upright on a phone, a line suggests turning
 * it for more columns: once per browser (on screen until closed, and never
 * while the keyboard is open)
 */
import { h, icon, prefs } from '../../core/dom.js';
import { t, tAttr, onLocaleChange } from '../../core/i18n.js';
import { workspace } from '../../shared/workspace.js';

const SWIPE_PX = 60;

export function consoleScreen({ section, onLeave, onSwitch }) {
  let active = false;
  let hintOn = false; // the line is on screen (it was shown for the first time, or is still there)
  const hintText = h('p');
  const hint = h('div.rotate-hint', { role: 'note', hidden: true },
    icon('phone-rotate'), hintText,
    h('button.icon-btn', { type: 'button', ...tAttr('title', 'consoles.rotate.dismiss'), ...tAttr('aria-label', 'consoles.rotate.dismiss'), onclick: () => { hintOn = false; hint.hidden = true; workspace.refit(); } }, icon('close')));
  const writeHint = () => { hintText.textContent = t('consoles.rotate.hint'); };
  writeHint();
  onLocaleChange(writeHint);

  // The workspace's own back arrow and chips: they belong to whoever shows the console screen
  workspace.addEventListener('back', () => { if (active) onLeave(); });
  workspace.addEventListener('solo', (e) => { if (active) onSwitch(e.detail); });

  workspace.addEventListener('solo', (e) => { if (active) (e.detail.presenceBar?.el ?? e.detail.head).after(hint); });

  // A horizontal swipe on the chip row moves to the next or the previous console
  let swipe = null;
  workspace.switcher.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; });
  workspace.switcher.addEventListener('pointerup', (e) => {
    if (!swipe || !active) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx)) return;
    const next = workspace.neighbour(dx < 0 ? 1 : -1);
    if (!next) return;
    workspace.solo(next.session.key);
    onSwitch(next);
  });

  return {
    get active() { return active; },
    enter(pane) {
      active = true;
      section.dataset.screen = 'console';
      document.documentElement.dataset.chrome = 'immersive';
      workspace.solo(pane.session.key);
      (pane.presenceBar?.el ?? pane.head).after(hint); // under the console's head (and its presence row)
      if (!hintOn && !prefs.get('rotateHintSeen', false) && innerWidth <= innerHeight) { hintOn = true; prefs.set('rotateHintSeen', true); }
      hint.hidden = !hintOn || innerWidth > innerHeight;
      requestAnimationFrame(() => { workspace.refit(); pane.term?.scrollToBottom?.(); });
    },
    leave() {
      if (!active) return;
      active = false;
      delete section.dataset.screen;
      delete document.documentElement.dataset.chrome;
      hint.hidden = true;
      workspace.solo(null);
    },
  };
}
