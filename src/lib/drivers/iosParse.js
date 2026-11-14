/**
 * What a Cisco IOS / IOS XE console prints, read: show version, VLANs and
 * VTP, CDP neighbours, interfaces, ping. Pure functions of the text, no
 * console: the driver (ciscoIos.js) and the tests use them
 */

/** VLAN 1 and 1002-1005: on every switch, never created nor replayed */
export const isDefaultVlan = (id) => id === 1 || (id >= 1002 && id <= 1005);

/** show version → facts (family null when it is not Cisco IOS / IOS XE) */
export function parseShowVersion(text) {
  const t = String(text);
  const xe = t.match(/Cisco IOS XE Software, Version (\S+)/);
  const ios = t.match(/Cisco IOS Software(?: \[\w+\])?, (.+?) Software \(([^)]+)\), (?:Experimental )?Version ([^,\s]+)/);
  const family = xe ? 'iosxe' : ios ? 'ios' : null;
  const model = (t.match(/^Model [Nn]umber\s*:\s*(\S+)/m) || t.match(/^[Cc]isco (\S+) \([^)]*\) (?:processor|with)/m) || [])[1] || null;
  const reg = t.match(/Configuration register is (0x[0-9A-Fa-f]+)(?: \(will be (0x[0-9A-Fa-f]+) at next reload\))?/);
  const kind = /^Model [Nn]umber\s*:/m.test(t) || /Switch Ports Model/.test(t) || /^(WS-C|C1000|C9\d00|IE-)/.test(model || '') ? 'switch' : 'router';
  const configRegister = reg ? reg[1] : null;
  const nextConfigRegister = reg?.[2] ?? null;
  const warnings = [];
  let registerOk = true;
  if (kind === 'router' && configRegister) {
    const effective = (nextConfigRegister || configRegister).toLowerCase();
    if (effective !== '0x2102') { registerOk = false; warnings.push('register_unusual'); }
  }
  return {
    family,
    kind,
    model,
    version: xe ? xe[1] : ios ? ios[3] : null,
    software: ios ? ios[2] : null,
    image: (t.match(/System image file is "([^"]+)"/) || [])[1] || null,
    configRegister,
    nextConfigRegister,
    registerOk,
    hostname: (t.match(/^(\S+) uptime is/m) || [])[1] || null,
    uptime: (t.match(/^\S+ uptime is (.+)$/m) || [])[1] || null,
    serial: (t.match(/^Processor board ID (\S+)/m) || [])[1] || null,
    warnings,
  };
}

/** show vlan brief → [{ id, name, status, ports: ['Fa0/1', …] }] (fixed columns, as IOS prints them) */
export function parseVlanBrief(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\d{1,4})\s+(\S+)\s+(active|suspended|act\/lshut|sus\/lshut|act\/ishut|sus\/ishut|act\/unsup)\b\s*(.*)$/);
    if (m) {
      out.push({ id: Number(m[1]), name: m[2], status: m[3], ports: splitPorts(m[4]) });
    } else if (/^\s{20,}\S/.test(line) && out.length) {
      out.at(-1).ports.push(...splitPorts(line));
    }
  }
  return out;
}
const splitPorts = (s) => s.split(',').map((p) => p.trim()).filter(Boolean);

/**
 * show vtp status → { version, mode, domain, pruning } or null. Both layouts:
 * 12.2SE ("VTP Version : running VTP1 (VTP2 capable)" or "VTP Version : 2",
 * "VTP V2 Mode : Enabled") and 15.x / IOS XE ("VTP version running : 1").
 */
export function parseVtpStatus(text) {
  const t = String(text);
  const mode = t.match(/^\s*VTP Operating Mode\s*:\s*(Server|Client|Transparent|Off)\b/im);
  if (!mode) return null;
  const running = t.match(/^VTP version running\s*:\s*(\d)/im) || t.match(/^VTP Version\s*:\s*running VTP(\d)/im) || t.match(/^VTP Version\s*:\s*(\d)\s*$/im);
  let version = running ? Number(running[1]) : 1;
  if (version === 1 && /^VTP V2 Mode\s*:\s*Enabled/im.test(t)) version = 2;
  const domain = (t.match(/^VTP Domain Name\s*:[ \t]*(\S*)/im) || [])[1] || '';
  return { version, mode: mode[1].toLowerCase(), domain, pruning: /^VTP Pruning Mode\s*:\s*Enabled/im.test(t) };
}

/** show vtp password → the password, or null ("The VTP password is not configured.") */
export function parseVtpPassword(text) {
  return (String(text).match(/^VTP Password:[ \t]*(\S+)/m) || [])[1] || null;
}

/** show cdp neighbors detail → [{ deviceId, ip, platform, capabilities, localInterface, remoteInterface, version, nativeVlan, duplex }] */
export function parseCdpNeighbors(text) {
  return String(text).split(/^-{5,}\s*$/m).map((block) => {
    const get = (re) => (block.match(re) || [])[1]?.trim() ?? null;
    const deviceId = get(/Device ID: ?(.+)/);
    if (!deviceId) return null;
    const platform = block.match(/Platform: ?([^,\n]+),\s*Capabilities: ?([^\n]*)/);
    const ifs = block.match(/Interface: ?([^,\n]+),\s*Port ID \(outgoing port\): ?([^\n]+)/);
    const version = block.match(/Version ?:\s*\n([\s\S]*?)(?:\n\s*\n|$)/);
    return {
      deviceId,
      ip: get(/IP(?:v4)? address: ?(\S+)/),
      platform: platform ? platform[1].replace(/^cisco /i, '').trim() : null,
      capabilities: platform ? platform[2].trim() : null,
      localInterface: ifs ? ifs[1].trim() : null,
      remoteInterface: ifs ? ifs[2].trim() : null,
      version: version ? version[1].trim() : null,
      nativeVlan: get(/Native VLAN: ?(\d+)/) ? Number(get(/Native VLAN: ?(\d+)/)) : null,
      duplex: get(/Duplex: ?(\S+)/),
    };
  }).filter(Boolean);
}

const IP_BRIEF_TAIL = String.raw`(YES|NO)\s+(\S+)\s+(up|down|administratively down|reset|deleted)\s+(up|down)\s*$`;
const IP_BRIEF_ROW = new RegExp(String.raw`^(\S+)\s+(\S+)\s+${IP_BRIEF_TAIL}`);
/** A name as long as its column is glued to the address: only readable when the address is "unassigned" */
const IP_BRIEF_GLUED = new RegExp(String.raw`^(\S+?)(unassigned)\s+${IP_BRIEF_TAIL}`);
/** The lines of `show ip interface brief` that look like an interface row (readable or not) */
const IP_BRIEF_LOOKS = new RegExp(String.raw`\s${IP_BRIEF_TAIL}`);

/** How many lines of `show ip interface brief` are interface rows, whether parseIpInterfaceBrief reads them or not */
export function countRows(text) {
  return String(text).split('\n').filter((line) => IP_BRIEF_LOOKS.test(line)).length;
}

/** show ip interface brief → [{ name, ip, ok, method, status, protocol }] */
export function parseIpInterfaceBrief(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(IP_BRIEF_ROW) ?? line.match(IP_BRIEF_GLUED);
    if (m) out.push({ name: m[1], ip: m[2] === 'unassigned' ? null : m[2], ok: m[3] === 'YES', method: m[4], status: m[5], protocol: m[6] });
  }
  return out;
}

/** ping output → { sent, received, successRate, marks, rtt } or null */
export function parsePing(text) {
  const m = String(text).match(/Success rate is (\d+) percent \((\d+)\/(\d+)\)(?:, round-trip min\/avg\/max = (\d+)\/(\d+)\/(\d+) ms)?/);
  if (!m) return null;
  return {
    successRate: Number(m[1]),
    received: Number(m[2]),
    sent: Number(m[3]),
    marks: (String(text).match(/^[!.UQM?&]+$/m) || [''])[0],
    rtt: m[4] ? { min: Number(m[4]), avg: Number(m[5]), max: Number(m[6]) } : null,
  };
}

