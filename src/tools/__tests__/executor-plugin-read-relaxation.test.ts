import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { gateMutatingEffect, __resetEffectGrantsForTest } from "../../permissions/effect-enforcement.js";
import type { ScriptHookManager } from "../../hooks/script-hook-manager.js";

const resources = new PermissionTestResources();
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-plugin-pipeline-"));
  __resetEffectGrantsForTest();
  vi.stubEnv("AVE_HOME", join(directory, "state"));
});
afterEach(async () => { await resources.cleanup(); vi.unstubAllEnvs(); await cleanupTmpDir(directory); });

function fixture(options: {
  category?: Tool["category"];
  mode?: "strict" | "default" | "auto" | "allow";
  flag?: boolean;
  contained?: boolean;
  effect?: boolean;
  hooks?: ScriptHookManager;
} = {}) {
  const requests: ApprovalRequestInput[] = [];
  const gate = {
    requestAndWait: async (request: ApprovalRequestInput) => {
      requests.push(request);
      return { requestId: request.id, choice: "deny-once" };
    },
  } as unknown as ApprovalGate;
  const execute = vi.fn(async () => {
    if (options.effect) {
      await gateMutatingEffect({
        pluginId: "plugin-resource", methodPath: "storage.write", effect: "write", target: "a.txt",
        approvalGate: gate, permissionManager: manager, input: ["a.txt", "new content"],
        resolveStoragePath: (path) => join(directory, path),
      });
    }
    return { output: "resource-read", isError: false };
  });
  const tool = createDynamicTool({
    name: "plugin_resource", description: "A plugin resource operation", source: "plugin",
    pluginId: "plugin-resource", category: options.category ?? "read", pathFields: [],
    isReadOnly: () => options.category !== "write",
    jsonSchema: { type: "object", properties: { command: { type: "string" } } },
    execute,
  });
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode(options.mode ?? "strict");
  if (options.mode === "auto") setReviewerForTest(manager, {
    classifier: { classify: () => ({ level: "medium", reason: "reviewed plugin operation" }) },
    cache: resources.makeVerdictCache(join(directory, "verdict-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "recently-denied.json")),
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, options.hooks,
    undefined, () => options.flag ?? true, () => options.contained ?? true);
  const run = (headless = false) => executor.executeAll([
    { id: "resource", name: tool.name, input: options.category === "write" ? {} : { command: "git status" } },
  ], { sessionId: "plugin-pipeline", executionCwd: directory, permissionContext: userPermissionContext({ headless }) });
  return { execute, manager, requests, run };
}

describe("plugin permission pipeline", () => {
  it.each([
    { flag: false, contained: false }, { flag: false, contained: true },
    { flag: true, contained: false }, { flag: true, contained: true },
  ])("ordinary reads use the common policy with flag=$flag contained=$contained", async (options) => {
    const { execute, requests, run } = fixture(options);
    const [result] = await run();
    if (options.contained) {
      expect(result.is_error).not.toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(0);
    } else {
      expect(result.is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    }
  });

  it.each(["strict", "default"] as const)("contained plugin writes still ask in %s", async (mode) => {
    const { execute, requests, run } = fixture({ category: "write", mode, flag: true, contained: true });
    const [result] = await run();
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].category).toBe("tool");
  });

  it.each([true, false])("allow mode authorizes writes with containment=%s", async (contained) => {
    const { execute, requests, run } = fixture({ category: "write", mode: "allow", contained });
    const [result] = await run();
    expect(result.is_error).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("standing deny rules beat read classification and containment", async () => {
    const { execute, manager, requests, run } = fixture();
    manager.setRules([{ pattern: "plugin_resource", action: "deny" }]);
    const [result] = await run();
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("a persisted deny beats allow mode", async () => {
    const { execute, manager, requests, run } = fixture({ mode: "allow", category: "write" });
    await manager.addAlwaysDeniedPersist("plugin_resource");
    const [result] = await run();
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("contained headless reads remain ordinary reads", async () => {
    const { execute, requests, run } = fixture({ contained: true });
    const [result] = await run(true);
    expect(result.is_error).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it.each([false, true])("unconfined reads ask in the write-allowing mode with risk inspection=%s", async (flag) => {
    const { execute, requests, run } = fixture({ contained: false, mode: "default", flag });
    const [result] = await run();
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("unconfined reads use ordinary automatic review", async () => {
    const { manager, run } = fixture({ contained: false, mode: "auto" });
    const review = vi.spyOn(manager, "dispatchReviewer");
    await run();
    expect(review).toHaveBeenCalledOnce();
  });

  it("unconfined reads respect allow mode", async () => {
    const { execute, requests, run } = fixture({ contained: false, mode: "allow" });
    const [result] = await run();
    expect(result.is_error).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("unconfined headless reads deny when no human can approve", async () => {
    const { execute, requests, run } = fixture({ contained: false });
    const [result] = await run(true);
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("headless writes deny without a human card", async () => {
    const { execute, requests, run } = fixture({ category: "write", mode: "default" });
    const [result] = await run(true);
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("permission-request hooks can deny a write before its card", async () => {
    const runPermissionRequest = vi.fn(async () => ({ decision: "deny", reason: "operator denied", results: [] }));
    const hooks = {
      runPreToolUse: vi.fn(async () => ({ decision: "allow", reason: "", results: [] })),
      runPermissionRequest,
    } as unknown as ScriptHookManager;
    const { execute, requests, run } = fixture({ category: "write", hooks });
    const [result] = await run();
    expect(result.is_error).toBe(true);
    expect(runPermissionRequest).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("an observed write cannot inherit the tool's read classification", async () => {
    const { execute, requests, run } = fixture({ effect: true });
    const [result] = await run();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.is_error).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].category).toBe("agent-action");
  });
});
