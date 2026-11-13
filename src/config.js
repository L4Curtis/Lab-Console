/**
 * Central configuration, loaded once from environment variables (.env)
 *
 * Every value is validated at startup so a misconfigured deployment fails
 * immediately with a readable message instead of failing later inside a
 * student's terminal
 *
 * The object is assembled from fragments. The platform's own settings are
 * read below; a module that needs settings exports readConfig() from
 * src/modules/<id>/config.js and gets one line in loadConfig(). Nothing else
 * reads the environment (see src/lib/env.js)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, takeErrors, fail, str, required, int, bool, list, portRange, oneOf, origin } from './lib/env.js';
import { parseTrustedProxies } from './lib/security.js';
import { readConfig as readAuthConfig } from './modules/auth/config.js';

export const LOCALES = Object.freeze(['fr', 'en']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Client addresses are only read from X-Forwarded-For behind these proxies.
 * The upstream TRUST_PROXY=true believed the header from any peer, so any
 * client could choose the address that the sign-in limits and the audit
 * trail see: a deployment that still sets it is refused, not silently changed
 */
function trustedProxies() {
  if (bool('TRUST_PROXY', false)) {
    fail('TRUST_PROXY=true is no longer supported: it let any client choose its own address. '
      + 'Remove it and list every proxy in front of Lab Console in TRUSTED_PROXIES instead (see docs/v2/AUTH.md, "Exposed to the Internet")');
  }
  const entries = list('TRUSTED_PROXIES');
  try {
    parseTrustedProxies(entries);
  } catch (err) {
    fail(`TRUSTED_PROXIES: ${err.message} (expected a comma list such as 192.168.10.112,10.0.0.0/8)`);
    return [];
  }
  return entries;
}

function readServerConfig() {
  return {
    host: str('HOST', '0.0.0.0'),
    port: int('PORT', 3000, { min: 0, max: 65535 }), // 0 = any free port (tests)
    // Public origin of the platform, e.g. https://lab.example.org: OIDC redirect
    // URIs and cookie security derive from it. Required
    publicUrl: origin('PUBLIC_URL'),
    trustedProxies: trustedProxies(),
    // Extra origins allowed to open terminal WebSockets (same-origin is always allowed)
    allowedOrigins: list('ALLOWED_ORIGINS'),
  };
}

function tunnelTransport() {
  const v = str('PROXMOX_TUNNEL_TRANSPORT', 'auto').toLowerCase();
  if (!['auto', 'forward', 'exec'].includes(v)) {
    fail('PROXMOX_TUNNEL_TRANSPORT must be auto, forward or exec');
    return 'auto';
  }
  return v;
}

// ── SSH jump server (credential set #1) ─────────────────────────────────────
function readSshConfig() {
  const privateKeyPath = str('SSH_PRIVATE_KEY_PATH');
  const sshPassword = str('SSH_PASSWORD');
  let privateKey;
  if (privateKeyPath) {
    try {
      privateKey = fs.readFileSync(path.resolve(privateKeyPath));
    } catch (e) {
      fail(`SSH_PRIVATE_KEY_PATH could not be read: ${e.message}`);
    }
  }
  if (!privateKeyPath && !sshPassword) fail('Set SSH_PASSWORD (or SSH_PRIVATE_KEY_PATH)');

  return {
    host: required('SSH_HOST'),
    port: int('SSH_PORT', 22, { min: 1, max: 65535 }),
    username: required('SSH_USERNAME'),
    password: sshPassword || undefined,
    privateKey,
    passphrase: str('SSH_KEY_PASSPHRASE') || undefined,
    // "SHA256:…" as printed by `ssh-keygen -lf`; Strongly recommended: pins the
    // jump server's identity and defeats man-in-the-middle attacks
    hostFingerprint: str('SSH_HOST_FINGERPRINT'),
    readyTimeoutMs: 15_000,
    keepaliveIntervalMs: 15_000,
    // How the Proxmox tunnel reaches the lab network through the jump server:
    //   auto    - try `ssh -L`-style forwarding, fall back to a relay command
    //             if the jump server forbids forwarding (recommended)
    //   forward - direct-tcpip only (fails if AllowTcpForwarding is off)
    //   exec    - always run a relay (socat/nc/bash), like the device consoles
    tunnelTransport: tunnelTransport(),
    // Optional explicit relay command for `exec`/`auto`, with {host}/{port}
    // placeholders, e.g. "socat - TCP:{host}:{port}". Empty = auto-detect.
    tunnelRelay: str('PROXMOX_TUNNEL_RELAY') || undefined,
  };
}

// ── Telnet console login (credential set #2) ────────────────────────────────
function readTelnetConfig() {
  return {
    username: str('TELNET_USERNAME'),
    password: str('TELNET_PASSWORD'),
    autoLogin: bool('TELNET_AUTOLOGIN', true),
    // Silence (ms) after telnet connects before one Enter is sent to wake an
    // idle console; Never sent if a prompt is visible. 0 disables it
    wakeIdleMs: int('TELNET_WAKE_IDLE_MS', 2500, { min: 0, max: 30_000 }),
  };
}

function readConsolesConfig() {
  return {
    // A label such as ".211 - 2001" resolves to `${networkPrefix}.211` port 2001
    networkPrefix: str('CONSOLE_NETWORK_PREFIX', '10.22.9').replace(/\.$/, ''),
    allowedHosts: list('ALLOWED_CONSOLE_HOSTS', ['10.22.9.211', '10.22.9.212']),
    portRange: portRange('ALLOWED_PORT_RANGE', '2000-2099'),
  };
}

// ── Proxmox VE API (credential set #3, ticket authentication) ───────────────
// Reached only through the SSH jump server (config.ssh), never directly
function readProxmoxConfig() {
  const url = str('PROXMOX_URL').replace(/\/+$/, '');
  if (!url) return { enabled: false };
  if (!/^https:\/\/[^/]+$/.test(url)) fail('PROXMOX_URL must look like https://10.22.9.71:8006 (no path)');
  const fingerprint = str('PROXMOX_FINGERPRINT').toUpperCase();
  if (fingerprint && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
    fail('PROXMOX_FINGERPRINT must be a SHA-256 fingerprint like AB:CD:… (32 pairs)');
  }
  return {
    enabled: true,
    url,
    username: required('PROXMOX_USERNAME'),
    realm: str('PROXMOX_REALM', 'pam'),
    password: required('PROXMOX_PASSWORD'),
    fingerprint,
  };
}

function readLimitsConfig() {
  return {
    maxSessions: int('MAX_SESSIONS', 40, { min: 1, max: 1000 }),
    maxSessionsPerClient: int('MAX_SESSIONS_PER_CLIENT', 6, { min: 1, max: 100 }),
    idleTimeoutMs: int('IDLE_TIMEOUT_MINUTES', 60, { min: 1, max: 24 * 60 }) * 60_000,
    opensPerMinute: 20, // per client IP; stops click-spam from hammering the jump host
  };
}

/** Freeze plain objects and arrays all the way down (Buffers such as the SSH key are left alone) */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

/**
 * APP_SECRET: the key material that encrypts secrets saved from the
 * administration pages (today the SSO client secret, data/auth/oidc.json).
 * Optional: without it they are kept in clear in files of mode 600
 */
function readAppSecret() {
  const value = str('APP_SECRET');
  if (value && value.length < 32) fail('APP_SECRET must be at least 32 characters long, e.g. the output of: openssl rand -base64 48');
  return value;
}

/**
 * Read the whole configuration from the environment. Throws a ConfigError
 * listing every problem; never returns a partly valid object
 */
export function loadConfig() {
  takeErrors(); // start from a clean list (tests load several configurations)

  const assembled = {
    server: readServerConfig(),

    // Writable state directory: the only place the platform writes to
    dataDir: path.resolve(str('DATA_DIR', './data')),
    // UI language for a first visit; the browser remembers the user's choice
    defaultLocale: oneOf('DEFAULT_LOCALE', LOCALES, 'fr'),
    // Encrypts the secrets saved from the administration pages (optional, see .env.example)
    appSecret: readAppSecret(),

    diagramPath: path.resolve(str('DIAGRAM_PATH', './diagrams/diagram.drawio')),
    ssh: readSshConfig(),
    telnet: readTelnetConfig(),
    consoles: readConsolesConfig(),
    // Admin switches (console devices outside the lab diagrams)
    infraConfigPath: path.resolve(str('INFRA_CONFIG_PATH', './config/infrastructure.json')),
    proxmox: readProxmoxConfig(),
    limits: readLimitsConfig(),

    // ── Module fragments: one line per module that has settings ─────────────
    auth: readAuthConfig(),
  };

  if (!assembled.server.publicUrl && !str('PUBLIC_URL')) {
    fail('PUBLIC_URL is required: the address users type, e.g. https://lab.example.org (sign-in redirects and cookie security derive from it)');
  }

  const problems = takeErrors();
  if (problems.length) throw new ConfigError(problems);
  return deepFreeze(assembled);
}

function loadOrExit() {
  loadEnvFile();
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`\n✖ ${err.message}\n`);
    console.error('  Copy .env.example to .env and fill in the values.\n');
    process.exit(1);
  }
}

export const config = loadOrExit();
