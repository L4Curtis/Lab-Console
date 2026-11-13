/**
 * The shared note of a device (SPEC "Lot collab"): what every screen needs
 * to know about notes, the badge they put on the diagram, and the dialog
 * that shows or edits one
 *
 *   noteOf(deviceKey)         the note, or null
 *   onNotes(fn)               called after every change; returns the function that stops
 *   knowDevices(labs)         the consoles section tells which device belongs to which bench
 *   mayEdit(bench)            the occupants of the bench and admins (the server decides again)
 *   openNoteDialog(deviceKey) read it, or write it when the person may
 *
 * The list is read once, then followed over the SSE topic 'collab:note'. A
 * save names the revision it started from: when someone saved first, the
 * dialog says so and offers their version instead of overwriting it
 */
import { h, toast } from '../../core/dom.js';
import { request, getJson, live } from '../../core/api.js';
import { t, getLocale } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { openDialog } from '../../shared/dialog.js';
import { registerDiagramLayer, refreshDiagram } from '../../shared/diagramLayers.js';
import { registerPaneAction } from '../../shared/paneActions.js';
import { benchSummary, isOccupant, onBenches } from '../teams/data.js';

const TOOLTIP_LINES = 3;
const TOOLTIP_WIDTH = 70;

const notes = new Map();   // device key → note
const devices = new Map(); // device key → { bench, name }
const listeners = new Set();
let maxChars = 2000;

const changed = () => {
  refreshDiagram();
  for (const fn of listeners) fn();
};

export const noteOf = (key) => notes.get(key) ?? null;
export const allNotes = () => [...notes.values()];

export function onNotes(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function knowDevices(labs) {
  for (const lab of labs) for (const d of lab.devices) devices.set(d.key, { bench: lab.name, name: d.name });
}

export const mayEdit = (bench) => session.isAdmin || isOccupant(benchSummary(bench));

const when = (iso) => new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const clip = (line) => (line.length > TOOLTIP_WIDTH ? `${line.slice(0, TOOLTIP_WIDTH - 1)}…` : line);

/** Read the list again (at start-up, and after a conflict); a failure leaves what we have */
export async function loadNotes() {
  try {
    const data = await getJson('/api/collab/notes');
    notes.clear();
    for (const n of data.notes) notes.set(n.key, n);
    maxChars = data.limits?.maxChars ?? maxChars;
    changed();
  } catch (err) {
    console.warn(`[collab] notes could not be read: ${err.message}`);
  }
}

export function startNotes() {
  live.on('collab:note', (n) => {
    if (n.removed) notes.delete(n.key);
    else notes.set(n.key, n);
    changed();
  });
  onBenches(() => listeners.forEach((fn) => fn())); // who may edit changed
  // On the diagram: a badge on a device that has a note, and its first lines in the tooltip
  registerDiagramLayer('notes', (device) => {
    const note = notes.get(device.key);
    if (!note) return null;
    const lines = note.text.split('\n').slice(0, TOOLTIP_LINES).map(clip);
    if (note.text.split('\n').length > TOOLTIP_LINES) lines[lines.length - 1] += ' …';
    return {
      badges: [{ text: t('collab.notes.badge'), kind: 'note', title: t('collab.notes.badgeTitle', { name: note.by.name }) }],
      tooltip: [t('collab.notes.tooltipHead', { name: note.by.name, time: when(note.updatedAt) }), ...lines],
    };
  });
  // On a console tile
  registerPaneAction({
    id: 'note', icon: 'note', title: 'collab.notes.action', order: 40,
    when: (s) => s.kind === 'console' && typeof s.device === 'string' && !s.device.startsWith('admin:'),
    run: (pane) => openNoteDialog(pane.session.device),
  });
  return loadNotes();
}

/** Show the note of a device, in a dialog where the people allowed to write it can */
export function openNoteDialog(key) {
  const info = devices.get(key) ?? { bench: '', name: key };
  const editable = mayEdit(info.bench);
  let rev = noteOf(key)?.rev ?? 0;
  const note = noteOf(key);

  const meta = h('p.note-meta.muted');
  const writeMeta = (n) => { meta.textContent = n ? t('collab.notes.lastBy', { name: n.by.name, time: when(n.updatedAt) }) : t('collab.notes.none'); };
  writeMeta(note);
  const problem = h('p.note-problem', { role: 'alert', hidden: true });
  const theirs = h('button.btn.small', { type: 'button', hidden: true }, t('collab.notes.showTheirs'));

  let body;
  let save = null;
  if (editable) {
    const area = h('textarea.note-text-input', { rows: 8, maxlength: String(maxChars), 'aria-label': t('collab.notes.field', { device: info.name }), placeholder: t('collab.notes.placeholder') });
    area.value = note?.text ?? '';
    const count = h('span.note-count.muted');
    const writeCount = () => { count.textContent = t('collab.notes.count', { count: [...area.value].length, max: maxChars }); };
    area.addEventListener('input', writeCount);
    writeCount();
    save = h('button.btn.primary', { type: 'submit', dataset: { action: 'save' } }, t('collab.notes.save'));
    const cancel = h('button.btn', { type: 'button', onclick: () => dlg.close(false) }, t('common.actions.cancel'));
    const form = h('form.note-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        problem.hidden = true;
        theirs.hidden = true;
        try {
          await request('PUT', `/api/collab/notes/${encodeURIComponent(key)}`, { text: area.value, rev });
          dlg.close(true);
        } catch (err) {
          problem.textContent = err.message;
          problem.hidden = false;
          if (err.code === 'collab.note_conflict') {
            // Someone saved first: keep what was typed, offer their version
            await loadNotes();
            const latest = noteOf(key);
            rev = latest?.rev ?? 0;
            writeMeta(latest);
            theirs.hidden = false;
            theirs.onclick = () => { area.value = latest?.text ?? ''; writeCount(); theirs.hidden = true; problem.hidden = true; area.focus(); };
          }
        } finally {
          save.disabled = false;
        }
      },
    }, area, h('div.note-foot', count, h('span.note-hint.muted', t('collab.notes.emptyDeletes'))), problem, h('div.modal-actions', theirs, cancel, save));
    body = form;
  } else {
    body = h('div.note-read',
      note ? h('p.note-text', note.text) : h('p.muted', t('collab.notes.none')),
      h('p.muted', t('collab.notes.readOnly')));
  }
  const dlg = openDialog(h('div.modal-body.note-dialog', { dataset: { device: key } }, meta, body), {
    title: t('collab.notes.title', { device: info.name, bench: info.bench }),
    initialFocus: editable ? '.note-text-input' : undefined,
  });
  dlg.closed.then((saved) => { if (saved) toast(t('collab.notes.saved'), 'info', 2500); });
  return dlg;
}
