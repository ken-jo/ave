import { execFileSync } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { resolveWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

/** Match native ledger output to requests; this spelling key is never object identity. */
export function windowsPathKey(path: string): string {
  const ordinary = path.replace(/\//g, "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  return win32.normalize(ordinary).replace(/[\\/]+$/, "").toLowerCase();
}

interface WindowsPathComponentFacts {
  readonly exists: boolean | null;
  readonly canonical: string | null;
  readonly volumeSerial: string | null;
  readonly fileId: string | null;
  /** The 32-bit volume serial exposed as Node's bigint dev. */
  readonly volumeSerialNumber: string | null;
  /** The legacy 64-bit file index exposed as Node's bigint ino. */
  readonly fileIndex: string | null;
  readonly attributes: number;
  readonly reparseTag: number;
  readonly directory: boolean;
  /** Substitute name read from the retained link handle; null for other objects. */
  readonly reparseTarget: string | null;
}

export interface WindowsPathFacts extends WindowsPathComponentFacts {
  readonly ancestors: readonly WindowsPathComponentFacts[];
}

/** Native object identity is independent of path spelling, aliases and directory case mode. */
export function windowsObjectKey(facts: Pick<WindowsPathFacts, "volumeSerial" | "fileId">): string {
  if (facts.volumeSerial === null || facts.fileId === null) throw new Error("Windows object identity is missing");
  return `${facts.volumeSerial}:${facts.fileId}`;
}

interface WindowsAce {
  readonly type: number;
  readonly flags: number;
  readonly mask: number;
  readonly sid: string | null;
  readonly account?: string;
}

export interface WindowsDacl {
  readonly identity: { readonly volumeSerial: string; readonly fileId: string };
  readonly owner: string;
  readonly group?: string;
  readonly protected: boolean;
  readonly nullDacl: boolean;
  readonly aces: readonly WindowsAce[];
}

export interface WindowsDaclFacts extends WindowsPathFacts {
  readonly currentUserSid: string;
  readonly elevated: boolean;
  readonly principals: Readonly<Record<string, string>>;
  readonly dacl: WindowsDacl | null;
  readonly parent?: WindowsDacl | null;
  readonly contentHex?: string | null;
}

const SID_PATTERN = /^S-1-[0-9-]+$/;
const HEX_64_PATTERN = /^0x[0-9a-f]{16}$/;
const HEX_128_PATTERN = /^0x[0-9a-f]{32}$/;

function isUint(value: unknown, maximum = 0xffffffff): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function isComponent(value: unknown): value is WindowsPathComponentFacts {
  if (value === null || typeof value !== "object") return false;
  const row = value as WindowsPathComponentFacts;
  if (row.reparseTarget !== null && (typeof row.reparseTarget !== "string" || !row.reparseTarget || row.reparseTarget.includes("\0"))) return false;
  if (![true, false, null].includes(row.exists) || !isUint(row.attributes) || !isUint(row.reparseTag) || typeof row.directory !== "boolean") return false;
  if (row.exists !== true) return [row.canonical, row.volumeSerial, row.fileId, row.volumeSerialNumber, row.fileIndex].every(field => field === null)
    && row.attributes === 0 && row.reparseTag === 0 && !row.directory;
  return typeof row.canonical === "string" && row.canonical.length > 0
    && typeof row.volumeSerial === "string" && HEX_64_PATTERN.test(row.volumeSerial)
    && typeof row.fileId === "string" && HEX_128_PATTERN.test(row.fileId)
    && typeof row.volumeSerialNumber === "string" && HEX_64_PATTERN.test(row.volumeSerialNumber)
    && BigInt(row.volumeSerialNumber) <= 0xffffffffn
    && typeof row.fileIndex === "string" && HEX_64_PATTERN.test(row.fileIndex);
}

function isDescriptor(value: unknown): value is WindowsDacl {
  if (value === null || typeof value !== "object") return false;
  const row = value as WindowsDacl;
  return typeof row.owner === "string" && SID_PATTERN.test(row.owner) && (row.group === undefined || (typeof row.group === "string" && SID_PATTERN.test(row.group)))
    && typeof row.protected === "boolean" && typeof row.nullDacl === "boolean"
    && row.identity !== null && typeof row.identity === "object"
    && typeof row.identity.volumeSerial === "string" && HEX_64_PATTERN.test(row.identity.volumeSerial)
    && typeof row.identity.fileId === "string" && HEX_128_PATTERN.test(row.identity.fileId)
    && Array.isArray(row.aces) && (!row.nullDacl || row.aces.length === 0)
    && row.aces.every(ace => ace !== null && typeof ace === "object" && isUint(ace.type, 255) && isUint(ace.flags, 255)
      && isUint(ace.mask) && (ace.sid === null || (typeof ace.sid === "string" && SID_PATTERN.test(ace.sid)))
      && (ace.account === undefined || typeof ace.account === "string"));
}

function request(paths: readonly string[], mode: "--pin" | "--dacl", flags: readonly string[] = []): WindowsPathFacts[] {
  if (paths.length === 0) return [];
  if (paths.some(path => !isAbsolute(path))) throw new Error("Windows path facts require absolute paths");
  const output = execFileSync(resolveWindowsPathKindHelper(), [mode, ...flags, ...paths], {
    encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 8 * 1024 * 1024,
  });
  const response: unknown = JSON.parse(output);
  if (!Array.isArray(response) || response.length !== paths.length) throw new Error("Invalid Windows path facts response");
  // The wire descriptor is flat; the typed view distinguishes an absent DACL
  // snapshot from a present descriptor whose ACL is unrestricted.
  const rows = response.map((row: unknown) => {
    if (mode !== "--dacl" || row === null || typeof row !== "object") return row;
    const { identity, owner, group, protected: protectedDacl, nullDacl, aces, ...facts } = row as Record<string, unknown>;
    return { ...facts, dacl: identity === null ? null : { identity, owner, ...(group === undefined ? {} : { group }), protected: protectedDacl, nullDacl, aces } };
  });
  for (const row of rows as WindowsDaclFacts[]) {
    if (!isComponent(row) || !Array.isArray(row.ancestors) || !row.ancestors.every(isComponent)) throw new Error("Invalid Windows path pin");
    if (mode !== "--dacl") continue;
    if (typeof row.currentUserSid !== "string" || !SID_PATTERN.test(row.currentUserSid) || typeof row.elevated !== "boolean"
      || row.principals === null || typeof row.principals !== "object" || Array.isArray(row.principals)
      || Object.entries(row.principals).some(([sid, name]) => !SID_PATTERN.test(sid) || !["srt-sandbox", "sandbox-runtime-users"].includes(name))) {
      throw new Error("Invalid Windows DACL identity");
    }
    if (row.exists === true ? !isDescriptor(row.dacl) : row.dacl !== null) throw new Error("Invalid Windows DACL descriptor");
    if (row.dacl !== null && (row.dacl.identity.volumeSerial !== row.volumeSerial || row.dacl.identity.fileId !== row.fileId)) throw new Error("Windows DACL identity mismatch");
    if (flags.includes("--parent")) {
      const parent = row.ancestors.at(-1);
      if (parent?.exists === true ? !isDescriptor(row.parent) : row.parent !== null) throw new Error("Invalid Windows parent DACL");
      if (row.parent && (row.parent.identity.volumeSerial !== parent?.volumeSerial || row.parent.identity.fileId !== parent.fileId)) throw new Error("Windows parent DACL identity mismatch");
    }
    if (flags.includes("--content") && row.contentHex !== null
      && (typeof row.contentHex !== "string" || row.contentHex.length > 2097152 || !/^(?:[0-9a-f]{2})*$/.test(row.contentHex))) throw new Error("Invalid Windows file content");
  }
  return rows as WindowsPathFacts[];
}

export function pinWindowsPaths(paths: readonly string[]): readonly WindowsPathFacts[] {
  return request(paths, "--pin");
}

/** Content is read on the descriptor's pinned handle, bounded to one MiB. */
export function readWindowsDacls(paths: readonly string[], options: { parent?: boolean; content?: boolean } = {}): readonly WindowsDaclFacts[] {
  // The native walk holds non-write/non-delete-shared component handles through DACL capture; separate pins add no snapshot binding.
  return request(paths, "--dacl", [...(options.parent ? ["--parent"] : []), ...(options.content ? ["--content"] : [])]) as WindowsDaclFacts[];
}

/** This is the sole admission rule for Windows path pins, including unfamiliar tags. */
export function admitWindowsReparse(facts: WindowsPathFacts, use: "grant" | "evidence" = "evidence"): boolean | "resolve" {
  let follow = false;
  for (const component of [...facts.ancestors, facts]) {
    if (component.exists === null) {
      // The non-following walk stops below a link; only resolution can prove the remaining components.
      if (use === "grant" && follow) continue;
      return false;
    }
    const tag = component.reparseTag;
    if (tag === 0 && (component.attributes & 0x400) === 0) continue;
    if (use === "evidence" || tag === 0) return false;
    if ((tag & 0x20000000) === 0) continue;
    if (tag !== 0xa0000003 && tag !== 0xa000000c) return false;
    follow = true;
  }
  return follow ? "resolve" : true;
}

export function mapWindowsGenericRights(mask: number): number {
  let mapped = mask & 0x0fffffff;
  if ((mask & 0x80000000) !== 0) mapped |= 0x120089;
  if ((mask & 0x40000000) !== 0) mapped |= 0x120116;
  if ((mask & 0x20000000) !== 0) mapped |= 0x1200a0;
  if ((mask & 0x10000000) !== 0) mapped |= 0x1f01ff;
  return mapped >>> 0;
}

export type WindowsReadDenyPrincipal = "Everyone" | "Users" | "Authenticated Users" | "INTERACTIVE" | "srt-sandbox" | "sandbox-runtime-users";

export function evaluateWindowsReadDacl(facts: WindowsDaclFacts): {
  status: "private" | "readable";
  principals?: WindowsReadDenyPrincipal[];
  reason?: string;
} {
  if (!facts.dacl) throw new Error("DACL descriptor is missing");
  if (facts.dacl.nullDacl) return { status: "readable", principals: ["Everyone"], reason: "Unrestricted DACL" };
  const principals: Readonly<Record<string, string>> = {
    "S-1-1-0": "Everyone", "S-1-5-32-545": "Users", "S-1-5-11": "Authenticated Users", "S-1-5-4": "INTERACTIVE", ...facts.principals,
  };
  const matched = new Set<WindowsReadDenyPrincipal>();
  for (const ace of facts.dacl.aces) {
    if ((ace.flags & 8) !== 0) continue;
    if (![0, 1].includes(ace.type) || ace.sid === null) throw new Error("Unsupported DACL entry");
    if (ace.type === 1) continue;
    const principal = principals[ace.sid];
    if ((mapWindowsGenericRights(ace.mask) & 1) !== 0 && principal !== undefined) matched.add(principal as WindowsReadDenyPrincipal);
  }
  return matched.size === 0 ? { status: "private" } : { status: "readable", principals: [...matched] };
}

export function leadingWindowsDenies(dacl: WindowsDacl | null, sid: string): { mask: number; inheritable: number } {
  if (!/^S-1-[0-9]+(?:-[0-9]+){0,15}$/.test(sid)) throw new Error("Invalid deny DACL SID");
  const parts = sid.slice(4).split("-").map(value => BigInt(value));
  if (parts[0]! > 0xffffffffffffn || parts.slice(1).some(value => value > 0xffffffffn)) throw new Error("Invalid deny DACL SID");
  const trustee = `S-1-${parts.join("-")}`;
  let mask = 0, inheritable = 0;
  for (const ace of dacl?.aces ?? []) {
    if (ace.type !== 1 || (ace.flags & 0x10) !== 0) break;
    if (ace.sid !== trustee || (ace.flags & 8) !== 0) continue;
    mask |= ace.mask;
    if ((ace.flags & 3) === 3 && (ace.flags & 4) === 0) inheritable |= ace.mask;
  }
  return { mask: mask >>> 0, inheritable: inheritable >>> 0 };
}

export interface WindowsOwnerAccessRule {
  sid: string;
  account?: string;
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}

export function windowsOwnerRules(dacl: WindowsDacl): WindowsOwnerAccessRule[] {
  if (dacl.nullDacl) throw new Error("Unrestricted directory DACL");
  return dacl.aces.map(ace => {
    if (![0, 1].includes(ace.type) || ace.sid === null) throw new Error("Unsupported directory DACL entry");
    return { sid: ace.sid, ...(ace.account ? { account: ace.account } : {}), accessControlType: ace.type, fileSystemRights: ace.mask | 0,
      inheritanceFlags: ((ace.flags & 2) !== 0 ? 1 : 0) | ((ace.flags & 1) !== 0 ? 2 : 0),
      propagationFlags: ((ace.flags & 4) !== 0 ? 1 : 0) | ((ace.flags & 8) !== 0 ? 2 : 0), isInherited: (ace.flags & 0x10) !== 0 };
  });
}

export function isOwnerOnlyDacl(descriptor: { ownerSid?: string; elevated?: boolean; rules?: WindowsOwnerAccessRule[] }, sid: string): boolean {
  const ownerValid = descriptor.ownerSid === sid || (descriptor.elevated === true && descriptor.ownerSid === "S-1-5-32-544");
  const rule = descriptor.rules?.[0];
  return ownerValid && descriptor.rules?.length === 1 && rule?.sid === sid && rule.accessControlType === 0 && rule.fileSystemRights === 2032127
    && rule.inheritanceFlags === 3 && rule.propagationFlags === 0 && rule.isInherited === false;
}

export interface WindowsPolicyDescriptor {
  ownerSid: string;
  nullDacl: boolean;
  rules: { sid: string; mask: number; allow: boolean; inheritOnly: boolean }[];
}

const ADMINISTRATORS_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";
const TRUSTED_WRITERS = new Set([ADMINISTRATORS_SID, SYSTEM_SID, "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);

export function windowsPolicyDescriptor(dacl: WindowsDacl): WindowsPolicyDescriptor {
  return { ownerSid: dacl.owner, nullDacl: dacl.nullDacl, rules: dacl.aces.map(ace => {
    if (![0, 1, 5, 6].includes(ace.type) || ace.sid === null) throw new Error("Unsupported policy DACL entry");
    return { sid: ace.sid, mask: ace.mask, allow: ace.type === 0 || ace.type === 5, inheritOnly: (ace.flags & 8) !== 0 };
  }) };
}

export function windowsPolicyTrustFailure(file: WindowsPolicyDescriptor, parent: WindowsPolicyDescriptor): string | null {
  if (file.ownerSid !== ADMINISTRATORS_SID && file.ownerSid !== SYSTEM_SID) return `owner ${file.ownerSid}`;
  if (!TRUSTED_WRITERS.has(parent.ownerSid)) return `parent owner ${parent.ownerSid}`;
  for (const [descriptor, label, mask] of [[file, "file", 0x500d0116], [parent, "parent", 0x500d0040]] as const) {
    if (descriptor.nullDacl) return `${label} has an unrestricted DACL`;
    for (const rule of descriptor.rules) {
      if (rule.allow && !rule.inheritOnly && (rule.mask & mask) !== 0 && !TRUSTED_WRITERS.has(rule.sid)) return `${label} writable by ${rule.sid}`;
    }
  }
  return null;
}
