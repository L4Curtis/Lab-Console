/**
 * "Script library" module: the lists of console commands people keep, share
 * with their team, or (administrators) publish for everybody. The inject
 * dialog, the multi-line paste and the "send to several consoles" dialog read
 * it. Rules in library.js; storage in repos.scripts (table scripts)
 *
 *   GET    /api/scripts        what the caller may see, without the texts
 *   GET    /api/scripts/:id    one script with its text
 *   POST   /api/scripts        { scope: personal | team | published, title, description?, body }
 *   PATCH  /api/scripts/:id    { title?, description?, body?, updatedAt? }
 *   DELETE /api/scripts/:id
 *
 * Every change is audited (script.create / update / delete, with the title
 * and the shelf, never the text)
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { ScriptLibrary, LibraryError, LIMITS } from './library.js';

export function createScriptsModule({ repos, audit, services }) {
  const library = new ScriptLibrary({
    repos,
    teamOf: (user) => services.teams?.teamOf?.(user),
    teamName: (teamId) => services.teams?.get?.(teamId)?.name,
  });

  services.scripts = {
    list: (user) => library.list(user),
    get: (user, id) => library.get(user, id),
  };

  const router = express.Router();
  // A 64 KB text can double in size once its line breaks are escaped
  const json = express.json({ limit: `${LIMITS.bodyBytes * 4 / 1024}kb` });
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  const details = (s) => ({ id: s.id, title: s.title, scope: s.scope, ...(s.team ? { team: s.team.name, teamId: s.team.id } : {}) });

  /** A refusal of the library is an API error */
  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof LibraryError) throw httpError(err.status, err.code, err.message, err.params);
      throw err;
    }
  };

  router.get('/', guard(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await library.list(req.user));
  }));
  router.get('/:id', guard(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ script: await library.get(req.user, req.params.id) });
  }));
  router.post('/', json, guard(async (req, res) => {
    const script = await library.create(req.user, body(req));
    audit.log(req, 'script.create', details(script));
    res.status(201).json({ script });
  }));
  router.patch('/:id', json, guard(async (req, res) => {
    const script = await library.update(req.user, req.params.id, body(req));
    audit.log(req, 'script.update', details(script));
    res.json({ script });
  }));
  router.delete('/:id', guard(async (req, res) => {
    const script = await library.remove(req.user, req.params.id);
    audit.log(req, 'script.delete', { id: script.id, title: script.title, scope: script.scope });
    res.json({ ok: true });
  }));

  return { id: 'scripts', title: 'Script library', enabled: true, router };
}
