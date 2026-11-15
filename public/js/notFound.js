/** The page served with a 404 for any address that is not a file or a route (public/404.html) */
import { initTheme } from './core/theme.js';
import { loadSession } from './core/session.js';
import { initI18n } from './core/i18n.js';

initTheme(); // light, dark, or the system's choice (core/theme.js)
const session = await loadSession();
await initI18n({ defaultLocale: session.locale, namespaces: ['common'] });
