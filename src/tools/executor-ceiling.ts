// Link parent cancellation and the execution ceiling; return promptly even if the task ignores abort.

import type { Tool } from "./base.js";
import { MAX_TIMER_DELAY_MS, resolveShellTimeoutMs, TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

type ToolCeilingTerminationReason = "ceiling" | "user-abort" | "error";

// Leave time for shell timeout cleanup and retryable error formatting before the executor ceiling fires.
const SHELL_CEILING_GRACE_MS = TOOL_TIMEOUT_POLICY.shellCeilingGraceMs;

// Only builtins may raise ceilings through host-derived loop budgets or shell timeoutSeconds; plugins and external tools cannot.
// Clamp both paths to MAX_TIMER_DELAY_MS so timer overflow cannot turn large budgets into 1ms aborts.
export function resolveEffectiveCeilingMs(
  tool: Pick<Tool, "name" | "source" | "category" | "resolveHostCeilingMs">,
  input: Record<string, unknown>,
): number {
  return Math.min(MAX_TIMER_DELAY_MS, resolveRequestedCeilingMs(tool, input));
}

// Only the clamping resolver may call this.
function resolveRequestedCeilingMs(
  tool: Pick<Tool, "name" | "source" | "category" | "resolveHostCeilingMs">,
  input: Record<string, unknown>,
): number {
  if (tool.source === "builtin" && tool.resolveHostCeilingMs) {
    return tool.resolveHostCeilingMs();
  }
  if (tool.source !== "builtin" || tool.category !== "shell") {
    return TOOL_TIMEOUT_POLICY.globalCeilingMs;
  }
  const requested = input.timeoutSeconds;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return TOOL_TIMEOUT_POLICY.globalCeilingMs;
  }
  return Math.max(
    TOOL_TIMEOUT_POLICY.globalCeilingMs + SHELL_CEILING_GRACE_MS,
    resolveShellTimeoutMs(requested) + SHELL_CEILING_GRACE_MS,
  );
}

type ToolTaskOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ToolCeilingTerminationReason; error: Error };

// After prompt interruption, settlement tracks actual completion so authority leases remain poisoned until the task stops.
export type ToolCeilingOutcome<T> = ToolTaskOutcome<T> & {
  readonly settlement?: Promise<ToolTaskOutcome<T>>;
};

// Always clear the timer and detach parent listeners after ceiling, parent abort, or task failure.
export async function runWithCeiling<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
  parentAbortSignal: AbortSignal | undefined,
  taskName: string,
): Promise<ToolCeilingOutcome<T>> {
  const ceilingController = new AbortController();
  let resolveInterruption: (outcome: ToolTaskOutcome<T>) => void = () => {};
  let interruptionSettled = false;
  const interruptionOutcome = new Promise<ToolTaskOutcome<T>>((resolve) => {
    resolveInterruption = (outcome) => {
      if (interruptionSettled) return;
      interruptionSettled = true;
      resolve(outcome);
    };
  });
  const parentAbortError = (): Error =>
    parentAbortSignal?.reason instanceof Error
      ? parentAbortSignal.reason
      : new Error(String(parentAbortSignal?.reason ?? "parent aborted"));
  let ceilingFired = false;
  const timer = setTimeout(() => {
    ceilingFired = true;
    const err = new Error(`tool execution exceeded global ceiling (${ceilingMs}ms): ${taskName}`);
    resolveInterruption({ ok: false, reason: "ceiling", error: err });
    ceilingController.abort(err);
  }, ceilingMs);

  // Already-aborted signals do not fire newly attached listeners; skip the task to avoid hanging.
  if (parentAbortSignal?.aborted) {
    clearTimeout(timer);
    return { ok: false, reason: "user-abort", error: parentAbortError() };
  }

  let parentAbortListener: (() => void) | undefined;
  if (parentAbortSignal) {
    parentAbortListener = () => {
      const err = parentAbortError();
      resolveInterruption({ ok: false, reason: "user-abort", error: err });
      ceilingController.abort(err);
    };
    parentAbortSignal.addEventListener("abort", parentAbortListener, { once: true });
  }

  const taskOutcome: Promise<ToolTaskOutcome<T>> = Promise.resolve()
    .then(() => task(ceilingController.signal))
    .then((value): ToolTaskOutcome<T> => ({ ok: true, value }))
    .catch((err): ToolTaskOutcome<T> => {
      if (ceilingFired) {
        return {
          ok: false,
          reason: "ceiling",
          error: new Error(
            `tool execution exceeded global ceiling (${ceilingMs}ms): ${taskName}`,
          ),
        };
      }
      if (parentAbortSignal?.aborted) {
        return {
          ok: false,
          reason: "user-abort",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
      return {
        ok: false,
        reason: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    });

  try {
    const winner = await Promise.race([
      taskOutcome.then((outcome) => ({ source: "task" as const, outcome })),
      interruptionOutcome.then((outcome) => ({
        source: "interruption" as const,
        outcome,
      })),
    ]);
    return winner.source === "task"
      ? winner.outcome
      : { ...winner.outcome, settlement: taskOutcome };
  } finally {
    interruptionSettled = true;
    clearTimeout(timer);
    if (parentAbortListener && parentAbortSignal) {
      parentAbortSignal.removeEventListener("abort", parentAbortListener);
    }
  }
}
