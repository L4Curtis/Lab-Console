/**
 * A software authenticator for tests: what a browser and a passkey would
 * send back to the server, built by hand with node:crypto
 *
 *   const key = new SoftAuthenticator({ origin: lab.url });
 *   const response = key.register(optionsJSON);          // RegistrationResponseJSON
 *   const response = key.authenticate(optionsJSON);      // AuthenticationResponseJSON
 *
 * Options (each call): origin (the page that asked: a wrong one is what a
 * phishing site would produce), rpId, userVerified, credential (which one
 * to use when several were registered). Keys are ES256 (P-256), attestation
 * "none", like most passkeys. Only what the server checks is implemented
 */
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** Just enough CBOR (RFC 8949) for an attestation object and a COSE key */
export function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const s = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  if (value && typeof value === 'object') return cbor(new Map(Object.entries(value)));
  throw new TypeError(`cbor: cannot encode ${typeof value}`);
}

const FLAGS = { up: 0x01, uv: 0x04, at: 0x40 };

export class SoftAuthenticator {
  constructor({ origin, rpId = new URL(origin).hostname } = {}) {
    this.origin = origin;
    this.rpId = rpId;
    this.credentials = []; // { id, privateKey, userHandle, counter }
  }

  #authData({ rpId, userVerified, counter, attested }) {
    const flags = FLAGS.up | (userVerified ? FLAGS.uv : 0) | (attested ? FLAGS.at : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
  }

  /**
   * Answer navigator.credentials.create(options). `credential`: present one
   * this authenticator already holds again (what a real one refuses to do,
   * and what the server must refuse when it comes)
   */
  register(options, { origin = this.origin, rpId = this.rpId, userVerified = true, credential: again } = {}) {
    const { privateKey, publicKey } = again
      ? { privateKey: again.privateKey, publicKey: crypto.createPublicKey(again.privateKey) }
      : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = again ? Buffer.from(again.id, 'base64url') : crypto.randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, id, cose]);
    const authData = this.#authData({ rpId, userVerified, counter: 0, attested });
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const credential = again ?? { id: b64url(id), privateKey, userHandle: options.user.id, counter: 0 };
    if (!again) this.credentials.push(credential);
    return {
      id: credential.id,
      rawId: credential.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Answer navigator.credentials.get(options) with a credential of this authenticator */
  authenticate(options, { origin = this.origin, rpId = this.rpId, userVerified = true, credential } = {}) {
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const chosen = credential ?? this.credentials.find((c) => !allowed.length || allowed.includes(c.id));
    if (!chosen) throw new Error('no credential of this authenticator is allowed');
    chosen.counter += 1;
    const authData = this.#authData({ rpId, userVerified, counter: chosen.counter });
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), chosen.privateKey);
    return {
      id: chosen.id,
      rawId: chosen.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: chosen.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
