/**
 * Test helper: the real application on an ephemeral port, with the real
 * sign-in, a temporary data directory and a jump server that is never
 * contacted (nothing connects until a console is opened)
 *
 *   const lab = await startTestApp();          // { url, wsUrl, app, deps, config, as(), signIn(), close() }
 *   await fetch(`${lab.url}/api/modules`, { headers: lab.as('student1') });   // or 'admin', or a User
 *   await fetch(`${lab.url}/api/modules`);                                    // nobody: 401
 *   new WebSocket(`${lab.wsUrl}/ws/console?…`, { headers: { origin: lab.url, ...lab.as('admin') } });
 *   await lab.close();                         // always, in an after() hook
 *
 * There is no switch that turns authentication off. `lab.as(who)` opens a
 * real session in the session store (what a successful sign-in does) and
 * returns the Cookie header that carries it; `lab.signIn(user)` does the same
 * and also returns the session id. To go through the sign-in forms
 * themselves, use TEST_ADMIN with adminCode(), or the mock identity provider
 *
 * `env` overrides any variable; the configuration is read again on each call,
 * so one test file can start several differently configured applications
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base32Decode, totp } from '../../src/modules/auth/totp.js';
import { student, admin } from './fakes.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const silentLogger = () => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log;
};

/**
 * The local administrator of every test application. The hash is the one of
 * `password`, with the cheapest scrypt cost the platform accepts so that the
 * suite stays fast; the secret is the RFC 6238 test key
 */
export const TEST_ADMIN = Object.freeze({
  username: 'root',
  password: 'test-admin-password',
  passwordHash: 'scrypt:16384:8:1:wO1_uOeXU78FE8g_3_KlUg:_5HOdJZV9ljKqQHPJa9YLu3RTF9gJxP9Wto1mf-QNO0',
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
});

/** The code the administrator's authenticator shows at `timeMs` */
export const adminCode = (timeMs = Date.now()) => totp(base32Decode(TEST_ADMIN.totpSecret), timeMs);

/** A minimal valid environment; nothing in it points at a real machine */
export function baseEnv(dataDir) {
  return {
    ENV_FILE: path.join(dataDir, 'no-such.env'), // never pick up a developer's .env
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_URL: 'http://127.0.0.1', // startTestApp replaces it with the address really bound
    LOCAL_ADMIN_USERNAME: TEST_ADMIN.username,
    LOCAL_ADMIN_PASSWORD_HASH: TEST_ADMIN.passwordHash,
    LOCAL_ADMIN_TOTP_SECRET: TEST_ADMIN.totpSecret,
    OIDC_ISSUER: '',
    OIDC_CLIENT_ID: '',
    OIDC_CLIENT_SECRET: '',
    OIDC_CLIENT_AUTH_METHOD: '',
    OIDC_SCOPES: '',
    OIDC_GROUPS_CLAIM: '',
    OIDC_ADMIN_GROUPS: '',
    OIDC_ALLOWED_GROUPS: '',
    OIDC_PROVIDER_NAME: '',
    OIDC_ALLOW_INSECURE: '',
    DATA_DIR: dataDir,
    SSH_HOST: '127.0.0.1',
    SSH_PORT: '1',
    SSH_USERNAME: 'test',
    SSH_PASSWORD: 'test',
    DIAGRAM_PATH: path.join(repoRoot, 'diagrams', 'diagram.drawio'),
    INFRA_CONFIG_PATH: path.join(repoRoot, 'config', 'infrastructure.json'),
    PROXMOX_URL: '',
    TRUST_PROXY: '',
    TRUSTED_PROXIES: '',
    DEFAULT_LOCALE: '',
    ALLOWED_ORIGINS: '',
  };
}

export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lab-console-test-'));
}

/** Apply `env` to process.env and return a function that puts everything back */
export function withEnv(env) {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * Read a configuration from baseEnv + overrides, without touching the
 * caller's environment. Nothing is created on disk: the default DATA_DIR is
 * only a path (startTestApp passes a real temporary directory)
 */
export async function loadTestConfig(env = {}, dataDir = path.join(os.tmpdir(), `lab-console-test-${process.pid}-unused`)) {
  const restoreBase = withEnv(baseEnv(dataDir));
  try {
    // src/config.js also evaluates the environment when it is first imported,
    // and exits the process if it is invalid: import it under the valid base
    const { loadConfig } = await import('../../src/config.js');
    const restore = withEnv(env);
    try {
      return loadConfig();
    } finally {
      restore();
    }
  } finally {
    restoreBase();
  }
}

/** A port that was free a moment ago: PUBLIC_URL must be known before the application listens */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const KNOWN_USERS = { student1: () => student(1), student2: () => student(2), student3: () => student(3), admin: () => admin() };

/**
 * Options: env (variables), auth (a factory replacing createAuth: only
 * fakeAuth() from fakes.js, kept for tests written before the sign-in
 * existed), modules (a factory replacing the module list, e.g.
 * `(deps) => [createMyModule(deps)]`), logger, now (a clock for the sign-in
 * module: `now: () => clock.ms`)
 */
export async function startTestApp({ env = {}, logger = silentLogger, auth, modules, now } = {}) {
  const dataDir = tempDataDir();
  const { createApp } = await import('../../src/server.js');
  const { createAuth } = await import('../../src/modules/auth/index.js');
  const makeAuth = auth ?? (now ? (deps) => createAuth({ ...deps, now }) : undefined);

  let lab;
  let config;
  let port;
  for (let attempt = 1; ; attempt++) {
    port = env.PORT ? Number(env.PORT) : await freePort();
    config = await loadTestConfig({ PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, ...env }, dataDir);
    lab = await createApp({ config, logger, createAuth: makeAuth, createModules: modules });
    try {
      await lab.listen();
      break;
    } catch (err) {
      await lab.close();
      // Another test process took the port between the probe and the bind: pick another
      if (err.code !== 'EADDRINUSE' || attempt >= 5 || env.PORT) {
        fs.rmSync(dataDir, { recursive: true, force: true });
        throw err;
      }
    }
  }

  const url = `http://127.0.0.1:${port}`;
  const opened = new Map(); // user id → Cookie header

  /** Open a session for `user` (a name from KNOWN_USERS or a User), as a successful sign-in would */
  function signIn(who = 'admin') {
    const user = typeof who === 'string' ? KNOWN_USERS[who]?.() : who;
    if (!user?.id) throw new TypeError(`Unknown test user "${who}" (student1, student2, student3, admin, or a User)`);
    const { id, token, cookie } = lab.deps.auth.sessions.create(user, { ip: '127.0.0.1', userAgent: 'test' });
    return { id, token, cookie, user, headers: { cookie } };
  }

  return {
    ...lab,
    config,
    dataDir,
    port,
    url,
    wsUrl: `ws://127.0.0.1:${port}`,
    signIn,
    /** Headers of a signed-in user; the same session is reused for the same user */
    as(who = 'admin') {
      const key = typeof who === 'string' ? who : who.id;
      if (!opened.has(key)) opened.set(key, signIn(who).cookie);
      return { cookie: opened.get(key) };
    },
    async close() {
      await lab.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
