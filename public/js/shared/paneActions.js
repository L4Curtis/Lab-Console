/**
 * Actions of the console tiles, registered by whoever provides them
 * (ARCHITECTURE §8). A tile lists every registered action whose
 * `when(session)` holds, in `order`, in its ⋯ menu (UX.md §8.2), and asks
 * `enabled(pane)` again each time the menu opens, so a later lot adds "Back
 * up this device" or "Send to several consoles" with one call and no change
 * to the tile:
 *
 *   registerPaneAction({
 *     id: 'backup', icon: 'download',
 *     label: 'jobs.actions.backupOne',                                  // the menu's words: a dictionary key, or () => text
 *     title: 'jobs.actions.backupOneHint',                              // optional: a longer explanation (tooltip, the menu's hint)
 *     when: (session) => session.kind === 'console',
 *     enabled: (pane) => pane.canPilot,                                  // optional
 *     run: (pane) => …,
 *     order: 50,                                                         // optional, lower comes first
 *     pinned: true,                                                      // optional: also an icon in the head of a wide tile
 *   })   → unregister()
 *
 * Tiles already open get the new action too.
 */
const actions = new Map();
const listeners = new Set();

export function registerPaneAction({ id, icon, label, title, when = () => true, enabled = () => true, run, order = 100, pinned = false }) {
  if (!id || typeof run !== 'function') throw new TypeError('A pane action needs an id and run(pane)');
  actions.set(id, { id, icon, label: label ?? title, title: title ?? label, when, enabled, run, order, pinned });
  for (const fn of listeners) fn();
  return () => {
    if (actions.get(id)?.run !== run) return;
    actions.delete(id);
    for (const fn of listeners) fn();
  };
}

/** The actions for a session descriptor, in order */
export function paneActionsFor(session) {
  return [...actions.values()]
    .filter((a) => { try { return a.when(session); } catch { return false; } })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Called when the list changes; returns the function that stops listening */
export function onPaneActionsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
