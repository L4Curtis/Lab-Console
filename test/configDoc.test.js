import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnvExample, renderConfigDoc } from '../scripts/gen-config-doc.js';

const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

test('the configuration reference is generated from .env.example', () => {
  const current = readFileSync(new URL('../docs/CONFIGURATION.md', import.meta.url), 'utf8');
  assert.equal(current, renderConfigDoc(example), 'run: npm run gen-config-doc');
});

test('every variable of .env.example is in the reference, with a description', () => {
  const names = parseEnvExample(example).flatMap((s) => s.vars);
  assert.ok(names.length > 50);
  const doc = renderConfigDoc(example);
  for (const v of names) assert.ok(doc.includes(`\`${v.name}\``), v.name);
});
