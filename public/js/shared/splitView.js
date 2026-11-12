/**
 * Layout used by every section: its own content on one side, the shared
 * terminal workspace on the other, with a draggable splitter; Only the
 * visible section's SplitView holds the workspace (activate() moves it in)
 */
import { h, prefs } from '../core/dom.js';
import { tAttr } from '../core/i18n.js';
import { workspace } from './workspace.js';

let activeSplit = null;
workspace.addEventListener('change', () => activeSplit?.sync());
workspace.addEventListener('toggle-primary', () => activeSplit?.togglePrimary());

export class SplitView {
  /** `labelKey` names the side panel for assistive technology and follows the language; `label` is a fixed text */
  constructor(container, primary, { onResize, label, labelKey = 'terminal.split.sidePanel' } = {}) {
    this.onResize = onResize;
    this.primary = h('section.split-primary', label ? { 'aria-label': label } : tAttr('aria-label', labelKey), primary);
    this.splitter = h('div.splitter', { role: 'separator', 'aria-orientation': 'vertical', ...tAttr('aria-label', 'terminal.split.resize'), tabindex: 0 });
    this.el = h('div.split-body', { dataset: { primary: 'shown', terminals: 'false' } }, this.primary, this.splitter);
    container.append(this.el);
    this.#bindSplitter();
  }

  /** Call from the section's show(): pulls the shared workspace into this layout */
  activate() {
    activeSplit = this;
    if (workspace.el.parentNode !== this.el) this.el.append(workspace.el);
    this.sync();
    requestAnimationFrame(() => { this.onResize?.(); workspace.refit(); });
  }

  sync() {
    this.el.dataset.terminals = String(workspace.panes.size > 0);
  }

  togglePrimary() {
    this.el.dataset.primary = this.el.dataset.primary === 'shown' ? 'hidden' : 'shown';
    requestAnimationFrame(() => { this.onResize?.(); workspace.refit(); });
  }

  #bindSplitter() {
    const body = this.el;
    const apply = (pct) => {
      const v = Math.max(20, Math.min(75, pct));
      document.documentElement.style.setProperty('--primary-size', `${v}%`);
      prefs.set('split', v);
    };
    apply(prefs.get('split', 40));
    this.splitter.addEventListener('pointerdown', (e) => {
      this.splitter.setPointerCapture(e.pointerId);
      body.classList.add('resizing');
      const rect = body.getBoundingClientRect();
      const vertical = getComputedStyle(body).flexDirection === 'column';
      const move = (ev) => apply(vertical ? ((ev.clientY - rect.top) / rect.height) * 100 : ((ev.clientX - rect.left) / rect.width) * 100);
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        body.classList.remove('resizing');
        this.onResize?.();
        workspace.refit();
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up, { once: true });
    });
    this.splitter.addEventListener('keydown', (e) => {
      const cur = prefs.get('split', 40);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') apply(cur - 5);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') apply(cur + 5);
    });
  }
}
