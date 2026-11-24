// Destination spelling, allow entries and the resolved-address check of the egress relay.
import net from "node:net";
import { networkInterfaces } from "node:os";

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

type Hextets = [number, number, number, number, number, number, number, number];

function hextets(address: string): Hextets | undefined {
  if (net.isIP(address) !== 6) return undefined;
  let text = address;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(fill, 0)).fill("0"), ...right].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups as Hextets : undefined;
}

function dottedQuad(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

// The IPv4 address an IPv6 address is delivered to (mapped, translated, compatible, 64:ff9b::/96, 2002::/16), if any.
function embeddedIPv4(address: string): string | undefined {
  const g = hextets(address);
  if (g === undefined) return undefined;
  const zeroPrefix = g.slice(0, 5).every((group) => group === 0);
  if (zeroPrefix && g[5] === 0xffff) return dottedQuad(g[6], g[7]);
  if (g.slice(0, 4).every((group) => group === 0) && g[4] === 0xffff && g[5] === 0) return dottedQuad(g[6], g[7]);
  if (zeroPrefix && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) return dottedQuad(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return dottedQuad(g[6], g[7]);
  if (g[0] === 0x2002) return dottedQuad(g[1], g[2]);
  return undefined;
}

// Control characters, zone ids and anything outside the DNS label alphabet never reach matching or the wire.
export function isValidRelayHost(host: string): boolean {
  if (host.length === 0 || host.length > 255) return false;
  const bare = stripBrackets(host);
  if (bare.includes("%")) return false;
  return net.isIP(bare) !== 0 || /^[A-Za-z0-9._-]+$/.test(bare);
}

// The spelling a dial acts on: numeric shorthand expanded, case folded, no brackets or trailing dot, an IPv4-mapped literal as IPv4.
export function canonicalRelayHost(host: string): string | undefined {
  try {
    const bare = stripBrackets(host);
    const out = stripBrackets(new URL(`http://${net.isIP(bare) === 6 ? `[${bare}]` : bare}/`).hostname);
    if (net.isIP(out) !== 6) return out.replace(/\.$/, "");
    const g = hextets(out);
    if (g === undefined) return out;
    return g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff ? dottedQuad(g[6], g[7]) : out;
  } catch {
    return undefined;
  }
}

export interface RelayAllowEntry {
  // Canonical host, or the suffix after `*.` for a wildcard.
  readonly host: string;
  readonly port: number;
  readonly wildcard: boolean;
}

// `host:port`, `*.suffix:port` or `[v6]:port`. The port is required: an entry admits one host on one port.
export function parseRelayAllowEntry(entry: string): RelayAllowEntry {
  const match = /^(?<host>\[[^\]]+\]|[^:[\]]+):(?<port>[1-9]\d{0,4})$/.exec(entry);
  const spelled = match?.groups?.host;
  const port = Number(match?.groups?.port);
  if (spelled === undefined || !(port <= 65535)) throw new Error("egress relay allow entry needs host:port");
  const wildcard = spelled.startsWith("*.");
  const named = wildcard ? spelled.slice(2) : spelled;
  const host = canonicalRelayHost(named);
  if (host === undefined || !isValidRelayHost(named) || (wildcard && (net.isIP(host) !== 0 || !host.includes(".")))) {
    throw new Error("egress relay allow entry has an invalid host");
  }
  return { host, port, wildcard };
}

export function relayAllowEntryMatches(entry: RelayAllowEntry, canonicalHost: string, port: number): boolean {
  if (entry.port !== port) return false;
  if (!entry.wildcard) return canonicalHost === entry.host;
  return net.isIP(canonicalHost) === 0 && canonicalHost.endsWith(`.${entry.host}`);
}

export function isLoopbackName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

const RESERVED = new net.BlockList();
// Unspecified, link-local, multicast, broadcast, then instance-metadata endpoints outside link-local space.
RESERVED.addSubnet("0.0.0.0", 8, "ipv4");
RESERVED.addAddress("::", "ipv6");
RESERVED.addSubnet("169.254.0.0", 16, "ipv4");
RESERVED.addSubnet("fe80::", 10, "ipv6");
RESERVED.addSubnet("224.0.0.0", 4, "ipv4");
RESERVED.addSubnet("ff00::", 8, "ipv6");
RESERVED.addAddress("255.255.255.255", "ipv4");
for (const address of ["100.100.100.200", "168.63.129.16", "192.0.0.192"]) RESERVED.addAddress(address, "ipv4");
RESERVED.addSubnet("fd00:ec2::", 32, "ipv6");
for (const address of ["fd20:ce::254", "fd00:c1::a9fe:a9fe", "fd00:42::42", "fd00:a9fe:a9fe::1", "fd00:100::100:200"]) {
  RESERVED.addAddress(address, "ipv6");
}

function inList(list: net.BlockList, address: string): boolean {
  const family = net.isIP(address);
  return family !== 0 && list.check(address, family === 6 ? "ipv6" : "ipv4");
}

// A literal no destination may be: unspecified, link-local, multicast, broadcast or an instance-metadata endpoint. Loopback is not in it.
export function isReservedAddress(address: string): boolean {
  return [address, embeddedIPv4(address)].some((form) => form !== undefined && inList(RESERVED, form));
}

export function isLoopbackAddress(address: string): boolean {
  return inList(LOOPBACK, address);
}

export function localInterfaceAddresses(): string[] {
  try {
    return Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address));
  } catch {
    return [];
  }
}

// Loopback, unspecified, or an address of one of this host's interfaces, in either spelling.
export function isThisHostAddress(address: string, local: readonly string[]): boolean {
  const forms = [address, embeddedIPv4(address)].filter((form): form is string => form !== undefined);
  return forms.some((form) => isLoopbackAddress(form) || form === "0.0.0.0" || form === "::"
    || local.some((own) => own.toLowerCase() === form.toLowerCase()));
}

// Whether a name may be dialed at an address it resolved to. A literal destination is never judged here.
export function resolvedAddressPermitted(
  canonicalHost: string,
  address: string,
  port: number,
  allow: readonly RelayAllowEntry[],
  local: readonly string[],
): boolean {
  if (net.isIP(canonicalHost) !== 0) return true;
  if (net.isIP(address) === 0) return false;
  // An address the allow list names itself is reachable by name too; an embedded form earns nothing.
  const literal = canonicalRelayHost(address);
  if (allow.some((entry) => !entry.wildcard && entry.host === literal && entry.port === port)) return true;
  if (isLoopbackName(canonicalHost)) return isLoopbackAddress(address);
  const forms = [address, embeddedIPv4(address)].filter((form): form is string => form !== undefined);
  if (forms.some((form) => inList(LOOPBACK, form) || inList(RESERVED, form))) return false;
  return !isThisHostAddress(address, local);
}
