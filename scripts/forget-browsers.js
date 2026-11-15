/**
 * Forget every browser the local administrator signed in from:
 *   npm run forget-browsers            (then restart Lab Console)
 *
 * Removes the key of the known-browser cookies from the database
 * (DATA_DIR/lab-console.db, auth_state 'device-key'). At the next start a new
 * key is made, so every known-browser cookie stops counting: those browsers
 * meet the shared sign-in limits like any other until they sign in again.
 * Sessions are not touched. DATA_DIR defaults to ./data, as for the service;
 * in Docker: docker compose exec lab-console node scripts/forget-browsers.js
 */
import path from 'node:path';
import { openDatabase, createRepositories } from '../src/lib/db/index.js';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const file = path.join(dataDir, 'lab-console.db');

try {
  const db = await openDatabase({ file });
  try {
    const { changes } = await createRepositories(db).authState.remove('device-key');
    console.log(changes
      ? `Known browsers forgotten (${file}). Restart Lab Console for it to take effect.`
      : `No known-browser key in ${file}: nothing to forget.`);
  } finally {
    await db.close();
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
