/**
 * The cables a bench's diagram draws, with the ports written at their ends
 *
 * A link is an edge of the diagram between two console devices of the same
 * page. Its labels that read as interface names (ports.js) give the ports:
 *   - a label in the first or last third of the link belongs to that end;
 *   - one label in the middle third, alone, is read as the port of both
 *     ends (the lab diagrams write "fa0/5" once on a link between two
 *     switches cabled port to port); such a port is marked `assumed`, so a
 *     report can say the diagram did not really tell;
 *   - an end with no label has no port: only the devices are compared.
 * Edges to a shape that is not a console device (a PC, a cloud, a text) are
 * not links of the bench: nothing on the console can check them.
 *
 * Pure module, shared by the cabling check and the mock lab.
 *
 *   diagramLinks(lab) → [{ id, a: { key, name, port, assumed }, b: { … } }]
 */
import { parsePort, fullPort } from './ports.js';

const NEAR_START = 1 / 3;
const NEAR_END = 2 / 3;

export function diagramLinks(lab) {
  const byId = new Map((lab?.devices ?? []).map((d) => [d.id, d]));
  const links = [];
  for (const e of lab?.edges ?? []) {
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    if (!from || !to || from.id === to.id) continue;
    const ports = (e.labels ?? []).map((l) => ({ port: parsePort(l.text), at: typeof l.at === 'number' ? l.at : 0.5 })).filter((l) => l.port);
    let a = null;
    let b = null;
    let assumed = false;
    for (const l of ports) {
      if (l.at < NEAR_START) a ??= l.port;
      else if (l.at > NEAR_END) b ??= l.port;
    }
    const middle = ports.filter((l) => l.at >= NEAR_START && l.at <= NEAR_END);
    if (!a && !b && ports.length === 1 && middle.length === 1) {
      a = b = middle[0].port;
      assumed = true;
    } else {
      // Two labels, one of them in the middle: it belongs to the end that has none, by distance
      for (const l of middle) {
        if (!a && (b || l.at <= 0.5)) a = l.port;
        else if (!b) b = l.port;
      }
    }
    const end = (d, p) => ({ key: d.key, name: d.name, port: p ? fullPort(p.canonical) : null, assumed: Boolean(p) && assumed });
    links.push({ id: e.id, a: end(from, a), b: end(to, b) });
  }
  return links;
}
