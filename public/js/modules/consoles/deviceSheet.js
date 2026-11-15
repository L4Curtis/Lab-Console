/**
 * The device sheet (UX.md §8.3): a long press on a device, in the diagram or
 * the list (a right click with a mouse). Its name, console address and state,
 * who is on it, its note, and what can be done: open the console, be told
 * when a busy line is free, read or write the note
 *
 *   openDeviceSheet(device, { bench, state, room, onOpen })
 */
import { h, icon, toast } from '../../core/dom.js';
import { request } from '../../core/api.js';
import { t, tNode } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';
import { avatar } from '../../shared/presenceBar.js';
import { errorText } from '../../shared/serverText.js';
import { fmtShort } from '../../core/format.js';
import { noteOf, mayEdit, openNoteDialog } from '../collab/notes.js';
import { deviceStateText } from './deviceList.js';

const TONE = { idle: 'success', open: 'info', live: 'info', busy: 'warning', disabled: 'neutral' };

export function openDeviceSheet(device, { bench, state, room, onOpen }) {
  const note = noteOf(device.key);
  const people = room?.users ?? [];
  let dlg = null;
  const act = (run) => async () => { dlg.close(); await dlg.closed; run(); };
  const notify = async () => {
    try {
      await request('POST', '/api/consoles/notify', { device: device.key });
      toast(t('terminal.pane.notifyArmed', { name: device.name }));
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  const body = h('div.modal-body.device-sheet', { dataset: { device: device.name } },
    h('p.device-sheet-line',
      h('code', `${device.target.host}:${device.target.port}`),
      h('span.badge', { dataset: { tone: TONE[state] ?? 'neutral' } }, h('span.dot'), deviceStateText(state, room))),
    people.length
      ? h('p.device-sheet-people', h('span.avatar-stack', people.slice(0, 5).map((u) => avatar(u, u.pilot))),
        h('span', room?.pilot ? t('consoles.live.pilot', { name: room.pilot.name }) : t('consoles.live.noPilot')))
      : null,
    h('section.device-sheet-note',
      h('h3', tNode('consoles.device.note')),
      note
        ? [h('p.note-text', note.text), h('p.muted', t('collab.notes.lastBy', { name: note.by.name, time: fmtShort(note.updatedAt) }))]
        : h('p.muted', tNode('collab.notes.none'))),
    h('div.form-actions',
      state === 'busy' ? h('button.btn', { type: 'button', dataset: { action: 'notify' }, onclick: act(notify) }, icon('bell'), tNode('terminal.pane.notifyFree')) : null,
      note || mayEdit(bench) ? h('button.btn', { type: 'button', dataset: { action: 'note' }, onclick: act(() => openNoteDialog(device.key)) }, icon('note'), tNode(note ? (mayEdit(bench) ? 'collab.notes.edit' : 'collab.notes.open') : 'collab.notes.add')) : null,
      h('button.btn.primary', { type: 'button', dataset: { action: 'open' }, disabled: state === 'disabled' ? true : null, onclick: act(() => onOpen(device)) }, icon('terminal'), tNode('consoles.device.open'))));
  dlg = openDialog(body, { title: t('consoles.device.title', { name: device.name, bench }) });
  return dlg;
}
