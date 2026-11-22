import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

export interface InstallerGitInstall {
  path: string;
  root: string;
  prefix: string;
}

const MINGIT_PREFIXES = ["ucrt64", "clangarm64"] as const;
export const DARWIN_GIT_SHIM = "/usr/bin/git";
export const DARWIN_CLT_PROBE = "/usr/bin/xcode-select";

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
  // A Windows path with a leading slash but no drive still depends on the current drive.
  return platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(path) : posix.isAbsolute(path);
}

export function systemGitCandidates(
  platform: NodeJS.Platform,
  searchPath: string | undefined,
): string[] {
  const windows = platform === "win32";
  const seen = new Set<string>();
  const fromPath: string[] = [];
  for (const rawEntry of (searchPath ?? "").split(windows ? ";" : ":")) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
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

let hostGitPath: string | null | undefined;

/** Cache the executable (or its absence) for synchronous project instruction lookups. */
export function resolveHostGit(packaged: boolean): string | null {
  if (hostGitPath === undefined) {
    hostGitPath = findInstallerGit(installerGitRoot(packaged))?.path
      ?? systemGitCandidates(process.platform, process.env.PATH).find(canRunSystemGit)
      ?? null;
  }
  return hostGitPath;
}
