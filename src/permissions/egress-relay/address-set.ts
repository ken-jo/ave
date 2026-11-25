// Portions derived from @anthropic-ai/sandbox-runtime (Apache-2.0) and modified; see THIRD-PARTY-NOTICES.
// Address ranges as block lists: range entries, membership, the IPv4 address inside an IPv6 literal, loopback.
import { BlockList, isIP } from "node:net";

export const LOOPBACK_RANGES: readonly string[] = ["127.0.0.0/8", "::1"];

type Family = "ipv4" | "ipv6";

function familyOf(address: string): Family | undefined {
  const version = isIP(address);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : undefined;
}

function withoutZone(address: string): string {
  const at = address.indexOf("%");
  return at < 0 ? address : address.slice(0, at);
}

function quad(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

// The eight 16-bit groups of an IPv6 literal, read from its URL-normalized spelling.
type Groups = [number, number, number, number, number, number, number, number];

function groupsOf(address: string): Groups | undefined {
  let spelled: string;
  try {
    spelled = new URL(`http://[${withoutZone(address)}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const halves = spelled.split("::");
  const before = halves[0] ? halves[0].split(":") : [];
  const after = halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length > 1 ? 8 - before.length - after.length : 0;
  if (zeros < 0 || before.length + zeros + after.length !== 8) return undefined;
  return [...before, ...Array<string>(zeros).fill("0"), ...after].map((group) => Number.parseInt(group, 16)) as Groups;
}

function allZero(groups: readonly number[], from: number, to: number): boolean {
  return groups.slice(from, to).every((group) => group === 0);
}

// The IPv4 address of an IPv4-mapped IPv6 literal (::ffff:a.b.c.d).
function mappedIPv4(address: string): string | undefined {
  if (!/ffff/i.test(address)) return undefined;
  const groups = groupsOf(address);
  if (groups === undefined || !allZero(groups, 0, 5) || groups[5] !== 0xffff) return undefined;
  return quad(groups[6], groups[7]);
}

// The IPv4 address an IPv6 literal carries: 2002::/16, 64:ff9b::/96, mapped, compatible, translated.
export function embeddedIPv4(address: string): string | undefined {
  if (isIP(address) !== 6) return undefined;
  const groups = groupsOf(address);
  if (groups === undefined) return undefined;
  if (groups[0] === 0x2002) return quad(groups[1], groups[2]);
  const tail = quad(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && allZero(groups, 2, 6)) return tail;
  if (allZero(groups, 0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) return tail;
  if (allZero(groups, 0, 4) && groups[4] === 0xffff && groups[5] === 0) return tail;
  return undefined;
}

interface AddressRange {
  readonly address: string;
  readonly prefix: number;
  readonly family: Family;
}

// `address` or `address/prefix`. A mapped IPv6 range is the IPv4 range it covers; one wider than /96 is refused.
function parseRange(entry: string): AddressRange | undefined {
  const cut = entry.indexOf("/");
  const address = withoutZone(cut < 0 ? entry : entry.slice(0, cut));
  const family = familyOf(address);
  if (family === undefined) return undefined;
  const bits = family === "ipv6" ? 128 : 32;
  let prefix = bits;
  if (cut >= 0) {
    const text = entry.slice(cut + 1);
    if (!/^\d{1,3}$/.test(text) || Number(text) > bits) return undefined;
    prefix = Number(text);
  }
  const mapped = family === "ipv6" ? mappedIPv4(address) : undefined;
  if (mapped === undefined) return { address, prefix, family };
  return prefix < 96 ? undefined : { address: mapped, prefix: prefix - 96, family: "ipv4" };
}

// False when the entry is not an address or range; the list is then unchanged.
export function addRange(list: BlockList, entry: string): boolean {
  const range = parseRange(entry);
  if (range === undefined) return false;
  try {
    list.addSubnet(range.address, range.prefix, range.family);
    return true;
  } catch {
    return false;
  }
}

export function addressInSet(list: BlockList, address: string): boolean {
  const bare = withoutZone(address);
  const family = familyOf(bare);
  return family !== undefined && list.check(bare, family);
}

const LOOPBACK = new BlockList();
for (const range of LOOPBACK_RANGES) {
  if (!addRange(LOOPBACK, range)) throw new Error(`invalid address range: ${JSON.stringify(range)}`);
}

// Strict: the spelling is judged as written, so a zone on a spelling that is not an address (`127.0.0.1%eth0`, `::1%`) is not loopback.
export function isLoopbackAddress(address: string): boolean {
  const family = familyOf(address);
  return family !== undefined && LOOPBACK.check(address, family);
}

export function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}
