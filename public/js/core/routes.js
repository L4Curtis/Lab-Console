/**
 * Addresses of the previous navigation that still have to work (docs/v2/UX.md
 * §4.2). Pure, no import and no DOM, so that node:test loads it as is:
 *
 *   routeRedirect('#/overview/free', { isAdmin: false, compact: true }) → '#/home/lab/free'
 *   routeRedirect('#/consoles/B4M', …)                                  → null (nothing to change)
 *
 * main.js applies the answer with history.replaceState before routing, so
 * the old address leaves no entry in the history
 */
const OVERVIEW_FILTERS = new Set(['all', 'free', 'mine', 'taken', 'locked']);

/** The part of the address that names a screen: '#/team/mine?sheet' → ['team', 'mine'] */
export function hashParts(hash) {
  return String(hash ?? '').replace(/^#\/?/, '').replace(/\?.*$/, '').split('/').filter(Boolean);
}

export function routeRedirect(hash, { compact = false } = {}) {
  const [path, ...rest] = hashParts(hash);
  switch (path) {
    case 'overview': {
      const filter = rest[0] && OVERVIEW_FILTERS.has(rest[0]) ? `/${rest[0]}` : '';
      return `#/home/lab${filter}`;
    }
    case 'team':
      return rest.length ? null : '#/team/mine';
    case 'admin':
      // A phone shows the list of the administration's screens; a wider screen opens the first one
      return rest.length || compact ? null : '#/admin/users';
    default:
      return null;
  }
}
