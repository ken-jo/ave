import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { replaceStagedFile } from "../lib/atomic-file.js";
import { AVE_HOME_CONFIGURATION_FILES } from "./ave-home.js";
import { testHomeTrustDirectory } from "./ave-home-test-guard.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { runWindowsNative } from "./windows-native-host.js";
import { admitWindowsReparse, isOwnerOnlyDacl, pinWindowsPaths, readWindowsDacls, windowsOwnerRules } from "./windows-path-facts.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { win32SystemBinary } from "./windows-system-path.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

/** A configuration file a trusted boot moved out of the home root, kept until the user restores it or dismisses the notice. */
export interface AveHomeQuarantinedFile {
  /** The timestamped folder under `<home>/quarantine/`, or its `config` subfolder for files set aside from an uncommitted `config/`. */
  readonly folder: string;
  readonly name: (typeof AVE_HOME_CONFIGURATION_FILES)[number];
  /** SHA-256 (hex) of the bytes moved; absent when they could not be read safely, so the file cannot be restored by Ave. */
  readonly sha256?: string;
  /** The user asked (a gesture-checked action) to restore it on the next trusted start. */
  readonly restore?: true;
}

/**
 * What Ave knows about one home across starts, kept outside the home so the home root's ACL has no bearing on it.
 * - `refused`: a start refused the root's protection; root configuration files are never migrated or trusted again.
 * - `committed`: `config/` was committed; it never falls back to the root.
 * - `workspaceUnavailable`: consecutive starts whose workspace check could not open the workspace.
 */
export interface AveHomeTrustRecord {
  readonly refused?: true;
  readonly committed?: true;
  readonly workspaceUnavailable?: number;
  readonly quarantined?: readonly AveHomeQuarantinedFile[];
}

class AveHomeTrustRecordError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`Home trust record is unverified at ${path}: ${reason}`);
    this.name = "AveHomeTrustRecordError";
  }
}

export const AVE_HOME_QUARANTINE_DIRECTORY = "quarantine";
const QUARANTINE_FOLDER = /^\d{8}T\d{6,9}Z(?:\/config)?$/;

/** Where records live: the run's directory in tests, `%LOCALAPPDATA%\Ave\home-trust` on Windows, nowhere on POSIX (see below). */
export function aveHomeTrustDirectory(): string | undefined {
  const test = testHomeTrustDirectory();
  if (test !== undefined) return resolve(test);
  // POSIX homes are never refused (mode 0700 is enforced at every start), so there is no refusal history to keep.
  if (process.platform !== "win32") return undefined;
  const local = process.env.LOCALAPPDATA?.trim();
  if (!local) throw new AveHomeTrustRecordError("%LOCALAPPDATA%", "Local application data folder is not set");
  return join(resolve(local), "Ave", "home-trust");
}

function recordName(home: string): string {
  const key = process.platform === "win32" ? resolve(home).toLowerCase() : resolve(home);
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

function trustDirectoryCreateRequest(path: string) {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $handle = [HomeDirectoryDacl]::OpenHome($request.path, $identity.User, $true);
    try {
      if (-not [HomeDirectoryDacl]::OwnerOnly([HomeDirectoryDacl]::Read($handle), $identity.User, $elevated)) { throw 'Home trust directory protection is unverified' }
    } finally { $handle.Dispose() }`;
  return { file: win32SystemBinary("WindowsPowerShell/v1.0/powershell"), args: [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], options: { input: script, encoding: "utf-8" as const, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    timeout: TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs + TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
    env: windowsPowerShellEnv({ ...process.env, AVE_DACL_REQUEST: JSON.stringify({ path }) }) } };
}

/** True when the directory exists as this account's protected owner-only directory; false when absent; throws otherwise. */
function verifyTrustDirectory(directory: string): boolean {
  if (process.platform === "win32") {
    // An absent directory (or an absent `%LOCALAPPDATA%\Ave` above it) is simply no record yet.
    try { lstatSync(directory); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
    const row = readWindowsDacls([directory])[0]!;
    if (!admitWindowsReparse(row, "evidence")) throw new Error("Directory is a link or junction");
    if (row.exists === false) return false;
    if (!row.directory || !row.dacl?.protected || !isOwnerOnlyDacl({ ownerSid: row.dacl.owner, elevated: row.elevated,
      rules: windowsOwnerRules(row.dacl) }, row.currentUserSid)) throw new Error("Directory is not this account's owner-only directory");
    return true;
  }
  let handle: number;
  try { handle = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const stats = fstatSync(handle);
    if (!stats.isDirectory() || stats.uid !== process.getuid!() || (stats.mode & 0o077) !== 0) throw new Error("Directory is not this account's owner-only directory");
  } finally { closeSync(handle); }
  return true;
}

function ensureTrustDirectory(directory: string): void {
  if (verifyTrustDirectory(directory)) return;
  mkdirSync(dirname(directory), { recursive: true });
  if (process.platform === "win32") {
    const { file, args, options } = trustDirectoryCreateRequest(directory);
    runWindowsNative(() => execFileSync(file, args, options));
  } else {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!verifyTrustDirectory(directory)) throw new Error("Directory is missing after creation");
}

function parseRecord(text: string): AveHomeTrustRecord {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Record is not an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["version", "refused", "committed", "workspaceUnavailable", "quarantined"].includes(key)) throw new Error(`Record has an unknown field ${key}`);
  }
  if (raw.version !== 1) throw new Error("Record version is unsupported");
  if (raw.refused !== undefined && raw.refused !== true) throw new Error("Record refusal is invalid");
  if (raw.committed !== undefined && raw.committed !== true) throw new Error("Record commit is invalid");
  if (raw.workspaceUnavailable !== undefined && (!Number.isSafeInteger(raw.workspaceUnavailable) || (raw.workspaceUnavailable as number) < 1)) {
    throw new Error("Record workspace count is invalid");
  }
  let quarantined: AveHomeQuarantinedFile[] | undefined;
  if (raw.quarantined !== undefined) {
    if (!Array.isArray(raw.quarantined)) throw new Error("Record quarantine is invalid");
    quarantined = raw.quarantined.map((entry: unknown) => {
      const file = entry as Record<string, unknown> | null;
      if (!file || typeof file !== "object" || typeof file.folder !== "string" || !QUARANTINE_FOLDER.test(file.folder)
        || !(AVE_HOME_CONFIGURATION_FILES as readonly unknown[]).includes(file.name)
        || (file.sha256 !== undefined && (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)))
        || (file.restore !== undefined && (file.restore !== true || file.sha256 === undefined))
        || Object.keys(file).some((key) => !["folder", "name", "sha256", "restore"].includes(key))) throw new Error("Record quarantine entry is invalid");
      return file as unknown as AveHomeQuarantinedFile;
    });
  }
  return {
    ...(raw.refused ? { refused: true as const } : {}),
    ...(raw.committed ? { committed: true as const } : {}),
    ...(raw.workspaceUnavailable !== undefined ? { workspaceUnavailable: raw.workspaceUnavailable as number } : {}),
    ...(quarantined?.length ? { quarantined } : {}),
  };
}

/**
 * The home's record: empty when none was written (a home this account has never refused or committed under this build), and
 * an {@link AveHomeTrustRecordError} when one exists but cannot be verified. Callers fail closed on that error.
 */
export function readAveHomeTrustRecord(home: string): AveHomeTrustRecord {
  const directory = aveHomeTrustDirectory();
  if (directory === undefined) return {};
  const path = join(directory, recordName(home));
  try {
    if (!verifyTrustDirectory(directory)) return {};
    if (process.platform === "win32") {
      const row = pinWindowsPaths([path])[0]!;
      if (!admitWindowsReparse(row, "evidence")) throw new Error("Record is a link");
      if (row.exists === false) return {};
      if (row.directory) throw new Error("Record is not a regular file");
      return parseRecord(readFileSync(path, "utf8"));
    }
    let handle: number;
    try { handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    try {
      if (!fstatSync(handle).isFile()) throw new Error("Record is not a regular file");
      return parseRecord(readFileSync(handle, "utf8"));
    } finally { closeSync(handle); }
  } catch (error) {
    if (error instanceof AveHomeTrustRecordError) throw error;
    throw new AveHomeTrustRecordError(path, (error as Error).message);
  }
}

/** Replace the home's record atomically inside the verified owner-only directory; an empty record removes it. */
export function writeAveHomeTrustRecord(home: string, record: AveHomeTrustRecord): void {
  const directory = aveHomeTrustDirectory();
  if (directory === undefined) return;
  const path = join(directory, recordName(home));
  try {
    ensureTrustDirectory(directory);
    const value = parseRecord(JSON.stringify({ version: 1, ...record }));
    if (Object.keys(value).length === 0) {
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      unlinkSync(path);
      return;
    }
    const staged = join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
      try {
        if (process.platform !== "win32") fchmodSync(handle, 0o600);
        writeFileSync(handle, JSON.stringify({ version: 1, ...value }));
        fsyncSync(handle);
      } finally { closeSync(handle); }
      replaceStagedFile(staged, path);
    } finally {
      try { unlinkSync(staged); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) {
    if (error instanceof AveHomeTrustRecordError) throw error;
    throw new AveHomeTrustRecordError(path, (error as Error).message);
  }
}

/**
 * Counts consecutive starts whose workspace check could not open the workspace, and returns the warning once the check has failed
 * on two or more starts in a row: a one-start failure is already reported by the start itself, a repeated one means the workspace's
 * inherited entries and writers have stayed unverified.
 */
export function recordAveHomeWorkspaceCheck(home: string, unavailable: boolean): string | undefined {
  const record = readAveHomeTrustRecord(home);
  const count = unavailable ? (record.workspaceUnavailable ?? 0) + 1 : 0;
  if (count !== (record.workspaceUnavailable ?? 0)) {
    const { workspaceUnavailable: _previous, ...rest } = record;
    writeAveHomeTrustRecord(home, count > 0 ? { ...rest, workspaceUnavailable: count } : rest);
  }
  return count >= 2
    ? `Directory "workspace" could not be checked on ${count} consecutive starts — its inherited entries and writers stay unverified until a start can open it`
    : undefined;
}
