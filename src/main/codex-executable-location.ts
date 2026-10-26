import { execFile } from "node:child_process";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";
import { WINDOWS_OWNER_CLAIM_SOURCE } from "../shared/windows-owner-claim.js";
import { constants, promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve as resolvePath, win32 } from "node:path";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { isRecord } from "../shared/is-record.js";
import { createLogger } from "../lib/logger.js";
import { spawnManaged } from "./managed-child-processes.js";
import {
  WindowsAclHost,
  WindowsAclHostError,
  windowsAclTransportSeam,
  type WindowsAclHostLaunch,
  type WindowsAclLimits,
  type WindowsAclRequest,
} from "./windows-acl-host.js";

const log = createLogger("codex-executable-location");
const MAX_SYMLINKS = 40;
const MAX_ACL_OUTPUT_BYTES = 256 * 1024;
// One request receives at most this many paths, which keeps each request line bounded and the output budget per path stable.
const ACL_BATCH_PATHS = 128;
const ACL_BATCH_CHARS = 24 * 1024;
const ACL_OUTPUT_PATHS = 16;
const trustedSystemSids = new Set([
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const MUTATION_ACCESS_MASK = 0x000d0156 | 0x50000000;
const FILE_ADD_SUBDIRECTORY = 0x4;
const SID_PATTERN = /^S-1-(?:\d+-)*\d+$/;
const CAP_SID_PATTERN = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const ACCOUNT_DOMAIN_SID_PATTERN = /^S-1-5-21-\d+-\d+-\d+$/;
const PACKAGE_SID_PATTERN = /^S-1-15-2(-\d+){7}$/;
// The owner accepts this installed package's sandbox; the publisher pins its signer.
const CLAUDE_DESKTOP_PACKAGE = Object.freeze({ familyName: "Claude_pzs8sxrjxfjjc", publisherId: "pzs8sxrjxfjjc" });
const PACKAGE_RESOLUTION_FAILURES = [
  "mapping-not-found", "ambiguous-mapping", "package-not-installed", "publisher-mismatch", "malformed-sid", "sid-mismatch", "resolution-failed",
] as const;
type PackageResolutionFailure = typeof PACKAGE_RESOLUTION_FAILURES[number];
type DesktopPackagePrincipals = { status: "resolved"; packageSid: string; capabilitySid: string }
  | { status: "unavailable"; reason: PackageResolutionFailure };
// A package SID derives from its family name and stays stable for this process. Uninstalling leaves its ACE inert because no token carries that SID
// anymore. Cache failures too: a later installation requires a restart to become trusted.
let cachedDesktopPackage: DesktopPackagePrincipals | undefined;
let packageResolutionWarned = false;

export function _resetDesktopPackageCacheForTest(): void {
  cachedDesktopPackage = undefined;
  packageResolutionWarned = false;
}

// Spawned through the managed-child tracker, so app quit kills a live host.
const windowsAclHost = new WindowsAclHost((command, args, options) =>
  spawnManaged(command, args, options, { label: "windows-acl-host" }));
let windowsAclQueue: Promise<void> = Promise.resolve();
let windowsAclRequestId = 0;

// Kill the ACL host and drop queued work, the way a restart would.
export function _resetWindowsAclHostForTest(): void {
  windowsAclHost.discard();
  windowsAclTransportSeam.override?.discard();
  windowsAclQueue = Promise.resolve();
}

const MAX_CAP_SID_BYTES = 1024 * 1024;
const PRIVATE_ACCESS_MASK = 0x001f01ff | 0xf0000000;
const INHERIT_ONLY_ACE = 0x08;
const aclMutationPermissions = new Set([
  "write", "append", "add_file", "add_subdirectory", "delete", "delete_child",
  "writeattr", "writeextattr", "writesecurity", "chown",
]);
const aclReadPermissions = new Set([
  "read", "list", "search", "execute", "readattr", "readextattr", "readsecurity",
]);
const aclInheritanceFlags = new Set([
  "file_inherit", "directory_inherit", "limit_inherit", "only_inherit", "inherited",
]);

export class CodexExecutableLocationError extends Error {
  routeKind?: CodexLocationRouteKind;
  constructor(reason: string) {
    super(reason);
    this.name = "CodexExecutableLocationError";
  }
}

interface InspectedPath {
  path: string;
  stat: Stats;
}

// A location admitted with the rule its single-path function applies.
export interface CodexLocationRequest {
  readonly path: string;
  readonly kind: "executable" | "directory" | "private-directory";
  // Windows only; unknown callers retain strict script dependency admission.
  readonly routeKind?: CodexLocationRouteKind;
}

export type CodexLocationRouteKind = "native" | "script" | "guarded-script";
type ComponentRole = "ancestor" | "leaf" | "private";
interface ComponentRule { routeKind: CodexLocationRouteKind; role: ComponentRole }

// The only exception to foreign subdirectory-creation admission.
function mayIgnoreForeignSubdirectoryCreation(kind: CodexLocationRouteKind, role: ComponentRole): boolean {
  return role === "ancestor" && (kind === "native" || kind === "guarded-script");
}

export interface CodexLocationTrustInputs {
  readonly capSidPath?: string;
  readonly readCapSidFile?: (path: string) => Promise<string | null>;
}

interface WindowsAccessEntry {
  sid: string;
  mask: number;
  flags: number;
  type: number;
}

interface WindowsPathSecurity {
  path: string;
  owner: string;
  daclPresent: boolean;
  entries: WindowsAccessEntry[];
}

interface WindowsSecurityResult {
  currentSid: string;
  machineDomainSid?: string;
  capSidAccounts?: { sid: string; resolvesToAccount: boolean }[];
  paths: WindowsPathSecurity[];
  sandboxGroup?: { name: string; description: string; sid: string; members: string[] };
  desktopPackage: DesktopPackagePrincipals;
}

// Read the path object’s ACL without following reparse points; decode fresh request data and fail closed on any error.
// Disable module autoloading and import only pinned engine modules to avoid untrusted search paths and slow discovery.
const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$WarningPreference = 'SilentlyContinue'",
  "$VerbosePreference = 'SilentlyContinue'",
  "$InformationPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
  "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1')",
  "Add-Type -TypeDefinition @'",
  WINDOWS_OWNER_CLAIM_SOURCE,
  "public static class ExecutablePathSecurity {",
  "  [DllImport(\"advapi32.dll\")]",
  "  private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);",
  "  [DllImport(\"userenv.dll\", CharSet = CharSet.Unicode, ExactSpelling = true)]",
  "  private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);",
  "  [DllImport(\"advapi32.dll\", ExactSpelling = true)]",
  "  private static extern IntPtr FreeSid(IntPtr sid);",
  "  public static string DerivePackageSid(string name) {",
  "    IntPtr sid;",
  "    int result = DeriveAppContainerSidFromAppContainerName(name, out sid);",
  "    if (result != 0) Marshal.ThrowExceptionForHR(result);",
  "    try { return new System.Security.Principal.SecurityIdentifier(sid).Value; }",
  "    finally { FreeSid(sid); }",
  "  }",
  "  public static byte[] Read(string path) {",
  "    using (SafeFileHandle handle = WindowsOwnerClaim.CreateFile(path, 0x00020000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {",
  "      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());",
  "      IntPtr owner, group, dacl, sacl, descriptor;",
  "      uint result = WindowsOwnerClaim.GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);",
  "      if (result != 0) throw new Win32Exception((int)result);",
  "      try {",
  "        byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];",
  "        Marshal.Copy(descriptor, bytes, 0, bytes.Length);",
  "        return bytes;",
  "      } finally { WindowsOwnerClaim.LocalFree(descriptor); }",
  "    }",
  "  }",
  "}",
  "'@",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "$request = ConvertFrom-Json -InputObject $line",
  // Direct assignment preserves the decoded array without nesting it inside a single pipeline object.
  "$targets = $request.paths",
  // Read all owners before mutation; keep token-owned paths, claim administrator-owned paths, and reject any foreign owner without changing the batch.
  "$claims = $null",
  "if ($request.setOwner -is [bool] -and $request.setOwner) {",
  "  $claimant = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "  $claimTargets = @($targets)",
  "  $previous = @(foreach ($target in $claimTargets) { [WindowsOwnerClaim]::Owner([string]$target) })",
  "  $refused = @($previous | Where-Object { $_ -ne $claimant.Value -and $_ -ne 'S-1-5-32-544' }).Count -ne 0",
  "  $claims = @(for ($index = 0; $index -lt $claimTargets.Count; $index++) {",
  "    $target = [string]$claimTargets[$index]",
  "    $owner = $previous[$index]",
  "    if ($owner -eq $claimant.Value) { $outcome = 'kept' }",
  "    elseif ($owner -ne 'S-1-5-32-544') { $outcome = 'refused' }",
  "    elseif ($refused) { $outcome = 'unclaimed' }",
  "    else { [WindowsOwnerClaim]::ClaimFromAdministrators($target, $claimant, $false); $outcome = 'set' }",
  "    [PSCustomObject]@{ path = $target; previousOwner = $owner; outcome = $outcome }",
  "  })",
  "}",
  "$paths = @($targets | ForEach-Object {",
  "  $target = [string]$_",
  "  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new([ExecutablePathSecurity]::Read($target), 0)",
  "  $entries = @(if ($null -ne $descriptor.DiscretionaryAcl) { $descriptor.DiscretionaryAcl | ForEach-Object {",
  "    if ($_ -isnot [System.Security.AccessControl.CommonAce]) { throw 'Unsupported access entry' }",
  "    [PSCustomObject]@{ sid = $_.SecurityIdentifier.Value; mask = [int64]$_.AccessMask; flags = [int]$_.AceFlags; type = [int]$_.AceType }",
  "  } })",
  "  [PSCustomObject]@{ path = $target; owner = $descriptor.Owner.Value; daclPresent = ($null -ne $descriptor.DiscretionaryAcl); entries = $entries }",
  "})",
  "$machineDomainSid = $null",
  "try {",
  // LocalAccounts and Appx are imported where they are used, inside the lookups whose failure already falls back or reports an unavailable package.
  "  Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.LocalAccounts\\Microsoft.PowerShell.LocalAccounts.psd1') -ErrorAction Stop",
  "  $localUser = Get-LocalUser -ErrorAction Stop | Select-Object -First 1",
  "  $machineDomainSid = $localUser.SID.AccountDomainSid.Value",
  "} catch {",
  "  try {",
  "    $localUser = ([ADSI]'WinNT://.').Children | Where-Object { $_.SchemaClassName -eq 'User' } | Select-Object -First 1",
  "    $machineDomainSid = [System.Security.Principal.SecurityIdentifier]::new([byte[]]$localUser.psbase.InvokeGet('objectSID'), 0).AccountDomainSid.Value",
  "  } catch { $machineDomainSid = $null }",
  "}",
  "$sandboxGroup = $null",
  "try {",
  "  $group = [ADSI]'WinNT://./CodexSandboxUsers,group'",
  "  $name = [string]$group.psbase.InvokeGet('Name')",
  "  $description = [string]$group.psbase.InvokeGet('Description')",
  "  if ($name -ceq 'CodexSandboxUsers' -and $description -ceq 'Codex sandbox internal group (managed)') {",
  "    $sid = [System.Security.Principal.SecurityIdentifier]::new([byte[]]$group.psbase.InvokeGet('objectSID'), 0).Value",
  "    $members = @($group.psbase.Invoke('Members') | ForEach-Object {",
  "      $bytes = $_.GetType().InvokeMember('objectSID', 'GetProperty', $null, $_, $null)",
  "      [System.Security.Principal.SecurityIdentifier]::new([byte[]]$bytes, 0).Value",
  "    })",
  "    $sandboxGroup = @{ name = $name; description = $description; sid = $sid; members = $members }",
  "  }",
  "} catch {",
  "  try {",
  "    Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.LocalAccounts\\Microsoft.PowerShell.LocalAccounts.psd1') -ErrorAction Stop",
  "    $group = Get-LocalGroup -Name 'CodexSandboxUsers' -ErrorAction Stop",
  "    if ($group.Name -ceq 'CodexSandboxUsers' -and $group.Description -ceq 'Codex sandbox internal group (managed)') {",
  "      $members = @(Get-LocalGroupMember -Group $group -ErrorAction Stop | ForEach-Object { $_.SID.Value })",
  "      $sandboxGroup = @{ name = $group.Name; description = $group.Description; sid = $group.SID.Value; members = $members }",
  "    }",
  "  } catch { $sandboxGroup = $null }",
  "}",
  "$capCandidates = $request.capSids",
  "$capSidAccounts = @($capCandidates | ForEach-Object {",
  "  $capSid = [System.Security.Principal.SecurityIdentifier]::new([string]$_)",
  "  $resolvesToAccount = $true",
  "  try { $null = $capSid.Translate([System.Security.Principal.NTAccount]) }",
  "  catch [System.Security.Principal.IdentityNotMappedException] { $resolvesToAccount = $false }",
  "  [PSCustomObject]@{ sid = $capSid.Value; resolvesToAccount = $resolvesToAccount }",
  "})",
  `$desktopPackageIdentity = @{ familyName = '${CLAUDE_DESKTOP_PACKAGE.familyName}'; publisherId = '${CLAUDE_DESKTOP_PACKAGE.publisherId}' }`,
  "if ($request.skipPackage -is [bool] -and $request.skipPackage) {",
  "  $desktopPackage = @{ status = 'skipped' }",
  "} else {",
  "$desktopPackage = @{ status = 'unavailable'; reason = 'resolution-failed' }",
  "try {",
  "  $mappings = @(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings' -ErrorAction Stop | Where-Object {",
  "    (Get-ItemProperty -LiteralPath $_.PSPath -Name Moniker -ErrorAction Stop).Moniker -ieq $desktopPackageIdentity.familyName",
  "  })",
  "  if ($mappings.Count -eq 0) { $desktopPackage.reason = 'mapping-not-found' }",
  "  elseif ($mappings.Count -ne 1) { $desktopPackage.reason = 'ambiguous-mapping' }",
  "  else {",
  "    Import-Module -Name ($PSHOME + '\\Modules\\Appx\\Appx.psd1') -ErrorAction Stop",
  "    $packages = @(Get-AppxPackage -Name 'Claude' -ErrorAction Stop | Where-Object { $_.PackageFamilyName -ieq $desktopPackageIdentity.familyName })",
  "    if ($packages.Count -eq 0) { $desktopPackage.reason = 'package-not-installed' }",
  "    elseif (@($packages | Where-Object { $_.PublisherId -ine $desktopPackageIdentity.publisherId }).Count -ne 0) { $desktopPackage.reason = 'publisher-mismatch' }",
  "    else {",
  "      $packageSid = [string]$mappings[0].PSChildName",
  "      if ($packageSid -cnotmatch '^S-1-15-2(-\\d+){7}$') { $desktopPackage.reason = 'malformed-sid' }",
  "      else {",
  "        $derivedSid = [ExecutablePathSecurity]::DerivePackageSid($desktopPackageIdentity.familyName)",
  "        if ($packageSid -cne $derivedSid) { $desktopPackage.reason = 'sid-mismatch' }",
  "        else { $desktopPackage = @{ status = 'resolved'; packageSid = $derivedSid; capabilitySid = 'S-1-15-3-' + $derivedSid.Substring(9) } }",
  "      }",
  "    }",
  "  }",
  "} catch { $desktopPackage = @{ status = 'unavailable'; reason = 'resolution-failed' } }",
  "}",
  "$result = [PSCustomObject]@{ currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; machineDomainSid = $machineDomainSid; capSidAccounts = $capSidAccounts; paths = $paths; sandboxGroup = $sandboxGroup; desktopPackage = $desktopPackage }",
  "if ($null -ne $claims) { $result | Add-Member -NotePropertyName claims -NotePropertyValue $claims }",
  // One physical line per reply, written outside the pipeline.
  "[Console]::Out.WriteLine(([PSCustomObject]@{ id = $request.id; result = $result } | ConvertTo-Json -Depth 7 -Compress))",
  "[Console]::Out.WriteLine(('END ' + [string]$request.id))",
  "[Console]::Out.Flush()",
  "}",
].join("\n");
const WINDOWS_ACL_ENCODED_SCRIPT = Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64");

function assertAbsolutePath(candidate: string): void {
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new CodexExecutableLocationError("Executable path is invalid");
  }
  const absolute = process.platform === "win32"
    ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(candidate)
      && !/^[\\/]{2}[?.][\\/]/.test(candidate)
    : posix.isAbsolute(candidate);
  if (!absolute) throw new CodexExecutableLocationError("Executable path must be absolute");
}

function assertPosixOwnership(path: InspectedPath): void {
  const uid = process.getuid?.();
  if (uid === undefined || (path.stat.uid !== 0 && path.stat.uid !== uid)) {
    throw new CodexExecutableLocationError("Executable path has an untrusted owner");
  }
  const stickyRootDirectory = path.stat.isDirectory() && path.stat.uid === 0 && (path.stat.mode & 0o1000) !== 0;
  if (!path.stat.isSymbolicLink() && (path.stat.mode & 0o022) !== 0 && !stickyRootDirectory) {
    throw new CodexExecutableLocationError("Executable path is writable by another account");
  }
}

async function inspectPathRoute(
  candidate: string,
  inspected: Map<string, InspectedPath>,
  privateDirectory = false,
): Promise<InspectedPath> {
  const paths = process.platform === "win32" ? win32 : posix;
  const separator = process.platform === "win32" ? /[\\/]/ : /\//;
  let current = paths.parse(candidate).root;
  let pending = candidate.slice(current.length).split(separator);
  let symlinks = 0;

  const inspect = async (path: string): Promise<InspectedPath> => {
    const entry = { path, stat: await fs.lstat(path) };
    if (process.platform !== "win32") assertPosixOwnership(entry);
    inspected.set(process.platform === "win32" ? win32.normalize(path) : path, entry);
    return entry;
  };

  let entry = await inspect(current);
  if (!entry.stat.isDirectory()) throw new CodexExecutableLocationError("Executable ancestor is not a directory");

  while (pending.length > 0) {
    const component = pending.shift()!;
    if (!component || component === ".") continue;
    if (component === "..") {
      current = paths.dirname(current);
      entry = await inspect(current);
      continue;
    }
    entry = await inspect(paths.join(current, component));
    if (entry.stat.isSymbolicLink()) {
      if (privateDirectory && pending.every((part) => part === "" || part === ".")) {
        throw new CodexExecutableLocationError("Runtime directory must not be a symbolic link");
      }
      if (++symlinks > MAX_SYMLINKS) throw new CodexExecutableLocationError("Executable path has too many symbolic links");
      const target = await fs.readlink(entry.path);
      if (/[\u0000-\u001f\u007f]/.test(target)) throw new CodexExecutableLocationError("Executable path is invalid");
      if (paths.isAbsolute(target)) {
        assertAbsolutePath(target);
        current = paths.parse(target).root;
        entry = await inspect(current);
        if (!entry.stat.isDirectory()) throw new CodexExecutableLocationError("Executable ancestor is not a directory");
        pending = [...target.slice(current.length).split(separator), ...pending];
      } else {
        pending = [...target.split(separator), ...pending];
      }
      continue;
    }
    current = entry.path;
    if (pending.some((part) => part !== "" && part !== ".") && !entry.stat.isDirectory()) {
      throw new CodexExecutableLocationError("Executable ancestor is not a directory");
    }
  }
  return entry;
}

function aclOutputBytes(inspected: readonly { readonly path: string }[]): number {
  return MAX_ACL_OUTPUT_BYTES * Math.max(1, Math.ceil(inspected.length / ACL_OUTPUT_PATHS));
}

function aclBatches<T extends { readonly path: string }>(inspected: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let chars = 0;
  for (const entry of inspected) {
    const size = JSON.stringify(entry.path).length + 1;
    if (batch.length > 0 && (batch.length >= ACL_BATCH_PATHS || chars + size > ACL_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(entry);
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function assertExtendedAccessRules(inspected: readonly InspectedPath[], privateDirectories: ReadonlySet<string>): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("/bin/ls", ["-ldne", "-D", "%s", "--", ...inspected.map((entry) => entry.path)], {
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
      maxBuffer: aclOutputBytes(inspected),
      env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" },
    }, (error, output, stderr) => {
      if (error) reject(error);
      else if (stderr.trim()) reject(new CodexExecutableLocationError("Executable access rules could not be read"));
      else resolve(output);
    });
  });
  const seen = new Set<string>();
  let current: InspectedPath | undefined;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const header = /^[bcdlps-][rwxStTs-]{9}[+@.]?\s+\d+\s+(\d+)\s+\d+\s+\d+\s+-?\d+\s+(.*)$/.exec(line);
    if (header) {
      const name = header[2]!;
      const matches = inspected.filter((entry) => entry.stat.isSymbolicLink()
        ? name.startsWith(`${entry.path} -> `)
        : name === entry.path);
      if (matches.length !== 1 || seen.has(matches[0]!.path)) {
        throw new CodexExecutableLocationError("Executable access rules are incomplete");
      }
      current = matches[0]!;
      const owner = Number(header[1]);
      if (owner !== 0 && owner !== process.getuid?.()) {
        throw new CodexExecutableLocationError("Executable path has an untrusted owner");
      }
      seen.add(current.path);
      continue;
    }
    const rule = /^\s+\d+:\s+(\S+)\s+(?:inherited\s+)?(allow|deny)\s+([a-z_,]+)\s*$/.exec(line);
    if (!current || !rule) throw new CodexExecutableLocationError("Executable access rules are unsupported");
    if (rule[2] === "deny") continue;
    const permissions = rule[3]!.split(",");
    if (permissions.some((permission) => !aclMutationPermissions.has(permission)
        && !aclReadPermissions.has(permission) && !aclInheritanceFlags.has(permission))) {
      throw new CodexExecutableLocationError("Executable access rules are unsupported");
    }
    const owner = /^user:(\d+)$/.exec(rule[1]!);
    if (owner && (Number(owner[1]) === 0 || Number(owner[1]) === process.getuid?.())) continue;
    const privateLeaf = privateDirectories.has(current.path);
    if (!privateLeaf && permissions.includes("only_inherit")) continue;
    if (permissions.some((permission) => aclMutationPermissions.has(permission)
        || (privateLeaf && aclReadPermissions.has(permission)))) {
      throw new CodexExecutableLocationError(privateLeaf
        ? "Runtime directory is accessible by another account"
        : "Executable path is writable by another account");
    }
  }
  if (seen.size !== inspected.length) throw new CodexExecutableLocationError("Executable access rules are incomplete");
}

const WINDOWS_ACL_RESULT_KEYS = new Set(["currentSid", "machineDomainSid", "capSidAccounts", "paths", "sandboxGroup", "desktopPackage", "claims"]);
const WINDOWS_ACL_PATH_KEYS = new Set(["path", "owner", "daclPresent", "entries"]);
const WINDOWS_ACL_GROUP_KEYS = new Set(["name", "description", "sid", "members"]);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isSandboxGroupShape(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, WINDOWS_ACL_GROUP_KEYS)) return false;
  const group = value;
  return ["name", "description", "sid"].every((key) => group[key] === undefined || typeof group[key] === "string")
    && (group.members === undefined || (Array.isArray(group.members) && group.members.every((member) => typeof member === "string")));
}

// Validate exactly { id, result } and the matching request id before parsing host-defined result fields and trust rules.
function validateWindowsAclReply(line: string, id: number): unknown {
  let reply: unknown;
  try {
    reply = JSON.parse(line.replace(/^\uFEFF/, ""));
  } catch {
    throw new CodexExecutableLocationError("Executable access rules could not be read");
  }
  if (!isRecord(reply) || Object.keys(reply).length !== 2 || reply.id !== id || !isRecord(reply.result)) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  const result = reply.result;
  if (!hasOnlyKeys(result, WINDOWS_ACL_RESULT_KEYS) || typeof result.currentSid !== "string" || !Array.isArray(result.paths)
      || !isRecord(result.desktopPackage)
      || (result.machineDomainSid !== undefined && result.machineDomainSid !== null && typeof result.machineDomainSid !== "string")
      || (result.capSidAccounts !== undefined && !(Array.isArray(result.capSidAccounts) && result.capSidAccounts.every((account) =>
        isRecord(account) && Object.keys(account).length === 2
          && typeof account.sid === "string" && typeof account.resolvesToAccount === "boolean")))
      || (result.sandboxGroup !== undefined && result.sandboxGroup !== null && !isSandboxGroupShape(result.sandboxGroup))) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  for (const path of result.paths) {
    if (!isRecord(path) || !hasOnlyKeys(path, WINDOWS_ACL_PATH_KEYS) || typeof path.path !== "string"
        || typeof path.owner !== "string" || typeof path.daclPresent !== "boolean" || !Array.isArray(path.entries)) {
      throw new CodexExecutableLocationError("Executable access rules are invalid");
    }
    for (const entry of path.entries) {
      // Entry failures keep the parser's message for the same refusal.
      if (!isRecord(entry) || Object.keys(entry).length !== 4 || typeof entry.sid !== "string" || typeof entry.mask !== "number"
          || typeof entry.flags !== "number" || typeof entry.type !== "number") {
        throw new CodexExecutableLocationError("Executable access rules are unsupported");
      }
    }
  }
  return result;
}

// Serialize requests so replies cannot cross; discard the host on failure and start fresh for the next request without retrying the failed one.
function exchangeWindowsAcl(request: WindowsAclRequest, launch: WindowsAclHostLaunch, limits: WindowsAclLimits): Promise<unknown> {
  const exchange = windowsAclQueue.then(async () => {
    const transport = windowsAclTransportSeam.override ?? windowsAclHost;
    try {
      const line = await transport.request(request, launch, limits);
      if (Buffer.byteLength(line) > limits.maxBytes) throw new WindowsAclHostError("Windows ACL host reply exceeds its limit");
      return validateWindowsAclReply(line, request.id);
    } catch (error) {
      transport.discard();
      throw error;
    }
  });
  windowsAclQueue = exchange.then(() => undefined, () => undefined);
  return exchange;
}

function parseWindowsSecurity(value: unknown, skippedPackage?: DesktopPackagePrincipals): WindowsSecurityResult {
  if (!isRecord(value) || typeof value.currentSid !== "string" || !SID_PATTERN.test(value.currentSid)
      || !Array.isArray(value.paths)) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  const skipped = isRecord(value.desktopPackage) && value.desktopPackage.status === "skipped";
  if (skipped && (!skippedPackage || Object.keys(value.desktopPackage as Record<string, unknown>).length !== 1)) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  const desktopPackage = skipped ? skippedPackage : value.desktopPackage;
  if (!isRecord(desktopPackage) || (desktopPackage.status === "resolved"
    ? Object.keys(desktopPackage).length !== 3 || typeof desktopPackage.packageSid !== "string"
      || !PACKAGE_SID_PATTERN.test(desktopPackage.packageSid)
      || desktopPackage.capabilitySid !== desktopPackage.packageSid.replace("S-1-15-2-", "S-1-15-3-")
    : desktopPackage.status !== "unavailable" || Object.keys(desktopPackage).length !== 2
      || !PACKAGE_RESOLUTION_FAILURES.includes(desktopPackage.reason as PackageResolutionFailure))) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  for (const path of value.paths) {
    if (!isRecord(path) || typeof path.path !== "string" || typeof path.owner !== "string" || !SID_PATTERN.test(path.owner)
        || typeof path.daclPresent !== "boolean" || !Array.isArray(path.entries)) {
      throw new CodexExecutableLocationError("Executable access rules are invalid");
    }
    for (const entry of path.entries) {
      if (!isRecord(entry) || typeof entry.sid !== "string" || !SID_PATTERN.test(entry.sid) || !Number.isInteger(entry.mask)
          || !Number.isInteger(entry.flags) || !Number.isInteger(entry.type)
          || (entry.type !== 0 && entry.type !== 1)) {
        throw new CodexExecutableLocationError("Executable access rules are unsupported");
      }
    }
  }
  return { ...value, desktopPackage } as unknown as WindowsSecurityResult;
}

function windowsAclLaunch(): WindowsAclHostLaunch {
  // The current account's process environment is trusted; arbitrary actions by that account are outside the filesystem admission boundary.
  const systemRoot = windowsSystemRoot();
  const system32 = win32SystemBinary("");
  const command = win32SystemBinary("WindowsPowerShell/v1.0/powershell");
  // The host process stays as fixed as the per-probe process was. Inputs that travelled in its environment travel in each request line instead.
  return {
    command,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_ACL_ENCODED_SCRIPT],
    options: { windowsHide: true, env: windowsPowerShellEnv({ SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${system32};${systemRoot}` }) },
  };
}

async function readWindowsSecurity(inspected: readonly InspectedPath[], capSids: readonly string[]): Promise<WindowsSecurityResult> {
  const launch = windowsAclLaunch();
  // Captured before queueing, so concurrent first lookups each resolve the package and are compared with the cached outcome below.
  const skippedPackage = cachedDesktopPackage;
  const result = await exchangeWindowsAcl({
    id: ++windowsAclRequestId,
    paths: inspected.map((entry) => entry.path),
    capSids: [...capSids],
    skipPackage: skippedPackage !== undefined,
    setOwner: false,
  }, launch, { timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: aclOutputBytes(inspected) });
  const security = parseWindowsSecurity(result, skippedPackage);
  const desktopPackage = security.desktopPackage;
  if (cachedDesktopPackage && (cachedDesktopPackage.status !== desktopPackage.status
    || (cachedDesktopPackage.status === "resolved" && desktopPackage.status === "resolved"
      && cachedDesktopPackage.packageSid !== desktopPackage.packageSid)
    || (cachedDesktopPackage.status === "unavailable" && desktopPackage.status === "unavailable"
      && cachedDesktopPackage.reason !== desktopPackage.reason))) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  cachedDesktopPackage ??= desktopPackage;
  if (security.desktopPackage.status === "unavailable" && !packageResolutionWarned) {
    packageResolutionWarned = true;
    log.warn({ reason: security.desktopPackage.reason }, "Desktop package exemption unavailable");
  }
  return security;
}

function sandboxPrincipals(security: WindowsSecurityResult): string[] {
  const group = security.sandboxGroup;
  if (!isRecord(group) || group.name !== "CodexSandboxUsers"
    || group.description !== "Codex sandbox internal group (managed)"
    || !isMachineAccountSid(group.sid, security.machineDomainSid) || !Array.isArray(group.members)
    || !group.members.every((sid) => isMachineAccountSid(sid, security.machineDomainSid))) return [];
  // Fail closed for the whole group: one foreign or broad member invalidates all trust.
  return [group.sid, ...group.members];
}

function isMachineAccountSid(sid: unknown, machineDomainSid: unknown): sid is string {
  // Only local account SIDs qualify; well-known, built-in, logon, creator and package SIDs never do.
  return typeof sid === "string" && CAP_SID_PATTERN.test(sid)
    && typeof machineDomainSid === "string" && ACCOUNT_DOMAIN_SID_PATTERN.test(machineDomainSid)
    && sid.slice(0, sid.lastIndexOf("-")) === machineDomainSid;
}

function admittedCapSids(security: WindowsSecurityResult, candidates: readonly string[]): string[] {
  const machineDomainSid = security.machineDomainSid;
  if (typeof machineDomainSid !== "string" || !ACCOUNT_DOMAIN_SID_PATTERN.test(machineDomainSid)
    || !Array.isArray(security.capSidAccounts)) return [];
  const currentDomainSid = security.currentSid.slice(0, security.currentSid.lastIndexOf("-"));
  return candidates.filter((sid) => {
    const domainSid = sid.slice(0, sid.lastIndexOf("-"));
    const resolutions = security.capSidAccounts!.filter((entry) => isRecord(entry) && entry.sid === sid);
    return domainSid !== currentDomainSid && domainSid !== machineDomainSid
      && resolutions.length === 1 && resolutions[0]!.resolvesToAccount === false;
  });
}

function assertWindowsSecurity(
  security: WindowsSecurityResult,
  inspected: readonly InspectedPath[],
  rules: ReadonlyMap<string, readonly ComponentRule[]>,
  privateDirectories: ReadonlySet<string>,
  capSids: readonly string[] = [],
): void {
  const expected = new Set(inspected.map((entry) => win32.normalize(entry.path)));
  const seen = new Set<string>();
  // A write-restricted token must pass both normal user/group and restricting-SID checks. A cap-SID ACE therefore never extends write access to another account.
  const trustedSids = new Set([security.currentSid, ...trustedSystemSids, ...sandboxPrincipals(security), ...capSids]);
  // Capability tokens still require the normal user/group check; only the identified package’s mutation access is exempt, never ownership or private paths.
  const packageSids = new Set(security.desktopPackage.status === "resolved"
    ? [security.desktopPackage.packageSid, security.desktopPackage.capabilitySid] : []);
  const privateRoots = new Set([...privateDirectories].map((directory) => directory.toLowerCase()));
  for (const path of security.paths) {
    const key = win32.normalize(path.path);
    if (!expected.has(key)) continue;
    if (seen.has(key)) throw new CodexExecutableLocationError("Executable access rules are incomplete");
    seen.add(key);
    let privateComponent = false;
    for (let component = key.toLowerCase();; component = win32.dirname(component)) {
      if (privateRoots.has(component)) { privateComponent = true; break; }
      if (win32.dirname(component) === component) break;
    }
    const trusted = (sid: string): boolean => privateComponent
      ? sid === security.currentSid || trustedSystemSids.has(sid) : trustedSids.has(sid);
    if (!trusted(path.owner)) throw new CodexExecutableLocationError("Executable path has an untrusted owner");
    if (!path.daclPresent) throw new CodexExecutableLocationError("Executable path has unrestricted access");
    if (privateComponent && path.owner !== security.currentSid) {
      throw new CodexExecutableLocationError(`Runtime directory is not owned by the current account: ${JSON.stringify(path.path)} (owner ${path.owner}, account ${security.currentSid})`);
    }
    const componentRules = rules.get(key) ?? [{ routeKind: "script", role: "leaf" }];
    const mayIgnore = componentRules.every(({ routeKind, role }) =>
      mayIgnoreForeignSubdirectoryCreation(routeKind, privateComponent ? "private" : role));
    const mask = privateComponent ? PRIVATE_ACCESS_MASK
      : mayIgnore ? MUTATION_ACCESS_MASK & ~FILE_ADD_SUBDIRECTORY : MUTATION_ACCESS_MASK;
    for (const entry of path.entries) {
      if (entry.type !== 0 || trusted(entry.sid)) continue;
      if (!privateComponent && packageSids.has(entry.sid)) continue;
      if (!privateComponent && (entry.flags & INHERIT_ONLY_ACE) !== 0) continue;
      if ((entry.mask & mask) !== 0) {
        const reason = privateComponent
          ? "Runtime directory is accessible by another account"
          : "Executable path is writable by another account";
        throw new CodexExecutableLocationError(`${reason}: ${JSON.stringify(path.path)} (SID ${entry.sid}, mask 0x${(entry.mask >>> 0).toString(16)})`);
      }
    }
  }
  if (seen.size !== expected.size) throw new CodexExecutableLocationError("Executable access rules are incomplete");
}

async function readCapSidFile(path: string): Promise<string | null> {
  try {
    const before = await fs.lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_CAP_SID_BYTES)) return null;
    const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.ctimeNs !== before.ctimeNs || opened.mtimeNs !== before.mtimeNs) return null;
      const buffer = Buffer.alloc(MAX_CAP_SID_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (length > MAX_CAP_SID_BYTES || BigInt(length) !== before.size
        || after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) return null;
      return buffer.subarray(0, length).toString("utf8");
    } finally { await file.close(); }
  } catch { return null; }
}

function parseCapSids(contents: string | null): string[] {
  try {
    if (contents === null || Buffer.byteLength(contents) > MAX_CAP_SID_BYTES) return [];
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) return [];
    const values: unknown[] = [value.workspace, value.readonly];
    for (const key of ["workspace_by_cwd", "writable_root_by_path"]) {
      if (isRecord(value[key])) values.push(...Object.values(value[key]));
    }
    return [...new Set(values.filter((sid): sid is string => typeof sid === "string" && CAP_SID_PATTERN.test(sid)))];
  } catch { return []; }
}

async function inspectLocation(
  candidate: string,
  inspected: Map<string, InspectedPath>,
  privateDirectory = false,
): Promise<InspectedPath> {
  assertAbsolutePath(candidate);
  await inspectPathRoute(candidate, inspected, privateDirectory);
  return inspectPathRoute(await fs.realpath(candidate), inspected);
}

// Batch deduplicated routes without weakening any leaf, private-path, or ancestor-child-creation rule.
export async function assertCodexLocations(requests: readonly CodexLocationRequest[], trustInputs: CodexLocationTrustInputs = {}): Promise<void> {
  try {
    await inspectCodexLocations(requests, trustInputs);
  } catch (error) {
    if (error instanceof CodexExecutableLocationError) {
      error.routeKind ??= requests.some((request) => request.routeKind === "guarded-script") ? "guarded-script" : undefined;
      log.warn({ reason: error.message }, "Executable location rejected");
    }
    throw error;
  }
}

async function inspectCodexLocations(requests: readonly CodexLocationRequest[], trustInputs: CodexLocationTrustInputs): Promise<void> {
  const inspected = new Map<string, InspectedPath>();
  const privateDirectories = new Set<string>();
  const rules = new Map<string, ComponentRule[]>();
  for (const { path: candidate, kind, routeKind = "script" } of requests) {
    if (kind === "private-directory") {
      assertAbsolutePath(candidate);
      if ((await fs.lstat(candidate)).isSymbolicLink()) {
        throw new CodexExecutableLocationError("Runtime directory must not be a symbolic link");
      }
    }
    const route = new Map<string, InspectedPath>();
    const leaf = await inspectLocation(candidate, route, kind === "private-directory");
    for (const [key, entry] of route) {
      inspected.set(key, entry);
      const role: ComponentRole = !entry.stat.isDirectory() || key === win32.normalize(candidate)
        || key === win32.normalize(leaf.path) ? "leaf" : "ancestor";
      rules.set(key, [...rules.get(key) ?? [], { routeKind, role }]);
    }
    if (kind === "executable") {
      if (!leaf.stat.isFile()) throw new CodexExecutableLocationError("Executable path is not a regular file");
    } else if (kind === "directory") {
      if (!leaf.stat.isDirectory()) throw new CodexExecutableLocationError("Executable package path is not a directory");
    } else {
      if (!leaf.stat.isDirectory()) throw new CodexExecutableLocationError("Runtime path is not a directory");
      if (process.platform !== "win32" && (leaf.stat.uid !== process.getuid?.() || (leaf.stat.mode & 0o7777) !== 0o700)) {
        throw new CodexExecutableLocationError("Runtime directory must be private to the current account");
      }
      privateDirectories.add(process.platform === "win32" ? win32.normalize(leaf.path) : leaf.path);
    }
  }
  if (process.platform !== "win32" && process.platform !== "darwin") return;
  if (process.platform === "darwin") {
    for (const batch of aclBatches([...inspected.values()])) await assertExtendedAccessRules(batch, privateDirectories);
    return;
  }
  if (inspected.size === 0) return;
  // Cap-file routes join the same deduplicated probe batch; they never admit themselves using SIDs supplied by their own contents.
  const capPath = trustInputs.capSidPath ?? win32.join(process.env.CODEX_HOME || win32.join(homedir(), ".codex"), "cap_sid");
  const capRoute = new Map<string, InspectedPath>();
  try {
    const stat = await fs.lstat(capPath);
    if (stat.isFile() && !stat.isSymbolicLink()) await inspectLocation(capPath, capRoute);
  } catch { capRoute.clear(); }
  let batches = aclBatches([...inspected.values()]);
  const withCapPaths = batches.map((batch) => [...batch]);
  for (const [key, entry] of capRoute) {
    if (inspected.has(key)) continue;
    const batch = withCapPaths.find((paths) => paths.length < ACL_BATCH_PATHS
      && paths.reduce((chars, path) => chars + JSON.stringify(path.path).length + 1, 0)
        + JSON.stringify(entry.path).length + 1 <= ACL_BATCH_CHARS);
    if (!batch) {
      // Optional trust input must not add probes. If existing batches are full, leave the cap file unread and retain admission without cap exemptions.
      capRoute.clear();
      break;
    }
    batch.push(entry);
  }
  if (capRoute.size) batches = withCapPaths;
  // Parse only bounded SID data before the existing probe; it grants no trust until the cap-file route passes admission without those candidates below.
  let capCandidates: string[] = [];
  if (capRoute.size) {
    try { capCandidates = parseCapSids(await (trustInputs.readCapSidFile ?? readCapSidFile)(capPath)); }
    catch { /* Unreadable cap files supply no candidates. */ }
    if (JSON.stringify(capCandidates).length > ACL_BATCH_CHARS) capCandidates = [];
  }
  const all = new Map([...inspected, ...capRoute]);
  const results: WindowsSecurityResult[] = [];
  for (const batch of batches) results.push(await readWindowsSecurity(batch, capCandidates));
  const security = { ...results[0]!, paths: results.flatMap((result) => result.paths) };
  if (results.some((result) => result.currentSid !== security.currentSid)) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  for (const result of results) {
    if (result.desktopPackage.status === "unavailable") security.desktopPackage = result.desktopPackage;
    else if (security.desktopPackage.status === "resolved"
      && result.desktopPackage.packageSid !== security.desktopPackage.packageSid) {
      throw new CodexExecutableLocationError("Executable access rules are invalid");
    }
  }
  const expected = new Set(all.keys());
  if (security.paths.some((path) => !expected.has(win32.normalize(path.path)))) {
    throw new CodexExecutableLocationError("Executable access rules are incomplete");
  }
  let capSids: string[] = [];
  if (capRoute.size) {
    try {
      const capRules = new Map([...capRoute].map(([key, entry]) => [key, [{
        routeKind: "native" as const, role: !entry.stat.isDirectory() || key === win32.normalize(capPath) ? "leaf" as const : "ancestor" as const,
      }]]));
      assertWindowsSecurity(security, [...capRoute.values()], capRules, new Set());
      capSids = capCandidates.filter((sid) => results.every((result) => admittedCapSids(result, [sid]).length === 1));
    } catch { /* Untrusted or unreadable cap files supply no principals. */ }
  }
  assertWindowsSecurity(security, [...inspected.values()], rules, privateDirectories, capSids);
}

// Private objects must be owned by the token user; only administrator-owned objects may be claimed.
// Refuse foreign owners atomically and verify every returned owner; see architecture.md, Windows object ownership.
export async function claimPrivateOwnership(paths: readonly string[]): Promise<void> {
  if (process.platform !== "win32" || paths.length === 0) return;
  for (const path of paths) assertAbsolutePath(path);
  const launch = windowsAclLaunch();
  for (const batch of aclBatches(paths.map((path) => ({ path })))) {
    const result = await exchangeWindowsAcl({
      id: ++windowsAclRequestId,
      paths: batch.map(({ path }) => path),
      capSids: [],
      skipPackage: true,
      setOwner: true,
    }, launch, { timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: aclOutputBytes(batch) });
    const claim = parseOwnershipClaim(result, batch.map(({ path }) => path));
    const refused = claim.claims.find(({ outcome }) => outcome === "refused");
    if (refused) {
      throw new CodexExecutableLocationError(`Runtime directory is owned by another account: ${JSON.stringify(refused.path)} (owner ${refused.previousOwner}, account ${claim.currentSid})`);
    }
    const unowned = claim.paths.find(({ owner }) => owner !== claim.currentSid);
    if (unowned) {
      throw new CodexExecutableLocationError(`Runtime directory owner could not be set to the current account: ${JSON.stringify(unowned.path)} (owner ${unowned.owner}, account ${claim.currentSid})`);
    }
  }
}

const OWNERSHIP_CLAIM_OUTCOMES = ["kept", "set", "unclaimed", "refused"] as const;

interface OwnershipClaim {
  currentSid: string;
  paths: { path: string; owner: string }[];
  claims: { path: string; previousOwner: string; outcome: typeof OWNERSHIP_CLAIM_OUTCOMES[number] }[];
}

// The claim reply, checked path by path against the request; any other shape refuses.
function parseOwnershipClaim(value: unknown, requested: readonly string[]): OwnershipClaim {
  const invalid = () => new CodexExecutableLocationError("Runtime directory ownership reply is invalid");
  if (!isRecord(value) || typeof value.currentSid !== "string" || !SID_PATTERN.test(value.currentSid)
      || !isRecord(value.desktopPackage) || value.desktopPackage.status !== "skipped" || Object.keys(value.desktopPackage).length !== 1
      || !Array.isArray(value.paths) || value.paths.length !== requested.length
      || !Array.isArray(value.claims) || value.claims.length !== requested.length) {
    throw invalid();
  }
  const paths = value.paths.map((entry: unknown, index) => {
    if (!isRecord(entry) || entry.path !== requested[index] || typeof entry.owner !== "string" || !SID_PATTERN.test(entry.owner)) {
      throw invalid();
    }
    return { path: entry.path as string, owner: entry.owner };
  });
  const claims = value.claims.map((entry: unknown, index) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, OWNERSHIP_CLAIM_KEYS) || entry.path !== requested[index]
        || typeof entry.previousOwner !== "string" || !SID_PATTERN.test(entry.previousOwner)
        || !OWNERSHIP_CLAIM_OUTCOMES.includes(entry.outcome as typeof OWNERSHIP_CLAIM_OUTCOMES[number])) {
      throw invalid();
    }
    return { path: entry.path as string, previousOwner: entry.previousOwner, outcome: entry.outcome as typeof OWNERSHIP_CLAIM_OUTCOMES[number] };
  });
  return { currentSid: value.currentSid, paths, claims };
}

const OWNERSHIP_CLAIM_KEYS = new Set(["path", "previousOwner", "outcome"]);

// Create parents first and record only newly made paths; on creation or ownership failure remove them in reverse order.
export async function createPrivateObjects<T>(create: (created: string[]) => Promise<T>): Promise<T> {
  const created: string[] = [];
  try {
    const result = await create(created);
    await claimPrivateOwnership(created);
    return result;
  } catch (error) {
    for (const path of [...created].reverse()) await fs.rm(path, { recursive: true, force: true });
    throw error;
  }
}

// `fs.mkdir` with `recursive` that records, parents first, each directory it made, for {@link createPrivateObjects}.
export async function makePrivateDirectoryTree(path: string, created: string[]): Promise<void> {
  const reported = await fs.mkdir(path, { recursive: true, mode: 0o700 });
  if (reported === undefined) return;
  // Normalize namespaced Windows paths and drive case; reject mkdir reports outside the target to keep rollback from deleting unrelated directories.
  const first = resolvePath(process.platform === "win32" ? reported.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "") : reported);
  const same = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  const made: string[] = [];
  let directory = resolvePath(path);
  for (; !same(directory, first); directory = dirname(directory)) {
    if (dirname(directory) === directory) {
      throw new CodexExecutableLocationError(`Created directory is outside the requested path: ${JSON.stringify(reported)} for ${JSON.stringify(path)}`);
    }
    made.unshift(directory);
  }
  created.push(directory, ...made);
}

// Claim each directory for the current account in order; the first parent must exist, and later paths may nest in earlier ones.
export async function createPrivateDirectories(paths: readonly string[]): Promise<void> {
  await createPrivateObjects(async (created) => {
    for (const path of paths) {
      await fs.mkdir(path, { mode: 0o700 });
      created.push(path);
    }
  });
}

// Create one private directory owned by the current account; its parent must exist.
export async function createPrivateDirectory(path: string): Promise<string> {
  await createPrivateDirectories([path]);
  return path;
}

// `fs.mkdtemp` for a private directory owned by the current account.
export async function createPrivateTempDirectory(prefix: string): Promise<string> {
  return createPrivateObjects(async (created) => {
    const path = await fs.mkdtemp(prefix);
    created.push(path);
    return path;
  });
}

// Admit the file's location; callers execute a separately pinned artifact.
export async function assertCodexExecutableLocation(
  candidate: string,
  routeKind: CodexLocationRouteKind = "script",
  trustInputs: CodexLocationTrustInputs = {},
): Promise<void> {
  await assertCodexLocations([{ path: candidate, kind: "executable", routeKind }], trustInputs);
}

// Require a current-account private leaf and trusted, non-mutable ancestors.
export async function assertCodexPrivateRuntimeDirectory(
  candidate: string,
  routeKind: CodexLocationRouteKind = "script",
  trustInputs: CodexLocationTrustInputs = {},
): Promise<void> {
  await assertCodexLocations([{ path: candidate, kind: "private-directory", routeKind }], trustInputs);
}
