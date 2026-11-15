/**
 * Repository of the sign-in module's own small values (table auth_state,
 * migration 002), one JSON document per name:
 *
 *   'local-admin'   { lastTotpStep }   the environment administrator's last accepted code
 *   'device-key'    { key }            the key of the known-browser cookies
 *
 *   get(name)               → the value, or undefined when there is none
 *   set(name, value)        insert, or update the existing value
 *   setIfAbsent(name, value)   keep what is there (imports: the database wins)
 *   remove(name)            → { changes }
 */
import { toIso, toJson } from '../values.js';

export function createAuthStateRepository(db, { now = () => new Date() } = {}) {
  const upsert = (conflict) => async (name, value) => db.run(
    `INSERT INTO auth_state (name, data, updated_at) VALUES (?, ?, ?) ${conflict}`,
    [String(name), toJson(value), toIso(now())],
  );
  return {
    async get(name) {
      const found = await db.get('SELECT data FROM auth_state WHERE name = ?', [String(name)]);
      // A damaged value is an error, not "nothing": callers decide (a new key would sign known browsers out)
      return found === undefined ? undefined : JSON.parse(found.data);
    },
    set: upsert('ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    setIfAbsent: upsert('ON CONFLICT (name) DO NOTHING'),
    async remove(name) { return db.run('DELETE FROM auth_state WHERE name = ?', [String(name)]); },
  };
}
