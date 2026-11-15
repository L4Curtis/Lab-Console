/**
 * The bench rules the task modules share: jobs, checks and recovery act on a
 * bench's devices for a person, and ask the same questions. Who decides is
 * still services.benches (canOperate, holder, lock); this module only puts
 * the questions in one place, with one wording per module:
 *
 *   const access = createBenchAccess({ services, infra, prefix: 'jobs' });
 *   const bench = access.benchOf(req.params.bench);       // or 404 jobs.unknown_bench
 *   const no = access.operateRefusal(req.user, bench.name); // 423 jobs.locked | 403 jobs.not_occupant | null
 *
 * A task runs for a while after it was allowed. Before each device or step,
 * its module asks again with `currentUser(actor)`: the person with the role
 * the directory gives the account now, or null when the account is disabled.
 * A demoted administrator does not keep the rights they started with
 * (consoles' mayPilot applies the same rule to every byte)
 */
import { httpError } from '../../lib/httpError.js';
import { targetKey } from '../../lib/consoleTarget.js';
import { isAdmin } from '../auth/roles.js';

/**
 * `user` as the directory knows the account now: its current role, or null
 * when the account is disabled. A user the directory does not hold (the
 * environment's administrator, a platform without the accounts module) is
 * returned as is
 */
export function currentUser(services, user) {
  const account = user?.id ? services.accounts?.get?.(user.id) : null;
  if (!account) return user ?? null;
  if (account.state !== 'active') return null;
  return account.role ? { ...user, role: account.role } : user;
}

/**
 * @param services  the shared services (benches, teams, consoles, accounts), read lazily
 * @param infra     { adminSwitches }: the lines no task ever touches
 * @param prefix    the module's code namespace ('jobs', 'checks', 'recovery')
 */
export function createBenchAccess({ services, infra, prefix }) {
  const benches = () => services.benches;
  const labs = () => services.consoles?.registry?.model?.labs ?? [];

  const isMember = (user, teamId) => Boolean(teamId && services.teams?.get?.(teamId)?.members?.includes(user?.id));
  const teamOf = (user) => services.teams?.teamOf?.(user) ?? null;

  /** The diagram's bench called `name`, or a 404 */
  function benchOf(name) {
    const found = labs().find((l) => l.name === name);
    if (!found) throw httpError(404, `${prefix}.unknown_bench`, 'This bench does not exist.', { bench: String(name ?? '').slice(0, 40) });
    return found;
  }

  /** The console lines no task touches: the admin switches */
  const adminLines = () => new Set((infra?.adminSwitches ?? []).map((s) => targetKey(s.target)));

  /** Is this device on a console line a task may use (it has one, and it is not an admin switch)? */
  function isTaskDevice(device) {
    return Boolean(device?.target) && !adminLines().has(targetKey(device.target));
  }

  /**
   * The devices of `bench` (a name or the diagram's bench) a task may touch:
   * never an admin switch. Each is the registry's own device (what the
   * consoles open, journal and decide on) with its bench, and `shared` when
   * another bench uses its console line
   */
  function taskDevices(bench) {
    const page = typeof bench === 'string' ? benchOf(bench) : bench;
    const shared = services.consoles?.sharedTargets?.() ?? new Set();
    const registry = services.consoles?.registry;
    return page.devices
      .filter(isTaskDevice)
      .map((d) => ({ ...(registry?.getDevice?.(d.key) ?? d), labName: page.name, shared: shared.has(targetKey(d.target)) }));
  }

  /** Why `user` may not act on `bench` (an HttpError: 423 when locked, else 403), or null */
  function operateRefusal(user, bench) {
    if (benches()?.canOperate?.(user, bench)) return null;
    const lock = benches()?.lock?.(bench);
    if (lock) return httpError(423, `${prefix}.locked`, 'This bench is locked: only admins work on it.', { reason: lock.reason });
    return httpError(403, `${prefix}.not_occupant`, 'Only the occupants of this bench (and admins) do that.', { bench });
  }

  /**
   * A device of `bench` whose console line another bench uses, while that
   * bench is locked or held by another team: the refusal (409
   * `${prefix}.shared_in_use`), or null. Admins are never refused
   */
  function sharedConflict(user, bench, devices) {
    if (isAdmin(user)) return null;
    const shared = services.consoles?.sharedTargets?.() ?? new Set();
    const mine = teamOf(user)?.id ?? null;
    for (const d of devices) {
      const key = targetKey(d.target);
      if (!shared.has(key)) continue;
      for (const other of labs()) {
        if (other.name === bench || !other.devices?.some((x) => targetKey(x.target) === key)) continue;
        const holder = benches()?.holder?.(other.name);
        if (benches()?.lock?.(other.name) || (holder && holder.teamId !== mine)) {
          return httpError(409, `${prefix}.shared_in_use`, 'This device shares its console line with a bench another team holds: it is left alone.', { device: d.name, bench: other.name });
        }
      }
    }
    return null;
  }

  /** May `user` (as the directory knows them now) still act on `bench`? Admins always */
  function mayStillOperate(user, bench) {
    const now = currentUser(services, user);
    return isAdmin(now) || Boolean(benches()?.canOperate?.(now, bench));
  }

  return {
    isAdmin,
    isMember,
    teamOf,
    currentUser: (user) => currentUser(services, user),
    benchOf,
    isTaskDevice,
    taskDevices,
    operateRefusal,
    sharedConflict,
    mayStillOperate,
  };
}
