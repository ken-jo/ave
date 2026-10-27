import type {
  ToolOutputArtifactInfo,
  ToolOutputCapture,
} from "../shared/tool-output-artifact.js";
import type { ShellTask, ShellTaskAction, ShellTaskActionResult } from "../shared/shell-tasks.js";
import { SHELL_TASK_OUTPUT_PREVIEW_CHARS } from "../shared/shell-tasks.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../lib/logger.js";
import { beginAgentTerminalObservation, type AgentTerminalObservationInput, type AgentTerminalObservationLease } from "./agent-terminal-observation.js";
import { errorMessage } from "../shared/error-message.js";
import { hostScriptInvocationReadPaths } from "../main/host-script-runtime.js";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
/**
 * Host shell tool family: the `bash` and `powershell` execution tools, the
 * session-scoped background-shell registry, and the `bash_output` /
 * `bash_kill` tools that read from and stop shells `bash` started in the
 * background. The two shell dialects share one authorization preamble shape
 * (§691 plan sealing + one-shot fallback permit), one output-formatting
 * contract, and one spawn skeleton; colocating them keeps those in lockstep.
 *
 * Portions (the bash tool sections below) adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/bash_tool.py
 * Copyright (c) 2025 OpenHarness Contributors
 */

import { spawn, type ChildProcess, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import { assertSrtWinSpawnIntegrity } from "../permissions/srt-win-integrity.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve as pathResolve, win32 as win32Path } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import { spawnWindowsJobProcess } from "../main/windows-job-launcher.js";
import { t } from "../i18n/index.js";
import {
  createDynamicTool,
  ZodTool,
  type Tool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./base.js";
import { buildHostShellChildEnv, buildSafeChildEnv, buildSandboxedChildEnv } from "./safe-env.js";
import { prepareShellInvocation, matchesPreparedShellInvocation, preparedShellFacts, preparedShellToolUseId, preparedShellCommand, preparedShellCwdProbe, bindPreparedShellExecutableReadPaths, preparedShellExecutableReadPaths, preparedSandboxBootstrap, preparedSandboxEnvironment, disposePreparedShellInvocation, claimPreparedShellInvocation, transferPreparedShellInvocation, type PreparedShellInvocation } from "./prepared-shell-invocation.js";
import { POWER_SHELL_AST_PARSER, normalizePowerShellAstSummary, type PowerShellArgument, type PowerShellAstSummary } from "./powershell-ast.js";
import { resolveShellFilesystemPath } from "../shared/shell-filesystem-path.js";
import { getPolicyHome } from "../shared/policy-home.js";
import { hostPathForShellPath } from "../lib/shell-resolver.js";
import { ShellCwdProbeFilter, type ShellCwdProbe } from "./shell-cwd-probe.js";
import { clearShellSessionCwd, recordShellSessionCwd } from "./shell-session-cwd.js";
import { createLiveOutputStream, toolOutputProgressFromMetadata, type ToolOutputProgressSink } from "./tool-output-progress.js";
import {
  findResolvedShellPathViolation,
  findShellPathPolicyViolation,
  type ShellPathPolicyViolation,
} from "./shell-path-policy.js";
export type { PowerShellAstSummary } from "./powershell-ast.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
import { preparePowerShellLaunch, retainPowerShellLaunchUntilExit } from "./powershell-launch.js";
import { createPowerShellParserResponse } from "./powershell-parser-response.js";
import { verifiedShellEnvironment, verifiedShellExecution, verifiedShellRequiresResultCheck, verifiedShellResultRefusal, type VerifiedShellCommand, type VerifiedShellIdentity } from "../permissions/verified-shell-command.js";
import { resolveTrustedPowerShellExecutable } from "../shared/powershell-executable.js";
import { isPowerShellStartupPinned, POWERSHELL_STARTUP_UNPROVEN_REASON } from "../shared/powershell-startup-policy.js";
import {
  validateShellWorkingDirectory,
} from "./shell-path-policy.js";
import {
  wrapToolCommand,
  annotateWithSandboxViolations,
  cleanupAsrtSandboxAfterCommand,
  getBuiltinShellReadPolicy,
  getDefaultSensitiveWriteDenyPaths,
  type SandboxWrapResult,
} from "../permissions/asrt-sandbox.js";
import { openEgressInvocation, type ShellEgressContext } from "../permissions/egress-invocations.js";
import { MXC_BASH_UNAVAILABLE_MESSAGE, powerShellMxcCommandLine } from "../permissions/mxc-windows.js";
import { prepareMxcShellLaunch, type MxcShellLaunch } from "./mxc-shell-launch.js";
import { buildMandatorySandboxWritePolicy } from "../permissions/sandbox-write-policy.js";
import { currentEffectGateContext } from "../permissions/effect-enforcement.js";
import { currentToolExecutionCwd } from "./execution-context.js";
import {
  getHostShellExecutionPlan,
  isIssuedHostShellExecutionPlan,
} from "../permissions/sandbox-capability.js";
import {
  getHostShellExecutionPlanAuditProjection,
  requiresExplicitHostShellApproval,
  type HostShellExecutionPlan,
} from "../permissions/host-shell-execution-plan.js";
import {
  consumeExecutionGrantForBuiltinToolInvocation,
  consumeExecutionGrantForShellInvocation,
  disposableGrantRelaxesPathPolicy,
} from "../permissions/execution-router.js";
import {
  canonicalizeHostShellAllowedDirectories,
  consumeHostShellExecutionPermitForSpawn,
  HOST_SHELL_AUTHORIZATION_REVOKED_ERROR,
  resolveHostShellWorkingDirectory,
  withHostShellExecutionHandoff,
  type HostShellSpawnAuthorization,
} from "../permissions/host-shell-execution-permit.js";
import { hostShellWorkingDirectoryPrelude } from "./host-shell-cwd-guard.js";
import { attachHostShellControlChannel } from "./host-shell-control-channel.js";
import { deriveSandboxWritePaths } from "../permissions/sandbox-write-jail.js";
import { resolveShellTimeoutMs, TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  assertManagedChildProcessAdmissionOpen,
  forceKillManagedChildProcess,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import type {
  BrokeredWorkloadCapability,
  BrokeredWorkloadExecutionResult,
  WorkloadBackgroundActor,
  WorkloadBackgroundParent,
  WorkloadToolCorrelationAuthority,
} from "../workload/runtime.js";
import { isWorkloadBrokerActive } from "../workload/runtime.js";
import type { ApprovalMemoryScope } from "../shared/permissions-events.js";
import {
  WORKLOAD_BROKER_LIMITS,
  type WorkloadBrokerSuccessResults,
} from "../workload/protocol.js";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
type ManagedPowerShellChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

// Output-formatting contract shared verbatim by both shell dialects.
const OUTPUT_CAP = 12_000;
const TRUNCATION_MARKER = "\n...[truncated]...";
const shellTaskLog = createLogger("shell-tasks");

function shellTaskOutputPreview(output: string, truncated = false): Pick<ShellTask, "output" | "outputTruncated"> {
  return { output: output.slice(-SHELL_TASK_OUTPUT_PREVIEW_CHARS), outputTruncated: truncated || output.length > SHELL_TASK_OUTPUT_PREVIEW_CHARS };
}

function formatOutput(raw: string, captureTruncated = false): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return captureTruncated ? TRUNCATION_MARKER.trimStart() : "(no output)";
  if (text.length > OUTPUT_CAP || captureTruncated) return text.slice(0, OUTPUT_CAP) + TRUNCATION_MARKER;
  return text;
}

interface ShellCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function shellObservationSandbox(plan: HostShellExecutionPlan, disposable: boolean): AgentTerminalObservationInput["sandbox"] {
  return disposable ? { mode: "disposable", detail: "disposable-container" }
    : plan.mode === "asrt" ? { mode: "isolated", detail: "filesystem/process confinement" }
      : { mode: "unconfined", detail: plan.executionRequest === "host" ? "explicit-host" : plan.fallbackReason };
}

/** Observations started while a checked shell result is pending ({@link checkedShellResult}); their output is released only with that result. */
const heldShellObservations = new AsyncLocalStorage<AgentTerminalObservationLease[]>();

function startShellObservation(command: string, cwd: string, sandbox: AgentTerminalObservationInput["sandbox"], token?: string) {
  const held = heldShellObservations.getStore();
  const observation = beginAgentTerminalObservation({ kind: "shell", command, cwd, sandbox,
    ...(held ? { outputAvailability: "on-completion" as const, outputHeld: true as const } : {}) });
  if (observation) held?.push(observation);
  if (token !== undefined) observation?.bindEgress(token);
  return observation;
}

function consumeShellExecutionRoute(input: {
  context: ToolExecutionContext;
  legacyPlan: HostShellExecutionPlan;
  toolName: "bash" | "powershell";
  command: string;
  cwd: string;
  timeoutSeconds: number;
  background: boolean;
}) {
  if (input.context.executionRouteGrant === undefined) return null;
  return consumeExecutionGrantForShellInvocation({
    grant: input.context.executionRouteGrant,
    legacyPlan: input.legacyPlan,
    toolName: input.toolName,
    command: input.command,
    cwd: input.cwd,
    timeoutSeconds: input.timeoutSeconds,
    background: input.background,
  });
}

type WorkloadRuntime = typeof import("../workload/runtime.js");

interface BrokeredShellAuthority {
  readonly runtime: WorkloadRuntime;
  readonly capability: BrokeredWorkloadCapability;
  readonly correlationAuthority: WorkloadToolCorrelationAuthority;
}

/**
 * An active broker launch is exclusive. Once configured, a missing disposable
 * grant, a cwd binding mismatch, or handshake failure must never degrade to a
 * local child on the host that owns the broker socket.
 */
async function acquireBrokeredShellAuthority(
  executionAuthority: ReturnType<typeof consumeShellExecutionRoute>,
  requestedGrant: ToolExecutionContext["executionRouteGrant"],
): Promise<BrokeredShellAuthority | null> {
  const runtime = await import("../workload/runtime.js");
  if (executionAuthority?.disposableAuthority === "workload-broker") {
    if (
      executionAuthority.route !== "disposable-container" ||
      executionAuthority.brokeredWorkloadCapability === undefined ||
      executionAuthority.workloadCorrelationAuthority === undefined ||
      !runtime.isWorkloadBrokerActive()
    ) {
      throw new Error("workload-broker:grant-binding-unavailable");
    }
    return Object.freeze({
      runtime,
      capability: executionAuthority.brokeredWorkloadCapability,
      correlationAuthority: executionAuthority.workloadCorrelationAuthority!,
    });
  }
  if (
    runtime.isWorkloadBrokerActive() ||
    requestedGrant?.disposableAuthority === "workload-broker"
  ) {
    throw new Error("workload-broker:disposable-grant-required");
  }
  return null;
}

function brokerFailureResult(error: unknown): ToolExecutionResult {
  const reason = error instanceof Error ? error.message : "workload-broker:unexpected-failure";
  return {
    output: `Workload broker refused execution (${reason}).`,
    isError: true,
    metadata: {
      source: "workload-broker",
      executionTransport: "workload-broker",
      sandboxed: true,
      isolation: "disposable-container",
    },
  };
}

/** Termination belongs in shell content, which every provider receives. */
function formatShellCompletion(output: string, empty: boolean, completion: ShellCompletion): string {
  if (completion.code === 0 && completion.signal === null) return output;
  const cause = completion.signal !== null
    ? `terminated by signal ${completion.signal}`
    : completion.code !== null
      ? `exited with code ${completion.code}`
      : "failed with no reported exit code or signal";
  return empty ? `Shell command ${cause} without output.` : `Shell command ${cause}.\n${output}`;
}

/** Keep a bounded UTF-8 prefix while continuing to drain both child pipes. */
type BoundOutputCaptureFactory = () => ToolOutputCapture;

function captureFactoryFromContext(ctx: ToolExecutionContext): BoundOutputCaptureFactory | undefined {
  const factory = ctx.metadata.toolOutputCaptureFactory;
  return typeof factory === "function" ? factory as BoundOutputCaptureFactory : undefined;
}

interface OutputCollectorOptions {
  readonly captureFactory?: BoundOutputCaptureFactory;
  readonly cwdProbe?: Pick<ShellCwdProbe, "start" | "end">;
  /** Display-only live output; the formatted result stays bounded. */
  readonly progress?: ToolOutputProgressSink;
  readonly retainForHandoff?: boolean;
  readonly observation?: AgentTerminalObservationLease;
}

function createOutputCollector(child: PipedChild, options: OutputCollectorOptions = {}) {
  const factory = options.captureFactory;
  const cwdProbe = options.cwdProbe;
  // Four bytes cover any UTF-8 code point. The display cap remains in UTF-16
  // characters; raw whitespace also counts against this capture budget.
  const buffer = Buffer.alloc(OUTPUT_CAP * 4);
  let size = 0;
  let truncated = false;
  let capture: ToolOutputCapture | undefined;
  let finalized = false;
  let paused = false;
  let backgroundOutput: ((chunk: string) => void) | undefined;
  let handoffOutput = "";
  let handoffTruncated = false;
  const handoffStdoutDecoder = new StringDecoder("utf8");
  const handoffStderrDecoder = new StringDecoder("utf8");
  const observationDecoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let observationFinished = false;
  const observe = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (observationFinished || !options.observation) return;
    const text = observationDecoders[stream].write(chunk);
    if (text.length > 0) options.observation.write(text);
  };
  const retainHandoffOutput = (decoded: string): void => {
    if (!options.retainForHandoff) return;
    const remaining = MAX_OUTPUT_CHARS - handoffOutput.length;
    let retained = decoded.slice(0, remaining);
    if (retained.length > 0 && /[\uD800-\uDBFF]$/.test(retained)) retained = retained.slice(0, -1);
    handoffOutput += retained;
    handoffTruncated ||= retained.length < decoded.length;
  };
  // The probe reports on stderr; its bytes never reach the display buffer,
  // the output artifact, or live progress.
  const probeFilter = cwdProbe === undefined ? undefined : new ShellCwdProbeFilter(cwdProbe);
  const live = options.progress === undefined ? undefined : createLiveOutputStream(options.progress);
  const append = (chunk: Buffer): void => {
    if (!capture || capture.append(chunk) || paused) return;
    paused = true;
    child.stdout.pause();
    child.stderr.pause();
    void capture.waitForDrain().then(() => {
      paused = false;
      if (!finalized) {
        child.stdout.resume();
        child.stderr.resume();
      }
    });
  };
  const collect = (chunk: Buffer): void => {
    if (finalized || chunk.length === 0) return;
    // Reserve only when output can exceed the bounded display. The prefix
    // accumulated before reservation is replayed once, in observed order.
    if (!capture && factory && size + chunk.length > OUTPUT_CAP) {
      capture = factory();
      if (size > 0) append(buffer.subarray(0, size));
    }
    append(chunk);
    const retained = Math.min(chunk.length, buffer.length - size);
    if (retained > 0) chunk.copy(buffer, size, 0, retained);
    size += retained;
    if (retained < chunk.length) truncated = true;
  };
  const collectStderrBytes = (chunk: Buffer): void => {
    observe("stderr", chunk);
    collect(chunk);
    if (chunk.length > 0) live?.write("stderr", chunk);
  };
  return {
    collect(chunk: Buffer): void {
      observe("stdout", chunk);
      if (backgroundOutput) { backgroundOutput(handoffStdoutDecoder.write(chunk)); return; }
      if (finalized) return;
      retainHandoffOutput(handoffStdoutDecoder.write(chunk));
      collect(chunk);
      live?.write("stdout", chunk);
    },
    collectStderr(chunk: Buffer): void {
      if (backgroundOutput) {
        const filtered = probeFilter === undefined ? chunk : probeFilter.push(chunk);
        observe("stderr", filtered);
        backgroundOutput(handoffStderrDecoder.write(filtered));
        return;
      }
      if (finalized) return;
      const filtered = probeFilter === undefined ? chunk : probeFilter.push(chunk);
      retainHandoffOutput(handoffStderrDecoder.write(filtered));
      collectStderrBytes(filtered);
    },
    async finish(interrupted: boolean): Promise<Record<string, unknown>> {
      if (probeFilter !== undefined && !finalized && !backgroundOutput) collectStderrBytes(probeFilter.flush());
      live?.close();
      finalized = true;
      return capture ? { outputArtifact: await capture.finish(interrupted) } : {};
    },
    handOffOutput(sink: (chunk: string) => void): void {
      backgroundOutput = sink;
      // Finalizing a foreground artifact must not leave the continuing pipes paused.
      child.stdout.resume();
      child.stderr.resume();
    },
    finishBackground(): void {
      if (backgroundOutput) {
        if (probeFilter) {
          const rest = probeFilter.flush();
          observe("stderr", rest);
          backgroundOutput(handoffStderrDecoder.write(rest));
        }
        backgroundOutput(handoffStdoutDecoder.end());
        backgroundOutput(handoffStderrDecoder.end());
      }
      backgroundOutput = undefined;
    },
    finishObservation(code: number | null, status?: Parameters<AgentTerminalObservationLease["finish"]>[1]): void {
      if (observationFinished) return;
      observationFinished = true;
      if (!options.observation) return;
      const rest = observationDecoders.stdout.end() + observationDecoders.stderr.end();
      if (rest.length > 0) options.observation.write(rest);
      options.observation.finish(code, status);
    },
    abandonCapture(): void { capture?.abandon?.(); },
    handoffSnapshot(): { output: string; truncated: boolean } {
      return { output: handoffOutput, truncated: handoffTruncated };
    },
    /** The shell's final directory as it reported it, when the probe completed. */
    reportedCwd(): string | undefined {
      return probeFilter?.reportedCwd;
    },
    format(completion?: ShellCompletion): string {
      const prefix = buffer.subarray(0, size);
      // An incomplete final code point belongs to the discarded suffix.
      const text = truncated ? new StringDecoder("utf8").write(prefix) : prefix.toString("utf8");
      const output = formatOutput(text, truncated);
      return completion === undefined ? output : formatShellCompletion(output, text.trim().length === 0 && !truncated, completion);
    },
  };
}

/** Checked output cannot be validated while its child may still read metadata. */
function checkedShellClose(child: ChildProcess, required: boolean): Promise<void> | undefined {
  return required ? new Promise((resolve) => { child.once("close", () => resolve()); }) : undefined;
}

/** Own the deadline and cancellation subscription until the child settles. */
function watchShellLifetime(
  child: ChildProcess,
  timeoutSeconds: number,
  signal?: AbortSignal,
  abortSandbox?: () => void,
) {
  let timedOut = false;
  let aborted = false;
  let termination: void | Promise<void>;
  let notifyStopped: () => void;
  const stopped = new Promise<void>((resolve) => { notifyStopped = resolve; });
  const stop = (): void => {
    abortSandbox?.();
    termination = forceKillManagedChildProcess(child, timedOut ? "shell-timeout" : "shell-cancelled");
    // An exited root can leave inherited pipes open in a detached descendant.
    // Interruption releases our pipe ends and settles without waiting for close.
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (termination) void termination.then(() => notifyStopped());
    else notifyStopped();
  };
  const cancel = (): void => {
    if (timedOut || aborted) return;
    aborted = true;
    stop();
  };
  const timer = setTimeout(() => {
    if (aborted) return;
    timedOut = true;
    stop();
  }, resolveShellTimeoutMs(timeoutSeconds));
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return {
    stopped,
    get termination() { return termination; },
    get timedOut() { return timedOut; },
    get aborted() { return aborted; },
    releaseSignal(): void { signal?.removeEventListener("abort", cancel); },
    dispose(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
    output(text: string): string {
      return aborted ? `Shell command cancelled.\n${text}` : text;
    },
    metadata(): { aborted?: true } {
      return aborted ? { aborted: true } : {};
    },
  };
}

const shellTimeoutSchema = z.number().int().min(1)
  .default(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000)
  .describe(
    "Seconds to wait before the command is killed. Positive integer; defaults to " +
    `${TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000}. Start with the default and only pass a ` +
    "larger value when a previous call timed out. Brokered disposable workloads accept at most " +
    `${WORKLOAD_BROKER_LIMITS.maximumTimeoutMs / 1000} seconds; local execution has no schema maximum.`,
  );

/**
 * Session-scoped registry for background shell processes started by the `bash`
 * tool with `run_in_background: true`. Mirrors the module-singleton shape of
 * {@link ../main/managed-child-processes.js} (which this also registers each
 * child with, so background shells are force-killed on app quit).
 *
 * Isolation: every entry is tagged with the `sessionId` that started it, and
 * `bash_output` / `bash_kill` reject a `shellId` that belongs to a different
 * session. Shell ids are unguessable UUIDs, so the session tag is defense in
 * depth on top of an already-unforgeable handle.
 *
 * Output model: stdout and stderr are appended to a single combined buffer in
 * arrival order (a terminal-like transcript), capped at
 * {@link MAX_OUTPUT_CHARS}. Once the cap is reached the buffer stops growing and
 * `truncated` latches true — so the read cursor is never invalidated and
 * incremental reads stay correct.
 */
export const MAX_OUTPUT_CHARS = 200_000;
const BROKER_BACKGROUND_KILL_TIMEOUT_MS =
  TOOL_TIMEOUT_POLICY.workloadBrokerBackgroundCleanupEffectMs;
/**
 * A background command must reach its broker-owned deadline while the exact
 * capability is still live, with enough time left for a fresh handshake and
 * a bounded terminal cleanup request. This prevents an accepted command from
 * predictably outliving the only authority that can terminate it.
 */
const BROKER_BACKGROUND_LIFETIME_GUARD_MS =
  (2 * WORKLOAD_BROKER_LIMITS.handshakeTimeoutMs) +
  BROKER_BACKGROUND_KILL_TIMEOUT_MS +
  TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs;
/** Terminal statuses a background shell can settle into. */
type BackgroundShellStatus = "running" | "exited" | "killed" | "failed";
type BackgroundShellWaitFor = z.infer<typeof backgroundOutputWaitForSchema>;

interface BackgroundShellEntry {
  shellId: string;
  sessionId: string;
  command: string;
  child: ChildProcess;
  status: BackgroundShellStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  outputTruncated: boolean;
  readCursor: number;
  startedAt: string;
  stopTracking: () => void;
  terminate: () => void;
  waiters: Set<() => void>;
  observation?: AgentTerminalObservationLease;
}

interface BackgroundShellReadResult {
  shellId: string;
  status: BackgroundShellStatus;
  exitCode: number | null;
  signal: string | null;
  /** New output since the previous read (advances the cursor). */
  output: string;
  /** True once total output hit the cap and later bytes were dropped. */
  truncated: boolean;
  command: string;
  workloadStatus?: WorkloadBrokerSuccessResults["shell.kill"]["status"] | "running";
  completion?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

interface BrokerBackgroundShellEntry {
  readonly shellId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly executionId: string;
  readonly capability: BrokeredWorkloadCapability;
  readonly parent: WorkloadBackgroundParent;
  offset: number;
  status: BackgroundShellStatus;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  capturedChars: number;
  terminalReceipt?: Record<string, unknown>;
  workloadStatus?: WorkloadBrokerSuccessResults["shell.kill"]["status"];
  completion?: string;
  isError?: boolean;
  observation?: AgentTerminalObservationLease;
}

type BrokerSessionCleanupState = "pending" | "complete" | "cleanup-unproven";

interface BrokerBackgroundCleanupOutcome {
  readonly shellId: string;
  readonly executionId: string;
  readonly state: Exclude<BrokerSessionCleanupState, "pending">;
  readonly ownedResourcesZero: boolean;
  readonly requiresExternalRelease: boolean;
  readonly workloadStatus?: WorkloadBrokerSuccessResults["shell.kill"]["status"];
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly failure?: string;
}

interface BrokerSessionCleanupReport {
  readonly sessionId: string;
  readonly state: BrokerSessionCleanupState;
  readonly requested: number;
  readonly settled: number;
  readonly pending: number;
  readonly cleanupUnproven: number;
  readonly outcomes: readonly BrokerBackgroundCleanupOutcome[];
}

interface MutableBrokerSessionCleanup {
  readonly sessionId: string;
  requested: number;
  readonly pending: Map<string, Promise<void>>;
  readonly outcomes: Map<string, BrokerBackgroundCleanupOutcome>;
}

export interface BackgroundShellManager {
  register(input: {
    sessionId: string;
    command: string;
    child: ChildProcess;
    startedAt: string;
    /** True only when this child was spawned as a detached POSIX group leader. */
    killProcessGroup?: boolean;
    /** An adopted foreground pipe keeps its existing filter and forwards output. */
    captureOutput?: boolean;
    initialOutput?: string;
    initialOutputTruncated?: boolean;
    observation?: AgentTerminalObservationLease;
  }): string;
  registerBroker(input: {
    sessionId: string;
    command: string;
    executionId: string;
    capability: BrokeredWorkloadCapability;
    parent: WorkloadBackgroundParent;
    offset: number;
    observation?: AgentTerminalObservationLease;
  }): string;
  isBrokerShell(sessionId: string, shellId: string): boolean;
  readBroker(
    sessionId: string,
    shellId: string,
    waitMs: number,
    actor: WorkloadBackgroundActor,
    signal?: AbortSignal,
    waitFor?: BackgroundShellWaitFor,
  ): Promise<BackgroundShellReadResult | ToolExecutionResult | undefined>;
  killBroker(
    sessionId: string,
    shellId: string,
    actor: WorkloadBackgroundActor,
    signal?: AbortSignal,
  ): Promise<BackgroundShellReadResult | ToolExecutionResult | undefined>;
  read(sessionId: string, shellId: string): BackgroundShellReadResult | undefined;
  list(sessionId: string): ShellTask[];
  appendOutput(sessionId: string, shellId: string, chunk: string): void;
  waitForOutput(sessionId: string, shellId: string, waitMs: number, signal?: AbortSignal, waitFor?: BackgroundShellWaitFor): Promise<void>;
  kill(sessionId: string, shellId: string): BackgroundShellReadResult | undefined;
  /** User lifecycle cancellation does not consume the model's output cursor. */
  stop(sessionId: string, shellId: string): boolean;
  waitForLocalCleanup(sessionId: string): Promise<void>;
  /** Kill + drop every shell owned by a session (call on session end). */
  disposeSession(sessionId: string): number;
  /** Begin cleanup for every still-live broker shell during process shutdown. */
  disposeAllBrokerShells(signal?: AbortSignal): number;
  /** Observe cleanup without treating fire-and-forget transport as success. */
  getBrokerCleanupReport(sessionId: string): BrokerSessionCleanupReport | undefined;
  /** Resolve once every broker cleanup request for this session has settled. */
  waitForBrokerCleanup(sessionId: string): Promise<BrokerSessionCleanupReport | undefined>;
  /**
   * Wait for the current cleanup generation and consume its evidence only when
   * cleanup is proven complete. Unproven evidence remains available for
   * shutdown diagnostics and prevents a later transition from forgetting it.
   */
  settleSessionCleanup(sessionId: string): Promise<BrokerSessionCleanupReport | undefined>;
  /** Wait for every tracked broker cleanup and return its final release proof. */
  waitForAllBrokerCleanup(): Promise<readonly BrokerSessionCleanupReport[]>;
  /** Test-only reset. */
  _resetForTest(): void;
  _size(): number;
}

function isBrokerTransportToolResult<K extends "shell.start" | "shell.read" | "shell.kill">(
  result: BrokeredWorkloadExecutionResult<K>,
): result is ToolExecutionResult {
  return !("executionId" in result);
}

function brokerTerminalStatus(
  status: WorkloadBrokerSuccessResults["shell.read"]["status"] |
    WorkloadBrokerSuccessResults["shell.kill"]["status"],
): BackgroundShellStatus {
  if (status === "running") return "running";
  if (status === "exited") return "exited";
  if (status === "transport-failed" || status === "cleanup-unproven") return "failed";
  return "killed";
}

function brokerTerminalReceipt(
  result: WorkloadBrokerSuccessResults["shell.read"] |
    WorkloadBrokerSuccessResults["shell.kill"],
): Record<string, unknown> | undefined {
  if (result.status === "running") return undefined;
  return {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    oomDelta: result.oomDelta,
    ownedResourcesZero: result.ownedResourcesZero,
    receiptDigest: result.receiptDigest,
  };
}

function workloadCompletionSentence(input: {
  status: WorkloadBrokerSuccessResults["shell.run"]["status"];
  exitCode: number | null;
  signal: string | null;
  oomDelta: number;
  ownedResourcesZero: boolean;
}): string | undefined {
  switch (input.status) {
    case "exited":
      return input.exitCode === 0
        ? undefined
        : `Workload shell exited with code ${input.exitCode ?? "unknown"}.`;
    case "signaled":
      return `Workload shell was terminated by signal ${input.signal ?? "unknown"}.`;
    case "timed-out":
      return "Workload shell timed out and the broker completed its termination sequence.";
    case "cancelled":
      return "Workload shell was cancelled and the broker completed its termination sequence.";
    case "oom-killed":
      return `Workload shell was OOM-killed (cgroup OOM delta ${input.oomDelta}).`;
    case "transport-failed":
      return "Workload shell transport failed before a successful completion was proven.";
    case "cleanup-unproven":
      return `Workload shell cleanup was not proven (owned resources zero: ${input.ownedResourcesZero}).`;
  }
}

function workloadTerminalIsError(input: {
  status: WorkloadBrokerSuccessResults["shell.run"]["status"];
  exitCode: number | null;
  isError: boolean;
  ownedResourcesZero: boolean;
}): boolean {
  return input.isError || input.status !== "exited" || input.exitCode !== 0 ||
    !input.ownedResourcesZero;
}

function brokerBackgroundSnapshot(
  entry: BrokerBackgroundShellEntry,
  output: string,
): BackgroundShellReadResult {
  return {
    shellId: entry.shellId,
    status: entry.status,
    exitCode: entry.exitCode,
    signal: entry.signal,
    output,
    truncated: entry.truncated,
    command: entry.command,
    ...(entry.workloadStatus === undefined ? {} : { workloadStatus: entry.workloadStatus }),
    ...(entry.completion === undefined ? {} : { completion: entry.completion }),
    ...(entry.isError === undefined ? {} : { isError: entry.isError }),
    metadata: {
      source: "workload-broker",
      executionTransport: "workload-broker",
      ...(entry.terminalReceipt === undefined
        ? {}
        : { workloadReceipt: entry.terminalReceipt }),
    },
  };
}

function captureBrokerBackgroundOutput(
  entry: BrokerBackgroundShellEntry,
  raw: string,
): string {
  const remaining = Math.max(0, MAX_OUTPUT_CHARS - entry.capturedChars);
  const output = raw.slice(0, remaining);
  entry.capturedChars += output.length;
  if (raw.length > remaining) entry.truncated = true;
  return output;
}

function isWellFormedUnicode(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function isExactBrokerReadRange(input: {
  offset: number;
  nextOffset: number;
  output: string;
  maxBytes: number;
}): boolean {
  if (!isWellFormedUnicode(input.output)) return false;
  const outputBytes = Buffer.byteLength(input.output, "utf8");
  return outputBytes <= input.maxBytes &&
    input.nextOffset === input.offset + outputBytes;
}

/**
 * shell.kill returns the complete retained transcript. Split it at the last
 * consumed UTF-8 byte cursor so the user sees only unread output.
 */
function brokerKillUnreadSuffix(
  output: string,
  consumedBytes: number,
  nextOffset: number,
): string | null {
  if (!isWellFormedUnicode(output)) return null;
  const encoded = Buffer.from(output, "utf8");
  if (nextOffset !== encoded.byteLength || consumedBytes > nextOffset) return null;
  const consumed = encoded.subarray(0, consumedBytes);
  const unread = encoded.subarray(consumedBytes);
  const consumedText = consumed.toString("utf8");
  const unreadText = unread.toString("utf8");
  if (!Buffer.from(consumedText, "utf8").equals(consumed) ||
      !Buffer.from(unreadText, "utf8").equals(unread)) {
    return null;
  }
  return unreadText;
}

function withBrokerTransportMetadata(result: ToolExecutionResult): ToolExecutionResult {
  return {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      source: "workload-broker",
      executionTransport: "workload-broker",
      sandboxed: true,
      isolation: "disposable-container",
    },
  };
}

function createManager(): BackgroundShellManager {
  const shells = new Map<string, BackgroundShellEntry>();
  const localCleanup = new Map<string, Set<Promise<void>>>();
  const brokerShells = new Map<string, BrokerBackgroundShellEntry>();
  const brokerCleanup = new Map<string, MutableBrokerSessionCleanup>();
  let brokerRuntimeImport: Promise<typeof import("../workload/runtime.js")> | undefined;
  const loadBrokerRuntime = () =>
    brokerRuntimeImport ??= import("../workload/runtime.js");

  const cleanupReport = (
    cleanup: MutableBrokerSessionCleanup,
  ): BrokerSessionCleanupReport => {
    const outcomes = [...cleanup.outcomes.values()];
    const cleanupUnproven = outcomes.filter(
      (outcome) => outcome.state === "cleanup-unproven",
    ).length;
    return Object.freeze({
      sessionId: cleanup.sessionId,
      state: cleanup.pending.size > 0
        ? "pending"
        : cleanupUnproven > 0
          ? "cleanup-unproven"
          : "complete",
      requested: cleanup.requested,
      settled: outcomes.length,
      pending: cleanup.pending.size,
      cleanupUnproven,
      outcomes: Object.freeze(outcomes),
    });
  };

  const unprovenCleanup = (
    entry: BrokerBackgroundShellEntry,
    failure: string,
  ): BrokerBackgroundCleanupOutcome => Object.freeze({
    shellId: entry.shellId,
    executionId: entry.executionId,
    state: "cleanup-unproven" as const,
    ownedResourcesZero: false,
    requiresExternalRelease: true,
    failure,
  });

  const cleanTerminalOutcome = (
    entry: BrokerBackgroundShellEntry,
    result: WorkloadBrokerSuccessResults["shell.kill"],
  ): BrokerBackgroundCleanupOutcome => {
    const receipt = brokerTerminalReceipt(result);
    return Object.freeze({
      shellId: entry.shellId,
      executionId: entry.executionId,
      state: result.ownedResourcesZero ? "complete" as const : "cleanup-unproven" as const,
      ownedResourcesZero: result.ownedResourcesZero,
      requiresExternalRelease: !result.ownedResourcesZero,
      workloadStatus: result.status,
      ...(receipt === undefined ? {} : { receipt: Object.freeze(receipt) }),
      ...(!result.ownedResourcesZero
        ? { failure: "workload-broker:cleanup-unproven" }
        : {}),
    });
  };

  const cleanupBrokerEntry = async (
    entry: BrokerBackgroundShellEntry,
    reason: "session-disposal" | "application-shutdown",
    signal?: AbortSignal,
  ): Promise<BrokerBackgroundCleanupOutcome> => {
    if (entry.terminalReceipt?.ownedResourcesZero === true) {
      return Object.freeze({
        shellId: entry.shellId,
        executionId: entry.executionId,
        state: "complete" as const,
        ownedResourcesZero: true,
        requiresExternalRelease: false,
        ...(entry.workloadStatus === undefined
          ? {}
          : { workloadStatus: entry.workloadStatus }),
        receipt: Object.freeze({ ...entry.terminalReceipt }),
      });
    }
    try {
      const runtime = await loadBrokerRuntime();
      const result = await runtime.executeBrokeredWorkloadRequest(
        entry.capability,
        "shell.kill",
        {
          executionId: entry.executionId,
          signal: "SIGKILL",
          timeoutMs: BROKER_BACKGROUND_KILL_TIMEOUT_MS,
        },
        { parent: entry.parent, actor: { kind: "host-cleanup", reason } },
        signal,
      );
      // Runtime transport/capability failures resolve as ToolExecutionResult;
      // they are not promise rejections and must remain cleanup-unproven.
      if (isBrokerTransportToolResult(result)) {
        const code = typeof result.metadata?.code === "string"
          ? result.metadata.code
          : undefined;
        return unprovenCleanup(
          entry,
          code === undefined ? result.output : `workload-broker:${code}`,
        );
      }
      if (result.executionId !== entry.executionId ||
          brokerKillUnreadSuffix(result.output, entry.offset, result.nextOffset) === null) {
        return unprovenCleanup(entry, "workload-broker:background-binding-mismatch");
      }
      return cleanTerminalOutcome(entry, result);
    } catch (error) {
      return unprovenCleanup(
        entry,
        error instanceof Error ? error.message : "workload-broker:unexpected-failure",
      );
    }
  };

  const trackBrokerCleanup = (
    cleanup: MutableBrokerSessionCleanup,
    entry: BrokerBackgroundShellEntry,
    reason: "session-disposal" | "application-shutdown",
    signal?: AbortSignal,
  ): void => {
    const request = cleanupBrokerEntry(entry, reason, signal).then((outcome) => {
      // Test reset or a future lifecycle owner may replace the report. A late
      // request must not mutate a different session generation's evidence.
      if (brokerCleanup.get(cleanup.sessionId) !== cleanup) return;
      cleanup.outcomes.set(entry.shellId, outcome);
      cleanup.pending.delete(entry.shellId);
    });
    cleanup.pending.set(entry.shellId, request);
    void request;
  };

  const disposeBrokerSession = (
    sessionId: string,
    reason: "session-disposal" | "application-shutdown",
    signal?: AbortSignal,
  ): number => {
    let disposed = 0;
    for (const entry of [...brokerShells.values()]) {
      if (entry.sessionId !== sessionId) continue;
      brokerShells.delete(entry.shellId);
      entry.observation?.revoke();
      disposed += 1;
      let cleanup = brokerCleanup.get(sessionId);
      if (cleanup === undefined) {
        cleanup = {
          sessionId,
          requested: 0,
          pending: new Map(),
          outcomes: new Map(),
        };
        brokerCleanup.set(sessionId, cleanup);
      }
      cleanup.requested += 1;
      trackBrokerCleanup(cleanup, entry, reason, signal);
    }
    return disposed;
  };

  const notify = (entry: BackgroundShellEntry): void => {
    for (const wake of [...entry.waiters]) wake();
  };

  const append = (entry: BackgroundShellEntry, chunk: string): void => {
    entry.observation?.write(chunk);
    if (entry.outputTruncated) return;
    const remaining = MAX_OUTPUT_CHARS - entry.output.length;
    if (remaining <= 0) {
      entry.outputTruncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      entry.output += chunk;
    } else {
      entry.output += chunk.slice(0, remaining);
      entry.outputTruncated = true;
    }
    if (entry.output.length > entry.readCursor) notify(entry);
  };

  const snapshot = (entry: BackgroundShellEntry): BackgroundShellReadResult => {
    const output = entry.output.slice(entry.readCursor);
    entry.readCursor = entry.output.length;
    return {
      shellId: entry.shellId,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      output,
      truncated: entry.outputTruncated,
      command: entry.command,
    };
  };

  const owned = (sessionId: string, shellId: string): BackgroundShellEntry | undefined => {
    const entry = shells.get(shellId);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    return entry;
  };

  const ownedBroker = (
    sessionId: string,
    shellId: string,
  ): BrokerBackgroundShellEntry | undefined => {
    const entry = brokerShells.get(shellId);
    return entry?.sessionId === sessionId ? entry : undefined;
  };

  const stopOwned = (sessionId: string, shellId: string): BackgroundShellEntry | undefined => {
    const entry = owned(sessionId, shellId);
    if (!entry) return undefined;
    if (entry.status === "running") entry.status = "killed";
    entry.terminate();
    notify(entry);
    return entry;
  };

  const applyBrokerTerminal = (
    entry: BrokerBackgroundShellEntry,
    result: WorkloadBrokerSuccessResults["shell.read"] |
      WorkloadBrokerSuccessResults["shell.kill"],
  ): void => {
    entry.offset = result.nextOffset;
    entry.truncated ||= result.truncated;
    entry.status = brokerTerminalStatus(result.status);
    if (result.status !== "running") {
      entry.exitCode = result.exitCode;
      entry.signal = result.signal;
      entry.terminalReceipt = brokerTerminalReceipt(result);
      entry.workloadStatus = result.status;
      entry.completion = workloadCompletionSentence(result);
      entry.isError = workloadTerminalIsError(result);
      entry.observation?.finish(result.exitCode, result.cancelled ? "cancelled" : workloadTerminalIsError(result) ? "failed" : "completed");
    }
  };

  return {
    register({ sessionId, command, child, startedAt, killProcessGroup = false, captureOutput = true, initialOutput = "", initialOutputTruncated = false, observation }): string {
      // Keep the registry lean within a long-lived session: drop this session's
      // already-finished shells whose output has been fully read before adding a
      // new one. Never-read terminal shells are preserved (the model may still
      // fetch their final output); everything else is reaped at session end via
      // disposeSession(). This bounds in-session growth without surprising an
      // active poller.
      for (const e of [...shells.values()]) {
        if (
          e.sessionId === sessionId &&
          e.status !== "running" &&
          e.readCursor > 0 &&
          e.readCursor >= e.output.length
        ) {
          e.terminate();
          shells.delete(e.shellId);
        }
      }
      const shellId = randomUUID();
      const stopTracking = trackManagedChildProcess(child, {
        label: "tool:bash:background",
        killProcessGroup,
      });
      let terminationRequested = false;
      const terminate = (): void => {
        // Never re-signal a released handle: its numeric PID may be reused.
        if (terminationRequested) return;
        terminationRequested = true;
        const termination = forceKillManagedChildProcess(child, "background-shell-ended");
        if (termination) {
          const pending = localCleanup.get(sessionId) ?? new Set<Promise<void>>();
          localCleanup.set(sessionId, pending);
          pending.add(termination);
          void termination.then(() => {
            pending.delete(termination);
            if (pending.size === 0 && localCleanup.get(sessionId) === pending) localCleanup.delete(sessionId);
          });
        }
      };
      const entry: BackgroundShellEntry = {
        shellId,
        sessionId,
        command,
        child,
        status: "running",
        exitCode: null,
        signal: null,
        output: initialOutput.slice(0, MAX_OUTPUT_CHARS),
        outputTruncated: initialOutputTruncated,
        readCursor: 0,
        startedAt,
        stopTracking,
        terminate,
        waiters: new Set(),
        observation,
      };
      shells.set(shellId, entry);

      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const onStdout = (c: Buffer): void => append(entry, decoders.stdout.write(c));
      const onStderr = (c: Buffer): void => append(entry, decoders.stderr.write(c));
      if (captureOutput) {
        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
      }
      // A descendant may retain the output pipes after its parent exits, so
      // close is too late to own cleanup. End the owned group at root exit.
      child.once("exit", () => {
        if (killProcessGroup) terminate();
        else terminationRequested = true;
      });
      child.on("close", (code, signal: NodeJS.Signals | null = null) => {
        if (captureOutput) append(entry, decoders.stdout.end() + decoders.stderr.end());
        entry.exitCode = code;
        entry.signal = signal;
        if (entry.status === "running") {
          entry.status = signal === null ? "exited" : "killed";
        }
        observation?.finish(code, entry.status === "killed" ? "cancelled" : entry.status === "failed" || code !== 0 ? "failed" : "completed");
        notify(entry);
      });
      child.on("error", (err) => {
        if (entry.status === "running") {
          entry.status = "failed";
          append(entry, `\n[spawn error] ${err.message}\n`);
        }
        observation?.finish(null, "failed");
        notify(entry);
      });
      return shellId;
    },

    registerBroker({ sessionId, command, executionId, capability, parent, offset, observation }): string {
      for (const entry of [...brokerShells.values()]) {
        if (
          entry.sessionId === sessionId &&
          entry.status !== "running" &&
          entry.terminalReceipt?.ownedResourcesZero === true
        ) {
          brokerShells.delete(entry.shellId);
        }
      }
      const shellId = randomUUID();
      brokerShells.set(shellId, {
        shellId,
        sessionId,
        command,
        executionId,
        capability,
        parent,
        offset,
        status: "running",
        exitCode: null,
        signal: null,
        truncated: false,
        capturedChars: 0,
        observation,
      });
      return shellId;
    },

    isBrokerShell(sessionId, shellId): boolean {
      return ownedBroker(sessionId, shellId) !== undefined;
    },

    async readBroker(sessionId, shellId, waitMs, actor, signal, waitFor) {
      const entry = ownedBroker(sessionId, shellId);
      if (!entry) return undefined;
      signal?.throwIfAborted();
      const condition = backgroundOutputWaitForSchema.parse(waitFor);
      const boundedWaitMs = backgroundOutputWaitSchema.parse(waitMs);
      let output = "";
      if (entry.status === "running") {
        const maximumReadBytes = MAX_OUTPUT_CHARS * 4;
        const runtime = await loadBrokerRuntime();
        const result = await runtime.executeBrokeredWorkloadRequest(
          entry.capability,
          "shell.read",
          {
            executionId: entry.executionId,
            offset: entry.offset,
            maxBytes: maximumReadBytes,
            waitMs: boundedWaitMs,
            waitFor: condition,
          },
          { parent: entry.parent, actor },
          signal,
        );
        if (isBrokerTransportToolResult(result)) {
          return withBrokerTransportMetadata(result);
        }
        if (
          result.executionId !== entry.executionId ||
          result.offset !== entry.offset ||
          !isExactBrokerReadRange({
            offset: result.offset,
            nextOffset: result.nextOffset,
            output: result.output,
            maxBytes: maximumReadBytes,
          })
        ) {
          return brokerFailureResult(new Error("workload-broker:background-binding-mismatch"));
        }
        entry.observation?.write(result.output, { truncated: result.truncated });
        applyBrokerTerminal(entry, result);
        output += captureBrokerBackgroundOutput(entry, result.output);
      }
      return brokerBackgroundSnapshot(entry, output);
    },

    async killBroker(sessionId, shellId, actor, signal) {
      const entry = ownedBroker(sessionId, shellId);
      if (!entry) return undefined;
      const runtime = await loadBrokerRuntime();
      const result = await runtime.executeBrokeredWorkloadRequest(
        entry.capability,
        "shell.kill",
        {
          executionId: entry.executionId,
          signal: "SIGKILL",
          timeoutMs: BROKER_BACKGROUND_KILL_TIMEOUT_MS,
        },
        { parent: entry.parent, actor },
        signal,
      );
      if (isBrokerTransportToolResult(result)) {
        return withBrokerTransportMetadata(result);
      }
      const unreadOutput = brokerKillUnreadSuffix(
        result.output,
        entry.offset,
        result.nextOffset,
      );
      if (result.executionId !== entry.executionId || unreadOutput === null) {
        return brokerFailureResult(new Error("workload-broker:background-binding-mismatch"));
      }
      entry.observation?.write(unreadOutput, { truncated: result.truncated });
      applyBrokerTerminal(entry, result);
      return brokerBackgroundSnapshot(
        entry,
        captureBrokerBackgroundOutput(entry, unreadOutput),
      );
    },

    read(sessionId, shellId): BackgroundShellReadResult | undefined {
      const entry = owned(sessionId, shellId);
      return entry ? snapshot(entry) : undefined;
    },

    list(sessionId): ShellTask[] {
      const local = [...shells.values()].filter((entry) => entry.sessionId === sessionId).map((entry): ShellTask => ({
        shellId: entry.shellId, command: entry.command, startedAt: entry.startedAt,
        status: entry.status, backgrounded: true, canBackground: false,
        canStop: entry.status === "running", ...shellTaskOutputPreview(entry.output, entry.outputTruncated),
      }));
      // Broker lifecycle actions require a fresh tool authority; the UI does not mint one.
      return [...local, ...[...brokerShells.values()].filter((entry) => entry.sessionId === sessionId).map((entry): ShellTask => ({
        shellId: entry.shellId, command: entry.command, startedAt: "", status: entry.status,
        backgrounded: true, canBackground: false, canStop: false, output: "", outputTruncated: false,
      }))];
    },

    appendOutput(sessionId, shellId, chunk): void {
      const entry = owned(sessionId, shellId);
      if (entry) append(entry, chunk);
    },

    async waitForOutput(sessionId, shellId, waitMs, signal, waitFor): Promise<void> {
      const delay = backgroundOutputWaitSchema.parse(waitMs);
      const condition = backgroundOutputWaitForSchema.parse(waitFor);
      signal?.throwIfAborted();
      const entry = owned(sessionId, shellId);
      if (!entry || delay === 0 || entry.status !== "running"
        || (condition === "output" && entry.output.length > entry.readCursor)) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          entry.waiters.delete(wake);
          signal?.removeEventListener("abort", abort);
        };
        const finish = (): void => {
          cleanup();
          resolve();
        };
        const wake = (): void => {
          if (condition === "completion" && entry.status === "running" && owned(sessionId, shellId) === entry) return;
          finish();
        };
        const abort = (): void => {
          cleanup();
          reject(signal?.reason);
        };
        const timer = setTimeout(finish, delay);
        entry.waiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },

    kill(sessionId, shellId): BackgroundShellReadResult | undefined {
      const entry = stopOwned(sessionId, shellId);
      return entry ? snapshot(entry) : undefined;
    },

    stop(sessionId, shellId): boolean { return stopOwned(sessionId, shellId) !== undefined; },

    async waitForLocalCleanup(sessionId): Promise<void> {
      while (localCleanup.has(sessionId)) await Promise.all([...localCleanup.get(sessionId)!]);
    },

    disposeSession(sessionId): number {
      let disposed = 0;
      for (const entry of [...shells.values()]) {
        if (entry.sessionId !== sessionId) continue;
        entry.terminate();
        entry.observation?.revoke();
        shells.delete(entry.shellId);
        notify(entry);
        disposed += 1;
      }
      return disposed + disposeBrokerSession(sessionId, "session-disposal");
    },

    disposeAllBrokerShells(signal?: AbortSignal): number {
      const sessionIds = new Set(
        [...brokerShells.values()].map((entry) => entry.sessionId),
      );
      let disposed = 0;
      for (const sessionId of sessionIds) {
        disposed += disposeBrokerSession(sessionId, "application-shutdown", signal);
      }
      return disposed;
    },

    getBrokerCleanupReport(sessionId): BrokerSessionCleanupReport | undefined {
      const cleanup = brokerCleanup.get(sessionId);
      return cleanup === undefined ? undefined : cleanupReport(cleanup);
    },

    async waitForBrokerCleanup(sessionId): Promise<BrokerSessionCleanupReport | undefined> {
      const cleanup = brokerCleanup.get(sessionId);
      if (cleanup === undefined) return undefined;
      while (cleanup.pending.size > 0) {
        await Promise.all([...cleanup.pending.values()]);
      }
      return cleanupReport(cleanup);
    },

    async settleSessionCleanup(sessionId): Promise<BrokerSessionCleanupReport | undefined> {
      const cleanup = brokerCleanup.get(sessionId);
      if (cleanup === undefined) return undefined;
      while (cleanup.pending.size > 0) {
        await Promise.all([...cleanup.pending.values()]);
      }
      const report = cleanupReport(cleanup);
      // Object identity is the cleanup-generation binding. A late waiter must
      // never consume a newer generation installed under the same session id.
      if (report.state === "complete" && brokerCleanup.get(sessionId) === cleanup) {
        brokerCleanup.delete(sessionId);
      }
      return report;
    },

    async waitForAllBrokerCleanup(): Promise<readonly BrokerSessionCleanupReport[]> {
      // Admission is sealed before app shutdown calls this method, but loop in
      // case a session-dispose microtask registered cleanup immediately before
      // the seal became visible to its caller.
      while (true) {
        const pending = [...brokerCleanup.values()].flatMap(
          (cleanup) => [...cleanup.pending.values()],
        );
        if (pending.length === 0) break;
        await Promise.all(pending);
      }
      return Object.freeze(
        [...brokerCleanup.values()].map((cleanup) => cleanupReport(cleanup)),
      );
    },

    _resetForTest(): void {
      for (const entry of [...shells.values()]) {
        entry.stopTracking();
        entry.observation?.revoke();
      }
      for (const entry of brokerShells.values()) entry.observation?.revoke();
      const entries = [...shells.values()];
      shells.clear();
      localCleanup.clear();
      brokerShells.clear();
      brokerCleanup.clear();
      for (const entry of entries) notify(entry);
    },
    _size(): number {
      return shells.size + brokerShells.size;
    },
  };
}

/** Process-wide singleton, mirroring managed-child-processes.ts. */
export const backgroundShellManager: BackgroundShellManager = createManager();

const foregroundShellTasks = new Map<string, {
  sessionId: string;
  snapshot: () => ShellTask;
  background: () => ShellTaskActionResult;
}>();

export function listShellTasks(sessionId: string): ShellTask[] {
  return [
    ...[...foregroundShellTasks.values()].filter((task) => task.sessionId === sessionId).map((task) => task.snapshot()),
    ...backgroundShellManager.list(sessionId),
  ];
}

export function controlShellTask(sessionId: string, action: ShellTaskAction, shellId?: string): ShellTaskActionResult {
  if (action === "background") {
    const task = shellId === undefined
      ? [...foregroundShellTasks.values()].reverse().find((task) => task.sessionId === sessionId)
      : foregroundShellTasks.get(shellId);
    if (!task || task.sessionId !== sessionId) return { ok: false, error: "shell-not-found" };
    return task.background();
  }
  if (shellId === undefined || backgroundShellManager.isBrokerShell(sessionId, shellId)) {
    return { ok: false, error: "shell-not-found" };
  }
  // Stopping cancels this session's existing child; it never starts another execution.
  return backgroundShellManager.stop(sessionId, shellId)
    ? { ok: true, shellId }
    : { ok: false, error: "shell-not-found" };
}

/**
 * The one shell teardown for an ending session, parent or sub-agent: stop its
 * background shells, forget its saved working directory, and settle any
 * brokered cleanup. The caller decides what an unproven cleanup means.
 */
export async function endShellSession(sessionId: string): Promise<BrokerSessionCleanupReport | undefined> {
  backgroundShellManager.disposeSession(sessionId);
  await backgroundShellManager.waitForLocalCleanup(sessionId);
  clearShellSessionCwd(sessionId);
  return await backgroundShellManager.settleSessionCleanup(sessionId);
}

/**
 * SafeBashExecutor (Tier A1) — non-interactive shell execution with
 * preflight detection for interactive scaffolds, timeout handling with
 * partial-output drain, graceful terminate→kill ladder, and output cap.
 *
 * AF3: the `cwd` sandbox check in `execute()` is a **heuristic hint**,
 * not a sandbox boundary. A user-supplied `input.cwd` that points outside
 * the session cwd is rejected before spawn, but the real enforcement of
 * which commands may run lives in {@link ../main/bash-ast-validator.ts}.
 * Do not rely on this function to stop shell escapes — only BashAstValidator
 * (Step 2.5 of the tool executor pipeline) prevents dangerous syntax.
 */

const hostShellExecutionFields = {
  executionMode: z.enum(["default", "host"]).optional().describe(
    "Use default execution, or explicitly request one foreground execution as the current user without OS sandboxing. Host requires a fresh desktop allow-once approval.",
  ),
  justification: z.string().optional().describe("Required nonblank reason for explicit host execution"),
};

/**
 * Opt-in memory scope shared by bash and powershell: the command and its cwd
 * override. `run_in_background` keeps exact-args identity — a background
 * process outlives the turn — and `executionMode: "host"` is one-shot and
 * never recorded, so both fall back to the exact input.
 */
function shellApprovalMemoryScope(input: unknown): ApprovalMemoryScope | undefined {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (typeof args.command !== "string" || args.command.length === 0) return undefined;
  if (args.run_in_background === true || args.executionMode === "host") return undefined;
  return { kind: "command", commandSha256: sha256Hex(args.command), cwd: typeof args.cwd === "string" ? args.cwd : null };
}

function validateHostShellExecutionRequest(
  input: { executionMode?: "default" | "host"; justification?: string; run_in_background?: boolean },
  ctx: z.RefinementCtx,
): void {
  if (input.executionMode !== "host") return;
  if (!input.justification?.trim()) {
    ctx.addIssue({ code: "custom", path: ["justification"], message: "Host execution requires a nonblank justification" });
  }
  if (input.run_in_background === true) {
    ctx.addIssue({ code: "custom", path: ["run_in_background"], message: "Host execution must run in the foreground" });
  }
}

export const BashToolInputSchema = z.object({
  ...hostShellExecutionFields,
  command: z.string().min(1).describe("Shell command to execute"),
  cwd: z.string().optional().describe(
    "Working directory for this call only; a relative path resolves from the session directory. " +
      "A `cd` in a foreground command carries into later bash calls of this session while the " +
      "directory stays inside the workspace or an allowed directory. Environment variables, " +
      "functions, and shell options do not persist between calls.",
  ),
  // Optional-but-defaulted and strictly positive: a command always has a
  // deadline, so nothing waits forever. Local execution has no upper bound;
  // the brokered workload protocol has the model-visible maximum documented
  // below because its capability lifetime is bounded.
  timeoutSeconds: shellTimeoutSchema,
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background and return a shellId immediately instead of waiting. " +
        "Read incremental output with bash_output and stop it with bash_kill. `timeoutSeconds` " +
        "is the maximum lifetime in a brokered disposable workload (up to 3600 seconds); " +
        "plain local background shells instead live until stopped or the session ends. The shell is bound to this session and is " +
        "terminated when the session ends, so it is for work you will read back during this " +
        "session -- not for leaving a server, daemon or worker running for something that " +
        "inspects it afterwards. Available on plain host and brokered disposable routes. Under " +
        "the OS sandbox (ASRT), the command runs synchronously and the result is flagged " +
        "backgroundUnavailable, because the sandbox cannot safely run concurrent commands.",
    ),
}).superRefine(validateHostShellExecutionRequest);

const INTERACTIVE_SCAFFOLDS = [
  "create-next-app",
  "npm create ",
  "pnpm create ",
  "yarn create ",
  "bun create ",
  "pnpm dlx ",
  "npm init ",
  "pnpm init ",
  "yarn init ",
  "bunx create-",
  "npx create-",
];

const NON_INTERACTIVE_MARKERS = [
  "--yes",
  " -y",
  "--skip-install",
  "--defaults",
  "--non-interactive",
  "--ci",
];

const canonicalBashTools = new WeakSet<object>();

export function isCanonicalBashTool(tool: unknown): tool is BashTool {
  return typeof tool === "object" && tool !== null && canonicalBashTools.has(tool);
}

export class BashTool extends ZodTool<typeof BashToolInputSchema> {
  readonly awaitCancellationSettlement = true;
  constructor() {
    super();
    if (new.target === BashTool) canonicalBashTools.add(this);
  }

  readonly name = "bash";
  readonly description =
    "Run a non-interactive shell command in the local repository under permission and path checks. " +
    "Prefer the dedicated tools when one fits: grep_files instead of grep/rg, glob_files or list_files instead of " +
    "find/ls, read_file instead of cat/head/tail, edit_file or apply_patch instead of sed -i, write_file instead of " +
    "echo/heredoc redirects. Quote paths that contain spaces. " +
    "A command runs until it exits or `timeoutSeconds` (default 120) elapses; for a slow build or test, pass a " +
    "larger timeoutSeconds rather than retrying the same one. For a long-running process you will check on, set " +
    "run_in_background, then read its output with bash_output (waitFor/waitMs) and stop it with bash_kill. " +
    "Output is previewed up to 12,000 characters; when a result says it was truncated, page the rest with " +
    "read_tool_result_chunk instead of rerunning the command. " +
    "Recursive copying and archive creation/extraction remain blocked in this shell: use copy_path for files or " +
    "directory trees and extract_archive for tar or gzip-compressed tar extraction. Both require an absent exact " +
    "destination with an existing parent; no overwrite or merge. ZIP extraction and archive creation have no " +
    "built-in equivalent.";
  readonly inputSchema = BashToolInputSchema;
  override readonly category: ToolCategory = "shell";

  override isReadOnly(_input: unknown): boolean {
    return false;
  }

  approvalCacheKey(input: unknown): string {
    const parsed = BashToolInputSchema.parse(input);
    return sha256Hex(JSON.stringify({ command: parsed.command, cwd: parsed.cwd ?? null }));
  }

  // The executor appends the sealed execution plan (host vs sandboxed) to the
  // memory key, so a sandboxed approval never answers for another substrate.
  approvalMemoryScope(input: unknown): ApprovalMemoryScope | undefined {
    return shellApprovalMemoryScope(input);
  }

  protected async executeTyped(
    input: z.infer<typeof BashToolInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    ctx.abortSignal?.throwIfAborted();
    // Preflight: interactive scaffolds would hang on stdin.
    const preflightError = preflightInteractiveCommand(input.command);
    if (preflightError !== null) {
      return {
        output: preflightError,
        isError: true,
        metadata: { interactiveRequired: true },
      };
    }

    let resolvedCwd: string;
    try {
      if (isWorkloadBrokerActive()) {
        const runtime = await import("../workload/runtime.js");
        const capability = await runtime.acquireBrokeredWorkloadCapability(ctx.abortSignal);
        resolvedCwd = runtime.resolveBrokeredWorkloadPath(capability, input.cwd ?? ".");
      } else {
        resolvedCwd = resolveHostShellWorkingDirectory(ctx.cwd, input.cwd);
      }
    } catch (error) {
      return brokerFailureResult(error);
    }
    // §691: the executor seals the host-shell substrate before permission
    // routing. The supplied plan must come from the live host provider; a
    // structural lookalike cannot downgrade an active ASRT route to plain spawn.
    const suppliedHostShellPlan = ctx.hostShellExecutionPlan;
    if (
      suppliedHostShellPlan !== undefined &&
      !isIssuedHostShellExecutionPlan(suppliedHostShellPlan)
    ) {
      return {
        output: "spawn failed: shell execution plan was not issued by the host.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    const hostShellPlan = suppliedHostShellPlan ?? getHostShellExecutionPlan(input.executionMode);
    if (hostShellPlan.executionRequest !== (input.executionMode ?? "default")) {
      return { output: "Shell execution request does not match the host plan.", isError: true };
    }
    const executionAuthority = consumeShellExecutionRoute({
      context: ctx,
      legacyPlan: hostShellPlan,
      toolName: "bash",
      command: input.command,
      cwd: resolvedCwd,
      timeoutSeconds: input.timeoutSeconds,
      background: input.run_in_background ?? false,
    });
    const disposableExecution = executionAuthority?.route === "disposable-container";
    let brokeredAuthority: BrokeredShellAuthority | null;
    try {
      brokeredAuthority = await acquireBrokeredShellAuthority(
        executionAuthority,
        ctx.executionRouteGrant,
      );
    } catch (error) {
      return brokerFailureResult(error);
    }
    const identity = { command: input.command, requestedCwd: input.cwd, executionCwd: ctx.cwd, resolvedCwd,
      toolUseId: typeof ctx.metadata.toolUseId === "string" ? ctx.metadata.toolUseId : undefined, plan: hostShellPlan,
      verifiedShellCommand: ctx.verifiedShellCommand };
    if (brokeredAuthority !== null) {
      if (ctx.verifiedShellCommand !== undefined) return brokerFailureResult(new Error("workload-broker:unexpected-native-shell-proof"));
      if (ctx.preparedShellInvocation !== undefined) {
        disposePreparedShellInvocation(ctx.preparedShellInvocation);
        return brokerFailureResult(new Error("workload-broker:unexpected-host-shell-preparation"));
      }
      try {
        return input.run_in_background === true
          ? await startBrokeredBash(brokeredAuthority, input, resolvedCwd, ctx)
          : await runBrokeredBash(brokeredAuthority, input, resolvedCwd, ctx);
      } catch (error) {
        return brokerFailureResult(error);
      }
    }
    if (disposableExecution && ctx.verifiedShellCommand !== undefined) {
      return { output: "Verified shell commands require a native host execution route.", isError: true };
    }
    const cwdViolation = validateShellWorkingDirectory(
      resolvedCwd,
      ctx.cwd,
      ctx.extraAllowedDirectories,
    );
    if (cwdViolation) {
      const kind = cwdViolation.startsWith("Sensitive")
        ? "sensitive-path"
        : "sandbox-boundary";
      if (!disposableGrantRelaxesPathPolicy(executionAuthority, kind)) {
        return { output: cwdViolation, isError: true };
      }
    }
    if (
      !disposableExecution &&
      requiresExplicitHostShellApproval(hostShellPlan) &&
      !ctx.hostShellExecutionPermit
    ) {
      return { output: "spawn failed: this host shell execution requires a one-shot host approval permit.", isError: true, metadata: { sandboxed: false, isolation: "none" } };
    }
    let prepared: PreparedShellInvocation;
    try { prepared = ctx.preparedShellInvocation ?? prepareShellInvocation(identity, ctx.abortSignal); }
    catch (error) {
      ctx.abortSignal?.throwIfAborted();
      return { output: `spawn failed: shell preparation failed: ${(error as Error).message}`, isError: true,
        metadata: { sandboxed: false, isolation: "unavailable" } };
    }
    if (!matchesPreparedShellInvocation(prepared, identity)) {
      return { output: "spawn failed: shell preparation does not match this invocation.", isError: true };
    }
    const verifiedIdentity: VerifiedShellIdentity = { command: input.command, dialect: "bash", cwd: resolvedCwd };
    const holdsOutput = verifiedShellRequiresResultCheck(ctx.verifiedShellCommand, verifiedIdentity);
    // Checked native reads release only bounded final output after reinspection.
    const outputCapture = holdsOutput ? undefined : captureFactoryFromContext(ctx);
    const outputProgress = holdsOutput ? undefined : toolOutputProgressFromMetadata(ctx.metadata);
    try {
    const commandPathViolation = findShellPathPolicyViolation(
      input.command,
      resolvedCwd,
      ctx.cwd,
      ctx.extraAllowedDirectories,
      ctx.blockReadsOutsideWorkingDirectories === true,
      preparedShellFacts(prepared),
    );
    if (
      commandPathViolation &&
      !disposableGrantRelaxesPathPolicy(executionAuthority, commandPathViolation.kind)
    ) {
      return { output: commandPathViolation.reason, isError: true };
    }


    // Explicit host requests and the Windows Plan B select a plain host child.
    // Its opaque permit exists only after an allow-once approval (or, for an
    // explicit host request, a matching allow rule) for this exact
    // command/cwd/tool-use tuple and is consumed before spawn.
    let hostSpawnAuthorization: HostShellSpawnAuthorization | undefined;
    if (!disposableExecution && requiresExplicitHostShellApproval(hostShellPlan)) {
      const spawnAuthorization = consumeHostShellExecutionPermitForSpawn({
        permit: ctx.hostShellExecutionPermit,
        plan: hostShellPlan,
        toolName: "bash",
        toolUseId:
          typeof ctx.metadata.toolUseId === "string"
            ? ctx.metadata.toolUseId
            : undefined,
        command: input.command,
        requestedCwd: input.cwd,
        executionCwd: ctx.cwd,
        resolvedCwd,
        timeoutSeconds: input.timeoutSeconds,
        executionMode: input.executionMode ?? "default",
        justification: input.justification,
        runInBackground: input.run_in_background ?? false,
        allowedDirectories: canonicalizeHostShellAllowedDirectories(ctx.extraAllowedDirectories),
      });
      if (spawnAuthorization === undefined) {
        return {
          output: `spawn failed: ${HOST_SHELL_AUTHORIZATION_REVOKED_ERROR}`,
          isError: true,
          metadata: { sandboxed: false, isolation: "none" },
        };
      }
      hostSpawnAuthorization = spawnAuthorization;
    }
    if (!disposableExecution && hostShellPlan.mode === "blocked") {
      return {
        output:
          "spawn failed: ASRT shell tools require filesystem and process isolation; " +
          "the active sandbox is only partially confined.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    if (!disposableExecution && hostShellPlan.mode === "asrt" && hostShellPlan.substrate === "mxc") {
      // Git Bash (MSYS2) cannot start inside an MXC container: its runtime is
      // denied the named-object directory it creates at startup (measured,
      // 0xC0000022, in every session). The PowerShell tool runs contained;
      // an explicit host request still runs Bash after approval.
      return {
        output: MXC_BASH_UNAVAILABLE_MESSAGE,
        isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
      };
    }
    if (hostShellPlan.mode === "asrt") {
      // The executor binds before approval. Direct tool callers bind after the
      // same path check; an existing binding never consults ambient state again.
      bindPreparedShellExecutableReadPaths(prepared);
      // Write-jail = canonicalized union of the owner plugin sandbox root
      // (when plugin-owned) and the in-scope allowed directories
      // (cwd ∪ user-authorized extras). cwd stays readable but is no
      // longer the write boundary.
      const writePaths = deriveSandboxWritePaths({
        ...(ctx.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: ctx.ownerPluginSandboxRoot }
          : {}),
        allowedDirectories: [resolvedCwd, ...ctx.extraAllowedDirectories],
      });
      const checked = await checkedShellResult(() => spawnWithSandbox(
        input.command,
        resolvedCwd,
        writePaths,
        input.timeoutSeconds, prepared, ctx.abortSignal, outputCapture,
        outputProgress, holdsOutput,
      ), ctx.verifiedShellCommand, verifiedIdentity);
      if (checked.refused) return checked.result;
      return withBackgroundUnavailable(
        trackSessionCwd(checked.result, resolvedCwd, ctx),
        input.run_in_background === true,
      );
    }

    // Clean plain host-shell path — the ONLY path that may background. The ASRT
    // sandbox is a process-global singleton (cleanupAfterCommand), so a
    // backgrounded ASRT command running concurrently with the next tool would
    // corrupt the shared sandbox state; background execution is therefore
    // confined to the unsandboxed plain path, and the one-shot-permit routes
    // (explicit host, Windows Plan B: requiresExplicitUserApproval) are
    // excluded so a one-shot-approved command cannot outlive its approval. A
    // requested-but-unavailable sandbox follows the normal rules and may
    // background like sandbox-off.
    if (
      input.run_in_background === true &&
      !holdsOutput &&
      (!hostShellPlan.requiresExplicitUserApproval || disposableExecution)
    ) {
      const result = spawnBackground(input.command, resolvedCwd, sessionIdFromContext(ctx), prepared, shellObservationSandbox(hostShellPlan, disposableExecution));
      return disposableExecution ? withDisposableExecutionMetadata(result) : result;
    }

    const checked = await checkedShellResult(() => spawnWithTimeout(
      input.command, hostSpawnAuthorization?.cwdIdentity.realpath ?? resolvedCwd, input.timeoutSeconds, prepared, ctx.abortSignal,
      outputCapture, outputProgress, hostSpawnAuthorization,
      holdsOutput ? undefined : sessionIdFromContext(ctx), !holdsOutput && !hostShellPlan.requiresExplicitUserApproval && !disposableExecution && process.platform !== "win32",
      holdsOutput, shellObservationSandbox(hostShellPlan, disposableExecution),
    ), ctx.verifiedShellCommand, verifiedIdentity);
    if (checked.refused) return checked.result;
    // A disposable route's directory belongs to its own lifecycle, not the
    // host session's.
    const plainResult = disposableExecution
      ? withoutReportedCwd(checked.result)
      : trackSessionCwd(checked.result, resolvedCwd, ctx);
    if (disposableExecution) {
      return withBackgroundUnavailable(
        withDisposableExecutionMetadata(plainResult),
        input.run_in_background === true,
      );
    }
    if (!recordsUnsandboxedExecutionPlan(hostShellPlan)) {
      return withBackgroundUnavailable(plainResult, input.run_in_background === true);
    }
    return withBackgroundUnavailable(
      {
        ...plainResult,
        metadata: {
          ...plainResult.metadata,
          sandboxed: false,
          isolation: "none",
          sandboxExecutionPlan: getHostShellExecutionPlanAuditProjection(hostShellPlan),
        },
      },
      input.run_in_background === true,
    );
    } finally {
      disposePreparedShellInvocation(prepared);
    }
  }
}

/**
 * A plain child that ran without the OS isolation the user asked for, or by
 * explicit request, carries its public plan projection in the result so the
 * chat and audit can name why ("sandbox unavailable", "explicit host"). An
 * ordinary sandbox-off run does not: the user chose it.
 */
function recordsUnsandboxedExecutionPlan(plan: HostShellExecutionPlan): boolean {
  if (plan.requiresExplicitUserApproval) return true;
  // Not requested (setting off, or no sandbox on this platform) is the
  // ordinary sandbox-off run; every other reason is a degradation to name.
  return plan.fallbackReason !== "none"
    && plan.fallbackReason !== "disabled-by-setting"
    && plan.fallbackReason !== "platform-unsupported";
}

function withoutReportedCwd(result: SpawnResult): SpawnResult {
  const { reportedCwd: _reportedCwd, ...rest } = result;
  return rest;
}

/**
 * Carry a foreground command's final directory into the session. Only a
 * directory change made by the command itself moves the session: a per-call
 * `cwd` override that the command did not leave stays per-call. A directory
 * outside the workspace and allowed directories resets the session to the
 * workspace root and says so in the result.
 */
function trackSessionCwd(result: SpawnResult, startCwd: string, ctx: ToolExecutionContext): SpawnResult {
  const reported = result.reportedCwd;
  const rest = withoutReportedCwd(result);
  if (reported === undefined) return rest;
  const finalCwd = pathResolve(reported);
  if (finalCwd === pathResolve(startCwd)) return rest;
  const sessionId = ctx.metadata.sessionId;
  const violation = validateShellWorkingDirectory(finalCwd, ctx.cwd, ctx.extraAllowedDirectories);
  if (violation === null) {
    recordShellSessionCwd(sessionId, ctx.cwd, finalCwd);
    return rest;
  }
  recordShellSessionCwd(sessionId, ctx.cwd, ctx.cwd);
  return {
    ...rest,
    output: `${rest.output}\n\nShell working directory reset to ${pathResolve(ctx.cwd)}: ` +
      `${finalCwd} is outside the workspace and allowed directories.`,
    metadata: { ...rest.metadata, cwdReset: true },
  };
}

/** Post-run clamp seam: path policy keeps real commands from reaching it. */
export const _trackShellSessionCwdForTest = trackSessionCwd;

/** Session id threaded by the executor in ctx.metadata; used to scope background shells. */
function sessionIdFromContext(ctx: ToolExecutionContext): string {
  const raw = ctx.metadata["sessionId"];
  return typeof raw === "string" && raw !== "" ? raw : "unknown";
}

/**
 * Flag a synchronous result that was produced because backgrounding was
 * requested but unavailable on the active execution path (the ASRT sandbox or a
 * requested-sandbox approval fallback). The command still ran; the caller just
 * did not get a background handle. (The `blocked` plan returns its error before
 * this wrap, so it never carries the flag — nothing ran to background.)
 */
function withBackgroundUnavailable(result: SpawnResult, requested: boolean): SpawnResult {
  if (!requested) return result;
  return { ...result, metadata: { ...result.metadata, backgroundUnavailable: true } };
}

function withDisposableExecutionMetadata<
  T extends { readonly metadata?: Record<string, unknown> },
>(result: T): T & { metadata: Record<string, unknown> } {
  return {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      sandboxed: true,
      isolation: "disposable-container",
    },
  };
}

async function captureBrokerForegroundOutput(
  raw: string,
  ctx: ToolExecutionContext,
): Promise<{ output: string; outputArtifact?: ToolOutputArtifactInfo }> {
  const truncated = raw.replace(/\r\n/g, "\n").trim().length > OUTPUT_CAP;
  if (!truncated) return { output: formatOutput(raw) };
  const factory = captureFactoryFromContext(ctx);
  if (!factory) return { output: formatOutput(raw) };
  const capture = factory();
  const bytes = Buffer.from(raw, "utf8");
  if (!capture.append(bytes)) await capture.waitForDrain();
  return {
    output: formatOutput(raw, true),
    outputArtifact: await capture.finish(false),
  };
}

function workloadTerminalReceipt(
  result: WorkloadBrokerSuccessResults["shell.run"],
): Record<string, unknown> {
  return {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    oomDelta: result.oomDelta,
    ownedResourcesZero: result.ownedResourcesZero,
    receiptDigest: result.receiptDigest,
  };
}

async function runBrokeredBash(
  authority: BrokeredShellAuthority,
  input: z.infer<typeof BashToolInputSchema>,
  resolvedCwd: string,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const timeoutMs = resolveShellTimeoutMs(input.timeoutSeconds);
  if (timeoutMs > WORKLOAD_BROKER_LIMITS.maximumTimeoutMs) {
    return brokerFailureResult(new Error(
      `workload-broker:timeout-limit: brokered execution accepts at most ${WORKLOAD_BROKER_LIMITS.maximumTimeoutMs / 1000} seconds; retry with a smaller timeoutSeconds`,
    ));
  }
  const observation = beginAgentTerminalObservation({ kind: "shell", command: input.command, cwd: resolvedCwd,
    sandbox: { mode: "disposable", detail: "disposable-container" }, outputAvailability: "on-completion" });
  let completed = false;
  try {
  const result = await authority.runtime.executeBrokeredWorkloadRequest(
    authority.capability,
    "shell.run",
    {
      command: input.command,
      cwd: resolvedCwd,
      timeoutMs,
    },
    authority.correlationAuthority,
    ctx.abortSignal,
  );
  if (!("status" in result)) return withBrokerTransportMetadata(result);
  observation?.write(result.output);
  observation?.finish(result.exitCode, result.cancelled ? "cancelled" : workloadTerminalIsError(result) ? "failed" : "completed");
  completed = true;
  const captured = await captureBrokerForegroundOutput(result.output, ctx);
  const completion = workloadCompletionSentence(result);
  const output = completion === undefined
    ? captured.output
    : captured.output === "(no output)"
      ? completion
      : `${captured.output}\n${completion}`;
  return {
    output,
    isError: workloadTerminalIsError(result),
    metadata: {
      source: "workload-broker",
      executionTransport: "workload-broker",
      sandboxed: true,
      isolation: "disposable-container",
      workloadReceipt: workloadTerminalReceipt(result),
      returncode: result.exitCode,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.cancelled ? { aborted: true } : {}),
      ...(captured.outputArtifact === undefined
        ? {}
        : { outputArtifact: captured.outputArtifact }),
    },
  };
  } finally { if (!completed) observation?.finish(null, ctx.abortSignal?.aborted ? "cancelled" : "failed"); }
}

async function startBrokeredBash(
  authority: BrokeredShellAuthority,
  input: z.infer<typeof BashToolInputSchema>,
  resolvedCwd: string,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const timeoutMs = resolveShellTimeoutMs(input.timeoutSeconds);
  const capabilityExpiresAt = Date.parse(authority.capability.expiresAt);
  const requiredOperations = ["shell.start", "shell.read", "shell.kill"] as const;
  if (requiredOperations.some(
    (operation) => !authority.capability.allowedOperations.includes(operation),
  )) {
    return brokerFailureResult(
      new Error("workload-broker:background-lifecycle-operations-unavailable"),
    );
  }
  if (
    timeoutMs > WORKLOAD_BROKER_LIMITS.maximumTimeoutMs
  ) {
    return brokerFailureResult(new Error(
      `workload-broker:timeout-limit: brokered execution accepts at most ${WORKLOAD_BROKER_LIMITS.maximumTimeoutMs / 1000} seconds; retry with a smaller timeoutSeconds`,
    ));
  }
  if (
    !Number.isFinite(capabilityExpiresAt) ||
    capabilityExpiresAt - Date.now() < timeoutMs + BROKER_BACKGROUND_LIFETIME_GUARD_MS
  ) {
    return brokerFailureResult(
      new Error("workload-broker:background-capability-lifetime-insufficient"),
    );
  }
  const observation = beginAgentTerminalObservation({ kind: "shell", command: input.command, cwd: resolvedCwd,
    sandbox: { mode: "disposable", detail: "disposable-container" }, outputAvailability: "on-completion" });
  let registered = false;
  try {
  const result = await authority.runtime.executeBrokeredWorkloadRequest(
    authority.capability,
    "shell.start",
    {
      command: input.command,
      cwd: resolvedCwd,
      timeoutMs,
    },
    authority.correlationAuthority,
    ctx.abortSignal,
  );
  if (isBrokerTransportToolResult(result)) return withBrokerTransportMetadata(result);
  if (result.isError) {
    return withBrokerTransportMetadata({ output: result.output, isError: true });
  }
  const brokerReceipt = authority.runtime.getWorkloadBrokerResponseReceipt(result);
  if (brokerReceipt === undefined) {
    return brokerFailureResult(new Error("workload-broker:start-correlation-receipt-missing"));
  }
  const shellId = backgroundShellManager.registerBroker({
    sessionId: sessionIdFromContext(ctx),
    command: input.command,
    executionId: result.executionId,
    capability: authority.capability,
    parent: authority.runtime.issueWorkloadBackgroundParent(result),
    offset: result.offset,
    observation,
  });
  registered = true;
  return {
    output: JSON.stringify({
      backgrounded: true,
      shellId,
      status: "running",
      hint:
        "Read output with bash_output({ shellId }); stop it with bash_kill({ shellId }). " +
        "This shell is managed by the session and is stopped when the session ends.",
    }),
    isError: false,
    metadata: {
      backgrounded: true,
      shellId,
      source: "workload-broker",
      executionTransport: "workload-broker",
      sandboxed: true,
      isolation: "disposable-container",
    },
  };
  } finally { if (!registered) observation?.finish(null, ctx.abortSignal?.aborted ? "cancelled" : "failed"); }
}

/**
 * Spawn a plain host-shell child that outlives this call and hand it to the
 * background-shell manager (which tracks it for quit-kill and owns its output
 * buffer). Returns immediately with the shell id. Uses the same secret-stripped
 * environment as {@link spawnWithTimeout}; `timeoutSeconds` does not apply — a
 * background shell runs until it exits, bash_kill, session end, or app quit.
 */
function spawnBackground(command: string, cwd: string, sessionId: string, prepared: PreparedShellInvocation,
  sandbox: AgentTerminalObservationInput["sandbox"]): SpawnResult {
  const releaseClaim = claimPreparedShellInvocation(prepared);
  try {
  const { shell, argv, environment: env } = preparedShellCommand(prepared);
  if (process.platform === "win32" && shell.windowsFlavor !== "msys") {
    return {
      output: "Background Bash requires a confirmed native Windows shell. Process ownership is unavailable for this interpreter; this command was not started.",
      isError: true,
      metadata: { backgroundUnavailable: true },
    };
  }
  assertManagedChildProcessAdmissionOpen("tool:bash:background");
  const observation = startShellObservation(command, cwd, sandbox);
  let child: ChildProcess;
  try {
    child = process.platform === "win32"
      ? spawnWindowsJobProcess(shell.cmd, [...argv], { cwd, env })
      : spawn(shell.cmd, [...argv], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        shell: false,
        detached: true,
      });
  } catch (error) { observation?.finish(null, "failed"); throw error; }
  const cleanup = transferPreparedShellInvocation(prepared);
  child.once("close", cleanup);
  const shellId = backgroundShellManager.register({
    sessionId,
    command,
    child,
    startedAt: new Date().toISOString(),
    killProcessGroup: process.platform !== "win32",
    observation,
  });
  return {
    output: JSON.stringify({
      backgrounded: true,
      shellId,
      status: "running",
      // The lifetime belongs in the result, not only in the schema: this is the
      // last thing the model reads before it decides whether the process is
      // still there later. Saying only how to read and stop it left the model
      // free to assume it outlives the session -- on a benchmark it reported a
      // gRPC server as "still running for the client to connect to" after the
      // turn had already killed it.
      hint:
        "Read output with bash_output({ shellId }); stop it with bash_kill({ shellId }). " +
        "This shell is managed by the session and is stopped when the session ends. " +
        "Descendants that leave the owned process group may survive its cleanup.",
    }),
    isError: false,
    metadata: { backgrounded: true, shellId },
  };
  } finally { releaseClaim(); }
}

function preflightInteractiveCommand(command: string): string | null {
  const lowered = command.toLowerCase();
  const hasScaffold = INTERACTIVE_SCAFFOLDS.some((marker) => lowered.includes(marker));
  const hasNonInteractive = NON_INTERACTIVE_MARKERS.some((marker) =>
    lowered.includes(marker),
  );
  if (hasScaffold && !hasNonInteractive) {
    return (
      "This command appears to require interactive input before it can continue. " +
      "The bash tool is non-interactive, so it cannot answer installer/scaffold prompts live. " +
      "Prefer non-interactive flags (for example --yes, -y, --skip-install, --defaults, --non-interactive), " +
      "or run the scaffolding step once in an external terminal before asking the agent to continue."
    );
  }
  return null;
}

interface SpawnResult {
  output: string;
  isError: boolean;
  metadata: Record<string, unknown>;
  /**
   * Host path of the directory a completed foreground command ended in, from
   * the cwd probe. Absent after a timeout, cancellation, spawn failure, or a
   * shell that never reached the probe. Never forwarded to the model as-is.
   */
  reportedCwd?: string;
}

function verifiedShellOutputRefusal(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): SpawnResult | undefined {
  const refusal = verifiedShellResultRefusal(handle, identity);
  return refusal === undefined ? undefined : { output: refusal, isError: true, metadata: {} };
}

/** Reinspect checked executions whether they return a result or fail to spawn. */
async function checkedShellResult<T extends ToolExecutionResult>(
  execute: () => Promise<T>, handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity,
): Promise<{ result: T | SpawnResult; refused: boolean }> {
  const requiresResultCheck = verifiedShellRequiresResultCheck(handle, identity);
  // Agent observation of a checked execution follows the same quarantine as its result: no output before revalidation, none at all on refusal.
  const held: AgentTerminalObservationLease[] = [];
  let result: T | SpawnResult;
  try {
    result = requiresResultCheck ? await heldShellObservations.run(held, execute) : await execute();
  } catch (error) {
    if (!requiresResultCheck) throw error;
    const prefix = identity.dialect === "powershell" ? "PowerShell " : "";
    result = { output: `${prefix}spawn failed: ${errorMessage(error)}`, isError: true, metadata: {} };
  }
  const refusal = verifiedShellOutputRefusal(handle, identity);
  for (const observation of held) observation.releaseHeldOutput(refusal === undefined);
  return refusal === undefined ? { result, refused: false } : { result: refusal, refused: true };
}

/**
 * Execute a shell command under the ASRT (Anthropic sandbox-runtime) sandbox.
 *
 * ASRT does not spawn the workload: {@link wrapToolCommand} returns the
 * `{ argv, env }` for the OS-confined wrapper (macOS Seatbelt profile, Linux
 * bwrap+seccomp) and the host spawns it here with `shell: false` (the wrapper
 * argv already contains the shell invocation; a second shell would double-parse
 * the command). Windows ASRT is not shell-contained and cannot accept the
 * per-exec allowRead/allowWrite grants this path needs, so executeTyped refuses
 * before reaching this function on win32. After exit,
 * {@link cleanupAsrtSandboxAfterCommand} releases the per-command proxy/helper
 * state.
 *
 * Filesystem jail (per-command, trust-safe — see asrt-sandbox.PerCommandFilesystem):
 *   - `allowWrite: writePaths` — the namespace-scoped write-jail derived by
 *     {@link ../permissions/sandbox-write-jail.js deriveSandboxWritePaths}
 *     (owner plugin sandbox root ∪ allowed directories), NOT the bare cwd.
 *     On Linux the wrap withholds a root under a protected read deny, because
 *     a bubblewrap write bind would reopen the deny
 *     (asrt-sandbox.ts buildPerCommandSandboxCustomConfig).
 * Reads retain the sensitive and private-session floors; other files are
 * broadly readable. The invocation's own proxy listener applies domain grants
 * or asks the host approval callback for an unknown destination.
 *
 * @internal — only exported for testing.
 */
function ambientShellEgressContext(): ShellEgressContext {
  const gate = currentEffectGateContext();
  return {
    sessionId: gate?.sessionId,
    workspaceRoot: currentToolExecutionCwd(),
    approvalSurface: gate !== undefined && !gate.headless && gate.approvalSurface !== "unavailable" ? "interactive" : "unavailable",
  };
}

async function annotateSandboxCommandResult(
  commandId: string, wrapped: SandboxWrapResult, text: string, command: string, terminated: boolean,
): Promise<{ output: string; sandboxCleanupFailed: boolean }> {
  const outcome = wrapped.cleanupCompleted && !terminated
    ? { failure: t("sandboxPolicy.cleanupPending") }
    : await wrapped.cleanupCompleted;
  const notices = [...(wrapped.notices ?? []), ...(outcome?.notice ? [outcome.notice] : []), ...(outcome?.failure ? [outcome.failure] : [])];
  return {
    output: await annotateWithSandboxViolations(commandId, text, command, notices),
    sandboxCleanupFailed: outcome?.failure !== undefined,
  };
}

export async function spawnWithSandbox(
  command: string,
  resolvedCwd: string,
  writePaths: readonly string[],
  timeoutSeconds: number,
  prepared: PreparedShellInvocation,
  signal?: AbortSignal,
  outputCaptureFactory?: BoundOutputCaptureFactory,
  progress?: ToolOutputProgressSink,
  waitForClose = false,
): Promise<SpawnResult> {
  const releaseClaim = claimPreparedShellInvocation(prepared);
  try {
  signal?.throwIfAborted();
  const { shell, homePath, hostHome: home } = preparedShellCommand(prepared);
  if (!homePath) throw new Error("Sandbox shell preparation has no owned HOME");
  // Compose broad reads while retaining protected paths and private sessions.
  const sandboxWritePaths = [...writePaths, homePath];
  const { allowRead, denyRead, floorPierces } = getBuiltinShellReadPolicy(
    [resolvedCwd, ...sandboxWritePaths, ...preparedShellExecutableReadPaths(prepared)], home, homePath,
  );
  const filesystem = {
    allowWrite: sandboxWritePaths,
    allowRead,
    denyRead,
    denyWrite: getDefaultSensitiveWriteDenyPaths(),
    floorPierces,
  };

  const abortController = new AbortController();
  const wrapAbortSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;
  const egress = openEgressInvocation(
    { kind: "shell", toolName: "bash", toolUseId: preparedShellToolUseId(prepared), context: ambientShellEgressContext() },
    { abortSignal: wrapAbortSignal },
  );
  let wrapped: SandboxWrapResult;
  try {
    const binShell = shell.cmd;
    wrapped = await wrapToolCommand(preparedSandboxBootstrap(prepared, { cwdProbe: true }), {
      filesystem,
      abortSignal: wrapAbortSignal,
      commandId: egress.token,
      denyUnixSockets: true,
      binShell,
    });
  } catch (err) {
    egress.release();
    return {
      output: `spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  const [cmd, ...args] = wrapped.argv;
  if (signal?.aborted) {
    void cleanupAsrtSandboxAfterCommand();
    egress.release();
    const annotated = await annotateSandboxCommandResult(egress.token, wrapped, "Shell command cancelled.", command, true);
    const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
    return { output: annotated.output, isError: true, metadata: { ...cleanupMetadata, aborted: true, sandboxed: false } };
  }
  if (cmd === undefined) {
    void cleanupAsrtSandboxAfterCommand();
    egress.release();
    const annotated = await annotateSandboxCommandResult(egress.token, wrapped, "spawn failed: ASRT returned an empty argv", command, true);
    const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
    return {
      output: annotated.output,
      isError: true,
      metadata: { ...cleanupMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  // Per-platform env: on win32 ASRT returns a REAL env carrying the proxy
  // set (srt-win forwards its env verbatim — the proxy vars are NOT baked into
  // the command string as on mac/linux, where `wrapped.env` IS process.env).
  // buildSandboxedChildEnv composes the SAME secret-stripped result on both: the
  // safe whitelist baseline + ONLY the allow-listed proxy/CA/SANDBOX_RUNTIME
  // keys ASRT set/changed. So the Windows proxy set is propagated (the "spread")
  // while mac/linux gains nothing extra, and host secrets stay stripped on both.
  const childEnv = preparedSandboxEnvironment(prepared, wrapped.env);
  let observation: AgentTerminalObservationLease | undefined;
  try { observation = startShellObservation(command, resolvedCwd,
    { mode: "isolated", detail: "filesystem/process confinement" }, egress.token); }
  catch (error) { void cleanupAsrtSandboxAfterCommand(); egress.release(); throw error; }

  return await new Promise<SpawnResult>((resolveResult) => {
    // CRITICAL: shell:false — the wrapper argv is the literal program+args; a
    // shell here would re-parse and break quoting / inject a second shell.
    let child: PipedChild;
    try {
      assertManagedChildProcessAdmissionOpen("tool:bash:asrt");
      assertSrtWinSpawnIntegrity(cmd);
      child = spawn(cmd, args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        cwd: resolvedCwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: childEnv,
      });
    } catch (err) {
      observation?.finish(null, "failed");
      void cleanupAsrtSandboxAfterCommand();
      egress.release();
      void annotateSandboxCommandResult(egress.token, wrapped, `spawn failed: ${(err as Error).message}`, command, true).then(annotated => {
        const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
        resolveResult({
          output: annotated.output,
          isError: true,
          metadata: { ...cleanupMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
        });
      });
      return;
    }
    const closed = checkedShellClose(child, waitForClose);
    const cleanupPreparedAfterTermination = transferPreparedShellInvocation(prepared);
    trackManagedChildProcess(child, { killProcessGroup: process.platform !== "win32", label: "tool:bash:asrt" });
    // Detached, the child leads its own process group: the sandbox keeps the
    // ended invocation's listener port while anything in that group lives.
    if (process.platform !== "win32" && child.pid !== undefined) egress.noteProcessGroup(child.pid);

    const outputCollector = createOutputCollector(child, {
      captureFactory: outputCaptureFactory,
      cwdProbe: preparedShellCwdProbe(prepared).probe,
      progress,
      observation,
    });
    child.stdout.on("data", outputCollector.collect);
    child.stderr.on("data", outputCollector.collectStderr);

    let settled = false;

    let lifecycleCleaned = false;
    const cleanupAfterTermination = (): void => {
      if (lifecycleCleaned) return;
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) return;
      lifecycleCleaned = true;
      void cleanupAsrtSandboxAfterCommand();
      egress.release();
      cleanupPreparedAfterTermination();
      egress.release();
    };
    const lifetime = watchShellLifetime(child, timeoutSeconds, signal, () => abortController.abort());

    const finish = async (code: number | null, signal: NodeJS.Signals | null = null): Promise<void> => {
      if (closed !== undefined) await closed;
      if (lifetime.termination) await lifetime.termination;
      cleanupAfterTermination();
      lifetime.dispose();
      if (settled) return;
      settled = true;
      const artifactMetadata = await outputCollector.finish(lifetime.timedOut || lifetime.aborted || signal !== null);
      // Per-command cleanup (proxy/helper state) after the wrapped command ends.
      const { output: formatted, sandboxCleanupFailed } = await annotateSandboxCommandResult(egress.token, wrapped, lifetime.output(outputCollector.format(
        lifetime.timedOut || lifetime.aborted ? undefined : { code, signal },
      )), command, lifecycleCleaned);
      outputCollector.finishObservation(code, lifetime.aborted ? "cancelled" : lifetime.timedOut || signal !== null || sandboxCleanupFailed ? "failed" : undefined);
      if (lifetime.timedOut) {
        resolveResult({
          output: formatTimeoutOutput(formatted, command, timeoutSeconds),
          isError: true,
          metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code, timedOut: true, sandboxed: true,
            ...(sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {}) },
        });
      } else {
        resolveResult({
          output: formatted,
          isError: lifetime.aborted || code !== 0 || sandboxCleanupFailed,
          metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code, sandboxed: true,
            ...(sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {}) },
          ...reportedHostCwd(shell, lifetime.aborted ? undefined : outputCollector.reportedCwd()),
        });
      }
    };

    void lifetime.stopped.then(() => finish(child.exitCode));
    child.once("close", (code, signal) => { void finish(code, signal); });
    child.on("error", (err) => {
      void (async () => {
        if (closed !== undefined) await closed;
        if (settled) return;
        settled = true;
        const artifactMetadata = await outputCollector.finish(true);
        // Node can emit `error` for a failed process operation while the child
        // remains alive. The later `close` event owns ASRT/HOME finalization.
        cleanupAfterTermination();
        const annotated = await annotateSandboxCommandResult(egress.token, wrapped, `spawn failed: ${err.message}`, command, lifecycleCleaned);
        outputCollector.finishObservation(null, "failed");
        const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
        resolveResult({
          output: annotated.output,
          isError: true,
          metadata: { ...artifactMetadata, ...cleanupMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
        });
      })();
    });
  });
  } finally { releaseClaim(); }
}

async function spawnWithTimeout(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  prepared: PreparedShellInvocation,
  signal?: AbortSignal,
  outputCaptureFactory?: BoundOutputCaptureFactory,
  progress?: ToolOutputProgressSink,
  spawnAuthorization?: HostShellSpawnAuthorization,
  sessionId?: string,
  backgroundable = false,
  waitForClose = false,
  sandbox: AgentTerminalObservationInput["sandbox"] = { mode: "unconfined", detail: "host" },
): Promise<SpawnResult> {
  const releaseClaim = claimPreparedShellInvocation(prepared);
  try {
  signal?.throwIfAborted();
  const { shell, environment } = preparedShellCommand(prepared);
  const prelude = spawnAuthorization === undefined ? undefined : hostShellWorkingDirectoryPrelude(spawnAuthorization.cwdIdentity, "bash", process.platform);
  const { argv, probe } = preparedShellCwdProbe(prepared, prelude);
  const launch = (): Promise<SpawnResult> => new Promise((resolve) => {
    signal?.throwIfAborted();
    assertManagedChildProcessAdmissionOpen("tool:bash");
    const observation = startShellObservation(command, cwd, sandbox);
    let child: PipedChild;
    try { child = spawn(shell.cmd, [...argv], {
      windowsHide: true,
      detached: process.platform !== "win32",
      cwd,
      stdio: prelude === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe"],
      // Strip secrets (AVE_*, *_API_KEY, GITHUB_TOKEN, AWS_*, etc.) from
      // the child's environment. Only generic shell/locale vars pass through.
      env: { ...environment },
      shell: false,
    }) as PipedChild; }
    catch (error) { observation?.finish(null, "failed"); throw error; }
    const closed = checkedShellClose(child, waitForClose);
    const control = prelude === undefined || spawnAuthorization === undefined ? undefined : attachHostShellControlChannel(child, spawnAuthorization);
    const cleanupPreparedAfterTermination = transferPreparedShellInvocation(prepared);
    child.once("close", () => {
      if (lifetime.termination) void lifetime.termination.then(cleanupPreparedAfterTermination);
      else cleanupPreparedAfterTermination();
    });
    const stopTracking = trackManagedChildProcess(child, { killProcessGroup: process.platform !== "win32", label: "tool:bash" });

    const outputCollector = createOutputCollector(child, { captureFactory: outputCaptureFactory, cwdProbe: probe, progress,
      retainForHandoff: backgroundable, observation });
    child.stdout.on("data", outputCollector.collect);
    child.stderr.on("data", outputCollector.collectStderr);

    let settled = false;

    const lifetime = watchShellLifetime(child, timeoutSeconds, signal);
    let backgrounded = false;
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    if (sessionId !== undefined) foregroundShellTasks.set(taskId, {
      sessionId,
      snapshot: () => ({
        shellId: taskId, command, startedAt, status: "running", backgrounded: false,
        canBackground: backgroundable, canStop: false, ...shellTaskOutputPreview(backgroundable ? outputCollector.handoffSnapshot().output : outputCollector.format(), outputCollector.handoffSnapshot().truncated),
      }),
      background: () => {
        if (!backgroundable || settled || lifetime.aborted || lifetime.timedOut || child.exitCode !== null || child.signalCode !== null) {
          return { ok: false, error: "background-unavailable" };
        }
        const initialOutput = outputCollector.handoffSnapshot();
        let shellId: string;
        try {
          assertManagedChildProcessAdmissionOpen("tool:bash:background");
          shellId = backgroundShellManager.register({
            sessionId, command, child, startedAt, killProcessGroup: true, captureOutput: false,
            initialOutput: initialOutput.output, initialOutputTruncated: initialOutput.truncated,
          });
        } catch (err) {
          shellTaskLog.warn({ err }, "shell handoff refused by lifecycle admission");
          return { ok: false, error: "background-unavailable" };
        }
        // Commit only after the new lifecycle owner accepts this exact admitted child.
        settled = true;
        backgrounded = true;
        foregroundShellTasks.delete(taskId);
        lifetime.releaseSignal();
        stopTracking();
        outputCollector.handOffOutput((chunk) => backgroundShellManager.appendOutput(sessionId, shellId, chunk));
        void outputCollector.finish(true).catch(() => {
          try { outputCollector.abandonCapture(); } catch { /* The continuing child still has its session owner. */ }
          return { outputCaptureFailed: true };
        }).then((artifactMetadata) => resolve({
          output: JSON.stringify({ backgrounded: true, shellId, status: "running", hint: "Read with bash_output; stop with bash_kill. The original deadline still applies and session end stops this command." }),
          isError: false,
          metadata: { ...artifactMetadata, backgrounded: true, shellId },
        }));
        return { ok: true, shellId };
      },
    });

    const finish = async (code: number | null, signal: NodeJS.Signals | null = null): Promise<void> => {
      if (closed !== undefined) await closed;
      if (lifetime.termination) await lifetime.termination;
      lifetime.dispose();
      foregroundShellTasks.delete(taskId);
      if (backgrounded) outputCollector.finishBackground();
      if (backgrounded) outputCollector.finishObservation(code, lifetime.aborted ? "cancelled" : lifetime.timedOut || signal !== null ? "failed" : undefined);
      if (settled) return;
      settled = true;
      const rejected = control?.rejected === true;
      control?.dispose();
      const artifactMetadata = await outputCollector.finish(lifetime.timedOut || lifetime.aborted || signal !== null);
      outputCollector.finishObservation(code, lifetime.aborted ? "cancelled" : lifetime.timedOut || signal !== null ? "failed" : undefined);
      const formatted = lifetime.output(outputCollector.format(
        lifetime.timedOut || lifetime.aborted ? undefined : { code, signal },
      ));
      if (lifetime.timedOut) {
        resolve({
          output: formatTimeoutOutput(formatted, command, timeoutSeconds),
          isError: true,
          metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code, timedOut: true },
        });
      } else {
        resolve({
          output: rejected
            ? `spawn failed: ${HOST_SHELL_AUTHORIZATION_REVOKED_ERROR}` : formatted,
          isError: rejected || lifetime.aborted || code !== 0,
          metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code },
          ...reportedHostCwd(shell, lifetime.aborted ? undefined : outputCollector.reportedCwd()),
        });
      }
    };

    void lifetime.stopped.then(() => finish(child.exitCode));
    child.once("close", (code, signal) => { void finish(code, signal); });
    child.on("error", (err) => {
      void (async () => {
        if (closed !== undefined) await closed;
        if (settled) return;
        settled = true;
        foregroundShellTasks.delete(taskId);
        lifetime.dispose();
        control?.dispose();
        const artifactMetadata = await outputCollector.finish(true);
        outputCollector.finishObservation(null, "failed");
        resolve({
          output: `spawn failed: ${err.message}`,
          isError: true,
          metadata: { ...artifactMetadata },
        });
      })();
    });
  });
  if (spawnAuthorization !== undefined && prelude === undefined) {
    // Keep listener registration in the synchronous handoff, without holding
    // the policy queue for the lifetime of the command's result promise.
    const handoff = await withHostShellExecutionHandoff(spawnAuthorization, () => ({ result: launch() }));
    return handoff === undefined
      ? { output: `spawn failed: ${HOST_SHELL_AUTHORIZATION_REVOKED_ERROR}`, isError: true, metadata: {} } : await handoff.result;
  }
  return await launch();
  } finally { releaseClaim(); }
}

function reportedHostCwd(
  shell: Parameters<typeof hostPathForShellPath>[0],
  reported: string | undefined,
): { reportedCwd?: string } {
  if (reported === undefined || reported === "") return {};
  const hostPath = hostPathForShellPath(shell, reported);
  return hostPath === undefined || !isAbsolute(hostPath) ? {} : { reportedCwd: hostPath };
}

function formatTimeoutOutput(
  partial: string,
  command: string,
  timeoutSeconds: number,
): string {
  const effectiveSeconds = resolveShellTimeoutMs(timeoutSeconds) / 1000;
  const parts = [
    `Command timed out after ${effectiveSeconds} seconds. ` +
      (effectiveSeconds < timeoutSeconds
        ? "The native timer limit was reached; split the work into smaller steps."
        : "Retry with a larger `timeoutSeconds` if the command legitimately needs longer."),
  ];
  if (partial !== "(no output)") {
    parts.push("", "Partial output:", partial);
  }
  const hint = interactiveHint(command, partial);
  if (hint !== null) {
    parts.push("", hint);
  }
  return parts.join("\n");
}

function interactiveHint(command: string, output: string): string | null {
  const lowered = command.toLowerCase();
  const outputLower = output.toLowerCase();
  const looksInteractive = INTERACTIVE_SCAFFOLDS.some((m) => lowered.includes(m));
  const looksPrompt = [
    "would you like",
    "ok to proceed",
    "select an option",
    "press enter",
  ].some((m) => outputLower.includes(m));
  if (looksInteractive || looksPrompt) {
    return (
      "This command appears to require interactive input. " +
      "The bash tool is non-interactive, so prefer non-interactive flags " +
      "(for example --yes, -y, --skip-install, or similar) or run the " +
      "scaffolding step once in an external terminal before continuing."
    );
  }
  return null;
}

function sessionIdOf(ctx: ToolExecutionContext | undefined): string {
  const raw = ctx?.metadata?.["sessionId"];
  return typeof raw === "string" && raw !== "" ? raw : "unknown";
}

function shellIdOf(rawInput: unknown): string {
  const args = (rawInput ?? {}) as Record<string, unknown>;
  return typeof args.shellId === "string" ? args.shellId.trim() : "";
}

function present(result: BackgroundShellReadResult): ToolExecutionResult {
  return {
    output: JSON.stringify({
      shellId: result.shellId,
      command: result.command,
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      output: result.output,
      truncated: result.truncated,
      ...(result.workloadStatus === undefined
        ? {}
        : { workloadStatus: result.workloadStatus }),
      ...(result.completion === undefined
        ? {}
        : { completion: result.completion }),
    }),
    isError: result.isError ?? false,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  };
}

const NOT_FOUND =
  "no background shell with that id is running in this session (it may have already been reaped, or belongs to another session)";

const canonicalBrokerLifecycleTools = new WeakSet<object>();

export function isCanonicalBrokerLifecycleTool(tool: unknown): tool is Tool {
  return typeof tool === "object" && tool !== null && canonicalBrokerLifecycleTools.has(tool);
}

function consumeBrokerLifecycleActor(
  toolName: "bash_output" | "bash_kill",
  rawInput: unknown,
  ctx: ToolExecutionContext,
): WorkloadBackgroundActor | null {
  const authority = consumeExecutionGrantForBuiltinToolInvocation({
    grant: ctx.executionRouteGrant,
    toolName,
    normalizedInput: rawInput,
    cwd: ctx.cwd,
  });
  return authority?.disposableAuthority === "workload-broker" &&
    authority.workloadCorrelationAuthority !== undefined
    ? Object.freeze({
        kind: "tool-invocation" as const,
        authority: authority.workloadCorrelationAuthority,
      })
    : null;
}

// Leave room for the executor to deliver the result before its existing ceiling.
const backgroundOutputWaitSchema = z.number().int().min(0)
  .max(Math.min(30_000, TOOL_TIMEOUT_POLICY.globalCeilingMs - TOOL_TIMEOUT_POLICY.shellCeilingGraceMs))
  .default(0)
  .describe("Maximum milliseconds to wait for the waitFor condition; 0 returns immediately. Does not extend the command's lifetime.");

const backgroundOutputWaitForSchema = z.enum(["output", "completion"])
  .default("output")
  .describe("output returns on unread/new output or completion. completion keeps waiting through progress output until the shell ends or waitMs expires, then returns accumulated output and current status.");

/**
 * `bash_output` — read newly-accumulated output (and current status/exit code)
 * from a background shell started by `bash` with `run_in_background: true`.
 * Returns only the output produced since the previous call. Read-only.
 */
export function createBashOutputTool(
  manager: BackgroundShellManager = backgroundShellManager,
): Tool {
  const tool = createDynamicTool({
    name: "bash_output",
    description:
      "Read output produced since your last check from a background shell started by `bash` " +
      "with run_in_background: true. Returns the new output plus the shell's status " +
      "(running | exited | killed | failed), exit code and observed termination signal. " +
      "Set waitMs to wait for new output or completion. Set waitFor: 'completion' to keep waiting " +
      "through progress output within that same waitMs limit.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["shellId"],
      properties: {
        shellId: { type: "string", description: "The shell id returned by the background bash call." },
        waitMs: z.toJSONSchema(backgroundOutputWaitSchema),
        waitFor: z.toJSONSchema(backgroundOutputWaitForSchema),
      },
    },
    execute: async (rawInput, ctx) => {
      const shellId = shellIdOf(rawInput);
      if (shellId === "") {
        return { output: "bash_output: `shellId` is required.", isError: true };
      }
      const wait = backgroundOutputWaitSchema.safeParse((rawInput as Record<string, unknown>)?.waitMs);
      if (!wait.success) {
        return { output: `bash_output: invalid waitMs: ${wait.error.message}`, isError: true };
      }
      const waitFor = backgroundOutputWaitForSchema.safeParse((rawInput as Record<string, unknown>)?.waitFor);
      if (!waitFor.success) {
        return { output: `bash_output: invalid waitFor: ${waitFor.error.message}`, isError: true };
      }
      const brokerGrantPresented = ctx.executionRouteGrant?.disposableAuthority === "workload-broker";
      const actor = consumeBrokerLifecycleActor("bash_output", rawInput, ctx);
      if (brokerGrantPresented || isWorkloadBrokerActive()) {
        try {
          if (actor === null) {
            return brokerFailureResult(new Error("workload-broker:disposable-grant-required"));
          }
          if (!manager.isBrokerShell(sessionIdOf(ctx), shellId)) {
            return brokerFailureResult(new Error("workload-broker:background-handle-not-found"));
          }
          const result = await manager.readBroker(
            sessionIdOf(ctx),
            shellId,
            wait.data,
            actor,
            ctx?.abortSignal,
            waitFor.data,
          );
          if (!result) return { output: `bash_output: ${NOT_FOUND}.`, isError: true };
          return "shellId" in result ? present(result) : result;
        } catch (error) {
          if (ctx?.abortSignal?.aborted) {
            return { output: "bash_output: wait cancelled.", isError: true, metadata: { aborted: true } };
          }
          return brokerFailureResult(error);
        }
      }
      try {
        await manager.waitForOutput(sessionIdOf(ctx), shellId, wait.data, ctx?.abortSignal, waitFor.data);
        ctx?.abortSignal?.throwIfAborted();
      } catch (error) {
        if (!ctx?.abortSignal?.aborted) throw error;
        return { output: "bash_output: wait cancelled.", isError: true, metadata: { aborted: true } };
      }
      const result = manager.read(sessionIdOf(ctx), shellId);
      if (!result) {
        return { output: `bash_output: ${NOT_FOUND}.`, isError: true };
      }
      return present(result);
    },
  });
  canonicalBrokerLifecycleTools.add(tool);
  return tool;
}

/**
 * `bash_kill` — terminate a background shell started by `bash` with
 * `run_in_background: true`. Terminates the shell and its managed descendants, returning its final
 * status plus any remaining unread output.
 */
export function createBashKillTool(
  manager: BackgroundShellManager = backgroundShellManager,
): Tool {
  const tool = createDynamicTool({
    name: "bash_kill",
    description:
      "Terminate a background shell started by `bash` with run_in_background: true, by its shell id. " +
      "Returns the shell's final status and any remaining unread output.",
    source: "builtin",
    category: "shell",
    isReadOnly: () => false,
    jsonSchema: {
      type: "object",
      required: ["shellId"],
      properties: {
        shellId: { type: "string", description: "The shell id returned by the background bash call." },
      },
    },
    execute: async (rawInput, ctx) => {
      const shellId = shellIdOf(rawInput);
      if (shellId === "") {
        return { output: "bash_kill: `shellId` is required.", isError: true };
      }
      const brokerGrantPresented = ctx.executionRouteGrant?.disposableAuthority === "workload-broker";
      const actor = consumeBrokerLifecycleActor("bash_kill", rawInput, ctx);
      if (brokerGrantPresented || isWorkloadBrokerActive()) {
        try {
          if (actor === null) {
            return brokerFailureResult(new Error("workload-broker:disposable-grant-required"));
          }
          if (!manager.isBrokerShell(sessionIdOf(ctx), shellId)) {
            return brokerFailureResult(new Error("workload-broker:background-handle-not-found"));
          }
          const result = await manager.killBroker(
            sessionIdOf(ctx),
            shellId,
            actor,
            ctx?.abortSignal,
          );
          if (!result) return { output: `bash_kill: ${NOT_FOUND}.`, isError: true };
          return "shellId" in result ? present(result) : result;
        } catch (error) {
          return brokerFailureResult(error);
        }
      }
      const result = manager.kill(sessionIdOf(ctx), shellId);
      if (!result) {
        return { output: `bash_kill: ${NOT_FOUND}.`, isError: true };
      }
      await manager.waitForLocalCleanup(sessionIdOf(ctx));
      return present(result);
    },
  });
  canonicalBrokerLifecycleTools.add(tool);
  return tool;
}

/**
 * Native PowerShell tool.
 *
 * This is a distinct shell surface, not a bash alias. The executable is
 * selected only from a verified absolute installation. Missing or writable
 * installations are refused before the parser or caller source can start.
 */
type PowerShellParser = (command: string) => Promise<PowerShellAstSummary>;

export const PowerShellToolInputSchema = z.object({
  ...hostShellExecutionFields,
  run_in_background: z.boolean().optional().describe("PowerShell runs in the foreground; host requests must not set this to true"),
  command: z.string().min(1).describe("PowerShell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  // Optional-but-defaulted and strictly positive — see BashToolInputSchema.
  timeoutSeconds: shellTimeoutSchema,
}).superRefine(validateHostShellExecutionRequest);

const POWERSHELL_ALIASES = new Map<string, string>([
  ["ac", "add-content"],
  ["cat", "get-content"],
  ["clc", "clear-content"],
  ["copy", "copy-item"],
  ["cp", "copy-item"],
  ["cpi", "copy-item"],
  ["del", "remove-item"],
  ["dir", "get-childitem"],
  ["erase", "remove-item"],
  ["gc", "get-content"],
  ["gci", "get-childitem"],
  ["gi", "get-item"],
  ["iex", "invoke-expression"],
  ["ls", "get-childitem"],
  ["mkdir", "new-item"],
  ["md", "new-item"],
  ["mi", "move-item"],
  ["move", "move-item"],
  ["mv", "move-item"],
  ["ni", "new-item"],
  ["rd", "remove-item"],
  ["ren", "rename-item"],
  ["ri", "remove-item"],
  ["rm", "remove-item"],
  ["rmdir", "remove-item"],
  ["rni", "rename-item"],
  ["saps", "start-process"],
  ["sc", "set-content"],
  ["si", "set-item"],
  ["sp", "set-itemproperty"],
  ["start", "start-process"],
  ["type", "get-content"],
]);

const BLOCKED_COMMANDS = new Map<string, string>([
  ["invoke-expression", "Invoke-Expression is not allowed"],
  ["set-executionpolicy", "execution policy changes are not allowed"],
  ["start-process", "process detachment is not allowed"],
  ["read-host", "interactive prompts are not allowed"],
  ["pause", "interactive prompts are not allowed"],
  ["set-alias", "alias mutation is not allowed"],
  ["new-alias", "alias mutation is not allowed"],
  ["join-path", "dynamic path composition is not allowed"],
  ["resolve-path", "dynamic path resolution is not allowed"],
  ["convert-path", "dynamic path resolution is not allowed"],
  ["new-psdrive", "dynamic filesystem drive mapping is not allowed"],
  ["start-job", "background jobs are not allowed"],
  ["start-threadjob", "background jobs are not allowed"],
  ["invoke-command", "remote command invocation is not allowed"],
  ["get-wmiobject", "WMI command invocation is not allowed"],
  ["invoke-wmimethod", "WMI command invocation is not allowed"],
  ["invoke-cimmethod", "CIM command invocation is not allowed"],
  ["powershell", "nested PowerShell shells are not allowed"],
  ["powershell.exe", "nested PowerShell shells are not allowed"],
  ["pwsh", "nested PowerShell shells are not allowed"],
]);

const ENCODED_COMMAND_FLAGS = new Set(["-encodedcommand", "-enc"]);
const REMOVE_ITEM_COMMANDS = new Set(["remove-item"]);
const FILESYSTEM_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy-item",
  "get-childitem",
  "get-content",
  "get-item",
  "move-item",
  "new-item",
  "out-file",
  "remove-item",
  "rename-item",
  "set-content",
  "set-item",
  "set-itemproperty",
  "test-path",
]);

const canonicalPowerShellTools = new WeakSet<object>();

export function isCanonicalPowerShellTool(tool: unknown): tool is Tool & PowerShellTool {
  return typeof tool === "object" && tool !== null && canonicalPowerShellTools.has(tool);
}

export class PowerShellTool extends ZodTool<typeof PowerShellToolInputSchema> {
  readonly awaitCancellationSettlement = true;
  constructor() {
    super();
    if (new.target === PowerShellTool) canonicalPowerShellTools.add(this);
  }

  readonly name = "powershell";
  readonly description = "Run a non-interactive PowerShell command in the local repository.";
  readonly inputSchema = PowerShellToolInputSchema;
  override readonly category: ToolCategory = "shell";

  override isReadOnly(): boolean {
    return false;
  }

  approvalCacheKey(input: unknown): string {
    const parsed = PowerShellToolInputSchema.parse(input);
    return sha256Hex(JSON.stringify({ command: parsed.command, cwd: parsed.cwd ?? null }));
  }

  // The executor appends the sealed execution plan (host vs sandboxed) to the
  // memory key, so a sandboxed approval never answers for another substrate.
  approvalMemoryScope(input: unknown): ApprovalMemoryScope | undefined {
    return shellApprovalMemoryScope(input);
  }

  protected async executeTyped(
    input: z.infer<typeof PowerShellToolInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    ctx.abortSignal?.throwIfAborted();
    const resolvedCwd = resolveHostShellWorkingDirectory(ctx.cwd, input.cwd);
    // §691: the executor seals the host-shell substrate before permission
    // routing. The supplied plan must come from the live host provider; a
    // structural lookalike cannot downgrade an active ASRT route to plain spawn.
    const suppliedHostShellPlan = ctx.hostShellExecutionPlan;
    if (
      suppliedHostShellPlan !== undefined &&
      !isIssuedHostShellExecutionPlan(suppliedHostShellPlan)
    ) {
      return {
        output: "PowerShell spawn failed: shell execution plan was not issued by the host.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    const hostShellPlan = suppliedHostShellPlan ?? getHostShellExecutionPlan(input.executionMode);
    if (hostShellPlan.executionRequest !== (input.executionMode ?? "default")) {
      return { output: "Shell execution request does not match the host plan.", isError: true };
    }
    const executionAuthority = consumeShellExecutionRoute({
      context: ctx,
      legacyPlan: hostShellPlan,
      toolName: "powershell",
      command: input.command,
      cwd: resolvedCwd,
      timeoutSeconds: input.timeoutSeconds,
      background: input.run_in_background ?? false,
    });
    const disposableExecution = executionAuthority?.route === "disposable-container";
    try {
      const brokeredAuthority = await acquireBrokeredShellAuthority(
        executionAuthority,
        ctx.executionRouteGrant,
      );
      if (brokeredAuthority !== null) {
        return brokerFailureResult(new Error("workload-broker:powershell-unsupported"));
      }
    } catch (error) {
      return brokerFailureResult(error);
    }
    if (disposableExecution && ctx.verifiedShellCommand !== undefined) {
      return { output: "Verified shell commands require a native host execution route.", isError: true };
    }
    const cwdViolation = validateShellWorkingDirectory(
      resolvedCwd,
      ctx.cwd,
      ctx.extraAllowedDirectories,
    );
    if (cwdViolation) {
      const kind = cwdViolation.startsWith("Sensitive")
        ? "sensitive-path"
        : "sandbox-boundary";
      if (!disposableGrantRelaxesPathPolicy(executionAuthority, kind)) {
        return { output: cwdViolation, isError: true };
      }
    }
    if (
      !disposableExecution &&
      requiresExplicitHostShellApproval(hostShellPlan, "powershell") &&
      !ctx.hostShellExecutionPermit
    ) {
      return { output: "PowerShell spawn failed: this host shell execution requires a one-shot host approval permit.", isError: true, metadata: { sandboxed: false, isolation: "none" } };
    }
    let verified: VerifiedPowerShellExecution | undefined;
    const verifiedIdentity: VerifiedShellIdentity = { command: input.command, dialect: "powershell", cwd: resolvedCwd };
    if (ctx.verifiedShellCommand !== undefined) {
      const execution = verifiedShellExecution(ctx.verifiedShellCommand, verifiedIdentity);
      if (execution === undefined) return { output: "PowerShell spawn failed: verified shell command does not match this invocation.", isError: true };
      verified = { ...execution, identity: verifiedIdentity, handle: ctx.verifiedShellCommand };
    }
    const holdsOutput = verified !== undefined && verifiedShellRequiresResultCheck(verified.handle, verified.identity);
    const outputCapture = holdsOutput ? undefined : captureFactoryFromContext(ctx);
    const outputProgress = holdsOutput ? undefined : toolOutputProgressFromMetadata(ctx.metadata);
    let hostSpawnAuthorization: HostShellSpawnAuthorization | undefined;
    const authorizeHostSpawn = (): void => {
      if (!disposableExecution && requiresExplicitHostShellApproval(hostShellPlan, "powershell")) {
        const spawnAuthorization = consumeHostShellExecutionPermitForSpawn({
          permit: ctx.hostShellExecutionPermit,
          plan: hostShellPlan,
          toolName: "powershell",
          toolUseId:
            typeof ctx.metadata.toolUseId === "string"
              ? ctx.metadata.toolUseId
              : undefined,
          command: input.command,
          requestedCwd: input.cwd,
          executionCwd: ctx.cwd,
          resolvedCwd,
          timeoutSeconds: input.timeoutSeconds,
          executionMode: input.executionMode ?? "default",
          justification: input.justification,
          runInBackground: input.run_in_background ?? false,
          allowedDirectories: canonicalizeHostShellAllowedDirectories(ctx.extraAllowedDirectories),
        });
        if (spawnAuthorization === undefined) {
          throw new Error(HOST_SHELL_AUTHORIZATION_REVOKED_ERROR);
        }
        hostSpawnAuthorization = spawnAuthorization;
      }

    };
    if (!isPowerShellStartupPinned()) {
      try { authorizeHostSpawn(); } catch (error) {
        return { output: `PowerShell spawn failed: ${(error as Error).message}`, isError: true, metadata: { sandboxed: false, isolation: "none" } };
      }
    }
    let commandAst: PowerShellAstSummary;
    try {
      const parsed = hostShellPlan.mode === "asrt" && hostShellPlan.substrate === "mxc"
        ? await parsePowerShellAstInMxc(input.command, resolvedCwd, ctx, input.timeoutSeconds)
        : await parsePowerShellAst(input.command, isPowerShellStartupPinned() || hostSpawnAuthorization !== undefined);
      if ("failure" in parsed) return parsed.failure;
      commandAst = parsed;
    } catch (error) {
      return { output: `PowerShell parser failed: ${(error as Error).message}`, isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" } };
    }
    const structuralViolation = validatePowerShellAstStructure(commandAst);
    if (structuralViolation !== null) {
      return { output: `PowerShell command blocked: ${structuralViolation}`, isError: true };
    }
    const commandPathViolation = findPowerShellAstPathViolation(
      commandAst,
      resolvedCwd,
      ctx.cwd,
      ctx.extraAllowedDirectories,
      ctx.blockReadsOutsideWorkingDirectories === true,
      input.command,
    );
    if (
      commandPathViolation &&
      !disposableGrantRelaxesPathPolicy(executionAuthority, commandPathViolation.kind)
    ) {
      return { output: commandPathViolation.reason, isError: true };
    }
    if (verified !== undefined && verifiedShellExecution(verified.handle, verified.identity) === undefined) {
      return { output: "PowerShell spawn failed: verified shell command is no longer available for this invocation.", isError: true };
    }
    // Explicit host requests and the Windows Plan B select a plain host child.
    // Its opaque permit exists only after an allow-once approval (or, for an
    // explicit host request, a matching allow rule) for this exact
    // command/cwd/tool-use tuple and is consumed before spawn.
    // A pinned parser precedes permit consumption. An unpinned host parser may
    // start only after the exact one-shot authority was verified and consumed.
    if (isPowerShellStartupPinned()) {
      try { authorizeHostSpawn(); } catch (error) {
        return { output: `PowerShell spawn failed: ${(error as Error).message}`, isError: true, metadata: { sandboxed: false, isolation: "none" } };
      }
    }
    if (!disposableExecution && hostShellPlan.mode === "blocked") {
      return {
        output:
          "PowerShell spawn failed: ASRT shell tools require filesystem and process isolation; " +
          "the active sandbox is only partially confined.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    if (hostShellPlan.mode === "asrt") {
      // Namespace-scoped write-jail (owner plugin sandbox root ∪ allowed
      // directories), not the bare cwd. cwd stays readable.
      const writePaths = deriveSandboxWritePaths({
        ...(ctx.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: ctx.ownerPluginSandboxRoot }
          : {}),
        allowedDirectories: [resolvedCwd, ...ctx.extraAllowedDirectories],
      });
      const runtimeReads = powerShellHostScriptReadPaths(commandAst, input.command);
      const command = runtimeReads.length > 0 ? awaitedHostScriptCommand(input.command, commandAst.commands[0]!) : input.command;
      if (command === null) return { output: "PowerShell command blocked: host script runtime has no parser extent", isError: true };
      if (hostShellPlan.substrate === "mxc") {
        const checked = await checkedShellResult(() => spawnPowerShellInMxc(
          command,
          resolvedCwd,
          writePaths,
          input.timeoutSeconds, ctx.abortSignal, outputCapture,
          outputProgress,
          typeof ctx.metadata.toolUseId === "string" ? ctx.metadata.toolUseId : undefined,
          undefined, runtimeReads, verified,
        ), ctx.verifiedShellCommand, verifiedIdentity);
        return checked.result;
      }
      const checked = await checkedShellResult(() => spawnPowerShellWithSandbox(
        command,
        resolvedCwd,
        writePaths,
        input.timeoutSeconds, ctx.abortSignal, outputCapture,
        outputProgress,
        typeof ctx.metadata.toolUseId === "string" ? ctx.metadata.toolUseId : undefined,
        runtimeReads, verified,
      ), ctx.verifiedShellCommand, verifiedIdentity);
      return checked.result;
    }

    const checked = await checkedShellResult(() => spawnPowerShell(
      input.command, hostSpawnAuthorization?.cwdIdentity.realpath ?? resolvedCwd, input.timeoutSeconds, ctx.abortSignal,
      outputCapture, outputProgress, hostSpawnAuthorization, verified,
      shellObservationSandbox(hostShellPlan, disposableExecution),
    ), ctx.verifiedShellCommand, verifiedIdentity);
    if (checked.refused) return checked.result;
    const plainResult = checked.result;
    if (disposableExecution) return withDisposableExecutionMetadata(plainResult);
    if (!recordsUnsandboxedExecutionPlan(hostShellPlan)) return plainResult;
    return {
      ...plainResult,
      metadata: {
        ...plainResult.metadata,
        sandboxed: false,
        isolation: "none",
        sandboxExecutionPlan: getHostShellExecutionPlanAuditProjection(hostShellPlan),
      },
    };
  }
}

export async function validatePowerShellCommand(
  command: string,
  parser: PowerShellParser = parsePowerShellAst,
): Promise<string | null> {
  const ast = await parser(command);
  const astError = validatePowerShellAst(ast);
  return astError ? `PowerShell command blocked: ${astError}` : null;
}

export async function validatePowerShellCommandStructure(
  command: string,
  parser: PowerShellParser = parsePowerShellAst,
): Promise<string | null> {
  return validatePowerShellAstStructure(await parser(command));
}

export function validatePowerShellAstStructure(ast: PowerShellAstSummary): string | null {
  if (ast.errors.length > 0) {
    return `parse error: ${ast.errors[0]}`;
  }
  for (const command of ast.commands) {
    const rawName = command.name?.trim().toLowerCase() ?? "";
    const name = canonicalPowerShellCommandName(rawName);
    if (!name) {
      return "dynamic command invocation is not allowed";
    }
    const blocked = BLOCKED_COMMANDS.get(name);
    if (blocked) return blocked;

    const parameters = command.arguments.filter((argument) => argument.kind === "parameter");
    if (parameters.some((parameter) => ENCODED_COMMAND_FLAGS.has("-" + parameter.name.toLowerCase()))) {
      return "encoded commands are not allowed";
    }
    if (REMOVE_ITEM_COMMANDS.has(name) && parameters.some((parameter) => isPowerShellRecursion(name, parameter))
      && parameters.some(isPowerShellForce)) {
      return "recursive forced deletion is not allowed";
    }
  }
  if (ast.unsupported.length) return `unsupported PowerShell execution state: ${ast.unsupported[0]}`;
  return null;
}

export function validatePowerShellAst(ast: PowerShellAstSummary): string | null {
  const structural = validatePowerShellAstStructure(ast);
  if (structural) return structural;
  for (const command of ast.commands) {
    const name = canonicalPowerShellCommandName(command.name?.trim().toLowerCase() ?? "");
    if (!FILESYSTEM_COMMANDS.has(name)) continue;
    const parameters = command.arguments.filter((argument) => argument.kind === "parameter");
    if (parameters.some((parameter) => isPowerShellRecursion(name, parameter))) {
      return "recursive shell filesystem traversal is not allowed";
    }
    const dynamic = command.arguments.slice(1).find((argument) => argument.kind === "dynamic"
      || (argument.kind === "parameter" && argument.argument?.kind === "dynamic"));
    if (dynamic) return `dynamic path argument is not allowed: ${dynamic.text}`;
  }
  return null;
}

function canonicalPowerShellCommandName(name: string): string {
  return POWERSHELL_ALIASES.get(name) ?? name;
}

type PowerShellParameter = Extract<PowerShellArgument, { kind: "parameter" }>;

// PowerShell binds any unambiguous name prefix; an ambiguous one fails to bind, so matching it only over-blocks.
function isPowerShellParameterPrefix(parameter: PowerShellParameter, name: string, minimum = 1): boolean {
  const spelled = parameter.name.toLowerCase();
  return spelled.length >= minimum && name.startsWith(spelled);
}

// -Depth implies -Recurse whatever its value; Get-ChildItem also aliases Recurse as -s.
function isPowerShellRecursion(command: string, parameter: PowerShellParameter): boolean {
  if (isPowerShellParameterPrefix(parameter, "depth")) return true;
  const recurse = isPowerShellParameterPrefix(parameter, "recurse")
    || (command === "get-childitem" && parameter.name.toLowerCase() === "s");
  return recurse && isPowerShellSwitchEnabled(parameter);
}

// -f is ambiguous with -Filter on Remove-Item.
function isPowerShellForce(parameter: PowerShellParameter): boolean {
  return isPowerShellParameterPrefix(parameter, "force", 2) && isPowerShellSwitchEnabled(parameter);
}

function isPowerShellSwitchEnabled(parameter: PowerShellParameter): boolean {
  return parameter.argument === undefined || parameter.argument.kind !== "literal" || parameter.argument.value.toLowerCase() !== "false";
}

export function findPowerShellAstPathViolation(
  ast: PowerShellAstSummary, cwd: string, sandboxRoot: string, extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean,
  source?: string,
): ShellPathPolicyViolation | null {
  const cwdError = validateShellWorkingDirectory(cwd, sandboxRoot, extraAllowedDirectories);
  if (cwdError) return { kind: cwdError.startsWith("Sensitive") ? "sensitive-path" : "sandbox-boundary", reason: cwdError, path: cwd };
  const structural = validatePowerShellAst(ast);
  if (structural) return { kind: "dynamic-path", reason: `PowerShell command blocked: ${structural}` };
  const inspect = (argument: PowerShellArgument, effect: "read" | "write", literalPath = false): ShellPathPolicyViolation | null => {
    if (argument.kind === "parameter") return argument.argument ? inspect(argument.argument, effect, literalPath) : null;
    if (argument.kind !== "literal") return { kind: "dynamic-path", reason: "PowerShell path argument is unresolved", candidate: argument.text };
    const path = argument.value;
    if (path.startsWith("~") || (!literalPath && /[*?\[\]]/.test(path)) || /^[a-z][a-z0-9_-]*:(?![\\/])/i.test(path)) {
      return { kind: "dynamic-path", reason: "PowerShell provider, home or wildcard path requires an explicit ordinary path", candidate: argument.text };
    }
    let absolute: string;
    try { absolute = resolveShellFilesystemPath(path, cwd); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      return { kind: "invalid-path", reason: "PowerShell path cannot be resolved", candidate: argument.text };
    }
    return findResolvedShellPathViolation(absolute, argument.text, sandboxRoot, extraAllowedDirectories, effect, blockReadsOutsideWorkingDirectories);
  };
  for (const redirect of ast.redirections) { const violation = inspect(redirect, "write"); if (violation) return violation; }
  for (const command of ast.commands) {
    const name = canonicalPowerShellCommandName(command.name!.toLowerCase());
    const runtimeReads = powerShellHostScriptReadPaths(ast, source);
    if (runtimeReads.length > 0) {
      const violation = inspect(command.arguments[0]!, "read", true);
      if (violation) return violation;
    }
    if (["set-location", "cd", "sl", "push-location", "pushd", "pop-location", "popd", "set-alias", "new-alias", "import-module", "remove-module"].includes(name)) {
      return { kind: "dynamic-path", reason: "PowerShell location or command-identity changes require a separate invocation", candidate: command.arguments[0]?.text };
    }
    if (["write-output", "echo", "write-host", "write-error", "write-warning", "write-verbose", "write-debug", "write-information", "start-sleep", "select-object", "measure-object", "format-list", "format-table", "out-string"].includes(name)) continue;
    const effect = ["get-content", "get-childitem", "get-item", "get-itemproperty", "test-path"].includes(name) ? "read" : "write";
    let positional = 0;
    for (let index = 1; index < command.arguments.length; index += 1) {
      const argument = command.arguments[index]!;
      if (argument.kind === "parameter" && argument.name.toLowerCase() === "literalpath" && FILESYSTEM_COMMANDS.has(name)) {
        const target = argument.argument ?? command.arguments[++index];
        if (!target || target.kind === "parameter") return { kind: "dynamic-path", reason: "PowerShell literal path argument is missing", candidate: argument.text };
        const violation = inspect(target, effect, true); if (violation) return violation;
        continue;
      }
      if (argument.kind === "parameter" && ["value", "encoding", "itemtype", "type", "filter", "include", "exclude"].includes(argument.name.toLowerCase()) && FILESYSTEM_COMMANDS.has(name)) {
        if (!argument.argument) index += 1;
        continue;
      }
      if (argument.kind !== "parameter") {
        positional += 1;
        if (["set-content", "add-content", "set-item", "set-itemproperty"].includes(name) && positional > 1) continue;
      }
      const violation = inspect(argument, index === 1 && runtimeReads.length > 0 ? "read" : effect); if (violation) return violation;
    }
  }
  return null;
}

// The Windows runtime is a GUI-subsystem image: `&` returns before it exits unless its output is piped,
// and the sandbox then tears it down. Node's main-script realpath lstat()s the drive root, which MXC
// denies; the verified script is never a link, so preserving the main path is equivalent.
// The console decodes child output with the OEM code page unless told it is UTF-8.
export function awaitedHostScriptCommand(source: string, invocation: PowerShellAstSummary["commands"][number]): string | null {
  const { start, end, text } = invocation.arguments[0]!;
  if (start === undefined || end === undefined || source.slice(start, end) !== text) return null;
  // A runtime that never starts leaves $LASTEXITCODE unset; that must not read as success.
  return `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${source.slice(0, end)} --preserve-symlinks-main` +
    `${source.slice(end).trimEnd()} | Microsoft.PowerShell.Core\\Out-Default; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;
}

function powerShellHostScriptReadPaths(ast: PowerShellAstSummary, source?: string): readonly string[] {
  if (ast.commands.length !== 1 || source === undefined) return [];
  const command = ast.commands[0]!;
  const text = source.trim();
  if (!text.endsWith(command.text)) return [];
  const prefix = text.slice(0, text.length - command.text.length).trim();
  if (!/^\$env:ELECTRON_RUN_AS_NODE\s*=\s*(['"])1\1\s*;$/.test(prefix)) return [];
  return hostScriptInvocationReadPaths(command.arguments.map((argument) => argument.kind === "literal" ? argument.value : undefined),
    { ELECTRON_RUN_AS_NODE: "1" });
}

export async function findPowerShellCommandPathViolation(
  command: string, cwd: string, sandboxRoot: string, extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean,
): Promise<ShellPathPolicyViolation | null> {
  return findPowerShellAstPathViolation(await parsePowerShellAst(command), cwd, sandboxRoot, extraAllowedDirectories, blockReadsOutsideWorkingDirectories, command);
}

/** Parser and execution select the same verified absolute installation image. */
export function resolvePowerShellExecutable(): string {
  const installation = resolveTrustedPowerShellExecutable();
  if (installation === null) throw new Error("Trusted PowerShell installation is unavailable");
  return installation.executable;
}

async function parsePowerShellAstInMxc(command: string, cwd: string, ctx: ToolExecutionContext, timeoutSeconds: number): Promise<PowerShellAstSummary | { failure: ToolExecutionResult }> {
  // Only AST input is embedded; decoding never executes the supplied source.
  const input = Buffer.from(command, "utf8").toString("base64");
  const parserScript = POWER_SHELL_AST_PARSER.replace("[Console]::In.ReadToEnd()", `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${input}'))`);
  const writePaths = deriveSandboxWritePaths({
    ...(ctx.ownerPluginSandboxRoot !== undefined ? { ownerPluginSandboxRoot: ctx.ownerPluginSandboxRoot } : {}),
    allowedDirectories: [cwd, ...ctx.extraAllowedDirectories],
  });
  const response = createPowerShellParserResponse();
  const result = await spawnPowerShellInMxc(parserScript, cwd, writePaths, timeoutSeconds, ctx.abortSignal, undefined, undefined,
    typeof ctx.metadata.toolUseId === "string" ? ctx.metadata.toolUseId : undefined, response);
  if (result.isError) return { failure: result };
  return normalizePowerShellAstSummary(JSON.parse(response.read()));
}

interface VerifiedPowerShellExecution {
  readonly command: string;
  readonly executable: string;
  readonly identity: VerifiedShellIdentity;
  readonly handle: VerifiedShellCommand;
}

function powerShellExecutionEnvironment(verified: VerifiedPowerShellExecution | undefined, base: Record<string, string>): Record<string, string> {
  return verified === undefined ? base : verifiedShellEnvironment(verified.handle, verified.identity, base);
}

function spawnManagedPowerShell(executable: string, command: string, options: SpawnOptions & { env: Record<string, string> }, verified?: VerifiedPowerShellExecution): ManagedPowerShellChild {
  const launch = preparePowerShellLaunch(command, options.env);
  try {
    const child = spawn(executable, launch.args, { ...options, env: powerShellExecutionEnvironment(verified, launch.env) }) as ManagedPowerShellChild;
    retainPowerShellLaunchUntilExit(launch, child);
    return child;
  } catch (error) { launch.cleanup(); throw error; }
}

async function parsePowerShellAst(command: string, authorized = false): Promise<PowerShellAstSummary> {
  if (!isPowerShellStartupPinned() && !authorized) throw new Error(POWERSHELL_STARTUP_UNPROVEN_REASON);
  return new Promise<PowerShellAstSummary>((resolve, reject) => {
    const executable = resolvePowerShellExecutable();
    assertManagedChildProcessAdmissionOpen("tool:powershell-parser");
    const parser = spawnManagedPowerShell(
      executable, POWER_SHELL_AST_PARSER,
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSafeChildEnv(),
      },
    );
    trackManagedChildProcess(parser, { label: "tool:powershell-parser" });
    const response = createPowerShellParserResponse();
    const stderr: Buffer[] = [];
    parser.stdout.on("data", response.collect);
    parser.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    parser.on("error", (err) => {
      const message = err && "code" in err && err.code === "ENOENT"
        ? `PowerShell executable not found: ${executable}`
        : `PowerShell parser failed: ${err.message}`;
      reject(new Error(message));
    });
    parser.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell parser exited with ${code}: ${Buffer.concat(stderr).toString("utf-8").trim()}`));
        return;
      }
      try {
        resolve(normalizePowerShellAstSummary(JSON.parse(response.read())));
      } catch (err) {
        reject(new Error(`PowerShell parser returned invalid JSON: ${(err as Error).message}`));
      }
    });
    parser.stdin!.end(command);
  }).catch((err) => ({
    errors: [(err as Error).message],
    commands: [], redirections: [], unsupported: [],
  }));
}

/**
 * POSIX single-quote escape one argument so it survives the `<shell> -c <wrap>`
 * layer that ASRT's `wrapWithSandboxArgv` returns on macOS/Linux. Wrap in single
 * quotes and replace each embedded `'` with `'\''`. Self-contained (no
 * shell-quote dependency, which is only transitively present).
 */
function posixSingleQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Execute a PowerShell command under the ASRT sandbox — parity with bash.ts's
 * {@link spawnWithSandbox}.
 *
 * Windows wrapping receives the command and an explicit absolute shell image
 * with its argument prefix. The wrapper renders one inner shell, without
 * another executable lookup or a nested command interpreter.
 *
 *   On mac/linux ASRT wraps a SHELL COMMAND STRING (argv `[<shell>, -c,
 *   <wrapped>]`). pwsh is invoked there only as a `-Command` payload of the
 *   POSIX shell, so we still render the pwsh invocation as a single POSIX-quoted
 *   command line for that path (preserving the established mac/linux behaviour).
 *
 * Filesystem jail mirrors bash.ts: `allowWrite` = the derived write-jail, and
 * reads keep the existing sensitive and private-session floors.
 * Windows ASRT is not shell-contained and ASRT 0.0.80 cannot accept the
 * per-exec allowRead/allowWrite grants this path needs, so executeTyped refuses
 * before this function on win32; the win32 binShell branch remains defensive
 * for future ASRT capability changes.
 *
 * @internal — called only when the host has verified active OS confinement.
 */
async function spawnPowerShellWithSandbox(
  command: string,
  cwd: string,
  writePaths: readonly string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
  outputCaptureFactory?: BoundOutputCaptureFactory,
  progress?: ToolOutputProgressSink,
  toolUseId?: string,
  runtimeReadPaths: readonly string[] = [],
  verified?: VerifiedPowerShellExecution,
): Promise<ToolExecutionResult> {
  const waitForClose = verified !== undefined && verifiedShellRequiresResultCheck(verified.handle, verified.identity);
  signal?.throwIfAborted();
  // Resolve before allocating the temporary profile so a missing PowerShell
  // executable cannot leave an orphaned sandbox HOME behind.
  const executable = resolvePowerShellExecutable();
  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    return {
      output: `PowerShell spawn failed: could not create isolated HOME: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }
  const isWindows = process.platform === "win32";
  let powerShellLaunch: ReturnType<typeof preparePowerShellLaunch>;
  try { powerShellLaunch = preparePowerShellLaunch(verified?.command ?? command, powerShellExecutionEnvironment(verified, buildSafeChildEnv({ ...sandboxHome.env })), sandboxHome); }
  catch (error) { sandboxHome.cleanup(); throw error; }
  const sandboxCommand = isWindows ? powerShellLaunch.args.at(-1)!
    : [executable, ...powerShellLaunch.args].map(posixSingleQuote).join(" ");
  const binShell = isWindows
    ? { exe: executable, args: powerShellLaunch.args.slice(0, -1) } : undefined;

  const home = getPolicyHome();
  const sandboxWritePaths = [...writePaths, sandboxHome.path];
  const { allowRead, denyRead, floorPierces } = getBuiltinShellReadPolicy([cwd, ...sandboxWritePaths, ...runtimeReadPaths, ...(verified === undefined ? [] : [verified.executable])], home, sandboxHome.path);
  const filesystem = {
    allowWrite: sandboxWritePaths,
    allowRead,
    denyRead,
    denyWrite: getDefaultSensitiveWriteDenyPaths(),
    floorPierces,
  };

  const abortController = new AbortController();
  const wrapAbortSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;
  const egress = openEgressInvocation(
    { kind: "shell", toolName: "powershell", toolUseId, context: ambientShellEgressContext() },
    { abortSignal: wrapAbortSignal },
  );
  let wrapped: SandboxWrapResult;
  try {
    wrapped = await wrapToolCommand(sandboxCommand, {
      filesystem,
      abortSignal: wrapAbortSignal,
      commandId: egress.token,
      denyUnixSockets: true,
      ...(binShell !== undefined ? { binShell } : {}),
    });
  } catch (err) {
    egress.release();
    sandboxHome.cleanup();
    return {
      output: `PowerShell spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  const [cmd, ...args] = wrapped.argv;
  if (signal?.aborted) {
    void cleanupAsrtSandboxAfterCommand();
    egress.release();
    sandboxHome.cleanup();
    const annotated = await annotateSandboxCommandResult(egress.token, wrapped, "Shell command cancelled.", command, true);
    const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
    return { output: annotated.output, isError: true, metadata: { ...cleanupMetadata, aborted: true, sandboxed: false } };
  }
  if (cmd === undefined) {
    void cleanupAsrtSandboxAfterCommand();
    egress.release();
    sandboxHome.cleanup();
    const annotated = await annotateSandboxCommandResult(egress.token, wrapped, "PowerShell spawn failed: ASRT returned an empty argv", command, true);
    const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
    return {
      output: annotated.output,
      isError: true,
      metadata: { ...cleanupMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  // Per-platform env: on win32 ASRT returns a REAL env carrying the proxy
  // set the sandboxed child needs (srt-win forwards its env verbatim — the proxy
  // vars are NOT baked into the command string as they are on mac/linux). On
  // mac/linux `wrapped.env` IS process.env (the proxy is in the wrapped command
  // string). Either way buildSandboxedChildEnv composes the SAME secret-stripped
  // result: it starts from the safe whitelist baseline and overlays ONLY the
  // allow-listed proxy/CA/SANDBOX_RUNTIME keys ASRT set/changed — so on win32
  // the proxy set is propagated (the "spread") and on mac/linux nothing extra
  // leaks (ASRT changed nothing in process.env). Secrets stay stripped on both.
  const childEnv = powerShellExecutionEnvironment(verified, buildSandboxedChildEnv(wrapped.env, { ...sandboxHome.env,
    XDG_CONFIG_HOME: powerShellLaunch.env.XDG_CONFIG_HOME!, PSModulePath: powerShellLaunch.env.PSModulePath!,
  }));
  let observation: AgentTerminalObservationLease | undefined;
  try { observation = startShellObservation(command, cwd,
    { mode: "isolated", detail: "filesystem/process confinement" }, egress.token); }
  catch (error) { void cleanupAsrtSandboxAfterCommand(); egress.release(); sandboxHome.cleanup(); throw error; }

  return await new Promise<ToolExecutionResult>((resolveResult) => {
    let child: PipedChild;
    try {
      assertManagedChildProcessAdmissionOpen("tool:powershell:asrt");
      assertSrtWinSpawnIntegrity(cmd);
      child = spawn(cmd, args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: childEnv,
      });
    } catch (err) {
      observation?.finish(null, "failed");
      void cleanupAsrtSandboxAfterCommand();
      egress.release();
      sandboxHome.cleanup();
      void annotateSandboxCommandResult(egress.token, wrapped, `PowerShell spawn failed: ${(err as Error).message}`, command, true).then(annotated => {
        const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
        resolveResult({
          output: annotated.output,
          isError: true,
          metadata: { ...cleanupMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
        });
      });
      return;
    }
    const closed = checkedShellClose(child, waitForClose);
    trackManagedChildProcess(child, { killProcessGroup: process.platform !== "win32", label: "tool:powershell:asrt" });
    // Detached, the child leads its own process group: the sandbox keeps the
    // ended invocation's listener port while anything in that group lives.
    if (process.platform !== "win32" && child.pid !== undefined) egress.noteProcessGroup(child.pid);

    const outputCollector = createOutputCollector(child, { captureFactory: outputCaptureFactory, progress, observation });
    child.stdout.on("data", outputCollector.collect);
    child.stderr.on("data", outputCollector.collectStderr);

    let settled = false;

    let lifecycleCleaned = false;
    const cleanupAfterTermination = (): void => {
      if (lifecycleCleaned) return;
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) return;
      lifecycleCleaned = true;
      void cleanupAsrtSandboxAfterCommand();
      egress.release();
      sandboxHome.cleanup();
      egress.release();
    };
    const lifetime = watchShellLifetime(child, timeoutSeconds, signal, () => abortController.abort());

    const finish = async (code: number | null, signal: NodeJS.Signals | null = null): Promise<void> => {
      if (closed !== undefined) await closed;
      if (lifetime.termination) await lifetime.termination;
      cleanupAfterTermination();
      lifetime.dispose();
      if (settled) return;
      settled = true;
      const artifactMetadata = await outputCollector.finish(lifetime.timedOut || lifetime.aborted || signal !== null);
      const { output, sandboxCleanupFailed } = await annotateSandboxCommandResult(egress.token, wrapped, lifetime.output(outputCollector.format(
        lifetime.timedOut || lifetime.aborted ? undefined : { code, signal },
      )), command, lifecycleCleaned);
      outputCollector.finishObservation(code, lifetime.aborted ? "cancelled" : lifetime.timedOut || signal !== null || sandboxCleanupFailed ? "failed" : undefined);
      resolveResult({
        output: lifetime.timedOut
          ? `PowerShell command timed out after ${resolveShellTimeoutMs(timeoutSeconds) / 1000} seconds.\n${output}`
          : output,
        isError: lifetime.aborted || lifetime.timedOut || code !== 0 || sandboxCleanupFailed,
        metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code, timedOut: lifetime.timedOut, sandboxed: true,
          ...(sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {}) },
      });
    };

    void lifetime.stopped.then(() => finish(child.exitCode));
    child.once("close", (code, signal) => { void finish(code, signal); });
    child.on("error", (err) => {
      void (async () => {
        if (closed !== undefined) await closed;
        if (settled) return;
        settled = true;
        const artifactMetadata = await outputCollector.finish(true);
        // `error` may be a failed operation on a live process. The definitive
        // `close` event retains ASRT/HOME cleanup ownership.
        cleanupAfterTermination();
        const annotated = await annotateSandboxCommandResult(egress.token, wrapped,
          err && "code" in err && err.code === "ENOENT"
            ? `PowerShell executable not found: ${executable}`
            : `PowerShell spawn failed: ${err.message}`, command, lifecycleCleaned);
        outputCollector.finishObservation(null, "failed");
        const cleanupMetadata = annotated.sandboxCleanupFailed ? { sandboxCleanupFailed: true } : {};
        resolveResult({
          output: annotated.output,
          isError: true,
          metadata: { ...artifactMetadata, ...cleanupMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
        });
      })();
    });
  });
}

/**
 * Execute a PowerShell command in its own Microsoft Execution Containers
 * container (Windows hosts whose OS offers MXC's BaseContainer tier; see
 * `permissions/mxc-windows.ts`).
 *
 * The container runs System32 Windows PowerShell 5.1 with the command
 * `-EncodedCommand`-encoded. Its filesystem lists are the same per-command
 * policy {@link spawnPowerShellWithSandbox} hands ASRT, ranked for MXC. Its
 * network reaches only this invocation's proxy listener, which stamps the
 * invocation's identity on every request it forwards to the ASRT proxy, so a
 * refused host is recorded under this call's token exactly as on macOS and
 * Linux. `wxc-exec.exe` relays stdout, stderr and the exit code; killing it on
 * timeout or abort ends the container and every process in it.
 *
 * @internal — called only for a plan whose substrate is `mxc`.
 */
async function spawnPowerShellInMxc(
  command: string,
  cwd: string,
  writePaths: readonly string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
  outputCaptureFactory?: BoundOutputCaptureFactory,
  progress?: ToolOutputProgressSink,
  toolUseId?: string,
  parserResponse?: ReturnType<typeof createPowerShellParserResponse>,
  runtimeReadPaths: readonly string[] = [],
  verified?: VerifiedPowerShellExecution,
): Promise<ToolExecutionResult> {
  const waitForClose = verified !== undefined && verifiedShellRequiresResultCheck(verified.handle, verified.identity);
  signal?.throwIfAborted();
  const systemRoot = windowsSystemRoot();
  const installation = resolveTrustedPowerShellExecutable();
  const systemExecutable = win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe");
  if (installation === null || installation.kind !== "windows-powershell"
    || win32Path.normalize(installation.executable).toLowerCase() !== systemExecutable.toLowerCase()) {
    return {
      output: "PowerShell spawn failed: trusted system installation is unavailable",
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }
  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    return {
      output: `PowerShell spawn failed: could not create isolated HOME: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }
  const powerShellLaunch = preparePowerShellLaunch(verified?.command ?? command, powerShellExecutionEnvironment(verified, buildSafeChildEnv({ ...sandboxHome.env })), sandboxHome);
  const sandboxWritePaths = [...writePaths, sandboxHome.path];
  const hostHome = process.env["USERPROFILE"] ?? process.env["HOME"];
  const { allowRead, denyRead, floorPierces } = getBuiltinShellReadPolicy([cwd, ...sandboxWritePaths, ...runtimeReadPaths, ...(verified === undefined ? [] : [verified.executable])], hostHome, sandboxHome.path);
  const egress = openEgressInvocation(
    { kind: "shell", toolName: "powershell", toolUseId, context: ambientShellEgressContext() },
    signal ? { abortSignal: signal } : {},
  );
  let launch: MxcShellLaunch;
  try {
    // MXC bypasses the ASRT wrap, so it takes the same mandatory write floor
    // the per-command ASRT config restates: workspace control files (.git
    // controls, .vscode, .husky, .claude, .envrc, …) and Ave's permission,
    // approval and egress grant stores. Ranking keeps a deny inside a granted
    // directory as read-only (existing) or denied (absent).
    const sensitiveDenyWrite = getDefaultSensitiveWriteDenyPaths();
    const mandatory = buildMandatorySandboxWritePolicy(sandboxWritePaths, undefined, sensitiveDenyWrite);
    launch = await prepareMxcShellLaunch({
      egressToken: egress.token,
      commandLine: powerShellMxcCommandLine(systemRoot, powerShellLaunch.args.at(-1)!),
      cwd,
      filesystem: {
        allowWrite: mandatory.allowWrite,
        allowRead,
        denyRead,
        denyWrite: [...new Set([
          ...sensitiveDenyWrite,
          ...mandatory.denyWrite.map((entry) => typeof entry === "string" ? entry : entry.path),
        ])],
        floorPierces,
      },
      env: powerShellExecutionEnvironment(verified, powerShellLaunch.env),
      timeoutMs: resolveShellTimeoutMs(timeoutSeconds),
      exists: existsSync,
    });
  } catch (err) {
    egress.release();
    sandboxHome.cleanup();
    return {
      output: `PowerShell spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }
  const [cmd, ...args] = launch.argv;
  if (signal?.aborted || cmd === undefined) {
    void launch.release();
    sandboxHome.cleanup();
    egress.release();
    return { output: "Shell command cancelled.", isError: true, metadata: { aborted: true, sandboxed: false } };
  }
  let observation: AgentTerminalObservationLease | undefined;
  try { observation = parserResponse === undefined ? startShellObservation(command, cwd,
    { mode: "isolated", detail: "filesystem/process confinement" }, egress.token) : undefined; }
  catch (error) { void launch.release(); sandboxHome.cleanup(); egress.release(); throw error; }

  return await new Promise<ToolExecutionResult>((resolveResult) => {
    let child: PipedChild;
    try {
      assertManagedChildProcessAdmissionOpen("tool:powershell:mxc");
      child = spawn(cmd, args, {
        // The launcher runs from its own (per-machine, admin-only) directory, so
        // nothing in the workspace sits beside it; the container's working
        // directory travels in the request.
        cwd: win32Path.dirname(cmd),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        // The launcher's own environment: the container's is in the request.
        env: buildSafeChildEnv({}),
      });
    } catch (err) {
      observation?.finish(null, "failed");
      void launch.release();
      sandboxHome.cleanup();
      egress.release();
      resolveResult({
        output: `PowerShell spawn failed: ${(err as Error).message}`,
        isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
      });
      return;
    }
    const closed = checkedShellClose(child, waitForClose);
    trackManagedChildProcess(child, { killProcessGroup: false, label: "tool:powershell:mxc" });
    launch.bindChild(child);

    const outputCollector = createOutputCollector(child, { captureFactory: outputCaptureFactory, progress, observation });
    child.stdout.on("data", parserResponse === undefined ? outputCollector.collect : parserResponse.collect);
    child.stderr.on("data", outputCollector.collectStderr);

    let settled = false;
    let lifecycleCleaned = false;
    // After wxc-exec exits the container is gone, so the listener can close:
    // nothing is left that could reach its port.
    const cleanupAfterTermination = (): Promise<void> => {
      if (lifecycleCleaned) return Promise.resolve();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) return Promise.resolve();
      lifecycleCleaned = true;
      sandboxHome.cleanup();
      return launch.release().finally(() => egress.release());
    };
    const lifetime = watchShellLifetime(child, timeoutSeconds, signal);

    const finish = async (code: number | null, signal: NodeJS.Signals | null = null): Promise<void> => {
      if (closed !== undefined) await closed;
      lifetime.dispose();
      if (settled) {
        await cleanupAfterTermination();
        return;
      }
      settled = true;
      const artifactMetadata = await outputCollector.finish(lifetime.timedOut || lifetime.aborted || signal !== null);
      // Read the proxy's refusals under this call's token before releasing it.
      const output = await annotateWithSandboxViolations(egress.token, lifetime.output(outputCollector.format(
        lifetime.timedOut || lifetime.aborted ? undefined : { code, signal },
      )));
      await cleanupAfterTermination();
      outputCollector.finishObservation(code, lifetime.aborted ? "cancelled" : lifetime.timedOut || signal !== null ? "failed" : undefined);
      resolveResult({
        output: lifetime.timedOut
          ? `PowerShell command timed out after ${resolveShellTimeoutMs(timeoutSeconds) / 1000} seconds.\n${output}`
          : output,
        isError: lifetime.aborted || lifetime.timedOut || code !== 0,
        metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code, timedOut: lifetime.timedOut, sandboxed: true },
      });
    };

    void lifetime.stopped.then(() => finish(child.exitCode));
    child.once("close", (code, signal) => { void finish(code, signal); });
    child.on("error", (err) => {
      void (async () => {
        if (closed !== undefined) await closed;
        // A spawn that fails (no pid) may never emit "close": release the
        // listener, the egress token and the sandbox HOME here. A running
        // child keeps its timeout and abort watch, and "close" releases its
        // resources (cleanupAfterTermination's guard waits for the exit).
        if (child.pid === undefined) {
          lifetime.dispose();
          await cleanupAfterTermination();
        }
        if (settled) return;
        settled = true;
        const artifactMetadata = await outputCollector.finish(true);
        outputCollector.finishObservation(null, "failed");
        resolveResult({
          output: `PowerShell spawn failed: ${err.message}`,
          isError: true,
          metadata: { ...artifactMetadata, sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
        });
      })();
    });
  });
}

async function spawnPowerShell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  outputCaptureFactory?: BoundOutputCaptureFactory,
  progress?: ToolOutputProgressSink,
  spawnAuthorization?: HostShellSpawnAuthorization,
  verified?: VerifiedPowerShellExecution,
  sandbox: AgentTerminalObservationInput["sandbox"] = { mode: "unconfined", detail: "host" },
): Promise<ToolExecutionResult> {
  const waitForClose = verified !== undefined && verifiedShellRequiresResultCheck(verified.handle, verified.identity);
  signal?.throwIfAborted();
  const executable = resolvePowerShellExecutable();
  const prelude = spawnAuthorization === undefined ? undefined : hostShellWorkingDirectoryPrelude(spawnAuthorization.cwdIdentity, "powershell", process.platform);
  const launch = (): Promise<ToolExecutionResult> => new Promise((resolve) => {
    signal?.throwIfAborted();
    assertManagedChildProcessAdmissionOpen("tool:powershell");
    const observation = startShellObservation(command, cwd, sandbox);
    let child: PipedChild;
    try { child = spawnManagedPowerShell(
      executable, (prelude ?? "") + (verified?.command ?? command),
      {
        windowsHide: true,
        detached: process.platform !== "win32",
        cwd,
        stdio: prelude === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe"],
        env: powerShellExecutionEnvironment(verified, buildHostShellChildEnv()),
        shell: false,
      }, verified,
    ) as PipedChild; }
    catch (error) { observation?.finish(null, "failed"); throw error; }
    const closed = checkedShellClose(child, waitForClose);
    const control = prelude === undefined || spawnAuthorization === undefined ? undefined : attachHostShellControlChannel(child, spawnAuthorization);
    trackManagedChildProcess(child, { killProcessGroup: process.platform !== "win32", label: "tool:powershell" });

    const outputCollector = createOutputCollector(child, { captureFactory: outputCaptureFactory, progress, observation });
    child.stdout.on("data", outputCollector.collect);
    child.stderr.on("data", outputCollector.collectStderr);

    let settled = false;

    const lifetime = watchShellLifetime(child, timeoutSeconds, signal);

    const finish = async (code: number | null, signal: NodeJS.Signals | null = null): Promise<void> => {
      if (closed !== undefined) await closed;
      if (lifetime.termination) await lifetime.termination;
      lifetime.dispose();
      if (settled) return;
      settled = true;
      const rejected = control?.rejected === true;
      control?.dispose();
      const artifactMetadata = await outputCollector.finish(lifetime.timedOut || lifetime.aborted || signal !== null);
      outputCollector.finishObservation(code, lifetime.aborted ? "cancelled" : lifetime.timedOut || signal !== null ? "failed" : undefined);
      const output = lifetime.output(outputCollector.format(
        lifetime.timedOut || lifetime.aborted ? undefined : { code, signal },
      ));
      resolve({
        output: lifetime.timedOut
          ? `PowerShell command timed out after ${resolveShellTimeoutMs(timeoutSeconds) / 1000} seconds.\n${output}`
          : rejected
            ? `PowerShell spawn failed: ${HOST_SHELL_AUTHORIZATION_REVOKED_ERROR}` : output,
        isError: rejected || lifetime.aborted || lifetime.timedOut || code !== 0,
        metadata: { ...artifactMetadata, ...lifetime.metadata(), returncode: code, timedOut: lifetime.timedOut },
      });
    };

    void lifetime.stopped.then(() => finish(child.exitCode));
    child.once("close", (code, signal) => { void finish(code, signal); });
    child.on("error", (err) => {
      void (async () => {
        if (closed !== undefined) await closed;
        if (settled) return;
        settled = true;
        control?.dispose();
        const artifactMetadata = await outputCollector.finish(true);
        outputCollector.finishObservation(null, "failed");
        resolve({
          output: err && "code" in err && err.code === "ENOENT"
            ? `PowerShell executable not found: ${executable}`
            : `PowerShell spawn failed: ${err.message}`,
          isError: true,
          metadata: { ...artifactMetadata },
        });
      })();
    });
  });
  if (spawnAuthorization !== undefined && prelude === undefined) {
    const handoff = await withHostShellExecutionHandoff(spawnAuthorization, () => ({ result: launch() }));
    return handoff === undefined
      ? { output: `PowerShell spawn failed: ${HOST_SHELL_AUTHORIZATION_REVOKED_ERROR}`, isError: true } : handoff.result;
  }
  return launch();
}

/** @internal Native process lifetime seam; public calls must pass AST admission. */
export const _spawnPowerShellForTest = spawnPowerShell;
