import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { queryWindowsSystemDirectorySync } from "../main/windows-path-kind-launcher.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";
import { resolveVerifiedExecutable, type VerifiedExecutableCandidate } from "./verified-executable.js";

export interface InstallerGitInstall {
  path: string;
  root: string;
  prefix: string;
}

const MINGIT_PREFIXES = ["ucrt64", "clangarm64"] as const;
export const DARWIN_GIT_SHIM = "/usr/bin/git";
export const DARWIN_CLT_PROBE = "/usr/bin/xcode-select";
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
  if (root === null || !isFullyQualified(root, process.platform)) return null;
  const path = join(root, "cmd", "git.exe");
  const prefix = MINGIT_PREFIXES.find((name) => existsSync(join(root, name, "libexec", "git-core")));
  return prefix && isExecutableFile(path) ? { path, root, prefix } : null;
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

function canRunSystemGit(path: string): boolean {
  if (!isExecutableFile(path)) return false;
  if (process.platform !== "darwin" || path !== DARWIN_GIT_SHIM) return true;
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

function probeInstallerGit(install: InstallerGitInstall): HostGitLaunch | undefined {
  try {
    const cwd = dirname(install.path);
    const systemDirectory = queryWindowsSystemDirectorySync();
    const systemRoot = win32.dirname(systemDirectory);
    const pathEntries = [
      cwd, join(install.root, install.prefix, "bin"), join(install.root, "usr", "bin"),
      systemDirectory, systemRoot,
    ];
    if (pathEntries.some((entry) => entry.includes(";"))) return undefined;
    const options = {
      cwd,
      env: {
        PATH: pathEntries.join(";"),
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_ALLOW_PROTOCOL: "",
      },
    };
    const output = execFileSync(install.path, ["--no-lazy-fetch", "--version"], {
      ...options, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      timeout: TOOL_TIMEOUT_POLICY.projectGitQueryMs, maxBuffer: 4096,
    });
    return output.startsWith("git version ") ? { path: install.path, options } : undefined;
  } catch {
    return undefined;
  }
}

function systemGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const gitVariable = process.platform === "win32" ? /^GIT_/iu : /^GIT_/u;
  for (const key of Object.keys(env)) if (gitVariable.test(key)) delete env[key];
  env.GIT_ALLOW_PROTOCOL = "";
  return env;
}

let hostGit: HostGitLaunch | string | undefined;

/** Verified calls require a protected installation. Discovery caches a selected executable and checks again after a miss. */
export function resolveHostGit(policy: "verified"): string | null;
export function resolveHostGit(policy: { packaged: boolean }): HostGitLaunch | null;
export function resolveHostGit(policy: "verified" | { packaged: boolean }): HostGitLaunch | string | null {
  if (policy === "verified") {
    const candidates = VERIFIED_GIT_INSTALLATIONS[process.platform];
    return candidates === undefined ? null : resolveVerifiedExecutable(candidates)?.executable ?? null;
  }
  if (hostGit === undefined) {
    const bundled = findInstallerGit(installerGitRoot(policy.packaged));
    hostGit = (bundled === null ? undefined : probeInstallerGit(bundled))
      ?? systemGitCandidates(process.platform, process.env.PATH).find(canRunSystemGit);
  }
  return typeof hostGit === "string" ? { path: hostGit, options: { env: systemGitEnvironment() } } : hostGit ?? null;
}
