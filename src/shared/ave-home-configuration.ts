import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { replaceStagedFile, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { validateSecretDocument } from "../data/secret-document-store.js";
import { parseConfigurationObject, parsePolicyDocument } from "./configuration-document.js";
import { aveHome, aveHomeConfigurationDirectory, aveHomeConfigurationSeal, AVE_HOME_CONFIGURATION_DIRECTORY, AVE_HOME_CONFIGURATION_FILES, AVE_HOME_CONFIGURATION_MARKER, AVE_HOME_CONFIGURATION_MARKER_CONTENT, AveHomeConfigurationUntrustedError, isAveHomeConfigurationRefused, sealAveHomeConfiguration, setAveHomeConfigurationRefusedAtBoot, verifyAveHomeConfiguration, win32SystemBinary, type AveHomeConfigurationSealReason, type AveHomePrivacy } from "./ave-home.js";
import { withAveHomeConfigurationMigration, withAveHomeConfigurationWrite } from "./ave-home-configuration-access.js";
import { AVE_HOME_QUARANTINE_DIRECTORY, readAveHomeTrustRecord, writeAveHomeTrustRecord, type AveHomeQuarantinedFile, type AveHomeTrustRecord } from "./ave-home-trust-record.js";
import { isWindowsHomeRootSafe, WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { admitWindowsReparse, isOwnerOnlyDacl, pinWindowsPaths, readWindowsDacls, windowsObjectKey, windowsOwnerRules } from "./windows-path-facts.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import type { HomeConfigurationNoticeChoice, HomeConfigurationNoticeInfo } from "./sandbox-capability-info.js";
import { runWindowsNative } from "./windows-native-host.js";

const CONFIGURATION_FILES = AVE_HOME_CONFIGURATION_FILES;

function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateConfiguration(name: string, bytes: Buffer): void {
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("Source is not valid UTF-8"); }
  if (name === "settings.json") {
    try { parseConfigurationObject(raw, true); }
    catch { throw new Error("Settings source is not a JSON object"); }
  }
  else if (name === "policy.json") parsePolicyDocument(raw);
  else validateSecretDocument(raw);
}

/**
 * Boot completes this before settings or policy readers can observe the new paths. The home's trust record (kept outside the home,
 * see ave-home-trust-record.ts) decides what the root may still contribute: a home that was ever refused never migrates or trusts root
 * configuration files again, and a home that committed `config/` never falls back to the root. Where the location cannot be trusted
 * the configuration is sealed for the run (reads find nothing, so the strict defaults apply; writes are refused) and the Permissions
 * panel says why, instead of the boot failing before the user can see the refusal.
 */
export function migrateAveHomeConfiguration(home: string, privacy?: AveHomePrivacy): string[] {
  return withAveHomeConfigurationMigration(home, () => {
    const refused = privacy?.enforcement === "none" || isAveHomeConfigurationRefused(home);
    if (refused) setAveHomeConfigurationRefusedAtBoot(home);
    let record: AveHomeTrustRecord;
    try { record = readAveHomeTrustRecord(home); }
    catch (error) {
      sealAveHomeConfiguration(home, "trust-record-unverified");
      publishNotice(home, {});
      return [`Configuration is sealed: ${(error as Error).message}`];
    }
    publishNotice(home, record);
    return refused ? settleRefusedConfiguration(home, record) : migrateTrustedConfiguration(home, record);
  });
}

function seal(home: string, reason: AveHomeConfigurationSealReason, detail: string): string {
  sealAveHomeConfiguration(home, reason);
  return `Configuration is sealed (${reason}): ${detail}`;
}

function sameRecord(left: AveHomeTrustRecord, right: AveHomeTrustRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function saveRecord(home: string, previous: AveHomeTrustRecord, next: AveHomeTrustRecord, diagnostics: string[]): boolean {
  if (sameRecord(previous, next)) return true;
  try { writeAveHomeTrustRecord(home, next); return true; }
  catch (error) { diagnostics.push(`Home trust record was not updated: ${(error as Error).message}`); return false; }
}

/** `config/` itself must still be this account's owner-only directory: a refused root can rename children, never forge their owner. */
function verifyRefusedConfigurationBoundary(config: string): void {
  if (process.platform === "win32") {
    const row = readWindowsDacls([config])[0]!;
    if (!admitWindowsReparse(row, "evidence") || row.exists !== true || !row.directory || !row.dacl?.protected
      || !isOwnerOnlyDacl({ ownerSid: row.dacl.owner, elevated: row.elevated, rules: windowsOwnerRules(row.dacl) }, row.currentUserSid)) {
      throw new Error("Configuration boundary protection is unverified");
    }
    return;
  }
  const directory = lstatSync(config);
  if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) {
    throw new Error("Configuration boundary protection is unverified");
  }
}

/** A refused home is never migrated. Its location is decided once for the run, and never falls back to a root it once left. */
function settleRefusedConfiguration(home: string, record: AveHomeTrustRecord): string[] {
  const diagnostics: string[] = [];
  const config = join(resolve(home), AVE_HOME_CONFIGURATION_DIRECTORY);
  let committed = false;
  try {
    committed = aveHomeConfigurationDirectory(home) === config;
    if (committed) verifyRefusedConfigurationBoundary(config);
    else if (record.committed) diagnostics.push(seal(home, "configuration-missing", `${config} was committed before and is now missing or uncommitted`));
    else if (entry(join(config, ".ave-config-sources.json")) !== undefined) {
      diagnostics.push(seal(home, "migration-interrupted", `${config} holds migration state without a commit`));
    }
  } catch (error) {
    committed = false;
    diagnostics.push(seal(home, "configuration-unverified", (error as Error).message));
  }
  saveRecord(home, record, { ...record, refused: true, ...(committed ? { committed: true } : {}) }, diagnostics);
  return diagnostics;
}

function migrateTrustedConfiguration(home: string, record: AveHomeTrustRecord): string[] {
  const history = record.refused === true;
  const config = join(resolve(home), AVE_HOME_CONFIGURATION_DIRECTORY);
  let committed: boolean;
  try {
    // A recorded commit makes an invalid marker tampering, not an interrupted write: it is never recovered into a fresh migration.
    committed = verifyAveHomeConfiguration(home, record.committed !== true);
  } catch (error) {
    if (record.committed !== true && !history) throw error;
    return [seal(home, "configuration-unverified", (error as Error).message)];
  }
  if (record.committed === true && !committed) {
    return [seal(home, "configuration-missing", `${config} was committed before and is now missing or uncommitted`)];
  }
  const diagnostics: string[] = [];
  let current = record;
  if (history) {
    const result = quarantineRootConfiguration(home);
    diagnostics.push(...result.diagnostics);
    if (result.files.length > 0) {
      const next = { ...current, quarantined: [...current.quarantined ?? [], ...result.files] };
      if (saveRecord(home, current, next, diagnostics)) current = next;
      else {
        // The moved files would be unknown to the notice; nothing at the root is trusted either way.
        diagnostics.push(seal(home, "quarantine-failed", "the quarantine could not be recorded"));
        publishNotice(home, { ...current, quarantined: next.quarantined });
        return diagnostics;
      }
    }
    if (result.failed) {
      diagnostics.push(seal(home, "quarantine-failed", "root configuration could not be set aside"));
      publishNotice(home, current);
      return diagnostics;
    }
  }
  diagnostics.push(...(committed ? (history ? [] : cleanupRootConfiguration(home))
    : process.platform === "win32" ? migrateWindowsConfiguration(home) : migratePosixConfiguration(home)));
  const nowCommitted = aveHomeConfigurationDirectory(home) === config;
  if (history && !nowCommitted) {
    diagnostics.push(seal(home, "quarantine-failed", "the fresh configuration did not commit"));
    publishNotice(home, current);
    return diagnostics;
  }
  const { refused: _refused, ...rest } = current;
  const next: AveHomeTrustRecord = { ...rest, ...(nowCommitted ? { committed: true as const } : {}) };
  if (saveRecord(home, current, next, diagnostics)) current = next;
  publishNotice(home, current);
  return diagnostics;
}

function quarantineFolderName(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

/**
 * Moves the home root's configuration files (links and non-regular entries included, never followed) into a new timestamped folder
 * under `<home>/quarantine/`, whose directories are this account's protected owner-only directories. Nothing moved is read as
 * configuration; the notice lists it for review and a gesture-checked restore.
 */
function quarantineRootConfiguration(home: string): { files: AveHomeQuarantinedFile[]; failed: boolean; diagnostics: string[] } {
  const folder = quarantineFolderName();
  const diagnostics: string[] = [];
  let moved: string[] = [];
  let failed = false;
  try {
    const outcome = process.platform === "win32" ? quarantineWindowsConfiguration(home, folder) : quarantinePosixConfiguration(home, folder);
    for (const line of outcome) {
      if (line.startsWith("+")) moved.push(line.slice(1));
      else { failed = true; diagnostics.push(`Root configuration could not be set aside: ${line.slice(1)}`); }
    }
  } catch (error) {
    failed = true;
    moved = [];
    diagnostics.push(`Root configuration could not be set aside: ${(error as Error).message}`);
  }
  const files = moved.filter((name): name is AveHomeQuarantinedFile["name"] => (CONFIGURATION_FILES as readonly string[]).includes(name)).map((name) => {
    const bytes = readQuarantinedFile(home, folder, name);
    return { folder, name, ...(bytes ? { sha256: createHash("sha256").update(bytes).digest("hex") } : {}) };
  });
  if (files.length > 0) diagnostics.push(`Root configuration set aside in ${join(home, AVE_HOME_QUARANTINE_DIRECTORY, folder)}: ${files.map((file) => file.name).join(", ")}`);
  return { files, failed, diagnostics };
}

function quarantinePosixConfiguration(home: string, folder: string): string[] {
  const parent = join(home, AVE_HOME_QUARANTINE_DIRECTORY);
  try { mkdirSync(parent, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const handle = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(handle);
    if (stats.uid !== process.getuid!() || (stats.mode & 0o077) !== 0) throw new Error("Quarantine protection is unverified");
  } finally { closeSync(handle); }
  const results: string[] = [];
  let target: string | undefined;
  for (const name of CONFIGURATION_FILES) {
    try {
      if (entry(join(home, name)) === undefined) continue;
      if (target === undefined) {
        target = join(parent, folder);
        mkdirSync(target, { mode: 0o700 });
      }
      // A rename moves the entry itself: a link is set aside, never followed.
      replaceStagedFile(join(home, name), join(target, name));
      results.push(`+${name}`);
    } catch (error) { results.push(`!${name}: ${(error as Error).message}`); }
  }
  return results;
}

function quarantineWindowsConfiguration(home: string, folder: string): string[] {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    ConvertTo-Json -InputObject @([HomeDirectoryDacl]::QuarantineConfiguration($request.home, $request.folder, [string[]]$request.names, $identity.User, $elevated)) -Compress`;
  const output = runWindowsNative(() => execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ home, folder, names: CONFIGURATION_FILES }) }) }));
  const result: unknown = JSON.parse(output);
  if (!Array.isArray(result) || result.some((value) => typeof value !== "string" || !/^[+!]/.test(value))) throw new Error("Configuration quarantine returned an invalid result");
  return result as string[];
}

/** The bytes of a quarantined regular file, or undefined when it is a link, a directory, too large or unreadable. */
function readQuarantinedFile(home: string, folder: string, name: string): Buffer | undefined {
  const path = join(home, AVE_HOME_QUARANTINE_DIRECTORY, folder, name);
  let descriptor: number | undefined;
  try {
    if (process.platform === "win32") {
      const row = pinWindowsPaths([path])[0]!;
      if (!admitWindowsReparse(row, "evidence") || row.exists !== true || row.directory || row.volumeSerialNumber === null || row.fileIndex === null) return undefined;
      descriptor = openSync(path, constants.O_RDONLY);
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== BigInt(row.volumeSerialNumber) || opened.ino !== BigInt(row.fileIndex) || opened.size > 4n * 1024n * 1024n) return undefined;
    } else {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > 4 * 1024 * 1024) return undefined;
    }
    return readFileSync(descriptor);
  } catch {
    // A planted entry may refuse this account; it then stays set aside and cannot be restored by Ave.
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface ConfigurationNoticeState {
  readonly home: string;
  readonly quarantined: readonly AveHomeQuarantinedFile[];
}

let notice: ConfigurationNoticeState | undefined;

function publishNotice(home: string, record: AveHomeTrustRecord): void {
  notice = { home: resolve(home), quarantined: record.quarantined ?? [] };
}

/** What the Permissions panel shows about this run's configuration: why it is sealed, and what a trusted start set aside. */
export function getAveHomeConfigurationNotice(home = aveHome()): HomeConfigurationNoticeInfo | undefined {
  const sealed = aveHomeConfigurationSeal(home);
  const files = notice !== undefined && notice.home === resolve(home) ? notice.quarantined : [];
  if (sealed === undefined && files.length === 0) return undefined;
  return {
    ...(sealed !== undefined ? { sealed } : {}),
    ...(files.length > 0 ? { quarantine: { directory: join(resolve(home), AVE_HOME_QUARANTINE_DIRECTORY), files: files.map((file) => ({
      folder: file.folder, name: file.name, restorable: file.sha256 !== undefined, restoreRequested: file.restore === true,
    })) } } : {}),
  };
}

/**
 * Applies a gesture-checked choice from the Permissions panel to the home's trust record. Nothing is restored in this run:
 * `restore` asks the next trusted start to verify the file again (same bytes, same reader validation) and write it into `config/`
 * before any reader starts; `dismiss` forgets the notice and leaves the files in the quarantine folder; `start-fresh` lets the next
 * trusted start set the root aside and create a fresh `config/` after a committed one went missing.
 */
export function resolveAveHomeConfigurationNotice(choice: HomeConfigurationNoticeChoice, home = aveHome()): void {
  const record = readAveHomeTrustRecord(home);
  if (choice.action === "start-fresh") {
    if (aveHomeConfigurationSeal(home) !== "configuration-missing") throw new Error("Starting fresh applies only when committed configuration is missing");
    const { committed: _committed, ...rest } = record;
    writeAveHomeTrustRecord(home, { ...rest, refused: true });
    return;
  }
  const quarantined = record.quarantined ?? [];
  let next: AveHomeQuarantinedFile[];
  if (choice.action === "dismiss") next = quarantined.filter((file) => file.restore === true);
  else {
    const target = quarantined.find((file) => file.folder === choice.folder && file.name === choice.name);
    if (target === undefined) throw new Error("No such quarantined configuration file");
    if (target.sha256 === undefined) throw new Error("This quarantined file cannot be restored by Ave");
    next = quarantined.map((file) => file === target ? { ...file, restore: true as const } : file);
  }
  const { quarantined: _previous, ...rest } = record;
  const updated: AveHomeTrustRecord = { ...rest, ...(next.length > 0 ? { quarantined: next } : {}) };
  writeAveHomeTrustRecord(home, updated);
  publishNotice(home, updated);
}

/**
 * On a trusted start whose `config/` is committed, writes the quarantined files the user asked to restore into `config/` through the
 * verified configuration write path, after checking that the bytes are the ones set aside and that they pass reader validation.
 */
export async function restoreRequestedConfiguration(home: string): Promise<string[]> {
  const pending = notice !== undefined && notice.home === resolve(home) ? notice.quarantined.filter((file) => file.restore === true) : [];
  if (pending.length === 0 || aveHomeConfigurationSeal(home) !== undefined || isAveHomeConfigurationRefused(home)
    || aveHomeConfigurationDirectory(home) !== join(resolve(home), AVE_HOME_CONFIGURATION_DIRECTORY)) return [];
  const diagnostics: string[] = [];
  const restored = new Set<AveHomeQuarantinedFile>();
  for (const file of pending) {
    try {
      const bytes = readQuarantinedFile(home, file.folder, file.name);
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("its bytes changed after it was set aside");
      validateConfiguration(file.name, bytes);
      await withAveHomeConfigurationWrite(join(home, file.name), async (target) => writeUtf8FileAtomicSync(target, bytes.toString("utf8"), 0o600));
      restored.add(file);
      diagnostics.push(`Restored ${file.name} from ${join(home, AVE_HOME_QUARANTINE_DIRECTORY, file.folder)}`);
    } catch (error) {
      diagnostics.push(`Quarantined ${file.name} was not restored: ${(error as Error).message}`);
    }
  }
  const record = readAveHomeTrustRecord(home);
  const next = (record.quarantined ?? []).flatMap((file) => {
    const match = pending.find((entry) => entry.folder === file.folder && entry.name === file.name);
    if (match === undefined) return [file];
    if (restored.has(match)) return [];
    const { restore: _restore, ...kept } = file;
    return [kept];
  });
  const { quarantined: _previous, ...rest } = record;
  const updated: AveHomeTrustRecord = { ...rest, ...(next.length > 0 ? { quarantined: next } : {}) };
  saveRecord(home, record, updated, diagnostics);
  publishNotice(home, updated);
  return diagnostics;
}

/** Test teardown only. */
export function _resetAveHomeConfigurationNoticeForTest(): void {
  notice = undefined;
}

function cleanupRootConfiguration(home: string): string[] {
  const diagnostics: string[] = [];
  try {
    if (process.platform === "win32") {
      const result = windowsConfigurationRequest(home, undefined, true);
      if (!Array.isArray(result) || result.some((value) => typeof value !== "string")) throw new Error("Configuration cleanup returned invalid diagnostics");
      return result;
    }
    const root = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const sourceRoot = process.platform === "linux" ? `/proc/self/fd/${root}` : home;
      let hashes: Record<string, string> = {};
      try {
        const manifest = openSync(join(home, "config", ".ave-config-sources.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!fstatSync(manifest).isFile()) throw new Error("Configuration source record is not a regular file");
          const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration source record is invalid");
          hashes = parsed as Record<string, string>;
        } finally { closeSync(manifest); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`Configuration source record is unavailable: ${(error as Error).message}`);
      }
      for (const name of CONFIGURATION_FILES) {
        const path = join(sourceRoot, name);
        const oldPath = join(home, name);
        try {
          const identity = entry(path);
          if (identity === undefined) continue;
          if (!identity.isFile() || identity.isSymbolicLink()) {
            diagnostics.push(`Legacy configuration is a link or non-regular file: ${oldPath}`);
            continue;
          }
          const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let identical: boolean;
          try {
            const opened = fstatSync(descriptor);
            if (!opened.isFile() || opened.ino !== identity.ino || opened.dev !== identity.dev) throw new Error("Legacy configuration changed before cleanup");
            identical = createHash("sha256").update(readFileSync(descriptor)).digest("base64") === hashes[name];
          } finally { closeSync(descriptor); }
          const current = lstatSync(path);
          if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Legacy configuration changed before cleanup");
          if (identical) unlinkSync(path);
          else {
            const asideName = `${name}.post-migration-${new Date().toISOString().replace(/[-:.]/g, "")}`;
            const aside = join(sourceRoot, asideName);
            const reservation = openSync(aside, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            closeSync(reservation);
            replaceStagedFile(path, aside);
            diagnostics.push(`Legacy configuration preserved at ${join(home, asideName)}`);
          }
          fsyncSync(root);
        } catch (error) {
          diagnostics.push(`Legacy configuration cleanup failed at ${oldPath}: ${(error as Error).message}`);
        }
      }
    } finally { closeSync(root); }
  } catch (error) {
    diagnostics.push(`Legacy configuration cleanup failed at ${home}: ${(error as Error).message}`);
  }
  return diagnostics;
}

function migratePosixConfiguration(home: string): string[] {
  const destination = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const homeHandle = openSync(home, directoryFlags);
  let directoryHandle: number | undefined;
  const diagnostics: string[] = [];
  const copied: Array<{ name: string; source: string; ino: number | bigint; dev: number | bigint; bytes: Buffer }> = [];
  try {
    directoryHandle = openSync(destination, directoryFlags);
    const protection = fstatSync(directoryHandle);
    if (protection.uid !== process.getuid!() || (protection.mode & 0o077) !== 0) {
      throw new AveHomeConfigurationUntrustedError(destination, "Configuration directory protection is unverified");
    }
    const sourceRoot = process.platform === "linux" ? `/proc/self/fd/${homeHandle}` : home;
    const destinationRoot = process.platform === "linux" ? `/proc/self/fd/${directoryHandle}` : destination;
    for (const name of CONFIGURATION_FILES) {
      const oldPath = join(home, name);
      const source = join(sourceRoot, name);
      const staged = join(destinationRoot, `.${name}.migration-${randomUUID()}`);
      let input: number | undefined;
      try {
        const oldEntry = entry(source);
        if (oldEntry === undefined) continue;
        if (!oldEntry.isFile() || oldEntry.isSymbolicLink()) {
          diagnostics.push(`Configuration source is a link or non-regular file: ${oldPath}`);
          continue;
        }
        input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const identity = fstatSync(input);
        if (!identity.isFile() || identity.ino !== oldEntry.ino || identity.dev !== oldEntry.dev) throw new Error("Source changed");
        const bytes = readFileSync(input);
        validateConfiguration(name, bytes);
        const output = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          fchmodSync(output, 0o600);
          writeFileSync(output, bytes);
          fsyncSync(output);
        } finally { closeSync(output); }
        replaceStagedFile(staged, join(destinationRoot, name));
        fsyncSync(directoryHandle);
        copied.push({ name, source, ino: identity.ino, dev: identity.dev, bytes });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Source could not be read safely";
        diagnostics.push(`Configuration source rejected at ${oldPath}: ${reason}`);
      } finally {
        if (input !== undefined) closeSync(input);
        if (entry(staged) !== undefined) unlinkSync(staged);
      }
    }
    if (diagnostics.length > 0) return diagnostics;
    for (const name of CONFIGURATION_FILES) {
      if (copied.some((file) => file.name === name)) continue;
      const bytes = name === "settings.json" ? "{}\n" : name === "policy.json"
        ? '{"version":1,"requireExplicitApproval":true,"managed":false}\n'
        : '{"version":1,"entries":{}}\n';
      const existing = entry(join(destinationRoot, name));
      if (existing !== undefined) {
        if (!existing.isFile() || existing.isSymbolicLink()) return [`Configuration without a root source is not a regular file: ${join(destination, name)}`];
        const input = openSync(join(destinationRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const identity = fstatSync(input);
          if (identity.ino !== existing.ino || identity.dev !== existing.dev || !readFileSync(input).equals(Buffer.from(bytes))) {
            return [`Configuration without a root source requires recovery: ${join(destination, name)}`];
          }
        } finally { closeSync(input); }
        continue;
      }
      const staged = join(destinationRoot, `.${name}.migration-${randomUUID()}`);
      const output = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(output, bytes); fsyncSync(output); }
      finally { closeSync(output); }
      try { replaceStagedFile(staged, join(destinationRoot, name)); fsyncSync(directoryHandle); }
      finally { if (entry(staged) !== undefined) unlinkSync(staged); }
    }
    for (const identity of copied) {
      const current = entry(identity.source);
      if (current?.ino !== identity.ino || current.dev !== identity.dev) return [`Configuration source changed before commit: ${identity.source}`];
      const input = openSync(identity.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(input);
        if (!opened.isFile() || opened.ino !== identity.ino || opened.dev !== identity.dev || !readFileSync(input).equals(identity.bytes)) {
          return [`Configuration source changed before commit: ${identity.source}`];
        }
      } finally { closeSync(input); }
    }
    const stagedHashes = join(destinationRoot, `.ave-config-sources-${randomUUID()}`);
    try {
      const manifest = openSync(stagedHashes, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(manifest, JSON.stringify(Object.fromEntries(copied.map(({ name, bytes }) => [name, createHash("sha256").update(bytes).digest("base64")]))));
        fsyncSync(manifest);
      } finally { closeSync(manifest); }
      replaceStagedFile(stagedHashes, join(destinationRoot, ".ave-config-sources.json"));
      fsyncSync(directoryHandle);
    } finally { if (entry(stagedHashes) !== undefined) unlinkSync(stagedHashes); }
    const stagedMarker = join(destinationRoot, `.${AVE_HOME_CONFIGURATION_MARKER}.migration-${randomUUID()}`);
    try {
      const marker = openSync(stagedMarker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(marker, AVE_HOME_CONFIGURATION_MARKER_CONTENT);
        fsyncSync(marker);
      } finally { closeSync(marker); }
      replaceStagedFile(stagedMarker, join(destinationRoot, AVE_HOME_CONFIGURATION_MARKER));
      fsyncSync(directoryHandle);
    } finally { if (entry(stagedMarker) !== undefined) unlinkSync(stagedMarker); }
    diagnostics.push(...cleanupRootConfiguration(home));
  } finally {
    if (directoryHandle !== undefined) closeSync(directoryHandle);
    closeSync(homeHandle);
  }
  return diagnostics;
}

function windowsConfigurationRequest(home: string, hashes?: Array<string | null>, cleanup = false): unknown {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    if ($request.cleanup) { $result = [HomeDirectoryDacl]::CleanupConfiguration($request.home, $request.directory, [string[]]$request.names, $identity.User, $elevated) }
    else { $result = [HomeDirectoryDacl]::MigrateConfiguration($request.home, $request.directory, [string[]]$request.names, $identity.User, $elevated, [string[]]$request.hashes) }
    ConvertTo-Json -InputObject @($result) -Compress`;
  const output = runWindowsNative(() => execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ home, directory: AVE_HOME_CONFIGURATION_DIRECTORY, names: CONFIGURATION_FILES, hashes, cleanup }) }) }));
  return JSON.parse(output);
}

function migrateWindowsConfiguration(home: string): string[] {
  const root = readWindowsDacls([resolve(home)])[0]!;
  if (!admitWindowsReparse(root, "evidence") || !isWindowsHomeRootSafe(root)) {
    throw new AveHomeConfigurationUntrustedError(home, "Configuration home protection is unverified");
  }
  const sources = CONFIGURATION_FILES.map(name => {
    try {
      const path = resolve(home, name);
      const row = readWindowsDacls([path])[0]!;
      if (!admitWindowsReparse(row, "evidence")) return "!Source is a link, reparse point or non-regular file";
      if (row.exists === false) return null;
      if (row.directory || row.volumeSerialNumber === null || row.fileIndex === null) return "!Source could not be read safely";
      const descriptor = openSync(path, constants.O_RDONLY);
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.dev !== BigInt(row.volumeSerialNumber) || opened.ino !== BigInt(row.fileIndex)
          || opened.size > 4n * 1024n * 1024n) return "!Source could not be read safely";
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor, { bigint: true });
        const current = pinWindowsPaths([path])[0]!;
        if (!admitWindowsReparse(current, "evidence") || !current.exists || current.directory
          || windowsObjectKey(current) !== windowsObjectKey(row) || after.dev !== opened.dev || after.ino !== opened.ino
          || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
          || BigInt(bytes.length) !== opened.size) return "!Source could not be read safely";
        return bytes.toString("base64");
      } finally { closeSync(descriptor); }
    } catch {
      return "!Source could not be read safely";
    }
  });
  if (!Array.isArray(sources) || sources.length !== CONFIGURATION_FILES.length || sources.some((value) => value !== null && typeof value !== "string")) {
    throw new Error("Configuration migration returned invalid sources");
  }
  const diagnostics: string[] = [];
  const hashes = sources.map((source: string | null, index: number) => {
    if (source === null) return null;
    const path = join(home, CONFIGURATION_FILES[index]);
    if (source.startsWith("!")) { diagnostics.push(`${source.slice(1)}: ${path}`); return null; }
    const bytes = Buffer.from(source, "base64");
    try { validateConfiguration(CONFIGURATION_FILES[index], bytes); }
    catch (error) {
      diagnostics.push(`Configuration source fails reader validation at ${path}: ${(error as Error).message}`);
      return null;
    }
    return createHash("sha256").update(bytes).digest("base64");
  });
  if (diagnostics.length > 0) return diagnostics;
  const result = windowsConfigurationRequest(home, hashes);
  if (!Array.isArray(result) || result.some((value) => typeof value !== "string")) throw new Error("Configuration migration returned invalid diagnostics");
  return result;
}
