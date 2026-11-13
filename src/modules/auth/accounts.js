/**
 * Local sign-in goes through account providers
 *
 * A provider is a small object:
 *
 *   {
 *     id: 'env-admin',
 *     async verify({ username, password, code }) → { user } | null
 *   }
 *
 * The first one is the administrator of the environment (envAdmin.js).
 * Later ones (the directory of the accounts module: accounts created through
 * invitations) are added with auth.accounts.add(provider) and need no change
 * here. A provider that wants a further proof before a session is opened (a
 * passkey, for an account promoted to administrator) answers
 * `{ user, requires: ['passkey'] }` or `['passkey-enrol']`: the sign-in then
 * continues as a step (auth.steps, index.js) instead of opening a session.
 *
 * The contract every provider keeps: the same work, the same answer and the
 * same time whether or not the user name exists (hash a dummy password for
 * an unknown name). Every provider is asked on every attempt, so the time an
 * answer takes does not say which one knows the name either
 */
export function createAccountProviders(initial = []) {
  const providers = [];

  const add = (provider) => {
    if (!provider || typeof provider.verify !== 'function' || !provider.id) throw new TypeError('An account provider needs an id and verify()');
    if (providers.some((p) => p.id === provider.id)) throw new Error(`Account provider "${provider.id}" is already registered`);
    providers.push(provider);
    return () => {
      const i = providers.indexOf(provider);
      if (i !== -1) providers.splice(i, 1);
    };
  };
  for (const provider of initial) add(provider);

  return {
    add,
    get ids() { return providers.map((p) => p.id); },

    /** → { user, requires } from the one provider that recognises these credentials, or null */
    async verify(credentials, { logger } = {}) {
      const answers = await Promise.all(providers.map((p) => Promise.resolve()
        .then(() => p.verify(credentials))
        .catch((err) => {
          logger?.error(`account provider ${p.id} failed: ${err.message}`);
          return null;
        })));
      const matches = answers.filter((a) => a?.user);
      // Two providers claiming the same credentials is a configuration error, never a sign-in
      if (matches.length !== 1) return null;
      const [{ user, requires }] = matches;
      return { user, requires: Array.isArray(requires) ? requires.filter((r) => typeof r === 'string') : [] };
    },
  };
}
