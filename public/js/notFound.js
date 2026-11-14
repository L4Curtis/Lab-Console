/** The page served with a 404 for any address that is not a file or a route (public/404.html) */
import { prefs } from './core/dom.js';
import { loadSession } from './core/session.js';
import { initI18n } from './core/i18n.js';

document.documentElement.dataset.theme = prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const session = await loadSession();
await initI18n({ defaultLocale: session.locale, namespaces: ['common'] });
