import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { replaceStagedFile } from "../lib/atomic-file.js";
import { validateSecretDocument } from "../data/secret-document-store.js";
import { parseConfigurationObject, parsePolicyDocument } from "./configuration-document.js";
import { aveHomeConfigurationDirectory, AVE_HOME_CONFIGURATION_DIRECTORY, AVE_HOME_CONFIGURATION_MARKER, AVE_HOME_CONFIGURATION_MARKER_CONTENT, AveHomeConfigurationUntrustedError, isAveHomeConfigurationRefused, setAveHomeConfigurationRefusedAtBoot, verifyAveHomeConfiguration, win32SystemBinary, type AveHomePrivacy } from "./ave-home.js";
import { withAveHomeConfigurationMigration } from "./ave-home-configuration-access.js";
import { isWindowsHomeRootSafe, WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { admitWindowsReparse, pinWindowsPaths, readWindowsDacls, windowsObjectKey } from "./windows-path-facts.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { runWindowsNative } from "./windows-native-host.js";

const CONFIGURATION_FILES = ["settings.json", "policy.json", "ave-secrets.json"] as const;

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

/** Boot completes this before settings or policy readers can observe the new paths. */
export function migrateAveHomeConfiguration(home: string, privacy?: AveHomePrivacy): string[] {
  return withAveHomeConfigurationMigration(home, () => {
    if (privacy?.enforcement === "none" || isAveHomeConfigurationRefused(home)) {
      setAveHomeConfigurationRefusedAtBoot(home);
      return [];
    }
    const committed = verifyAveHomeConfiguration(home, true);
    const diagnostics = committed ? cleanupRootConfiguration(home)
      : process.platform === "win32" ? migrateWindowsConfiguration(home) : migratePosixConfiguration(home);
    aveHomeConfigurationDirectory(home);
    return diagnostics;
  });
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
            // A sandbox deny placeholder is absent, not a source: leave it for the sandbox to re-stamp.
            if (opened.size === 0) continue;
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
        if (identity.size === 0) continue;
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
        return bytes.length === 0 ? null : bytes.toString("base64");
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
