// Discover the user-installed CLI and require a native executable, minimum version, disabled-feature support, and compatible protocol schema. Probe
// startup failure is distinct from an incompatible binary; the minimum version must pass schema and exact-argv initialization checks.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_CLI_MINIMUM_VERSION } from "../shared/codex-subscription.js";
import { meetsMinimumCliVersion } from "../shared/subscription-runtime.js";
import {
  CodexExecutableArtifactError,
  copyCodexExecutableArtifact,
  discardCodexExecutableArtifact,
  verifyCodexExecutableArtifact,
  type CodexExecutableArtifact,
} from "./codex-executable-artifact.js";
import {
  assertCodexExecutableLocation, assertCodexLocations, assertCodexPrivateRuntimeDirectory, CodexExecutableLocationError,
  createPrivateDirectories, createPrivateTempDirectory,
} from "./codex-executable-location.js";
import {
  CODEX_SCHEMA_FILES,
  missingCodexProtocolRequirements,
} from "./codex-protocol-requirements.js";
import {
  CODEX_DISABLED_FEATURES,
  sanitizedCodexConversationEnvironment,
  validateCodexRuntimeDirectory,
} from "./codex-conversation-runtime.js";
import { forceKillManagedChildProcess } from "./managed-child-processes.js";
import {
  cliEnvironmentValue,
  cliExecutableCandidates,
  cliPathApi,
  fullyQualifiedCliPath,
  usableCliDirectory,
  type CliDiscoveryEnvironment,
} from "./user-cli-discovery.js";
import { spawnCodexNative } from "./codex-native-spawn.js";

export type CodexUserRuntimeErrorCode =
  // No `codex` was found.
  | "codex-runtime-not-installed"
  // The first `codex` found is not a native executable Ave can run.
  | "codex-runtime-invalid-executable"
  | "codex-runtime-unsafe-location"
  | "codex-runtime-version-unsupported"
  // The version is new enough but the protocol or features Ave needs are missing.
  | "codex-runtime-incompatible"
  // A probe could not run to completion; says nothing about compatibility.
  | "codex-runtime-start-failed";

export class CodexUserRuntimeError extends Error {
  constructor(
    readonly code: CodexUserRuntimeErrorCode,
    // The version the binary reported, when it got that far.
    readonly version: string | null = null,
    // For `codex-runtime-incompatible`: each missing requirement.
    readonly missing: readonly string[] = [],
  ) {
    super(code);
    this.name = "CodexUserRuntimeError";
  }
}

export interface CodexResolvedRuntime extends CodexExecutableArtifact {
  readonly version: string;
}

const MAX_PATH_LENGTH = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
const LAUNCHER_PACKAGE_NAME = "@openai/codex";

interface PlatformTarget {
  readonly packageName: string;
  readonly targetTriple: string;
}

// The per-platform packages the npm launcher selects, and their vendor triples.
const LAUNCHER_PLATFORM_TARGETS: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, PlatformTarget>>>> = {
  darwin: {
    x64: { packageName: "@openai/codex-darwin-x64", targetTriple: "x86_64-apple-darwin" },
    arm64: { packageName: "@openai/codex-darwin-arm64", targetTriple: "aarch64-apple-darwin" },
  },
  linux: {
    x64: { packageName: "@openai/codex-linux-x64", targetTriple: "x86_64-unknown-linux-musl" },
    arm64: { packageName: "@openai/codex-linux-arm64", targetTriple: "aarch64-unknown-linux-musl" },
  },
  win32: {
    x64: { packageName: "@openai/codex-win32-x64", targetTriple: "x86_64-pc-windows-msvc" },
    arm64: { packageName: "@openai/codex-win32-arm64", targetTriple: "aarch64-pc-windows-msvc" },
  },
};

export type CodexDiscoveryEnvironment = CliDiscoveryEnvironment;

// Search absolute PATH entries before known install locations; desktop launches may omit those locations, and relative entries are untrusted.
export function codexExecutableCandidates(discovery: CodexDiscoveryEnvironment): string[] {
  const { platform, env, homeDir } = discovery;
  const paths = cliPathApi(platform);
  const installLocations: string[] = [];
  const installDir = usableCliDirectory(cliEnvironmentValue(env, "CODEX_INSTALL_DIR", platform), platform);
  if (platform === "win32") {
    if (installDir) installLocations.push(paths.join(installDir, "codex.exe"));
    const localAppData = usableCliDirectory(cliEnvironmentValue(env, "LOCALAPPDATA", platform), platform);
    if (localAppData) installLocations.push(paths.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
    const appData = usableCliDirectory(cliEnvironmentValue(env, "APPDATA", platform), platform);
    if (appData) installLocations.push(paths.join(appData, "npm", "codex.cmd"));
  } else {
    if (installDir) installLocations.push(paths.join(installDir, "codex"));
    const home = usableCliDirectory(homeDir, platform);
    if (home) installLocations.push(paths.join(home, ".local", "bin", "codex"));
    installLocations.push("/opt/homebrew/bin/codex", "/usr/local/bin/codex");
  }
  return cliExecutableCandidates(
    discovery,
    platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"],
    installLocations,
  );
}

// Routing hint only. Full native-format validation happens on the private copy.
function isNativeExecutableHeader(header: Buffer, platform: NodeJS.Platform): boolean {
  if (header.length < 4) return false;
  if (platform === "win32") return header[0] === 0x4d && header[1] === 0x5a;
  if (platform === "darwin") {
    const magic = header.readUInt32BE(0);
    return magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xfeedface
      || magic === 0xcefaedfe || magic === 0xcafebabe || magic === 0xbebafeca
      || magic === 0xcafebabf || magic === 0xbfbafeca;
  }
  return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// The real path of `candidate` when it is a native executable file, else null.
async function nativeExecutableAt(candidate: string, platform: NodeJS.Platform): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(candidate);
    await assertCodexExecutableLocation(candidate, "native");
    const stat = await fs.stat(real);
    if (!stat.isFile()) return null;
    if (!isNativeExecutableHeader(await readHeader(real), platform)) return null;
    if (platform === "win32") {
      if (!real.toLowerCase().endsWith(".exe")) return null;
    } else {
      await fs.access(real, fsConstants.X_OK);
    }
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
  return real;
}

async function isLauncherPackageRoot(root: string): Promise<boolean> {
  try {
    const manifest = join(root, "package.json");
    // This is metadata for native resolution; the launcher script is never run.
    await assertCodexExecutableLocation(manifest, "native");
    const parsed = JSON.parse(await fs.readFile(manifest, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      && (parsed as { name?: unknown }).name === LAUNCHER_PACKAGE_NAME;
  } catch (error) {
    if (isAbsent(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}

// The package root of an npm-installed launcher at `candidate`, if it is one: on POSIX the `bin/codex.js` script the link points at, on Windows the
// `codex.cmd` shim next to `node_modules`.
async function launcherPackageRoot(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const paths = cliPathApi(platform);
  let root: string;
  if (platform === "win32") {
    if (paths.basename(candidate).toLowerCase() !== "codex.cmd") return null;
    root = paths.join(paths.dirname(candidate), "node_modules", "@openai", "codex");
  } else {
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
    if (paths.basename(real) !== "codex.js" || paths.basename(paths.dirname(real)) !== "bin") return null;
    root = paths.dirname(paths.dirname(real));
  }
  return await isLauncherPackageRoot(root) ? root : null;
}

// The native binary an npm launcher would start, found the way the launcher looks for it: the platform package nested in or beside the launcher package,
// or the launcher's own `vendor` directory.
async function launcherNativeExecutable(
  root: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): Promise<string | null> {
  const target = LAUNCHER_PLATFORM_TARGETS[platform]?.[arch];
  if (!target) return null;
  const paths = cliPathApi(platform);
  const executable = platform === "win32" ? "codex.exe" : "codex";
  const packageDir = target.packageName.split("/")[1]!;
  const locations = [
    paths.join(root, "node_modules", "@openai", packageDir),
    paths.join(paths.dirname(root), packageDir),
    root,
  ];
  for (const location of locations) {
    const native = await nativeExecutableAt(
      paths.join(location, "vendor", target.targetTriple, "bin", executable),
      platform,
    );
    if (native) return native;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function invalidExecutable(message?: string): CodexUserRuntimeError {
  const error = new CodexUserRuntimeError("codex-runtime-invalid-executable");
  if (message) error.message = message;
  return error;
}

// Turn one path into the native `codex` binary it stands for. A missing path is `null`; a present path that is neither a native executable nor an npm
// launcher whose native binary is installed is an invalid executable.
export async function resolveCodexNativeExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Promise<string | null> {
  if (
    !candidate || candidate.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(candidate)
    || !fullyQualifiedCliPath(candidate, platform)
  ) {
    throw new CodexUserRuntimeError("codex-runtime-invalid-executable");
  }
  if (!await exists(candidate)) return null;
  try {
    await assertCodexExecutableLocation(candidate, "native");
    const native = await nativeExecutableAt(candidate, platform);
    if (native) return native;
    const root = await launcherPackageRoot(candidate, platform);
    const launched = root ? await launcherNativeExecutable(root, platform, arch) : null;
    if (launched) return launched;
  } catch (error) {
    if (error instanceof CodexExecutableLocationError) throw unsafeLocation(error.message);
    throw error;
  }
  throw new CodexUserRuntimeError("codex-runtime-invalid-executable");
}

const VERSION_PATTERN = /^codex-cli (\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\s*$/m;

// The `x.y.z[-pre]` version in `codex --version` output, or null.
export function parseCodexVersion(output: string): string | null {
  const match = VERSION_PATTERN.exec(output);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ?? ""}`;
}

// Disabled features the CLI's `features list` output does not name.
export function missingCodexFeatures(
  listing: string,
  required: readonly string[] = CODEX_DISABLED_FEATURES,
): string[] {
  const known = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    const name = line.trim().split(/\s+/)[0];
    if (name) known.add(name);
  }
  return required.filter((feature) => !known.has(feature)).map((feature) => `feature ${feature}`);
}

interface CodexProbeResult {
  readonly code: number | null;
  readonly stdout: string;
}

export type CodexProbeRunner = (
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => Promise<CodexProbeResult>;

type SpawnProbe = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

// Run one bounded, shell-free probe command; stderr is discarded, never parsed.
function createCodexProbeRunner(
  spawn: SpawnProbe = (command, args, options) => spawnCodexNative(command, args, options, "codex-probe"),
): CodexProbeRunner {
  return (executable, args, options) => new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const fail = (reason: string) => {
      if (settled) return;
      const termination = forceKillManagedChildProcess(child, `codex probe ${reason}`);
      finish(() => {
        if (termination) void termination.then(() => rejectPromise(new Error(reason)));
        else rejectPromise(new Error(reason));
      });
    };
    const timer = setTimeout(() => fail("timeout"), options.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PROBE_OUTPUT_BYTES) {
        fail("output-limit");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", () => undefined);
    child.on("error", () => fail("spawn"));
    child.once("close", (code) => {
      finish(() => resolvePromise({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
    });
  });
}

export interface CodexUserRuntimeLocatorOptions {
  // Ave's isolated account home; compatibility probes use a separate empty home.
  readonly runtimeHome: string;
  // Existing private runtime child directory, created by the feature namespace.
  readonly runtimeDirectory: string;
  readonly sqliteHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
  readonly run?: CodexProbeRunner;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

// Finds the user's `codex` and qualifies a private copy once per content hash. Changed bytes are probed again; a probe that could not run is not
// remembered, so the next request tries again.
export class CodexUserRuntimeLocator {
  private readonly run: CodexProbeRunner;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly verdicts = new Map<string, Promise<CodexResolvedRuntime>>();
  private readonly artifacts = new Set<CodexExecutableArtifact>();
  private readonly pendingDiscards = new Set<CodexExecutableArtifact>();
  private disposed = false;
  private lastVersion: string | null = null;

  constructor(private readonly options: CodexUserRuntimeLocatorOptions) {
    this.run = options.run ?? createCodexProbeRunner();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
  }

  // The version the last probed binary reported, for the status projection.
  lastKnownVersion(): string | null {
    return this.lastVersion;
  }

  // Resolve, qualify and return the binary Ave should start.
  async resolve(): Promise<CodexResolvedRuntime> {
    if (this.disposed) throw startFailed();
    const executable = await this.locate();
    const artifact = await this.snapshot(executable);
    const identity = `${artifact.contentHash}:${artifact.companion?.contentHash ?? ""}`;
    let verdict = this.verdicts.get(identity);
    if (!verdict) {
      verdict = this.qualify(artifact).catch(async (error: unknown) => {
        let discarded = false;
        try {
          await this.discard(artifact);
          discarded = true;
        } finally {
          if (!discarded || !(error instanceof CodexUserRuntimeError) || error.code === "codex-runtime-start-failed") {
            this.verdicts.delete(identity);
          }
        }
        throw error;
      });
      this.verdicts.set(identity, verdict);
    } else {
      await this.discard(artifact);
    }
    try {
      const resolved = await verdict;
      try {
        await verifyCodexExecutableArtifact(resolved);
      } catch (error) {
        this.verdicts.delete(identity);
        await this.discard(resolved);
        if (error instanceof CodexExecutableLocationError) throw unsafeLocation(error.message);
        if (error instanceof CodexExecutableArtifactError) throw invalidExecutable(error.message);
        throw error;
      }
      if (this.disposed) throw startFailed();
      this.lastVersion = resolved.version;
      return resolved;
    } catch (error) {
      this.lastVersion = error instanceof CodexUserRuntimeError ? error.version : null;
      throw error;
    }
  }

  // Release only this locator's copies after its transports have stopped.
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.verdicts.values());
    this.verdicts.clear();
    await Promise.all([...this.artifacts].map((artifact) => this.discard(artifact)));
  }

  private async discard(artifact: CodexExecutableArtifact): Promise<void> {
    this.pendingDiscards.add(artifact);
    await discardCodexExecutableArtifact(artifact);
    this.artifacts.delete(artifact);
    this.pendingDiscards.delete(artifact);
  }

  private async locate(): Promise<string> {
    for (const candidate of codexExecutableCandidates({ platform: this.platform, env: this.env, homeDir: this.homeDir })) {
      const native = await resolveCodexNativeExecutable(candidate, this.platform, this.arch);
      if (native) return native;
    }
    throw new CodexUserRuntimeError("codex-runtime-not-installed");
  }

  private async snapshot(executable: string): Promise<CodexExecutableArtifact> {
    try {
      if (this.disposed) throw startFailed();
      for (const artifact of this.pendingDiscards) await this.discard(artifact);
      const artifact = await copyCodexExecutableArtifact(executable, this.options.runtimeDirectory, this.platform, this.arch);
      if (this.disposed) {
        await discardCodexExecutableArtifact(artifact);
        throw startFailed();
      }
      this.artifacts.add(artifact);
      return artifact;
    } catch (error) {
      if (error instanceof CodexExecutableLocationError) throw unsafeLocation(error.message);
      if (error instanceof CodexExecutableArtifactError) {
        throw invalidExecutable(error.message);
      }
      throw error;
    }
  }

  private async qualify(artifact: CodexExecutableArtifact): Promise<CodexResolvedRuntime> {
    const workspaceDir = validateCodexRuntimeDirectory(this.options.workspaceDir, startFailed);
    const runtimeTempDir = validateCodexRuntimeDirectory(this.options.runtimeTempDir, startFailed);
    let probeRoot: string;
    try {
      await assertCodexPrivateRuntimeDirectory(runtimeTempDir, "native");
      probeRoot = await createPrivateTempDirectory(join(runtimeTempDir, "probe-"));
    } catch {
      throw startFailed();
    }
    try {
      await assertCodexPrivateRuntimeDirectory(probeRoot, "native");
      const runtimeHome = join(probeRoot, "home");
      const sqliteHome = join(probeRoot, "sqlite");
      const probeTempDir = join(probeRoot, "temp");
      const schemaDir = join(probeRoot, "schema");
      await createPrivateDirectories([runtimeHome, sqliteHome, probeTempDir, schemaDir]);
      await assertCodexLocations([runtimeHome, sqliteHome, probeTempDir, schemaDir].map((path) => ({
        path, kind: "private-directory", routeKind: "native",
      })));
      const env = sanitizedCodexConversationEnvironment(runtimeHome, sqliteHome, probeTempDir, this.env, this.platform);
      const probe = async (args: readonly string[]): Promise<string> => {
        let result: CodexProbeResult;
        try {
          await verifyCodexExecutableArtifact(artifact);
          result = await this.run(artifact.executable, args, { cwd: workspaceDir, env, timeoutMs: PROBE_TIMEOUT_MS });
        } catch (error) {
          if (error instanceof CodexExecutableArtifactError || error instanceof CodexExecutableLocationError) {
            throw invalidExecutable(error.message);
          }
          throw startFailed();
        }
        if (result.code !== 0) throw startFailed();
        return result.stdout;
      };

      const version = parseCodexVersion(await probe(["--version"]));
      if (!version) throw new CodexUserRuntimeError("codex-runtime-invalid-executable");
      if (!meetsMinimumCliVersion(version, CODEX_CLI_MINIMUM_VERSION)) {
        throw new CodexUserRuntimeError("codex-runtime-version-unsupported", version);
      }
      const missing = missingCodexFeatures(await probe(["features", "list"]));

      await probe(["app-server", "generate-json-schema", "--experimental", "--out", schemaDir]);
      const read = async (name: string): Promise<unknown> => {
        try {
          return JSON.parse(await fs.readFile(join(schemaDir, name), "utf8"));
        } catch {
          return null;
        }
      };
      missing.push(...missingCodexProtocolRequirements({
        clientRequest: await read(CODEX_SCHEMA_FILES.clientRequest),
        serverNotification: await read(CODEX_SCHEMA_FILES.serverNotification),
        serverRequest: await read(CODEX_SCHEMA_FILES.serverRequest),
      }));
      if (missing.length > 0) {
        throw new CodexUserRuntimeError("codex-runtime-incompatible", version, Object.freeze(missing));
      }
      return Object.freeze({ ...artifact, version });
    } catch (error) {
      if (error instanceof CodexUserRuntimeError) throw error;
      throw startFailed();
    } finally {
      await fs.rm(probeRoot, { recursive: true, force: true });
    }
  }
}

function startFailed(): CodexUserRuntimeError {
  return new CodexUserRuntimeError("codex-runtime-start-failed");
}

function unsafeLocation(message: string): CodexUserRuntimeError {
  const error = new CodexUserRuntimeError("codex-runtime-unsafe-location");
  error.message = message;
  return error;
}
