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

export function createRepositories(db, { now = () => new Date() } = {}) {
  const options = { now };
  return {
    sessions: createSessionsRepository(db, options),
    authState: createAuthStateRepository(db, options),
    audit: createAuditRepository(db, options),
    settings: createSettingsRepository(db, options),
    legacyImports: createLegacyImportsRepository(db, options),
    /** Run fn(repos) in one transaction: every repository inside works on it */
    transaction: (fn) => db.transaction((tx) => fn(createRepositories(tx, options))),
  };
}
