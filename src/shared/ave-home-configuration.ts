import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AVE_HOME_CONFIGURATION_DIRECTORY, win32SystemBinary } from "./ave-home.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";

const CONFIGURATION_FILES = ["settings.json", "policy.json", "ave-secrets.json"] as const;

function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Boot completes this before settings or policy readers can observe the new paths. */
export function migrateAveHomeConfiguration(home: string): string[] {
  if (!CONFIGURATION_FILES.some((name) => entry(join(home, name)) !== undefined)) return [];
  if (process.platform === "win32") return migrateWindowsConfiguration(home);
  const destination = join(home, AVE_HOME_CONFIGURATION_DIRECTORY);
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const homeHandle = openSync(home, directoryFlags);
  let directoryHandle: number | undefined;
  const diagnostics: string[] = [];
  try {
    directoryHandle = openSync(destination, directoryFlags);
    fchmodSync(directoryHandle, 0o700);
    const sourceRoot = process.platform === "linux" ? `/proc/self/fd/${homeHandle}` : home;
    const destinationRoot = process.platform === "linux" ? `/proc/self/fd/${directoryHandle}` : destination;
    for (const name of CONFIGURATION_FILES) {
      const oldPath = join(home, name);
      const newPath = join(destination, name);
      const source = join(sourceRoot, name);
      const target = join(destinationRoot, name);
      const oldEntry = entry(source);
      if (oldEntry === undefined) continue;
      if (!oldEntry.isFile() || oldEntry.isSymbolicLink()) {
        diagnostics.push(`Skipped non-regular configuration source "${oldPath}" for "${newPath}"`);
        continue;
      }
      if (entry(target) !== undefined) {
        diagnostics.push(`Configuration "${newPath}" already exists; retained legacy "${oldPath}" without merging`);
        continue;
      }
      const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const staged = join(destinationRoot, `.${name}.migration-${randomUUID()}`);
      try {
        const identity = fstatSync(input);
        if (!identity.isFile() || identity.ino !== oldEntry.ino || identity.dev !== oldEntry.dev) throw new Error("Configuration source changed before copying");
        const output = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          fchmodSync(output, 0o600);
          writeFileSync(output, readFileSync(input));
          fsyncSync(output);
        } finally { closeSync(output); }
        if (entry(target) !== undefined) {
          diagnostics.push(`Configuration "${newPath}" already exists; retained legacy "${oldPath}" without merging`);
          continue;
        }
        renameSync(staged, target);
        fsyncSync(directoryHandle);
        const current = entry(source);
        if (current?.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Configuration source changed before deletion");
        unlinkSync(source);
        fsyncSync(homeHandle);
      } finally {
        closeSync(input);
        if (entry(staged) !== undefined) unlinkSync(staged);
      }
    }
  } finally {
    if (directoryHandle !== undefined) closeSync(directoryHandle);
    closeSync(homeHandle);
  }
  return diagnostics;
}

function migrateWindowsConfiguration(home: string): string[] {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $diagnostics = [HomeDirectoryDacl]::MigrateConfiguration($request.home, $request.directory, [string[]]$request.names, $identity.User, $elevated);
    ConvertTo-Json -InputObject @($diagnostics) -Compress`;
  const bootstrap = "$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))";
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ home, directory: AVE_HOME_CONFIGURATION_DIRECTORY, names: CONFIGURATION_FILES }) }) });
  const diagnostics: unknown = JSON.parse(output);
  if (!Array.isArray(diagnostics) || diagnostics.some((value) => typeof value !== "string")) {
    throw new Error("Configuration migration returned invalid diagnostics");
  }
  return diagnostics;
}
