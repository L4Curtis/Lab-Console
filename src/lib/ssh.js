/**
 * Jump-server connection settings shared by every SSH user in the platform:
 * lab/admin-switch consoles (one exec channel each) and the Proxmox tunnel
 * (forwardOut channels); One place for credentials and host-key pinning
 */
import crypto from 'node:crypto';

let warnedUnpinned = false;

export function sshConnectOptions(ssh, log) {
  return {
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    password: ssh.password,
    privateKey: ssh.privateKey,
    passphrase: ssh.passphrase,
    readyTimeout: ssh.readyTimeoutMs,
    keepaliveInterval: ssh.keepaliveIntervalMs,
    hostVerifier: (key) => verifyHostKey(key, ssh, log),
  };
}

function verifyHostKey(key, ssh, log) {
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  if (!ssh.hostFingerprint) {
    if (!warnedUnpinned) {
      warnedUnpinned = true;
      log.warn(`SSH_HOST_FINGERPRINT is not set - jump server identity is NOT verified. Observed: ${fingerprint}`);
    }
    return true;
  }
  const ok = fingerprint === ssh.hostFingerprint.trim();
  if (!ok) log.error(`Jump server host key mismatch! expected ${ssh.hostFingerprint}, got ${fingerprint}`);
  return ok;
}

/**
 * Why an SSH connection to the jump server failed: the English sentence plus a
 * stable `code` and `params` for the browser to translate (ARCHITECTURE §4)
 */
export function sshErrorInfo(err, ssh) {
  const host = ssh.host;
  if (err.level === 'client-authentication') return { code: 'consoles.ssh_rejected', params: {}, message: 'Jump server rejected the SSH credentials (check SSH_USERNAME / SSH_PASSWORD)' };
  if (err.code === 'ECONNREFUSED') return { code: 'consoles.ssh_refused', params: { host, port: ssh.port }, message: `Jump server ${ssh.host}:${ssh.port} refused the connection` };
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) return { code: 'consoles.ssh_timeout', params: { host }, message: `Jump server ${ssh.host} did not answer in time` };
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return { code: 'consoles.ssh_unreachable', params: { host }, message: `Jump server ${ssh.host} is unreachable from the platform` };
  if (/host key|verification/i.test(err.message)) return { code: 'consoles.ssh_identity', params: {}, message: 'Jump server identity check failed (SSH_HOST_FINGERPRINT mismatch)' };
  return { code: 'consoles.ssh_error', params: { detail: err.message }, message: `SSH error: ${err.message}` };
}

export const describeSshError = (err, ssh) => sshErrorInfo(err, ssh).message;
