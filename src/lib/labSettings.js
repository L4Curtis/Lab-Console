/**
 * The "lab" settings namespace: how Lab Console reaches the consoles
 *
 *   ssh       the jump server (host, port, user, password or key, host key fingerprint)
 *   telnet    the console server's own login, answered by the application
 *   consoles  which console addresses may be dialled (hosts, port range)
 *
 * Values have the shapes of config.ssh, config.telnet and config.consoles
 * (ARCHITECTURE §6); the fields below are the ones the administration page
 * may change. The rest (timeouts, the Proxmox tunnel's transport, the
 * diagram's network prefix) stays with the environment.
 */
import net from 'node:net';
import ssh2 from 'ssh2';

const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/;
const USER = /^[^\s:@/\\]{1,64}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const isHost = (v) => HOST.test(v) || net.isIP(v) !== 0;
const hostPattern = { test: isHost };

function keyProblem(privateKey, passphrase) {
  if (!privateKey) return null;
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(privateKey)) return 'key_format';
  try {
    const parsed = ssh2.utils.parseKey(privateKey, passphrase || undefined);
    if (parsed instanceof Error) return /passphrase/i.test(parsed.message) ? 'key_passphrase' : 'key_format';
  } catch {
    return 'key_format';
  }
  return null;
}

export function labSettings(config) {
  return {
    defaults: () => ({
      // A key read from SSH_PRIVATE_KEY_PATH is a Buffer: settings are JSON, ssh2 takes the text too
      ssh: { ...config.ssh, ...(config.ssh.privateKey ? { privateKey: Buffer.from(config.ssh.privateKey).toString('utf8') } : {}) },
      telnet: { ...config.telnet },
      consoles: { ...config.consoles, allowedHosts: [...config.consoles.allowedHosts], portRange: { ...config.consoles.portRange } },
    }),
    fields: {
      'ssh.host': { type: 'string', required: true, pattern: hostPattern },
      'ssh.port': { type: 'int', min: 1, max: 65535 },
      'ssh.username': { type: 'string', required: true, pattern: USER },
      'ssh.password': { type: 'secret', max: 256 },
      'ssh.privateKey': { type: 'secret', max: 16 * 1024, multiline: true },
      'ssh.passphrase': { type: 'secret', max: 256 },
      'ssh.hostFingerprint': { type: 'string', pattern: FINGERPRINT },
      'telnet.username': { type: 'string', pattern: USER },
      'telnet.password': { type: 'secret', max: 256 },
      'telnet.autoLogin': { type: 'bool' },
      'telnet.wakeIdleMs': { type: 'int', min: 0, max: 30_000 },
      'consoles.allowedHosts': { type: 'list', required: true, pattern: hostPattern, maxItems: 20 },
      'consoles.portRange': { type: 'range', min: 1, max: 65535 },
    },
    /** Rules across fields, on the values that would apply */
    check(values) {
      const problems = [];
      if (!values.ssh.password && !values.ssh.privateKey) problems.push({ field: 'ssh.password', code: 'credentials_required' });
      const key = keyProblem(values.ssh.privateKey, values.ssh.passphrase);
      if (key) problems.push({ field: key === 'key_passphrase' ? 'ssh.passphrase' : 'ssh.privateKey', code: key });
      return problems;
    },
  };
}
