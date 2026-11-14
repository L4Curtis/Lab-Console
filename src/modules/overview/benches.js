/**
 * The overview of every bench: who holds it, who is on it, which consoles are
 * open and who pilots them, the job that runs, the lock, the next slots and
 * the state of its console lines (SPEC "Lot overview")
 *
 * Nothing is stored here. Every field is read from the service that owns it
 * (benches, teams, consoles, jobs, checks) at the moment of the request, so
 * the page and the other screens can never disagree
 *
 * What is shown is what every signed-in user already receives over SSE
 * (`benches:state`, `consoles:rooms`, `jobs:running`), in the reservation
 * calendar, and in the last line status of the checks lot (everyone may read
 * it: /api/checks/latest). What is left out on purpose: backups, journals, notes and chat
 * (they belong to a team), the last command typed on a console, user names
 * and ids of the people (names only), the address of a console line. The
 * only thing that depends on the reader is `you`: whether they work on the
 * bench, and which slots are their team's
 */
import { httpError } from '../../lib/httpError.js';

const SLOTS_SHOWN = 3;
const FINISHED = new Set(['done', 'failed', 'skipped', 'cancelled']);

const targetKey = (t) => `${t.host}:${t.port}`;

/** The services the overview reads; a platform without them cannot answer */
export function requireServices(services) {
  if (!services.benches?.detail || !services.consoles?.registry || !services.teams?.get) {
    throw httpError(503, 'overview.unavailable', 'The overview needs the consoles, teams and benches modules');
  }
}

/** What a job shows to everyone: the same as the 'jobs:running' topic, counted */
function jobView(job) {
  if (!job) return null;
  const devices = job.devices ?? [];
  return {
    kind: job.kind,
    state: job.state,
    actor: job.actor?.name ?? '',
    startsAt: job.startsAt ?? null,
    devices: {
      total: devices.length,
      finished: devices.filter((d) => FINISHED.has(d.state)).length,
      failed: devices.filter((d) => d.state === 'failed').length,
    },
  };
}

/**
 * Every bench of the diagram, in its order, as `user` sees it
 * @param now  milliseconds (the slot that has not ended yet is the first one)
 */
export function benchCards({ services, user, now }) {
  requireServices(services);
  const labs = services.consoles.registry.model.labs ?? [];
  const rooms = services.consoles.rooms;
  const roomOf = new Map((rooms?.list() ?? []).map((r) => [r.target, r]));
  const busyOutside = new Set(rooms?.busyOutside() ?? []);
  const myTeam = services.teams.teamOf?.(user) ?? null;

  const slotsOf = new Map();
  for (const r of services.benches.reservations({ from: now })) {
    if (!slotsOf.has(r.bench)) slotsOf.set(r.bench, []);
    slotsOf.get(r.bench).push(r);
  }

  return labs.map((lab) => {
    const detail = services.benches.detail(lab.name, user);

    // The lines of the bench: open in the application, refused by the console server, silent (accepted, nothing
    // printed), and what the checks lot's last line status (while fresh) found on the lines nobody has open now
    const checked = services.checks?.lines?.(lab.name) ?? null;
    const lineOf = new Map((checked?.devices ?? []).map((d) => [d.key, d.line]));
    const lines = { total: 0, open: 0, busy: 0, silent: 0, free: 0, checkedAt: checked?.at ?? null };
    const consoles = [];
    for (const device of lab.devices) {
      if (device.allowed === false) continue; // outside the allow-list: inert, not a line of the bench
      lines.total += 1;
      const key = targetKey(device.target);
      const room = roomOf.get(key);
      if (!room || room.state === 'closed') {
        // What the application knows now wins; the check speaks for the lines it found free or silent.
        // Its busy lines are already in busyOutside (the check marks them); one in the application then
        // is no longer known
        if (busyOutside.has(key)) lines.busy += 1;
        else if (lineOf.get(device.key) === 'silent') lines.silent += 1;
        else if (lineOf.get(device.key) === 'free') lines.free += 1;
        continue;
      }
      lines.open += 1;
      if (room.state === 'silent') lines.silent += 1;
      consoles.push({
        device: device.name,
        state: room.state,
        pilot: room.pilot?.name ?? null,
        people: room.users.length,
        shared: Boolean(room.shared),
        task: Boolean(room.task),
      });
    }

    return {
      bench: lab.name,
      state: detail.lock ? 'locked' : detail.holder ? 'taken' : 'free',
      holder: detail.holder ? { teamName: detail.holder.teamName, since: detail.holder.since, mine: myTeam?.id === detail.holder.teamId } : null,
      occupants: detail.occupants.map((o) => ({ name: o.name, guest: o.guest })),
      lock: detail.lock ? { reason: detail.lock.reason, by: detail.lock.by?.name ?? '', at: detail.lock.at } : null,
      releaseAt: detail.releaseAt,
      lastActivity: detail.lastActivity,
      lines,
      consoles,
      job: jobView(services.jobs?.running?.(lab.name)),
      slots: (slotsOf.get(lab.name) ?? []).slice(0, SLOTS_SHOWN).map((r) => ({
        start: r.start, end: r.end, teamName: r.teamName, mine: Boolean(myTeam && r.teamId === myTeam.id),
      })),
      // Join requests are the occupants' business (and the admins'): detail() empties them for anyone else
      requests: detail.requests.length,
      you: { occupant: detail.you.occupant, member: detail.you.member, guest: detail.you.guest },
    };
  });
}

/** The lab in a few numbers (the home page's strip) */
export function labTotals(cards) {
  return {
    benches: cards.length,
    free: cards.filter((c) => c.state === 'free').length,
    taken: cards.filter((c) => c.state === 'taken').length,
    locked: cards.filter((c) => c.state === 'locked').length,
    consoles: cards.reduce((n, c) => n + c.consoles.length, 0),
    jobs: cards.filter((c) => c.job).length,
  };
}
