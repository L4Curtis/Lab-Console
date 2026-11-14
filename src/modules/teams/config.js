/**
 * Teams and benches settings (configuration fragment, see ARCHITECTURE §3)
 *
 *   config.benches.idleHours            a taken bench is released after this long without activity
 *   config.benches.teamMaxMembers       members of a team, invitations not yet answered included
 *   config.benches.reservations         { maxFuture, maxHours, maxDaysAhead } limits per team
 *
 * Admins are not bound by the reservation limits; nobody may book a slot
 * that overlaps another one
 */
import { int } from '../../lib/env.js';

export function readConfig() {
  return {
    idleHours: int('BENCH_IDLE_HOURS', 3, { min: 1, max: 24 }),
    teamMaxMembers: int('TEAM_MAX_MEMBERS', 8, { min: 2, max: 30 }),
    reservations: {
      maxFuture: int('RESERVATION_MAX_FUTURE', 2, { min: 1, max: 20 }),
      maxHours: int('RESERVATION_MAX_HOURS', 4, { min: 1, max: 12 }),
      maxDaysAhead: int('RESERVATION_MAX_DAYS_AHEAD', 14, { min: 1, max: 120 }),
    },
  };
}
