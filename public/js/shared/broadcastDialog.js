/**
 * "Send to several consoles": the same lines, one after the other, on every
 * console the person ticks - and only the consoles where they hold the
 * keyboard can be ticked. Each console then answers for itself (done, done
 * with device errors, refused, stopped), in a list that follows the progress.
 *
 * The browser sends the request on the socket of each ticked console; each
 * room decides for itself whether this person is its pilot (a console they
 * watch refuses, whatever this dialog shows) and paces the lines like an
 * injection (src/lib/automationProtocol.js, the `broadcast` message). The
 * answers come back on the same sockets, tagged with this request's `batch`,
 * and are also shown in each tile's own task bar
 */
import { h, icon, prefs, toast, loadCss } from '../core/dom.js';
import { t, tNode, tAttr, loadNamespace, onLocaleChange } from '../core/i18n.js';
import { openDialog } from './dialog.js';
import { serverText } from './serverText.js';
import { openScriptLibrary } from './scriptLibrary.js';
import { workspace } from './workspace.js';

const MAX_LINES = 50;
const FINAL = new Set(['done', 'warning', 'error', 'cancelled', 'lost']);

/** The lines the server will see: the final line break is not a line */
function linesOf(text) {
  const clean = text.replace(/\r\n?/g, '\n');
  if (!clean.trim()) return [];
  const lines = clean.split('\n');
  if (clean.endsWith('\n')) lines.pop();
  return lines;
}

export async function openBroadcastDialog({ from }) {
  await Promise.all([loadNamespace('terminal', 'scripts'), loadCss('terminal')]);
  const saved = prefs.get('injectOptions', {});

  // ── What can be ticked ────────────────────────────────────────────────────
  const open = [...workspace.panes.values()].filter((p) => p.session.kind === 'console');
  // The console the person started from comes first
  const targets = [...open.filter((p) => p === from), ...open.filter((p) => p !== from)].map((pane) => ({
    pane,
    box: h('input', { type: 'checkbox', checked: pane.isPilot, disabled: !pane.isPilot }),
  }));
  const reason = (pane) => {
    if (pane.isPilot) return '';
    if (pane.state !== 'connected') return t('terminal.broadcast.reasonOffline');
    return t(pane.presenceBar?.presence?.task ? 'terminal.broadcast.reasonBusy' : 'terminal.broadcast.reasonNotPilot');
  };

  const textarea = h('textarea.field.script-input', {
    spellcheck: 'false', autocomplete: 'off', wrap: 'off', rows: 6, ...tAttr('aria-label', 'terminal.broadcast.commands'),
    placeholder: 'show ip interface brief\nshow vlan brief',
  });
  textarea.style.minHeight = '120px';
  const count = h('span.script-count');
  const hint = h('p.muted.script-hint');
  const stopOnError = h('input', { type: 'checkbox', checked: Boolean(saved.stopOnError) });
  const send = h('button.btn.primary', { type: 'submit', dataset: { action: 'send' } }, icon('broadcast'));
  const problem = h('p.form-error', { role: 'alert' });
  const library = h('button.btn.small', { type: 'button', dataset: { action: 'library' }, onclick: async () => {
    const script = await openScriptLibrary();
    if (!script) return;
    textarea.value = script.body;
    refresh();
    textarea.focus();
  } }, icon('library'), tNode('terminal.script.library'));

  const ticked = () => targets.filter((x) => x.box.checked && !x.box.disabled);
  const refresh = () => {
    const lines = linesOf(textarea.value);
    const n = ticked().length;
    count.textContent = t('terminal.script.count', { count: lines.length });
    hint.textContent = t('terminal.broadcast.hint', { max: MAX_LINES });
    problem.textContent = lines.length > MAX_LINES ? t('terminal.broadcast.tooMany', { max: MAX_LINES }) : '';
    send.disabled = !lines.length || lines.length > MAX_LINES || !n;
    send.replaceChildren(icon('broadcast'), t('terminal.broadcast.send', { count: n }));
  };
  textarea.addEventListener('input', refresh);
  for (const x of targets) x.box.addEventListener('change', refresh);
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });

  const targetRow = ({ pane, box }) => h('li', h('label.bc-target', { dataset: { allowed: String(pane.isPilot) } }, box,
    h('span.bc-name', h('strong', pane.session.title), h('span.muted', pane.session.subtitle || '')),
    h('small', reason(pane))));
  const targetList = h('ul.bc-targets');
  const drawTargets = () => targetList.replaceChildren(...targets.map(targetRow));

  const form = h('form.modal-body.script-form', { onsubmit: (e) => { e.preventDefault(); start(); } },
    h('p.muted.script-hint', tNode('terminal.broadcast.intro')),
    h('fieldset.script-options', h('legend', tNode('terminal.broadcast.consoles')), targetList),
    h('div.script-bar', library, count),
    textarea,
    hint,
    h('label.check.bc-option', stopOnError, h('span', tNode('terminal.script.stopOnError'))),
    problem,
    h('div.form-actions', h('button.btn', { type: 'button', onclick: () => dlg.close() }, tNode('common.actions.cancel')), send));

  const results = h('div.modal-body.bc-results', { hidden: true });
  const dlg = openDialog(h('div', form, results), { title: t('terminal.broadcast.title'), wide: true, initialFocus: textarea });
  drawTargets();
  refresh();

  // ── Sending, and following the answers ───────────────────────────────────
  let rows = null;
  const offs = [];

  function start() {
    const chosen = ticked();
    const script = textarea.value;
    const lines = linesOf(script);
    if (!chosen.length || !lines.length || lines.length > MAX_LINES) return;
    // The pacing is the server's (it waits for each prompt): the injection dialog's choices do not apply here
    const options = { stopOnError: stopOnError.checked, skipComments: true };
    prefs.set('injectOptions', { ...saved, stopOnError: stopOnError.checked });
    const batch = `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    rows = chosen.map(({ pane }) => ({ pane, state: 'waiting', last: null }));
    for (const row of rows) {
      offs.push(row.pane.onAutomation((m) => {
        if (m.task !== 'broadcast' || m.batch !== batch) return;
        row.last = m;
        row.state = m.state;
        draw();
      }));
      if (!row.pane.sendBroadcast({ batch, script, options })) row.state = 'lost';
    }
    form.hidden = true;
    results.hidden = false;
    draw();
    workspace.addEventListener('change', onWorkspace);
  }

  // A console whose line dropped while it was running will not answer any more
  function onWorkspace() {
    let changed = false;
    for (const row of rows ?? []) {
      if (!FINAL.has(row.state) && row.pane.state !== 'connected') { row.state = 'lost'; changed = true; }
    }
    if (changed) draw();
  }

  function rowText(row) {
    if (row.state === 'waiting') return t('terminal.broadcast.waiting');
    if (row.state === 'lost') return t('terminal.broadcast.lost');
    return serverText(row.last);
  }

  function draw() {
    if (!rows) return;
    const finished = rows.every((r) => FINAL.has(r.state));
    const clean = rows.filter((r) => r.state === 'done').length;
    const items = rows.map((row) => {
      const total = row.last?.total ?? row.last?.result?.total;
      const done = row.last?.done ?? row.last?.result?.sent;
      const errors = row.last?.result?.errors ?? [];
      return h('li.bc-result', { dataset: { state: row.state, console: row.pane.session.title } },
        h('span.bc-state', row.state === 'running' || row.state === 'waiting'
          ? h('span.spinner', { 'aria-hidden': 'true' })
          : icon(row.state === 'done' ? 'check' : row.state === 'cancelled' ? 'close' : 'warning')),
        h('div.bc-main',
          h('strong', row.pane.session.title, h('span.muted', ` ${row.pane.session.subtitle || ''}`)),
          h('span.bc-message', rowText(row)),
          row.state === 'running' && total ? h('span.task-progress', h('span.task-fill', { style: `width:${Math.round((100 * (done || 0)) / total)}%` })) : null,
          errors.length ? h('ul.bc-errors', errors.map((e) => h('li', h('code', t('terminal.task.line', { line: e.line })), h('span', e.command), h('em', e.message)))) : null));
    });
    results.replaceChildren(
      h('ul.bc-list', { role: 'status', 'aria-live': 'polite' }, items),
      h('p.bc-summary', finished ? t('terminal.broadcast.summary', { ok: clean, count: rows.length }) : t('terminal.broadcast.running')),
      h('div.form-actions',
        finished ? null : h('button.btn', { type: 'button', dataset: { action: 'stop' }, onclick: () => rows.filter((r) => !FINAL.has(r.state)).forEach((r) => r.pane.stopTask()) }, icon('stop'), tNode('terminal.broadcast.stopAll')),
        h('button.btn.primary', { type: 'button', dataset: { action: 'close' }, onclick: () => dlg.close() }, tNode('common.actions.close'))));
  }

  const offLocale = onLocaleChange(() => { drawTargets(); refresh(); draw(); });
  dlg.closed.then(() => {
    offLocale();
    workspace.removeEventListener('change', onWorkspace);
    for (const off of offs) off();
    // The consoles go on with their lines whether this window stays or not: their own bars show it
    if (rows && !rows.every((r) => FINAL.has(r.state))) toast(t('terminal.broadcast.goesOn'), 'info', 5000);
  });
}
