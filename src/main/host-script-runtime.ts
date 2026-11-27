import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { admitLocalRoute, localFs, withLocalityDecision } from "../shared/local-path-io.js";
import { dirname, isAbsolute, join, relative } from "node:path";
import { admitWindowsReparse, mapWindowsGenericRights, readWindowsDacls } from "../shared/windows-path-facts.js";
import { classifyWindowsSpelling } from "../shared/windows-path-spelling.js";
import { getConfiguredHostResources, type HostResources } from "./host-resources.js";

interface ScriptRuntimePaths { javascriptRuntime: string; bundledScriptsDirectory: string }
interface ScriptRootSnapshot { device: bigint; inode: bigint; manifestDigest: string }
const runtimePaths = new WeakMap<HostResources, ScriptRuntimePaths>();
const rootSnapshots = new WeakMap<ScriptRuntimePaths, ScriptRootSnapshot>();

/** Shipped commands use the host's runtime; no PATH lookup or package installation. */
export function hostScriptRuntimePaths(): ScriptRuntimePaths | undefined {
  const resources = getConfiguredHostResources();
  if (!resources) return undefined;
  const existing = runtimePaths.get(resources);
  if (existing) return existing;
  let directory = resources.isPackaged ? join(resources.resourcePath, "skill-scripts")
    : join(resources.resourcePath, "..", "dist", "skill-scripts");
  try {
    if (!lstatSync(directory).isSymbolicLink()) directory = realpathSync.native(directory);
  } catch { /* Missing outputs remain unverified. */ }
  const paths = Object.freeze({
    javascriptRuntime: process.execPath,
    bundledScriptsDirectory: directory,
  });
  runtimePaths.set(resources, paths);
  try {
    const info = lstatSync(directory, { bigint: true });
    const manifest = join(directory, "manifest.json");
    if (info.isDirectory() && !info.isSymbolicLink() && lstatSync(manifest).size <= 64 * 1024) {
      rootSnapshots.set(paths, { device: info.dev, inode: info.ino,
        manifestDigest: createHash("sha256").update(readFileSync(manifest)).digest("hex") });
    }
  } catch { /* Missing build outputs never acquire execution authority in this host generation. */ }
  return paths;
}

export function hostScriptWriteDenyPaths(): readonly string[] {
  const paths = hostScriptRuntimePaths();
  if (!paths) return [];
  const denied = [paths.bundledScriptsDirectory, paths.javascriptRuntime];
  for (const path of [...denied]) {
    try { denied.push(realpathSync.native(path)); } catch { /* Missing resources stay denied by name. */ }
  }
  return [...new Set(denied)];
}

// A caller operand is resolved only on a route proven local; any other spelling names no host file.
function sameFile(left: string, right: string): boolean {
  try {
    return withLocalityDecision(() =>
      localFs.realpathNative(admitLocalRoute(left).verdict) === localFs.realpathNative(admitLocalRoute(right).verdict));
  } catch { return false; }
}

/** Only direct, unchanged build outputs are executable resources. Links never qualify. */
export function isVerifiedHostScript(path: string): boolean {
  const paths = hostScriptRuntimePaths();
  if (!paths || !isAbsolute(path)) return false;
  const name = relative(paths.bundledScriptsDirectory, path);
  if (!/^[a-z][a-z0-9-]*\.cjs$/.test(name) || path !== join(paths.bundledScriptsDirectory, name)) return false;
  try {
    const snapshot = rootSnapshots.get(paths);
    const rootInfo = lstatSync(paths.bundledScriptsDirectory, { bigint: true });
    if (!snapshot || rootInfo.isSymbolicLink() || rootInfo.dev !== snapshot.device || rootInfo.ino !== snapshot.inode) return false;
    const root = realpathSync.native(paths.bundledScriptsDirectory);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024
      || dirname(realpathSync.native(path)) !== root) return false;
    const manifestPath = join(root, "manifest.json");
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 64 * 1024) return false;
    const manifestBytes = readFileSync(manifestPath);
    if (createHash("sha256").update(manifestBytes).digest("hex") !== snapshot.manifestDigest) return false;
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    const record = manifest as Record<string, unknown>;
    if (record.version !== 1 || !record.scripts || typeof record.scripts !== "object" || Array.isArray(record.scripts)) return false;
    const digest = (record.scripts as Record<string, unknown>)[name];
    return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
      && createHash("sha256").update(readFileSync(path)).digest("hex") === digest;
  } catch { return false; }
}

/** Exact argv roles only: command image, direct script operand, then ordinary data paths. */
export function hostScriptInvocationReadPaths(
  argv: readonly (string | undefined)[],
  environment: Readonly<Record<string, string | undefined>> = {},
  windowsWorkbookOperand?: string,
): readonly string[] {
  const paths = hostScriptRuntimePaths();
  const [runtime, script] = argv;
  if (environment.ELECTRON_RUN_AS_NODE !== "1"
    || Object.entries(environment).some(([name, value]) => value !== undefined
      && /^(?:NODE_|LD_|DYLD_)/i.test(name))) return [];
  if (!paths || !runtime || !script || runtime !== paths.javascriptRuntime || !isAbsolute(runtime) || !sameFile(runtime, paths.javascriptRuntime)
    || !isVerifiedHostScript(script)) return [];
  if (isWindowsWorkbookScript(script) && (windowsWorkbookOperand === undefined || windowsWorkbookOperand !== argv[2])) return [];
  return [...new Set([runtime, realpathSync.native(runtime), dirname(realpathSync.native(runtime)), script])];
}

export function isWindowsWorkbookScript(path: string | undefined): boolean {
  if (process.platform !== "win32" || path === undefined) return false;
  const paths = hostScriptRuntimePaths();
  return paths !== undefined && path === join(paths.bundledScriptsDirectory, "edit-xlsx.cjs");
}

export const WINDOWS_WORKBOOK_LITERAL_REQUIRED = "Windows workbook edits require a direct PowerShell command with a literal workbook path. [workbook-acl-unreadable]";
const WORKBOOK_ACL_DIFFERS = "The workbook has access rules Ave cannot keep on the edited file. [workbook-acl-differs]";
const WORKBOOK_ACL_UNREADABLE = "The workbook access rules could not be verified. [workbook-acl-unreadable]";
const OBJECT_INHERIT_ACE = 0x01;
const INHERITED_ACE = 0x10;
const ENCRYPTED_FILE = 0x4000;
const CREATOR_OWNER_SID = "S-1-3-0";

export function checkWindowsWorkbookAccess(path: string): { identity: string } | { reason: string } {
  try {
    if (classifyWindowsSpelling(path, "win32").kind !== "local-drive") return { reason: WORKBOOK_ACL_UNREADABLE };
    const [facts] = readWindowsDacls([path], { parent: true, access: true });
    if (facts && admitWindowsReparse(facts) !== true) return { reason: WORKBOOK_ACL_DIFFERS };
    if (!facts?.exists || !facts.dacl?.sacl || !facts.parent?.sacl || !facts.volumeSerialNumber || !facts.fileIndex || !facts.changeTime
      || facts.fileSystemName !== "NTFS" || [facts.volumeSerialNumber, facts.fileIndex, facts.changeTime].some(value => BigInt(value) === 0n)) {
      return { reason: WORKBOOK_ACL_UNREADABLE };
    }
    const { dacl, parent } = facts;
    const leafAccess = facts.dacl.sacl;
    if (facts.directory || (facts.attributes & ENCRYPTED_FILE) !== 0
      || facts.elevated || dacl.owner !== facts.currentUserSid || dacl.protected || dacl.nullDacl || parent.nullDacl
      || leafAccess.integrityLabel !== null || leafAccess.dynamicAccessControl || facts.parent.sacl.dynamicAccessControl
      || ((facts.parent.sacl.integrityLabel?.flags ?? 0) & OBJECT_INHERIT_ACE) !== 0) {
      return { reason: WORKBOOK_ACL_DIFFERS };
    }
    const inherited = parent.aces.filter(ace => (ace.flags & OBJECT_INHERIT_ACE) !== 0);
    if (inherited.length !== dacl.aces.length || dacl.aces.some((ace, index) => {
      const source = inherited[index];
      return source === undefined || ace.flags !== INHERITED_ACE || (ace.type !== 0 && ace.type !== 1) || ace.type !== source.type
        || ace.sid === null || ace.sid === CREATOR_OWNER_SID || ace.sid !== source.sid
        || mapWindowsGenericRights(ace.mask) !== mapWindowsGenericRights(source.mask);
    })) return { reason: WORKBOOK_ACL_DIFFERS };

    return { identity: `${facts.volumeSerialNumber}:${facts.fileIndex}:${facts.changeTime}` };
  } catch {
    return { reason: WORKBOOK_ACL_UNREADABLE };
  }
}

export function isHostScriptReadPath(path: string): boolean {
  const paths = hostScriptRuntimePaths();
  return paths !== undefined && (sameFile(path, paths.javascriptRuntime) || isVerifiedHostScript(path));
}
