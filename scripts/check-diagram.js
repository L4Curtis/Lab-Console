#!/usr/bin/env node
/**
 * Lint a .drawio file with the exact parser the server uses
 *   npm run check-diagram [-- path/to/file.drawio]
 * Lists every clickable device per lab and flags suspicious console mappings
 * Exit code 1 when two *different* devices share one console line
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDrawio } from '../src/modules/consoles/drawio.js';
import { BLOCKING_WARNING } from '../src/lib/diagrams.js';

const file = path.resolve(process.argv[2] || process.env.DIAGRAM_PATH || './diagrams/diagram.drawio');
const prefix = process.env.CONSOLE_NETWORK_PREFIX || '10.22.9';
const { labs, warnings } = parseDrawio(fs.readFileSync(file, 'utf8'), { networkPrefix: prefix });

let total = 0;
for (const lab of labs) {
  console.log(`\n${lab.name}  (${lab.devices.length} devices, ${lab.edges.length} links)`);
  for (const d of lab.devices) {
    total++;
    console.log(`  ${d.name.padEnd(8)} ${d.kind.padEnd(9)} → ${d.target.host}:${d.target.port}`);
  }
  const unmapped = lab.shapes.filter((s) => s.kind === 'device-unmapped');
  for (const s of unmapped) console.log(`  ⚠ device shape without console info: "${s.label.lines.join(' ')}"`);
}
console.log(`\n${labs.length} labs, ${total} clickable devices`);
// A warning is { code, params, message }: the message is the English sentence, the code decides the exit status
if (warnings.length) console.log('\nWarnings:\n  ' + warnings.map((w) => w.message).join('\n  '));
process.exit(warnings.some((w) => w.code === BLOCKING_WARNING) ? 1 : 0);
