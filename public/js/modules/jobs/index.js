/**
 * "Backups and jobs" section (#/jobs/<bench>[/backup|reset|inject]): what a
 * team does with the configurations of its bench
 *
 *   - start a backup, a reset, an injection, a comparison with the live
 *     devices (dialogs.js); the job runs on the server and is followed here
 *     live, device by device, by everyone who may see it, with a Stop button
 *     and, for a reset, the countdown before anything starts;
 *   - right after a backup: the ZIP, and a plain message that the server is
 *     not a backup;
 *   - the team's snapshots (read, ZIP, diff, compare with the live devices,
 *     the TP folder, delete), a ZIP import, a search across them;
 *   - the TP templates (everyone injects them; admins publish them and
 *     choose the base configuration applied after a reset);
 *   - the bench's recent jobs and their reports.
 *
 * The backup offered when a bench is released lands here (#/jobs/B4M/backup).
 * The server decides every permission again; what is computed here only
 * hides buttons
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { t, tNode, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { confirmDialog } from '../../shared/dialog.js';
import { codeText, stepText, stateText, kindText, fmtDate, fmtBytes, call, benchApi } from './text.js';
import { backupDialog, resetDialog, injectDialog, compareDialog, viewSetDialog, diffDialog, reportDialog, templateDialog } from './dialogs.js';

const FINAL = new Set(['done', 'failed', 'cancelled', 'partial']);

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('jobs', 'ios', 'terminal'), loadCss('jobs')]);

  let benches = [];
  let bench = null;
  let detail = null;
  let snapshots = [];
  let templates = [];
  let history = [];
  let current = null;       // the job followed on screen
  let lastBackup = null;    // the snapshot a backup of this page just made: offered as a ZIP
  let visible = false;
  let tick = null;

  // ── Layout ────────────────────────────────────────────────────────────────
  const picker = h('select.field.jobs-bench', { 'aria-label': t('jobs.bench'), onchange: () => select(picker.value) });
  const head = h('header.view-head', h('div.view-title', h('h1', tNode('jobs.title')), h('p', tNode('jobs.subtitle'))), h('label.jobs-bench-label', h('span', tNode('jobs.bench')), picker));
  const notice = h('div.jobs-notice', { role: 'status' });
  const actions = h('div.jobs-actions');
  const running = h('section.jobs-current', { hidden: true, 'aria-live': 'polite' });
  const download = h('section.jobs-download', { hidden: true, role: 'alert' });
  const snapList = h('div.jobs-snapshots');
  const searchBox = h('input.field', { type: 'search', placeholder: t('jobs.snapshots.searchPlaceholder'), 'aria-label': t('jobs.snapshots.search'), minlength: 2, maxlength: 100 });
  const searchOut = h('div.jobs-search', { hidden: true });
  const importInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => importZip() });
  const tplList = h('div.jobs-templates');
  const histList = h('ol.jobs-history');
  const body = h('div.jobs-view', h('div.panel',
    notice, actions, running, download,
    h('section', h('div.jobs-section-head', h('h2', tNode('jobs.snapshots.title')),
      h('form.jobs-search-form', { onsubmit: (e) => { e.preventDefault(); search(); } }, searchBox, h('button.btn.small', { type: 'submit' }, icon('search'), tNode('jobs.snapshots.search'))),
      h('button.btn.small', { type: 'button', dataset: { action: 'import' }, onclick: () => importInput.click() }, icon('upload'), tNode('jobs.snapshots.import')), importInput),
    h('p.muted.jobs-not-backup', tNode('jobs.snapshots.notBackup')), searchOut, snapList),
    h('section', h('div.jobs-section-head', h('h2', tNode('jobs.templates.title')),
      session.isAdmin ? h('button.btn.small', { type: 'button', dataset: { action: 'new-template' }, onclick: () => newTemplate() }, icon('plus'), tNode('jobs.templates.new')) : null), tplList),
    h('section', h('h2', tNode('jobs.history.title')), histList)));
  el.append(head, body);

  // ── Data ──────────────────────────────────────────────────────────────────

  async function loadBenches() {
    const labs = await getJson('/api/consoles/labs').catch(() => ({ labs: [] }));
    benches = labs.labs.map((l) => l.name);
    picker.replaceChildren(...benches.map((b) => h('option', { value: b }, b)));
  }

  async function load() {
    if (!bench) return;
    const name = bench;
    const [d, s, tp, runs] = await Promise.all([
      call('GET', benchApi(name)),
      getJson(`/api/jobs/snapshots?bench=${encodeURIComponent(name)}`).catch(() => ({ snapshots: [] })),
      getJson('/api/jobs/templates').catch(() => ({ templates: [] })),
      getJson(`/api/jobs/runs?bench=${encodeURIComponent(name)}`).catch(() => ({ jobs: [] })),
    ]);
    if (name !== bench) return;
    detail = d;
    snapshots = s.snapshots;
    templates = tp.templates;
    history = runs.jobs;
    if (d?.running?.devices && (!current || current.bench !== name || FINAL.has(current.state))) current = d.running;
    else if (current && current.bench !== name) current = null;
    render();
  }

  // Live: the job followed (and any job of this bench), the summary of every bench
  live.on('jobs:job', (job) => {
    if (job.bench !== bench) return;
    const wasMine = current?.id === job.id;
    if (!current || wasMine || !FINAL.has(job.state)) current = job;
    renderRunning();
    if (FINAL.has(job.state) && wasMine) {
      if (job.kind === 'backup' && job.snapshotId && job.devices.some((x) => x.state === 'done')) lastBackup = { id: job.snapshotId, jobId: job.id };
      load();
    }
  });
  live.on('jobs:running', () => { if (visible && detail && !current) load(); });
  live.on('benches:state', () => { if (visible) load(); });
  onLocaleChange(() => render());

  // ── Actions ───────────────────────────────────────────────────────────────

  function started(job) {
    if (!job) return;
    current = job;
    lastBackup = null;
    renderRunning();
  }

  const startBackup = async () => started(await backupDialog(bench, detail));
  const startReset = async () => started(await resetDialog(bench, detail));
  const startInject = async (preset) => started(await injectDialog(bench, detail, { snapshots, templates, preset }));
  const startCompare = async (preset) => started(await compareDialog(bench, detail, { snapshots, preset }));

  async function cancel(job) {
    const res = await call('POST', `/api/jobs/runs/${encodeURIComponent(job.id)}/cancel`);
    if (res) { current = res.job; renderRunning(); }
  }

  async function importZip() {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    const res = await fetch(`/api/jobs/snapshots/import?bench=${encodeURIComponent(bench)}&label=${encodeURIComponent(file.name.replace(/\.zip$/i, '').slice(0, 80))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip', Accept: 'application/json' }, body: file, credentials: 'same-origin',
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) { toast(codeText(data?.code, data?.params, data?.error ?? String(res.status)), 'error', 7000); return; }
    toast(t('jobs.snapshots.imported', { count: data.snapshot.devices.length }));
    await load();
  }

  async function search() {
    const q = searchBox.value.trim();
    if (q.length < 2) { searchOut.hidden = true; return; }
    const res = await call('GET', `/api/jobs/snapshots/search?q=${encodeURIComponent(q)}`);
    if (!res) return;
    searchOut.hidden = false;
    searchOut.replaceChildren(
      h('p.muted', t('jobs.snapshots.hits', { count: res.hits.length, q })),
      h('ul', res.hits.map((x) => h('li', h('span.muted', `${fmtDate(x.createdAt)} · ${x.bench} · ${x.device}:${x.line}`), ' ', h('code', x.text)))));
  }

  async function removeSnapshot(s) {
    const ok = await confirmDialog({ title: t('jobs.snapshots.deleteTitle'), body: t('jobs.snapshots.deleteBody', { date: fmtDate(s.createdAt) }), confirmLabel: t('jobs.snapshots.delete'), danger: true });
    if (ok && await call('DELETE', `/api/jobs/snapshots/${encodeURIComponent(s.id)}`)) await load();
  }

  async function newTemplate(snapshot = null) {
    const tpl = await templateDialog({ snapshot });
    if (tpl) { toast(t('jobs.templates.published', { name: tpl.name })); await load(); }
  }

  async function setBase(tpl, on) {
    if (await call('PUT', `/api/jobs/templates/${encodeURIComponent(tpl.id)}`, { base: on })) await load();
  }

  async function removeTemplate(tpl) {
    const ok = await confirmDialog({ title: t('jobs.templates.deleteTitle', { name: tpl.name }), body: t('jobs.templates.deleteBody'), confirmLabel: t('jobs.templates.delete'), danger: true });
    if (ok && await call('DELETE', `/api/jobs/templates/${encodeURIComponent(tpl.id)}`)) await load();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const button = (action, label, onclick, { cls = '', disabled = false, iconName = null } = {}) => h(`button.btn.small${cls}`, { type: 'button', dataset: { action }, onclick, disabled }, iconName ? icon(iconName) : null, label);

  function render() {
    if (!detail) return;
    renderNotice();
    const may = detail.canOperate;
    const busy = Boolean(current && !FINAL.has(current.state));
    actions.replaceChildren(
      button('backup', t('jobs.actions.backup'), startBackup, { cls: '.primary', disabled: busy || !(may || detail.offer), iconName: 'download' }),
      button('inject', t('jobs.actions.inject'), () => startInject(), { disabled: busy || !may || !(snapshots.length || templates.length), iconName: 'script' }),
      button('compare', t('jobs.actions.compare'), () => startCompare(), { disabled: busy || !may || !snapshots.length, iconName: 'columns' }),
      button('reset', t('jobs.actions.reset'), startReset, { cls: '.danger', disabled: busy || !may, iconName: 'refresh' }));
    renderRunning();
    renderSnapshots();
    renderTemplates();
    renderHistory();
  }

  function renderNotice() {
    const parts = [];
    if (detail.lock) parts.push(h('p.jobs-lock', icon('lock'), t('jobs.notice.locked', { reason: detail.lock.reason })));
    else if (detail.offer) parts.push(h('p.jobs-offer', icon('download'), t('jobs.notice.offer', { bench }), ' ', button('offer', t('jobs.actions.backup'), startBackup, { cls: '.primary' })));
    else if (!detail.canOperate) parts.push(h('p.muted', detail.holder ? t('jobs.notice.otherTeam', { team: detail.holder.teamName ?? '?' }) : t('jobs.notice.takeFirst')));
    if (detail.base) parts.push(h('p.muted', t('jobs.notice.base', { name: detail.base.name })));
    notice.replaceChildren(...parts);
  }

  function renderRunning() {
    clearInterval(tick);
    const job = current;
    if (!job || job.bench !== bench) { running.hidden = true; download.hidden = true; return; }
    running.hidden = false;
    const pending = job.state === 'pending';
    const countdown = h('strong.jobs-countdown');
    const updateCountdown = () => { countdown.textContent = t('jobs.current.countdown', { count: Math.max(0, Math.ceil((Date.parse(job.startsAt) - Date.now()) / 1000)) }); };
    if (pending) { updateCountdown(); tick = setInterval(updateCountdown, 250); }
    const done = job.devices.filter((d) => FINAL.has(d.state)).length;
    running.dataset.state = job.state;
    running.replaceChildren(
      h('div.jobs-current-head',
        h('h2', t('jobs.current.title', { kind: kindText(job.kind), bench: job.bench })),
        h('span.jobs-state', { dataset: { state: job.state } }, stateText(job.state)),
        h('span.muted', t('jobs.current.by', { name: job.actor?.name ?? '' })),
        pending ? countdown : h('span.muted', t('jobs.current.progress', { done, total: job.devices.length })),
        !FINAL.has(job.state) ? button('cancel', t('jobs.current.stop'), () => cancel(job), { cls: '.danger', iconName: 'stop' }) : null,
        FINAL.has(job.state) ? button('report', t('jobs.current.report'), () => reportDialog(job)) : null),
      h('table.vm-table.jobs-devices-table', h('tbody', job.devices.map((d) => h('tr', { dataset: { device: d.name, state: d.state } },
        h('td', h('strong', d.name)),
        h('td', h('span.jobs-state', { dataset: { state: d.state } }, stateText(d.state))),
        h('td.jobs-step', deviceLine(d)))))));
    renderDownload(job);
  }

  function deviceLine(d) {
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

  /** Right after a backup: the ZIP, now, and why */
  function renderDownload(job) {
    const show = lastBackup && lastBackup.jobId === job.id;
    download.hidden = !show;
    if (!show) return;
    download.replaceChildren(
      h('p', h('strong', t('jobs.download.title')), ' ', t('jobs.download.body')),
      h('a.btn.primary', { href: `/api/jobs/snapshots/${encodeURIComponent(lastBackup.id)}/zip`, download: '', dataset: { action: 'download-zip' } }, icon('download'), t('jobs.download.button')));
  }

  function renderSnapshots() {
    if (!snapshots.length) { snapList.replaceChildren(h('p.muted', t('jobs.snapshots.none'))); return; }
    snapList.replaceChildren(h('div.table-wrap', h('table.vm-table.jobs-snapshots-table',
      h('thead', h('tr', ['date', 'label', 'devices', 'by', 'actions'].map((c) => h('th', t(`jobs.snapshots.col.${c}`))))),
      h('tbody', snapshots.map((s) => h('tr', { dataset: { snapshot: s.id } },
        h('td', fmtDate(s.createdAt)),
        h('td', s.label || t(`jobs.origin.${s.origin}`), s.teamName ? h('small.muted', ` · ${s.teamName}`) : null),
        h('td', s.devices.map((d) => d.device).join(', ')),
        h('td', s.author.name),
        h('td.jobs-row-actions',
          button('view', t('jobs.snapshots.view'), () => viewSetDialog(s)),
          h('a.btn.small', { href: `/api/jobs/snapshots/${encodeURIComponent(s.id)}/zip`, download: '' }, icon('download'), t('jobs.snapshots.zip')),
          snapshots.length > 1 ? button('diff', t('jobs.snapshots.diff'), () => diffDialog(s, snapshots)) : null,
          detail.canOperate ? button('compare', t('jobs.snapshots.live'), () => startCompare(s.id)) : null,
          detail.canOperate ? button('inject', t('jobs.snapshots.inject'), () => startInject(s.id)) : null,
          s.bench === bench ? h('a.btn.small', { href: `${benchApi(bench, '/folder')}?snapshot=${encodeURIComponent(s.id)}`, download: '' }, t('jobs.snapshots.folder')) : null,
          session.isAdmin ? button('publish', t('jobs.templates.publish'), () => newTemplate(s)) : null,
          button('delete', t('jobs.snapshots.delete'), () => removeSnapshot(s), { cls: '.subtle.danger' }))))))));
  }

  function renderTemplates() {
    if (!templates.length) { tplList.replaceChildren(h('p.muted', t('jobs.templates.none'))); return; }
    tplList.replaceChildren(h('ul.jobs-template-list', templates.map((tpl) => h('li', { dataset: { template: tpl.name } },
      h('div', h('strong', tpl.name), tpl.base ? h('span.badge', t('jobs.templates.baseBadge')) : null, tpl.description ? h('p.muted', tpl.description) : null,
        h('small.muted', tpl.devices.map((d) => (d.device === '*' ? t('jobs.templates.every') : d.device)).join(', '))),
      h('div.jobs-row-actions',
        button('view', t('jobs.snapshots.view'), () => viewSetDialog(tpl, { kind: 'templates' })),
        detail?.canOperate ? button('inject', t('jobs.snapshots.inject'), () => startInject(tpl.id)) : null,
        session.isAdmin ? button('base', tpl.base ? t('jobs.templates.unsetBase') : t('jobs.templates.setBase'), () => setBase(tpl, !tpl.base)) : null,
        session.isAdmin ? button('delete', t('jobs.templates.delete'), () => removeTemplate(tpl), { cls: '.subtle.danger' }) : null)))));
  }

  function renderHistory() {
    if (!history.length) { histList.replaceChildren(h('li.muted', t('jobs.history.none'))); return; }
    histList.replaceChildren(...history.slice(0, 15).map((job) => h('li', { dataset: { job: job.id } },
      h('time', fmtDate(job.createdAt)), ' ',
      h('span', t('jobs.history.line', { kind: kindText(job.kind), name: job.actor?.name ?? '', count: job.devices.length })), ' ',
      h('span.jobs-state', { dataset: { state: job.state } }, stateText(job.state)), ' ',
      button('report', t('jobs.current.report'), () => reportDialog(job), { cls: '.subtle' }))));
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  async function select(name, action = null) {
    if (!benches.includes(name)) return;
    if (name !== bench) {
      bench = name;
      picker.value = name;
      detail = null;
      current = null;
      lastBackup = null;
    }
    navigate(`#/jobs/${encodeURIComponent(name)}`);
    await load();
    if (action === 'backup' && detail && (detail.canOperate || detail.offer)) startBackup();
    if (action === 'reset' && detail?.canOperate) startReset();
    if (action === 'inject' && detail?.canOperate) startInject();
  }

  /** The bench my team holds, else the first one */
  async function defaultBench() {
    const summaries = await getJson('/api/benches').catch(() => null);
    const mine = summaries?.benches?.find((b) => b.occupants?.some((o) => o.id === session.user?.id));
    return mine?.bench ?? benches[0];
  }

  await loadBenches();
  return {
    async show([name, action] = []) {
      visible = true;
      await select(name && benches.includes(name) ? name : bench ?? await defaultBench(), action ?? null);
    },
    hide() { visible = false; },
  };
}
