/**
 * Passkeys (WebAuthn), through @simplewebauthn/server
 *
 * The relying party is the host of PUBLIC_URL and the only accepted origin is
 * PUBLIC_URL itself. Browsers only offer WebAuthn to a secure context with a
 * domain name, so passkeys are offered when PUBLIC_URL is https on a name -
 * or http://localhost, for tests and for a developer's machine - and refused
 * otherwise (an http address on the LAN, a bare IP address).
 *
 * A ceremony (a registration or a sign-in) starts with a challenge chosen by
 * the server, kept here and nowhere else: 5 minutes, single use, bound to
 * the browser that asked for it by an HttpOnly cookie, and to what it was
 * asked for (the account adding a passkey, the account finishing a sign-in).
 * A response is checked against the challenge it was given for, which is
 * forgotten before the check: a replayed response finds nothing.
 *
 *   const rp = relyingParty(publicUrl)      // { available, rpID, origin, name }
 *   const ceremonies = createCeremonies({ now })
 *   registrationOptions(rp, account, …) / verifyRegistration(rp, ceremony, response)
 *   authenticationOptions(rp, { credentials, userVerification }) / verifyAuthentication(rp, ceremony, response, passkey)
 */
import net from 'node:net';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { createPendingLogins } from '../auth/pendingLogins.js';

export const CEREMONY_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 2 * 60_000; // what the browser is told; the server keeps the challenge longer
const RP_NAME = 'Lab Console';

/** A refused ceremony; `reason` is for the server log and the audit trail, never for the browser */
export class PasskeyError extends Error {
  constructor(reason, message, cause) {
    super(message);
    this.name = 'PasskeyError';
    this.reason = reason;
    this.cause = cause;
  }
}

/** Where passkeys live, derived from PUBLIC_URL */
export function relyingParty(publicUrl) {
  const url = new URL(publicUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const available = (url.protocol === 'https:' && !net.isIP(hostname)) || (url.protocol === 'http:' && hostname === 'localhost');
  return Object.freeze({ available, rpID: hostname, origin: url.origin, name: RP_NAME });
}

/** Challenges waiting for their answer (see the header); the id goes in the browser's cookie */
export function createCeremonies({ now = Date.now } = {}) {
  return createPendingLogins({ ttlMs: CEREMONY_TTL_MS, max: 5000, perOwner: 20, now });
}

const transportsOf = (response) => (Array.isArray(response?.response?.transports)
  ? response.response.transports.filter((t) => typeof t === 'string').slice(0, 8)
  : []);

/** Options for navigator.credentials.create(): a passkey for `account` (a local account of the directory) */
export function registrationOptions(rp, account) {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.rpID,
    userName: account.username,
    userDisplayName: account.name,
    userID: Buffer.from(account.webauthnUserId, 'base64url'),
    timeout: TIMEOUT_MS,
    attestationType: 'none',
    // The same authenticator twice is useless; the browser says so before asking
    excludeCredentials: (account.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports })),
    // Discoverable, so that the passkey alone can sign in (one click on the login page)
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

/** Check a registration response. → the passkey to store ({ id, publicKey, counter, transports, … }) */
export async function verifyRegistration(rp, ceremony, response) {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    throw new PasskeyError('invalid_response', `registration refused: ${err.message}`, err);
  }
  if (!result.verified) throw new PasskeyError('not_verified', 'registration not verified');
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports?.length ? credential.transports : transportsOf(response),
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

/**
 * Options for navigator.credentials.get(). Without `credentials` the browser
 * offers every passkey it has for this site (one-click sign-in); with them,
 * only those (the step after a password)
 */
export function authenticationOptions(rp, { credentials = [], userVerification = 'preferred' } = {}) {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: TIMEOUT_MS,
    userVerification,
    allowCredentials: credentials.map((p) => ({ id: p.id, transports: p.transports })),
  });
}

/**
 * Check a sign-in response made with `passkey` (as stored). `requireUserVerification`:
 * a passkey that signs in alone must have checked its user (PIN, fingerprint).
 * → { counter, backedUp }
 */
export async function verifyAuthentication(rp, ceremony, response, passkey, { requireUserVerification = true } = {}) {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification,
    });
  } catch (err) {
    throw new PasskeyError('invalid_response', `sign-in refused: ${err.message}`, err);
  }
  if (!result.verified) throw new PasskeyError('not_verified', 'sign-in not verified');
  return { counter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp };
}

/** The credential id a response names, if it looks like one */
export const credentialIdOf = (response) => (typeof response?.id === 'string' && /^[A-Za-z0-9_-]{16,1366}$/.test(response.id) ? response.id : null);
