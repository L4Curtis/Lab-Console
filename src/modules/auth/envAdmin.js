/**
 * The local administrator defined in the environment: the first account
 * provider (see accounts.js). One account, signed in with a user name, a
 * password and a one-time code, all three at once
 *
 * It exists so that someone can always get in: when the identity provider is
 * down, misconfigured, or not set up yet. Because it does not depend on
 * anything else it is also the most exposed door, hence:
 *   - the password is only known as a scrypt hash,
 *   - the one-time code is mandatory, and a time step that was accepted is
 *     dead, even across a restart,
 *   - every check runs on every attempt, in constant time, and the caller
 *     gets a single yes or no: nothing tells which of the three was wrong,
 *     nor whether the user name exists
 */
import { createUser } from './user.js';
import { parseHash, verifyPassword, safeEqual } from './password.js';
import { base32Decode, verifyTotp } from './totp.js';

export function createEnvAdminProvider({ settings, store, logger, now = Date.now }) {
  const log = logger ?? { warn() {}, error() {} };
  const hash = parseHash(settings.passwordHash);
  const key = base32Decode(settings.totpSecret);
  if (!hash || key.length < 16) throw new Error('The local administrator settings are invalid (run "npm run setup-admin")');
  const user = createUser({ id: `local:${settings.username}`, username: settings.username, name: settings.username, role: 'admin', via: 'local' });

  // The last accepted time step survives a restart, so a code cannot be
  // replayed by restarting the service inside its 90-second validity
  const state = store.json('auth/local-admin.json', { lastTotpStep: -1 });
  let lastStep = -1;
  try {
    const saved = Number(state.get()?.lastTotpStep);
    if (Number.isInteger(saved)) lastStep = saved;
  } catch (err) {
    log.error(`local administrator state could not be read: ${err.message}`);
  }

  return {
    id: 'env-admin',
    user,

    /** → { user } when all three are right, null otherwise. Same work in every case */
    async verify({ username, password, code }) {
      const nameOk = safeEqual(typeof username === 'string' ? username.trim() : '', settings.username);
      const passwordOk = await verifyPassword(password, hash);
      // Read after the await: two attempts in flight must not both accept the same code
      const step = verifyTotp(key, typeof code === 'string' ? code : '', { timeMs: now(), after: lastStep });
      if (!(nameOk && passwordOk && step !== null)) return null;

      // Burn the code only on a complete success: a stranger who guesses or
      // sees a code must not be able to lock the real administrator out with it
      lastStep = step;
      await state.set({ lastTotpStep: step }).catch((err) => log.error(`local administrator state could not be saved: ${err.message}`));
      return { user };
    },
  };
}
