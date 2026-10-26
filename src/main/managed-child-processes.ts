import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import { createLogger } from "../lib/logger.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("ave");
const PROCESS_TREE_KILL_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.processTreeKillMs;
const DETACHED_PROCESS_GROUP_POLL_MS = TOOL_TIMEOUT_POLICY.processGroupPollMs;
const PROCESS_GROUP_RETENTION_WARNING_MS = TOOL_TIMEOUT_POLICY.processGroupRetentionWarningMs;

interface ManagedChildProcess {
  child: ChildProcess;
  label: string;
  killProcessGroup: boolean;
  processGroupId?: number;
  disposeTimer?: NodeJS.Timeout;
  disposalStartedAt?: number;
  retentionWarningEmitted?: boolean;
  dispose: () => void;
  onSettled: () => void;
  onError: () => void;
}

const managedChildren = new Set<ManagedChildProcess>();
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
  // ESLint-style guardrail: callers MUST go through this helper. Direct `spawn()` imports outside of `managed-child-processes.ts` should be flagged by a
  // future lint rule (`no-restricted-imports` allowlisting this module only).
  const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
  const inferredGroupKill =
    spawnOptions.detached === true && process.platform !== "win32";
  trackManagedChildProcess(child, {
    label: trackOptions.label,
    killProcessGroup: trackOptions.killProcessGroup ?? inferredGroupKill,
  });
  return child;
}

export function trackManagedChildProcess(
  child: ChildProcess,
  options: TrackManagedChildProcessOptions = {},
): () => void {
  if (typeof child.once !== "function" || typeof child.off !== "function") {
    return () => {};
  }

  const entry: ManagedChildProcess = {
    child,
    label: options.label ?? "child-process",
    killProcessGroup: options.killProcessGroup === true,
    processGroupId: resolveProcessGroupId(child, options),
    dispose: () => {},
    onSettled: () => {},
    onError: () => {},
  };

  const dispose = (): void => {
    managedChildren.delete(entry);
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    child.off("exit", entry.onSettled);
    child.off("close", entry.onSettled);
    child.off("error", entry.onError);
  };
  const onSettled = (): void => {
    if (pendingTreeKills.has(child)) return;
    if (entry.processGroupId !== undefined && processGroupExists(entry.processGroupId)) {
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
  if (typeof child.pid !== "number" || child.pid <= 0) return undefined;
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
      if (entry.processGroupId !== undefined && processGroupExists(entry.processGroupId)) {
        // Signal delivery is not proof of termination, including EPERM failures. Keep the original group handle until disappearance is observed.
        scheduleProcessGroupDisposal(entry);
      } else if (process.platform !== "win32" || !isKillable(entry) || (child.pid ?? 0) <= 0) {
        entry.dispose();
      }
    }
  };
  try {
    const completion = pending ?? forceKillProcessTree(child, entry?.killProcessGroup ?? false, entry?.processGroupId);
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

export function __resetManagedChildProcessesForTest(): void {
  for (const entry of [...managedChildren]) entry.dispose();
  managedChildren.clear();
  managedChildProcessAdmissionSealed = false;
}

function isKillable(entry: ManagedChildProcess): boolean {
  if (entry.processGroupId !== undefined && processGroupExists(entry.processGroupId)) return true;
  return entry.child.exitCode === null && entry.child.signalCode == null;
}

function scheduleProcessGroupDisposal(entry: ManagedChildProcess): void {
  if (entry.disposeTimer) return;
  if (entry.disposalStartedAt === undefined) entry.disposalStartedAt = Date.now();

  const poll = (): void => {
    entry.disposeTimer = undefined;
    if (entry.processGroupId === undefined || !processGroupExists(entry.processGroupId)) {
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

// Only ESRCH proves a group is gone; permission and unexpected probe errors conservatively keep disposal polling.
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
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
}

function runWindowsTreeKill(pid: number): Promise<TreeKillResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, budgetExceeded = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, elapsedMs: Date.now() - startedAt, budgetExceeded });
    };
    try {
      const runner = spawn(win32SystemBinary("taskkill"), ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, shell: false,
      });
      runner.once("error", () => finish(null, null));
      runner.once("exit", (code, signal) => finish(code, signal));
      timer = setTimeout(() => {
        finish(null, "SIGKILL", true);
        try { runner.kill("SIGKILL"); } catch { /* Still try the tree again. */ }
      }, TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
    } catch {
      finish(null, null);
    }
  });
}

function forceKillProcessTree(
  child: ChildProcess,
  killProcessGroup: boolean,
  processGroupId?: number,
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
      const result = await runWindowsTreeKill(pid);
      if (result.exitCode === 0) return;
      // 128: the root is already gone, so no /T pass can reach its tree again.
      if (result.exitCode === TASKKILL_PROCESS_NOT_FOUND) break;
      log.warn({ pid, attempt, ...result }, "managed-child: taskkill /T /F failed");
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
