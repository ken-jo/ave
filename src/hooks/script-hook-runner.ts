// Blocking hooks fail closed on command failures; successful commands may be silent or return decisions, and exit 2 uses stderr as denial feedback. Shell admission, sandbox policy, safe env and caller-side DLP apply; hook allows never upgrade upstream denies (docs/guides/user-hooks.md).
// Generic argv never passes through an implicit shell; legacy scripts keep the resolved interpreter path.
import { spawn, type ChildProcess } from "node:child_process";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { raceWithAbort } from "../shared/abortable-deadline.js";
import { turnExtensionPolicyContext } from "../shared/turn-extension-policy.js";
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
import {
  assertExtensionStartAllowed, cleanupAsrtSandboxAfterCommand, isPluginWorkerConfinementActive,
} from "../permissions/asrt-sandbox.js";
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
  // Defaults to DEFAULT_HOOK_TIMEOUT_MS.
  timeoutMs?: number;
  // Defaults to process.cwd().
  cwd?: string;
  // Host-owned admission for a trusted user command; enrollment is not permission.
  authorizeCommand?: HookCommandAuthorizer;
  abortSignal?: AbortSignal;
}

// Legacy scripts and config argv share the same fail-closed runner, environment and timeout gates.
export interface RunnableHook {
  id: string;
  hookType: HookEvent;
  // A lone .sh path uses the resolved interpreter; all other argv spawn directly without a shell.
  command: string[];
  env?: Record<string, string>;
  // Optional matcher — surfaced to the hook via `AVE_HOOK_MATCHER`.
  matcher?: string;
  // Path for audit/forensics — `.sh` abs path, or the resolved script arg.
  hookPath: string;
  // Clamped per-hook timeout overrides the caller option, then the default.
  timeoutMs?: number;
  // Runner results always carry origin for audit; legacy hooks default to sh.
  source?: "sh" | "config";
  // Audit identity hashes trusted script bytes or verbatim argv; absent identities fall back to argv hashing.
  commandIdentity?: string;
  pluginOwner?: PluginHookOwner;
  confinement?: { kind: "bundled"; pluginId: string; dataDir: string; generationRoot: string };
}

function hashCommandArgv(command: string[]): string {
  return sha256Hex(command.join("\0"));
}

export function runnableFromDiscovered(hook: DiscoveredHook): RunnableHook {
  return {
    id: hook.fileName,
    hookType: hook.hookType,
    command: [hook.path],
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    hookPath: hook.path,
    source: "sh",
    commandIdentity: hook.sha256,
  };
}

// Only a lone .sh path uses interpreter resolution; generic argv, including sh ./x.sh, spawns directly.
function isLegacyShellScript(command: string[]): boolean {
  return command.length === 1 && command[0].toLowerCase().endsWith(".sh");
}

// Inject only hook metadata; buildSafeChildEnv supplies the secret-stripped environment.
function buildHookEnv(payload: ScriptHookStdin, matcher: string | undefined): Record<string, string> {
  // `event` is the closed-set surface (lifecycle events carry it explicitly; tool-use shapes leave it undefined → fall back to `hookType`).
  const event = payload.event ?? payload.hookType;
  return {
    AVE_HOOK_TYPE: payload.hookType,
    // AVE_HOOK_EVENT carries the closed event; AVE_HOOK_MATCHER exposes the configured matcher.
    AVE_HOOK_EVENT: event,
    ...(matcher !== undefined ? { AVE_HOOK_MATCHER: matcher } : {}),
    // `toolName` is present on tool-use + PostToolUseFailure/PermissionDenied lifecycle payloads; absent on session-only lifecycle events.
    ...(payload.toolName !== undefined ? { AVE_HOOK_TOOL_NAME: payload.toolName } : {}),
    AVE_HOOK_SESSION_ID: payload.sessionId,
    AVE_HOOK_TRUST_ORIGIN: payload.trustOrigin,
    // Tool-use origin metadata lets hooks restrict a specific server or plugin via env or stdin.
    ...("mcpServerId" in payload && payload.mcpServerId !== undefined ? { AVE_HOOK_MCP_SERVER_ID: payload.mcpServerId } : {}),
    ...("pluginId" in payload && payload.pluginId !== undefined ? { AVE_HOOK_PLUGIN_ID: payload.pluginId } : {}),
  };
}

// Timeout, spawn, nonzero exit and malformed output deny; observe-only callers record the result without changing control flow.
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
  // Timeout precedence is per-hook budget, caller option, then default.
  const timeoutMs = runnable.timeoutMs ?? options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const confinement = runnable.confinement;
  const cwd = confinement?.generationRoot ?? options.cwd ?? process.cwd();
  const start = Date.now();
  const inherited = turnExtensionPolicyContext.getStore();
  const abortSignal = options.abortSignal ?? inherited?.abortSignal;

  // Every result carries origin and the trusted script or argv hash for forensic attribution.
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
  if (abortSignal?.aborted) return deny("Hook execution cancelled");

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
  let refreshCommandAllowed: (() => Promise<void>) | undefined;
  let assertCommandAllowed: (() => void) | undefined;
  if (!confinement && options.authorizeCommand) {
    try {
      const admission = await raceWithAbort(turnExtensionPolicyContext.run({
        ...inherited, allowExternalHooks: inherited?.allowExternalHooks !== false, abortSignal,
      }, () => options.authorizeCommand!(runnable, payload, cwd)), abortSignal);
      if (abortSignal?.aborted) return deny("Hook execution cancelled");
      if (admission.decision !== "allow") return deny(`hook command denied: ${admission.reason}`);
      admittedPlan = admission.plan;
      assertCommandAllowed = admission.assertAllowed;
      refreshCommandAllowed = admission.refreshAllowed;
      if (admittedPlan && (!isIssuedHostShellExecutionPlan(admittedPlan)
        || getIssuedHostShellExecutionPlanGeneration(admittedPlan) !== getSandboxGeneration()
        || admittedPlan.identity !== getHostShellExecutionPlan().identity)) {
        return deny("hook shell execution policy changed during approval");
      }
    } catch (error) {
      if (abortSignal?.aborted) return deny("Hook execution cancelled");
      return deny(`hook command admission failed: ${(error as Error).message}`);
    }
  }

  const childEnvBase = buildSafeChildEnv({ ...runnable.env, ...hookEnv,
    ...(confinement ? { PLUGIN_ROOT: confinement.generationRoot, PLUGIN_DATA: confinement.dataDir } : {}),
  });

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
    // Preserve the script path as $0; inject hook env through inline assignments and the spawn allowlist.
    const hookCommand = `${shellEnvAssignments(hookEnv)} ${shellCommandForHookPath(shell, runnable.command[0])}`;
    spawnCmd = shell.cmd;
    spawnArgs = shell.shellArgs(hookCommand);
    spawnEnv = shellEnvForChild(shell, childEnvBase);
  } else {
    // Expand leading ~ and spawn argv directly; shell quoting/parsing would introduce injection.
    const argv = runnable.command.map(expandLeadingTilde);
    spawnCmd = argv[0];
    spawnArgs = argv.slice(1);
    spawnEnv = childEnvBase;
  }

  if (abortSignal?.aborted) return deny("Hook execution cancelled");
  assertManagedChildProcessAdmissionOpen("hook:script");
  if (confinement) {
    try {
      assertExtensionStartAllowed();
    } catch (error) {
      return deny(`sandbox unavailable: ${(error as Error).message}`);
    }
  }
  let cleanupWrap: (() => void) | undefined;
  let wrappedEgress: EgressInvocation | undefined;
  let windowsSpawn: WindowsBundledSpawn | undefined;
  // Bundled hooks require the worker-confinement gate; user hooks use the host-shell plan under which they were admitted, or its live plan.
  const sandboxEnabled = confinement
    ? isPluginWorkerConfinementActive()
    : (admittedPlan ?? getHostShellExecutionPlan()).mode === "asrt";
  const scriptAnchor = resolveScriptAnchor(runnable.command);
  const canonicalAnchor = scriptAnchor === null ? undefined : resolve(canonicalizePathForMatch(resolve(cwd, scriptAnchor)));
  // Only an exact script inside the protected hook directory gets a read exception. An arbitrary command argument must never relax a secret floor.
  const userScriptReads = canonicalAnchor !== undefined && isPathWithin(
    caseFoldForMatch(resolve(defaultHooksDir())), caseFoldForMatch(canonicalAnchor),
  ) ? [canonicalAnchor] : [];
  // A user hook has no plugin, so its egress gets no extension allowlist.
  const hookEgressOwner: WorkerEgressOwner = confinement
    ? { kind: "worker", role: "hook", pluginId: confinement.pluginId }
    : { kind: "worker", role: "hook", pluginId: undefined, instanceId: sha256Hex(runnable.id) };
  if (sandboxEnabled && process.platform === "win32" && (confinement || admittedPlan?.mode === "asrt")) {
    // Windows hooks use a stdio relay with read access to their generation and write access to their data.
    try {
      await refreshCommandAllowed?.();
      windowsSpawn = await spawnWindowsBundledProcess({
        label: `hook:${confinement?.pluginId ?? "user"}`,
        command: spawnCmd,
        args: spawnArgs,
        baseEnv: spawnEnv,
        cwd,
        allowRead: confinement ? [confinement.generationRoot] : userScriptReads,
        allowWrite: confinement ? [confinement.dataDir] : [cwd],
        egressOwner: hookEgressOwner,
        refreshStillValid: refreshCommandAllowed,
        assertStillValid: () => {
          abortSignal?.throwIfAborted();
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
    let wrappedAsrt = false;
    try {
      const wrapped = await wrapBundledCommand({ command: spawnCmd, args: spawnArgs,
        sandboxHome,
        allowWrite: confinement ? [confinement.dataDir] : [cwd],
        ownPluginReads: confinement ? [confinement.generationRoot] : userScriptReads,
        tempPrincipal: confinement ? { kind: "plugin", id: confinement.pluginId }
          : { kind: "hook", id: sha256Hex(runnable.id) },
        egressOwner: hookEgressOwner });
      wrappedEgress = wrapped.egress;
      wrappedAsrt = true;
      [spawnCmd, ...spawnArgs] = wrapped.argv;
      spawnEnv = bundledWrappedEnv(childEnvBase, wrapped.env, sandboxHome.env);
      let cleaned = false;
      cleanupWrap = () => {
        if (cleaned) return;
        cleaned = true;
        void cleanupAsrtSandboxAfterCommand();
        sandboxHome.cleanup();
      };
    } catch (error) {
      wrappedEgress?.release();
      if (wrappedAsrt) void cleanupAsrtSandboxAfterCommand();
      sandboxHome.cleanup();
      return deny(`sandbox unavailable: ${(error as Error).message}`);
    }
  }

  // The fresh authority probe is the last await before spawn. Everything after it, through spawn, runs in one synchronous turn.
  let refreshError: unknown;
  try {
    await refreshCommandAllowed?.();
  } catch (error) {
    refreshError = error;
  }
  if (abortSignal?.aborted) {
    if (windowsSpawn) await forceKillManagedChildProcess(windowsSpawn.child, "hook caller aborted");
    wrappedEgress?.release();
    cleanupWrap?.();
    return deny("Hook execution cancelled");
  }
  if (admittedPlan && (getIssuedHostShellExecutionPlanGeneration(admittedPlan) !== getSandboxGeneration()
    || admittedPlan.identity !== getHostShellExecutionPlan().identity)) {
    if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook shell policy changed");
    wrappedEgress?.release();
    cleanupWrap?.();
    return deny("hook shell execution policy changed before spawn");
  }
  try {
    if (refreshError !== undefined) throw refreshError;
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
        windowsHide: true,
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
    // Retain the invocation listener while the detached process group lives.
    if (wrappedEgress !== undefined && process.platform !== "win32" && child.pid !== undefined) {
      wrappedEgress.noteProcessGroup(child.pid);
    }
    // Relay streams, not child pipes, carry hook input and output.
    const hookStdin = windowsSpawn?.stdin ?? child.stdin;
    const hookStdout = windowsSpawn?.stdout ?? child.stdout;
    // Relayed output can lag child close; wait up to one second before parsing the verdict.
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFallback: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanupWrap?.();
      if (timer) clearTimeout(timer);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      abortSignal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const durationMs = Date.now() - start;

      if (cancelled) {
        resolve(deny("Hook execution cancelled", { rawStdout: stdout, exitCode: code ?? undefined }));
        return;
      }

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
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        ...forensics,
        decision: "deny",
        reason: `hook spawn error: ${err.message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });

    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(timeoutFallback);
      void forceKillManagedChildProcess(child, "hook caller aborted");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    try {
      hookStdin?.write(stdinJson);
      hookStdin?.end();
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
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

function normalizeRunnable(hook: DiscoveredHook | RunnableHook): RunnableHook {
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

// Unsupported control fields reject stdout so mutation/context injection cannot silently succeed; no event retains the legacy parser contract.
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

// Preserve caller order and stop at the first denial; later hooks must not execute or override it.
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

function identityLabel(hook: DiscoveredHook | RunnableHook): string {
  if (Array.isArray((hook as RunnableHook).command)) {
    return (hook as RunnableHook).id;
  }
  return (hook as DiscoveredHook).fileName;
}
