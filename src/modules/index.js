/**
 * Module registry. Each feature area of the platform is a self-contained
 * module mounted under /api/<id> (HTTP) and optionally /ws/<id> (WebSocket).
 * Adding a feature = adding one line here + one folder.
 *
 * Every module receives the same `deps` (ARCHITECTURE §6):
 *   { config, logger, events, infra, store, audit, auth, settings, services }
 * and takes what it needs. A module publishes its API for the others as
 * `services.<id> = {...}` while being created; the others read it lazily,
 * inside handlers, so the order of the list below never matters.
 */
import { createConsolesModule } from './consoles/index.js';
import { createProxmoxModule } from './proxmox/index.js';
import { createTeamsModules } from './teams/index.js';
import { createAccountsModule } from './accounts/index.js';
import { createAdminModule } from './admin/index.js';
import { createJobsModule } from './jobs/index.js';
import { createScriptsModule } from './scripts/index.js';
import { createCollabModule } from './collab/index.js';
import { createChecksModule } from './checks/index.js';
import { createRecoveryModule } from './recovery/index.js';
import { createOverviewModule } from './overview/index.js';

export function createModules(deps) {
  return [createConsolesModule(deps), ...createTeamsModules(deps), createProxmoxModule(deps), createAccountsModule(deps), createAdminModule(deps), createJobsModule(deps), createScriptsModule(deps), createCollabModule(deps), createChecksModule(deps), createRecoveryModule(deps), createOverviewModule(deps)];
}
