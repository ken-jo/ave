import { accessSync, constants, existsSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { queryWindowsSystemDirectory, queryWindowsSystemDirectorySync } from "../main/windows-path-kind-launcher.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { type GitVersion, meetsMinimumGitVersion, parseGitVersion } from "./git-version.js";
import { runGitProbeAsync, runGitProbeSync } from "./host-git-probe.js";
import { check, runChecksAsync, runChecksSync, throwPastDeadline, type Checks } from "./sync-async-checks.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";
import { resolveVerifiedExecutableAsync, type VerifiedExecutableCandidate } from "./verified-executable.js";

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
  const absolutePath = searchPath.split(":").filter((entry) => isFullyQualified(entry, "linux")).join(":");
  // An empty PATH searches the current directory. The null device has no executable children.
  return absolutePath || "/dev/null";
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

type GitChecks<T> = Checks<T>;

const DISCOVERY_TIMEOUT = "Git discovery timed out";

function checkDiscoveryDeadline(deadline: number | undefined): void {
  throwPastDeadline(deadline, DISCOVERY_TIMEOUT);
}

function executableAccessMode(): number {
  return process.platform === "win32" ? constants.F_OK : constants.X_OK;
}

function fileIdentity(stat: BigIntStats): string | null {
  return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") : null;
}

export function executableIdentitySync(path: string): string | null {
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

type GitCandidate = { path: string; version: GitVersion } & (
  | { installer: VerifiedInstallerGit; options: HostGitLaunch["options"] }
  | { installer?: never }
);

type DiscoveredGit = GitCandidate & { identity: string };
type GitAcceptance = (git: DiscoveredGit, deadline?: number) => Promise<boolean>;

export interface GitDiscovery {
  git: DiscoveredGit | null;
  systemTooOld?: { path: string; version: string };
}

function runProbe(path: string, args: string[], options: Parameters<typeof runGitProbeAsync>[2] = {}) {
  return check(() => runGitProbeSync(path, args, options), deadline => runGitProbeAsync(path, args, options, deadline));
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

function* probeInstallerGit(install: InstallerGitInstall): GitChecks<GitCandidate | null> {
  if (performance.now() < retryBundledGitAt) return null;
  let selected: GitCandidate | null = null;
  try {
    const cwd = dirname(install.path);
    const pathEntries = [cwd, join(install.root, install.prefix, "bin"), join(install.root, "usr", "bin")];
    if (pathEntries.some((entry) => entry.includes(";"))) return null;
    const systemDirectory = yield* check(queryWindowsSystemDirectorySync,
      deadline => queryWindowsSystemDirectory(TOOL_TIMEOUT_POLICY.projectGitQueryMs, deadline));
    const systemRoot = win32.dirname(systemDirectory);
    if (systemDirectory.includes(";")) return null;
    const lookupSwitch = process.env.NoDefaultCurrentDirectoryInExePath;
    const options = {
      cwd,
      env: {
        PATH: [...pathEntries, systemDirectory, systemRoot].join(";"),
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ...(lookupSwitch === undefined ? {} : { NoDefaultCurrentDirectoryInExePath: lookupSwitch }),
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
  developerDirectory?: string;
}

const discoveredGit = new Map<string | null, GitScan>();
const pendingDiscoveries = new Map<string | null, Promise<GitDiscovery>>();
// Callers that require extra evidence keep their selection separate from ordinary Git discovery.
const qualifiedDiscoveries = new WeakMap<GitAcceptance, Map<string | null, GitScan>>();

function* isDirectory(path: string): GitChecks<boolean> {
  try {
    return (yield* check(() => statSync(path), () => stat(path))).isDirectory();
  } catch {
    return false;
  }
}

function* acceptsGit(git: DiscoveredGit, accept: GitAcceptance | undefined): GitChecks<boolean> {
  if (accept === undefined) return true;
  const accepted = yield* check(() => { throw new Error("Git qualification requires async discovery"); }, deadline => accept(git, deadline));
  return accepted && (yield* executableIdentity(git.path)) === git.identity;
}

function* selectGit(installerRoot: string | null, cached: GitScan | undefined, failedPath?: string, accept?: GitAcceptance): GitChecks<GitScan> {
  if (cached?.selection.git && (yield* executableIdentity(cached.selection.git.path)) === cached.selection.git.identity
    && (!cached.developerDirectory || (yield* isDirectory(cached.developerDirectory)))) return cached;

  const bundledPath = installerGitPath(installerRoot);
  if (installerRoot !== null && bundledPath !== null && bundledPath !== failedPath) {
    const candidate = yield* probeStableGit(bundledPath, function* () {
      const bundled = yield* findInstallerLayout(installerRoot, bundledPath);
      return bundled ? yield* probeInstallerGit(bundled) : null;
    });
    if (candidate) {
      const git = { ...candidate.result, identity: candidate.identity };
      if (yield* acceptsGit(git, accept)) return { selection: { git } };
    }
  }

  const selection: GitDiscovery = { git: null };
  let shimDirectory: string | undefined;
  // The floor probe checks capability and relies on the host to trust the executable.
  // System candidates come from absolute entries on the host process PATH and well-known locations.
  // Earlier PATH entries already had priority. Floor discovery can now reach later entries when earlier ones fail the floor.
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
    const git = { path, version, identity: candidate.identity };
    if (supported && (yield* acceptsGit(git, accept))) return { selection: { ...selection, git }, developerDirectory };
    if (!meetsMinimumGitVersion(version)) selection.systemTooOld ??= { path, version: version.text };
  }
  return { selection };
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

function finishDiscovery(installerRoot: string | null, cached: GitScan | undefined, result: GitScan, cache = discoveredGit): GitDiscovery {
  // A synchronous caller may have already updated the memo while an async probe was pending.
  if (cache.get(installerRoot) === cached) {
    if (result.selection.git === null) cache.delete(installerRoot);
    else cache.set(installerRoot, result);
  }
  return result.selection;
}

function discoverHostGitSync(installerRoot: string | null): GitDiscovery {
  const cached = discoveredGit.get(installerRoot);
  const result = runChecksSync(selectGit(installerRoot, cached));
  return finishDiscovery(installerRoot, cached, result);
}

function discoverGit(installerRoot: string | null, failedPath?: string, deadline?: number): Promise<GitDiscovery> {
  checkDiscoveryDeadline(deadline);
  const pending = pendingDiscoveries.get(installerRoot);
  if (pending) return pending;
  const cached = discoveredGit.get(installerRoot);
  if (deadline !== undefined) return runChecksAsync(selectGit(installerRoot, cached, failedPath), deadline, DISCOVERY_TIMEOUT)
    .then(result => finishDiscovery(installerRoot, cached, result));
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
  deadline?: number,
  accept?: GitAcceptance,
): Promise<T> {
  let cache = discoveredGit;
  if (accept !== undefined) {
    cache = qualifiedDiscoveries.get(accept) ?? new Map();
    qualifiedDiscoveries.set(accept, cache);
  }
  const discover = (failedPath?: string): Promise<GitDiscovery> => {
    if (accept === undefined) return discoverGit(installerRoot, failedPath, deadline);
    const cached = cache.get(installerRoot);
    return runChecksAsync(selectGit(installerRoot, cached, failedPath, accept), deadline, DISCOVERY_TIMEOUT)
      .then(result => finishDiscovery(installerRoot, cached, result, cache));
  };
  let discovery = await discover();
  for (let attempt = 0; ; attempt++) {
    checkDiscoveryDeadline(deadline);
    try {
      return await use(discovery);
    } catch (error) {
      const { git } = discovery;
      if (!git || !isLaunchFailure(error, git.path)) throw error;
      const ownsSelection = cache.get(installerRoot)?.selection.git === git;
      if (ownsSelection) {
        cache.delete(installerRoot);
        if (accept === undefined) pendingDiscoveries.delete(installerRoot);
      }
      if (attempt === 1) throw error;
      discovery = await discover(ownsSelection ? git.path : undefined);
    }
  }
}

/** Verified calls require a protected installation and prove it without blocking the event loop.
 * Discovery caches a selected executable and checks again after a miss. */
export function resolveHostGit(policy: "verified"): Promise<string | null>;
export function resolveHostGit(policy: { packaged: boolean }): HostGitLaunch | null;
export function resolveHostGit(policy: "verified" | { packaged: boolean }): Promise<string | null> | HostGitLaunch | null {
  if (policy === "verified") {
    const candidates = VERIFIED_GIT_INSTALLATIONS[process.platform];
    return candidates === undefined ? Promise.resolve(null)
      : resolveVerifiedExecutableAsync(candidates).then((verified) => verified?.executable ?? null);
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
