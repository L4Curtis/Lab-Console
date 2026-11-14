/**
 * Who may run, follow and see a bench job (SPEC "Lot jobs")
 *
 * Running one: services.benches.canOperate(user, bench) (the occupants of an
 * unlocked bench, and admins), through the shared bench rules
 * (teams/access.js); after a release, the team that released may still back
 * the bench up for a while (the offer). A job goes on device after device
 * only while its actor, with the role the directory gives them now, may still
 * run it.
 *
 * Seeing one is decided by what was true when it ran, never by who holds the
 * bench now: the members of the team that held it (job.teamId) and the admins
 * read the whole report, which carries configuration lines (diffs, refused
 * commands, console output). Its actor, when not one of them, and the bench's
 * occupants while the job runs, see it without those lines (redactedJob);
 * nobody else sees it.
 */
import { publicJob, redactedJob } from './runner.js';

export const OFFER_MS = 30 * 60_000;
/** Jobs that erase or write a device */
export const MUTATING = new Set(['reset', 'inject']);
const LIVE = new Set(['pending', 'running']);

/**
 * @param access   the shared bench rules (createBenchAccess, prefix 'jobs')
 * @param library  the snapshots (canSee)
 */
export function createJobPermissions({ services, access, library, now }) {
  const { isAdmin } = access;
  const benches = () => services.benches;
  const offers = new Map(); // bench → { teamId, until }: the backup offered after a release

  /** The backup a release offered to this user's team, while it holds (bench still free, or theirs, and not locked) */
  function offerFor(user, bench) {
    const offer = offers.get(bench);
    if (!offer || offer.until < now()) return null;
    if (!access.isMember(user, offer.teamId)) return null;
    const holder = benches()?.holder?.(bench);
    if (benches()?.lock?.(bench) || (holder && holder.teamId !== offer.teamId)) return null;
    return offer;
  }

  /** A release offers a backup to the team that let the bench go */
  function offer(bench, teamId) {
    offers.set(bench, { teamId, until: now() + OFFER_MS });
  }

  /** Why `user` may not run a job on `bench` (an HttpError), or null; `offerOk`: a backup the release offered counts */
  function refusal(user, bench, { offerOk = false } = {}) {
    const no = access.operateRefusal(user, bench);
    if (!no || (offerOk && no.status === 403 && offerFor(user, bench))) return null;
    return no;
  }

  /** A job goes on device after device only while its actor may still run it (and, erasing or writing, touch a shared line) */
  function mayGoOn(job, device) {
    const user = access.currentUser(job.hidden.actorUser);
    if (!user) return false;
    if (MUTATING.has(job.kind) && device?.shared && access.sharedConflict(user, job.bench, [device])) return false;
    if (isAdmin(user) || benches()?.canOperate?.(user, job.bench)) return true;
    return Boolean(job.options.offer && offerFor(user, job.bench));
  }

  /** May `user` stop this running job: its actor, the bench's occupants, admins */
  const mayCancel = (user, job) => isAdmin(user) || job.actor.id === user.id || Boolean(benches()?.canOperate?.(user, job.bench));

  /**
   * What `user` may see of `job`: 'full' (the members of the team that held
   * the bench when it ran, admins), 'summary' (its actor otherwise; the
   * bench's occupants while it runs, or in its own publications), or null
   */
  function viewOf(user, job, { live = false } = {}) {
    if (!user?.id) return null;
    if (isAdmin(user) || library.canSee(user, { teamId: job.teamId })) return 'full';
    if (job.actor?.id === user.id) return 'summary';
    if ((live || LIVE.has(job.state)) && benches()?.isOccupant?.(user, job.bench)) return 'summary';
    return null;
  }

  /** The job as `user` may see it, or null */
  function jobFor(user, job, options) {
    const view = viewOf(user, job, options);
    if (view === 'full') return job.hidden ? publicJob(job) : job;
    if (view === 'summary') return redactedJob(job);
    return null;
  }

  return { offers, offer, offerFor, refusal, mayGoOn, mayCancel, viewOf, jobFor };
}
