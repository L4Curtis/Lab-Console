/**
 * The screens are drawn again whenever the lab moves. Someone tabbing through
 * the cards must not lose their place each time: after a redraw the focus goes
 * back to the same button or link (the same action of the same bench or panel)
 */

const identify = (el) => {
  const action = el.dataset?.action;
  const scope = action ? el.closest('[data-bench], [data-panel]') : null;
  return scope ? `${scope.dataset.bench ?? scope.dataset.panel}|${action}` : null;
};

/** host.replaceChildren(...nodes), the focus given back to what had it */
export function replaceKeepingFocus(host, nodes) {
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const id = active ? identify(active) : null;
  host.replaceChildren(...nodes);
  if (!id) return;
  for (const el of host.querySelectorAll('[data-action]')) {
    if (identify(el) === id) {
      el.focus();
      return;
    }
  }
}
