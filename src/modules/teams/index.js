/**
 * Teams and benches: two server modules built together because the benches
 * follow the teams (SPEC "Lot teams", ARCHITECTURE §7)
 *
 *   /api/teams     create, rename, invite, accept, leave, dissolve      services.teams
 *   /api/benches   take, release, join on request, lock, reservations   services.benches
 *
 * Every change is written to the audit trail and announced over SSE with an
 * audience: a team invitation reaches the person invited only, a join
 * request reaches the bench's occupants only. Authorization is checked here,
 * on every route; the browser only hides what it may not do
 *
 * `now` and `tickMs` are seams for the tests (a fake clock, no timer)
 */
import express from 'express';
import { httpError } from '../../lib/httpError.js';
import { Teams, isInvitee, normalizeUsername } from './teams.js';
import { Benches } from './benches.js';

const TICK_MS = 30_000;

export function createTeamsModules(deps, { now = () => Date.now(), tickMs = TICK_MS } = {}) {
  const { config, logger, events, repos, audit, auth, services } = deps;
  const log = logger.child('teams');
  const teams = new Teams({ repos, now });
  const benches = new Benches({ repos, teams, services, events, audit, logger: log, config: config.benches, now });

  teams.on('change', (change) => {
    announceTeam(change);
    benches.teamChanged(change).catch((err) => log.warn(`benches did not follow a team change: ${err.message}`));
  });

  /** Who hears about a team change: its members before and after, and the admins */
  function announceTeam({ team, before, after }) {
    const ids = new Set([...(before?.members ?? []), ...(after?.members ?? [])]);
    const invited = [...(before?.invitations ?? []), ...(after?.invitations ?? [])];
    events.publish('teams:changed', { teamId: team?.id ?? null }, {
      audience: (u) => u.role === 'admin' || ids.has(u.id) || invited.some((inv) => isInvitee(inv, u)),
    });
  }

  services.teams = {
    teamOf: (userOrId) => teams.teamOf(userOrId),
    get: (teamId) => teams.get(teamId),
    list: () => teams.list(),
    invitationsFor: (user) => teams.invitationsFor(user),
  };
  services.benches = {
    holder: (labName) => benches.holder(labName),
    occupants: (labName) => benches.occupants(labName),
    isOccupant: (user, labName) => benches.isOccupant(user, labName),
    canOperate: (user, labName) => benches.canOperate(user, labName),
    canPilot: (user, device) => benches.canPilot(user, device),
    lock: (labName) => benches.lock(labName),
    touch: (labName) => benches.touch(labName),
    onRelease: (fn) => benches.onRelease(fn),
    detail: (labName, user) => benches.detail(labName, user),
    reservations: (options) => benches.listReservations(options),
  };

  const json = express.json({ limit: '4kb' });
  const isAdmin = (req) => req.user.role === 'admin';
  const param = (req, name) => String(req.params[name] ?? '');

  // ── /api/teams ────────────────────────────────────────────────────────────
  const teamsRouter = express.Router();

  const teamFor = (req) => {
    const team = teams.get(param(req, 'id'));
    if (!team) throw httpError(404, 'teams.unknown', 'This team does not exist (any more)');
    return team;
  };
  const memberOrAdmin = (req, team) => {
    if (!isAdmin(req) && !team.members.includes(req.user.id)) throw httpError(403, 'teams.not_member', 'Only the members of this team may do that');
  };
  const nameOf = (body) => (body && typeof body === 'object' ? body.name : undefined);

  teamsRouter.get('/', (req, res) => {
    const mine = teams.teamOf(req.user);
    const all = teams.list();
    res.set('Cache-Control', 'no-store').json({
      mine,
      invitations: teams.invitationsFor(req.user),
      // Students see which teams exist (a holder's name is public); admins see everything
      teams: isAdmin(req) ? all : all.map(({ id, name, members }) => ({ id, name, size: members.length })),
      admin: isAdmin(req),
    });
  });

  teamsRouter.post('/', json, async (req, res) => {
    const team = await teams.create(req.user, nameOf(req.body));
    audit.log(req, 'team.create', { team: team.name, teamId: team.id });
    res.status(201).json({ team });
  });

  teamsRouter.patch('/:id', json, async (req, res) => {
    memberOrAdmin(req, teamFor(req));
    const before = teamFor(req);
    const team = await teams.rename(before.id, nameOf(req.body));
    audit.log(req, 'team.rename', { team: team.name, teamId: team.id, from: before.name });
    res.json({ team });
  });

  teamsRouter.delete('/:id', auth.requireRole('admin'), async (req, res) => {
    const team = await teams.dissolve(teamFor(req).id);
    audit.log(req, 'team.dissolve', { team: team.name, teamId: team.id });
    res.json({ ok: true });
  });

  /**
   * The account an invitation names, as the directory knows it
   * (services.accounts, the accounts lot): { id, username } of the one
   * account with this user name that can sign in, in its own spelling. The
   * invitation is bound to that account, so a namesake never accepts it;
   * when several accounts share the name (a local account and an SSO one,
   * possible for accounts made before sign-up refused SSO names), nobody is
   * invited: 409 teams.ambiguous_user. Without the directory (a platform
   * without the accounts module), the name is taken as typed
   */
  function resolveInvitee(raw) {
    const accounts = services.accounts;
    if (typeof accounts?.findAllByUsername !== 'function') return raw;
    const name = normalizeUsername(raw);
    const found = accounts.findAllByUsername(name);
    if (found.length > 1) {
      throw httpError(409, 'teams.ambiguous_user', 'Several accounts have this user name: an administrator must sort it out first', { username: name });
    }
    const account = found[0];
    if (!account || account.state !== 'active') {
      throw httpError(404, 'teams.unknown_user', 'Nobody with this user name can sign in here: an SSO account is known after its first sign-in', { username: name });
    }
    return { id: account.id, username: account.username };
  }

  teamsRouter.post('/:id/invitations', json, async (req, res) => {
    const target = teamFor(req);
    memberOrAdmin(req, target);
    const { team, invited, username, userId } = await teams.invite(target.id, resolveInvitee(req.body?.username), req.user);
    if (invited) {
      audit.log(req, 'team.invite', { team: team.name, teamId: team.id, invitee: username });
      // The invitation reaches the person it names, and nobody else
      events.publish('teams:invitation', { team: { id: team.id, name: team.name }, by: { name: req.user.name } }, {
        audience: (u) => isInvitee({ username, userId }, u),
      });
    }
    res.status(invited ? 201 : 200).json({ team });
  });

  teamsRouter.delete('/:id/invitations/:username', async (req, res) => {
    const target = teamFor(req);
    const invitation = teams.invitationNamed(target.id, param(req, 'username'));
    // Declining is for the account the invitation names, not for whoever shares its user name
    const declining = Boolean(invitation) && isInvitee(invitation, req.user);
    if (!declining) memberOrAdmin(req, target);
    await teams.dropInvitation(target.id, param(req, 'username'));
    audit.log(req, declining ? 'team.invite.decline' : 'team.invite.revoke', { team: target.name, teamId: target.id, invitee: param(req, 'username') });
    res.json({ ok: true });
  });

  teamsRouter.post('/:id/accept', async (req, res) => {
    const target = teamFor(req);
    const team = await teams.accept(target.id, req.user);
    audit.log(req, 'team.join', { team: team.name, teamId: team.id });
    res.json({ team });
  });

  teamsRouter.post('/:id/leave', async (req, res) => {
    const target = teamFor(req);
    if (!target.members.includes(req.user.id)) throw httpError(403, 'teams.not_member', 'Only the members of this team may do that');
    const { dissolved } = await teams.removeMember(target.id, req.user.id);
    audit.log(req, 'team.leave', { team: target.name, teamId: target.id, dissolved });
    res.json({ ok: true, dissolved });
  });

  teamsRouter.delete('/:id/members/:userId', auth.requireRole('admin'), async (req, res) => {
    const target = teamFor(req);
    const { dissolved } = await teams.removeMember(target.id, param(req, 'userId'));
    audit.log(req, 'team.member.remove', { team: target.name, teamId: target.id, member: param(req, 'userId'), dissolved });
    res.json({ ok: true, dissolved });
  });

  // ── /api/benches ──────────────────────────────────────────────────────────
  const benchesRouter = express.Router();
  const benchOf = (req) => benches.bench(param(req, 'bench'));

  benchesRouter.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      benches: benches.names().map((n) => benches.summary(n)),
      idleHours: benches.idleHours,
      limits: benches.limits,
      backupOffer: benches.hasReleaseHandlers,
    });
  });

  // Reservations come before /:bench so that the word is never read as a bench name
  benchesRouter.get('/reservations', (req, res) => {
    const time = (v) => {
      if (v === undefined) return undefined;
      const ms = Date.parse(String(v));
      if (!Number.isFinite(ms)) throw httpError(400, 'benches.bad_slot', 'Invalid date');
      return ms;
    };
    const bench = req.query.bench === undefined ? undefined : benches.bench(String(req.query.bench));
    res.set('Cache-Control', 'no-store').json({
      reservations: benches.listReservations({ bench, from: time(req.query.from), to: time(req.query.to) }),
      limits: benches.limits,
    });
  });

  benchesRouter.post('/reservations', json, async (req, res) => {
    const { bench, start, end, teamId } = req.body ?? {};
    const reservation = await benches.reserve(req.user, { bench, start, end, teamId: isAdmin(req) ? teamId : undefined });
    res.status(201).json({ reservation });
  });

  benchesRouter.delete('/reservations/:id', async (req, res) => {
    await benches.cancelReservation(req.user, param(req, 'id'));
    res.json({ ok: true });
  });

  benchesRouter.get('/:bench', (req, res) => {
    res.set('Cache-Control', 'no-store').json(benches.detail(benchOf(req), req.user));
  });

  benchesRouter.get('/:bench/history', async (req, res) => {
    const name = benchOf(req);
    if (!isAdmin(req) && !benches.isOccupant(req.user, name)) throw httpError(403, 'benches.not_occupant', 'Only the occupants of this bench see its history');
    const entries = await audit.query({ bench: name, action: ['bench', 'job'], limit: 100 });
    // Who did what and when; never the addresses
    res.set('Cache-Control', 'no-store').json({
      history: entries.map((e) => ({ ts: e.ts, action: e.action, actor: { name: e.actor?.name ?? e.actor?.username ?? '', username: e.actor?.username ?? '' }, details: { team: e.details?.team, guest: e.details?.guestName ?? e.details?.guest, reason: e.details?.reason, device: e.details?.device } })),
    });
  });

  benchesRouter.post('/:bench/take', async (req, res) => {
    res.json(await benches.take(req.user, benchOf(req)));
  });

  benchesRouter.post('/:bench/release', async (req, res) => {
    const name = benchOf(req);
    // Who may release is decided inside the release itself, against the bench as it is when it runs
    const { offers } = await benches.release(req.user, name);
    res.json({ ok: true, offers });
  });

  benchesRouter.post('/:bench/assign', auth.requireRole('admin'), json, async (req, res) => {
    res.json(await benches.assign(req.user, benchOf(req), String(req.body?.teamId ?? '')));
  });

  benchesRouter.post('/:bench/join', async (req, res) => {
    res.status(202).json(await benches.requestJoin(req.user, benchOf(req)));
  });

  benchesRouter.delete('/:bench/join', async (req, res) => {
    await benches.cancelRequest(req.user, benchOf(req));
    res.json({ ok: true });
  });

  benchesRouter.post('/:bench/requests/:userId/accept', async (req, res) => {
    res.json(await benches.answer(req.user, benchOf(req), param(req, 'userId'), true));
  });

  benchesRouter.post('/:bench/requests/:userId/refuse', async (req, res) => {
    res.json(await benches.answer(req.user, benchOf(req), param(req, 'userId'), false));
  });

  benchesRouter.post('/:bench/leave', async (req, res) => {
    await benches.removeGuest(req.user, benchOf(req), req.user.id, { self: true });
    res.json({ ok: true });
  });

  benchesRouter.delete('/:bench/guests/:userId', auth.requireRole('admin'), async (req, res) => {
    await benches.removeGuest(req.user, benchOf(req), param(req, 'userId'));
    res.json({ ok: true });
  });

  benchesRouter.post('/:bench/touch', async (req, res) => {
    const name = benchOf(req);
    if (!benches.isOccupant(req.user, name)) throw httpError(403, 'benches.not_occupant', 'Only the occupants of this bench may do that');
    benches.touch(name, { force: true });
    res.json({ ok: true });
  });

  benchesRouter.put('/:bench/lock', auth.requireRole('admin'), json, async (req, res) => {
    res.json({ lock: await benches.setLock(req.user, benchOf(req), req.body?.reason) });
  });

  benchesRouter.delete('/:bench/lock', auth.requireRole('admin'), async (req, res) => {
    await benches.unlock(req.user, benchOf(req));
    res.json({ ok: true });
  });

  // ── Periodic work: automatic release, warnings before a slot ──────────────
  let timer = null;
  if (tickMs > 0) {
    timer = setInterval(() => benches.tick().catch((err) => log.warn(`bench tick failed: ${err.message}`)), tickMs);
    timer.unref();
  }
  return [
    {
      id: 'teams',
      title: 'Teams',
      enabled: true,
      router: teamsRouter,
      teams,
      // State from the database before the first request; the diagram is loaded by then too
      async start() {
        await teams.load();
        await benches.load();
        benches.publishState();
      },
    },
    {
      id: 'benches',
      title: 'Benches',
      enabled: true,
      router: benchesRouter,
      benches,
      tick: () => benches.tick(),
      shutdown() { clearInterval(timer); },
    },
  ];
}
