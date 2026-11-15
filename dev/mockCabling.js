/**
 * The cables of the mock lab: what CDP, the interfaces' line protocol and
 * ping see on the simulated devices
 *
 * By default the cables are the diagram's links (src/modules/checks/links.js),
 * so the lab is cabled exactly as drawn. An end the diagram does not label
 * gets the first free Ethernet port of the device's model. Tests and demos
 * then break it on purpose:
 *
 *   cabling.unplug('10.22.9.211:2016', 'FastEthernet0/1')      the cable is pulled out: a link goes missing
 *   cabling.move('10.22.9.211:2016', 'Fa0/2', 'Fa0/9')         plugged into another port: a wrong port
 *   cabling.plug({ target, port }, { target, port })           one more cable: an unexpected neighbour
 *
 * or, for `npm run mock-lab`, MOCK_CABLING="unplug:2016/Fa0/1;move:2016/Fa0/2>Fa0/9;plug:2016/Fa0/20=2017/Fa0/20"
 * (console ports of the first console server).
 */
import { MODELS } from './fakeIos.js';
import { diagramLinks } from '../src/modules/checks/links.js';
import { canonicalPort, fullPort } from '../src/modules/checks/ports.js';

const MANAGEMENT = new Set(['gigabitethernet0/0', 'gigabitethernet0']); // the 9300L's and the 4331's management ports
const isEthernet = (name) => /^(Fast|Gigabit|TenGigabit)Ethernet/.test(name) && !MANAGEMENT.has(canonicalPort(name));

/** The diagram's links as cables between console lines: [{ a: { target, port }, b: { target, port } }] */
export function cablesFromLabs(labs) {
  const out = [];
  for (const lab of labs) {
    const targetOf = new Map(lab.devices.map((d) => [d.key, `${d.target.host}:${d.target.port}`]));
    for (const l of diagramLinks(lab)) out.push({ a: { target: targetOf.get(l.a.key), port: l.a.port }, b: { target: targetOf.get(l.b.key), port: l.b.port } });
  }
  return out;
}

export class MockCabling {
  #cables = []; // { a: { key, port }, b: { key, port } }, ports in IOS's full spelling

  /**
   * @param links    [{ a: { target, port | null }, b: { target, port | null } }]
   * @param modelOf  (target) => the device's model (MODELS key), to choose the ports nobody labelled
   */
  constructor(links = [], { modelOf = () => null } = {}) {
    this.modelOf = modelOf;
    const pending = [];
    for (const l of links) {
      if (!l?.a?.target || !l?.b?.target) continue;
      const cable = { a: { key: l.a.target, port: l.a.port ? fullPort(l.a.port) : null }, b: { key: l.b.target, port: l.b.port ? fullPort(l.b.port) : null } };
      this.#cables.push(cable);
      pending.push(cable);
    }
    // Labelled ends first, so that a port chosen for an unlabelled end is really free
    for (const cable of pending) for (const end of [cable.a, cable.b]) if (!end.port) end.port = this.#freePort(end.key);
  }

  /** Every cable, as plain data */
  list() {
    return this.#cables.map((c) => ({ a: { ...c.a }, b: { ...c.b } }));
  }

  /** The console lines that have at least one cable */
  keys() {
    return [...new Set(this.#cables.flatMap((c) => [c.a.key, c.b.key]))];
  }

  /** The cables at `key`: [{ port, other: { key, port } }] */
  at(key) {
    const out = [];
    for (const c of this.#cables) {
      if (c.a.key === key) out.push({ port: c.a.port, other: c.b });
      if (c.b.key === key) out.push({ port: c.b.port, other: c.a });
    }
    return out;
  }

  /** The cable plugged into `port` of `key`, or null */
  find(key, port) {
    const want = canonicalPort(port);
    return this.at(key).find((c) => canonicalPort(c.port) === want) ?? null;
  }

  unplug(key, port) {
    const before = this.#cables.length;
    const want = canonicalPort(port);
    this.#cables = this.#cables.filter((c) => !((c.a.key === key && canonicalPort(c.a.port) === want) || (c.b.key === key && canonicalPort(c.b.port) === want)));
    return this.#cables.length !== before;
  }

  move(key, from, to) {
    const want = canonicalPort(from);
    for (const c of this.#cables) {
      for (const end of [c.a, c.b]) {
        if (end.key === key && canonicalPort(end.port) === want) { end.port = fullPort(to); return true; }
      }
    }
    return false;
  }

  plug(a, b) {
    this.#cables.push({ a: { key: a.target, port: fullPort(a.port) }, b: { key: b.target, port: fullPort(b.port) } });
  }

  /** MOCK_CABLING: "unplug:2016/Fa0/1;move:2016/Fa0/2>Fa0/9;plug:2016/Fa0/20=2017/Fa0/20", ports on `host` */
  apply(spec, host) {
    for (const step of String(spec || '').split(';').map((s) => s.trim()).filter(Boolean)) {
      const [verb, rest = ''] = step.split(':');
      const end = (s) => { const [p, ...port] = s.split('/'); return { target: `${host}:${Number(p)}`, port: port.join('/') }; };
      if (verb === 'unplug') { const e = end(rest); this.unplug(e.target, e.port); }
      else if (verb === 'move') { const [from, to] = rest.split('>'); const e = end(from); this.move(e.target, e.port, to); }
      else if (verb === 'plug') { const [x, y] = rest.split('='); this.plug(end(x), end(y)); }
    }
  }

  #freePort(key) {
    const used = new Set(this.at(key).map((c) => canonicalPort(c.port)).filter(Boolean));
    // Ethernet first, then the serial ports, then made-up ones: never a port twice
    const names = (MODELS[this.modelOf(key)]?.interfaces ?? []).map(([n]) => n).filter((n) => !MANAGEMENT.has(canonicalPort(n)) && !/^Vlan/.test(n));
    const pool = [...names.filter(isEthernet), ...names.filter((n) => !isEthernet(n)), ...Array.from({ length: 48 }, (_, i) => `GigabitEthernet9/0/${i + 1}`)];
    return pool.find((n) => !used.has(canonicalPort(n)));
  }
}
