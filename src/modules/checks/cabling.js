/**
 * The cabling check's verdict: what CDP saw against what the diagram draws
 *
 * Input: the diagram's links (links.js) and, for each device of the bench,
 * what was read on it (`show cdp neighbors detail`, `show ip interface
 * brief`, its hostname). Output, per diagram link:
 *
 *   ok          CDP sees that cable, on the ports the diagram gives (an end
 *               without a port label only needs the right device)
 *   wrong_port  the two devices are cabled together, on other ports
 *   missing     at least one end could see it and does not: unplugged, an
 *               interface shut or down (the reason says which when the
 *               interfaces tell), or plugged elsewhere
 *   unverified  no end could tell: neither was read, or the one that was
 *               has CDP off, or the other one does not speak CDP (not Cisco)
 *
 * and every cable CDP sees that no diagram link explains is `unexpected`.
 *
 * Who is the neighbour? Never the diagram's name alone: a real device is
 * called "R1-3001" or "Switch". The CDP Device ID is matched against the
 * hostnames read on the bench's own devices during the same run; two
 * devices with the same hostname (two factory "Switch") are told apart by
 * the reciprocal entry (each sees the other on the ports the other names).
 * Only a device that could not be read is matched by its diagram name
 * ("R1" for "R1" or "R1-3001"), and the link says so (`guessed`).
 *
 * Pure module: no I/O, unit-tested on its own.
 */
import { canonicalPort, fullPort } from './ports.js';

const READ = 'done';

/** "R2.lab.local", "Switch(FOC1234X0YZ)" → "r2", "switch" */
export function hostKey(deviceId) {
  return String(deviceId ?? '').trim().replace(/\(.*\)$/, '').split('.')[0].toLowerCase();
}

/**
 * @param links    diagramLinks(lab)
 * @param devices  [{ key, name, state, code?, hostname?, cdp?: { enabled, neighbors }, interfaces?: [...] }]
 * → { links: [...], unexpected: [...], summary: { ok, wrong_port, missing, unverified, unexpected } }
 */
export function compareCabling(links, devices) {
  const byKey = new Map(devices.map((d) => [d.key, d]));
  const read = devices.filter((d) => d.state === READ && d.hostname);
  const byHost = new Map();
  for (const d of read) {
    const k = hostKey(d.hostname);
    if (!byHost.has(k)) byHost.set(k, []);
    byHost.get(k).push(d);
  }

  /** The bench device behind a CDP entry seen from `from`, or null; `guessed` when matched by diagram name */
  function resolve(from, n) {
    const k = hostKey(n.deviceId);
    const named = (byHost.get(k) ?? []).filter((d) => d.key !== from.key);
    if (named.length === 1) return { device: named[0], guessed: false };
    if (named.length > 1) {
      const mine = hostKey(from.hostname);
      const back = named.filter((c) => (c.cdp?.neighbors ?? []).some((m) => hostKey(m.deviceId) === mine
        && canonicalPort(m.localInterface) === canonicalPort(n.remoteInterface)
        && canonicalPort(m.remoteInterface) === canonicalPort(n.localInterface)));
      return back.length === 1 ? { device: back[0], guessed: false } : null;
    }
    // Not one of the hostnames read: perhaps a device of the bench that could not be read
    const guess = devices.filter((d) => d.key !== from.key && d.state !== READ && nameMatches(d.name, k));
    return guess.length === 1 ? { device: guess[0], guessed: true } : null;
  }

  // ── What CDP sees: one entry per cable, whichever end saw it ───────────────
  const observed = [];
  const byEnds = new Map();
  for (const d of read) {
    if (!d.cdp?.enabled) continue;
    for (const n of d.cdp.neighbors ?? []) {
      const here = canonicalPort(n.localInterface) ?? String(n.localInterface ?? '').toLowerCase();
      const there = canonicalPort(n.remoteInterface) ?? String(n.remoteInterface ?? '').toLowerCase();
      const other = resolve(d, n);
      const endA = `${d.key}|${here}`;
      const endB = other ? `${other.device.key}|${there}` : `?${hostKey(n.deviceId)}|${there}`;
      const id = [endA, endB].sort().join(' ');
      const seen = byEnds.get(id);
      if (seen) { seen.seenBy.push(d.key); continue; }
      const cable = {
        a: { key: d.key, name: d.name, port: here },
        b: { key: other?.device.key ?? null, name: other?.device.name ?? n.deviceId, port: there, guessed: Boolean(other?.guessed) },
        rawA: n.localInterface, rawB: n.remoteInterface,
        seenBy: [d.key],
        used: false,
      };
      byEnds.set(id, cable);
      observed.push(cable);
    }
  }
  /** The cable's port at device `key` (canonical), or undefined when the cable does not touch it */
  const portAt = (cable, key) => (cable.a.key === key ? cable.a.port : cable.b.key === key ? cable.b.port : undefined);
  const joins = (cable, x, y) => (cable.a.key === x && cable.b.key === y) || (cable.a.key === y && cable.b.key === x);

  /** Could `d` have seen this cable? It was read and runs CDP */
  const looks = (d) => d?.state === READ && d.cdp?.enabled;
  /** Would `d` be seen if it is cabled? It runs Cisco IOS (or was not read for another reason: still a CDP speaker) */
  const speaks = (d) => Boolean(d) && !(d.state === 'skipped' && d.code === 'ios.not_ios');

  // ── Diagram links, the best described first (two ports, then one, then none) ──
  const known = (l) => Number(Boolean(l.a.port)) + Number(Boolean(l.b.port));
  const order = [...links].sort((x, y) => known(y) - known(x));
  const verdicts = new Map();
  const want = (end) => (end.port ? canonicalPort(end.port) : null);

  for (const l of order) {
    const exact = observed.find((c) => !c.used && joins(c, l.a.key, l.b.key)
      && (!want(l.a) || portAt(c, l.a.key) === want(l.a)) && (!want(l.b) || portAt(c, l.b.key) === want(l.b)));
    if (exact) {
      exact.used = true;
      verdicts.set(l.id, verdict(l, 'ok', exact));
    }
  }
  // Cabled together on other ports: a cable that keeps one of the drawn ports goes to its link first
  const shared = (l, c) => Number(Boolean(want(l.a)) && portAt(c, l.a.key) === want(l.a)) + Number(Boolean(want(l.b)) && portAt(c, l.b.key) === want(l.b));
  for (const score of [2, 1, 0]) {
    for (const l of order) {
      if (verdicts.has(l.id)) continue;
      const other = observed.find((c) => !c.used && joins(c, l.a.key, l.b.key) && shared(l, c) === score);
      if (!other) continue;
      other.used = true;
      verdicts.set(l.id, verdict(l, 'wrong_port', other));
    }
  }
  for (const l of order) if (!verdicts.has(l.id)) verdicts.set(l.id, missingOrUnverified(l));

  function verdict(l, status, cable) {
    const end = (e) => ({ ...e, seen: cable ? fullPort(portAt(cable, e.key)) : null });
    return { id: l.id, status, a: end(l.a), b: end(l.b), guessed: Boolean(cable?.b.guessed) };
  }

  function missingOrUnverified(l) {
    const a = byKey.get(l.a.key);
    const b = byKey.get(l.b.key);
    const visible = (looks(a) && speaks(b)) || (looks(b) && speaks(a));
    if (!visible) {
      return { id: l.id, status: 'unverified', a: { ...l.a, seen: null }, b: { ...l.b, seen: null }, reason: unverifiedReason(a, b) };
    }
    return { id: l.id, status: 'missing', a: { ...l.a, seen: null }, b: { ...l.b, seen: null }, reason: interfaceReason(l.a, a) ?? interfaceReason(l.b, b) };
  }

  const result = links.map((l) => verdicts.get(l.id));
  const unexpected = observed.filter((c) => !c.used).map((c) => ({
    a: { key: c.a.key, name: c.a.name, port: fullPort(c.a.port) },
    b: { key: c.b.key, name: c.b.name, port: fullPort(c.b.port), guessed: c.b.guessed },
  }));
  const summary = { ok: 0, wrong_port: 0, missing: 0, unverified: 0, unexpected: unexpected.length };
  for (const r of result) summary[r.status]++;
  return { links: result, unexpected, summary };
}

/** Why a link could not be checked: { code, params } */
function unverifiedReason(a, b) {
  for (const d of [a, b]) if (d?.state === 'skipped' && d.code === 'ios.not_ios') return { code: 'not_cisco', params: { device: d.name } };
  for (const d of [a, b]) if (d?.state === READ && !d.cdp?.enabled) return { code: 'cdp_off', params: { device: d.name } };
  return { code: 'not_read', params: { devices: [a, b].filter(Boolean).map((d) => d.name).join(', ') } };
}

/** A missing link explained by an interface of a device that was read: shut, down, or absent */
function interfaceReason(end, d) {
  if (!end.port || d?.state !== READ || !Array.isArray(d.interfaces)) return null;
  const want = canonicalPort(end.port);
  const ifc = d.interfaces.find((i) => canonicalPort(i.name) === want);
  if (!ifc) return d.interfaces.length ? { code: 'no_such_port', params: { device: d.name, port: end.port } } : null;
  if (ifc.status === 'administratively down') return { code: 'shutdown', params: { device: d.name, port: end.port } };
  if (ifc.status !== 'up' || ifc.protocol !== 'up') return { code: 'down', params: { device: d.name, port: end.port } };
  return null;
}

/** "R1" names "r1" and "r1-3001" (a hostname made of the name and the console port) */
function nameMatches(name, host) {
  const n = String(name ?? '').toLowerCase();
  return Boolean(n) && (host === n || host.startsWith(`${n}-`) || host.startsWith(`${n}_`));
}
