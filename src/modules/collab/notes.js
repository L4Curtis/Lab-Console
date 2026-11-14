/**
 * The shared note of a device (SPEC "Lot collab")
 *
 * One note per device of the diagram, read by every signed-in user (it is
 * drawn on the diagram for everyone), written by the occupants of the
 * device's bench and by admins. A note is plain text of 2000 characters at
 * most; saving an empty text deletes it.
 *
 *   GET  /api/collab/notes            every note of a device that still exists
 *   PUT  /api/collab/notes/:key       { text, rev } - `rev` is the revision the editor started from
 *                                     (0: no note yet); another revision is a 409 `collab.note_conflict`
 *
 * Two people editing at once cannot overwrite each other without knowing:
 * the second save is refused and the browser shows the new version.
 * SSE `collab:note` (everyone): the note as listed, or { key, rev: 0, removed: true }
 */
import { httpError } from '../../lib/httpError.js';
import { cleanText, createUserLimiter, rateLimited } from './rules.js';

const isAdmin = (user) => user?.role === 'admin';

export function mountNotes(router, { repos, events, audit, services, json, limits, now }) {
  const registry = () => services.consoles?.registry;
  const limiter = createUserLimiter({ limit: limits.notePerWindow, windowMs: limits.noteWindowMs, now });

  /** The device of the diagram, or a 404: admin switches belong to no bench and carry no note */
  function deviceOf(key) {
    const device = registry()?.getDevice(String(key));
    if (!device) throw httpError(404, 'collab.unknown_device', 'This device does not exist (any more)');
    return device;
  }

  /** The occupants of the device's bench, and admins */
  const mayEdit = (user, device) => isAdmin(user) || Boolean(services.benches?.isOccupant?.(user, device.labName));

  /** A stored note as the browser sees it: the names are the diagram's today */
  const view = (note, device) => ({ ...note, bench: device.labName, device: device.name });

  async function list() {
    const out = [];
    for (const note of await repos.collab.notes()) {
      const device = registry()?.getDevice(note.key);
      if (device) out.push(view(note, device));
    }
    return out;
  }

  router.get('/notes', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ notes: await list(), limits: { maxChars: limits.noteChars } });
  });

  router.put('/notes/:key', json, async (req, res) => {
    const device = deviceOf(req.params.key);
    if (!mayEdit(req.user, device)) {
      throw httpError(403, 'collab.note_forbidden', 'Only the occupants of this bench and the admins may write its notes', { bench: device.labName });
    }
    const rev = req.body?.rev;
    if (!Number.isInteger(rev) || rev < 0) throw httpError(400, 'collab.bad_revision', 'rev must be the revision the note had when you opened it (0 for none)');
    const text = cleanText(req.body?.text, { max: limits.noteChars });
    const wait = limiter.hit(req.user.id);
    if (wait) throw rateLimited(wait);

    const conflict = (current) => httpError(409, 'collab.note_conflict', 'Someone changed this note since you opened it', { rev: current?.rev ?? 0 });
    const current = await repos.collab.note(device.key);
    const details = { bench: device.labName, device: device.name, chars: [...text].length };

    if (text === '') {
      if (!current && rev === 0) return res.json({ note: null }); // nothing to delete, nothing was asked of it
      if (!current || !(await repos.collab.removeNote(device.key, rev))) throw conflict(current);
      audit.log(req, 'collab.note.clear', details);
      events.publish('collab:note', { key: device.key, bench: device.labName, rev: 0, removed: true });
      return res.json({ note: null });
    }

    const saved = await repos.collab.saveNote({
      key: device.key, bench: device.labName, device: device.name, text, by: { id: req.user.id, name: req.user.name || req.user.username || req.user.id }, at: now(),
    }, rev);
    if (!saved) throw conflict(current);
    audit.log(req, 'collab.note.set', details);
    const note = view(saved, device);
    events.publish('collab:note', note);
    res.json({ note });
  });

  return {
    list,
    noteOf: async (key) => {
      const device = registry()?.getDevice(String(key));
      const note = device ? await repos.collab.note(device.key) : null;
      return note && view(note, device);
    },
  };
}
