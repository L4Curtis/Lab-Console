/**
 * The dialogs of the jobs section: starting a backup, a reset (what is
 * erased, who is connected, the bench name typed), an injection (source,
 * mode, then the exact script of each device before anything is sent), a
 * comparison with the live devices; reading a snapshot, the diff of two,
 * a job's report, and publishing a TP template (admins)
 *
 * Every dialog returns what the server answered (a job, a template) or null.
 * The server checks everything again: a dialog only helps to ask right.
 */
import { h, icon } from '../../core/dom.js';
import { request, getJson } from '../../core/api.js';
import { t } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { openDialog } from '../../shared/dialog.js';
import { codeText, stateText, kindText, fmtDate, benchApi, patchView } from './text.js';

// ── Pieces ──────────────────────────────────────────────────────────────────

/** Devices to tick: shared ones unticked by default; `extra(d)` adds a cell (people, "erase anyway") */
function deviceChecklist(devices, { extra = null, name = 'device' } = {}) {
  const boxes = new Map();
  const rows = devices.map((d) => {
    const box = h('input', { type: 'checkbox', name, value: d.key, checked: !d.shared });
    boxes.set(d.key, box);
    return h('li', { dataset: { device: d.name } },
      h('label.check', box, h('span', h('strong', d.name), d.shared ? h('small.jobs-tag', t('jobs.devices.shared')) : null)),
      extra ? extra(d) : null);
  });
  const all = h('button.btn.small.subtle', { type: 'button', onclick: () => { const on = [...boxes.values()].some((b) => !b.checked); for (const b of boxes.values()) b.checked = on; } }, t('jobs.devices.toggleAll'));
  return {
    el: h('fieldset.jobs-devices', h('legend', t('jobs.devices.legend'), ' ', all), h('ul', rows)),
    selected: () => [...boxes].filter(([, b]) => b.checked).map(([k]) => k),
    tick: (key, on) => { if (boxes.has(key)) boxes.get(key).checked = on; },
  };
}

/** Enable secret and console line password: asked now, kept in memory by the job, never stored */
function passwordFields() {
  const enable = h('input.field', { type: 'password', autocomplete: 'off', name: 'enable', maxlength: 64 });
  const line = h('input.field', { type: 'password', autocomplete: 'off', name: 'line', maxlength: 64 });
  return {
    el: h('details.jobs-passwords', h('summary', t('jobs.passwords.title')),
      h('p.muted', t('jobs.passwords.hint')),
      h('label', h('span', t('jobs.passwords.enable')), enable),
      h('label', h('span', t('jobs.passwords.line')), line)),
    values: () => ({ enablePasswords: enable.value ? [enable.value] : [], linePasswords: line.value ? [line.value] : [] }),
  };
}

/** A dialog made of a form: `build(form)` fills it, `submit()` returns the result or throws a message */
function formShell({ title, wide = true, danger = false, submitLabel, body, submit, canSubmit = () => true }) {
  const error = h('p.form-error', { role: 'alert' });
  const go = h(`button.btn.${danger ? 'danger-solid' : 'primary'}`, { type: 'submit', dataset: { action: 'confirm' } }, submitLabel);
  const cancel = h('button.btn', { type: 'button', dataset: { action: 'cancel' }, onclick: () => dlg.close(null) }, t('common.actions.cancel'));
  const actions = h('div.form-actions', cancel, go);
  const form = h('form.modal-body.form-grid.jobs-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!canSubmit()) return;
      go.disabled = true;
      error.textContent = '';
      try {
        const result = await submit();
        if (result !== undefined) dlg.close(result);
      } catch (err) {
        error.textContent = err.code ? codeText(err.code, err.params, err.message) : err.message;
      } finally {
        go.disabled = !canSubmit();
      }
    },
  }, body, error, actions);
  const dlg = openDialog(form, { title, wide, role: danger ? 'alertdialog' : undefined });
  return { dlg, form, go, actions, error };
}

// ── Backup ──────────────────────────────────────────────────────────────────

export async function backupDialog(bench, detail) {
  const devices = deviceChecklist(detail.devices);
  const label = h('input.field', { type: 'text', name: 'label', maxlength: 80, placeholder: t('jobs.backup.labelPlaceholder') });
  const pw = passwordFields();
  const { dlg } = formShell({
    title: t('jobs.backup.title', { bench }),
    submitLabel: t('jobs.backup.go'),
    body: [h('p.dialog-text', t('jobs.backup.intro')), devices.el, h('label', h('span', t('jobs.backup.label')), label), pw.el],
    submit: async () => (await request('POST', benchApi(bench, '/backup'), { devices: devices.selected(), label: label.value, ...pw.values() })).job,
  });
  return dlg.closed;
}

// ── Reset ───────────────────────────────────────────────────────────────────

export async function resetDialog(bench, detail) {
  const force = new Map();
  const devices = deviceChecklist(detail.devices, {
    extra: (d) => h('span.jobs-device-extra',
      d.people.length ? h('span.jobs-people', icon('team'), d.people.join(', ')) : h('span.muted', t('jobs.reset.nobody')),
      session.isAdmin ? h('label.check.jobs-force', (() => { const b = h('input', { type: 'checkbox', value: d.key }); force.set(d.key, b); return b; })(), h('small', t('jobs.reset.force'))) : null),
  });
  const base = detail.base ? h('input', { type: 'checkbox', name: 'base', checked: true }) : null;
  const pw = passwordFields();
  const typed = h('input.field', { type: 'text', autocomplete: 'off', spellcheck: 'false', name: 'confirm' });
  const erased = h('ul.jobs-erased', ['backup', 'startup', 'vlan', 'register', 'reload', 'refuse'].map((k) => h('li', t(`jobs.reset.erased.${k}`))));
  const { dlg, go } = formShell({
    title: t('jobs.reset.title', { bench }),
    danger: true,
    submitLabel: t('jobs.reset.go'),
    body: [
      h('p.dialog-text', t('jobs.reset.intro')), erased, devices.el,
      base ? h('label.check', base, h('span', t('jobs.reset.base', { name: detail.base.name }))) : null,
      pw.el,
      h('label.require-text', h('span', t('jobs.reset.typeBench', { bench })), typed),
      h('p.muted', t('jobs.reset.countdown', { count: detail.countdownSeconds ?? 10 })),
    ],
    canSubmit: () => typed.value.trim() === bench,
    submit: async () => (await request('POST', benchApi(bench, '/reset'), {
      devices: devices.selected(),
      confirm: typed.value.trim(),
      applyBase: base ? base.checked : false,
      forceErase: [...force].filter(([, b]) => b.checked).map(([k]) => k),
      ...pw.values(),
    })).job,
  });
  const sync = () => { go.disabled = typed.value.trim() !== bench; };
  typed.addEventListener('input', sync);
  sync();
  return dlg.closed;
}

// ── Injection: choose, preview, send ─────────────────────────────────────────

export async function injectDialog(bench, detail, { snapshots, templates, preset = null }) {
  const source = h('select.field', { name: 'source' },
    snapshots.length ? h('optgroup', { label: t('jobs.inject.snapshots') }, snapshots.map((s) => h('option', { value: `snapshot:${s.id}`, selected: preset === s.id }, `${fmtDate(s.createdAt)} · ${s.bench} · ${s.label || t(`jobs.origin.${s.origin}`)}`))) : null,
    templates.length ? h('optgroup', { label: t('jobs.inject.templates') }, templates.map((x) => h('option', { value: `template:${x.id}`, selected: preset === x.id }, x.name))) : null);
  const mode = h('select.field', { name: 'mode' }, h('option', { value: 'reset' }, t('jobs.inject.modeReset')), h('option', { value: 'merge' }, t('jobs.inject.modeMerge')));
  const save = h('input', { type: 'checkbox', name: 'save', checked: true });
  const rsa = h('select.field', { name: 'rsa' }, h('option', { value: '' }, t('jobs.inject.rsaNone')), [1024, 2048].map((n) => h('option', { value: String(n) }, t('jobs.inject.rsaBits', { n }))));
  const devices = deviceChecklist(detail.devices);
  // Tick what the source holds: a snapshot's devices, a template's (or every unshared device for a '*' entry)
  const tickSource = () => {
    const [kind, id] = source.value.split(':');
    const set = kind === 'snapshot' ? snapshots.find((s) => s.id === id) : templates.find((x) => x.id === id);
    const names = new Set((set?.devices ?? []).map((d) => d.device));
    for (const d of detail.devices) devices.tick(d.key, !d.shared && (names.has(d.name) || names.has('*')));
  };
  source.addEventListener('change', tickSource);
  tickSource();
  const pw = passwordFields();
  const typed = h('input.field', { type: 'text', autocomplete: 'off', spellcheck: 'false', name: 'confirm' });
  const typedRow = h('label.require-text', h('span', t('jobs.reset.typeBench', { bench })), typed);
  const previewBox = h('div.jobs-preview', { hidden: true });
  const choose = h('div.jobs-choose',
    h('label', h('span', t('jobs.inject.source')), source),
    h('label', h('span', t('jobs.inject.mode')), mode),
    h('label.check', save, h('span', t('jobs.inject.save'))),
    h('label', h('span', t('jobs.inject.rsa')), rsa),
    devices.el);
  let preview = null;

  const body = () => {
    const [kind, id] = source.value.split(':');
    return { source: { [kind]: id }, devices: devices.selected(), rsaModulus: rsa.value ? Number(rsa.value) : null };
  };

  const shell = formShell({
    title: t('jobs.inject.title', { bench }),
    submitLabel: t('jobs.inject.preview'),
    body: [h('p.dialog-text', t('jobs.inject.intro')), choose, previewBox],
    canSubmit: () => !preview || mode.value === 'merge' || typed.value.trim() === bench,
    submit: async () => {
      if (!preview) {
        preview = await request('POST', benchApi(bench, '/preview'), body());
        showPreview();
        return undefined; // stay open: the preview is the next step
      }
      const scripts = Object.fromEntries(preview.devices.map((d) => [d.key, d.sha256]));
      return (await request('POST', benchApi(bench, '/inject'), {
        ...body(), devices: preview.devices.map((d) => d.key), scripts, mode: mode.value, save: save.checked, confirm: typed.value.trim(), ...pw.values(),
      })).job;
    },
  });

  function showPreview() {
    choose.hidden = true;
    previewBox.hidden = false;
    const back = h('button.btn.subtle', { type: 'button', onclick: () => { preview = null; choose.hidden = false; previewBox.hidden = true; shell.go.textContent = t('jobs.inject.preview'); shell.go.classList.replace('danger-solid', 'primary'); } }, icon('chevronLeft'), t('jobs.inject.back'));
    previewBox.replaceChildren(
      back,
      h('p.dialog-text', t(mode.value === 'reset' ? 'jobs.inject.previewReset' : 'jobs.inject.previewMerge', { source: preview.source.name })),
      preview.missing.length ? h('p.form-error', t('jobs.inject.missing', { devices: preview.missing.map((m) => m.name).join(', ') })) : null,
      h('div.jobs-scripts', preview.devices.map((d) => h('details.jobs-script', { dataset: { device: d.name } },
        h('summary', h('strong', d.name), ' ← ', d.from, ' · ', t('jobs.inject.lines', { count: d.lines }), d.dropped.length ? ` · ${t('jobs.inject.dropped', { count: d.dropped.length })}` : ''),
        d.dropped.length ? h('ul.jobs-dropped', d.dropped.map((x) => h('li', h('code', x.text), ' — ', t(`jobs.dropped.${x.code}`)))) : null,
        h('pre.jobs-code', d.script)))),
      pw.el,
      mode.value === 'reset' ? typedRow : null);
    shell.go.textContent = t('jobs.inject.go', { count: preview.devices.length });
    shell.go.disabled = !preview.devices.length;
    if (mode.value === 'reset') {
      shell.go.classList.replace('primary', 'danger-solid');
      const sync = () => { shell.go.disabled = typed.value.trim() !== bench || !preview?.devices.length; };
      typed.oninput = sync;
      sync();
    }
  }
  return shell.dlg.closed;
}

// ── Comparison with the live devices ───────────────────────────────────────

export async function compareDialog(bench, detail, { snapshots, preset = null }) {
  const source = h('select.field', { name: 'snapshot' }, snapshots.map((s) => h('option', { value: s.id, selected: preset === s.id }, `${fmtDate(s.createdAt)} · ${s.bench} · ${s.label || t(`jobs.origin.${s.origin}`)}`)));
  const devices = deviceChecklist(detail.devices);
  const pw = passwordFields();
  const { dlg } = formShell({
    title: t('jobs.compare.title', { bench }),
    submitLabel: t('jobs.compare.go'),
    body: [h('p.dialog-text', t('jobs.compare.intro')), h('label', h('span', t('jobs.compare.snapshot')), source), devices.el, pw.el],
    submit: async () => (await request('POST', benchApi(bench, '/compare'), { snapshot: source.value, devices: devices.selected(), ...pw.values() })).job,
  });
  return dlg.closed;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** A snapshot (or a template: `kind`), device by device */
export async function viewSetDialog(set, { kind = 'snapshots' } = {}) {
  const pick = h('select.field', set.devices.map((d) => h('option', { value: d.device }, d.device)));
  const facts = h('p.muted.jobs-facts');
  const code = h('pre.jobs-code', { tabindex: 0 });
  async function show() {
    const d = await getJson(`/api/jobs/${kind}/${encodeURIComponent(set.id)}/devices/${encodeURIComponent(pick.value)}`).catch((err) => ({ config: codeText(err.code, err.params, err.message) }));
    const f = d.facts ?? {};
    facts.textContent = [f.model, f.version, f.configRegister ? t('jobs.view.register', { value: f.configRegister }) : null, d.intact === false ? t('jobs.view.damaged') : null].filter(Boolean).join(' · ');
    code.textContent = d.config ?? '';
  }
  pick.addEventListener('change', show);
  const dlg = openDialog(h('div.modal-body.jobs-view', h('label', h('span', t('jobs.view.device')), pick), facts, code), { title: set.name ?? `${set.bench} · ${set.label || fmtDate(set.createdAt)}`, wide: true });
  await show();
  return dlg.closed;
}

export async function diffDialog(a, snapshots) {
  const others = snapshots.filter((s) => s.id !== a.id);
  const pick = h('select.field', others.map((s) => h('option', { value: s.id }, `${fmtDate(s.createdAt)} · ${s.bench} · ${s.label || t(`jobs.origin.${s.origin}`)}`)));
  const out = h('div.jobs-diff');
  async function show() {
    if (!pick.value) { out.replaceChildren(h('p.muted', t('jobs.diff.none'))); return; }
    const r = await getJson(`/api/jobs/snapshots/${encodeURIComponent(a.id)}/diff/${encodeURIComponent(pick.value)}`).catch(() => null);
    if (!r) return;
    out.replaceChildren(...r.devices.map((d) => h('section.jobs-diff-device', { dataset: { device: d.device, status: d.status } },
      h('h3', d.device, ' ', h('small', t(`jobs.diff.${d.status === 'only-a' ? 'onlyA' : d.status === 'only-b' ? 'onlyB' : d.status}`, { added: d.added, removed: d.removed }))),
      d.patch ? patchView(d.patch) : null)));
  }
  pick.addEventListener('change', show);
  const dlg = openDialog(h('div.modal-body', h('label', h('span', t('jobs.diff.with')), pick), out), { title: t('jobs.diff.title', { a: a.label || fmtDate(a.createdAt) }), wide: true });
  await show();
  return dlg.closed;
}

/** A job's report: every device, its outcome, and what the device printed when it stopped */
export function reportDialog(job) {
  const rows = job.devices.map((d) => {
    const r = d.result ?? {};
    const lines = [];
    if (d.state === 'failed' || d.state === 'skipped') lines.push(codeText(d.code, d.params, d.message ?? ''));
    if (d.state === 'cancelled') lines.push(t('jobs.report.cancelledAt', { stage: d.stage ?? '—' }));
    if (r.register) lines.push(t('jobs.report.register', { value: r.register }));
    if (r.vlanDat && r.vlanDat !== 'n/a') lines.push(t(`jobs.report.vlanDat.${r.vlanDat}`));
    if (r.base) lines.push(t('jobs.report.base', { name: r.base.name, count: r.base.errors.length }));
    if (Array.isArray(r.errors) && r.errors.length) lines.push(t('jobs.report.errors', { count: r.errors.length }));
    if (r.saved === true) lines.push(t('jobs.report.saved'));
    if (r.check) lines.push(t(`jobs.report.check.${r.check.status === 'same' ? 'same' : 'changed'}`, { added: r.check.added ?? 0, removed: r.check.removed ?? 0 }));
    for (const w of r.warnings ?? []) lines.push(t(`jobs.report.warning.${w}`));
    return h('li.jobs-report-device', { dataset: { device: d.name, state: d.state } },
      h('div.jobs-report-head', h('strong', d.name), h('span.jobs-state', { dataset: { state: d.state } }, stateText(d.state))),
      lines.length ? h('ul', lines.map((l) => h('li', l))) : null,
      r.errors?.length ? h('details', h('summary', t('jobs.report.errorLines')), h('pre.jobs-code', r.errors.map((e) => `${e.line}: ${e.command}\n  ${e.message}`).join('\n'))) : null,
      r.check?.patch ? h('details', h('summary', t('jobs.report.diff')), patchView(r.check.patch)) : null,
      r.check?.missing?.length ? h('details', h('summary', t('jobs.report.missing')), h('pre.jobs-code', r.check.missing.join('\n'))) : null,
      d.lastOutput ? h('details', h('summary', t('jobs.report.output')), h('pre.jobs-code', d.lastOutput)) : null);
  });
  return openDialog(h('div.modal-body.jobs-report', h('p.muted', t('jobs.report.by', { name: job.actor.name, date: fmtDate(job.createdAt), state: stateText(job.state) })), h('ul.jobs-report-list', rows)),
    { title: t('jobs.report.title', { kind: kindText(job.kind), bench: job.bench }), wide: true }).closed;
}

// ── Templates (admins) ──────────────────────────────────────────────────────

export async function templateDialog({ snapshot = null } = {}) {
  const name = h('input.field', { type: 'text', name: 'name', required: true, maxlength: 80 });
  const description = h('input.field', { type: 'text', name: 'description', maxlength: 500 });
  const config = snapshot ? null : h('textarea.field.jobs-code', { name: 'config', rows: 10, spellcheck: 'false', placeholder: t('jobs.templates.configPlaceholder') });
  const base = h('input', { type: 'checkbox', name: 'base' });
  const { dlg } = formShell({
    title: snapshot ? t('jobs.templates.fromSnapshot') : t('jobs.templates.new'),
    submitLabel: t('jobs.templates.publish'),
    body: [
      h('p.dialog-text', snapshot ? t('jobs.templates.fromSnapshotIntro', { devices: snapshot.devices.map((d) => d.device).join(', ') }) : t('jobs.templates.newIntro')),
      h('label', h('span', t('jobs.templates.name')), name),
      h('label', h('span', t('jobs.templates.description')), description),
      config ? h('label', h('span', t('jobs.templates.config')), config) : null,
      h('label.check', base, h('span', t('jobs.templates.base'))),
    ],
    submit: async () => (await request('POST', '/api/jobs/templates', {
      name: name.value, description: description.value, base: base.checked,
      ...(snapshot ? { snapshot: snapshot.id } : { configs: { '*': config.value } }),
    })).template,
  });
  return dlg.closed;
}

