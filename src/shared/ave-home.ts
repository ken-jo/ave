import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";

export const AVE_HOME_CONFIGURATION_DIRECTORY = "config";
export const AVE_HOME_CONFIGURATION_MARKER = ".ave-config-migrated";
export const AVE_HOME_CONFIGURATION_MARKER_CONTENT = "ave-home-boundary-v1";

let bootConfiguration: { home: string; migrated: boolean } | undefined;
const configurationDecisions = new Map<string, boolean | AveHomeConfigurationUntrustedError>();

export class AveHomeConfigurationUntrustedError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`Configuration boundary is untrusted at ${path}: ${reason}`);
    this.name = "AveHomeConfigurationUntrustedError";
  }
}

function configurationKey(home: string): string {
  const root = resolve(home);
  return process.platform === "win32" ? root.toLowerCase() : root;
}

export function invalidateAveHomeConfiguration(home: string): void {
  configurationDecisions.delete(configurationKey(home));
}

/** Boot pins its verified decision before any configuration reader starts. */
export function setAveHomeConfigurationAtBoot(home: string, migrated: boolean): void {
  bootConfiguration = { home: resolve(home), migrated };
}

export function aveHomeConfigurationDirectory(home = aveHome()): string {
  const root = resolve(home);
  if (bootConfiguration !== undefined) {
    const bootHome = bootConfiguration.home;
    if (process.platform === "win32" ? bootHome.toLowerCase() === root.toLowerCase() : bootHome === root) {
      return bootConfiguration.migrated ? join(root, AVE_HOME_CONFIGURATION_DIRECTORY) : root;
    }
  }
  const key = configurationKey(root);
  let committed = configurationDecisions.get(key);
  // Cache for this process; migration invalidates it, external changes require restart.
  if (committed === undefined) {
    try { committed = verifyAveHomeConfiguration(root); }
    catch (error) {
      if (error instanceof AveHomeConfigurationUntrustedError) configurationDecisions.set(key, error);
      throw error;
    }
    configurationDecisions.set(key, committed);
  }
  if (committed instanceof AveHomeConfigurationUntrustedError) throw committed;
  return committed ? join(root, AVE_HOME_CONFIGURATION_DIRECTORY) : root;
}

export function verifyAveHomeConfiguration(home: string, recoverInvalidMarker = false): boolean {
  const config = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
  try {
    try {
      const directory = lstatSync(config);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Configuration directory is a link or is not a directory");
      lstatSync(join(config, AVE_HOME_CONFIGURATION_MARKER));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
        $request=ConvertFrom-Json $env:AVE_DACL_REQUEST;
        Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
        $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
        $elevated=([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
        try {
          $committed=[HomeDirectoryDacl]::ConfigurationCommitted($request.path,$identity.User,$elevated,$request.recover);
          @{ committed=$committed } | ConvertTo-Json -Compress
        } catch {
          @{ reason=$_.Exception.InnerException.Message } | ConvertTo-Json -Compress
        }`;
      const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
      ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
        AVE_DACL_REQUEST: JSON.stringify({ path: config, recover: recoverInvalidMarker }) }) });
      const result = JSON.parse(output) as { committed?: unknown; reason?: unknown };
      if (typeof result.reason === "string") throw new Error(result.reason);
      if (typeof result.committed !== "boolean") throw new Error("Invalid boundary verification result");
      return result.committed;
    }
    let directory: number;
    try { directory = openSync(config, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const markerPath = join(process.platform === "linux" ? `/proc/self/fd/${directory}` : config, AVE_HOME_CONFIGURATION_MARKER);
      let marker: number;
      try { marker = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      try {
        const protection = fstatSync(directory);
        if (!protection.isDirectory() || protection.uid !== process.getuid!() || (protection.mode & 0o077) !== 0) {
          throw new Error("Configuration directory protection is unverified");
        }
        const identity = fstatSync(marker);
        if (!identity.isFile()) throw new Error("Configuration marker is not a regular file");
        if (identity.size === Buffer.byteLength(AVE_HOME_CONFIGURATION_MARKER_CONTENT) && readFileSync(marker, "utf8") === AVE_HOME_CONFIGURATION_MARKER_CONTENT) return true;
        if (!recoverInvalidMarker) throw new Error("Configuration marker content is invalid");
        const current = lstatSync(markerPath);
        if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Configuration marker changed before recovery");
        unlinkSync(markerPath);
        return false;
      } finally { closeSync(marker); }
    } finally { closeSync(directory); }
  } catch (error) {
    throw new AveHomeConfigurationUntrustedError(config, error instanceof Error ? error.message : "Verification failed");
  }
}

export const AVE_HOME_PROTECTED_DIRECTORIES: readonly string[] = Object.freeze([
  "secrets", "subscription-runtimes", "keys", "certs", AVE_HOME_CONFIGURATION_DIRECTORY,
]);

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
  | { enforcement: "win32-dacl"; home: string; sid: string; repairs?: string[]; diagnostics?: string[] }
  | {
    enforcement: "none";
    home: string;
    failedPath?: string;
    reason: string;
    category: AveHomePrivacyFailureCategory;
    extraPrincipals?: AveHomePrincipal[];
    repairs?: string[];
    diagnostics?: string[];
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
  repaired?: boolean;
  skippedLinks?: number;
  cleanupWarnings?: string[];
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

// FILE_GENERIC_READ | FILE_GENERIC_EXECUTE (including SYNCHRONIZE), with no mutating rights.
const WINDOWS_ROOT_READ_ONLY_RIGHTS = 0x1200a9;

function mapFileGenericRights(mask: number): number {
  return (mask & 0x0fffffff) | ((mask & 0x80000000) ? 0x120089 : 0) |
    ((mask & 0x40000000) ? 0x120116 : 0) | ((mask & 0x20000000) ? 0x1200a0 : 0) |
    ((mask & 0x10000000) ? 0x1f01ff : 0);
}

/** ACL input stays in environment JSON; the bootstrap reads the script from stdin. */
export function readWindowsDirectoryDacls(paths: readonly string[], protect = false): WindowsDirectoryDacl[] {
  if (!(process.env.SystemRoot ?? process.env.windir)?.trim()) {
    return paths.map((path) => ({ path, category: "system-root-missing", error: "Windows system root is missing" }));
  }
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $sid = $identity.User.Value;
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    function Read-Dacl($path, $handle) {
      $acl = [HomeDirectoryDacl]::Read($handle);
      $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        $principal = @{ sid = $_.IdentityReference.Value; accessControlType = [int]$_.AccessControlType;
          fileSystemRights = [int]$_.FileSystemRights; inheritanceFlags = [int]$_.InheritanceFlags;
          propagationFlags = [int]$_.PropagationFlags; isInherited = $_.IsInherited };
        try { $principal.account = $_.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch {}
        $principal
      });
      @{ path = $path; currentUserSid = $sid; elevated = $elevated;
        ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
        protected = $acl.AreAccessRulesProtected; rules = $rules }
    }
    $refused = $false;
    $homeHandle = $null;
    try {
      $results = @(foreach ($path in $request.paths) {
        if ($refused) { @{ path = $path; error = 'An enclosing directory was refused' }; continue }
        $handle = $null;
        try {
          $repaired = -1;
          if (-not $request.protect) {
            $handle = [HomeDirectoryDacl]::OpenHome($path, $identity.User, $false);
          } elseif ($null -eq $homeHandle) {
            $homeHandle = [HomeDirectoryDacl]::OpenHome($path, $identity.User, $true);
            $handle = $homeHandle;
            $refused = -not [HomeDirectoryDacl]::RootSafe([HomeDirectoryDacl]::Read($handle), $identity.User, $elevated, $request.readOnlyRights);
          } else {
            if ([System.IO.Path]::GetDirectoryName($path) -ne [System.IO.Path]::GetFullPath($request.paths[0])) { throw 'Directory is outside the pinned home' }
            $leaf = [System.IO.Path]::GetFileName($path);
            $repaired = [HomeDirectoryDacl]::Repair($homeHandle, $leaf, $identity.User, $elevated, $request.paths[0]);
            $handle = [HomeDirectoryDacl]::OpenRelative($homeHandle, $leaf, $identity.User, 1, $true, $true, $true);
          }
          if ($null -eq $handle) { throw 'Directory does not exist' }
          $result = Read-Dacl $path $handle;
          if ($repaired -ge 0) { $result.repaired = $true; $result.skippedLinks = $repaired }
          if ($request.protect -and $null -ne $homeHandle -and $handle -ne $homeHandle) { $result.cleanupWarnings = @([HomeDirectoryDacl]::CleanupWarnings.ToArray()) }
          $result
        } catch {
          $refused = $true;
          $errorText = $_.Exception.GetBaseException().Message;
          $category = 'directory-failed';
          if ($errorText -match 'link or junction') { $category = 'reparse-point' }
          elseif ($errorText -match 'owned by another account') { $category = 'invalid-owner-grant' }
          @{ path = $path; category = $category; error = ('Directory "' + $path + '": ' + $_.Exception.Message) }
        } finally {
          if ($null -ne $handle -and $handle -ne $homeHandle) { $handle.Dispose() }
        }
      });
      ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
    } finally { if ($null -ne $homeHandle) { $homeHandle.Dispose() } }`;
  const bootstrap = "$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))";
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64"),
  ], { input: script, encoding: "utf-8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ paths, protect, readOnlyRights: WINDOWS_ROOT_READ_ONLY_RIGHTS }) }) });
  const results: unknown = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== paths.length) {
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

export function acknowledgeHomeBoundaryRepair(home: string, path: string): void {
  if (process.platform !== "win32") return;
  const name = AVE_HOME_PROTECTED_DIRECTORIES.find((entry) => join(home, entry) === path);
  if (name === undefined) throw new Error("Repair notice boundary is invalid");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    $request=ConvertFrom-Json $env:AVE_DACL_REQUEST;
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated=([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    [HomeDirectoryDacl]::AcknowledgeRepair($request.home,$request.name,$identity.User,$elevated);`;
  execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64")], {
    input: script, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: windowsPowerShellEnv({ ...process.env, AVE_DACL_REQUEST: JSON.stringify({ home, name }) }),
  });
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
  bootConfiguration = undefined;
  configurationDecisions.clear();
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
    const config = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
    mkdirSync(config, { mode: 0o700, recursive: true });
    if (process.platform !== "win32") {
      const handle = openSync(config, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchmodSync(handle, 0o700); }
      finally { closeSync(handle); }
    }
    return { enforcement: "posix-mode", home };
  }
  let path = home;
  let category: AveHomePrivacyFailureCategory = "directory-failed";
  const repairs: string[] = [];
  const diagnostics: string[] = [];
  try {
    // The protection helper creates private directories with current-user ownership.
    mkdirSync(dirname(home), { recursive: true });
    category = "read-back-failed";
    path = home;
    const paths = [home, ...AVE_HOME_PROTECTED_DIRECTORIES.map((name) => join(home, name))];
    const descriptors = runtime.readDacls(paths, true);
    const sid = descriptors[0]?.currentUserSid;
    for (const target of paths) {
      if (!descriptors.some((entry) => entry.path === target)) {
        path = target;
        throw new Error(`Directory "${target}" DACL read-back missing`);
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
      if (descriptor.ownerSid !== sid && !(descriptor.elevated === true && descriptor.ownerSid === "S-1-5-32-544")) {
        return { enforcement: "none", home, failedPath: path, category: "invalid-owner-grant", reason: "Directory is owned by another account" };
      }
      const extraPrincipals = [...new Map(descriptor.rules
        .filter((rule) => rule.sid !== sid && (path !== home || rule.accessControlType !== 0 ||
          (mapFileGenericRights(rule.fileSystemRights) & ~WINDOWS_ROOT_READ_ONLY_RIGHTS) !== 0))
        .map(({ sid, account }) => [sid, { sid, ...(account ? { account } : {}) }])).values()];
      if (extraPrincipals.length > 0) {
        return { enforcement: "none", home, failedPath: path, category: "extra-principals", extraPrincipals,
          reason: "Remove the extra principal entries or move AVE_HOME" };
      }
      if (descriptor.protected !== true) {
        return { enforcement: "none", home, failedPath: path, category: "not-protected", reason: "Directory DACL is not protected against inheritance" };
      }
      const readOnlyPrincipals = path === home ? descriptor.rules.filter((rule) => rule.sid !== sid) : [];
      const ownerDescriptor = path === home ? { ...descriptor, rules: descriptor.rules.filter((rule) => rule.sid === sid) } : descriptor;
      if (!isOwnerOnlyDacl(ownerDescriptor, sid)) {
        return { enforcement: "none", home, failedPath: path, category: "invalid-owner-grant", reason: "Directory DACL is not owner-only FullControl with object and container inheritance" };
      }
      if (readOnlyPrincipals.length > 0) diagnostics.push(`Directory "${path}" has foreign read-only access: ${readOnlyPrincipals.map((rule) => rule.sid).join(", ")}`);
      if (descriptor.repaired) repairs.push(path);
      if (descriptor.skippedLinks) diagnostics.push(`Directory "${path}" repair skipped ${descriptor.skippedLinks} link entries`);
      diagnostics.push(...descriptor.cleanupWarnings ?? []);
    }
    if (!sid) throw new Error("Current account SID read-back missing");
    return { enforcement: "win32-dacl", home, sid, ...(repairs.length ? { repairs } : {}), ...(diagnostics.length ? { diagnostics } : {}) };
  } catch (err) {
    return { enforcement: "none", home, failedPath: path, category, reason: (err as Error).message,
      ...(repairs.length ? { repairs } : {}), ...(diagnostics.length ? { diagnostics } : {}) };
  }
}
