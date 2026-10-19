/**
 * Main-process connection manager for the Claude Code CLI the user installed.
 *
 * Ave finds the CLI itself — PATH, then the official install locations — and
 * qualifies it before use: `--version` must identify Claude Code, `--help` must
 * list every option the print invocation passes, and `auth --help` must offer
 * login, logout and status. The user never points Ave at the file.
 *
 * Credentials stay in the official CLI home under an Ave-owned CLAUDE_CONFIG_DIR.
 * This module never reads token files. It only runs the qualified executable for
 * version probes, auth status, browser login, logout, and isolation verification.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import { JsonLineReader } from "../lib/json-line-reader.js";
import { isRecord } from "../shared/is-record.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { claudeCodePrintArgs, claudeCodeRequiredOptions, ClaudeCodeStream } from "./claude-code-stream.js";
import {
  CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID,
  claudeCodeSubscriptionStatus,
  type ClaudeCodeSubscriptionErrorCode,
  type ClaudeCodeSubscriptionStatus,
} from "../shared/claude-code-subscription.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import { writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import {
  cliEnvironmentValue,
  cliExecutableCandidates,
  cliPathApi,
  usableCliDirectory,
  type CliDiscoveryEnvironment,
} from "./user-cli-discovery.js";

const PROBE_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const MAX_EXECUTABLE_PATH_LENGTH = 4_096;
const MAX_VERSION_LENGTH = 80;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type SpawnClaude = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export class ClaudeCodeSubscriptionError extends Error {
  constructor(readonly code: ClaudeCodeSubscriptionErrorCode) {
    super(code);
    this.name = "ClaudeCodeSubscriptionError";
  }
}

export interface ClaudeCodeSubscriptionClientOptions {
  /** Existing app-owned isolated data root for this runtime only. */
  runtimeHome: string;
  /** Existing blank app-owned workspace. Never bind a real project here. */
  workspaceDir: string;
  /** Existing app-owned temporary directory. */
  runtimeTempDir?: string;
  /** Opens a trusted login page only when the CLI prints one. */
  openExternal?: (url: string) => Promise<void> | void;
  /** Test seam; production uses the managed-child registry. */
  spawn?: SpawnClaude;
  /** Test seam for filesystem-based executable validation. */
  resolveExecutable?: (candidate: string) => Promise<string>;
  platform?: NodeJS.Platform;
  /** Discovery inputs; production reads the process environment and home. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Test seam: where to look, most specific first. Production uses {@link claudeCodeExecutableCandidates}. */
  candidates?: () => readonly string[];
}

/** A found CLI that passed qualification, bound to the bytes it was probed on. */
interface QualifiedClaudeCode {
  readonly executable: string;
  readonly identity: string;
  readonly version: string;
}

interface PendingLogin {
  child: ChildProcess;
  timer: NodeJS.Timeout;
}

interface AuthStatusPayload {
  loggedIn: boolean;
}

export async function validateClaudeCodeRuntimeDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    try {
      if (!isAbsolute(directory) || CONTROL_CHARACTERS.test(directory)) throw new Error("invalid-directory");
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid-directory");
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable");
    }
  }
}

function configuredStatus(): ClaudeCodeSubscriptionStatus {
  return claudeCodeSubscriptionStatus("not-configured", "unknown");
}

function unavailableStatus(): ClaudeCodeSubscriptionStatus {
  return claudeCodeSubscriptionStatus("unavailable", "unknown");
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function blocksInheritedEnvironment(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith("ANTHROPIC_")
    || normalized.startsWith("CLAUDE_")
    || normalized.startsWith("OPENAI_")
    || normalized.startsWith("COPILOT_")
    || normalized.startsWith("CODEX_")
    || normalized.startsWith("OTEL_")
    || normalized.startsWith("GH_")
    || normalized.startsWith("GITHUB_")
    || normalized.startsWith("NODE_")
    || normalized.startsWith("NPM_")
    || normalized.startsWith("BUN_")
    || normalized === "HTTP_PROXY"
    || normalized === "HTTPS_PROXY"
    || normalized === "ALL_PROXY"
    || normalized === "NO_PROXY"
    || normalized === "SSL_CERT_FILE"
    || normalized === "SSL_CERT_DIR"
    || normalized === "SSLKEYLOGFILE"
    || normalized.startsWith("LD_")
    || normalized.startsWith("DYLD_");
}

const SAFE_INHERITED_ENV_NAMES = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
]);

function normalizedRuntimeDirectory(candidate: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.normalize(candidate) : resolve(candidate);
}

function unsafeWindowsPath(path: string): boolean {
  return path.startsWith("\\") || path.startsWith("\\?\\") || path.startsWith("\\.\\");
}

export async function resolveClaudeCodeSubscriptionExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const absolute = platform === "win32" ? win32.isAbsolute(candidate) : isAbsolute(candidate);
  if (
    !candidate
    || candidate.length > MAX_EXECUTABLE_PATH_LENGTH
    || CONTROL_CHARACTERS.test(candidate)
    || !absolute
    || (platform === "win32" && unsafeWindowsPath(candidate))
  ) {
    throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
  }
  try {
    const executable = await fs.realpath(candidate);
    const stat = await fs.stat(executable);
    if (!stat.isFile()) throw new Error("not-a-file");
    if (platform === "win32") {
      if (unsafeWindowsPath(executable) || !executable.toLocaleLowerCase().endsWith(".exe")) {
        throw new Error("not-a-native-windows-executable");
      }
    } else {
      await fs.access(executable, fsConstants.X_OK);
    }
    return executable;
  } catch {
    throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
  }
}

/**
 * Where a `claude` the user installed can be, most specific first: every
 * absolute PATH entry, then the official install locations — the native
 * installer's `~/.local/bin`, and the global `bin` directories Homebrew and
 * Linux packages (and an npm prefix in one of them) link into. An npm prefix
 * elsewhere is found only through PATH. On Windows only the native
 * `claude.exe` qualifies, so only `.exe` candidates are listed.
 */
export function claudeCodeExecutableCandidates(discovery: CliDiscoveryEnvironment): string[] {
  const { platform, env, homeDir } = discovery;
  const paths = cliPathApi(platform);
  const installLocations: string[] = [];
  if (platform === "win32") {
    const profile = usableCliDirectory(cliEnvironmentValue(env, "USERPROFILE", platform), platform)
      ?? usableCliDirectory(homeDir, platform);
    if (profile) installLocations.push(paths.join(profile, ".local", "bin", "claude.exe"));
  } else {
    const home = usableCliDirectory(homeDir, platform);
    if (home) installLocations.push(paths.join(home, ".local", "bin", "claude"));
    installLocations.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude");
  }
  return cliExecutableCandidates(discovery, platform === "win32" ? ["claude.exe"] : ["claude"], installLocations);
}

const CLAUDE_CODE_VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?) \(Claude Code\)\s*$/m;

/** The version `claude --version` reports, or null when the output is not Claude Code's. */
export function parseClaudeCodeVersion(output: string): string | null {
  const version = CLAUDE_CODE_VERSION_PATTERN.exec(output)?.[1] ?? null;
  return version && version.length <= MAX_VERSION_LENGTH ? version : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each required option `claude --help` does not list. */
export function missingClaudeCodeOptions(help: string): string[] {
  return claudeCodeRequiredOptions().filter((option) =>
    !new RegExp(`^\\s{2}(?:\\S+, )*${escapeRegExp(option)}(?=[\\s,<\\[=]|$)`, "m").test(help));
}

/** Each auth subcommand `claude auth --help` does not list. */
export function missingClaudeCodeAuthCommands(help: string): string[] {
  return ["login", "logout", "status"].filter((command) =>
    !new RegExp(`^\\s{2}${command}(?=\\s|$)`, "m").test(help));
}

export function sanitizedClaudeCodeEnvironment(
  runtimeHome: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runtimeTempDir = join(runtimeHome, "tmp"),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!value || blocksInheritedEnvironment(key)) continue;
    if (SAFE_INHERITED_ENV_NAMES.has(key) || SAFE_INHERITED_ENV_NAMES.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  const isolatedHome = normalizedRuntimeDirectory(runtimeHome, platform);
  const isolatedTemp = normalizedRuntimeDirectory(runtimeTempDir, platform);
  if (platform === "win32") {
    env.USERPROFILE = isolatedHome;
    env.HOME = isolatedHome;
    env.APPDATA = win32.join(isolatedHome, "appdata");
    env.LOCALAPPDATA = win32.join(isolatedHome, "localappdata");
  } else {
    env.HOME = isolatedHome;
    env.XDG_CONFIG_HOME = join(isolatedHome, "config");
    env.XDG_DATA_HOME = join(isolatedHome, "data");
    env.XDG_CACHE_HOME = join(isolatedHome, "cache");
  }
  env.TEMP = isolatedTemp;
  env.TMP = isolatedTemp;
  env.TMPDIR = isolatedTemp;
  // The official CLI stores auth and session transcripts under this directory.
  env.CLAUDE_CONFIG_DIR = isolatedHome;
  // The host supplies the complete MCP catalog and owns tool discovery.
  env.ENABLE_TOOL_SEARCH = "false";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

function spawnClaudeCode(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): ChildProcess {
  return spawnManaged(command, args, options, { label: "claude-code-subscription" });
}

export class ClaudeCodeSubscriptionClient {
  private readonly runtimeHome: string;
  private readonly workspaceDir: string;
  private readonly runtimeTempDir: string;
  private readonly openExternal: ((url: string) => Promise<void> | void) | null;
  private readonly spawn: SpawnClaude;
  private readonly resolveExecutable: (candidate: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly candidates: () => readonly string[];
  /** The CLI the last discovery found and qualified, or null when none was found. */
  private found: QualifiedClaudeCode | null = null;
  /** Qualification verdicts by executable identity; a probe that could not run is not remembered. */
  private readonly qualifications = new Map<string, Promise<QualifiedClaudeCode>>();
  private pendingLogin: PendingLogin | null = null;
  /** The version the last probed CLI reported, kept when it failed qualification. */
  private lastVersion: string | null = null;
  /** The last status read, for an error response that still has to describe the card. */
  private lastStatus: ClaudeCodeSubscriptionStatus = configuredStatus();
  private verifiedVersion: string | null = null;
  /** The identity `verify()` proved; a different binary must be verified again. */
  private verifiedIdentity: string | null = null;
  private stopped = false;
  private epoch = 0;
  private loginStarting = false;
  private readonly commands = new Set<() => void>();

  constructor(options: ClaudeCodeSubscriptionClientOptions) {
    this.runtimeHome = options.runtimeHome;
    this.workspaceDir = options.workspaceDir;
    this.runtimeTempDir = options.runtimeTempDir ?? join(options.runtimeHome, "tmp");
    this.openExternal = options.openExternal ?? null;
    this.spawn = options.spawn ?? spawnClaudeCode;
    this.resolveExecutable = options.resolveExecutable
      ?? ((candidate) => resolveClaudeCodeSubscriptionExecutable(candidate, options.platform));
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.candidates = options.candidates ?? (() => claudeCodeExecutableCandidates({
      platform: this.platform, env: this.env, homeDir: this.homeDir,
    }));
  }

  /**
   * The executable a chat session starts: the CLI found now, and only while it
   * is the same file `verify()` proved. An update or reinstall in between is a
   * different binary and has to be verified again.
   */
  async verifiedExecutable(): Promise<string> {
    const found = await this.locate();
    if (!found) throw new ClaudeCodeSubscriptionError("claude-code-runtime-not-configured");
    if (this.verifiedIdentity !== found.identity) {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-unverified");
    }
    return found.executable;
  }

  getRuntimePaths(): {
    readonly runtimeHome: string;
    readonly workspaceDir: string;
    readonly runtimeTempDir: string;
  } {
    return Object.freeze({
      runtimeHome: this.runtimeHome,
      workspaceDir: this.workspaceDir,
      runtimeTempDir: this.runtimeTempDir,
    });
  }

  /**
   * Discovery runs on every status read, so "check again" after installing or
   * updating the CLI is a status read. A found CLI that fails qualification
   * throws `claude-code-runtime-incompatible`; none found is `not-configured`.
   */
  async getStatus(): Promise<ClaudeCodeSubscriptionStatus> {
    if (this.pendingLogin) {
      return claudeCodeSubscriptionStatus("ready", "pending", this.verifiedVersion ?? this.found?.version ?? null, "browser");
    }
    let found: QualifiedClaudeCode | null;
    try {
      found = await this.locate();
    } catch (error) {
      // The card still has to say which CLI it found while it reports the error.
      this.lastStatus = claudeCodeSubscriptionStatus("unavailable", "unknown", this.lastVersion);
      throw error;
    }
    if (!found) return this.remember(configuredStatus());
    try {
      const auth = await this.readAuthStatus();
      return this.remember(claudeCodeSubscriptionStatus(
        this.verifiedVersion ? "ready" : "unverified",
        auth.loggedIn === true ? "connected" : "signed-out",
        this.verifiedVersion ?? found.version,
      ));
    } catch {
      return this.remember(unavailableStatus());
    }
  }

  /** The last status read, without running anything. */
  getCachedStatus(): ClaudeCodeSubscriptionStatus {
    return this.lastStatus;
  }

  private remember(status: ClaudeCodeSubscriptionStatus): ClaudeCodeSubscriptionStatus {
    this.lastStatus = status;
    return status;
  }

  async verify(): Promise<ClaudeCodeSubscriptionStatus> {
    const found = await this.locate();
    if (!found) throw new ClaudeCodeSubscriptionError("claude-code-runtime-not-configured");
    const epoch = this.epoch;
    const executable = this.requireExecutable();
    this.verifiedVersion = null;
    this.verifiedIdentity = null;
    const auth = await this.readAuthStatus();
    if (auth.loggedIn !== true) {
      this.assertCurrent(epoch);
      this.assertStillFound(found);
      this.verifiedVersion = found.version;
      this.verifiedIdentity = found.identity;
      return this.remember(claudeCodeSubscriptionStatus("ready", "signed-out", found.version));
    }
    await this.probePrint(executable);
    this.assertCurrent(epoch);
    this.assertStillFound(found);
    this.verifiedVersion = found.version;
    this.verifiedIdentity = found.identity;
    return this.remember(claudeCodeSubscriptionStatus("ready", "connected", found.version));
  }

  async startBrowserLogin(): Promise<ClaudeCodeSubscriptionStatus> {
    await this.locate();
    const executable = this.requireExecutable();
    if (this.pendingLogin || this.loginStarting) {
      throw new ClaudeCodeSubscriptionError("claude-code-login-in-progress");
    }
    const epoch = this.epoch;
    this.loginStarting = true;
    try {
      await this.prepareExecutable(executable, epoch);
      const child = this.spawn(executable, ["auth", "login"], {
        cwd: this.workspaceDir,
        env: sanitizedClaudeCodeEnvironment(this.runtimeHome, process.env, this.platform, this.runtimeTempDir),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
      });
      const timer = setTimeout(() => {
        void this.cancelLoginQuietly();
      }, LOGIN_TIMEOUT_MS);
      this.pendingLogin = { child, timer };
      timer.unref();
      child.once("close", () => {
        if (this.pendingLogin?.child === child) {
          clearTimeout(this.pendingLogin.timer);
          this.pendingLogin = null;
        }
        forceKillManagedChildProcess(child, "claude-code-login-complete");
      });
      const failLogin = () => { if (this.pendingLogin?.child === child) void this.cancelLoginQuietly(); };
      child.on("error", failLogin);
      child.stdout?.on("error", failLogin);
      child.stderr?.on("error", failLogin);
      // Drain output without retaining secrets or URLs beyond a short trusted open.
      this.watchLoginOutput(child);
      if (!child.stdout || !child.stderr) {
        await this.cancelLoginQuietly();
        throw new ClaudeCodeSubscriptionError("claude-code-login-failed");
      }
      return this.remember(claudeCodeSubscriptionStatus("ready", "pending", this.verifiedVersion ?? this.found?.version ?? null, "browser"));
    } finally { this.loginStarting = false; }
  }

  async cancelLogin(): Promise<ClaudeCodeSubscriptionStatus> {
    await this.invalidateCommands();
    return this.getStatus();
  }

  async logout(): Promise<ClaudeCodeSubscriptionStatus> {
    await this.locate();
    const executable = this.requireExecutable();
    await this.invalidateCommands();
    await this.runCaptured(executable, ["auth", "logout"], PROBE_TIMEOUT_MS);
    this.verifiedVersion = null;
    return this.remember(claudeCodeSubscriptionStatus("unverified", "signed-out", this.found?.version ?? null));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.invalidateCommands();
  }

  private async invalidateCommands(): Promise<void> {
    this.epoch += 1;
    this.verifiedVersion = null;
    this.verifiedIdentity = null;
    for (const cancel of this.commands) cancel();
    await this.cancelLoginQuietly();
  }

  private assertCurrent(epoch: number): void {
    if (this.stopped || this.epoch !== epoch) throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
  }

  private async prepareExecutable(executable: string, epoch: number): Promise<void> {
    await validateClaudeCodeRuntimeDirectories([this.runtimeHome, this.workspaceDir, this.runtimeTempDir]);
    if (await this.resolveExecutable(executable) !== executable) {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
    }
    this.assertCurrent(epoch);
  }

  private requireExecutable(): string {
    this.assertCurrent(this.epoch);
    if (!this.found) {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-not-configured");
    }
    return this.found.executable;
  }

  /**
   * Find the CLI and qualify it. The first candidate that exists decides: an
   * unusable one is reported, never skipped for the next, so Ave does not run
   * a different `claude` than the user's own shell would.
   */
  private async locate(): Promise<QualifiedClaudeCode | null> {
    this.assertCurrent(this.epoch);
    let executable: string | null = null;
    for (const candidate of this.candidates()) {
      try {
        await fs.lstat(candidate);
      } catch (error) {
        if (isAbsent(error)) continue;
        throw new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable");
      }
      // Like a shell, pass over an entry that is not a runnable file — a
      // dangling link left by an old install, a directory, a file without the
      // execute bit — and keep looking. A runnable file decides.
      try {
        executable = await this.resolveExecutable(candidate);
      } catch (error) {
        if (error instanceof ClaudeCodeSubscriptionError && error.code === "claude-code-runtime-invalid-executable") continue;
        throw error;
      }
      break;
    }
    if (!executable) {
      this.lastVersion = null;
      this.adopt(null);
      return null;
    }
    let identity: string;
    try {
      const stat = await fs.stat(executable);
      identity = `${executable}\n${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
    }
    let verdict = this.qualifications.get(identity);
    if (!verdict) {
      verdict = this.qualify(executable, identity);
      this.qualifications.set(identity, verdict);
      verdict.catch((error: unknown) => {
        // Only an answer about the binary is a verdict; a probe that could not
        // run says nothing and is asked again next time.
        if (!(error instanceof ClaudeCodeSubscriptionError && error.code === "claude-code-runtime-incompatible")) {
          this.qualifications.delete(identity);
        }
      });
    }
    try {
      const qualified = await verdict;
      this.adopt(qualified);
      return qualified;
    } catch (error) {
      this.adopt(null);
      throw error;
    }
  }

  /** A discovery in between may have adopted another binary; a proof must name the one it ran on. */
  private assertStillFound(found: QualifiedClaudeCode): void {
    if (this.found?.identity !== found.identity) {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    }
  }

  private adopt(found: QualifiedClaudeCode | null): void {
    if (this.found?.identity !== found?.identity) {
      this.verifiedVersion = null;
      this.verifiedIdentity = null;
    }
    this.found = found;
  }

  private async qualify(executable: string, identity: string): Promise<QualifiedClaudeCode> {
    const incompatible = () => new ClaudeCodeSubscriptionError("claude-code-runtime-incompatible");
    // A probe that ran and exited non-zero is an answer about the binary (an
    // old CLI without `auth`, a different program named `claude`); one that
    // could not run, timed out or was cancelled rejects instead and is retried.
    const probe = async (args: readonly string[]): Promise<string> => {
      const output = await this.runCaptured(executable, args, PROBE_TIMEOUT_MS, { anyExitCode: true });
      if (output.code !== 0) throw incompatible();
      return output.stdout;
    };
    this.lastVersion = null;
    const version = parseClaudeCodeVersion(await probe(["--version"]));
    this.lastVersion = version;
    if (!version) throw incompatible();
    const help = await probe(["--help"]);
    const authHelp = await probe(["auth", "--help"]);
    if (missingClaudeCodeOptions(help).length > 0 || missingClaudeCodeAuthCommands(authHelp).length > 0) {
      throw incompatible();
    }
    return Object.freeze({ executable, identity, version });
  }

  private async cancelLoginQuietly(): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    this.pendingLogin = null;
    clearTimeout(pending.timer);
    try {
      forceKillManagedChildProcess(pending.child, "claude-code-login-cancel");
    } catch {
      // Best-effort cancellation only.
    }
  }

  private watchLoginOutput(child: ChildProcess): void {
    let opened = false;
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      stream?.on("data", (chunk: Buffer | string) => {
        if (this.pendingLogin?.child !== child) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) { void this.cancelLoginQuietly(); return; }
        if (opened) return;
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        // Wait for a delimiter: a split URL must never open a partial address.
        if (!this.openExternal) return;
        for (const match of buffer.matchAll(/https:\/\/[^\s"'\u001b]+(?=[\s"'\u001b])/gi)) {
          let url: URL;
          try { url = new URL(match[0]); } catch { continue; }
          if (url.protocol !== "https:" || url.username || url.password || url.port
            || !["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname.toLowerCase())) continue;
          opened = true;
          void Promise.resolve().then(() => {
            if (this.pendingLogin?.child === child) return this.openExternal?.(url.toString());
          }).catch(() => undefined);
          break;
        }
      });
    }
  }

  private async readAuthStatus(): Promise<AuthStatusPayload> {
    const executable = this.requireExecutable();
    const output = await this.runCaptured(executable, ["auth", "status"], PROBE_TIMEOUT_MS, { acceptedCodes: [0, 1] });
    try {
      const parsed: unknown = JSON.parse(output.stdout);
      if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean"
        || output.code !== (parsed.loggedIn ? 0 : 1)) throw new Error("invalid-auth-status");
      if (parsed.loggedIn && (parsed.authMethod !== "claude.ai" || parsed.apiProvider !== "firstParty"
        || typeof parsed.subscriptionType !== "string" || !parsed.subscriptionType.trim())) {
        throw new Error("subscription-auth-required");
      }
      return { loggedIn: parsed.loggedIn };
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    }
  }

  private async probePrint(executable: string): Promise<void> {
    const path = join(this.runtimeTempDir, `verify-${randomUUID()}.json`);
    await validateClaudeCodeRuntimeDirectories([this.runtimeTempDir]);
    try {
      await writeFileAtomicAtPath(path, `${JSON.stringify({ mcpServers: {} })}\n`);
      const output = await this.runCaptured(executable, claudeCodePrintArgs(path, []),
        TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs, { input: "Reply with exactly: AVE_OK" });
      const stream = new ClaudeCodeStream([]);
      let malformed = false;
      const reader = new JsonLineReader({
        maxLineBytes: MAX_OUTPUT_BYTES,
        onMessage: (event) => { stream.accept(event); },
        onError: () => { malformed = true; },
      });
      reader.write(output.stdout);
      reader.write("\n");
      reader.close();
      if (malformed) throw new Error("invalid-print-stream");
      stream.assertComplete();
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    } finally {
      await fs.rm(path, { force: true });
    }
  }

  private async runCaptured(
    executable: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    options: { input?: string; acceptedCodes?: readonly number[]; anyExitCode?: boolean } = {},
  ): Promise<{ stdout: string; code: number }> {
    const epoch = this.epoch;
    await this.prepareExecutable(executable, epoch);
    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let outputBytes = 0;
      let stdout = "";
      const stdoutDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const child = this.spawn(executable, args, {
        cwd: this.workspaceDir,
        env: sanitizedClaudeCodeEnvironment(this.runtimeHome, process.env, this.platform, this.runtimeTempDir),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
      });
      const timer = setTimeout(() => cancel(), timeoutMs);
      timer.unref();
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.commands.delete(cancel);
        callback();
      };
      const cancel = (code: ClaudeCodeSubscriptionErrorCode = "claude-code-operation-failed"): void => {
        if (settled) return;
        finish(() => rejectPromise(new ClaudeCodeSubscriptionError(code)));
        forceKillManagedChildProcess(child, "claude-code-command-cancel");
      };
      this.commands.add(cancel);
      const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          cancel();
          return;
        }
        // Never retain stderr or use it as a replacement protocol response.
        try {
          if (target === "stdout") stdout += typeof chunk === "string"
            ? chunk : stdoutDecoder.decode(chunk, { stream: true });
        } catch { cancel(); }
      };
      child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      child.on("error", () => cancel("claude-code-runtime-unavailable"));
      child.stdout?.on("error", () => cancel());
      child.stderr?.on("error", () => cancel());
      child.stdin?.on("error", () => cancel());
      child.once("close", (code, signal) => {
        if (settled) return;
        try {
          stdout += stdoutDecoder.decode();
          this.assertCurrent(epoch);
          if (signal || code === null || (!options.anyExitCode && !(options.acceptedCodes ?? [0]).includes(code))) {
            throw new Error("invalid-command-result");
          }
          finish(() => resolvePromise({ stdout, code }));
          forceKillManagedChildProcess(child, "claude-code-command-complete");
        } catch { cancel(); }
      });
      if (!child.stdout || !child.stderr || (options.input !== undefined && !child.stdin)) { cancel(); return; }
      if (options.input !== undefined) child.stdin!.end(options.input, (error?: Error | null) => { if (error) cancel(); });
    });
  }
}

export function claudeCodeRuntimeDirectoryNames(): {
  readonly runtimeHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
} {
  const prefix = `claude-cli-v1-${CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID}`;
  return Object.freeze({
    runtimeHome: `${prefix}-home`,
    workspaceDir: `${prefix}-workspace`,
    runtimeTempDir: `${prefix}-tmp`,
  });
}
