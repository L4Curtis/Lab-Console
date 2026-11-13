/**
 * The harness leaves nothing behind when a scenario goes wrong: no Chromium,
 * no data directory, no browser profile. A scenario that fails, and one that
 * is killed with SIGTERM while it runs (a cancelled run), are started as
 * child processes and the machine is inspected once they are gone
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from '../helpers/app.js';

const fixture = path.join(repoRoot, 'test', 'e2e', 'fixtures', 'broken-scenario.js');

/** Command lines of the running processes (Linux /proc) */
function processes() {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try { out.push({ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') }); } catch { /* gone */ }
  }
  return out;
}
const chromiums = () => processes().filter((p) => /chrom/i.test(p.cmd.split(' ')[0])).map((p) => p.pid);
const profiles = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('playwright_chromiumdev_profile-')).sort();

/** Run the broken scenario; → { code, signal, info } once the child has exited */
function runBroken(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { cwd: repoRoot, env: { ...process.env, BROKEN: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let info = null;
    const onData = (d) => {
      output += d;
      const line = /HARNESS (\{.*\})/.exec(output);
      if (!line || info) return;
      info = JSON.parse(line[1]);
      try {
        assert.ok(fs.existsSync(info.dataDir), 'the data directory exists while the scenario runs');
        assert.ok(processes().some((p) => p.cmd.includes(info.marker)), 'its Chromium runs while the scenario runs');
      } catch (err) {
        child.kill('SIGTERM');
        reject(err);
      }
      if (mode === 'signal') child.kill('SIGTERM');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code, signal) => (info ? resolve({ code, signal, info }) : reject(new Error(`no harness started:\n${output}`))));
  });
}

for (const mode of ['fail', 'signal']) {
  test(`a scenario that ${mode === 'fail' ? 'fails' : 'is killed with SIGTERM'} leaves no process and no directory behind`, async () => {
    const chromiumBefore = chromiums();
    const profilesBefore = profiles();
    const { code, info } = await runBroken(mode);
    assert.equal(code, mode === 'fail' ? 1 : 143, 'the run reports the failure');
    assert.equal(fs.existsSync(info.dataDir), false, 'the data directory is removed');
    assert.deepEqual(processes().filter((p) => p.cmd.includes(info.marker)), [], 'no Chromium of that run is left');
    assert.deepEqual(chromiums().filter((pid) => !chromiumBefore.includes(pid)), [], 'no new Chromium process at all');
    assert.deepEqual(profiles(), profilesBefore, 'no browser profile left in the temporary directory');
  });
}
