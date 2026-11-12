/**
 * Tabs inside a section: one file per screen, loaded the first time it is
 * shown and kept mounted afterwards (like the sections themselves, so a tab
 * never loses its state when the user looks elsewhere)
 *
 *   const tabs = mountTabs(el, [
 *     { id: 'sessions', title: () => t('admin.tabs.sessions'), load: () => import('./tabs/sessions.js') },
 *     { id: 'audit', title: () => t('admin.tabs.audit'), load: () => import('./tabs/audit.js'), when: () => session.isAdmin },
 *   ], { navigate, base: '#/admin' });
 *   return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
 *
 * A tab file exports mount(el, ctx) → { show?(params), hide?() }, the same
 * contract as a section. Adding a screen is one file and one line.
 * `title` is a string, or a function when it must follow the language.
 * `when` hides a tab (it is a convenience: the server still checks the role)
 *
 * Options: navigate + base keep the address in step (#/admin/audit); label
 * names the tab list for screen readers; bar is an existing element to put
 * the tab buttons in (default: at the top of the container); ctx is passed
 * on to every tab
 */
import { h, loadCss } from '../core/dom.js';
import { t, onLocaleChange } from '../core/i18n.js';

let serial = 0;

export function mountTabs(container, tabs, { navigate, base = '', label, bar, ctx = {} } = {}) {
  loadCss('shared');
  const uid = `tabs-${++serial}`;
  const shown = tabs.filter((tab) => tab.when?.() !== false);
  const state = new Map(); // id → { button, panel, api, loading, failed }
  let current = null;
  let visible = false;

  const titleOf = (tab) => (typeof tab.title === 'function' ? tab.title() : tab.title);
  const list = h('div.seg', { role: 'tablist', 'aria-label': label });
  const panels = h('div.tab-panels');

  for (const tab of shown) {
    const button = h('button.seg-btn', {
      type: 'button', role: 'tab', id: `${uid}-tab-${tab.id}`, 'aria-controls': `${uid}-panel-${tab.id}`,
      'aria-selected': 'false', tabindex: '-1', dataset: { tab: tab.id },
      onclick: () => select(tab.id),
    }, titleOf(tab));
    const panel = h('section.tab-panel', { role: 'tabpanel', id: `${uid}-panel-${tab.id}`, 'aria-labelledby': button.id, tabindex: '0', hidden: true });
    list.append(button);
    panels.append(panel);
    state.set(tab.id, { tab, button, panel, api: null, loading: null, failed: false });
  }

  // Arrow keys move between tabs, as the ARIA tabs pattern expects
  list.addEventListener('keydown', (e) => {
    const ids = shown.map((tab) => tab.id);
    const at = ids.indexOf(e.target?.dataset?.tab);
    if (at === -1) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = ids[(to + ids.length) % ids.length];
    select(next);
    state.get(next).button.focus();
  });

  (bar ?? container).append(list);
  container.append(panels);
  const stop = onLocaleChange(() => { for (const s of state.values()) s.button.textContent = titleOf(s.tab); });

  async function ensureMounted(entry) {
    if (entry.api) return entry.api;
    if (!entry.loading) {
      entry.failed = false;
      entry.panel.replaceChildren();
      entry.panel.setAttribute('aria-busy', 'true');
      entry.loading = entry.tab.load()
        .then(async ({ mount }) => { entry.api = (await mount(entry.panel, { ...ctx, navigate, tab: entry.tab.id })) || {}; })
        .catch((err) => {
          console.error(`[tabs] ${entry.tab.id} could not be loaded`, err);
          entry.failed = true;
          entry.panel.replaceChildren(h('p.tab-error', { role: 'alert' }, t('common.tabs.loadFailed')));
        })
        .finally(() => { entry.loading = null; entry.panel.removeAttribute('aria-busy'); });
    }
    await entry.loading;
    return entry.api;
  }

  /** Show one tab; `params` are the address segments after its id */
  async function select(id, params = [], { silent = false } = {}) {
    const entry = state.get(id) ?? state.get(shown[0]?.id);
    if (!entry) return;
    const previous = current && current !== entry.tab.id ? state.get(current) : null;
    current = entry.tab.id;
    for (const s of state.values()) {
      const on = s === entry;
      s.button.setAttribute('aria-selected', String(on));
      s.button.tabIndex = on ? 0 : -1;
      s.panel.hidden = !on;
    }
    if (previous) previous.api?.hide?.();
    if (!silent && navigate && base) navigate(`${base}/${entry.tab.id}`);
    const api = await ensureMounted(entry);
    // The user may have moved on while the file was loading
    if (api && visible && current === entry.tab.id) api.show?.(params);
  }

  return {
    get current() { return current; },
    select,
    /** The section became visible; params = [tabId, ...rest] from the address */
    show([id, ...rest] = []) {
      visible = true;
      // The address already says where we are: do not rewrite it
      return select(state.has(id) ? id : current ?? shown[0]?.id, state.has(id) ? rest : [], { silent: true });
    },
    /** The section was hidden: tell the tab on screen */
    hide() {
      visible = false;
      state.get(current)?.api?.hide?.();
    },
    destroy() {
      stop();
      list.remove();
      panels.remove();
    },
  };
}
