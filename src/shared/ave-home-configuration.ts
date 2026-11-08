import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { replaceStagedFile } from "../lib/atomic-file.js";
import { parseConfigurationObject, parsePolicyDocument } from "./configuration-document.js";
import { aveHomeConfigurationDirectory, AVE_HOME_CONFIGURATION_DIRECTORY, AVE_HOME_CONFIGURATION_MARKER, AVE_HOME_CONFIGURATION_MARKER_CONTENT, AVE_HOME_CONFIGURATION_SOURCES, AVE_HOME_TRUST_MANIFEST, AveHomeConfigurationUntrustedError, isAveHomeConfigurationRefused, setAveHomeConfigurationRefusedAtBoot, verifyAveHomeConfiguration, win32SystemBinary, type AveHomePrivacy } from "./ave-home.js";
import { withAveHomeConfigurationMigration } from "./ave-home-configuration-access.js";
import { AVE_HOME_CONFIGURATION_RECOVERY, isWindowsHomeRootSafe, WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { admitWindowsReparse, isOwnerOnlyDacl, readWindowsDacls, windowsOwnerRules } from "./windows-path-facts.js";
import { initialAveHomeTrustManifest } from "./ave-home-trust.js";
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

/**
 * Boot completes this before settings or policy readers can observe the new paths. A commit never imports root files: it writes
 * default documents that carry over only the closed restriction field set of the root candidates, writes the trust-state files
 * fresh, commits the marker and then preserves roots in fresh aside files. A `config/` that already holds a document this commit would not
 * write is a home that needs recovery: nothing is committed or overwritten and the home is refused (§5).
 */
export function migrateAveHomeConfiguration(home: string, privacy?: AveHomePrivacy): string[] {
  return withAveHomeConfigurationMigration(home, () => {
    if (privacy?.enforcement === "none" || isAveHomeConfigurationRefused(home)) {
      if (!isAveHomeConfigurationRefused(home)) setAveHomeConfigurationRefusedAtBoot(home);
      return [];
    }
    const committed = verifyAveHomeConfiguration(home, true);
    if (committed) {
      const diagnostics = cleanupRootConfiguration(home);
      aveHomeConfigurationDirectory(home);
      return diagnostics;
    }
    const sources = readRootConfigurationSources(home);
    const documents = carriedConfiguration(sources.bytes);
    const manifest = initialAveHomeTrustManifest(home, sources.present, movedConfigurationCandidate(home));
    const result = process.platform === "win32" ? commitWindowsConfiguration(home, documents, manifest) : commitPosixConfiguration(home, documents, manifest);
    if (result.some((diagnostic) => diagnostic.startsWith(AVE_HOME_CONFIGURATION_RECOVERY))) {
      setAveHomeConfigurationRefusedAtBoot(home, "recovery");
      return [...sources.diagnostics, ...result];
    }
    const diagnostics = [...sources.diagnostics, ...result, ...cleanupRootConfiguration(home)];
    aveHomeConfigurationDirectory(home);
    return diagnostics;
  });
}

const DEFAULT_DOCUMENTS = {
  "settings.json": "{}\n",
  "policy.json": '{"version":1,"requireExplicitApproval":true,"managed":false}\n',
  "ave-secrets.json": '{"version":1,"entries":{}}\n',
} as const satisfies Record<(typeof CONFIGURATION_FILES)[number], string>;

/**
 * The documents a commit writes: defaults, plus only the closed restriction field set of each root candidate, each as `true`
 * (strict-OR with the default). Nothing widening is imported; secrets never are. Bytes that do not parse carry nothing.
 */
export function carriedConfiguration(bytes: Partial<Record<(typeof CONFIGURATION_FILES)[number], Buffer>>): Record<(typeof CONFIGURATION_FILES)[number], string> {
  const documents: Record<(typeof CONFIGURATION_FILES)[number], string> = { ...DEFAULT_DOCUMENTS };
  const text = (buffer: Buffer | undefined) => {
    if (buffer === undefined) return undefined;
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { return undefined; }
  };
  const settings = text(bytes["settings.json"]);
  if (settings !== undefined) {
    try {
      const permissions = parseConfigurationObject(settings, true).permissions as Record<string, unknown> | undefined;
      if (permissions?.blockReadsOutsideWorkingDirectories === true) documents["settings.json"] = '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}\n';
    } catch { /* carries nothing */ }
  }
  const policy = text(bytes["policy.json"]);
  if (policy !== undefined) {
    try {
      if (parsePolicyDocument(policy).managed === true) documents["policy.json"] = '{"version":1,"requireExplicitApproval":true,"managed":true}\n';
    } catch { /* carries nothing */ }
  }
  return documents;
}

/** The root candidates' bytes, read without following links. A link or unreadable candidate carries nothing and is reported. */
function readRootConfigurationSources(home: string): { bytes: Partial<Record<(typeof CONFIGURATION_FILES)[number], Buffer>>; present: boolean; diagnostics: string[] } {
  const bytes: Partial<Record<(typeof CONFIGURATION_FILES)[number], Buffer>> = {};
  const diagnostics: string[] = [];
  let present = false;
  for (const name of CONFIGURATION_FILES) {
    const path = join(home, name);
    let identity;
    try { identity = entry(path); }
    catch (error) { present = true; diagnostics.push(`Legacy configuration could not be read safely at ${path}: ${(error as Error).message}`); continue; }
    // A zero-byte regular file is a sandbox deny placeholder (srt-win stamps absent deny targets a write grant reaches), not legacy configuration.
    if (identity === undefined || (identity.isFile() && !identity.isSymbolicLink() && identity.size === 0)) continue;
    present = true;
    if (!identity.isFile() || identity.isSymbolicLink()) { diagnostics.push(`Legacy configuration is a link or non-regular file: ${path}`); continue; }
    try {
      const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.ino !== identity.ino || opened.dev !== identity.dev || opened.size > 4 * 1024 * 1024) throw new Error("Source changed or is too large");
        bytes[name] = readFileSync(descriptor);
      } finally { closeSync(descriptor); }
    } catch (error) {
      diagnostics.push(`Legacy configuration could not be read safely at ${path}: ${(error as Error).message}`);
    }
  }
  return { bytes, present, diagnostics };
}

/**
 * D3①: a user-owned, owner-only sibling directory of the root holding a valid configuration marker looks like a `config/` that
 * was moved away. The scan is a heuristic, not a guarantee; a hit only takes away the one-click approval.
 */
function movedConfigurationCandidate(home: string): boolean {
  let names: string[];
  try { names = readdirSync(home); } catch { return false; }
  const candidates = names.filter((name) => name !== AVE_HOME_CONFIGURATION_DIRECTORY).map((name) => join(home, name)).filter((path) => {
    try {
      if (!lstatSync(path).isDirectory()) return false;
      const marker = lstatSync(join(path, AVE_HOME_CONFIGURATION_MARKER));
      return marker.isFile() && readFileSync(join(path, AVE_HOME_CONFIGURATION_MARKER), "utf8") === AVE_HOME_CONFIGURATION_MARKER_CONTENT;
    } catch { return false; }
  });
  if (candidates.length === 0) return false;
  if (process.platform !== "win32") {
    return candidates.some((path) => {
      const directory = lstatSync(path);
      return directory.uid === process.geteuid!() && (directory.mode & 0o077) === 0;
    });
  }
  try {
    return readWindowsDacls(candidates.map((path) => resolve(path))).some((row) => row.exists === true && row.directory && row.dacl !== null
      && row.dacl.protected && isOwnerOnlyDacl({ ownerSid: row.dacl.owner, elevated: row.elevated, rules: windowsOwnerRules(row.dacl) }, row.currentUserSid));
  } catch {
    // Unreadable evidence must not offer the one-click approval.
    return true;
  }
}

function cleanupRootConfiguration(home: string): string[] {
  const diagnostics: string[] = [];
  try {
    if (process.platform === "win32") {
      const result = windowsConfigurationRequest(home);
      if (!Array.isArray(result) || result.some((value) => typeof value !== "string")) throw new Error("Configuration cleanup returned invalid diagnostics");
      return result;
    }
    const root = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const sourceRoot = process.platform === "linux" ? `/proc/self/fd/${root}` : home;
      let hashes: Record<string, string> = {};
      try {
        const manifest = openSync(join(home, AVE_HOME_CONFIGURATION_DIRECTORY, AVE_HOME_CONFIGURATION_SOURCES), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
          let contents: Buffer;
          try {
            const opened = fstatSync(descriptor);
            if (!opened.isFile() || opened.ino !== identity.ino || opened.dev !== identity.dev) throw new Error("Legacy configuration changed before cleanup");
            // A sandbox deny placeholder is absent, not a source: leave it for the sandbox to re-stamp.
            if (opened.size === 0) continue;
            contents = readFileSync(descriptor);
            identical = createHash("sha256").update(contents).digest("base64") === hashes[name];
          } finally { closeSync(descriptor); }
          const current = lstatSync(path);
          if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Legacy configuration changed before cleanup");
          if (identical) unlinkSync(path);
          else {
            let asideName = readdirSync(sourceRoot).find(candidate => {
              if (!candidate.startsWith(`${name}.post-migration-`)) return false;
              const preserved = openSync(join(sourceRoot, candidate), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              try {
                const opened = fstatSync(preserved);
                return opened.isFile() && opened.size === contents.length && readFileSync(preserved).equals(contents);
              } finally { closeSync(preserved); }
            });
            if (asideName === undefined) {
              asideName = `${name}.post-migration-${new Date().toISOString().replace(/[-:.]/g, "")}`;
              const aside = join(sourceRoot, asideName);
              const reservation = openSync(aside, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
              try { writeFileSync(reservation, contents); fsyncSync(reservation); }
              finally { closeSync(reservation); }
            }
            fsyncSync(root);
            const copied = lstatSync(path);
            if (copied.ino !== identity.ino || copied.dev !== identity.dev || copied.size !== identity.size
              || copied.mtimeMs !== identity.mtimeMs || copied.ctimeMs !== identity.ctimeMs) throw new Error("Legacy configuration changed during preservation");
            unlinkSync(path);
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

export const _cleanupRootConfigurationForTest = cleanupRootConfiguration;

function commitPosixConfiguration(home: string, documents: Record<(typeof CONFIGURATION_FILES)[number], string>, manifest: string): string[] {
  const destination = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const homeHandle = openSync(home, directoryFlags);
  let directoryHandle: number | undefined;
  try {
    directoryHandle = openSync(destination, directoryFlags);
    const protection = fstatSync(directoryHandle);
    if (protection.uid !== process.getuid!() || (protection.mode & 0o077) !== 0) {
      throw new AveHomeConfigurationUntrustedError(destination, "Configuration directory protection is unverified");
    }
    const destinationRoot = process.platform === "linux" ? `/proc/self/fd/${directoryHandle}` : destination;
    const absent: Array<(typeof CONFIGURATION_FILES)[number]> = [];
    const recovery: string[] = [];
    for (const name of CONFIGURATION_FILES) {
      const existing = entry(join(destinationRoot, name));
      if (existing === undefined) { absent.push(name); continue; }
      if (!existing.isFile() || existing.isSymbolicLink()) { recovery.push(`${AVE_HOME_CONFIGURATION_RECOVERY}: ${join(destination, name)}`); continue; }
      const input = openSync(join(destinationRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const identity = fstatSync(input);
        if (identity.ino !== existing.ino || identity.dev !== existing.dev || !readFileSync(input).equals(Buffer.from(documents[name]))) {
          recovery.push(`${AVE_HOME_CONFIGURATION_RECOVERY}: ${join(destination, name)}`);
        }
      } finally { closeSync(input); }
    }
    // A `config/` that holds user files is never committed or overwritten.
    if (recovery.length > 0) return recovery;
    const write = (name: string, bytes: string) => {
      const staged = join(destinationRoot, `.${name}.migration-${randomUUID()}`);
      try {
        const output = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { fchmodSync(output, 0o600); writeFileSync(output, bytes); fsyncSync(output); }
        finally { closeSync(output); }
        replaceStagedFile(staged, join(destinationRoot, name));
        fsyncSync(directoryHandle!);
      } finally { if (entry(staged) !== undefined) unlinkSync(staged); }
    };
    for (const name of absent) write(name, documents[name]);
    // Trust-state files are written fresh by every commit and staged before the marker (R3).
    write(AVE_HOME_CONFIGURATION_SOURCES, "{}");
    write(AVE_HOME_TRUST_MANIFEST, manifest);
    write(AVE_HOME_CONFIGURATION_MARKER, AVE_HOME_CONFIGURATION_MARKER_CONTENT);
    return [];
  } finally {
    if (directoryHandle !== undefined) closeSync(directoryHandle);
    closeSync(homeHandle);
  }
}

function windowsConfigurationRequest(home: string, commit?: { contents: string[]; manifest: string }): unknown {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    if ($request.cleanup) { $result = [HomeDirectoryDacl]::CleanupConfiguration($request.home, $request.directory, [string[]]$request.names, $identity.User, $elevated) }
    else { $result = [HomeDirectoryDacl]::CommitConfiguration($request.home, $request.directory, [string[]]$request.names, $identity.User, $elevated, [string[]]$request.contents, [string]$request.manifest) }
    ConvertTo-Json -InputObject @($result) -Compress`;
  const output = runWindowsNative(() => execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ home, directory: AVE_HOME_CONFIGURATION_DIRECTORY, names: CONFIGURATION_FILES, cleanup: commit === undefined,
      ...(commit === undefined ? {} : commit) }) }) }));
  return JSON.parse(output);
}

function commitWindowsConfiguration(home: string, documents: Record<(typeof CONFIGURATION_FILES)[number], string>, manifest: string): string[] {
  const root = readWindowsDacls([resolve(home)])[0]!;
  if (!admitWindowsReparse(root, "evidence") || !isWindowsHomeRootSafe(root)) {
    throw new AveHomeConfigurationUntrustedError(home, "Configuration home protection is unverified");
  }
  const result = windowsConfigurationRequest(home, { contents: CONFIGURATION_FILES.map((name) => documents[name]), manifest });
  if (!Array.isArray(result) || result.some((value) => typeof value !== "string")) throw new Error("Configuration commit returned invalid diagnostics");
  return result;
}
