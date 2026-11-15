/**
 * The harness leaves nothing behind when a scenario goes wrong: no Chromium,
 * no data directory, no browser profile. A scenario that fails, and one that
 * is killed with SIGTERM while it runs (a cancelled run), are started as
 * child processes and the machine is inspected once they are gone.
 *
 * Only what this run started is looked at: the processes descended from the
 * child (followed while it runs, so that one reparented after its parent died
 * is still known by its pid and start time), the processes carrying the
 * run's marker argument, and the browser profiles their command lines name.
 * Another suite running a browser on the machine at the same time changes
 * nothing here
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from '../helpers/app.js';

const fixture = path.join(repoRoot, 'test', 'e2e', 'fixtures', 'broken-scenario.js');

/** The running processes (Linux /proc): pid → { pid, ppid, start, cmd } */
function processes() {
  const out = new Map();
  for (const name of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // After "pid (comm) ": state, ppid, …; the start time is the 22nd field of the whole line
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      out.set(Number(name), { pid: Number(name), ppid: Number(fields[1]), start: fields[19], cmd });
    } catch { /* gone meanwhile */ }
  }
  return out;
}

/** The processes descended from `root` (itself excluded) */
function descendants(root, all) {
  const children = new Map();
  for (const p of all.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  const queue = [...(children.get(root) ?? [])];
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p);
    queue.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

const isChromium = (p) => /chrom/i.test(p.cmd.split(' ')[0] ?? '');
const profileOf = (p) => /--user-data-dir=(\S+)/.exec(p.cmd)?.[1] ?? null;
/** Is this very process (same pid, same start time) still running? */
const alive = (p, now) => now.get(p.pid)?.start === p.start;

/**
 * Run the broken scenario; → { code, signal, info, browsers, profiles } once the child has exited.
 * `browsers` are the Chromium processes of this run seen while it ran, `profiles` the profile
 * directories they were given
 */
function runBroken(mode) {
  return new Promise((resolve, reject) => {
    // Without the runner's NODE_TEST_CONTEXT the child reports in plain TAP, not to our runner
    const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
    const child = spawn(process.execPath, [fixture], { cwd: repoRoot, env: { ...env, BROKEN: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
    const browsers = new Map(); // `${pid}:${start}` → process
    let output = '';
    let info = null;
    const look = () => {
      const all = processes();
      const ours = descendants(child.pid, all);
      if (info) ours.push(...[...all.values()].filter((p) => p.cmd.includes(info.marker)));
      for (const p of ours.filter(isChromium)) browsers.set(`${p.pid}:${p.start}`, p);
    };
    const watch = setInterval(look, 25);
    const onData = (d) => {
      output += d;
      const line = /HARNESS (\{.*\})/.exec(output);
      if (!line || info) return;
      info = JSON.parse(line[1]);
      look();
      try {
        assert.ok(fs.existsSync(info.dataDir), 'the data directory exists while the scenario runs');
        assert.ok([...browsers.values()].some((p) => p.cmd.includes(info.marker)), 'its Chromium runs, as a process of this run, while the scenario runs');
        assert.ok([...browsers.values()].some((p) => profileOf(p)), 'its Chromium names its profile');
      } catch (err) {
        child.kill('SIGTERM');
        reject(err);
      }
      if (mode === 'signal') child.kill('SIGTERM');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => { clearInterval(watch); reject(err); });
    child.once('exit', (code, signal) => {
      clearInterval(watch);
      if (!info) return reject(new Error(`no harness started:\n${output}`));
      const list = [...browsers.values()];
      resolve({ code, signal, info, browsers: list, profiles: [...new Set(list.map(profileOf).filter(Boolean))] });
    });
  });
}

for (const mode of ['fail', 'signal']) {
  test(`a scenario that ${mode === 'fail' ? 'fails' : 'is killed with SIGTERM'} leaves no process and no directory behind`, async () => {
    const { code, info, browsers, profiles } = await runBroken(mode);
    assert.equal(code, mode === 'fail' ? 1 : 143, 'the run reports the failure');
    assert.equal(fs.existsSync(info.dataDir), false, 'the data directory is removed');
    const now = processes();
    assert.deepEqual([...now.values()].filter((p) => p.cmd.includes(info.marker)).map((p) => p.pid), [], 'no Chromium carrying the marker of that run is left');
    assert.ok(browsers.length > 0, 'the Chromium processes of that run were seen');
    assert.deepEqual(browsers.filter((p) => alive(p, now)).map((p) => `${p.pid} ${p.cmd.slice(0, 80)}`), [], 'no Chromium process of that run is left');
    assert.ok(profiles.length > 0, 'the profile of that run was seen');
    assert.deepEqual(profiles.filter((dir) => fs.existsSync(dir)), [], 'no browser profile of that run is left');
  });
}
