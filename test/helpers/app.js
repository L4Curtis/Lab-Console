/**
 * Test helper: the real application on an ephemeral port, with the anonymous
 * auth, a temporary data directory and a jump server that is never contacted
 * (nothing connects until a console is opened)
 *
 *   const lab = await startTestApp();          // { url, wsUrl, app, deps, config, close() }
 *   const lab = await startTestApp({ auth: fakeAuth() });   // then send `x-test-user: student1`
 *   const res = await fetch(`${lab.url}/api/health`);
 *   await lab.close();                         // always, in an after() hook
 *
 * `env` overrides any variable; the configuration is read again on each call,
 * so one test file can start several differently configured applications
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const silentLogger = () => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log;
};

/** A minimal valid environment; nothing in it points at a real machine */
export function baseEnv(dataDir) {
  return {
    ENV_FILE: path.join(dataDir, 'no-such.env'), // never pick up a developer's .env
    HOST: '127.0.0.1',
    PORT: '0',
    AUTH_MODE: 'off',
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
    PUBLIC_URL: '',
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

/**
 * Options: env (variables), auth (a factory such as fakeAuth() from fakes.js,
 * to test as a student, an admin or nobody), modules (a factory replacing the
 * module list, e.g. `(deps) => [createMyModule(deps)]`), logger
 */
export async function startTestApp({ env = {}, logger = silentLogger, auth, modules } = {}) {
  const dataDir = tempDataDir();
  const config = await loadTestConfig(env, dataDir);
  const { createApp } = await import('../../src/server.js');
  const lab = createApp({ config, logger, createAuth: auth, createModules: modules });
  const { port } = await lab.listen();
  return {
    ...lab,
    config,
    dataDir,
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    async close() {
      await lab.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
