/**
 * Permission policy — Layer 6 hook script runner.
 *
 * Public contract: docs/guides/user-hooks.md. Legacy scripts and declarative
 * command handlers share this runner, safe environment, output capture and
 * managed process lifetime. A successful command may be silent or return a
 * supported decision. Exit 2 uses stderr as denial feedback; other failures
 * remain fail-closed for blocking events.
 *
 * Production user commands pass host shell admission before spawning and use
 * the active OS sandbox policy. Generic argv never passes through an implicit
 * shell; legacy scripts retain the resolved interpreter path. DLP is applied
 * by the manager before serialization. A hook cannot upgrade an upstream deny.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import {
  resolveShell,
  shellEnvForChild,
  shellCommandForHookPath,
  shellQuote,
  ShellMismatchError,
} from "../lib/shell-resolver.js";
import { createLogger } from "../lib/logger.js";
import {
  assertManagedChildProcessAdmissionOpen,
  forceKillManagedChildProcess,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_STDOUT_BYTES,
  type HookEvent,
  type ScriptHookInvocationResult,
  type ScriptHookStdin,
  type ScriptHookStdout,
} from "./script-hook-types.js";
import { defaultHooksDir, type DiscoveredHook } from "./hook-discovery.js";
import type { PluginHookOwner } from "./hook-registry.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { hookEventName, hookJsonInput } from "./hook-contract.js";
import { isRecord } from "../shared/is-record.js";
import type { HookCommandAuthorizer } from "./hook-command-policy.js";
import { MAX_TIMER_DELAY_MS } from "../shared/tool-timeout-policy.js";
import { resolveScriptAnchor } from "./hook-config-trust.js";
import { resolve } from "node:path";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";
import { getHostShellExecutionPlan, getIssuedHostShellExecutionPlanGeneration, getSandboxGeneration, isIssuedHostShellExecutionPlan } from "../permissions/sandbox-capability.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive } from "../permissions/asrt-sandbox.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
import type { EgressInvocation, WorkerEgressOwner } from "../permissions/egress-invocations.js";
import {
  bundledWrappedEnv,
  spawnWindowsBundledProcess,
  wrapBundledCommand,
  type WindowsBundledSpawn,
} from "../sandbox/wrap-bundled-command.js";

const log = createLogger("hook-runner");

export interface RunOneHookOptions {
  /** Per-hook timeout in ms. Defaults to {@link DEFAULT_HOOK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Working directory for the spawned hook. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Host-owned admission for a trusted user command; enrollment is not permission. */
  authorizeCommand?: HookCommandAuthorizer;
}

/**
 * The minimal shape the runner needs to execute one hook handler. Both a
 * legacy `.sh` `DiscoveredHook` and a declarative `hooks.json` `command`
 * handler normalize into this (see `hook-registry.ts`). Decoupling the runner
 * from `DiscoveredHook` is what lets a generic `command` argv run through the
 * SAME fail-closed / env-allowlist / timeout machinery as a `.sh` file.
 */
export interface RunnableHook {
  /** Stable identity for audit / logs (registry id or `.sh` fileName). */
  id: string;
  /** Closed-set internal event (tool-use pre|post|perm OR a lifecycle event). */
  hookType: HookEvent;
  /**
   * argv to execute. A single-element argv ending in `.sh` is the legacy path
   * (runs through the resolved shell for Windows interpreter resolution);
   * anything else is spawned directly with NO shell (argv[0] = program).
   */
  command: string[];
  env?: Record<string, string>;
  /** Optional matcher — surfaced to the hook via `AVE_HOOK_MATCHER`. */
  matcher?: string;
  /** Path for audit/forensics — `.sh` abs path, or the resolved script arg. */
  hookPath: string;
  /**
   * Optional per-hook timeout (ms). Config entries carry their own clamped
   * budget here; when set it takes precedence over `RunOneHookOptions.timeoutMs`
   * so each hook in a mixed chain runs on its own ceiling. `.sh` hooks leave it
   * unset and fall back to the option / default.
   */
  timeoutMs?: number;
  /**
   * Origin discriminant — `.sh` legacy hook vs declarative `hooks.json`
   * `command` entry. Carried through onto every {@link ScriptHookInvocationResult}
   * so the audit layer can tell config-hook vs `.sh`-hook denials apart.
   * Defaults to `"sh"` for the legacy adapter.
   */
  source?: "sh" | "config";
  /**
   * Trust identity of the executed code — the resolved local-script sha256 for a
   * `.sh` hook, or a sha256 of the verbatim command argv for a generic command.
   * The runner falls back to hashing `command` when this is absent so the result
   * always carries a forensic anchor.
   */
  commandIdentity?: string;
  pluginOwner?: PluginHookOwner;
  confinement?: { kind: "bundled"; pluginId: string; dataDir: string; generationRoot: string };
}

/** sha256 (hex) of a verbatim command argv — the forensic anchor for a generic
 * `command` hook that has no on-disk local-script sha. */
function hashCommandArgv(command: string[]): string {
  return sha256Hex(command.join("\0"));
}

/** Adapt a legacy `DiscoveredHook` to the {@link RunnableHook} shape. */
export function runnableFromDiscovered(hook: DiscoveredHook): RunnableHook {
  return {
    id: hook.fileName,
    hookType: hook.hookType,
    command: [hook.path],
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    hookPath: hook.path,
    source: "sh",
    // The `.sh` file IS the trusted local script — its content sha256 is the
    // canonical command identity.
    commandIdentity: hook.sha256,
  };
}

/**
 * Is this a single legacy `.sh` file that must run through the resolved shell
 * (so Windows Git-Bash / WSL can pick the right interpreter)? Only a
 * single-element argv whose lone token ends in `.sh` qualifies — a generic
 * `command` (even `sh ./x.sh` or `python3 p.py`) is spawned directly.
 */
function isLegacyShellScript(command: string[]): boolean {
  return command.length === 1 && command[0].toLowerCase().endsWith(".sh");
}

/**
 * Build the injected hook env. PRESERVES the existing `AVE_HOOK_*` set and
 * ADDS `AVE_HOOK_EVENT` / `AVE_HOOK_MATCHER` (#811 §6.2). No secret vars are
 * ever added here — `buildSafeChildEnv` is the only env the child sees.
 */
function buildHookEnv(payload: ScriptHookStdin, matcher: string | undefined): Record<string, string> {
  // `event` is the closed-set surface (lifecycle events carry it explicitly;
  // tool-use shapes leave it undefined → fall back to `hookType`).
  const event = payload.event ?? payload.hookType;
  return {
    AVE_HOOK_TYPE: payload.hookType,
    // #811 — `AVE_HOOK_EVENT` is the closed-set event (alias of TYPE for the
    // generic-command surface; the lifecycle event for lifecycle dispatches);
    // `AVE_HOOK_MATCHER` exposes the configured matcher.
    AVE_HOOK_EVENT: event,
    ...(matcher !== undefined ? { AVE_HOOK_MATCHER: matcher } : {}),
    // `toolName` is present on tool-use + PostToolUseFailure/PermissionDenied
    // lifecycle payloads; absent on session-only lifecycle events.
    ...(payload.toolName !== undefined ? { AVE_HOOK_TOOL_NAME: payload.toolName } : {}),
    // sessionId is on every shape — lifecycle hooks key their policy on it.
    AVE_HOOK_SESSION_ID: payload.sessionId,
    AVE_HOOK_TRUST_ORIGIN: payload.trustOrigin,
    // Per-request MCP-aligned origin (#811 hooks-on-mcp-calls): a hook can deny
    // by the SPECIFIC server/plugin via env (the convenient path, alongside the
    // full stdin JSON). Only present on the tool-use shape.
    ...("mcpServerId" in payload && payload.mcpServerId !== undefined ? { AVE_HOOK_MCP_SERVER_ID: payload.mcpServerId } : {}),
    ...("pluginId" in payload && payload.pluginId !== undefined ? { AVE_HOOK_PLUGIN_ID: payload.pluginId } : {}),
  };
}

/**
 * Run a single hook handler. Pipes the canonical stdin payload, captures
 * stdout (capped), enforces the timeout, and parses the verdict.
 *
 * Accepts either a legacy `DiscoveredHook` (back-compat) or a normalized
 * {@link RunnableHook} (declarative `command` handler). Exit code !=0,
 * malformed stdout, timeout, or spawn error collapse to `decision: "deny"`.
 * Observe-only callers retain the result without changing control flow.
 */
export async function runOneHookScript(
  hook: DiscoveredHook | RunnableHook,
  payload: ScriptHookStdin,
  options: RunOneHookOptions = {},
): Promise<ScriptHookInvocationResult> {
  const normalized = normalizeRunnable(hook);
  // Seal the same expanded argv across asynchronous approval and actual spawn.
  const runnable = { ...normalized, command: normalized.command.map(expandLeadingTilde),
    timeoutMs: normalized.timeoutMs ?? options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    ...(normalized.env ? { env: { ...normalized.env } } : {}) };
  Object.freeze(runnable.command);
  if (runnable.env) Object.freeze(runnable.env);
  Object.freeze(runnable);
  // Per-hook timeout precedence: the runnable's own (clamped) budget wins, then
  // the caller-supplied option, then the default. This lets a mixed chain run
  // each config entry on its own ceiling.
  const timeoutMs = runnable.timeoutMs ?? options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const confinement = runnable.confinement;
  const cwd = confinement?.generationRoot ?? options.cwd ?? process.cwd();
  const start = Date.now();

  // Forensic anchors carried onto EVERY result this invocation produces. `source`
  // discriminates `.sh` vs config; `commandIdentity` is the local-script sha (sh)
  // or a hash of the verbatim argv (config). These let the audit layer tell
  // config-hook from `.sh`-hook denials apart.
  const forensics = {
    hookPath: runnable.hookPath,
    hookType: runnable.hookType,
    source: runnable.source ?? "sh",
    commandIdentity: normalized.commandIdentity ?? hashCommandArgv(normalized.command),
    ...(runnable.pluginOwner ? { pluginOwner: runnable.pluginOwner } : {}),
  } as const;

  const deny = (reason: string, extra: Partial<ScriptHookInvocationResult> = {}): ScriptHookInvocationResult => ({
    ...forensics,
    decision: "deny",
    reason,
    rawStdout: "",
    timedOut: false,
    durationMs: Date.now() - start,
    ...extra,
  });

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    return deny("hook timeout must be a positive supported timer delay");
  }
  if (runnable.hookType !== payload.hookType || (payload.event !== undefined && payload.event !== payload.hookType)) {
    return deny("hook event does not match its input");
  }
  let stdinJson: string;
  try {
    stdinJson = JSON.stringify(hookJsonInput(payload, cwd)) + "\n";
  } catch (error) {
    return deny(`failed to serialise hook payload: ${(error as Error).message}`);
  }

  const hookEnv = buildHookEnv(payload, runnable.matcher);
  let admittedPlan: HostShellExecutionPlan | undefined;
  let assertCommandAllowed: (() => void) | undefined;
  if (!confinement && options.authorizeCommand) {
    try {
      const admission = await options.authorizeCommand(runnable, payload, cwd);
      if (admission.decision !== "allow") return deny(`hook command denied: ${admission.reason}`);
      admittedPlan = admission.plan;
      assertCommandAllowed = admission.assertAllowed;
      if (admittedPlan && (!isIssuedHostShellExecutionPlan(admittedPlan)
        || getIssuedHostShellExecutionPlanGeneration(admittedPlan) !== getSandboxGeneration()
        || admittedPlan.identity !== getHostShellExecutionPlan().identity)) {
        return deny("hook shell execution policy changed during approval");
      }
    } catch (error) {
      return deny(`hook command admission failed: ${(error as Error).message}`);
    }
  }

  const childEnvBase = buildSafeChildEnv({ ...runnable.env, ...hookEnv,
    ...(confinement ? { PLUGIN_ROOT: confinement.generationRoot, PLUGIN_DATA: confinement.dataDir } : {}),
  });

  // Decide the spawn shape. Legacy single `.sh` → resolved shell (Windows
  // interpreter resolution). Generic command → direct spawn, NO shell.
  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnEnv: NodeJS.ProcessEnv;
  if (!confinement && isLegacyShellScript(runnable.command)) {
    let shell;
    try {
      shell = resolveShell();
    } catch (err) {
      if (err instanceof ShellMismatchError) {
        return deny(`shell unavailable: ${err.message}`);
      }
      throw err;
    }
    // The hook file path is passed via `shellCommandForHookPath` so the script's
    // own `$0` reflects its path. Env vars are injected as inline assignments
    // (the shell consumes them) AND via the spawn env allowlist.
    const hookCommand = `${shellEnvAssignments(hookEnv)} ${shellCommandForHookPath(shell, runnable.command[0])}`;
    spawnCmd = shell.cmd;
    spawnArgs = shell.shellArgs(hookCommand);
    spawnEnv = shellEnvForChild(shell, childEnvBase);
  } else {
    // Generic command-hook: spawn argv[0] directly with NO shell. Expand a
    // leading `~` in each token (the shell would have done this; a direct
    // spawn does not). NO shell quoting / parsing → no shell-injection surface.
    const argv = runnable.command.map(expandLeadingTilde);
    spawnCmd = argv[0];
    spawnArgs = argv.slice(1);
    spawnEnv = childEnvBase;
  }

  assertManagedChildProcessAdmissionOpen("hook:script");
  let cleanupWrap: (() => void) | undefined;
  let wrappedEgress: EgressInvocation | undefined;
  let windowsSpawn: WindowsBundledSpawn | undefined;
  const sandboxEnabled = admittedPlan ? admittedPlan.mode === "asrt" : isAsrtSandboxActive();
  const scriptAnchor = resolveScriptAnchor(runnable.command);
  const canonicalAnchor = scriptAnchor === null ? undefined : resolve(canonicalizePathForMatch(resolve(cwd, scriptAnchor)));
  // Only an exact script inside the protected hook directory gets a read
  // exception. An arbitrary command argument must never relax a secret floor.
  const userScriptReads = canonicalAnchor !== undefined && isPathWithin(
    caseFoldForMatch(resolve(defaultHooksDir())), caseFoldForMatch(canonicalAnchor),
  ) ? [canonicalAnchor] : [];
  // A user hook has no plugin, so its egress gets no extension allowlist.
  const hookEgressOwner: WorkerEgressOwner = confinement
    ? { kind: "worker", role: "hook", pluginId: confinement.pluginId }
    : { kind: "worker", role: "hook", pluginId: undefined, instanceId: sha256Hex(runnable.id) };
  if (sandboxEnabled && process.platform === "win32" && (confinement || admittedPlan?.mode === "asrt")) {
    // srt-win: the hook runs through the stdio relay with an ACL grant on its
    // own generation root (read) and data root (write); see
    // `spawnWindowsBundledProcess`.
    try {
      windowsSpawn = await spawnWindowsBundledProcess({
        label: `hook:${confinement?.pluginId ?? "user"}`,
        command: spawnCmd,
        args: spawnArgs,
        baseEnv: spawnEnv,
        cwd,
        allowRead: confinement ? [confinement.generationRoot] : userScriptReads,
        allowWrite: confinement ? [confinement.dataDir] : [cwd],
        egressOwner: hookEgressOwner,
        assertStillValid: () => {
          if (admittedPlan && (getIssuedHostShellExecutionPlanGeneration(admittedPlan) !== getSandboxGeneration()
            || admittedPlan.identity !== getHostShellExecutionPlan().identity)) {
            throw new Error("Hook shell execution policy changed before spawn");
          }
          assertCommandAllowed?.();
        },
      });
    } catch (error) {
      return deny(`sandbox unavailable: ${(error as Error).message}`);
    }
    const { releaseHold } = windowsSpawn;
    let cleaned = false;
    cleanupWrap = () => {
      if (!cleaned) {
        cleaned = true;
        void cleanupAsrtSandboxAfterCommand();
      }
      releaseHold();
    };
  } else if (sandboxEnabled && process.platform !== "win32") {
    const sandboxHome = createSandboxProcessHome();
    try {
      const wrapped = await wrapBundledCommand({ command: spawnCmd, args: spawnArgs,
        sandboxHome,
        allowWrite: confinement ? [confinement.dataDir] : [cwd],
        ownPluginReads: confinement ? [confinement.generationRoot] : userScriptReads,
        tempPrincipal: confinement ? { kind: "plugin", id: confinement.pluginId }
          : { kind: "hook", id: sha256Hex(runnable.id) },
        egressOwner: hookEgressOwner });
      [spawnCmd, ...spawnArgs] = wrapped.argv;
      spawnEnv = bundledWrappedEnv(childEnvBase, wrapped.env, sandboxHome.env);
      wrappedEgress = wrapped.egress;
      let cleaned = false;
      cleanupWrap = () => {
        if (cleaned) return;
        cleaned = true;
        void cleanupAsrtSandboxAfterCommand();
        sandboxHome.cleanup();
      };
    } catch (error) {
      sandboxHome.cleanup();
      return deny(`sandbox unavailable: ${(error as Error).message}`);
    }
  }

  if (admittedPlan && (getIssuedHostShellExecutionPlanGeneration(admittedPlan) !== getSandboxGeneration()
    || admittedPlan.identity !== getHostShellExecutionPlan().identity)) {
    if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook shell policy changed");
    wrappedEgress?.release();
    cleanupWrap?.();
    return deny("hook shell execution policy changed before spawn");
  }
  try {
    assertCommandAllowed?.();
  } catch (error) {
    if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook command permission changed");
    wrappedEgress?.release();
    cleanupWrap?.();
    return deny(`hook command denied before spawn: ${(error as Error).message}`);
  }

  return new Promise<ScriptHookInvocationResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = windowsSpawn?.child ?? spawn(spawnCmd, spawnArgs, {
        cwd,
        // Forward only the stripped environment and host-owned hook variables.
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // A detached group lets timeout termination include descendants.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      wrappedEgress?.release();
      cleanupWrap?.();
      resolve(deny(`hook spawn error: ${(error as Error).message}`));
      return;
    }
    if (wrappedEgress !== undefined) {
      const egress = wrappedEgress;
      child.once("exit", () => egress.release());
      child.once("close", () => egress.release());
      child.once("error", () => { if (child.pid === undefined) egress.release(); });
    }
    // A Windows sandboxed hook is registered by `spawnConfinedChild`.
    if (windowsSpawn === undefined) {
      trackManagedChildProcess(child, {
        label: "hook:script",
        killProcessGroup: process.platform !== "win32",
      });
    }
    // Detached (POSIX), the hook leads its own process group: the sandbox
    // keeps the ended invocation's listener port while that group lives.
    if (wrappedEgress !== undefined && process.platform !== "win32" && child.pid !== undefined) {
      wrappedEgress.noteProcessGroup(child.pid);
    }
    // Through the relay the hook's input and output are the relay's streams,
    // not the child's own pipes (`spawnWindowsBundledProcess`).
    const hookStdin = windowsSpawn?.stdin ?? child.stdin;
    const hookStdout = windowsSpawn?.stdout ?? child.stdout;
    // The relayed output is copied from the child's own and can trail its
    // `close` by a turn; the verdict waits for it, never longer than a second.
    const outputDrained: Promise<void> = windowsSpawn === undefined
      ? Promise.resolve()
      : new Promise<void>((resolveDrained) => {
        const done = (): void => resolveDrained();
        windowsSpawn!.stdout.once("end", done);
        windowsSpawn!.stdout.once("close", done);
        setTimeout(done, 1_000).unref();
      });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutCapped = false;

    hookStdout?.on("data", (c: Buffer) => {
      stdoutBytes += c.byteLength;
      if (stdoutBytes > MAX_HOOK_STDOUT_BYTES) {
        if (!stdoutCapped) {
          stdoutCapped = true;
          // Keep what we already have; don't grow further.
          stdoutChunks.push(c.subarray(0, Math.max(0, MAX_HOOK_STDOUT_BYTES - (stdoutBytes - c.byteLength))));
        }
        return;
      }
      stdoutChunks.push(c);
    });
    let stderrBytes = 0;
    child.stderr?.on("data", (c: Buffer) => {
      const remaining = MAX_HOOK_STDOUT_BYTES - stderrBytes;
      if (remaining <= 0) return;
      const captured = c.subarray(0, remaining);
      stderrChunks.push(captured);
      stderrBytes += captured.byteLength;
    });
    hookStdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      log.warn("hook stdin error: %s (%s)", runnable.id, err.message);
    });

    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFallback: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanupWrap?.();
      if (timer) clearTimeout(timer);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const durationMs = Date.now() - start;

      if (timedOut) {
        log.warn("hook timeout: %s (%dms)", runnable.id, timeoutMs);
        resolve({
          ...forensics,
          decision: "deny",
          reason: `hook timed out after ${timeoutMs}ms`,
          rawStdout: stdout,
          exitCode: code ?? undefined,
          timedOut: true,
          durationMs,
        });
        return;
      }

      if (code !== 0) {
        // Fail-safe: non-zero exit → deny. Stderr surfaces the cause.
        const tail = stderr.trim() || (signal ? `terminated by ${signal}` : `exit ${code}`);
        resolve({
          ...forensics,
          decision: "deny",
          reason: code === 2 ? `hook blocked (exit 2): ${tail}` : `hook exited non-zero (${code}): ${tail}`,
          rawStdout: stdout,
          exitCode: code ?? undefined,
          timedOut: false,
          durationMs,
          ...(code === 2 ? { blockFeedback: tail } : {}),
        });
        return;
      }

      const parsed = stdoutCapped ? null : parseHookStdout(stdout, runnable.hookType);
      if (!parsed) {
        resolve({
          ...forensics,
          decision: "deny",
          reason: stdoutCapped ? "hook stdout exceeded capture limit" : "hook stdout not valid decision JSON",
          rawStdout: stdout,
          exitCode: code,
          timedOut: false,
          durationMs,
        });
        return;
      }
      resolve({
        ...forensics,
        decision: parsed.action,
        reason: parsed.reason,
        rawStdout: stdout,
        exitCode: code,
        timedOut: false,
        durationMs,
        ...(parsed.block ? { blockFeedback: parsed.reason } : {}),
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      forceKillManagedChildProcess(child, "hook timeout");
      timeoutFallback = setTimeout(() => finish(child.exitCode), 1000);
    }, timeoutMs);

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      void outputDrained.then(() => finish(code, signal));
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupWrap?.();
      if (timer) clearTimeout(timer);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      resolve({
        ...forensics,
        decision: "deny",
        reason: `hook spawn error: ${err.message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });

    try {
      hookStdin?.write(stdinJson);
      hookStdin?.end();
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      forceKillManagedChildProcess(child, "hook stdin write failed");
      cleanupWrap?.();
      resolve({
        ...forensics,
        decision: "deny",
        reason: `failed to serialise hook payload: ${(err as Error).message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      });
    }
  });
}

/** Coerce a `DiscoveredHook` or `RunnableHook` into the runner's working shape. */
function normalizeRunnable(hook: DiscoveredHook | RunnableHook): RunnableHook {
  // A RunnableHook carries `command` (string[]); a DiscoveredHook carries
  // `path` + `fileName`. Discriminate on `command`.
  if (Array.isArray((hook as RunnableHook).command)) {
    return hook as RunnableHook;
  }
  return runnableFromDiscovered(hook as DiscoveredHook);
}

function shellEnvAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

/**
 * Normalize legacy or event-scoped structured stdout into a deny-only gate.
 * No event argument retains the legacy parser contract. Unsupported control
 * fields return null, so mutation or context injection cannot silently succeed.
 */
export function parseHookStdout(stdout: string, event?: HookEvent): ScriptHookStdout | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return event === undefined ? null : { action: "allow", reason: "hook completed" };
  // Tolerate code-fence wrapping.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (event === undefined || "action" in parsed) {
    if (parsed.action !== "allow" && parsed.action !== "deny") return null;
    if (typeof parsed.reason !== "string") return null;
    // Legacy output retains its bounded reason and does not accept mixed decisions.
    if (["decision", "hookSpecificOutput", "continue", "stopReason", "updatedInput", "updatedPermissions",
      "permissionDecision", "additionalContext", "suppressOutput", "systemMessage", "async", "asyncTimeout"]
      .some((key) => key in parsed)) return null;
    return { action: parsed.action, reason: parsed.reason.slice(0, 280) };
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  if ((fenced?.[1].trim() ?? trimmed) !== slice) return null;
  if (Object.keys(parsed).some((key) => !["decision", "reason", "continue", "stopReason", "hookSpecificOutput"].includes(key))) return null;
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") return null;
  if (parsed.stopReason !== undefined && typeof parsed.stopReason !== "string") return null;
  if (parsed.continue !== undefined && typeof parsed.continue !== "boolean") return null;
  let blocked = parsed.continue === false;
  let reason = parsed.stopReason ?? parsed.reason ?? "hook completed";
  if (parsed.decision !== undefined) {
    if (parsed.decision !== "block" && parsed.decision !== "allow") return null;
    if (parsed.decision === "block") {
      blocked = true;
      reason = parsed.reason ?? "hook blocked";
    }
  }
  if (parsed.hookSpecificOutput !== undefined) {
    const specific = parsed.hookSpecificOutput;
    if (!isRecord(specific) || specific.hookEventName !== hookEventName(event)) return null;
    if (event === "pre") {
      if (Object.keys(specific).some((key) => !["hookEventName", "permissionDecision", "permissionDecisionReason"].includes(key))) return null;
      if (specific.permissionDecision !== "allow" && specific.permissionDecision !== "deny") return null;
      if (specific.permissionDecisionReason !== undefined && typeof specific.permissionDecisionReason !== "string") return null;
      if (specific.permissionDecision === "deny") {
        blocked = true;
        reason = specific.permissionDecisionReason ?? "hook denied tool use";
      }
    } else if (event === "perm") {
      if (Object.keys(specific).some((key) => !["hookEventName", "decision"].includes(key))) return null;
      const decision = specific.decision;
      if (!isRecord(decision) || (decision.behavior !== "allow" && decision.behavior !== "deny")) return null;
      if (Object.keys(decision).some((key) => !["behavior", "message"].includes(key))) return null;
      if (decision.message !== undefined && typeof decision.message !== "string") return null;
      if (decision.behavior === "deny") {
        blocked = true;
        reason = decision.message ?? "hook denied permission request";
      }
    } else return null;
  }
  // `continue: false` stops outright, so only a bare block can ask a stop hook to continue the run.
  const block = parsed.decision === "block" && parsed.continue !== false;
  return { action: blocked ? "deny" : "allow", reason: String(reason), ...(block ? { block: true as const } : {}) };
}

/**
 * Run a chain of hooks of the same type. Order = caller-supplied
 * (alphabetical from {@link discoverHooks}, then config file order). Stops at
 * the first deny — subsequent hooks are not invoked (deny precedence + don't
 * waste cycles). Each entry may be a legacy `.sh` `DiscoveredHook` or a
 * normalized {@link RunnableHook}.
 */
export async function runHookChain(
  hooks: Array<DiscoveredHook | RunnableHook>,
  payload: ScriptHookStdin,
  options: RunOneHookOptions = {},
): Promise<{
  decision: "allow" | "deny";
  reason: string;
  results: ScriptHookInvocationResult[];
}> {
  const results: ScriptHookInvocationResult[] = [];
  for (const hook of hooks) {
    const r = await runOneHookScript(hook, payload, options);
    results.push(r);
    if (r.decision === "deny") {
      const label = identityLabel(hook);
      return { decision: "deny", reason: `${label}: ${r.reason}`, results };
    }
  }
  return {
    decision: "allow",
    reason: hooks.length === 0 ? "no hooks" : `${hooks.length} hook(s) allowed`,
    results,
  };
}

/** Human-readable identity for chain deny messages (`.sh` fileName or registry id). */
function identityLabel(hook: DiscoveredHook | RunnableHook): string {
  if (Array.isArray((hook as RunnableHook).command)) {
    return (hook as RunnableHook).id;
  }
  return (hook as DiscoveredHook).fileName;
}
