import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { createRationaleHostRuntime } from "../../__tests__/support/rationale-host-runtime.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

import { HookRunner } from "../../hooks/hook-runner.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { createDynamicTool } from "../base.js";
import type { RationaleControlCandidate, RationaleHostRuntime } from "../pipeline/rationale-orchestrator.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import type { ToolCategory } from "../types.js";


function registerProbe(
  registry: ToolRegistry,
  input: {
    name: string;
    category: ToolCategory;
    execute: (input: unknown) => Promise<string>;
    parallelSafe?: boolean;
  },
): void {
  registry.register(createDynamicTool({
    name: input.name,
    description: input.name,
    source: "builtin",
    category: input.category,
    ...(input.category === "meta" ? { decisionOverride: "ask" as const } : {}),
    ...(input.parallelSafe === undefined ? {} : { parallelSafe: input.parallelSafe }),
    isReadOnly: () => input.category === "read",
    jsonSchema: {
      type: "object",
      properties: { payload: { type: "string" } },
    },
    execute: async (rawInput) => ({
      output: await input.execute(rawInput),
      isError: false,
    }),
  }));
}

function reviewerPermissionManager(directory: string, classify = vi.fn(() => ({
  level: "high" as const,
  reason: "requires rationale",
}))): PermissionManager {
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("auto");

  setReviewerForTest(manager, {
    classifier: { classify },
    cache: new VerdictCache(join(directory, "reviewer-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "recently-denied.jsonl")),
  });
  return manager;
}

function rationaleApprovalGate(): ApprovalGate {
  return {
    requestAndWait: vi.fn(async () => {
      throw new Error("The rationale control must suspend before the approval card");
    }),
  } as unknown as ApprovalGate;
}

const permissionContext = {
  trustOrigin: "llm-tool-arg" as const,
  userIntent: "Perform the requested operation.",
};

function rationaleOptions(runtime: RationaleHostRuntime) {
  return {
    executionCwd: process.cwd(),
    sessionId: "session-rationale",
    permissionContext,
    rationaleRuntime: runtime,
  };
}

describe("ToolExecutor rationale conversation batches", () => {
  it("keeps the existing completed-result path when no anchored runtime is present", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-rationale-read-batch-"));
    try {
    const registry = new ToolRegistry();
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    registerProbe(registry, {
      name: "parallel_read_first",
      category: "read",
      execute: first,
      parallelSafe: true,
    });
    registerProbe(registry, {
      name: "parallel_read_second",
      category: "read",
      execute: second,
      parallelSafe: true,
    });
    const executor = new ToolExecutor(registry, undefined, new PermissionManager(join(directory, "permissions.json")));

    const outcome = await executor.executeConversationBatch(
      [
        { id: "read-first", name: "parallel_read_first", input: { payload: "a" } },
        { id: "read-second", name: "parallel_read_second", input: { payload: "b" } },
      ],
      {
        executionCwd: process.cwd(),
        permissionContext,
      },
    );

    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unexpected rationale control");
    expect(outcome.results.map((result) => result.tool_use_id)).toEqual([
      "read-first",
      "read-second",
    ]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it("returns a separate control, preserves the completed prefix, and cancels later siblings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-rationale-executor-batch-"));
    try {
      const registry = new ToolRegistry();
      const before = vi.fn(async () => "before");
      const trigger = vi.fn(async () => "must-not-run");
      const after = vi.fn(async () => "must-not-run");
      registerProbe(registry, { name: "prefix_read", category: "read", execute: before });
      registerProbe(registry, { name: "arbitrary_write", category: "write", execute: trigger });
      registerProbe(registry, { name: "suffix_read", category: "read", execute: after });
      const hooks = new HookRunner();
      hooks.registerPreHook("rewrite-trigger", (context) =>
        context.toolName === "arbitrary_write"
          ? { action: "modify", updatedInput: { payload: "post-hook-raw" } }
          : { action: "allow" },
      );
      const manager = reviewerPermissionManager(directory);
      const executor = new ToolExecutor(registry, hooks, manager, undefined, rationaleApprovalGate());
      const { runtime, materialize } = createRationaleHostRuntime();
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();

      const outcome = await executor.executeConversationBatch(
        [
          { id: "prefix", name: "prefix_read", input: { payload: "before" } },
          { id: "trigger", name: "arbitrary_write", input: { payload: "provider" } },
          { id: "suffix", name: "suffix_read", input: { payload: "after" } },
        ],
        {
          ...rationaleOptions(runtime),
          callbacks: { onToolStart, onToolEnd },
        },
      );

      expect(outcome.outcome).toBe("rationale-required");
      if (outcome.outcome !== "rationale-required") {
        throw new Error("expected rationale control");
      }
      expect(outcome.completedResults.map((result) => result.tool_use_id)).toEqual(["prefix"]);
      expect(outcome.control.ordinaryToolResult).toBeNull();
      expect(outcome.control.executionAuthorized).toBe(false);
      expect(outcome.control.control.sealedAction.finalInput).toEqual({
        payload: "post-hook-raw",
      });
      expect(outcome.control.triggeringBatchDisposition).toMatchObject({
        originalToolUseIds: ["prefix", "trigger", "suffix"],
        triggeringToolUseId: "trigger",
        completedToolUseIds: ["prefix"],
        cancelledUnexecutedToolUseIds: ["suffix"],
      });
      expect(before).toHaveBeenCalledOnce();
      expect(trigger).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
      expect(onToolStart.mock.calls.map(([name]) => name)).toEqual(["prefix_read"]);
      expect(onToolEnd.mock.calls.map(([name]) => name)).toEqual(["prefix_read"]);
      expect(materialize).toHaveBeenCalledOnce();
      const candidate = materialize.mock.calls[0]?.[0] as RationaleControlCandidate;
      expect(candidate.finalInput).toEqual({ payload: "post-hook-raw" });
      expect(candidate.permission).toMatchObject({
        decision: "ask",
        reasonCode: "reviewer-human-required",
        reviewer: { route: "foreground-auto", outcome: "fresh" },
      });
      expect(candidate.sandboxExecutionPlan).toMatchObject({
        version: "rationale-sandbox-execution-plan/v1",
        executionCwd: process.cwd(),
      });
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it("intercepts both fresh and cached final reviewer asks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-rationale-executor-cache-"));
    try {
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => "must-not-run");
      registerProbe(registry, { name: "cache_write", category: "write", execute });
      const classify = vi.fn(() => ({
        level: "high" as const,
        reason: "requires rationale",
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        reviewerPermissionManager(directory, classify),
        undefined,
        rationaleApprovalGate(),
      );
      const firstRuntime = createRationaleHostRuntime();
      const first = await executor.executeConversationBatch(
        [{ id: "fresh-trigger", name: "cache_write", input: { payload: "same" } }],
        rationaleOptions(firstRuntime.runtime),
      );
      const secondRuntime = createRationaleHostRuntime();
      const second = await executor.executeConversationBatch(
        [{ id: "cache-trigger", name: "cache_write", input: { payload: "same" } }],
        rationaleOptions(secondRuntime.runtime),
      );

      expect(first.outcome).toBe("rationale-required");
      expect(second.outcome).toBe("rationale-required");
      if (first.outcome !== "rationale-required" || second.outcome !== "rationale-required") {
        throw new Error("expected rationale controls");
      }
      expect(first.control.control.reviewerOutcome).toBe("fresh");
      expect(second.control.control.reviewerOutcome).toBe("cache");
      expect(classify).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it.each([
    ["write", "write_control"],
    ["shell", "shell_control"],
    ["network", "network_control"],
    ["meta", "agent_spawn"],
    ["meta", "agent_interrupt"],
    ["meta", "unrelated_meta_control"],
  ] as const)(
    "uses the same rationale branch for %s tool %s",
    async (category, name) => {
      const directory = mkdtempSync(join(tmpdir(), "ave-rationale-executor-category-"));
      try {
        const registry = new ToolRegistry();
        const execute = vi.fn(async () => "must-not-run");
        registerProbe(registry, { name, category, execute });
        const executor = new ToolExecutor(
          registry,
          undefined,
          reviewerPermissionManager(directory),
          undefined,
          rationaleApprovalGate(),
        );
        const { runtime } = createRationaleHostRuntime();
        const onToolStart = vi.fn();
        const onToolEnd = vi.fn();

        const outcome = await executor.executeConversationBatch(
          [{
            id: "category-trigger",
            name,
            input: category === "shell" ? { command: "echo safe" } : { payload: "value" },
          }],
          {
            ...rationaleOptions(runtime),
            callbacks: { onToolStart, onToolEnd },
          },
        );

        expect(outcome.outcome).toBe("rationale-required");
        if (outcome.outcome !== "rationale-required") {
          throw new Error("expected rationale control");
        }
        expect(outcome.control.control.action).toMatchObject({
          toolName: name,
          category,
          requiredAuthority: "mid",
        });
        expect(execute).not.toHaveBeenCalled();
        expect(onToolStart).not.toHaveBeenCalled();
        expect(onToolEnd).not.toHaveBeenCalled();
      } finally {
        await cleanupTmpDir(directory);
      }
    },
  );
  it("finalizes a reviewer denial once when the prepared runtime cannot offer model choice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-rationale-ineligible-"));
    try {
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => "must not execute");
      registerProbe(registry, { name: "network_probe", category: "network", execute });
      const manager = reviewerPermissionManager(directory);
      const finalized = vi.spyOn(manager, "resolveReviewerChoice");
      const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "deny-once" as const }));
      const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as unknown as ApprovalGate);
      const { runtime, materialize } = createRationaleHostRuntime();
      const outcome = await executor.executeConversationBatch([
        { id: "ineligible-choice", name: "network_probe", input: {} },
      ], { ...rationaleOptions({ ...runtime, rationaleProvenance: { startedFromUserKeyboard: false, taint: "none" } }) });
      expect(outcome.outcome).toBe("completed");
      expect(materialize).not.toHaveBeenCalled();
      expect(requestAndWait).toHaveBeenCalledOnce();
      expect(finalized).toHaveBeenCalledExactlyOnceWith("session-rationale", expect.any(String), "deny");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it("runs the existing permission hook before a model-choice fallback card", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-rationale-card-hook-"));
    try {
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => "must not execute");
      registerProbe(registry, { name: "hooked_network_probe", category: "network", execute });
      const manager = reviewerPermissionManager(directory);
      const requestAndWait = vi.fn();
      const hooks = new ScriptHookManager();
      const permissionHook = vi.spyOn(hooks, "runPermissionRequest").mockResolvedValue({ decision: "deny", reason: "The permission hook blocks this request", results: [] });
      const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as unknown as ApprovalGate, hooks);
      const { runtime, materialize } = createRationaleHostRuntime();
      const outcome = await executor.executeConversationBatch([
        { id: "hooked-choice", name: "hooked_network_probe", input: {} },
      ], rationaleOptions(runtime));
      expect(outcome.outcome).toBe("rationale-required");
      const callback = materialize.mock.calls[0]?.[0].requestHumanApproval;
      if (!callback) throw new Error("Expected the original approval callback");
      await expect(callback({ requestId: "hooked-card" })).rejects.toMatchObject({ reason: expect.stringContaining("The permission hook blocks this request") });
      expect(permissionHook).toHaveBeenCalledOnce();
      expect(requestAndWait).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await cleanupTmpDir(directory);
    }
  });

});
