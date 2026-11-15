/**
 * What the jobs section says about a job: the translated codes of the
 * state names, steps, sizes, diffs and the URLs of the API (the codes of
 * the server: codeText in shared/serverText.js)
 */
import { h } from '../../core/dom.js';
import { t, has } from '../../core/i18n.js';

/** A progress step (jobs.steps.* or ios.steps.*) */
export function stepText(code) {
  if (!code) return '';
  const [mod, , name] = String(code).split('.');
  const key = mod === 'jobs' ? `jobs.steps.${name}` : mod === 'ios' ? `ios.steps.${name}` : null;
  return key && has(key) ? t(key) : code;
}

export const stateText = (state) => (has(`jobs.state.${state}`) ? t(`jobs.state.${state}`) : state);

const TONES = { pending: 'info', running: 'info', waiting: 'info', queued: 'neutral', done: 'success', failed: 'danger', partial: 'warning', skipped: 'warning', cancelled: 'warning' };
/** The state of a job or of one of its devices, as a badge (a word, never a colour alone) */
export const stateBadge = (state) => h('span.badge.jobs-state', { dataset: { state, tone: TONES[state] ?? 'neutral' } }, stateText(state));

/** Save a file of the platform: a link the page follows itself, so that a refusal is a message (core/downloads.js) */
export function download(href) {
  const link = h('a', { href, download: '', hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
}
export const kindText = (kind) => (has(`jobs.kind.${kind}`) ? t(`jobs.kind.${kind}`) : kind);

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  return n < 1024 ? t('jobs.size.bytes', { n }) : t('jobs.size.kb', { n: (n / 1024).toFixed(n < 10_240 ? 1 : 0) });
}

export const benchApi = (bench, rest = '') => `/api/jobs/benches/${encodeURIComponent(bench)}${rest}`;

/** A unified diff as lines coloured by their sign (text only, never HTML) */
export function patchView(patch) {
  const lines = String(patch).split('\n').filter((l, i) => i > 3 || !/^(={3,}|-{3} |\+{3} |Index: )/.test(l));
  return h('pre.jobs-patch', lines.map((l) => h(`span.${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'}`, `${l}\n`)));
}
