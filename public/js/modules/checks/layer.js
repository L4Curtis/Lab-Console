/**
 * Bench checks on the lab diagram (SPEC "Lot checks"), for whoever may read
 * them:
 *
 *   - line status: a badge per device (free, busy outside the application,
 *     device silent) and the line in the tooltip, for 30 minutes;
 *   - cabling: each link of the diagram coloured by its verdict (ok, wrong
 *     port, missing, not verifiable) with the reason in its tooltip; a red
 *     ring around a device with a cabling problem, and its unexpected
 *     neighbours in its tooltip;
 *   - interfaces: the address (or "down", "shut") of each labelled link end
 *     written near that end, and the device's interfaces in its tooltip;
 *   - the check running on a bench: a ring on the device it is working on.
 *
 * Started once by main.js, whichever section is on screen
 */
import { loadCss } from '../../core/dom.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { registerDiagramLayer, registerLinkLayer, refreshDiagram } from '../../shared/diagramLayers.js';
import { startChecks, onChecks, allLast, allRunning } from './data.js';
import { lineText, linkText, shortPort, ifStateText, ageText } from './text.js';

const LINES_FRESH_MS = 30 * 60_000;
const LINE_BADGE = { free: '✓', busy: '●', silent: '?', in_app: '', unknown: '' };

export async function start() {
  await Promise.all([loadNamespace('checks', 'ios'), loadCss('checks')]);
  let byDevice = new Map(); // device key → { line, cabling: [links], unexpected: [], interfaces }
  let byLink = new Map();   // edge id → { cabling, interfaces }
  let runningDevices = new Map(); // device key → { check, device }

  function rebuild() {
    byDevice = new Map();
    byLink = new Map();
    runningDevices = new Map();
    const of = (key) => { if (!byDevice.has(key)) byDevice.set(key, { line: null, cabling: [], unexpected: [], interfaces: null }); return byDevice.get(key); };
    const link = (id) => { if (!byLink.has(id)) byLink.set(id, {}); return byLink.get(id); };
    for (const c of allLast()) {
      const r = c.result ?? {};
      if (c.kind === 'lines') {
        if (Date.now() - Date.parse(c.endedAt) > LINES_FRESH_MS) continue;
        for (const d of r.devices ?? []) of(d.key).line = { ...d, at: c.endedAt };
      } else if (c.kind === 'cabling') {
        for (const l of r.links ?? []) {
          link(l.id).cabling = l;
          if (l.status === 'missing' || l.status === 'wrong_port') { of(l.a.key).cabling.push(l); of(l.b.key).cabling.push(l); }
        }
        for (const u of r.unexpected ?? []) { of(u.a.key).unexpected.push(u); if (u.b.key) of(u.b.key).unexpected.push(u); }
      } else if (c.kind === 'interfaces') {
        for (const d of r.devices ?? []) if (d.interfaces) of(d.key).interfaces = d.interfaces;
        for (const l of r.links ?? []) link(l.id).interfaces = l;
      }
    }
    for (const c of allRunning()) {
      for (const d of c.devices ?? []) if (d.state === 'running' || d.state === 'waiting') runningDevices.set(d.key, { check: c, device: d });
    }
    refreshDiagram();
  }

  registerDiagramLayer('checks', (device) => {
    const e = byDevice.get(device.key);
    const run = runningDevices.get(device.key);
    if (!e && !run) return null;
    const badges = [];
    const tooltip = [];
    let ring = null;
    if (e?.line && LINE_BADGE[e.line.line]) {
      badges.push({ text: LINE_BADGE[e.line.line], kind: `line-${e.line.line}`, title: lineText(e.line.line) });
    }
    if (e?.line) tooltip.push(t('checks.layer.line', { state: lineText(e.line.line), age: ageText(e.line.at) }));
    if (e?.cabling.length || e?.unexpected.length) {
      ring = 'check-bad';
      for (const l of e.cabling) tooltip.push(linkText(l));
      for (const u of e.unexpected) tooltip.push(t('checks.cabling.unexpectedLine', { a: u.a.name, pa: shortPort(u.a.port), b: u.b.name, pb: shortPort(u.b.port) }));
    }
    if (e?.interfaces) {
      const shown = e.interfaces.filter((i) => i.ip || i.status === 'up').slice(0, 6);
      for (const i of shown) tooltip.push(`${shortPort(i.name)} ${i.ip ?? ''} ${ifStateText(i)}`.replace(/\s+/g, ' ').trim());
    }
    if (run) {
      ring = 'check-run';
      tooltip.push(t('checks.layer.running', { kind: t(`checks.kind.${run.check.kind}`), name: run.check.actor?.name ?? '' }));
    }
    return { ring, badges, tooltip };
  });

  registerLinkLayer('checks', (edge) => {
    const e = byLink.get(edge.id);
    if (!e) return null;
    const out = { tone: null, title: [], ends: {} };
    if (e.cabling) {
      out.tone = `cabling-${e.cabling.status}`;
      out.title.push(linkText(e.cabling));
    }
    if (e.interfaces) {
      // Near each end: its address, or what is wrong with it (an interface up without an address says nothing)
      const end = (x) => (x.port && x.status ? (x.status === 'up' && x.protocol === 'up' ? x.ip : ifStateText(x)) : null);
      out.ends = { source: end(e.interfaces.a), target: end(e.interfaces.b) };
      for (const x of [e.interfaces.a, e.interfaces.b]) {
        if (x.port && x.status) out.title.push(`${x.name} ${shortPort(x.port)} ${x.ip ?? ''} ${ifStateText(x)}`.replace(/\s+/g, ' ').trim());
      }
    }
    return out;
  });

  onChecks(rebuild);
  onLocaleChange(rebuild);
  await startChecks();
  rebuild();
}
