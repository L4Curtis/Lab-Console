/**
 * "Help" module: what the guided tour remembers about a person. The help page
 * itself is static text in the browser (public/js/modules/help/, dictionary
 * `help`); the only state is whether this person has been through the tour,
 * so that it opens by itself at the first sign-in and never again
 *
 *   GET /api/help/tour            { state: null | 'done' | 'skipped' }
 *   PUT /api/help/tour            { state: 'done' | 'skipped' } → { state }   ('skipped' never replaces 'done')
 *
 * Everyone signed in, about themselves only: the user comes from the session,
 * never from the request
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { TOUR_STATES } from '../../lib/db/repositories/tour.js';

export function createHelpModule({ repos }) {
  const router = express.Router();
  const json = express.json({ limit: '1kb' });

  router.get('/tour', async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ state: await repos.tour.get(req.user.id) });
  });

  router.put('/tour', json, async (req, res) => {
    const state = req.body?.state;
    if (!TOUR_STATES.includes(state)) throw httpError(400, 'help.bad_state', 'The tour ends as done or skipped');
    // Skipping a replay does not make someone who finished the tour a person who never did
    const kept = state === 'skipped' && (await repos.tour.get(req.user.id)) === 'done' ? 'done' : state;
    await repos.tour.set(req.user.id, kept);
    res.json({ state: kept });
  });

  return { id: 'help', title: 'Help', enabled: true, router };
}
