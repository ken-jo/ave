import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { WINDOWS_OWNER_CLAIM_SOURCE } from "./windows-owner-claim.js";
import { admitWindowsReparse, isOwnerOnlyDacl, readWindowsDacls, windowsOwnerRules, type WindowsDaclFacts } from "./windows-path-facts.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";
import { win32SystemBinary, windowsSystemRoot } from "./windows-system-path.js";
export { win32SystemBinary } from "./windows-system-path.js";

/** All user-data paths must use this resolver so AVE_HOME isolates every store, including secrets. */
export function aveHome(): string {
  const home = resolve(process.env.AVE_HOME ?? defaultAveHome());
  // Tests replace the guard to refuse real user data; production uses its no-op implementation.
  checkResolvedAveHome(home);
  return home;
}

/** The actual default home, ignoring AVE_HOME, for recognizing protected real-user data. */
export function defaultAveHome(): string {
  return resolve(join(homedir(), ".ave"));
}

/** Keep live, user-overlay, and merge-artifact names shared across seeding, prompt reads, IPC, and merging. */

/** Live agent context. Seeded from packaged resources; read on every turn. */
export const AGENTS_DOC_NAME = "AGENTS.md";

/** Compose the keep-latest user overlay after the live document so user choices win. */
export const AGENTS_CUSTOM_DOC_NAME = "agents.custom.md";

/** Merge output is review-only until explicitly applied to the live document. */
export const AGENTS_MERGED_DOC_NAME = "AGENTS.md.merged";

/** Report actual protection: POSIX modes do not establish Windows ACL isolation. */
export type AveHomePrivacy =
  | { enforcement: "posix-mode"; home: string }
  | { enforcement: "win32-dacl"; home: string; sid: string }
  | {
    enforcement: "none";
    home: string;
    failedPath?: string;
    reason: string;
    category: AveHomePrivacyFailureCategory;
    extraPrincipals?: AveHomePrincipal[];
  };

export type AveHomePrivacyFailureCategory =
  | "system-root-missing"
  | "directory-failed"
  | "identity-failed"
  | "icacls-failed"
  | "read-back-failed"
  | "extra-principals"
  | "not-protected"
  | "invalid-owner-grant"
  | "owner-claim-failed"
  | "reparse-point";

export interface AveHomePrincipal {
  sid: string;
  account?: string;
}

export interface WindowsDirectoryDacl {
  path: string;
  currentUserSid?: string;
  elevated?: boolean;
  ownerSid?: string;
  protected?: boolean;
  child?: boolean;
  rules?: WindowsAccessRule[];
  category?: AveHomePrivacyFailureCategory;
  error?: string;
}

export interface WindowsAccessRule extends AveHomePrincipal {
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}

export interface AveHomePrivacyRuntime {
  platform: NodeJS.Platform;
  readDacls(paths: readonly string[], protect?: boolean, claimableRuntimeRoot?: string): WindowsDirectoryDacl[];
}

const DEFAULT_PRIVACY_RUNTIME: AveHomePrivacyRuntime = {
  platform: process.platform,
  readDacls: readWindowsDirectoryDacls,
};

/** Read native facts before and after the existing directory protection writes. */
export function readWindowsDirectoryDacls(paths: readonly string[], protect = false, claimableRuntimeRoot?: string): WindowsDirectoryDacl[] {
  try { windowsSystemRoot(); } catch {
    return paths.map(path => ({ path, category: "system-root-missing", error: "Windows system root is missing" }));
  }
  const results: WindowsDirectoryDacl[] = [];
  let refused: AveHomePrivacyFailureCategory | undefined;
  for (const path of paths) {
    if (refused) { results.push({ path, category: refused, error: "An enclosing directory was refused" }); continue; }
    try {
      let row = readWindowsDacls([resolve(path)])[0]!;
      if (!admitWindowsReparse(row, "evidence")) {
        refused = "reparse-point";
        results.push({ path, category: refused, error: "Directory is a link or junction" }); continue;
      }
      if (protect && row.exists === false) {
        runWindowsDirectoryWrite(path, row.currentUserSid, "create");
        row = readWindowsDacls([resolve(path)])[0]!;
      }
      if (!admitWindowsReparse(row, "evidence")) {
        refused = "reparse-point";
        results.push({ path, category: refused, error: "Directory is a link or junction" }); continue;
      }
      if (!row.exists || (protect && !row.directory) || !row.dacl) {
        if (protect) refused = "directory-failed";
        results.push({ path, category: "directory-failed", error: "Path is not a directory" }); continue;
      }
      if (protect) {
        const owner = row.dacl.owner;
        const claim = path === claimableRuntimeRoot && !row.elevated && owner === "S-1-5-32-544";
        if (owner !== row.currentUserSid && !(row.elevated && owner === "S-1-5-32-544") && !claim) {
          refused = "invalid-owner-grant";
          results.push({ path, category: refused, error: "Directory is owned by another account" }); continue;
        }
        try {
          runWindowsDirectoryWrite(path, row.currentUserSid, claim ? "claim" : "protect");
        } catch (error) {
          refused = claim ? "owner-claim-failed" : "icacls-failed";
          results.push({ path, category: refused, error: (error as Error).message }); continue;
        }
        row = readWindowsDacls([resolve(path)])[0]!;
      }
      results.push(directoryDescriptor(path, row));
    } catch (error) {
      if (protect) refused = "read-back-failed";
      results.push({ path, category: "read-back-failed", error: (error as Error).message });
    }
  }
  if (!refused && paths[1] && existsSync(paths[1])) {
    try {
      const children = readdirSync(paths[1]).map(child => join(paths[1]!, child));
      let rows: readonly WindowsDaclFacts[];
      try { rows = readWindowsDacls(children.map(path => resolve(path))); }
      catch {
        // Preserve the ordered refusal boundary when an enumerated child cannot be read.
        for (const path of children) results.push({ ...directoryDescriptor(path, readWindowsDacls([resolve(path)])[0]!), child: true });
        return results;
      }
      for (const [index, path] of children.entries()) {
        results.push({ ...directoryDescriptor(path, rows[index]!), child: true });
      }
    } catch (error) { results.push({ path: paths[1], error: (error as Error).message }); }
  }
  return results;
}

function directoryDescriptor(path: string, row: WindowsDaclFacts): WindowsDirectoryDacl {
  if (!admitWindowsReparse(row, "evidence")) return { path, category: "reparse-point", error: "Directory is a link or junction" };
  if (!row.dacl) return { path, error: "Directory DACL is missing" };
  return { path, currentUserSid: row.currentUserSid, elevated: row.elevated, ownerSid: row.dacl.owner,
    protected: row.dacl.protected, rules: windowsOwnerRules(row.dacl) };
}

/** Creation, owner claim and icacls remain writes; no standalone descriptor reader runs here. */
function runWindowsDirectoryWrite(path: string, sid: string, action: "create" | "claim" | "protect"): void {
  execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop';
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $path = [string]$request.path;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    if ($identity.User.Value -ne $request.sid) { throw 'Current account changed' }
    if ($request.action -eq 'create') {
      $security = [System.Security.AccessControl.DirectorySecurity]::new();
      $security.SetOwner($identity.User);
      $security.SetAccessRuleProtection($true, $false);
      $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'));
      [System.IO.Directory]::CreateDirectory($path, $security) | Out-Null;
    } else {
      if ($request.action -eq 'claim') {
        Add-Type -TypeDefinition @'
${WINDOWS_OWNER_CLAIM_SOURCE}
'@;
        [WindowsOwnerClaim]::ClaimFromAdministrators($path, $identity.User, $true);
      }
      & $request.icacls $path '/inheritance:r' '/grant:r' ('*' + $request.sid + ':(OI)(CI)F') '/L' '/q' | Out-Null;
      if ($LASTEXITCODE -ne 0) { throw 'Directory permission command failed' }
    }`,
  ], { windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
    env: windowsPowerShellEnv({ ...process.env, AVE_DACL_REQUEST: JSON.stringify({
      path, sid, action, icacls: win32SystemBinary("icacls"),
    }) }) });
}

let bootHomePrivacy: AveHomePrivacy | undefined;
let extensionsWithoutIsolationApproved = false;
let reportPrivacyRefusal: ((message: string) => void) | undefined;

/** Main-process audit wiring; no renderer or extension owns this state. */
export function setAveHomePrivacyRefusalReporter(reporter: (message: string) => void): void {
  reportPrivacyRefusal = reporter;
}

export function areExtensionsWithoutIsolationApproved(): boolean {
  return getAveHomePrivacyFailure() !== undefined && extensionsWithoutIsolationApproved;
}

/** Called only by the trusted, gesture-checked permissions IPC handler. */
export function approveExtensionsWithoutIsolation(): void {
  if (getAveHomePrivacyFailure() === undefined) throw new Error("Home privacy approval is not applicable");
  extensionsWithoutIsolationApproved = true;
}

/** Boot publishes this once before confinement starts; folder permission repairs require a restart. */
export function setAveHomePrivacyAtBoot(privacy: AveHomePrivacy): void {
  if (JSON.stringify(bootHomePrivacy) !== JSON.stringify(privacy)) extensionsWithoutIsolationApproved = false;
  bootHomePrivacy = Object.freeze(structuredClone(privacy));
}

/** The failed path is safe to show; command diagnostics stay in the host log. */
export function getAveHomePrivacyFailure(): Extract<AveHomePrivacy, { enforcement: "none" }> | undefined {
  return process.platform === "win32" && bootHomePrivacy?.enforcement === "none"
    ? bootHomePrivacy
    : undefined;
}

/** Guard initialization and each confined extension effect boundary. */
export function assertAveHomePrivacyForConfinement(): void {
  if (process.platform !== "win32") return;
  if (bootHomePrivacy?.enforcement !== "win32-dacl" && bootHomePrivacy?.enforcement !== "none") {
    throw new Error("Extension confinement refused: home privacy not established (boot did not publish AVE_HOME protection)");
  }
  const failure = getAveHomePrivacyFailure();
  if (failure !== undefined) {
    const principals = failure.extraPrincipals?.map(({ sid, account }) => account ? `${sid} (${account})` : sid).join(", ");
    const message = `Extension isolation is off: AVE_HOME privacy could not be established (${failure.category}, ${failure.failedPath ?? failure.home}). Approve running without isolation in Settings > Permissions, or fix the folder permissions.${principals ? ` Extra principals: ${principals}.` : ""}`;
    reportPrivacyRefusal?.(message);
    throw new Error(message);
  }
}

/** Test teardown only; production seals the result during boot. */
export function _resetAveHomePrivacyForTest(): void {
  bootHomePrivacy = undefined;
  extensionsWithoutIsolationApproved = false;
  reportPrivacyRefusal = undefined;
}

/** Windows needs an explicit owner-only inheritable DACL; report failure so confinement refuses unprotected storage. */
export function ensureAveHomePrivate(
  home = aveHome(),
  runtime: AveHomePrivacyRuntime = DEFAULT_PRIVACY_RUNTIME,
): AveHomePrivacy {
  if (runtime.platform !== "win32") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return { enforcement: "posix-mode", home };
  }
  let path = home;
  let category: AveHomePrivacyFailureCategory = "directory-failed";
  try {
    // The protection helper creates private directories with current-user ownership.
    mkdirSync(dirname(home), { recursive: true });
    category = "read-back-failed";
    path = home;
    const paths = [home, join(home, "secrets"), join(home, "subscription-runtimes")];
    const descriptors = runtime.readDacls(paths, true, join(home, "subscription-runtimes"));
    const sid = descriptors[0]?.currentUserSid;
    for (const target of paths) {
      if (!descriptors.some((entry) => entry.path === target && !entry.child)) {
        throw new Error("Directory DACL read-back missing");
      }
    }
    for (const descriptor of descriptors) {
      path = descriptor.path;
      if (descriptor.error !== undefined) {
        category = descriptor.category ?? "read-back-failed";
        throw new Error(descriptor?.error ?? "Directory DACL read-back missing");
      }
      if (typeof sid !== "string" || !/^S-1-[0-9-]+$/.test(sid) || descriptor.currentUserSid !== sid) {
        category = "identity-failed";
        throw new Error("Current account SID read-back is invalid");
      }
      if (!Array.isArray(descriptor.rules) || descriptor.rules.some((rule) =>
        typeof rule.sid !== "string" || !/^S-1-[0-9-]+$/.test(rule.sid) ||
        ![0, 1].includes(rule.accessControlType) || !Number.isInteger(rule.fileSystemRights) ||
        !Number.isInteger(rule.inheritanceFlags) || !Number.isInteger(rule.propagationFlags) ||
        typeof rule.isInherited !== "boolean")) {
        throw new Error("Directory DACL rules read-back is invalid");
      }
      const extraPrincipals = [...new Map(descriptor.rules
        .filter((rule) => rule.sid !== sid && (!descriptor.child || (rule.accessControlType === 0 && !rule.isInherited)))
        .map(({ sid, account }) => [sid, { sid, ...(account ? { account } : {}) }])).values()];
      if (extraPrincipals.length > 0) {
        return { enforcement: "none", home, failedPath: path, category: "extra-principals", extraPrincipals,
          reason: "Remove the extra principal entries or move AVE_HOME" };
      }
      if (descriptor.child) continue;
      if (descriptor.protected !== true) {
        return { enforcement: "none", home, failedPath: path, category: "not-protected", reason: "Directory DACL is not protected against inheritance" };
      }
      if (!isOwnerOnlyDacl(descriptor, sid)) {
        return { enforcement: "none", home, failedPath: path, category: "invalid-owner-grant", reason: "Directory DACL is not owner-only FullControl with object and container inheritance" };
      }
    }
    if (!sid) throw new Error("Current account SID read-back missing");
    return { enforcement: "win32-dacl", home, sid };
  } catch (err) {
    return { enforcement: "none", home, failedPath: path, category, reason: (err as Error).message };
  }
}
