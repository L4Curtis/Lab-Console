/**
 * Authentication settings (configuration fragment, see ARCHITECTURE §3)
 *
 * This build only ships the anonymous implementation: AUTH_MODE=off. The
 * default stays "on" so that a deployment never runs open by accident - it
 * refuses to start until the operator either sets AUTH_MODE=off on purpose or
 * installs a build that has the login
 */
import { oneOf, fail } from '../../lib/env.js';

export function readConfig() {
  const mode = oneOf('AUTH_MODE', ['on', 'off'], 'on');
  if (mode === 'on') {
    fail('AUTH_MODE=on (the default) needs the sign-in module, which this build does not include yet. '
      + 'Set AUTH_MODE=off to run without login: every visitor is then an anonymous administrator, '
      + 'so keep the platform behind an access-controlled proxy');
  }
  return { mode };
}
