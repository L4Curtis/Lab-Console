/**
 * Bench checks, the refusals that need their own application: the per-person
 * rate limit, a bench with no device or no router to check
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startChecksApp } from './helpers/checks.js';

describe('rate limit', () => {
  let c;
  before(async () => {
    c = await startChecksApp({ checks: { perMinute: 2 } });
    await c.holdBench('student1');
  });
  after(async () => { await c?.close(); });

  test('a person starts a few checks a minute, then waits; the count is per person', { timeout: 60_000 }, async () => {
    const B = '/api/checks/benches/B4M';
    for (let i = 0; i < 2; i++) {
      assert.equal((await c.api('student1', 'POST', `${B}/interfaces`)).status, 202);
      assert.equal((await c.api('student1', 'POST', `${B}/cancel`)).status, 200);
      await c.until('B4M', 'interfaces');
    }
    const third = await c.api('student1', 'POST', `${B}/interfaces`);
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'checks.rate_limited');
    assert.equal(third.body.params.max, 2);
    assert.equal(c.runner.running('B4M'), null, 'nothing started');
    // Someone else is not counted with them
    const admin = await c.api('admin', 'POST', `${B}/interfaces`);
    assert.equal(admin.status, 202, JSON.stringify(admin.body));
    await c.api('admin', 'POST', `${B}/cancel`);
    await c.until('B4M', 'interfaces');
  });
});

describe('nothing to check', () => {
  let c;
  before(async () => {
    // Every console of B4M is outside the allow-list: the bench has nothing a check may reach
    c = await startChecksApp({ env: { ALLOWED_CONSOLE_HOSTS: '10.22.9.212' } });
  });
  after(async () => { await c?.close(); });

  test('no device, no router: refused before anything starts', async () => {
    for (const kind of ['lines', 'cabling', 'interfaces']) {
      const r = await c.api('admin', 'POST', `/api/checks/benches/B4M/${kind}`);
      assert.equal(r.status, 400, kind);
      assert.equal(r.body.code, 'checks.no_devices');
    }
    const ping = await c.api('admin', 'POST', '/api/checks/benches/B4M/ping');
    assert.equal(ping.status, 400);
    assert.equal(ping.body.code, 'checks.no_routers');
    assert.equal(c.runner.running('B4M'), null);
  });
});
