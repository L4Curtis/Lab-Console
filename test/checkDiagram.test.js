/**
 * `npm run check-diagram`: it lists the devices of a diagram and the
 * warnings of the parser as sentences (they are objects { code, params,
 * message } since the application returns them to the page), and exits 1
 * only for the one that blocks an import: two different devices on one line
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from './helpers/app.js';

const run = (file) => spawnSync(process.execPath, ['scripts/check-diagram.js', file], {
  cwd: repoRoot, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH },
});

/** A one-page diagram: [[name, '.211 - 2050'], …] */
function drawio(devices) {
  const cells = devices.map(([name, target], i) => `<mxCell id="d${i}" value="${name}&lt;br&gt;${target}" style="shape=mxgraph.cisco.routers.router;" vertex="1" parent="1"><mxGeometry x="${10 + i * 80}" y="10" width="50" height="50" as="geometry"/></mxCell>`).join('');
  return `<mxfile><diagram name="T1" id="p-T1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
}

function check(devices, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-diagram-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'lab.drawio');
  fs.writeFileSync(file, drawio(devices));
  return run(file);
}

test('a clean diagram lists its devices and exits 0', (t) => {
  const out = check([['R1', '.211 - 3001'], ['S1', '.211 - 3002']], t);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /1 labs, 2 clickable devices/);
  assert.doesNotMatch(out.stdout, /Warnings/);
});

test('two different devices on one console line: the warning is a sentence, the exit status is 1, nothing crashes', (t) => {
  const out = check([['R1', '.211 - 3001'], ['S1', '.211 - 3001']], t);
  assert.equal(out.status, 1, out.stderr);
  assert.equal(out.stderr, '', 'no stack trace');
  assert.doesNotMatch(out.stdout, /\[object Object\]/);
  assert.match(out.stdout, /Warnings:\n {2}Console 10\.22\.9\.211:3001 is used by different devices/);
});

test('a warning that is only a note (the same equipment on several pages) does not fail the check', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-diagram-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const page = (name) => `<diagram name="${name}" id="p-${name}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="d0" value="R1&lt;br&gt;.211 - 3001" style="shape=mxgraph.cisco.routers.router;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="50" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram>`;
  const file = path.join(dir, 'two.drawio');
  fs.writeFileSync(file, `<mxfile>${page('A')}${page('B')}</mxfile>`);
  const out = run(file);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /appears on several pages/);
});
