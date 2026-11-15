/**
 * dev/mock-lab.js as a library and as `npm run mock-lab`: a jump server on an
 * ephemeral port, the console server's login, devices that keep their state
 * between sessions, one session per console line, and the line probe
 * (`nc -z -w <s> <host> <port>`) a later lot uses to tell free lines from busy ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';
import { startMockLab } from '../dev/mock-lab.js';
import { repoRoot } from './helpers/app.js';

const SSH = { username: 'jump', password: 'jump-pass' };
const TELNET = { username: 'console', password: 'console-pass' };

function connect(port) {
  return new Promise((resolve, reject) => {
    const c = new ssh2.Client();
    c.on('ready', () => resolve(c)).on('error', reject).connect({ host: '127.0.0.1', port, ...SSH });
  });
}

/** Run a command; for telnet, returns a session to type into and read from */
function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: { term: 'xterm' } }, (err, stream) => {
      if (err) return reject(err);
      let text = '';
      const waiters = [];
      stream.on('data', (d) => { text += d.toString('latin1'); for (const w of [...waiters]) w(); });
      const exit = new Promise((r) => stream.on('exit', (code) => r(code)));
      resolve({
        stream, exit,
        get text() { return text; },
        type: (s) => stream.write(s),
        until: (re, ms = 3000) => new Promise((ok, ko) => {
          const check = () => { if (re.test(text)) { waiters.splice(waiters.indexOf(check), 1); clearTimeout(t); ok(text); } };
          const t = setTimeout(() => ko(new Error(`timed out waiting for ${re}; got ${JSON.stringify(text.slice(-300))}`)), ms);
          waiters.push(check);
          check();
        }),
        close: () => new Promise((r) => { stream.on('close', r); stream.close(); }),
      });
    });
  });
}

async function probe(client, port) {
  const s = await exec(client, `nc -z -w 3 10.22.9.4 ${port}`);
  return s.exit;
}

test('mock lab: ephemeral port, console server login, then the device; state survives the session', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, names: new Map([['10.22.9.4:2001', 'R1']]), devices: { '10.22.9.4:2001': { model: 'isr4331' } } });
  assert.ok(lab.port > 0);
  const client = await connect(lab.port);
  try {
    const s = await exec(client, 'telnet 10.22.9.4 2001');
    await s.until(/Escape character is '\^\]'\./);
    s.type('\r');
    await s.until(/Username: $/);
    s.type(`${TELNET.username}\r`);
    await s.until(/Password: $/);
    s.type(`${TELNET.password}\r`);
    s.type('\r');
    await s.until(/R1>$/);
    s.type('enable\rconfigure terminal\rhostname R7\rend\r');
    await s.until(/R7#$/);
    await s.close();

    assert.equal(lab.device('10.22.9.4:2001').cfg.hostname, 'R7');
    assert.equal(lab.device({ host: '10.22.9.4', port: 2001 }), lab.device('10.22.9.4:2001'), 'one device per console port');

    const again = await exec(client, 'telnet 10.22.9.4 2001');
    await again.until(/Escape character/);
    again.type(`\r${TELNET.username}\r`);
    await again.until(/Password: $/);
    again.type(`${TELNET.password}\r\r`);
    await again.until(/R7#$/, 3000);
    await again.close();
  } finally {
    client.end();
    await lab.close();
  }
});

test('mock lab: one session per line; the probe tells free lines from busy and down ones', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH, busyPorts: [2004], downPorts: [2003] });
  const client = await connect(lab.port);
  try {
    assert.equal(await probe(client, 2001), 0, 'free');
    assert.equal(await probe(client, 2003), 1, 'down');
    assert.equal(await probe(client, 2004), 1, 'busy outside the app');

    const first = await exec(client, 'telnet 10.22.9.4 2001');
    await first.until(/Escape character/);
    first.type('\r');
    await first.until(/Router>$/);
    assert.equal(await probe(client, 2001), 1, 'busy: a session is open');
    const second = await exec(client, 'telnet 10.22.9.4 2001');
    await second.until(/Connection refused/);
    assert.equal(await second.exit, 1);

    await first.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await probe(client, 2001), 0, 'free again once closed');

    const bad = await exec(client, 'nc -z -w 3 10.22.9.4 2001; reboot');
    assert.equal(await bad.exit, 127, 'only the exact probe form is accepted');
  } finally {
    client.end();
    await lab.close();
  }
});

test('mock lab: a strict console server hangs up on an empty login; BREAK during a boot reaches ROMMON', async () => {
  const lab = await startMockLab({ port: 0, ssh: SSH, telnet: TELNET, loginPorts: [2001], devices: { '10.22.9.4:2002': { model: '2811', start: 'booting', timeScale: 0.05 } } });
  const client = await connect(lab.port);
  try {
    const s = await exec(client, 'telnet 10.22.9.4 2001');
    await s.until(/login: $/);
    s.type('\r');
    await s.until(/Connection closed by foreign host/);

    const b = await exec(client, 'telnet 10.22.9.4 2002');
    await b.until(/Username: $|Escape character/);
    b.type(`\r${TELNET.username}\r`);
    await b.until(/Password: $/);
    b.type(`${TELNET.password}\r`);
    await b.until(/System Bootstrap|Readonly ROMMON|program load/, 5000);
    b.type('\x1dsend brk\r');
    await b.until(/rommon 1 > $/, 3000);
    await b.close();
  } finally {
    client.end();
    await lab.close();
  }
});

test('npm run mock-lab still starts from the command line, and reports the port it really bound', async () => {
  const child = spawn(process.execPath, ['dev/mock-lab.js'], {
    cwd: repoRoot, env: { PATH: process.env.PATH, MOCK_SSH_PORT: '0', SSH_USERNAME: 'u', SSH_PASSWORD: 'p', MOCK_SLOW_CONSOLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const line = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error(`no banner: ${out}`)), 8000);
      child.stdout.on('data', (d) => { out += d; if (/Mock jump server on 127\.0\.0\.1:\d+/.test(out)) { clearTimeout(t); resolve(out); } });
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
    });
    const port = Number(line.match(/127\.0\.0\.1:(\d+)/)[1]);
    assert.ok(port > 0, 'the bound port, not 0');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
});
