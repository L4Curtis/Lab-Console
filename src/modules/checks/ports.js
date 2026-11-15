/**
 * Interface names as people write them and as Cisco IOS prints them
 *
 * The lab diagrams label link ends the way students and teachers type them
 * ("fa0/5", "fe0/0", "g0/0/1", "gi1/0/24", "s0/1/1"); IOS prints full names
 * in `show cdp neighbors detail` ("FastEthernet0/5", "GigabitEthernet0/0/1")
 * and in `show ip interface brief`, and abbreviates them elsewhere ("Fa0/5",
 * "Gi1/0/24", "Se0/1/1"). Two spellings are the same port when their
 * canonical forms are equal: the interface type, lower case and unabbreviated,
 * followed by its numbers ("fastethernet0/5").
 *
 * Pure module: the cabling check and the mock lab share it.
 */

/** Abbreviation (lower case) → interface type, longest first in the matcher */
const TYPES = [
  ['tengigabitethernet', ['tengigabitethernet', 'tengig', 'ten', 'te']],
  ['twentyfivegige', ['twentyfivegige', 'twe']],
  ['twogigabitethernet', ['twogigabitethernet', 'tw']],
  ['fivegigabitethernet', ['fivegigabitethernet', 'fi']],
  ['fortygigabitethernet', ['fortygigabitethernet', 'fo']],
  ['hundredgige', ['hundredgige', 'hu']],
  ['gigabitethernet', ['gigabitethernet', 'gigabit', 'gige', 'gig', 'gi', 'ge', 'g']],
  ['fastethernet', ['fastethernet', 'fast', 'fa', 'fe', 'f']],
  ['ethernet', ['ethernet', 'eth', 'et', 'e']],
  ['serial', ['serial', 'ser', 'se', 's']],
  ['port-channel', ['port-channel', 'portchannel', 'po']],
  ['loopback', ['loopback', 'lo']],
  ['vlan', ['vlan', 'vl']],
  ['tunnel', ['tunnel', 'tu']],
];
const BY_ABBREVIATION = new Map(TYPES.flatMap(([type, abbreviations]) => abbreviations.map((a) => [a, type])));
const ABBREVIATIONS = [...BY_ABBREVIATION.keys()].sort((a, b) => b.length - a.length).map((a) => a.replace('-', '\\-'));
const NAME = new RegExp(`^(${ABBREVIATIONS.join('|')})(\\s?)(\\d{1,3}(?:/\\d{1,3}){0,3}(?:\\.\\d{1,5})?)$`, 'i');
/** Types that are not a slot of the chassis: their number has no slash ("Vlan10", "Po1", "Lo0") */
const LOGICAL = new Set(['port-channel', 'loopback', 'vlan', 'tunnel']);

/** How IOS spells each type in full */
const FULL = {
  tengigabitethernet: 'TenGigabitEthernet', twentyfivegige: 'TwentyFiveGigE', twogigabitethernet: 'TwoGigabitEthernet',
  fivegigabitethernet: 'FiveGigabitEthernet', fortygigabitethernet: 'FortyGigabitEthernet', hundredgige: 'HundredGigE',
  gigabitethernet: 'GigabitEthernet', fastethernet: 'FastEthernet', ethernet: 'Ethernet', serial: 'Serial',
  'port-channel': 'Port-channel', loopback: 'Loopback', vlan: 'Vlan', tunnel: 'Tunnel',
};
/** … and in its short form (show interfaces status, the diagram's overlay) */
const SHORT = {
  tengigabitethernet: 'Te', twentyfivegige: 'Twe', twogigabitethernet: 'Tw', fivegigabitethernet: 'Fi', fortygigabitethernet: 'Fo',
  hundredgige: 'Hu', gigabitethernet: 'Gi', fastethernet: 'Fa', ethernet: 'Et', serial: 'Se', 'port-channel': 'Po',
  loopback: 'Lo', vlan: 'Vl', tunnel: 'Tu',
};

/**
 * Any spelling → { type, numbers, canonical } or null when it is not an
 * interface name ("VLAN 10", "192.168.1.0/24", "trunk" are not)
 */
export function parsePort(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(NAME);
  if (!m) return null;
  const type = BY_ABBREVIATION.get(m[1].toLowerCase());
  const numbers = m[3];
  // A port of the chassis always has a slash ("fa0/5"); a space is tolerated only there ("Fa 0/5"):
  // "VLAN 10", "e1" or "S1" written on a link are not interface names
  if (LOGICAL.has(type) ? m[2] : !numbers.includes('/')) return null;
  return { type, numbers, canonical: `${type}${numbers}` };
}

/** Canonical form ("fastethernet0/5"), or null */
export function canonicalPort(text) {
  return parsePort(text)?.canonical ?? null;
}

/** Two spellings of the same interface? */
export function samePort(a, b) {
  const x = canonicalPort(a);
  return Boolean(x) && x === canonicalPort(b);
}

/** IOS's full name ("FastEthernet0/5"), or the text as given when it is not an interface name */
export function fullPort(text) {
  const p = parsePort(text);
  return p ? `${FULL[p.type]}${p.numbers}` : text;
}

/** IOS's short name ("Fa0/5"), or the text as given */
export function shortPort(text) {
  const p = parsePort(text);
  return p ? `${SHORT[p.type]}${p.numbers}` : text;
}
