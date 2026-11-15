/**
 * Bench jobs on the lab diagram, for everyone: a ring around each device a
 * job works on, a badge with its state, and the step in the tooltip. Fed by
 * the sticky SSE topic 'jobs:running' (which bench runs what, device by
 * device). Started once by main.js, whichever section is on screen
 */
import { loadCss } from '../../core/dom.js';
import { live } from '../../core/api.js';
import { t, loadNamespace } from '../../core/i18n.js';
import { registerDiagramLayer, refreshDiagram } from '../../shared/diagramLayers.js';
import { stepText, stateText, kindText } from './text.js';

const MARK = { queued: '…', waiting: '⌨', running: '⟳', done: '✓', failed: '!', skipped: '–', cancelled: '×' };

export async function start() {
  await Promise.all([loadNamespace('jobs', 'ios'), loadCss('jobs')]);
  let byDevice = new Map(); // device key → { job, device }
  live.on('jobs:running', (data) => {
    byDevice = new Map();
    for (const job of data?.jobs ?? []) for (const d of job.devices) byDevice.set(d.key, { job, device: d });
    refreshDiagram();
  });
  registerDiagramLayer('jobs', (device) => {
    const entry = byDevice.get(device.key);
    if (!entry) return null;
    const { job, device: d } = entry;
    const title = `${kindText(job.kind)} · ${stateText(d.state)}`;
    return {
      ring: job.kind === 'reset' || job.kind === 'inject' ? 'job-danger' : 'job',
      badges: [{ text: MARK[d.state] ?? '?', title, kind: 'job' }],
      tooltip: [t('jobs.layer.tooltip', { kind: kindText(job.kind), name: job.actor?.name ?? '', state: stateText(d.state) }), d.step ? stepText(d.step) : null].filter(Boolean),
    };
  });
}
