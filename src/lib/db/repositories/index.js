/**
 * Every repository of the application, built on one executor: the database,
 * or a transaction (ARCHITECTURE §6, "database"; recipe in §14)
 *
 *   const repos = createRepositories(db);
 *   await repos.audit.insert(entry);
 *   await repos.transaction(async (r) => { await r.sessions.remove(id); await r.audit.insert(entry); });
 *
 * A repository is the only place SQL is written: modules call its methods
 * and never see a statement (a test checks that src/ has no SQL elsewhere).
 * Adding one is a file in this folder and a line below
 */
import { createSessionsRepository } from './sessions.js';
import { createAuthStateRepository } from './authState.js';
import { createAuditRepository } from './audit.js';
import { createSettingsRepository } from './settings.js';
import { createLegacyImportsRepository } from './legacyImports.js';
import { createTeamsRepository } from './teams.js';
import { createBenchesRepository } from './benches.js';
import { createAccountsRepository } from './accounts.js';
import { createAccountLinksRepository } from './accountLinks.js';
import { createAnnouncementsRepository } from './announcements.js';
import { createDiagramsRepository } from './diagrams.js';
import { createJournalDaysRepository } from './journalDays.js';
import { createJobsRepository } from './jobs.js';
import { createSnapshotsRepository, createTemplatesRepository } from './configSets.js';

export function createRepositories(db, { now = () => new Date() } = {}) {
  const options = { now };
  return {
    sessions: createSessionsRepository(db, options),
    authState: createAuthStateRepository(db, options),
    audit: createAuditRepository(db, options),
    settings: createSettingsRepository(db, options),
    legacyImports: createLegacyImportsRepository(db, options),
    teams: createTeamsRepository(db, options),
    benches: createBenchesRepository(db, options),
    accounts: createAccountsRepository(db, options),
    accountLinks: createAccountLinksRepository(db, options),
    announcements: createAnnouncementsRepository(db, options),
    diagrams: createDiagramsRepository(db, options),
    journalDays: createJournalDaysRepository(db, options),
    jobs: createJobsRepository(db, options),
    snapshots: createSnapshotsRepository(db, options),
    templates: createTemplatesRepository(db, options),
    /** Run fn(repos) in one transaction: every repository inside works on it */
    transaction: (fn) => db.transaction((tx) => fn(createRepositories(tx, options))),
  };
}
