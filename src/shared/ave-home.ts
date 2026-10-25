import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";

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
  readDacls(paths: readonly string[], protect?: boolean): WindowsDirectoryDacl[];
}

const DEFAULT_PRIVACY_RUNTIME: AveHomePrivacyRuntime = {
  platform: process.platform,
  readDacls: readWindowsDirectoryDacls,
};

/** Pass one-shot ACL input as UTF-16 environment JSON, never command interpolation or console-codepage stdin. */
export function readWindowsDirectoryDacls(paths: readonly string[], protect = false): WindowsDirectoryDacl[] {
  if (!(process.env.SystemRoot ?? process.env.windir)?.trim()) {
    return paths.map((path) => ({ path, category: "system-root-missing", error: "Windows system root is missing" }));
  }
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $icacls = [string]$request.icacls;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $sid = $identity.User.Value;
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    function Read-Dacl($path, $child) {
      try {
        $acl = Get-Acl -LiteralPath $path;
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
          $principal = @{ sid = $_.IdentityReference.Value; accessControlType = [int]$_.AccessControlType;
            fileSystemRights = [int]$_.FileSystemRights; inheritanceFlags = [int]$_.InheritanceFlags;
            propagationFlags = [int]$_.PropagationFlags; isInherited = $_.IsInherited };
          try { $principal.account = $_.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch {}
          $principal
        });
        @{ path = $path; currentUserSid = $sid; elevated = $elevated;
          ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
          protected = $acl.AreAccessRulesProtected; child = $child; rules = $rules }
      } catch { @{ path = $path; error = $_.Exception.Message } }
    }
    $refused = $null;
    $results = @(foreach ($path in $request.paths) {
      # Each later path lies inside the first: once one is refused, none is touched.
      if ($null -ne $refused) { @{ path = $path; category = $refused; error = 'An enclosing directory was refused' }; continue }
      if ($request.protect) {
        # GetAttributes reads the entry itself, never a link's target.
        $attributes = $null;
        try { $attributes = [System.IO.File]::GetAttributes($path) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {}
        if ($null -eq $attributes) {
          # A directory this call creates is owned by the token user from the start, with
          # the same protected owner-only DACL icacls then grants. A token whose default
          # owner is Administrators would otherwise own it as that group, and a parent's
          # CREATOR OWNER entry would leave an explicit Administrators grant behind.
          try {
            $security = [System.Security.AccessControl.DirectorySecurity]::new();
            $security.SetOwner($identity.User);
            $security.SetAccessRuleProtection($true, $false);
            $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'));
            [System.IO.Directory]::CreateDirectory($path, $security) | Out-Null;
            $attributes = [System.IO.File]::GetAttributes($path);
          } catch { $refused = 'directory-failed'; @{ path = $path; category = $refused; error = $_.Exception.Message }; continue }
        }
        # icacls follows a link, so an existing link is refused before anything is
        # written, and so is an owner the home rule does not accept (isOwnerOnlyDacl).
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          $refused = 'reparse-point'; @{ path = $path; category = $refused; error = 'Directory is a link or junction' }; continue
        }
        if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
          $refused = 'directory-failed'; @{ path = $path; category = $refused; error = 'Path is not a directory' }; continue
        }
        $owner = (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
        if ($owner -ne $sid -and -not ($elevated -and $owner -eq 'S-1-5-32-544')) {
          $refused = 'invalid-owner-grant'; @{ path = $path; category = $refused; error = 'Directory is owned by another account' }; continue
        }
        # /L acts on a link itself, so a link swapped in after the check above is
        # changed in place of its target.
        & $icacls $path '/inheritance:r' '/grant:r' ('*' + $sid + ':(OI)(CI)F') '/L' '/q' | Out-Null;
        if ($LASTEXITCODE -ne 0) { $refused = 'icacls-failed'; @{ path = $path; category = $refused; error = 'Directory permission command failed' }; continue }
      }
      Read-Dacl $path $false
    });
    if ($null -eq $refused -and $request.paths.Count -gt 1 -and (Test-Path -LiteralPath $request.paths[1])) {
      try {
        # Immediate children only; deeper entries inherit from the verified, protected secrets/ DACL.
        $results += @(Get-ChildItem -LiteralPath $request.paths[1] -Force | ForEach-Object { Read-Dacl $_.FullName $true });
      } catch { $results += @{ path = $request.paths[1]; error = $_.Exception.Message } }
    }
    ConvertTo-Json -InputObject @($results) -Depth 5 -Compress`,
  ], { encoding: "utf-8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ paths, protect, icacls: win32SystemBinary("icacls") }) }) });
  const results: unknown = JSON.parse(output);
  if (!Array.isArray(results) || results.length < paths.length) {
    throw new Error("Directory DACL read-back returned an invalid result set");
  }
  return results;
}

function isOwnerOnlyDacl(descriptor: WindowsDirectoryDacl, sid: string): boolean {
  // Allow an existing elevated administrator owner, but never group Allow entries; new homes belong to the token user.
  const ownerValid = descriptor.ownerSid === sid ||
    (descriptor.elevated === true && descriptor.ownerSid === "S-1-5-32-544");
  const rule = descriptor.rules?.[0];
  return ownerValid && descriptor.rules?.length === 1 && rule?.sid === sid &&
    rule.accessControlType === 0 && rule.fileSystemRights === 2032127 &&
    rule.inheritanceFlags === 3 && rule.propagationFlags === 0 && rule.isInherited === false;
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

/** Resolve system security executables by absolute path to avoid incompatible or attacker-controlled PATH entries. */
export function win32SystemBinary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, "System32", `${name}.exe`) : name;
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
    const descriptors = runtime.readDacls(paths, true);
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
