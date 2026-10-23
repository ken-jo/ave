import { execFile } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import { posix, win32 } from "node:path";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { isRecord } from "../shared/is-record.js";

const MAX_SYMLINKS = 40;
const MAX_ACL_OUTPUT_BYTES = 256 * 1024;
// One probe receives at most this many paths, which keeps the path list well
// inside a Windows environment variable and the output budget per path stable.
const ACL_BATCH_PATHS = 128;
const ACL_BATCH_CHARS = 24 * 1024;
const ACL_OUTPUT_PATHS = 16;
const ACL_PATHS_ENV = "AVE_EXECUTABLE_ACL_PATHS";
const trustedSystemSids = new Set([
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const MUTATION_ACCESS_MASK = 0x000d0156 | 0x50000000;
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
  constructor(reason: string) {
    super(reason);
    this.name = "CodexExecutableLocationError";
  }
}

interface InspectedPath {
  path: string;
  stat: Stats;
}

/** A location admitted with the rule its single-path function applies. */
export interface CodexLocationRequest {
  readonly path: string;
  readonly kind: "executable" | "directory" | "private-directory";
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
  paths: WindowsPathSecurity[];
}

// Open the path object itself so a reparse point's ACL cannot be replaced by
// its target's ACL. The path list is data supplied through the environment.
const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.ComponentModel;",
  "using System.Runtime.InteropServices;",
  "using Microsoft.Win32.SafeHandles;",
  "public static class ExecutablePathSecurity {",
  "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);",
  "  [DllImport(\"advapi32.dll\", SetLastError = true)]",
  "  private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);",
  "  [DllImport(\"advapi32.dll\")]",
  "  private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);",
  "  [DllImport(\"kernel32.dll\")]",
  "  private static extern IntPtr LocalFree(IntPtr memory);",
  "  public static byte[] Read(string path) {",
  "    using (SafeFileHandle handle = CreateFile(path, 0x00020000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {",
  "      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());",
  "      IntPtr owner, group, dacl, sacl, descriptor;",
  "      uint result = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);",
  "      if (result != 0) throw new Win32Exception((int)result);",
  "      try {",
  "        byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];",
  "        Marshal.Copy(descriptor, bytes, 0, bytes.Length);",
  "        return bytes;",
  "      } finally { LocalFree(descriptor); }",
  "    }",
  "  }",
  "}",
  "'@",
  // Direct assignment preserves the decoded array without nesting it inside
  // the single pipeline object returned by the system command's JSON parser.
  "$targets = ConvertFrom-Json -InputObject $env:AVE_EXECUTABLE_ACL_PATHS",
  "$paths = @($targets | ForEach-Object {",
  "  $target = [string]$_",
  "  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new([ExecutablePathSecurity]::Read($target), 0)",
  "  $entries = @(if ($null -ne $descriptor.DiscretionaryAcl) { $descriptor.DiscretionaryAcl | ForEach-Object {",
  "    if ($_ -isnot [System.Security.AccessControl.CommonAce]) { throw 'Unsupported access entry' }",
  "    [PSCustomObject]@{ sid = $_.SecurityIdentifier.Value; mask = [int64]$_.AccessMask; flags = [int]$_.AceFlags; type = [int]$_.AceType }",
  "  } })",
  "  [PSCustomObject]@{ path = $target; owner = $descriptor.Owner.Value; daclPresent = ($null -ne $descriptor.DiscretionaryAcl); entries = $entries }",
  "})",
  "[PSCustomObject]@{ currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; paths = $paths } | ConvertTo-Json -Depth 6 -Compress",
].join("\n");

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

function aclOutputBytes(inspected: readonly InspectedPath[]): number {
  return MAX_ACL_OUTPUT_BYTES * Math.max(1, Math.ceil(inspected.length / ACL_OUTPUT_PATHS));
}

function aclBatches(inspected: readonly InspectedPath[]): InspectedPath[][] {
  const batches: InspectedPath[][] = [];
  let batch: InspectedPath[] = [];
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

function parseWindowsSecurity(stdout: string): WindowsSecurityResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  } catch {
    throw new CodexExecutableLocationError("Executable access rules could not be read");
  }
  if (!isRecord(value) || typeof value.currentSid !== "string" || !/^S-1-(?:\d+-)*\d+$/.test(value.currentSid)
      || !Array.isArray(value.paths)) {
    throw new CodexExecutableLocationError("Executable access rules are invalid");
  }
  for (const path of value.paths) {
    if (!isRecord(path) || typeof path.path !== "string" || typeof path.owner !== "string"
        || typeof path.daclPresent !== "boolean" || !Array.isArray(path.entries)) {
      throw new CodexExecutableLocationError("Executable access rules are invalid");
    }
    for (const entry of path.entries) {
      if (!isRecord(entry) || typeof entry.sid !== "string" || !Number.isInteger(entry.mask)
          || !Number.isInteger(entry.flags) || !Number.isInteger(entry.type)
          || (entry.type !== 0 && entry.type !== 1)) {
        throw new CodexExecutableLocationError("Executable access rules are unsupported");
      }
    }
  }
  return value as unknown as WindowsSecurityResult;
}

async function readWindowsSecurity(inspected: readonly InspectedPath[]): Promise<WindowsSecurityResult> {
  // The current account's process environment is trusted; arbitrary actions
  // by that account are outside the filesystem admission boundary.
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir;
  if (typeof root !== "string" || !/^[a-z]:[\\/]/i.test(root) || /[\u0000-\u001f\u007f]/.test(root)) {
    throw new CodexExecutableLocationError("System directory is unavailable");
  }
  const systemRoot = win32.normalize(root);
  const system32 = win32.join(systemRoot, "System32");
  const command = win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true,
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
      maxBuffer: aclOutputBytes(inspected),
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: `${system32};${systemRoot}`,
        [ACL_PATHS_ENV]: JSON.stringify(inspected.map((entry) => entry.path)),
      },
    }, (error, output) => error ? reject(error) : resolve(output));
  });
  return parseWindowsSecurity(stdout);
}

async function assertWindowsSecurity(inspected: readonly InspectedPath[], privateDirectories: ReadonlySet<string>): Promise<void> {
  const security = await readWindowsSecurity(inspected);
  const expected = new Set(inspected.map((entry) => win32.normalize(entry.path)));
  const seen = new Set<string>();
  for (const path of security.paths) {
    const key = win32.normalize(path.path);
    if (!expected.has(key) || seen.has(key)) throw new CodexExecutableLocationError("Executable access rules are incomplete");
    seen.add(key);
    const trusted = (sid: string): boolean => sid === security.currentSid || trustedSystemSids.has(sid);
    if (!trusted(path.owner)) throw new CodexExecutableLocationError("Executable path has an untrusted owner");
    if (!path.daclPresent) throw new CodexExecutableLocationError("Executable path has unrestricted access");
    const privateLeaf = privateDirectories.has(key);
    if (privateLeaf && path.owner !== security.currentSid) {
      throw new CodexExecutableLocationError("Runtime directory is not owned by the current account");
    }
    for (const entry of path.entries) {
      if (entry.type !== 0 || trusted(entry.sid)) continue;
      if (!privateLeaf && (entry.flags & INHERIT_ONLY_ACE) !== 0) continue;
      const mask = privateLeaf ? PRIVATE_ACCESS_MASK : MUTATION_ACCESS_MASK;
      if ((entry.mask & mask) !== 0) {
        throw new CodexExecutableLocationError(privateLeaf
          ? "Runtime directory is accessible by another account"
          : "Executable path is writable by another account");
      }
    }
  }
  if (seen.size !== expected.size) throw new CodexExecutableLocationError("Executable access rules are incomplete");
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

/**
 * Admit every location with its single-path rule, then read the access rules
 * of all their deduplicated routes through as few probes as the batch allows.
 * A private leaf keeps the private rule even where it is also another
 * location's ancestor, since that rule is stricter than the ancestor rule.
 */
export async function assertCodexLocations(requests: readonly CodexLocationRequest[]): Promise<void> {
  const inspected = new Map<string, InspectedPath>();
  const privateDirectories = new Set<string>();
  for (const { path: candidate, kind } of requests) {
    if (kind === "private-directory") {
      assertAbsolutePath(candidate);
      if ((await fs.lstat(candidate)).isSymbolicLink()) {
        throw new CodexExecutableLocationError("Runtime directory must not be a symbolic link");
      }
    }
    const leaf = await inspectLocation(candidate, inspected, kind === "private-directory");
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
  for (const batch of aclBatches([...inspected.values()])) {
    if (process.platform === "win32") await assertWindowsSecurity(batch, privateDirectories);
    else await assertExtendedAccessRules(batch, privateDirectories);
  }
}

/** Admit the file's location; callers execute a separately pinned artifact. */
export async function assertCodexExecutableLocation(candidate: string): Promise<void> {
  await assertCodexLocations([{ path: candidate, kind: "executable" }]);
}

/** Require a current-account private leaf and trusted, non-mutable ancestors. */
export async function assertCodexPrivateRuntimeDirectory(candidate: string): Promise<void> {
  await assertCodexLocations([{ path: candidate, kind: "private-directory" }]);
}

/** Check a package directory and every route component with the shared trust policy. */
export async function assertExecutableDirectory(candidate: string): Promise<void> {
  await assertCodexLocations([{ path: candidate, kind: "directory" }]);
}
