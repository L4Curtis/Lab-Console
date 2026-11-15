/**
 * The dotted prefixes of the audit trail that tell the story of a bench: its
 * occupancy, the job runs, the console lines. Not `job` as a whole: the
 * snapshots and the lab folder are logged on the bench too, whoever owns them
 * (a previous team downloading its old backup), and they stay that team's.
 */
const JOB_KINDS = ['backup', 'reset', 'inject', 'compare'];

export const activityActions = (services) => [
  'bench', 'console.open', 'console.join', 'console.freed',
  ...(services.jobs?.kinds ?? JOB_KINDS).map((kind) => `job.${kind}`),
];

/** What the occupants of a bench see in its history: the same prefixes, without the console lines */
export const historyActions = (services) => activityActions(services).filter((a) => !a.startsWith('console.'));
