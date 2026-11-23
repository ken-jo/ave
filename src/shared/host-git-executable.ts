import { accessSync, constants, existsSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { queryWindowsSystemDirectory, queryWindowsSystemDirectorySync } from "../main/windows-path-kind-launcher.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { type GitVersion, meetsMinimumGitVersion, parseGitVersion } from "./git-version.js";
import { runGitProbeAsync, runGitProbeSync } from "./host-git-probe.js";
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
  const install = runChecksSync(findInstallerLayout(root, path));
  return install && executableIdentitySync(path) !== null ? install : null;
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

/** A POSIX search path with only its absolute entries: an empty or relative one is read against the folder a call runs in. */
export function absolutePosixSearchPath(searchPath: string): string {
  return searchPath.split(":").filter((entry) => isFullyQualified(entry, "linux")).join(":");
}

function windowsPathEntries(searchPath: string): string[] {
  const entries: string[] = [];
  for (let start = 0; start < searchPath.length;) {
    while (/\s/u.test(searchPath.charAt(start))) start++;
    const quote = searchPath[start];
    const quoted = quote === '"' || quote === "'";
    const closingQuote = quoted ? searchPath.indexOf(quote, start + 1) : start;
    if (closingQuote === -1) break;
    const separator = searchPath.indexOf(";", closingQuote);
    const end = separator === -1 ? searchPath.length : separator;
    if (quoted) {
      if (searchPath.slice(closingQuote + 1, end).trim() === "") {
        entries.push(searchPath.slice(start + 1, closingQuote));
      }
    } else {
      const entry = searchPath.slice(start, end).trim();
      if (entry.includes('"')) break;
      entries.push(entry);
    }
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

interface DiscoveryCheck<T = unknown> {
  sync(): T;
  async(): Promise<T>;
}

type GitChecks<T> = Generator<DiscoveryCheck, T, unknown>;

// Both drivers perform the same checks and feed their results back into the same selection policy.
function* check<T>(sync: () => T, async: () => Promise<T>): GitChecks<T> {
  return (yield { sync, async }) as T;
}

function runChecksSync<T>(checks: GitChecks<T>): T {
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = step.value.sync();
    } catch (error) {
      step = checks.throw(error);
      continue;
    }
    step = checks.next(value);
  }
  return step.value;
}

async function runChecksAsync<T>(checks: GitChecks<T>): Promise<T> {
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value.async();
    } catch (error) {
      step = checks.throw(error);
      continue;
    }
    step = checks.next(value);
  }
  return step.value;
}

function executableAccessMode(): number {
  return process.platform === "win32" ? constants.F_OK : constants.X_OK;
}

function fileIdentity(stat: BigIntStats): string | null {
  return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":") : null;
}

function executableIdentitySync(path: string): string | null {
  try {
    accessSync(path, executableAccessMode());
    return fileIdentity(statSync(path, { bigint: true }));
  } catch {
    return null;
  }
}

async function executableIdentityAsync(path: string): Promise<string | null> {
  try {
    await access(path, executableAccessMode());
    return fileIdentity(await stat(path, { bigint: true }));
  } catch {
    return null;
  }
}

function executableIdentity(path: string) {
  return check(() => executableIdentitySync(path), () => executableIdentityAsync(path));
}

function* sameFile(left: string, right: string): GitChecks<boolean> {
  if (left === right) return true;
  if (process.platform === "win32" && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()) return true;
  try {
    const a = yield* check(() => statSync(left, { bigint: true }), () => stat(left, { bigint: true }));
    const b = yield* check(() => statSync(right, { bigint: true }), () => stat(right, { bigint: true }));
    if (a.ino && b.ino) return a.dev === b.dev && a.ino === b.ino;
    const realLeft = yield* check(() => realpathSync.native(left), () => realpath(left));
    const realRight = yield* check(() => realpathSync.native(right), () => realpath(right));
    return realLeft === realRight;
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

export interface GitDiscovery {
  git: DiscoveredGit | null;
  systemTooOld?: { path: string; version: string };
}

function runProbe(path: string, args: string[], options: Parameters<typeof runGitProbeAsync>[2] = {}) {
  return check(() => runGitProbeSync(path, args, options), () => runGitProbeAsync(path, args, options));
}

function* findInstallerLayout(root: string, path: string): GitChecks<InstallerGitInstall | null> {
  for (const prefix of MINGIT_PREFIXES) {
    const core = join(root, prefix, "libexec", "git-core");
    const exists = yield* check(() => existsSync(core), () => access(core).then(() => true, () => false));
    if (exists) return { path, root, prefix };
  }
  return null;
}

let retryBundledGitAt = 0;

function* probeInstallerGit(install: InstallerGitInstall): GitChecks<DiscoveredGit | null> {
  if (performance.now() < retryBundledGitAt) return null;
  let selected: DiscoveredGit | null = null;
  try {
    const cwd = dirname(install.path);
    const pathEntries = [cwd, join(install.root, install.prefix, "bin"), join(install.root, "usr", "bin")];
    if (pathEntries.some((entry) => entry.includes(";"))) return null;
    const systemDirectory = yield* check(queryWindowsSystemDirectorySync,
      () => queryWindowsSystemDirectory(TOOL_TIMEOUT_POLICY.projectGitQueryMs));
    const systemRoot = win32.dirname(systemDirectory);
    if (systemDirectory.includes(";")) return null;
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
    const probe = yield* runProbe(install.path, ["--no-lazy-fetch", "--version"], options);
    const version = probe.exitCode === 0 && parseGitVersion(probe.stdout);
    if (version && meetsMinimumGitVersion(version)) {
      selected = { path: install.path, options, version, installer: { ...install, systemDirectory, systemRoot } };
    }
  } catch {
    return null;
  } finally {
    if (!selected) retryBundledGitAt = performance.now() + BUNDLED_GIT_RETRY_MS;
  }
  return selected;
}

function systemGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const gitVariable = process.platform === "win32" ? /^GIT_/iu : /^GIT_/u;
  for (const key of Object.keys(env)) if (gitVariable.test(key)) delete env[key];
  env.GIT_ALLOW_PROTOCOL = "";
  if (process.platform !== "win32" && env.PATH !== undefined) env.PATH = absolutePosixSearchPath(env.PATH);
  return env;
}

function* probeSystemGit(path: string): GitChecks<{ version: GitVersion; supported: boolean } | null> {
  const env = buildSafeChildEnv({ LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  const options = { env };
  const probe = yield* runProbe(path, ["--no-lazy-fetch", "--version"], options);
  if (probe.exitCode === 0) {
    const version = parseGitVersion(probe.stdout);
    return version ? { version, supported: meetsMinimumGitVersion(version) } : null;
  }
  if (probe.exitCode !== 129) return null;
  // An unknown option can still leave a version to report in the runtime status.
  const fallback = yield* runProbe(path, ["--version"], options);
  const version = fallback.exitCode === 0 && parseGitVersion(fallback.stdout);
  return version ? { version, supported: false } : null;
}

interface GitScan {
  selection: GitDiscovery;
  identity: string | null;
  developerDirectory?: string;
}

const discoveredGit = new Map<string | null, GitScan>();
const pendingDiscoveries = new Map<string | null, Promise<GitDiscovery>>();

function* isDirectory(path: string): GitChecks<boolean> {
  try {
    return (yield* check(() => statSync(path), () => stat(path))).isDirectory();
  } catch {
    return false;
  }
}

function* selectGit(installerRoot: string | null, cached: GitScan | undefined, failedPath?: string): GitChecks<GitScan> {
  if (cached?.selection.git && (yield* executableIdentity(cached.selection.git.path)) === cached.identity
    && (!cached.developerDirectory || (yield* isDirectory(cached.developerDirectory)))) return cached;

  const bundledPath = installerGitPath(installerRoot);
  if (installerRoot !== null && bundledPath !== null && bundledPath !== failedPath) {
    const candidate = yield* probeStableGit(bundledPath, function* () {
      const bundled = yield* findInstallerLayout(installerRoot, bundledPath);
      return bundled ? yield* probeInstallerGit(bundled) : null;
    });
    if (candidate) return { selection: { git: candidate.result }, identity: candidate.identity };
  }

  const selection: GitDiscovery = { git: null };
  let shimDirectory: string | undefined;
  for (const path of systemGitCandidates(process.platform, process.env.PATH)) {
    const candidate = yield* probeStableGit(path, function* () {
      if (failedPath !== undefined && (yield* sameFile(path, failedPath))) return null;
      if (bundledPath !== null && (yield* sameFile(path, bundledPath))) return null;
      let developerDirectory: string | undefined;
      if (process.platform === "darwin" && (yield* sameFile(path, DARWIN_GIT_SHIM))) {
        if (shimDirectory === undefined) {
          const guard = yield* runProbe(DARWIN_CLT_PROBE, ["-p"]);
          shimDirectory = guard.exitCode === 0 ? guard.stdout.trim() : "";
        }
        if (!posix.isAbsolute(shimDirectory)) return null;
        developerDirectory = shimDirectory;
      }
      const probe = yield* probeSystemGit(path);
      return probe && { ...probe, developerDirectory };
    });
    if (!candidate) continue;
    const { version, supported, developerDirectory } = candidate.result;
    if (supported) return { selection: { ...selection, git: { path, version } }, identity: candidate.identity, developerDirectory };
    if (!meetsMinimumGitVersion(version)) selection.systemTooOld ??= { path, version: version.text };
  }
  return { selection, identity: null };
}

function* probeStableGit<T>(path: string, probe: () => GitChecks<T | null>): GitChecks<{ result: T; identity: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = yield* executableIdentity(path);
    if (identity === null) return null;
    const result = yield* probe();
    if (result === null) return null;
    if ((yield* executableIdentity(path)) === identity) return { result, identity };
  }
  return null;
}

function finishDiscovery(installerRoot: string | null, cached: GitScan | undefined, result: GitScan): GitDiscovery {
  // A synchronous caller may have already updated the memo while an async probe was pending.
  if (discoveredGit.get(installerRoot) === cached) {
    if (result.identity === null) discoveredGit.delete(installerRoot);
    else discoveredGit.set(installerRoot, result);
  }
  return result.selection;
}

function discoverHostGitSync(installerRoot: string | null): GitDiscovery {
  const cached = discoveredGit.get(installerRoot);
  const result = runChecksSync(selectGit(installerRoot, cached));
  return finishDiscovery(installerRoot, cached, result);
}

function discoverGit(installerRoot: string | null, failedPath?: string): Promise<GitDiscovery> {
  const pending = pendingDiscoveries.get(installerRoot);
  if (pending) return pending;
  const cached = discoveredGit.get(installerRoot);
  const discovery: Promise<GitDiscovery> = runChecksAsync(selectGit(installerRoot, cached, failedPath))
    .then((result) => pendingDiscoveries.get(installerRoot) === discovery
      ? finishDiscovery(installerRoot, cached, result)
      : result.selection)
    .finally(() => {
      if (pendingDiscoveries.get(installerRoot) === discovery) pendingDiscoveries.delete(installerRoot);
    });
  pendingDiscoveries.set(installerRoot, discovery);
  return discovery;
}

export function discoverHostGitAsync(installerRoot: string | null): Promise<GitDiscovery> {
  return discoverGit(installerRoot);
}

function isLaunchFailure(error: unknown, path: string): boolean {
  if (!(error instanceof Error)) return false;
  const launch = (error.cause ?? error) as { code?: string; path?: string };
  return launch.path === path && (launch.code === "ENOENT" || launch.code === "EACCES");
}

export async function withHostGitRecovery<T>(
  installerRoot: string | null,
  use: (discovery: GitDiscovery) => Promise<T>,
): Promise<T> {
  let discovery = await discoverGit(installerRoot);
  for (let attempt = 0; ; attempt++) {
    try {
      return await use(discovery);
    } catch (error) {
      const { git } = discovery;
      if (!git || !isLaunchFailure(error, git.path)) throw error;
      const ownsSelection = discoveredGit.get(installerRoot)?.selection.git === git;
      if (ownsSelection) {
        discoveredGit.delete(installerRoot);
        pendingDiscoveries.delete(installerRoot);
      }
      if (attempt === 1) throw error;
      discovery = await discoverGit(installerRoot, ownsSelection ? git.path : undefined);
    }
  }
}

/** Verified calls require a protected installation. Discovery caches a selected executable and checks again after a miss. */
export function resolveHostGit(policy: "verified"): string | null;
export function resolveHostGit(policy: { packaged: boolean }): HostGitLaunch | null;
export function resolveHostGit(policy: "verified" | { packaged: boolean }): HostGitLaunch | string | null {
  if (policy === "verified") {
    const candidates = VERIFIED_GIT_INSTALLATIONS[process.platform];
    return candidates === undefined ? null : resolveVerifiedExecutable(candidates)?.executable ?? null;
  }
  const { git } = discoverHostGitSync(installerGitRoot(policy.packaged));
  return gitLaunch(git);
}

function gitLaunch(git: DiscoveredGit | null): HostGitLaunch | null {
  if (!git) return null;
  return { path: git.path, options: git.installer ? git.options : { env: systemGitEnvironment() } };
}

export function withHostGitLaunch<T>(packaged: boolean, use: (git: HostGitLaunch | null) => Promise<T>): Promise<T> {
  return withHostGitRecovery(installerGitRoot(packaged), ({ git }) => use(gitLaunch(git)));
}
