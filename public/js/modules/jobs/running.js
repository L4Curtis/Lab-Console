/**
 * The job on screen: a card with its progress, who started it, Stop, and
 * the device list one click away; once a backup is done, the callout that
 * offers the ZIP at once (docs/v2/UX.md §10.6)
 *
 *   const running = createRunning({ onCancel(job), onReport(job), onDismiss(), zipOf(job) → { href } | null });
 *   host.append(running.el);                // two blocks: the card and the callout
 *   running.render(job | null, { bench })   // the job followed here, or null
 *   running.destroy()
 */
import { h, icon } from '../../core/dom.js';
import { t, onLocaleChange } from '../../core/i18n.js';
import { codeText } from '../../shared/serverText.js';
import { stepText, stateBadge, kindText, fmtBytes } from './text.js';

export const FINAL = new Set(['done', 'failed', 'cancelled', 'partial']);
const FINAL_DEVICE = new Set(['done', 'failed', 'skipped', 'cancelled']);

/** What a device line says: why it failed, what was saved, where it is now */
export function deviceLine(d) {
  if (d.state === 'failed' || d.state === 'skipped') return codeText(d.code, d.params, d.message ?? '');
  if (d.state === 'cancelled') return d.stage ? t('jobs.report.cancelledAt', { stage: d.stage }) : '';
  if (d.state === 'done') {
    const r = d.result ?? {};
    if (r.check) return t(`jobs.report.check.${r.check.status === 'same' ? 'same' : 'changed'}`, { added: r.check.added ?? 0, removed: r.check.removed ?? 0 });
    return r.bytes ? t('jobs.current.saved', { size: fmtBytes(r.bytes) }) : t('jobs.state.done');
  }
  const progress = d.progress?.total && d.stage === 'inject' ? ` (${d.progress.done}/${d.progress.total})` : '';
  return `${stepText(d.step)}${progress}`;
}

export function createRunning({ onCancel, onReport, onDismiss, zipOf }) {
  const card = h('section.card.jobs-current', { hidden: true, 'aria-live': 'polite' });
  const callout = h('section.jobs-download', { hidden: true, role: 'alert' });
  const el = h('div.jobs-running', card, callout);
  let job = null;
  let tick = null;
  let opened = false; // the device list stays open while the person reads it

  function render(next = job) {
    clearInterval(tick);
    if (next?.id !== job?.id) opened = false;
    job = next;
    if (!job) { card.hidden = true; callout.hidden = true; return; }
    card.hidden = false;
    const pending = job.state === 'pending';
    const final = FINAL.has(job.state);
    const done = job.devices.filter((d) => FINAL_DEVICE.has(d.state)).length;
    const total = job.devices.length;
    const countdown = h('strong.jobs-countdown');
    const updateCountdown = () => { countdown.textContent = t('jobs.current.countdown', { count: Math.max(0, Math.ceil((Date.parse(job.startsAt) - Date.now()) / 1000)) }); };
    if (pending) { updateCountdown(); tick = setInterval(updateCountdown, 250); }
    card.dataset.state = job.state;
    const progress = h('progress.jobs-progress', { max: String(total || 1), value: String(pending ? 0 : done), 'aria-label': t('jobs.current.progress', { done, total }) });
    const details = h('details.jobs-detail', { open: opened ? '' : null, ontoggle: (e) => { opened = e.target.open; } },
      h('summary', t('jobs.current.detail')),
      h('ul.jobs-device-list', job.devices.map((d) => h('li', { dataset: { device: d.name, state: d.state } },
        h('strong', d.name), stateBadge(d.state), h('span.jobs-step', deviceLine(d))))));
    card.replaceChildren(
      h('div.card-head',
        h('h2', t('jobs.current.title', { kind: kindText(job.kind), bench: job.bench })),
        stateBadge(job.state),
        h('span.card-actions',
          !final ? h('button.btn.sm.danger', { type: 'button', dataset: { action: 'cancel' }, onclick: () => onCancel(job) }, icon('stop'), t('jobs.current.stop')) : null,
          final ? h('button.btn.sm', { type: 'button', dataset: { action: 'report' }, onclick: () => onReport(job) }, t('jobs.current.report')) : null)),
      h('div.card-body',
        h('div.jobs-progress-row',
          progress,
          pending ? countdown : h('span.jobs-count', t('jobs.current.progress', { done, total }))),
        h('p.card-meta', t('jobs.current.by', { name: job.actor?.name ?? '' })),
        details));
    renderCallout();
  }

  /** Right after a backup: the ZIP, now, and why */
  function renderCallout() {
    const zip = job && zipOf(job);
    callout.hidden = !zip;
    if (!zip) return;
    callout.replaceChildren(
      icon('download'),
      h('p', h('strong', t('jobs.download.title')), ' ', t('jobs.download.body')),
      h('a.btn.primary', { href: zip.href, download: '', dataset: { action: 'download-zip' } }, icon('download'), t('jobs.download.button')),
      h('button.icon-btn', { type: 'button', dataset: { action: 'dismiss-download' }, title: t('common.actions.close'), 'aria-label': t('common.actions.close'), onclick: () => onDismiss() }, icon('close')));
  }

  const stop = onLocaleChange(() => render());
  return { el, render, destroy() { clearInterval(tick); stop(); el.remove(); } };
}
