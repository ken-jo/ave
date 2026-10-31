import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureToolApprovalWait, resolveEffectiveCeilingMs, runWithCeiling, withToolApprovalWait, type ToolApprovalWait } from "../executor-ceiling.js";
import { deferred } from "../../__tests__/support/deferred.js";
import {
  MAX_TIMER_DELAY_MS,
  TOOL_TIMEOUT_POLICY,
  resolveSubAgentCeilingMs,
} from "../../shared/tool-timeout-policy.js";

describe("resolveEffectiveCeilingMs — per-invocation ceiling", () => {
  const bash = { name: "bash", source: "builtin", category: "shell" } as const;

  it("follows a builtin shell tool's own timeoutSeconds when it exceeds the global ceiling", () => {
    // Escalated retries must reach the tool's retryable timeout before the executor ceiling.
    const ceiling = resolveEffectiveCeilingMs(bash, { command: "bun run build", timeoutSeconds: 600 });
    expect(ceiling).toBeGreaterThan(600_000);
  });

  it("leaves head-room above a default-budget shell call so its own timeout fires first", () => {
    const ceiling = resolveEffectiveCeilingMs(bash, {
      command: "echo hi",
      timeoutSeconds: TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000,
    });
    expect(ceiling).toBe(
      TOOL_TIMEOUT_POLICY.shellDefaultMs +
        TOOL_TIMEOUT_POLICY.workloadBrokerPreEffectHandshakeMs +
        TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs +
        TOOL_TIMEOUT_POLICY.workloadBrokerOuterGuardMs,
    );
  });

  it("uses a builtin's own host-derived ceiling when it declares one", () => {
    expect(
      resolveEffectiveCeilingMs(
        {
          name: "agent_spawn",
          source: "builtin",
          category: "meta",
          resolveHostCeilingMs: () => 1_800_000,
        },
        {},
      ),
    ).toBe(1_800_000);
  });

  it("clamps a scaled sub-agent ceiling to the largest delay setTimeout can hold", () => {
    // Timer delays above signed 32-bit range become 1ms; clamp oversized round budgets.
    const hugeBudget = {
      name: "agent_spawn",
      source: "builtin",
      category: "meta",
      resolveHostCeilingMs: () => resolveSubAgentCeilingMs(300_000),
    } as const;
    expect(resolveSubAgentCeilingMs(300_000)).toBeGreaterThan(MAX_TIMER_DELAY_MS);
    expect(resolveEffectiveCeilingMs(hugeBudget, {})).toBe(MAX_TIMER_DELAY_MS);
  });

  it("clamps an oversized shell timeoutSeconds to the same bound", () => {
    // Uncapped timeoutSeconds can overflow the same timer limit.
    expect(
      resolveEffectiveCeilingMs(bash, { command: "sleep 1", timeoutSeconds: 3_000_000 }),
    ).toBe(MAX_TIMER_DELAY_MS);
  });

  it("arms a real timer at the clamped ceiling instead of firing after 1ms", async () => {
    // An unclamped overflow would let the ceiling win this race immediately.
    vi.useRealTimers();
    const ceiling = resolveEffectiveCeilingMs(bash, {
      command: "sleep 1",
      timeoutSeconds: 3_000_000,
    });
    const outcome = await runWithCeiling(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "finished";
      },
      ceiling,
      undefined,
      "long-budget-tool",
    );
    expect(outcome).toEqual({ ok: true, value: "finished" });
  });

  it("a non-builtin tool cannot raise its own ceiling by declaring timeoutSeconds", () => {
    expect(
      resolveEffectiveCeilingMs(
        { name: "plugin_thing", source: "plugin", category: "shell" },
        { timeoutSeconds: 100_000 },
      ),
    ).toBe(TOOL_TIMEOUT_POLICY.globalCeilingMs);
  });

  it("a non-builtin tool cannot raise its own ceiling by declaring resolveHostCeilingMs", () => {
    // Escalation authority is host-owned; forged wire fields must remain inert.
    expect(
      resolveEffectiveCeilingMs(
        {
          name: "plugin_thing",
          source: "plugin",
          category: "write",
          resolveHostCeilingMs: () => 86_400_000,
        },
        {},
      ),
    ).toBe(TOOL_TIMEOUT_POLICY.globalCeilingMs);
  });
});

describe("runWithCeiling — executor global ceiling helper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns ok=true with the task's value when the task completes before the ceiling", async () => {
    const task = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        expect(signal.aborted).toBe(false);
        setTimeout(() => resolve("done"), 50);
      });
    const promise = runWithCeiling(task, 1_000, undefined, "fast-tool");
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, value: "done" });
  });

  it("returns ok=false reason='ceiling' and aborts the task's signal when the ceiling fires", async () => {
    let observedSignal: AbortSignal | undefined;
    const task = (signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const promise = runWithCeiling(task, 500, undefined, "hung-tool");
    await vi.advanceTimersByTimeAsync(600);
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("ceiling");
      expect(outcome.error.message).toMatch(/exceeded global ceiling \(500ms\): hung-tool/);
    }
    expect(observedSignal?.aborted).toBe(true);
  });

  it("returns ok=false reason='user-abort' when the parent abortSignal aborts first", async () => {
    const parentController = new AbortController();
    const task = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const promise = runWithCeiling(task, 10_000, parentController.signal, "any-tool");
    setTimeout(() => parentController.abort(new Error("user cancelled")), 100);
    await vi.advanceTimersByTimeAsync(150);
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("user-abort");
    }
  });

  it("returns user-abort promptly even when the task ignores the signal", async () => {
    const parentController = new AbortController();
    const task = vi.fn(() => new Promise<never>(() => {}));
    const promise = runWithCeiling(task, 10_000, parentController.signal, "stuck-tool");

    setTimeout(() => parentController.abort(new Error("user cancelled")), 100);
    await vi.advanceTimersByTimeAsync(150);

    const outcome = await promise;
    expect(task).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("user-abort");
      expect(outcome.error.message).toBe("user cancelled");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns ceiling promptly even when the task ignores the signal", async () => {
    const task = vi.fn(() => new Promise<never>(() => {}));
    const promise = runWithCeiling(task, 500, undefined, "stuck-tool");

    await vi.advanceTimersByTimeAsync(600);

    const outcome = await promise;
    expect(task).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("ceiling");
      expect(outcome.error.message).toMatch(/exceeded global ceiling \(500ms\): stuck-tool/);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exposes the actual late settlement when an interrupted task ignores the signal", async () => {
    let releaseTask!: (value: string) => void;
    const task = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseTask = resolve;
        }),
    );
    const promise = runWithCeiling(task, 500, undefined, "late-write");

    await vi.advanceTimersByTimeAsync(600);
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    expect(outcome.settlement).toBeDefined();

    let settled = false;
    void outcome.settlement?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseTask("late-success");
    await expect(outcome.settlement).resolves.toEqual({
      ok: true,
      value: "late-success",
    });
  });

  it("returns ok=false reason='error' for ordinary task failures (not timeout, not user abort)", async () => {
    const task = () => Promise.reject(new Error("internal tool error"));
    const outcome = await runWithCeiling(task, 5_000, undefined, "broken-tool");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("error");
      expect(outcome.error.message).toBe("internal tool error");
    }
  });

  it("takes the fast path (does not invoke the task) when the parent signal is already aborted at entry", async () => {
    const parentController = new AbortController();
    parentController.abort(new Error("already cancelled"));
    const task = vi.fn();
    const outcome = await runWithCeiling(task, 10_000, parentController.signal, "any-tool");
    expect(task).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("user-abort");
      expect(outcome.error.message).toBe("already cancelled");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the ceiling timer on successful completion (no orphan timer)", async () => {
    const task = () => Promise.resolve("instant");
    await runWithCeiling(task, 60_000, undefined, "instant-tool");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the parent abort listener after completion (no leak on long-lived signals)", async () => {
    const parentController = new AbortController();
    const beforeListenerCount = listenerCount(parentController.signal);
    const task = () => Promise.resolve("instant");
    await runWithCeiling(task, 60_000, parentController.signal, "instant-tool");
    expect(listenerCount(parentController.signal)).toBe(beforeListenerCount);
  });
});

function listenerCount(target: AbortSignal): number {
  void target;
  return 0;
}

describe("execution time during human approval", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("resumes only the unspent execution budget after a long approval wait", async () => {
    const answer = deferred<void>();
    let waiting = false;
    let completed = false;
    const running = runWithCeiling(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await withToolApprovalWait(() => { waiting = true; return answer.promise; });
      return new Promise<never>(() => {});
    }, 1_000, undefined, "approval-bound-tool");
    void running.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs * 2);
    expect(completed).toBe(false);
    answer.resolve();
    await vi.advanceTimersByTimeAsync(799);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ ok: false, reason: "ceiling" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures the invocation budget for a callback outside its asynchronous context", async () => {
    const answer = deferred<void>();
    const work = deferred<string>();
    let captured: ToolApprovalWait | undefined;
    const running = runWithCeiling(async () => {
      captured = captureToolApprovalWait();
      return work.promise;
    }, 1_000, undefined, "transport-bound-tool");
    await vi.advanceTimersByTimeAsync(250);
    if (!captured) throw new Error("Missing captured execution budget");
    const approval = captured(() => answer.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    answer.resolve();
    await approval;
    work.resolve("completed once");
    expect(await running).toEqual({ ok: true, value: "completed once" });
    await captured(() => Promise.resolve());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for every overlapping human card before resuming execution time", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let completed = false;
    const running = runWithCeiling(async () => {
      await Promise.all([
        withToolApprovalWait(() => first.promise),
        withToolApprovalWait(() => second.promise),
      ]);
      return new Promise<never>(() => {});
    }, 100, undefined, "parallel-cards");
    void running.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    first.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).toBe(false);
    second.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ ok: false, reason: "ceiling" });
  });

  it("keeps an unrelated invocation's execution ceiling running", async () => {
    const answer = deferred<void>();
    const approved = runWithCeiling(() => withToolApprovalWait(() => answer.promise), 100, undefined, "waiting-tool");
    const unrelated = runWithCeiling(() => new Promise<never>(() => {}), 100, undefined, "running-tool");
    await vi.advanceTimersByTimeAsync(100);
    expect(await unrelated).toMatchObject({ ok: false, reason: "ceiling" });
    answer.resolve();
    expect(await approved).toMatchObject({ ok: true });
  });

  it("pauses enclosing execution budgets for a nested tool's human card", async () => {
    const answer = deferred<void>();
    const running = runWithCeiling((parentSignal) => runWithCeiling(
      () => withToolApprovalWait(() => answer.promise),
      50, parentSignal, "nested-tool",
    ), 100, undefined, "enclosing-tool");
    await vi.advanceTimersByTimeAsync(10_000);
    answer.resolve();
    expect(await running).toEqual({ ok: true, value: { ok: true, value: undefined } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores execution time after a rejected wait that the handler catches", async () => {
    const answer = deferred<void>();
    const running = runWithCeiling(async () => {
      try {
        await withToolApprovalWait(() => answer.promise.then(() => { throw new Error("Approval unavailable"); }));
      } catch {
        // The tool handles the approval failure; its execution budget still applies.
      }
      return new Promise<never>(() => {});
    }, 100, undefined, "rejected-card");
    await vi.advanceTimersByTimeAsync(1_000);
    answer.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ ok: false, reason: "ceiling" });
  });

  it("propagates parent cancellation during a human wait without rearming a settled budget", async () => {
    const parent = new AbortController();
    const answer = deferred<void>();
    let childSignal: AbortSignal | undefined;
    const running = runWithCeiling((signal) => {
      childSignal = signal;
      return withToolApprovalWait(() => answer.promise);
    }, 100, parent.signal, "cancelled-card");
    await vi.advanceTimersByTimeAsync(10_000);
    parent.abort(new Error("owner stopped"));
    expect(await running).toMatchObject({ ok: false, reason: "user-abort" });
    expect(childSignal?.aborted).toBe(true);
    answer.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
