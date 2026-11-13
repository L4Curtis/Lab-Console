/**
 * Buttons of the console tiles, registered by whoever provides them
 * (ARCHITECTURE §8). The terminal tile lays out every registered action
 * whose `when(session)` holds, in `order`, and asks `enabled(pane)` again
 * each time the console's state changes (connected, the keyboard changing
 * hands, a task starting), so a later lot adds "Back up this device" or
 * "Send to several consoles" with one call and no change to the tile:
 *
 *   registerPaneAction({
 *     id: 'backup', icon: 'download', title: 'jobs.actions.backupOne',   // a dictionary key, or () => text
 *     when: (session) => session.kind === 'console',
 *     enabled: (pane) => pane.canPilot,                                  // optional
 *     run: (pane) => …,
 *     order: 50,                                                         // optional, lower comes first
 *   })   → unregister()
 *
 * Tiles already open get the new button too.
 */
const actions = new Map();
const listeners = new Set();

export function registerPaneAction({ id, icon, title, when = () => true, enabled = () => true, run, order = 100 }) {
  if (!id || typeof run !== 'function') throw new TypeError('A pane action needs an id and run(pane)');
  actions.set(id, { id, icon, title, when, enabled, run, order });
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
