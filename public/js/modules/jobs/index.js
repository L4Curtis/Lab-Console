/**
 * "Backups" section (#/jobs/<bench>[/backup|reset|inject|templates|runs]): what
 * a team does with the configurations of its bench (docs/v2/UX.md §10.6)
 *
 *   - start a backup, a reset, an injection, a comparison with the live
 *     devices (dialogs.js); the job runs on the server and is followed here
 *     live, device by device, by everyone who may see it, with a Stop button
 *     and, for a reset, the countdown before anything starts;
 *   - right after a backup: the ZIP, and a plain message that the server is
 *     not a backup;
 *   - three tabs: the team's snapshots (read, ZIP, diff, compare with the live
 *     devices, the TP folder, delete, a ZIP import, a search across them), the
 *     TP templates (everyone injects them; admins publish them and choose the
 *     base configuration applied after a reset), the bench's recent jobs and
 *     their reports.
 *
 * The backup offered when a bench is released lands here (#/jobs/B4M/backup).
 * The server decides every permission again; what is computed here only
 * hides buttons
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { getJson, live, callOrToast } from '../../core/api.js';
import { loading, loadFailure } from '../../shared/loadState.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { isCompact, onViewportChange } from '../../core/viewport.js';
import { confirmDialog, openDialog } from '../../shared/dialog.js';
import { openMenu } from '../../shared/menu.js';
import { mountTabs } from '../../shared/tabs.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { benchApi } from './text.js';
import { backupDialog, resetDialog, injectDialog, compareDialog, viewSetDialog, diffDialog, reportDialog, templateDialog } from './dialogs.js';
import { createRunning, FINAL } from './running.js';
import { createSnapshots, hitsView } from './snapshots.js';
import { createTemplates } from './templates.js';
import { createRuns } from './runs.js';
import { fmtShort } from '../../core/format.js';

const TAB_ADDRESSES = new Set(['templates', 'runs']);

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
  let retryStart = null;
  let failure = null;       // why the bench's page could not be read, shown with a retry button

  // ── Layout ────────────────────────────────────────────────────────────────
  const picker = h('button.btn.sm.jobs-picker', { type: 'button', dataset: { action: 'pick' }, 'aria-haspopup': 'menu', onclick: () => pick() });
  const header = pageHeader({ title: 'jobs.title', context: () => picker, tabs: true });
  const notice = h('div.jobs-notice', { role: 'status' });
  const failureBox = h('div.jobs-failure');
  const importInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => importZip() });
  const importTemplateInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => importTemplateZip() });
  const tabHost = h('div.jobs-tabs');
  const content = h('div.stack.tight.jobs-content', { hidden: true }, notice); // shown once the bench's page is read
  const body = h('div.view-body', failureBox, content, importInput);
  el.append(header.el, body);
  failureBox.replaceChildren(loading());

  const running = createRunning({
    onCancel: (job) => cancel(job),
    onReport: (job) => reportDialog(job),
    onDismiss: () => { lastBackup = null; running.render(current); },
    zipOf: (job) => (lastBackup && lastBackup.jobId === job.id ? { href: `/api/jobs/snapshots/${encodeURIComponent(lastBackup.id)}/zip` } : null),
  });

  const act = {
    view: (s) => viewSetDialog(s),
    diff: (s) => diffDialog(s, snapshots),
    compare: (s) => startCompare(s.id),
    inject: (s) => startInject(s.id),
    publish: (s) => newTemplate(s),
    remove: (s) => removeSnapshot(s),
    search: (q) => callOrToast('GET', `/api/jobs/snapshots/search?q=${encodeURIComponent(q)}`),
  };
  const snapView = createSnapshots({ bench: () => bench, detail: () => detail, snapshots: () => snapshots, isAdmin: session.isAdmin, act });
  const tplView = createTemplates({
    detail: () => detail, templates: () => templates, isAdmin: session.isAdmin, importInput: importTemplateInput,
    act: {
      view: (x) => viewSetDialog(x, { kind: 'templates' }),
      inject: (x) => startInject(x.id),
      setBase: (x, on) => setBase(x, on),
      remove: (x) => removeTemplate(x),
      create: () => newTemplate(),
    },
  });
  const runView = createRuns({ history: () => history, act: { report: (job) => reportDialog(job) } });

  content.append(running.el, tabHost);
  // The tabs are addressed as #/jobs/<bench>/templates: the bench is part of the address, so it is built here
  const tabNavigate = (hash) => {
    const id = hash.split('/').pop();
    navigate(`#/jobs/${encodeURIComponent(bench)}${TAB_ADDRESSES.has(id) ? `/${id}` : ''}`);
  };
  const panel = (view) => async () => ({ mount: (host) => { host.append(view.el); view.render(); return {}; } });
  const tabs = mountTabs(tabHost, [
    { id: 'snapshots', title: () => t('jobs.tabs.snapshots'), load: panel(snapView) },
    { id: 'templates', title: () => t('jobs.tabs.templates'), load: panel(tplView) },
    { id: 'runs', title: () => t('jobs.tabs.runs'), load: panel(runView) },
  ], { navigate: tabNavigate, base: '#/jobs', bar: header.tabBar, label: t('jobs.title') });

  // ── Data ──────────────────────────────────────────────────────────────────

  async function loadBenches() {
    const labs = await getJson('/api/consoles/labs');
    benches = labs.labs.map((l) => l.name);
  }

  async function load() {
    if (!bench) return;
    const name = bench;
    let d; let s; let tp; let runs;
    try {
      [d, s, tp, runs] = await Promise.all([
        getJson(benchApi(name)),
        getJson(`/api/jobs/snapshots?bench=${encodeURIComponent(name)}`),
        getJson('/api/jobs/templates'),
        getJson(`/api/jobs/runs?bench=${encodeURIComponent(name)}`),
      ]);
    } catch (err) {
      if (name === bench) { failure = err; renderFailure(); }
      return;
    }
    if (name !== bench) return;
    failure = null;
    failureBox.replaceChildren();
    content.hidden = false;
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
    updateHeader();
    if (FINAL.has(job.state) && wasMine) {
      if (job.kind === 'backup' && job.snapshotId && job.devices.some((x) => x.state === 'done')) lastBackup = { id: job.snapshotId, jobId: job.id };
      load();
    }
  });
  live.on('jobs:running', () => { if (visible && detail && !current) load(); });
  live.on('benches:state', () => { if (visible) load(); });
  onLocaleChange(() => { if (detail) { renderNotice(); updateHeader(); } });
  onViewportChange(() => updateHeader());

  // ── Actions ───────────────────────────────────────────────────────────────

  function started(job) {
    if (!job) return;
    current = job;
    lastBackup = null;
    renderRunning();
    updateHeader();
  }

  const startBackup = async () => started(await backupDialog(bench, detail));
  const startReset = async () => started(await resetDialog(bench, detail));
  const startInject = async (preset) => started(await injectDialog(bench, detail, { snapshots, templates, preset }));
  const startCompare = async (preset) => started(await compareDialog(bench, detail, { snapshots, preset }));

  async function cancel(job) {
    const res = await callOrToast('POST', `/api/jobs/runs/${encodeURIComponent(job.id)}/cancel`);
    if (res) { current = res.job; renderRunning(); updateHeader(); }
  }

  /** Send the ZIP chosen in `input` to `path`; the file's name, without .zip, names what it becomes. → the answer, or null (the error is shown) */
  async function postZip(input, path) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return null;
    const name = encodeURIComponent(file.name.replace(/\.zip$/i, '').slice(0, 80));
    return callOrToast('POST', path(name), file, { type: 'application/zip' });
  }

  async function importZip() {
    const data = await postZip(importInput, (label) => `/api/jobs/snapshots/import?bench=${encodeURIComponent(bench)}&label=${label}`);
    if (!data) return;
    toast(t('jobs.snapshots.imported', { count: data.snapshot.devices.length }));
    await load();
  }

  async function importTemplateZip() {
    const data = await postZip(importTemplateInput, (name) => `/api/jobs/templates/import?name=${name}`);
    if (!data) return;
    toast(t('jobs.templates.published', { name: data.template.name }));
    await load();
  }

  /** On a phone the search is a sheet opened from the app bar */
  function searchSheet() {
    const box = h('input.field', { type: 'search', placeholder: t('jobs.snapshots.searchPlaceholder'), 'aria-label': t('jobs.snapshots.search'), minlength: 2, maxlength: 100 });
    const out = h('div.jobs-search');
    const form = h('form.form-grid', { onsubmit: async (e) => {
      e.preventDefault();
      const q = box.value.trim();
      if (q.length < 2) return;
      const res = await act.search(q);
      if (res) out.replaceChildren(hitsView(res, q));
    } }, h('label', h('span', t('jobs.snapshots.search')), box), h('button.btn.primary.lg', { type: 'submit' }, icon('search'), t('jobs.snapshots.search')));
    openDialog(h('div.modal-body', form, out), { title: t('jobs.snapshots.search'), size: 'lg', initialFocus: box });
  }

  async function removeSnapshot(s) {
    const ok = await confirmDialog({ title: t('jobs.snapshots.deleteTitle'), body: t('jobs.snapshots.deleteBody', { date: fmtShort(s.createdAt) }), confirmLabel: t('jobs.snapshots.delete'), danger: true });
    if (ok && await callOrToast('DELETE', `/api/jobs/snapshots/${encodeURIComponent(s.id)}`)) await load();
  }

  async function newTemplate(snapshot = null) {
    const tpl = await templateDialog({ snapshot });
    if (tpl) { toast(t('jobs.templates.published', { name: tpl.name })); await load(); }
  }

  async function setBase(tpl, on) {
    if (await callOrToast('PUT', `/api/jobs/templates/${encodeURIComponent(tpl.id)}`, { base: on })) await load();
  }

  async function removeTemplate(tpl) {
    const ok = await confirmDialog({ title: t('jobs.templates.deleteTitle', { name: tpl.name }), body: t('jobs.templates.deleteBody'), confirmLabel: t('jobs.templates.delete'), danger: true });
    if (ok && await callOrToast('DELETE', `/api/jobs/templates/${encodeURIComponent(tpl.id)}`)) await load();
  }

  async function pick() {
    const id = await openMenu(picker, benches.map((b) => ({ id: b, label: b, checked: b === bench })), { label: t('jobs.bench') });
    if (id && id !== bench) await select(id);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** The bench's page could not be read: a message and a retry, in place of the empty headings */
  function renderFailure() {
    content.hidden = true;
    failureBox.replaceChildren(loadFailure('jobs.loadFailed', failure, () => retry()));
  }

  function retry() {
    if (!bench) return retryStart();
    failureBox.replaceChildren(loading());
    return load();
  }

  const isBusy = () => Boolean(current && !FINAL.has(current.state));

  /** The header follows what the person may do now; on a phone the search is an icon in the app bar */
  function updateHeader() {
    picker.replaceChildren(icon('rack'), bench ? t('jobs.picker', { bench }) : t('jobs.bench'), icon('chevronDown'));
    const may = Boolean(detail?.canOperate);
    const busy = isBusy();
    const none = !detail;
    header.update({
      primary: { id: 'backup', label: 'jobs.actions.backup', icon: 'download', run: startBackup, disabled: none || busy || !(may || detail?.offer) },
      actions: [
        { id: 'inject', label: 'jobs.actions.inject', icon: 'upload', run: () => startInject(), disabled: none || busy || !may || !(snapshots.length || templates.length) },
        { id: 'compare', label: 'jobs.actions.compare', icon: 'columns', run: () => startCompare(), disabled: none || busy || !may || !snapshots.length },
        isCompact() ? { id: 'search', label: 'jobs.snapshots.search', icon: 'search', bar: true, run: searchSheet } : null,
        { id: 'import', label: 'jobs.snapshots.import', icon: 'upload', run: () => importInput.click(), disabled: none },
        { id: 'reset', label: 'jobs.actions.reset', icon: 'refresh', run: startReset, danger: true, disabled: none || busy || !may },
      ],
    });
  }

  function render() {
    if (!detail) return;
    renderNotice();
    updateHeader();
    renderRunning();
    snapView.render();
    tplView.render();
    runView.render();
  }

  function renderNotice() {
    const parts = [];
    const callout = (cls, tone, iconName, ...nodes) => h(`p.jobs-callout.${cls}`, { dataset: { tone } }, icon(iconName), h('span', ...nodes));
    if (detail.lock) parts.push(callout('jobs-lock', 'danger', 'lock', t('jobs.notice.locked', { reason: detail.lock.reason })));
    else if (detail.offer) parts.push(callout('jobs-offer', 'warning', 'download', t('jobs.notice.offer', { bench })));
    else if (!detail.canOperate) parts.push(callout('jobs-info', 'info', 'info', detail.holder ? t('jobs.notice.otherTeam', { team: detail.holder.teamName ?? '?' }) : t('jobs.notice.takeFirst')));
    if (detail.base) parts.push(h('p.card-meta.jobs-base', t('jobs.notice.base', { name: detail.base.name })));
    notice.replaceChildren(...parts);
  }

  function renderRunning() {
    running.render(current && current.bench === bench ? current : null);
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  async function select(name, action = null) {
    if (!benches.includes(name)) return;
    if (name !== bench) {
      bench = name;
      detail = null;
      current = null;
      lastBackup = null;
      content.hidden = true;
      failureBox.replaceChildren(loading());
    }
    updateHeader();
    // The address keeps the tab on screen, unless this call is about a dialog to open
    const tab = TAB_ADDRESSES.has(action) ? action : !action && TAB_ADDRESSES.has(tabs.current) ? tabs.current : null;
    navigate(`#/jobs/${encodeURIComponent(name)}${tab ? `/${tab}` : ''}`);
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

  /** The list of benches, then the page of one; a failure of either shows the message with its retry */
  async function start(name, action) {
    if (!benches.length) {
      try { await loadBenches(); } catch (err) { failure = err; renderFailure(); return; }
    }
    await select(name && benches.includes(name) ? name : bench ?? await defaultBench(), action ?? null);
  }
  retryStart = () => { failureBox.replaceChildren(loading()); return start(null, null); };
  updateHeader();

  return {
    async show([name, action] = []) {
      visible = true;
      // A tab has its own address; the other words are what to start (backup, reset, inject)
      await tabs.show([TAB_ADDRESSES.has(action) ? action : 'snapshots']);
      await start(name, action ?? null);
    },
    hide() { visible = false; tabs.hide(); },
  };
}
