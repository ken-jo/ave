import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { admitWindowsReparse, isOwnerOnlyDacl, mapWindowsGenericRights, pinWindowsPaths, readWindowsDacls, windowsObjectKey, windowsOwnerRules, type WindowsDaclFacts } from "./windows-path-facts.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";
import { win32SystemBinary, windowsSystemRoot } from "./windows-system-path.js";
export { win32SystemBinary } from "./windows-system-path.js";
import { isWindowsHomeRootSafe, WINDOWS_HOME_BOUNDARY_SOURCE, WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS } from "./windows-home-boundary.js";
import { fileIdentityKey } from "../lib/file-identity.js";
import { openWindowsConfigurationHandles, windowsConfigurationDirectoryEntries, type WindowsConfigurationHandleEntry } from "./windows-configuration-handles.js";

export const AVE_HOME_CONFIGURATION_DIRECTORY = "config";
export const AVE_HOME_CONFIGURATION_MARKER = ".ave-config-migrated";
export const AVE_HOME_CONFIGURATION_MARKER_CONTENT = "ave-home-boundary-v1";

let refusedConfigurationHome: string | undefined;
const verifiedConfigurationIdentities = new Map<string, string>();
const configurationHomes = new Set<string>();
const committedConfigurationHomes = new Set<string>();
interface WindowsConfigurationLocation {
  readonly entries: readonly WindowsConfigurationHandleEntry[];
  readonly committed: boolean;
}
const windowsConfigurationLocations = new Map<string, WindowsConfigurationLocation>();

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

/** Only a refused home bypasses protected storage. */
export function setAveHomeConfigurationRefusedAtBoot(home: string): void {
  refusedConfigurationHome = configurationKey(home);
}

export function isAveHomeConfigurationRefused(home: string): boolean {
  return refusedConfigurationHome === configurationKey(home);
}

export function aveHomeConfigurationDirectory(home = aveHome()): string {
  const root = resolve(home);
  configurationHomes.add(root);
  if (isAveHomeConfigurationRefused(root)) return root;
  const key = configurationKey(root);
  const config = join(root, AVE_HOME_CONFIGURATION_DIRECTORY);
  try {
    if (process.platform === "win32") return windowsConfigurationDirectory(root, config, key);
    let directory;
    try { directory = lstatSync(config, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (committedConfigurationHomes.has(key)) throw new Error("Committed configuration directory is missing");
      verifiedConfigurationIdentities.delete(key);
      return root;
    }
    if (!directory.isDirectory()) throw new Error("Configuration directory is a link or is not a directory");
    const identity = fileIdentityKey(directory);
    let marker;
    try { marker = lstatSync(join(config, AVE_HOME_CONFIGURATION_MARKER), { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (marker !== undefined && !marker.isFile()) throw new Error("Configuration marker is not a regular file");
    if (verifiedConfigurationIdentities.get(key) !== identity) {
      verifyAveHomeConfiguration(root);
      if (fileIdentityKey(lstatSync(config, { bigint: true })) !== identity) throw new Error("Configuration directory changed during verification");
      verifiedConfigurationIdentities.set(key, identity);
    }
    if (marker === undefined) {
      if (committedConfigurationHomes.has(key)) throw new Error("Configuration commit marker is missing");
      return root;
    }
    if (marker.size !== BigInt(Buffer.byteLength(AVE_HOME_CONFIGURATION_MARKER_CONTENT)) || readFileSync(join(config, AVE_HOME_CONFIGURATION_MARKER), "utf8") !== AVE_HOME_CONFIGURATION_MARKER_CONTENT) {
      throw new Error("Configuration marker content is invalid");
    }
    committedConfigurationHomes.add(key);
    return config;
  } catch (error) {
    verifiedConfigurationIdentities.delete(key);
    if (error instanceof AveHomeConfigurationUntrustedError) throw error;
    throw new AveHomeConfigurationUntrustedError(config, (error as Error).message);
  }
}

function windowsConfigurationDirectory(root: string, config: string, key: string): string {
  const cached = windowsConfigurationLocations.get(key);
  if (cached !== undefined) {
    const { handles } = openWindowsConfigurationHandles(cached.entries);
    if (handles !== undefined) {
      try {
        const marker = handles.descriptors.at(-1)!;
        if ((!cached.committed || readFileSync(marker, "utf8") === AVE_HOME_CONFIGURATION_MARKER_CONTENT) && handles.matches()) return cached.committed ? config : root;
      } finally { handles.close(); }
    }
    windowsConfigurationLocations.delete(key);
    verifiedConfigurationIdentities.delete(key);
  }
  const paths = [config, join(config, AVE_HOME_CONFIGURATION_MARKER), root];
  const [directory, marker, rootFacts] = pinWindowsPaths(paths);
  if (!admitWindowsReparse(directory!, "evidence")) throw new Error("Configuration directory is a link or is not a directory");
  if (directory!.exists === false) {
    if (committedConfigurationHomes.has(key)) throw new Error("Committed configuration directory is missing");
    verifiedConfigurationIdentities.delete(key);
    if (rootFacts!.exists === true && rootFacts!.changeTime !== null && BigInt(rootFacts!.changeTime) !== 0n) {
      windowsConfigurationLocations.set(key, { committed: false, entries: windowsConfigurationDirectoryEntries(root, rootFacts!) });
    }
    return root;
  }
  if (!directory!.directory) throw new Error("Configuration directory is a link or is not a directory");
  if (!admitWindowsReparse(marker!, "evidence") || (marker!.exists && marker!.directory)) throw new Error("Configuration marker is not a regular file");
  const identity = `${windowsObjectKey(directory!)}|${marker!.exists ? `${windowsObjectKey(marker!)}:${marker!.changeTime}` : "missing"}`;
  const cacheable = marker!.exists === true && marker!.changeTime !== null && BigInt(marker!.changeTime) !== 0n;
  if (!cacheable || verifiedConfigurationIdentities.get(key) !== identity) {
    const committed = inspectWindowsConfiguration(root, false);
    const [afterDirectory, afterMarker] = pinWindowsPaths(paths);
    if (!admitWindowsReparse(afterDirectory!, "evidence") || !admitWindowsReparse(afterMarker!, "evidence")
      || afterDirectory!.exists !== true || windowsObjectKey(afterDirectory!) !== windowsObjectKey(directory!)
      || afterMarker!.exists !== marker!.exists || (marker!.exists && (windowsObjectKey(afterMarker!) !== windowsObjectKey(marker!)
        || afterMarker!.changeTime !== marker!.changeTime)) || committed !== marker!.exists) {
      throw new Error("Configuration directory changed during verification");
    }
    if (cacheable) verifiedConfigurationIdentities.set(key, identity);
    else verifiedConfigurationIdentities.delete(key);
  }
  if (marker!.exists === false) {
    if (committedConfigurationHomes.has(key)) throw new Error("Configuration commit marker is missing");
    if (directory!.changeTime !== null && BigInt(directory!.changeTime) !== 0n) {
      windowsConfigurationLocations.set(key, { committed: false, entries: [
        ...windowsConfigurationDirectoryEntries(root, rootFacts!),
        ...windowsConfigurationDirectoryEntries(config, directory!),
      ] });
    }
    return root;
  }
  committedConfigurationHomes.add(key);
  if (cacheable) windowsConfigurationLocations.set(key, { committed: true, entries: [
    ...windowsConfigurationDirectoryEntries(config, directory!, false),
    { path: paths[1]!, facts: marker!, changeTimeRequired: true },
  ] });
  return config;
}

export function configurationHomeForFile(path: string): string | undefined {
  const candidate = configurationKey(path);
  for (const home of new Set([aveHome(), ...configurationHomes])) {
    for (const name of ["settings.json", "policy.json", "ave-secrets.json"]) {
      if (candidate === configurationKey(join(home, name)) || candidate === configurationKey(join(home, "config", name))) return home;
    }
  }
  return undefined;
}

export function verifyAveHomeConfiguration(home: string, recoverInvalidMarker: boolean | "boundary" = false): boolean {
  const config = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
  try {
    if (process.platform !== "win32") try {
      const directory = lstatSync(config);
      if (!directory.isDirectory()) throw new Error("Configuration directory is a link or is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (process.platform === "win32") {
      if (recoverInvalidMarker !== true) return inspectWindowsConfiguration(home, recoverInvalidMarker === "boundary");
      const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
        $request=ConvertFrom-Json $env:AVE_DACL_REQUEST;
        Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
        $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
        $elevated=([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
        try {
          $committed=[HomeDirectoryDacl]::RecoverConfigurationCommit($request.path,$identity.User,$elevated);
          @{ committed=$committed } | ConvertTo-Json -Compress
        } catch {
          @{ reason=$_.Exception.InnerException.Message } | ConvertTo-Json -Compress
        }`;
      const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
      ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
        AVE_DACL_REQUEST: JSON.stringify({ path: home }) }) });
      const result = JSON.parse(output) as { committed?: unknown; reason?: unknown };
      if (typeof result.reason === "string") throw new Error(result.reason);
      if (typeof result.committed !== "boolean") throw new Error("Invalid boundary verification result");
      return result.committed;
    }
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const root = openSync(home, flags);
    try {
      const protection = fstatSync(root);
      if (!protection.isDirectory() || protection.uid !== process.getuid!() || (protection.mode & 0o022) !== 0) {
        throw new Error("Configuration home protection is unverified");
      }
      const configPath = join(process.platform === "linux" ? `/proc/self/fd/${root}` : home, AVE_HOME_CONFIGURATION_DIRECTORY);
      const directory = openSync(configPath, flags);
      try {
        const markerPath = join(process.platform === "linux" ? `/proc/self/fd/${directory}` : config, AVE_HOME_CONFIGURATION_MARKER);
        const protection = fstatSync(directory);
        if (!protection.isDirectory() || protection.uid !== process.getuid!() || (protection.mode & 0o077) !== 0) {
          throw new Error("Configuration directory protection is unverified");
        }
        if (recoverInvalidMarker === "boundary") return false;
        let marker: number;
        try { marker = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        try {
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
    } finally { closeSync(root); }
  } catch (error) {
    throw new AveHomeConfigurationUntrustedError(config, error instanceof Error ? error.message : "Verification failed");
  }
}


function inspectWindowsConfiguration(home: string, boundaryOnly: boolean): boolean {
  const config = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
  const [root, directory] = readWindowsDacls([resolve(home), resolve(config)]);
  if (!root || !admitWindowsReparse(root, "evidence") || !isWindowsHomeRootSafe(root)) {
    throw new Error("Configuration home protection is unverified");
  }
  if (directory?.exists === false) return false;
  if (!directory || !admitWindowsReparse(directory, "evidence") || !directory.directory
    || !directory.dacl?.protected || !isOwnerOnlyDacl(directoryDescriptor(config, directory), directory.currentUserSid)) {
    throw new Error("Configuration boundary protection is unverified");
  }
  if (boundaryOnly) return false;
  const marker = readWindowsDacls([resolve(config, AVE_HOME_CONFIGURATION_MARKER)], { content: true })[0]!;
  if (!admitWindowsReparse(marker!, "evidence")) throw new Error("Configuration marker is not a regular file");
  if (marker!.exists === false) return false;
  if (marker!.directory || typeof marker!.contentHex !== "string"
    || Buffer.from(marker!.contentHex, "hex").toString("utf8") !== AVE_HOME_CONFIGURATION_MARKER_CONTENT) {
    throw new Error("Configuration marker content is invalid");
  }
  return true;
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
const WINDOWS_ROOT_READ_ONLY_RIGHTS = WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS;

/** ACL input stays in environment JSON; the bootstrap reads the script from stdin. */
/** Standalone inspection uses the shared native facts; protection retains same-handle checks. */
export function readWindowsDirectoryDacls(paths: readonly string[], protect = false, claimableRuntimeRoot?: string): WindowsDirectoryDacl[] {
  try { windowsSystemRoot(); } catch {
    return paths.map(path => ({ path, category: "system-root-missing", error: "Windows system root is missing" }));
  }
  if (protect && paths[0]) {
    const root = readWindowsDacls([resolve(paths[0])])[0]!;
    if (!admitWindowsReparse(root, "evidence") || (root.exists && root.dacl?.owner !== root.currentUserSid
      && !(root.elevated && root.dacl?.owner === "S-1-5-32-544"))) {
      const category = !admitWindowsReparse(root, "evidence") ? "reparse-point" : "invalid-owner-grant";
      return paths.map(path => ({ path, category, error: "Home protection was refused before writing" }));
    }
  }
  const writes: WindowsDirectoryDacl[] = protect ? protectWindowsDirectories(paths, claimableRuntimeRoot) : paths.map(path => ({ path }));
  return paths.map((path, index) => {
    const write = writes[index]!;
    if ("error" in write) return write;
    try {
      const row = readWindowsDacls([resolve(path)])[0]!;
      if (!row.exists || !row.directory) return { path, category: "directory-failed", error: "Path is not a directory" };
      return { ...write, ...directoryDescriptor(path, row) };
    } catch (error) {
      return { path, category: "read-back-failed", error: (error as Error).message };
    }
  });
}

function protectWindowsDirectories(paths: readonly string[], claimableRuntimeRoot?: string): WindowsDirectoryDacl[] {
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
    $refused = $false;
    $homeHandle = $null;
    try {
      $results = @(foreach ($path in $request.paths) {
        if ($refused) { @{ path = $path; error = 'An enclosing directory was refused' }; continue }
        $handle = $null;
        try {
          $repaired = -1;
          if ($null -eq $homeHandle) {
            $homeHandle = [HomeDirectoryDacl]::OpenHome($path, $identity.User, $true);
            $handle = $homeHandle;
            $refused = -not [HomeDirectoryDacl]::RootSafe([HomeDirectoryDacl]::Read($handle), $identity.User, $elevated, $request.readOnlyRights);
          } else {
            if ([System.IO.Path]::GetDirectoryName($path) -ne [System.IO.Path]::GetFullPath($request.paths[0])) { throw 'Directory is outside the pinned home' }
            $leaf = [System.IO.Path]::GetFileName($path);
            if (-not $elevated -and $path -eq $request.claimableRuntimeRoot) {
              try { [HomeDirectoryDacl]::ClaimRuntimeRoot($homeHandle, $leaf, $identity.User) }
              catch { throw ('Runtime ownership claim failed: ' + $_.Exception.GetBaseException().Message) }
            }
            $repaired = [HomeDirectoryDacl]::Repair($homeHandle, $leaf, $identity.User, $elevated, $request.paths[0]);
            $handle = [HomeDirectoryDacl]::OpenRelative($homeHandle, $leaf, $identity.User, 1, $true, $true, $true);
          }
          if ($null -eq $handle) { throw 'Directory does not exist' }
          $result = @{ path = $path };
          if ($repaired -ge 0) { $result.repaired = $true; $result.skippedLinks = $repaired }
          if ($null -ne $homeHandle -and $handle -ne $homeHandle) { $result.cleanupWarnings = @([HomeDirectoryDacl]::CleanupWarnings.ToArray()) }
          $result
        } catch {
          $refused = $true;
          $errorText = $_.Exception.GetBaseException().Message;
          $category = 'directory-failed';
          if ($errorText -match 'link or junction') { $category = 'reparse-point' }
          elseif ($errorText -match 'Runtime ownership claim failed') { $category = 'owner-claim-failed' }
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
  // A one-shot process cannot separate cold startup from its directory operation.
  ], { input: script, encoding: "utf-8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs + TOOL_TIMEOUT_POLICY.windowsAclRequestMs, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ paths, claimableRuntimeRoot, readOnlyRights: WINDOWS_ROOT_READ_ONLY_RIGHTS }) }) });
  const results: unknown = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== paths.length) {
    throw new Error("Directory DACL read-back returned an invalid result set");
  }
  return results;
}


function directoryDescriptor(path: string, row: WindowsDaclFacts): WindowsDirectoryDacl {
  if (!admitWindowsReparse(row, "evidence")) return { path, category: "reparse-point", error: "Directory is a link or junction" };
  if (!row.dacl) return { path, error: "Directory DACL is missing" };
  return { path, currentUserSid: row.currentUserSid, elevated: row.elevated, ownerSid: row.dacl.owner,
    protected: row.dacl.protected, rules: windowsOwnerRules(row.dacl) };
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
  refusedConfigurationHome = undefined;
  verifiedConfigurationIdentities.clear();
  configurationHomes.clear();
  committedConfigurationHomes.clear();
  windowsConfigurationLocations.clear();
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
          (mapWindowsGenericRights(rule.fileSystemRights) & ~WINDOWS_ROOT_READ_ONLY_RIGHTS) !== 0))
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
