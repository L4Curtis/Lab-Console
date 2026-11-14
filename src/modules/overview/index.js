/**
 * Overview and home page: read-only views over the benches, the consoles, the
 * jobs and the teams (SPEC "Lot overview", ARCHITECTURE §9c)
 *
 *   GET /api/overview/benches   every bench: holder, occupants, open consoles and pilots, running job,
 *                               lock, next slots, state of its console lines   (everyone signed in)
 *   GET /api/overview/home      my team, our bench, our latest backups, recent activity on our bench,
 *                               the announcement                                (per person)
 *
 * No state and no SSE topic of its own: every answer is computed from the
 * services that own the data, at the moment of the request. The page stays
 * live by listening to the topics those services already publish (with
 * their own audiences) and reading again when one of them moves
 * (public/js/modules/overview/live.js). Nothing here can write
 */
import express from 'express';
import { benchCards } from './benches.js';
import { describeHome } from './home.js';

/** @param options  test seam: now (a clock, milliseconds) */
export function createOverviewModule({ audit, services }, options = {}) {
  const now = options.now ?? (() => Date.now());
  const router = express.Router();

  router.get('/benches', (req, res) => {
    const at = now();
    res.set('Cache-Control', 'no-store').json({ benches: benchCards({ services, user: req.user, now: at }), at: new Date(at).toISOString() });
  });

  router.get('/home', async (req, res) => {
    const at = now();
    res.set('Cache-Control', 'no-store').json(await describeHome({ services, audit, user: req.user, now: at }));
  });

  return { id: 'overview', title: 'Overview', enabled: true, router };
}
