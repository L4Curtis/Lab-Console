/**
 * The SSH connection pool against the mock jump server, which refuses a
 * channel past its MaxSessions like sshd: lines share connections, never
 * more channels per connection than allowed, a refused channel moves to
 * another connection, a dead connection is replaced, and nothing leaks when
 * the lines close
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLab } from '../dev/mock-lab.js';
import { SshPool } from '../src/lib/sshPool.js';
import { silentLogger } from './helpers/app.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const sshTo = (port, extra = {}) => ({ host: '127.0.0.1', port, ...SSH, readyTimeoutMs: 5000, keepaliveIntervalMs: 0, ...extra });

/** A console line through the pool: resolves the stream once the telnet banner shows */
async function line(pool, ssh, port) {
  let text = '';
  const stream = await pool.exec(ssh, `telnet 10.22.9.4 ${port}`, { pty: { term: 'xterm' } }, (s) => s.on('data', (d) => { text += d; }));
  await until(() => /Escape character|Connection refused/.test(text));
  return stream;
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const closeAll = (streams) => Promise.all(streams.map((s) => new Promise((r) => { s.once('close', r); s.close(); })));

test('pool: lines share connections, each under the jump server\'s MaxSessions', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH, maxSessions: 3 });
  const pool = new SshPool({ channelsPerConnection: 3, idleMs: 50, logger: silentLogger() });
  try {
    // Seven lines opened at once: three connections (3 + 3 + 1), not seven
    const streams = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => line(pool, sshTo(lab.port), 2000 + n)));
    assert.equal(lab.stats().connections, 3);
    assert.equal(lab.stats().channels, 7);
    assert.equal(lab.stats().peakChannels, 3, 'never more than MaxSessions on one connection');
    assert.equal(lab.stats().refusedChannels, 0);
    assert.deepEqual(pool.stats().map((s) => s.channels).sort(), [1, 3, 3]);
    assert.ok(!JSON.stringify(pool.stats()).includes(SSH.password), 'the password is not part of what the pool shows');

    // Closing lines gives the slots back; an eighth line reuses a slot
    await closeAll(streams.slice(0, 3));
    await until(() => pool.size.channels === 4);
    const again = await line(pool, sshTo(lab.port), 2010);
    assert.ok(lab.stats().connections <= 3);

    // No leak: everything closed → no channel, and the idle connections go away
    await closeAll([...streams.slice(3), again]);
    await until(() => pool.size.connections === 0 && lab.stats().connections === 0);
    assert.equal(lab.stats().channels, 0);
  } finally {
    pool.close();
    await lab.close();
  }
});

test('pool: a jump server with a lower MaxSessions than ours caps the connection and the line goes elsewhere', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH, maxSessions: 2 });
  const pool = new SshPool({ channelsPerConnection: 5, idleMs: 0, logger: silentLogger() });
  try {
    const streams = [];
    for (let n = 1; n <= 4; n++) streams.push(await line(pool, sshTo(lab.port), 2000 + n));
    assert.equal(lab.stats().channels, 4, 'every line got its channel');
    assert.ok(lab.stats().refusedChannels >= 1, 'the server said no once');
    assert.equal(lab.stats().peakChannels, 2);
    assert.equal(lab.stats().connections, 2);
    await closeAll(streams);
    await until(() => lab.stats().connections === 0);
  } finally {
    pool.close();
    await lab.close();
  }
});

test('pool: a connection that dies is replaced; settings that change open a new connection', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH });
  const other = await startMockLab({ port: 0, ssh: { username: 'jump2', password: 'other' } });
  const pool = new SshPool({ channelsPerConnection: 8, idleMs: 0, logger: silentLogger() });
  try {
    const first = await line(pool, sshTo(lab.port), 2001);
    const closed = new Promise((r) => first.once('close', r));
    // The jump server goes away under the line: it ends, and the pool forgets the connection
    await lab.close();
    await closed;
    await until(() => pool.size.connections === 0);

    // The administrator points the platform at another jump server: the next line goes there
    const moved = await line(pool, sshTo(other.port, { username: 'jump2', password: 'other' }), 2002);
    assert.equal(other.stats().connections, 1);
    await closeAll([moved]);
  } finally {
    pool.close();
    await other.close();
  }
});

test('pool: a jump server that refuses us rejects with the connection error; a closed pool refuses at once', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH });
  const pool = new SshPool({ logger: silentLogger() });
  try {
    await assert.rejects(pool.exec(sshTo(lab.port, { password: 'wrong' }), 'telnet 10.22.9.4 2001'), (err) => err.level === 'client-authentication');
    await assert.rejects(pool.exec(sshTo(1), 'telnet 10.22.9.4 2001'), (err) => err.code === 'ECONNREFUSED');
    assert.equal(pool.size.connections, 0, 'failed connections are not kept');
    pool.close();
    await assert.rejects(pool.exec(sshTo(lab.port), 'telnet 10.22.9.4 2001'), { code: 'POOL_CLOSED' });
  } finally {
    pool.close();
    await lab.close();
  }
});

test('pool: a connection carries at least one channel', () => {
  assert.throws(() => new SshPool({ channelsPerConnection: 0 }), /positive integer/);
});
