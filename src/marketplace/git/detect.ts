/**
 * Which git the marketplace runs (design §9.1).
 *
 *   system  — the first usable git on PATH, then the well-known install
 *             locations; must be at least {@link MIN_GIT_VERSION}.
 *   managed — the Ave-downloaded copy (§9.2), present and smoke-tested.
 *   auto    — system if usable, else managed if present, else "missing".
 *             A system git that is too old is reported, and auto moves on.
 *
 * On macOS `/usr/bin/git` is a shim that opens the Command Line Tools
 * installer when the tools are absent. Detection asks `xcode-select -p`
 * first and treats a missing toolchain as "no git there", so probing never
 * pops a dialog.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix } from "node:path";
import type { GitRuntimeMode } from "../../shared/git-runtime-mode.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { type GitVersion, meetsMinimumGitVersion, parseGitVersion } from "./git-version.js";


export interface GitExecutable {
  kind: "system" | "managed";
  /** Absolute path of the `git` binary. */
  path: string;
  version: GitVersion;
  /** Managed copies only: the install root that holds `bin/`, `libexec/`, … */
  managedRoot?: string;
}

interface TooOldGit {
  path: string;
  version: string;
}

export type GitDetection =
  | { state: "ready"; git: GitExecutable; systemTooOld?: TooOldGit }
  | { state: "missing"; systemTooOld?: TooOldGit }
  /** `system` mode only: the system git exists but is older than the minimum. */
  | { state: "too-old"; systemTooOld: TooOldGit };

/** A managed copy that is installed and passed its smoke test (§9.2). */
export interface ManagedGitInstall {
  path: string;
  root: string;
  version: GitVersion;
}

export interface GitDetectionDeps {
  platform: NodeJS.Platform;
  /** The PATH value to search, usually `process.env.PATH`. */
  searchPath: string | undefined;
  isExecutableFile(path: string): Promise<boolean>;
  /** Output of `<path> --version`, or null when it cannot be run. */
  readVersion(path: string): Promise<string | null>;
  /** darwin only: `xcode-select -p` succeeds. */
  commandLineToolsInstalled(): Promise<boolean>;
  findManagedGit(): Promise<ManagedGitInstall | null>;
}

const DARWIN_CLT_SHIM = "/usr/bin/git";

function wellKnownLocations(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["C:\\Program Files\\Git\\cmd\\git.exe"];
  if (platform === "darwin") return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  return ["/usr/bin/git", "/usr/local/bin/git"];
}

export function systemGitCandidates(platform: NodeJS.Platform, searchPath: string | undefined): string[] {
  const binary = platform === "win32" ? "git.exe" : "git";
  const sep = platform === "win32" ? ";" : ":";
  const fromPath = (searchPath ?? "")
    .split(sep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((entry) => entry.length > 0 && (platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(entry) : entry.startsWith("/")))
    .map((entry) => (platform === "win32" ? `${entry.replace(/[\\/]+$/u, "")}\\${binary}` : posix.join(entry, binary)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [...fromPath, ...wellKnownLocations(platform)]) {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function findSystemGit(
  deps: GitDetectionDeps,
): Promise<{ git: GitExecutable | null; tooOld: TooOldGit | null }> {
  let tooOld: TooOldGit | null = null;
  let cltChecked: boolean | null = null;
  for (const candidate of systemGitCandidates(deps.platform, deps.searchPath)) {
    if (!(await deps.isExecutableFile(candidate))) continue;
    if (deps.platform === "darwin" && candidate === DARWIN_CLT_SHIM) {
      cltChecked ??= await deps.commandLineToolsInstalled();
      if (!cltChecked) continue;
    }
    const output = await deps.readVersion(candidate);
    const version = output === null ? null : parseGitVersion(output);
    if (!version) continue;
    if (meetsMinimumGitVersion(version)) {
      return { git: { kind: "system", path: candidate, version }, tooOld };
    }
    tooOld ??= { path: candidate, version: version.text };
  }
  return { git: null, tooOld };
}

export async function detectGitRuntime(mode: GitRuntimeMode, deps: GitDetectionDeps): Promise<GitDetection> {
  if (mode === "managed") {
    const managed = await deps.findManagedGit();
    return managed
      ? { state: "ready", git: { kind: "managed", path: managed.path, version: managed.version, managedRoot: managed.root } }
      : { state: "missing" };
  }
  const system = await findSystemGit(deps);
  const tooOld = system.tooOld ? { systemTooOld: system.tooOld } : {};
  if (system.git) return { state: "ready", git: system.git, ...tooOld };
  if (mode === "system") {
    return system.tooOld ? { state: "too-old", systemTooOld: system.tooOld } : { state: "missing" };
  }
  const managed = await deps.findManagedGit();
  if (managed) {
    return {
      state: "ready",
      git: { kind: "managed", path: managed.path, version: managed.version, managedRoot: managed.root },
      ...tooOld,
    };
  }
  return { state: "missing", ...tooOld };
}

const VERSION_PROBE_TIMEOUT_MS = 5_000;

function execFileText(file: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: buildSafeChildEnv({ LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }),
      },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }),
    );
  });
}

export function nodeGitDetectionDeps(findManagedGit: () => Promise<ManagedGitInstall | null>): GitDetectionDeps {
  return {
    platform: process.platform,
    searchPath: process.env.PATH,
    async isExecutableFile(path) {
      try {
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readVersion(path) {
      const result = await execFileText(path, ["--version"]);
      return result.ok ? result.stdout : null;
    },
    async commandLineToolsInstalled() {
      return (await execFileText("/usr/bin/xcode-select", ["-p"])).ok;
    },
    findManagedGit,
  };
}
