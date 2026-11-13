/**
 * What the jobs section says about a job: the translated codes of the
 * server (jobs.*, ios.*, consoles.*, automation.*), state names, sizes and
 * dates, and the small API wrappers the section and its dialogs share
 */
import { h, toast } from '../../core/dom.js';
import { request } from '../../core/api.js';
import { t, tError, getLocale, has } from '../../core/i18n.js';
import { serverText } from '../../shared/serverText.js';

/** A code of the server, in the user's language: jobs.* and ios.* here, consoles.* and automation.* as the terminal says them */
export function codeText(code, params = {}, fallback = '') {
  if (!code) return fallback;
  const p = { ...params };
  if (p.cause) p.cause = codeText(p.cause, {}, p.cause);
  const [mod] = String(code).split('.');
  if (mod === 'consoles' || mod === 'automation') return serverText({ code, params: p, message: fallback || code });
  return tError(code, p, fallback || code);
}

/** A progress step (jobs.steps.* or ios.steps.*) */
export function stepText(code) {
  if (!code) return '';
  const [mod, , name] = String(code).split('.');
  const key = mod === 'jobs' ? `jobs.steps.${name}` : mod === 'ios' ? `ios.steps.${name}` : null;
  return key && has(key) ? t(key) : code;
}

export const stateText = (state) => (has(`jobs.state.${state}`) ? t(`jobs.state.${state}`) : state);
export const kindText = (kind) => (has(`jobs.kind.${kind}`) ? t(`jobs.kind.${kind}`) : kind);

export function fmtDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  return n < 1024 ? t('jobs.size.bytes', { n }) : t('jobs.size.kb', { n: (n / 1024).toFixed(n < 10_240 ? 1 : 0) });
}

/** A JSON call; on failure the translated error as a toast, and null */
export async function call(method, url, body) {
  try {
    return await request(method, url, body);
  } catch (err) {
    toast(codeText(err.code, err.params, err.message), 'error', 7000);
    return null;
  }
}

export const benchApi = (bench, rest = '') => `/api/jobs/benches/${encodeURIComponent(bench)}${rest}`;

/** A unified diff as lines coloured by their sign (text only, never HTML) */
export function patchView(patch) {
  const lines = String(patch).split('\n').filter((l, i) => i > 3 || !/^(={3,}|-{3} |\+{3} |Index: )/.test(l));
  return h('pre.jobs-patch', lines.map((l) => h(`span.${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'}`, `${l}\n`)));
}
