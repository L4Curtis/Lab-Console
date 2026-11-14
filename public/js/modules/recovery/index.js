/**
 * The password recovery assistant in the browser (SPEC "Lot recovery"),
 * started once by main.js:
 *
 *   - a "Password recovery" button on every lab console tile (not on admin
 *     switches) opens the assistant of that device;
 *   - a badge on the diagram on a device being recovered, with who does it.
 *
 * The assistant is a dialog. Before a recovery: what it does, the family of
 * the device to choose, Start (or why this person may not). During one: the
 * steps of the family, the one waiting for the person with what to do on
 * site and the button that confirms it (only for the person who started it),
 * what the device is doing now, Stop. At the end: a clean prompt and the way
 * to the Backups section, or why it stopped and the end of the console
 * output. Closing the dialog never stops a recovery: it runs on the server,
 * and opening the assistant of the device again shows it where it is.
 *
 * Followed over the SSE topics 'recovery:run' (a recovery, to those who may
 * follow it) and 'recovery:running' (sticky: which devices are being
 * recovered). The server decides every permission again
 */
import { h, icon, loadCss } from '../../core/dom.js';
import { request, live } from '../../core/api.js';
import { t, tError, has, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { openDialog, confirmDialog } from '../../shared/dialog.js';
import { serverText } from '../../shared/serverText.js';
import { registerPaneAction } from '../../shared/paneActions.js';
import { registerDiagramLayer, refreshDiagram } from '../../shared/diagramLayers.js';

const FINAL = new Set(['done', 'failed', 'cancelled']);
let running = [];                 // 'recovery:running': [{ id, bench, device: { key, name }, state, awaiting, current, actor }]
const followers = new Set();      // open dialogs: fn(recovery)

export async function startRecovery() {
  await Promise.all([loadNamespace('recovery'), loadCss('recovery')]);
  live.on('recovery:run', (rec) => { for (const fn of followers) fn(rec); });
  live.on('recovery:running', (list) => {
    running = Array.isArray(list) ? list : [];
    refreshDiagram();
  });
  registerDiagramLayer('recovery', (device) => {
    const r = running.find((x) => x.device?.key === device.key);
    if (!r) return null;
    return {
      ring: 'recovery',
      badges: [{ text: t('recovery.badge'), kind: 'recovery', title: t('recovery.byOther', { name: r.actor?.name ?? '' }) }],
      tooltip: [t('recovery.byOther', { name: r.actor?.name ?? '' })],
    };
  });
  registerPaneAction({
    id: 'recovery', icon: 'key', title: 'recovery.action', order: 70,
    when: (s) => s.kind === 'console' && typeof s.device === 'string' && !s.device.startsWith('admin:'),
    run: (pane) => openRecoveryDialog(pane.session.device),
  });
}

/** A server code in the user's language: recovery.* here, consoles.* and automation.* as the terminal says them */
function codeText(code, params = {}, fallback = '') {
  if (!code) return fallback;
  const [mod] = String(code).split('.');
  if (mod === 'consoles' || mod === 'automation') return serverText({ code, params, message: fallback || code });
  return tError(code, params, fallback || code);
}

/** recovery.progress.<name>, the driver's account of what the device is doing */
function progressText(p) {
  const name = String(p?.code ?? '').replace(/^recovery\.progress\./, '');
  return name && has(`recovery.progress.${name}`) ? t(`recovery.progress.${name}`, p.params ?? {}) : '';
}
const stateText = (rec) => (rec.state === 'cancelled' ? t('recovery.state.cancelled', { name: rec.cancelledBy?.name ?? '' }) : t(`recovery.state.${rec.state}`));

/**
 * The assistant of one device (its registry key). Returns the dialog
 * ({ el, close, closed })
 */
export function openRecoveryDialog(key) {
  let info = null;     // GET /api/recovery/devices/:key
  let rec = null;      // the recovery shown
  let busy = false;    // a request on its way: its button stays disabled
  let problem = null;  // the last refused request, translated

  const content = h('div.modal-body.recovery-dialog', { dataset: { device: key } }, h('p.muted', t('recovery.loading')));
  const dlg = openDialog(content, { title: t('recovery.action'), wide: true });
  const heading = dlg.el.querySelector('.modal-head h2');

  const follow = (r) => {
    if (r?.id && rec?.id === r.id) { rec = r; render(); }
    else if (r?.id && !rec && r.device?.key === key) { rec = r; render(); }
  };
  followers.add(follow);
  dlg.closed.then(() => followers.delete(follow));

  async function load() {
    try {
      info = await request('GET', `/api/recovery/devices/${encodeURIComponent(key)}`);
      // The recovery under way, when this person may follow it; else the one this dialog showed
      if (info.running?.steps) rec = info.running;
      problem = null;
    } catch (err) {
      problem = codeText(err.code, err.params, err.message);
    }
    render();
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    problem = null;
    render();
    try {
      const res = await fn();
      if (res?.recovery) rec = res.recovery;
    } catch (err) {
      problem = codeText(err.code, err.params, err.message);
    } finally {
      busy = false;
      render();
    }
  }

  const start = (family) => act(() => request('POST', `/api/recovery/devices/${encodeURIComponent(key)}/start`, { family }));
  const confirmStep = (step) => act(() => request('POST', `/api/recovery/runs/${encodeURIComponent(rec.id)}/confirm`, { step }));
  async function stop() {
    const ok = await confirmDialog({ title: t('recovery.stop'), body: t('recovery.stopConfirm', { device: rec.device.name }), confirmLabel: t('recovery.stop'), danger: true });
    if (ok) await act(() => request('POST', `/api/recovery/runs/${encodeURIComponent(rec.id)}/cancel`));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const deviceName = () => rec?.device?.name ?? info?.device?.name ?? key;
  const familyOf = (id) => info?.families?.find((f) => f.id === id) ?? null;

  function render() {
    if (heading) heading.textContent = t('recovery.title', { device: deviceName() });
    const parts = [];
    if (!info && !rec) parts.push(h('p.muted', problem ? '' : t('recovery.loading')));
    else if (rec?.steps) parts.push(...runView());
    else if (info?.running) parts.push(h('p.recovery-other', icon('lock'), t('recovery.byOther', { name: info.running.actor?.name ?? '' })));
    else parts.push(...startView());
    if (problem) parts.push(h('p.recovery-problem', { role: 'alert' }, problem));
    parts.push(h('div.modal-actions', h('button.btn', { type: 'button', dataset: { action: 'close' }, onclick: () => dlg.close() },
      rec && !FINAL.has(rec.state) ? t('recovery.close') : t('common.actions.close'))));
    content.replaceChildren(...parts);
  }

  function startView() {
    const families = info.families ?? [];
    const select = h('select.field', { name: 'family', 'aria-label': t('recovery.family') },
      families.map((f) => h('option', { value: f.id }, f.verified ? t(`recovery.families.${f.id}`) : `${t(`recovery.families.${f.id}`)} (${t('recovery.unverified')})`)));
    const go = h('button.btn.primary', { type: 'submit', dataset: { action: 'start' }, disabled: busy || !info.canStart }, icon('play'), t('recovery.start'));
    return [
      h('p.recovery-intro', t('recovery.intro')),
      info.canStart ? null : h('p.recovery-problem', { role: 'status' }, t('recovery.cannotStart', { reason: codeText(info.refusal?.code, info.refusal?.params, '') })),
      h('form.recovery-start', { onsubmit: (e) => { e.preventDefault(); start(select.value); } },
        h('label.field-label', h('span', t('recovery.family')), select), go),
    ];
  }

  function runView() {
    const mine = rec.actor?.id === session.user?.id;
    const final = FINAL.has(rec.state);
    const out = [h('p.recovery-head',
      h('span.recovery-state', { dataset: { state: rec.state } }, stateText(rec)), ' ',
      h('span.muted', t(`recovery.families.${rec.family}`)))];
    out.push(h('ol.recovery-steps', rec.steps.map((s) => stepItem(s, mine))));
    if (rec.state === 'done') {
      const host = [...rec.steps].reverse().find((s) => s.result?.host)?.result.host ?? 'Router';
      out.push(h('section.recovery-end', { dataset: { end: 'done' } },
        h('h3', t('recovery.doneTitle', { device: deviceName(), host })),
        h('p', t('recovery.doneText')),
        h('a.btn.primary', { href: `#/jobs/${encodeURIComponent(rec.bench)}`, dataset: { action: 'jobs' }, onclick: () => dlg.close() }, icon('archive'), t('recovery.toJobs'))));
    } else if (final) {
      const err = rec.error ?? { code: rec.code };
      out.push(h('section.recovery-end', { dataset: { end: rec.state } },
        h('h3', rec.state === 'cancelled' ? t('recovery.cancelledTitle') : t('recovery.failedTitle')),
        h('p.recovery-error', codeText(err.code, err.params, err.message ?? '')),
        rec.state === 'failed' ? h('p.muted', t('recovery.failedHint')) : null,
        err.lastOutput ? lastOutput(err.lastOutput) : null));
    } else {
      out.push(h('div.recovery-run-actions',
        h('button.btn.danger', { type: 'button', dataset: { action: 'stop' }, disabled: busy, onclick: stop }, icon('stop'), t('recovery.stop'))));
    }
    return out;
  }

  function stepItem(s, mine) {
    const waiting = rec.state === 'awaiting' && rec.awaiting === s.id;
    const doing = rec.current === s.id;
    const state = waiting ? 'awaiting' : s.state;
    const title = h('span.recovery-step-title', t(`recovery.steps.${s.id}.title`));
    const item = h('li', { dataset: { step: s.id, state } }, title, ' ',
      h('span.recovery-state', { dataset: { state } }, t(`recovery.state.${state}`)),
      s.tries > 1 ? h('small.muted', ` · ${t('recovery.attempt', { n: s.tries })}`) : null);
    if (waiting || doing) item.append(h('p.recovery-what', whatText(s.id)));
    if (doing && rec.progress) item.append(h('p.recovery-progress', { role: 'status' }, progressText(rec.progress)));
    // A step that failed in a way the person can fix waits for them again
    if (waiting && rec.error?.step === s.id && rec.error.retry) {
      item.append(h('p.recovery-problem', codeText(rec.error.code, rec.error.params, rec.error.message ?? '')), h('p.muted', t('recovery.retry')));
      if (rec.error.lastOutput) item.append(lastOutput(rec.error.lastOutput));
    }
    if (waiting) {
      if (mine) {
        const handsOn = familyOf(rec.family)?.handsOn?.includes(s.id) ?? s.id === 'power_cycle';
        item.append(h('button.btn.primary', { type: 'button', dataset: { action: 'confirm', step: s.id }, disabled: busy, onclick: () => confirmStep(s.id) },
          icon(handsOn ? 'power' : 'check'), handsOn ? t('recovery.ready') : t('recovery.confirm')));
      } else {
        item.append(h('p.muted', t('recovery.notYours', { name: rec.actor?.name ?? '' })));
      }
    }
    return item;
  }

  /** What a step does, or what the person does for it */
  function whatText(id) {
    if (id !== 'power_cycle') return t(`recovery.steps.${id}.doing`);
    if (rec.current === 'power_cycle' && rec.progress?.code === 'recovery.progress.power_now') return t('recovery.steps.power_cycle.now');
    const kind = familyOf(rec.family)?.kind ?? (/^(isr)/.test(rec.family) ? 'router' : 'switch');
    return kind === 'router' ? t('recovery.steps.power_cycle.router') : t('recovery.steps.power_cycle.switch');
  }

  const lastOutput = (text) => h('details.recovery-output', h('summary', t('recovery.lastOutput')), h('pre', text));

  render();
  load();
  return dlg;
}
