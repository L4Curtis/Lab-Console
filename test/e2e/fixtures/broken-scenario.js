/**
 * A scenario that goes wrong on purpose, run as a child process by
 * teardown.e2e.js to prove the harness cleans up after it. Not matched by
 * the e2e glob. BROKEN=fail: a test fails; BROKEN=signal: it hangs until the
 * parent sends SIGTERM. It prints what the parent must find gone afterwards
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs } from '../harness.js';

const h = useHarness();

test('goes wrong on purpose', async () => {
  const page = await h.newPage();
  await signInAs(page, 'alice');
  console.log(`HARNESS ${JSON.stringify({ dataDir: h.app.dataDir, marker: h.marker })}`);
  if (process.env.BROKEN === 'signal') await new Promise(() => {}); // until killed
  assert.fail('this scenario fails on purpose');
});
