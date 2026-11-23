import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Writable } from "node:stream";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import { createLogger } from "../lib/logger.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { errorMessage } from "../shared/error-message.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import { createProcessGroupReaper, type ProcessGroupReaper } from "./process-group-reaper.js";

const log = createLogger("ave");
const PROCESS_TREE_KILL_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.processTreeKillMs;
const DETACHED_PROCESS_GROUP_POLL_MS = TOOL_TIMEOUT_POLICY.processGroupPollMs;
const PROCESS_GROUP_RETENTION_WARNING_MS = TOOL_TIMEOUT_POLICY.processGroupRetentionWarningMs;

interface ManagedChildProcess {
  child: ChildProcess;
  label: string;
  killProcessGroup: boolean;
  requireProcessGroupReaper?: boolean;
  processGroupId?: number;
  disposeTimer?: NodeJS.Timeout;
  groupForceTimer?: NodeJS.Timeout;
  disposalStartedAt?: number;
  retentionWarningEmitted?: boolean;
  retainedUntilExit?: boolean;
  exitObserved?: boolean;
  dispose: () => void;
  onSettled: () => void;
  onError: () => void;
}

const managedChildren = new Set<ManagedChildProcess>();
let processGroupReaper: ProcessGroupReaper | undefined;
const pendingTreeKills = new WeakMap<ChildProcess, Promise<void>>();
let managedChildProcessAdmissionSealed = false;

export function sealManagedChildProcessAdmission(reason: string): void {
  if (managedChildProcessAdmissionSealed) return;
  managedChildProcessAdmissionSealed = true;
  log.info({ reason }, "shutdown: sealed managed child process admission");
}

export function assertManagedChildProcessAdmissionOpen(label: string): void {
  if (!managedChildProcessAdmissionSealed) return;
  throw new Error(`[managed-child] refusing to spawn '${label}' after shutdown started`);
}

export interface TrackManagedChildProcessOptions {
  label?: string;
  killProcessGroup?: boolean;
  requireProcessGroupReaper?: boolean;
}

const PROCESS_GROUP_LAUNCH_GATE = [
  'IFS= read -r release <&3 && [ -z "$release" ] || exit 0',
  "exec 3<&-",
  'exec "$@"',
].join("\n");

type LaunchBoundary = "before-registration" | "registration-written" | "acknowledged" | "released";

interface GatedLaunchOptions {
  label: string;
  onSpawn: (child: ChildProcess) => void;
  assertStillValid: () => void;
}

interface LaunchBoundaryTestHooks {
  reaper: ProcessGroupReaper;
  onBoundary: (boundary: LaunchBoundary, pgid: number) => void | Promise<void>;
}

export function spawnGatedManagedProcess(
  command: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  options: GatedLaunchOptions,
): Promise<ChildProcess> {
  return spawnGatedProcess(command, args, spawnOptions, options);
}

export function _spawnGatedManagedProcessForTest(
  command: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  options: GatedLaunchOptions,
  hooks: LaunchBoundaryTestHooks,
): Promise<ChildProcess> {
  return spawnGatedProcess(command, args, spawnOptions, options, hooks);
}

async function spawnGatedProcess(
  command: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  { label, onSpawn, assertStillValid }: GatedLaunchOptions,
  hooks?: LaunchBoundaryTestHooks,
): Promise<ChildProcess> {
  if (process.platform === "win32") throw new Error("Process group launch gates require POSIX");
  const stdio = Array.isArray(spawnOptions.stdio) ? spawnOptions.stdio : Array(3).fill(spawnOptions.stdio);
  if (stdio.length > 3) throw new Error("Process group launch gate requires fd 3");
  assertManagedChildProcessAdmissionOpen(label);
  const reaper = hooks?.reaper ?? hostDeathReaper();
  reaper.assertAvailable();
  const child = spawn("/bin/sh", ["-c", PROCESS_GROUP_LAUNCH_GATE, "launch-gate", command, ...args], {
    ...spawnOptions, shell: false, detached: true, stdio: [stdio[0], stdio[1], stdio[2], "pipe"],
  });
  const release = child.stdio[3];
  const stopped = new AbortController();
  const onError = (error: Error): void => stopped.abort(error);
  const onExit = (): void => stopped.abort(new Error("Process group launch gate exited before release"));
  child.once("error", onError);
  child.once("exit", onExit);
  release?.on("error", onError);
  let tracked = false;
  try {
    onSpawn(child);
    const pgid = child.pid;
    if (pgid === undefined || !(release instanceof Writable)) throw new Error("Process group launch gate did not start");
    if (hooks) await hooks.onBoundary("before-registration", pgid);
    stopped.signal.throwIfAborted();
    trackChild(child, { label, killProcessGroup: true, requireProcessGroupReaper: true }, reaper);
    tracked = true;
    const acknowledgment = await runWithCeiling(
      (signal) => reaper.acknowledge(pgid, signal, hooks && (() => hooks.onBoundary("registration-written", pgid))),
      TOOL_TIMEOUT_POLICY.pluginFactoryMs, stopped.signal, label,
    );
    if (!acknowledgment.ok) throw acknowledgment.error;
    if (hooks) await hooks.onBoundary("acknowledged", pgid);
    assertManagedChildProcessAdmissionOpen(label);
    assertStillValid();
    acknowledgment.value();
    stopped.signal.throwIfAborted();
    // One newline is the release byte. EOF alone leaves read unsuccessful.
    await new Promise<void>((resolve, reject) => {
      release.write("\n", (error) => { if (error) reject(error); else resolve(); });
    });
    if (hooks) await hooks.onBoundary("released", pgid);
    return child;
  } catch (error) {
    if (tracked) void forceKillManagedChildProcess(child, "process group launch failed");
    throw error;
  } finally {
    release?.destroy();
    child.off("exit", onExit);
    if (tracked) child.off("error", onError);
  }
}

// Spawn and track together to preserve quit cleanup; detached POSIX children default to group-kill unless an external supervisor owns them.
export function spawnManaged(
  command: string,
  args: ReadonlyArray<string>,
  spawnOptions: SpawnOptions,
  trackOptions: TrackManagedChildProcessOptions = {},
): ChildProcess {
  const label = trackOptions.label ?? "child-process";
  assertManagedChildProcessAdmissionOpen(label);
  if (trackOptions.requireProcessGroupReaper) assertProcessGroupReaperAvailable();
  // ESLint-style guardrail: callers MUST go through this helper. Direct `spawn()` imports outside of `managed-child-processes.ts` should be flagged by a
  // future lint rule (`no-restricted-imports` allowlisting this module only).
  const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
  const inferredGroupKill =
    spawnOptions.detached === true && process.platform !== "win32";
  trackManagedChildProcess(child, {
    ...trackOptions,
    killProcessGroup: trackOptions.killProcessGroup ?? inferredGroupKill,
  });
  return child;
}

export function trackManagedChildProcess(
  child: ChildProcess,
  options: TrackManagedChildProcessOptions = {},
): () => void {
  return trackChild(child, options);
}

function trackChild(
  child: ChildProcess,
  options: TrackManagedChildProcessOptions,
  launchReaper?: ProcessGroupReaper,
): () => void {
  if (typeof child.once !== "function" || typeof child.off !== "function") {
    return () => {};
  }

  const entry: ManagedChildProcess = {
    child,
    label: options.label ?? "child-process",
    killProcessGroup: options.killProcessGroup === true,
    requireProcessGroupReaper: options.requireProcessGroupReaper,
    processGroupId: resolveProcessGroupId(child, options),
    dispose: () => {},
    onSettled: () => {},
    onError: () => {},
  };

  // Only a process this host spawned goes to the reaper (below): a pid on any other object names nothing the host owns. `spawnfile` is set by
  // node:child_process on every process it starts.
  const reaperHeldGroup = typeof child.spawnfile === "string" ? entry.processGroupId : undefined;
  let releaseGroup: (() => void) | undefined;
  const dispose = (): void => disposeManagedChildProcess(entry, releaseGroup);
  const onSettled = (): void => {
    entry.exitObserved = true;
    if (pendingTreeKills.has(child)) return;
    if (entry.processGroupId !== undefined && processExists(-entry.processGroupId)) {
      scheduleProcessGroupDisposal(entry);
      return;
    }
    entry.dispose();
  };
  const onError = (): void => {
    // A spawn failure has no live pid and will never emit a meaningful exit. Signal-delivery errors on an already spawned process are not termination
    // evidence; retain those children for the shutdown force-kill/drain sweep.
    if (typeof child.pid !== "number" || child.pid <= 0) entry.dispose();
  };
  entry.dispose = dispose;
  entry.onSettled = onSettled;
  entry.onError = onError;

  managedChildren.add(entry);
  child.once("exit", onSettled);
  child.once("close", onSettled);
  child.once("error", onError);
  // The quit sweep dies with the host, so a host killed by SIGKILL or a crash left the group reparented and running. The reaper also holds the
  // group and kills it when the host's end of its pipe closes. Disposal releases it: at once when the leader exits with no group left, and
  // otherwise on the disposal poll (processGroupPollMs, 1 s) that first sees the group gone. The one case the reaper could signal the wrong
  // group: the leader exited while descendants remained, the last of them exits, and within that poll interval the pgid is reused and the host
  // dies. A registration that fails is undone whole: the child is killed, since no owner would end it, and no half-tracked entry is left behind.
  if (reaperHeldGroup !== undefined) {
    try {
      const reaper = launchReaper ?? hostDeathReaper();
      reaper.retain(reaperHeldGroup);
      releaseGroup = () => reaper.release(reaperHeldGroup);
    } catch (error) {
      dispose();
      try {
        forceKillProcessTreeSync(child, entry.killProcessGroup, entry.processGroupId);
      } catch (killError) {
        log.warn(
          { pid: child.pid ?? null, label: entry.label, err: errorMessage(killError) },
          "managed-child: failed to kill a child whose process group the reaper refused",
        );
      }
      throw error;
    }
  }
  if (managedChildProcessAdmissionSealed && isKillable(entry)) {
    if (process.platform === "win32") {
      void forceKillManagedChildProcess(child, "registered after admission seal");
    } else {
      try {
        forceKillProcessTreeSync(child, entry.killProcessGroup, entry.processGroupId);
        log.warn(
          { pid: child.pid ?? null, label: entry.label },
          "shutdown: force killed child registered after admission seal",
        );
      } catch (err) {
        log.warn(
          { pid: child.pid ?? null, label: entry.label, err: errorMessage(err) },
          "shutdown: failed to kill child registered after admission seal",
        );
      }
    }
  }
  return dispose;
}

// Failed admission still leaves a host-owned process. Keep it in cancellation/shutdown sweeps until death, independently of registration.
export function retainUnterminatedChildProcess(child: ChildProcess, label: string): void {
  if (child.exitCode != null || child.signalCode != null) return;
  const existing = [...managedChildren].find((entry) => entry.child === child);
  if (existing) {
    existing.retainedUntilExit = true;
    return;
  }
  const entry: ManagedChildProcess = {
    child, label, killProcessGroup: false, retainedUntilExit: true,
    dispose: () => disposeManagedChildProcess(entry),
    onSettled: () => { entry.exitObserved = true; entry.dispose(); },
    // A signal-delivery error is not death; the transport reports the error while this registration retains ownership.
    onError: () => {},
  };
  managedChildren.add(entry);
  child.once("exit", entry.onSettled);
  child.once("close", entry.onSettled);
  child.on("error", entry.onError);
}

function disposeManagedChildProcess(entry: ManagedChildProcess, releaseGroup?: () => void): void {
  const { child } = entry;
  if (entry.retainedUntilExit && !entry.exitObserved && child.exitCode == null && child.signalCode == null) return;
  const wasTracked = managedChildren.delete(entry);
  if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
  if (entry.groupForceTimer) clearTimeout(entry.groupForceTimer);
  child.off("exit", entry.onSettled);
  child.off("close", entry.onSettled);
  child.off("error", entry.onError);
  if (wasTracked) releaseGroup?.();
}

export function getManagedChildProcessCount(): number {
  return managedChildren.size;
}

// Detached POSIX children lead their own process group; Windows and non-group-kill callers have no group ID.
function resolveProcessGroupId(
  child: ChildProcess,
  options: TrackManagedChildProcessOptions,
): number | undefined {
  if (options.killProcessGroup !== true) return undefined;
  if (process.platform === "win32") return undefined;
  if (typeof child.pid !== "number" || child.pid <= 1) return undefined;
  return child.pid;
}

// Emergency shutdown may be followed immediately by process exit. It cannot depend on another event-loop turn; ordinary cancellation uses the async path.
export function forceKillManagedChildProcesses(reason: string): number {
  let killed = 0;
  let directChildCount = 0;
  const treeKillDeadline = process.platform === "win32"
    ? Date.now() + TOOL_TIMEOUT_POLICY.windowsEmergencyProcessSweepMs
    : undefined;

  for (const entry of [...managedChildren]) {
    const { child, label, killProcessGroup } = entry;
    if (!isKillable(entry)) {
      entry.dispose();
      continue;
    }

    try {
      const pid = child.pid;
      const remainingMs = treeKillDeadline === undefined ? undefined : Math.max(0, treeKillDeadline - Date.now());
      if (remainingMs === 0) {
        directChildCount += 1;
        child.kill("SIGKILL");
      } else {
        forceKillProcessTreeSync(child, killProcessGroup, entry.processGroupId, remainingMs);
      }
      killed += 1;
      log.warn({ pid: pid ?? null, label, killProcessGroup, reason }, "shutdown: force killed managed child process");
    } catch (err) {
      // ESRCH = already dead = expected (silently dispose). EPERM = unkillable foreign uid = real problem (log error). Anything else = unknown filesystem/kernel state (log warn).
      const code = (err as NodeJS.ErrnoException).code;
      const logFields = {
        pid: child.pid ?? null,
        label,
        killProcessGroup,
        reason,
        code: code ?? null,
        err: errorMessage(err),
      };
      if (code === "ESRCH") {
        // Already gone — count it as effectively killed for accounting, do not pollute the warn channel.
        killed += 1;
      } else if (code === "EPERM") {
        log.error(logFields, "shutdown: managed child process force kill blocked by EPERM");
      } else {
        log.warn(logFields, "shutdown: managed child process force kill failed");
      }
    } finally {
      entry.dispose();
    }
  }

  if (directChildCount > 0) {
    log.warn({ reason, directChildCount }, "shutdown: managed child tree-kill budget exhausted");
  }
  return killed;
}

export interface ManagedChildDrainResult {
  killedCount: number;
  unresolvedCount: number;
}

// Force-kill remaining children but retain ownership until bounded exit/close waits finish, allowing confinement and disposable-HOME finalizers to run.
export async function forceKillAndDrainManagedChildProcesses(
  reason: string,
  timeoutMs = 1_000,
): Promise<ManagedChildDrainResult> {
  sealManagedChildProcessAdmission(reason);
  const targets = [...managedChildren];
  let killedCount = 0;

  const completions: Promise<void>[] = [];
  for (const entry of targets) {
    const { child, label, killProcessGroup } = entry;
    if (!isKillable(entry) && !pendingTreeKills.has(child)) {
      entry.dispose();
      continue;
    }
    const pid = child.pid;
    const finish = (): void => {
      if (process.platform === "win32" && !isKillable(entry)) entry.dispose();
      killedCount += 1;
      log.warn(
        { pid: pid ?? null, label, killProcessGroup, reason },
        "shutdown: force killed managed child process before drain",
      );
    };
    const handleError = (err: unknown): void => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        killedCount += 1;
        entry.dispose();
      } else {
        const fields = {
          pid: child.pid ?? null,
          label,
          killProcessGroup,
          reason,
          code: code ?? null,
          err: errorMessage(err),
        };
        if (code === "EPERM") {
          log.error(fields, "shutdown: managed child process drain kill blocked by EPERM");
        } else {
          log.warn(fields, "shutdown: managed child process drain kill failed");
        }
      }
    };
    try {
      const completion = forceKillProcessTree(child, killProcessGroup, entry.processGroupId);
      if (completion) completions.push(completion.then(finish, handleError));
      else finish();
    } catch (err) {
      handleError(err);
    }
  }
  // POSIX kills and accounting remain sequential without yielding between them.
  if (completions.length > 0) await Promise.all(completions);

  const pending = (): ManagedChildProcess[] =>
    targets.filter((entry) => managedChildren.has(entry));
  if (pending().length > 0) {
    await new Promise<void>((resolve) => {
      const startedAt = Date.now();
      const poll = (): void => {
        if (pending().length === 0 || Date.now() - startedAt >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  const unresolved = pending();
  if (unresolved.length > 0) {
    log.warn(
      {
        timeoutMs,
        reason,
        unresolved: unresolved.map((entry) => ({
          pid: entry.child.pid ?? null,
          label: entry.label,
        })),
      },
      "shutdown: managed child drain deadline expired",
    );
  }
  return { killedCount, unresolvedCount: unresolved.length };
}

// Await Windows tree termination before releasing owned resources; cancellation has the same bounded tree-kill semantics as shutdown.
export function forceKillManagedChildProcess(child: ChildProcess, reason: string): void | Promise<void> {
  const pending = pendingTreeKills.get(child);
  const entry = [...managedChildren].find((candidate) => candidate.child === child);
  if (!pending && entry && !isKillable(entry)) {
    entry.dispose();
    return;
  }
  if (!pending && !entry && (child.exitCode != null || child.signalCode != null)) return;

  const handleError = (err: unknown): void => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      entry?.dispose();
    } else {
      log.warn({
        pid: child.pid ?? null,
        label: entry?.label ?? "untracked-child-process",
        reason,
        code: code ?? null,
        err: errorMessage(err),
      }, "managed-child: force kill failed");
    }
  };
  const finish = (): void => {
    if (entry && managedChildren.has(entry)) {
      if (entry.processGroupId !== undefined && processExists(-entry.processGroupId)) {
        // Signal delivery is not proof of termination, including EPERM failures. Keep the original group handle until disappearance is observed.
        scheduleProcessGroupDisposal(entry);
      } else if (process.platform !== "win32" || !isKillable(entry) || (child.pid ?? 0) <= 0) {
        entry.dispose();
      }
    }
  };
  try {
    // Only tracked children are owned through shutdown; an untracked tree kill must not keep a short-lived process alive.
    const completion = pending ?? forceKillProcessTree(child, entry?.killProcessGroup ?? false, entry?.processGroupId, entry !== undefined);
    if (completion) {
      // This public boundary always handles failures, including fire-and-forget transport callbacks. Awaiters observe completion without rejection leaks.
      const handled = completion.then(finish, (err: unknown) => { handleError(err); finish(); });
      pendingTreeKills.set(child, handled);
      void handled.then(() => {
        if (pendingTreeKills.get(child) === handled) pendingTreeKills.delete(child);
      });
      return handled;
    }
  } catch (err) {
    handleError(err);
  }
  finish();
}

function hostDeathReaper(): ProcessGroupReaper {
  processGroupReaper ??= createProcessGroupReaper(undefined, {
    onUnavailable: () => {
      for (const entry of managedChildren) {
        if (entry.requireProcessGroupReaper) void forceKillManagedChildProcess(entry.child, "process group reaper unavailable");
      }
    },
  });
  return processGroupReaper;
}

export function assertProcessGroupReaperAvailable(): void {
  hostDeathReaper().assertAvailable();
}

export function __resetManagedChildProcessesForTest(): void {
  for (const entry of [...managedChildren]) entry.dispose();
  managedChildren.clear();
  processGroupReaper?.shutdown();
  processGroupReaper = undefined;
  managedChildProcessAdmissionSealed = false;
}

function isKillable(entry: ManagedChildProcess): boolean {
  if (entry.processGroupId !== undefined && processExists(-entry.processGroupId)) return true;
  return entry.child.exitCode === null && entry.child.signalCode == null;
}

export function terminateManagedProcessGroup(child: ChildProcess, forceAfterMs: number): void {
  const entry = [...managedChildren].find((candidate) => candidate.child === child && candidate.processGroupId !== undefined);
  const pgid = entry?.processGroupId;
  if (!entry || pgid === undefined || entry.groupForceTimer) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      entry.dispose();
      return;
    }
  }
  entry.groupForceTimer = setTimeout(() => {
    entry.groupForceTimer = undefined;
    void forceKillManagedChildProcess(child, "process group did not terminate");
  }, forceAfterMs);
  entry.groupForceTimer.unref();
}

function scheduleProcessGroupDisposal(entry: ManagedChildProcess): void {
  if (entry.disposeTimer) return;
  if (entry.disposalStartedAt === undefined) entry.disposalStartedAt = Date.now();

  const poll = (): void => {
    entry.disposeTimer = undefined;
    if (entry.processGroupId === undefined || !processExists(-entry.processGroupId)) {
      entry.dispose();
      return;
    }
    const elapsed = Date.now() - (entry.disposalStartedAt ?? Date.now());
    if (elapsed >= PROCESS_GROUP_RETENTION_WARNING_MS && !entry.retentionWarningEmitted) {
      // Root exit does not end the lifetime of its surviving descendants. Warn once while retaining cancellation and shutdown ownership.
      entry.retentionWarningEmitted = true;
      log.warn({
        label: entry.label,
        processGroupId: entry.processGroupId,
        elapsedMs: elapsed,
      }, "managed-child: process group remains live; retaining ownership");
    }
    entry.disposeTimer = setTimeout(poll, DETACHED_PROCESS_GROUP_POLL_MS);
    entry.disposeTimer.unref?.();
  };

  entry.disposeTimer = setTimeout(poll, DETACHED_PROCESS_GROUP_POLL_MS);
  entry.disposeTimer.unref?.();
}

// Only ESRCH proves a process is gone; permission and unexpected probe errors retain ownership.
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

const TASKKILL_PROCESS_NOT_FOUND = 128;

interface TreeKillResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  budgetExceeded: boolean;
  targetGone: boolean;
}

function runWindowsTreeKill(child: ChildProcess, pid: number, holdEventLoop: boolean): Promise<TreeKillResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let targetExited = child.exitCode != null || child.signalCode != null;
    const handleTargetExit = (): void => { targetExited = true; };
    child.once("exit", handleTargetExit);
    child.once("close", handleTargetExit);
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, budgetExceeded = false, targetGone = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", handleTargetExit);
      child.off("close", handleTargetExit);
      resolve({ exitCode, signal, elapsedMs: Date.now() - startedAt, budgetExceeded, targetGone });
    };
    try {
      const runner = spawn(win32SystemBinary("taskkill"), ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, shell: false,
      });
      runner.once("error", () => finish(null, null));
      runner.once("exit", (code, signal) => finish(code, signal));
      timer = setTimeout(() => {
        const targetGone = targetExited || child.exitCode != null || child.signalCode != null || !processExists(pid);
        finish(null, "SIGKILL", true, targetGone);
        try { runner.kill("SIGKILL"); } catch { /* Still try the tree again. */ }
      }, TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
      if (!holdEventLoop) {
        runner.unref?.();
        timer.unref?.();
      }
    } catch {
      finish(null, null);
    }
  });
}

function forceKillProcessTree(
  child: ChildProcess,
  killProcessGroup: boolean,
  processGroupId?: number,
  holdEventLoop = true,
): void | Promise<void> {
  const pending = pendingTreeKills.get(child);
  if (pending) return pending;
  if (process.platform !== "win32" || typeof child.pid !== "number" || child.pid <= 0) {
    forceKillProcessTreeSync(child, killProcessGroup, processGroupId);
    return;
  }
  const pid = child.pid;
  const completion = (async () => {
    // No runtime Windows descendant snapshot is available. Retry the full tree before terminating the root, which would lose its ancestry information.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1 && (child.exitCode != null || child.signalCode != null)) break;
      const result = await runWindowsTreeKill(child, pid, holdEventLoop);
      if (result.targetGone) {
        log.info({ targetPid: pid, attempt, elapsedMs: result.elapsedMs }, "managed-child: taskkill watchdog expired after the target exited");
        return;
      }
      if (result.exitCode === 0) return;
      // 128: the root is already gone, so no /T pass can reach its tree again.
      if (result.exitCode === TASKKILL_PROCESS_NOT_FOUND) break;
      log.warn({ targetPid: pid, attempt, ...result }, "managed-child: taskkill /T /F failed");
    }
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  })();
  pendingTreeKills.set(child, completion);
  const release = (): void => {
    if (pendingTreeKills.get(child) === completion) pendingTreeKills.delete(child);
  };
  void completion.then(release, release);
  return completion;
}

function forceKillProcessTreeSync(
  child: ChildProcess,
  killProcessGroup: boolean,
  processGroupId?: number,
  windowsTimeoutMs: number = TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs,
): void {
  const pid = child.pid;

  if (killProcessGroup && process.platform !== "win32" && processGroupId !== undefined) {
    process.kill(-processGroupId, "SIGKILL");
    return;
  }

  if (typeof pid !== "number" || pid <= 0) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    // One pass only, within the remaining emergency sweep budget.
    const startedAt = Date.now();
    const result = spawnSync(win32SystemBinary("taskkill"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, shell: false,
      timeout: windowsTimeoutMs,
    });
    if (result.status === 0) return;
    log.warn({
      pid, exitCode: result.status ?? null, signal: result.signal ?? null,
      elapsedMs: Date.now() - startedAt,
      budgetExceeded: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    }, "managed-child: synchronous taskkill /T /F failed");
  } else {
    for (const descendantPid of collectDescendantPids(pid).reverse()) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already exited or inaccessible.
      }
    }
  }

  if (process.platform !== "win32" || (child.exitCode == null && child.signalCode == null)) {
    child.kill("SIGKILL");
  }
}

function collectDescendantPids(rootPid: number): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];

  while (stack.length > 0) {
    const pid = stack.pop() as number;
    for (const childPid of listDirectChildPids(pid)) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      descendants.push(childPid);
      stack.push(childPid);
    }
  }

  return descendants;
}

function listDirectChildPids(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TREE_KILL_TIMEOUT_MS,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
