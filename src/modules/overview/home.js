/**
 * The personal home page shown after sign-in: my team, our bench, our latest
 * backups, what happened lately on our bench, the announcement (SPEC "Lot
 * overview")
 *
 * Built per request from the services that own each part; nothing is kept.
 * The audience of each part is the one of its owner, asked again here:
 *   - the team and its slots: its members (an invitation: the person invited);
 *   - the bench: everyone sees its public card (benches.js), the join
 *     requests only the occupants and admins (benches.detail);
 *   - the backups: the snapshots of MY team, listed by the jobs service for
 *     this very user, so a guest of a bench, an outsider or another team
 *     never gets one. An admin has no team: no backups here (the Backups
 *     section lists them all);
 *   - the activity: the bench's audit trail since my team took it, for its
 *     occupants only (the rule of the bench history): occupancy, job runs,
 *     console lines; never the downloads and deletions of a snapshot or of the
 *     lab folder. Names of people, device names, never an address;
 *   - the announcement: everyone.
 */
import { benchCards, labTotals } from './benches.js';

const ACTIVITY_LIMIT = 15;
const BACKUPS_SHOWN = 5;
// Dotted prefixes of the audit trail that tell the story of a bench: its
// occupancy, the job runs, the console lines. Not `job` as a whole: the
// snapshots and the lab folder are logged on the bench too, whoever owns them
// (a previous team downloading its old backup), and they stay that team's
const JOB_KINDS = ['backup', 'reset', 'inject', 'compare'];
const activityActions = (services) => [
  'bench', 'console.open', 'console.join', 'console.freed',
  ...(services.jobs?.kinds ?? JOB_KINDS).map((kind) => `job.${kind}`),
];

const nameOf = (person) => person?.name || person?.username || '';

/** The bench `user` works on: their team's first, else one they are a guest of */
function mainBench(cards) {
  return cards.find((c) => c.holder?.mine) ?? cards.find((c) => c.you.occupant) ?? null;
}

export async function describeHome({ services, audit, user, now }) {
  const cards = benchCards({ services, user, now });
  const team = services.teams.teamOf(user);
  const bench = mainBench(cards);

  const slots = team
    ? services.benches.reservations({ from: now }).filter((r) => r.teamId === team.id)
      .map((r) => ({ bench: r.bench, start: r.start, end: r.end }))
    : [];

  const backups = team && services.jobs?.snapshots
    ? (await services.jobs.snapshots(user, { teamId: team.id, limit: BACKUPS_SHOWN })).map((s) => ({
      id: s.id, bench: s.bench, label: s.label, origin: s.origin, createdAt: s.createdAt, devices: s.devices.length, author: s.author?.name ?? '',
    }))
    : [];

  // Since the current holder took the bench: an earlier team's work is not ours to read
  let activity = [];
  if (bench?.you.occupant && bench.holder) {
    const entries = await audit.query({ bench: bench.bench, since: bench.holder.since, action: activityActions(services), limit: ACTIVITY_LIMIT });
    activity = entries.map((e) => ({
      ts: e.ts,
      action: e.action,
      actor: { name: nameOf(e.actor) },
      details: { team: e.details?.team, guest: e.details?.guestName ?? e.details?.guest, reason: e.details?.reason, device: e.details?.device },
    }));
  }

  const announcement = services.admin?.announcement?.() ?? null;
  return {
    team: team ? { id: team.id, name: team.name, members: team.people.map((p) => ({ name: p.name, you: p.id === user.id })) } : null,
    invitations: services.teams.invitationsFor(user).map((i) => ({ team: i.team.name, by: nameOf(i.by), at: i.at })),
    bench,
    slots,
    backups,
    activity,
    lab: labTotals(cards),
    announcement: announcement ? { text: announcement.text, level: announcement.level, at: announcement.at, expiresAt: announcement.expiresAt, by: nameOf(announcement.by) } : null,
  };
}
