/**
 * Group work in the browser (SPEC "Lot collab"), started once by main.js
 * after the session and the language are known:
 *
 *   notes.js          the shared note of a device: badge on the diagram, button on console tiles, dialog
 *   notifications.js  system notifications for a request for the keyboard, a free line, a finished job
 *   benchPanel.js     notes and chat of the bench on screen; the consoles section mounts it
 *
 * The notes are loaded in the background: the diagram shows them as they arrive
 */
import { loadCss } from '../../core/dom.js';
import { loadNamespace } from '../../core/i18n.js';
import { startNotes } from './notes.js';
import { startNotifications } from './notifications.js';

export async function startCollab() {
  await Promise.all([loadNamespace('collab'), loadCss('collab')]);
  startNotifications();
  startNotes();
}
