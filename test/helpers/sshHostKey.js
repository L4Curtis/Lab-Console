/**
 * An ed25519 host key for the small SSH servers some tests start, made once
 * per process. ssh2's generator writes now and then a key its own parser
 * refuses ("Malformed OpenSSH private key", about one in a few hundred):
 * keep only a key that parses back, as dev/mock-lab.js does.
 *   new ssh2.Server({ hostKeys: [testHostKey()] }, …)
 */
import ssh2 from 'ssh2';

let key = null;

export function testHostKey() {
  while (!key) {
    const candidate = ssh2.utils.generateKeyPairSync('ed25519').private;
    if (!(ssh2.utils.parseKey(candidate) instanceof Error)) key = candidate;
  }
  return key;
}
