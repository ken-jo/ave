import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { queryWindowsSystemDirectorySync } from "../main/windows-path-kind-launcher.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { type GitVersion, meetsMinimumGitVersion, parseGitVersion } from "./git-version.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";
import { resolveVerifiedExecutable, type VerifiedExecutableCandidate } from "./verified-executable.js";

export interface InstallerGitInstall {
  path: string;
  root: string;
  prefix: string;
}

export interface VerifiedInstallerGit extends InstallerGitInstall {
  systemDirectory: string;
  systemRoot: string;
}

const MINGIT_PREFIXES = ["ucrt64", "clangarm64"] as const;
const BUNDLED_GIT_RETRY_MS = 10_000;
const DARWIN_GIT_SHIM = "/usr/bin/git";
const DARWIN_CLT_PROBE = "/usr/bin/xcode-select";
const VERIFIED_GIT_INSTALLATIONS: Readonly<Partial<Record<NodeJS.Platform, readonly VerifiedExecutableCandidate[]>>> = Object.freeze({
  darwin: Object.freeze([
    { executable: "/Library/Developer/CommandLineTools/usr/bin/git", installationRoots: ["/Library/Developer/CommandLineTools"] },
    { executable: "/opt/git/bin/git", installationRoots: ["/opt/git"] },
  ]),
  linux: Object.freeze([
    { executable: "/usr/bin/git", installationRoots: ["/usr/bin/git"] },
    { executable: "/opt/git/bin/git", installationRoots: ["/opt/git"] },
  ]),
});

export function supportsVerifiedHostGit(): boolean {
  return VERIFIED_GIT_INSTALLATIONS[process.platform] !== undefined;
}

export function installerGitRoot(
  packaged: boolean,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return packaged && platform === "win32" ? join(dirname(execPath), "git") : null;
}

export function findInstallerGit(root: string | null): InstallerGitInstall | null {
  const path = installerGitPath(root);
  if (root === null || path === null) return null;
  const prefix = MINGIT_PREFIXES.find((name) => existsSync(join(root, name, "libexec", "git-core")));
  return prefix && isExecutableFile(path) ? { path, root, prefix } : null;
}

function installerGitPath(root: string | null): string | null {
  return root !== null && isFullyQualified(root, process.platform) ? join(root, "cmd", "git.exe") : null;
}

function wellKnownLocations(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["C:\\Program Files\\Git\\cmd\\git.exe"];
  if (platform === "darwin") return [DARWIN_GIT_SHIM, "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  return ["/usr/bin/git", "/usr/local/bin/git"];
}

function isFullyQualified(path: string, platform: NodeJS.Platform): boolean {
  // Require a drive prefix before probing, excluding UNC, device and current-drive paths.
  // Drive letters and links can still reach remote storage. The subprocess timeout doesn't bound filesystem probes.
  return platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(path) : posix.isAbsolute(path);
}

function windowsPathEntries(searchPath: string): string[] {
  const entries: string[] = [];
  for (let start = 0; start < searchPath.length;) {
    const quote = searchPath[start];
    const quoted = quote === '"' || quote === "'";
    const closingQuote = quoted ? searchPath.indexOf(quote, start + 1) : start;
    const separator = closingQuote === -1 ? -1 : searchPath.indexOf(";", closingQuote);
    const end = separator === -1 ? searchPath.length : separator;
    entries.push(searchPath.slice(start, end).trim().replace(/^["']|["']$/gu, ""));
    start = end + 1;
  }
  return entries;
}

export function systemGitCandidates(
  platform: NodeJS.Platform,
  searchPath: string | undefined,
): string[] {
  const windows = platform === "win32";
  const seen = new Set<string>();
  const fromPath: string[] = [];
  const path = searchPath ?? "";
  const entries = windows ? windowsPathEntries(path) : path.split(":").map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"));
  for (const entry of entries) {
    if (!isFullyQualified(entry, platform)) continue;
    fromPath.push(windows ? `${entry.replace(/[\\/]+$/u, "")}\\git.exe` : posix.join(entry, "git"));
  }
  return [...fromPath, ...wellKnownLocations(platform)].filter((candidate) => {
    const key = windows ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  if (process.platform === "win32" && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()) return true;
  try {
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    if (a.ino && b.ino) return a.dev === b.dev && a.ino === b.ino;
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

function commandLineToolsInstalled(): boolean {
  try {
    execFileSync(DARWIN_CLT_PROBE, ["-p"], { stdio: "ignore", timeout: TOOL_TIMEOUT_POLICY.projectGitQueryMs });
    return true;
  } catch {
    return false;
  }
}

interface HostGitLaunch {
  path: string;
  options: { cwd?: string; env: NodeJS.ProcessEnv };
}

type DiscoveredGit = { path: string; version: GitVersion } & (
  | { installer: VerifiedInstallerGit; options: HostGitLaunch["options"] }
  | { installer?: never }
);

interface GitDiscovery {
  git: DiscoveredGit | null;
  systemTooOld?: { path: string; version: string };
}

function readGitVersion(launch: HostGitLaunch, args: string[]): GitVersion | null {
  const output = execFileSync(launch.path, args, {
    ...launch.options, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    timeout: TOOL_TIMEOUT_POLICY.projectGitQueryMs, maxBuffer: 4096,
  });
  return parseGitVersion(output);
}

let retryBundledGitAt = 0;

function probeInstallerGit(install: InstallerGitInstall): DiscoveredGit | null {
  if (performance.now() < retryBundledGitAt) return null;
  let selected: DiscoveredGit | null = null;
  let invalidPath = false;
  try {
    const systemDirectory = queryWindowsSystemDirectorySync();
    const cwd = dirname(install.path);
    const pathEntries = [cwd, join(install.root, install.prefix, "bin"), join(install.root, "usr", "bin")];

    const systemRoot = win32.dirname(systemDirectory);
    if ([...pathEntries, systemDirectory].some((entry) => entry.includes(";"))) {
      invalidPath = true;
      return null;
    }
    const options = {
      cwd,
      env: {
        PATH: [...pathEntries, systemDirectory, systemRoot].join(";"),
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_ALLOW_PROTOCOL: "",
      },
    };
    const launch = { path: install.path, options };
    const version = readGitVersion(launch, ["--no-lazy-fetch", "--version"]);
    if (version && meetsMinimumGitVersion(version)) {
      selected = { ...launch, version, installer: { ...install, systemDirectory, systemRoot } };
    }
  } catch {
    return null;
  } finally {
    if (!selected && !invalidPath) retryBundledGitAt = performance.now() + BUNDLED_GIT_RETRY_MS;
  }
  return selected;
}

function systemGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const gitVariable = process.platform === "win32" ? /^GIT_/iu : /^GIT_/u;
  for (const key of Object.keys(env)) if (gitVariable.test(key)) delete env[key];
  env.GIT_ALLOW_PROTOCOL = "";
  return env;
}

function probeSystemGit(path: string): { version: GitVersion; supported: boolean } | null {
  const launch = { path, options: { env: buildSafeChildEnv({ LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }) } };
  try {
    const version = readGitVersion(launch, ["--no-lazy-fetch", "--version"]);
    return version ? { version, supported: meetsMinimumGitVersion(version) } : null;
  } catch (error) {
    if ((error as { status?: number }).status !== 129) return null;
    // An unknown option can still leave a version to report in the runtime status.
    try {
      const version = readGitVersion(launch, ["--version"]);
      return version ? { version, supported: false } : null;
    } catch {
      return null;
    }
  }
}

const discoveredGit = new Map<string | null, GitDiscovery>();

export function discoverHostGit(installerRoot: string | null): GitDiscovery {
  const cached = discoveredGit.get(installerRoot);
  if (cached?.git && isExecutableFile(cached.git.path)) return cached;
  discoveredGit.delete(installerRoot);

  const bundledPath = installerGitPath(installerRoot);
  const bundled = findInstallerGit(installerRoot);
  const git = bundled === null ? null : probeInstallerGit(bundled);
  if (git) {
    const found = { git };
    discoveredGit.set(installerRoot, found);
    return found;
  }
  const selection: GitDiscovery = { git: null };
  let cltInstalled: boolean | undefined;
  for (const path of systemGitCandidates(process.platform, process.env.PATH)) {
    if (!isExecutableFile(path) || (bundledPath !== null && sameFile(path, bundledPath))) continue;
    if (process.platform === "darwin" && path === DARWIN_GIT_SHIM) {
      cltInstalled ??= commandLineToolsInstalled();
      if (!cltInstalled) continue;
    }
    const probe = probeSystemGit(path);
    if (!probe) continue;
    if (probe.supported) {
      selection.git = { path, version: probe.version };
      discoveredGit.set(installerRoot, selection);
      break;
    }
    if (!meetsMinimumGitVersion(probe.version)) selection.systemTooOld ??= { path, version: probe.version.text };
  }
  return selection;
}

/** Verified calls require a protected installation. Discovery caches a selected executable and checks again after a miss. */
export function resolveHostGit(policy: "verified"): string | null;
export function resolveHostGit(policy: { packaged: boolean }): HostGitLaunch | null;
export function resolveHostGit(policy: "verified" | { packaged: boolean }): HostGitLaunch | string | null {
  if (policy === "verified") {
    const candidates = VERIFIED_GIT_INSTALLATIONS[process.platform];
    return candidates === undefined ? null : resolveVerifiedExecutable(candidates)?.executable ?? null;
  }
  const { git } = discoverHostGit(installerGitRoot(policy.packaged));
  if (!git) return null;
  return { path: git.path, options: git.installer ? git.options : { env: systemGitEnvironment() } };
}
