import { setReviewerForTest, wireJudgeForTest } from "../../__tests__/support/reviewer-judge.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { t } from "../../i18n/index.js";
import {
  PermissionManager,
  type ReviewerDispatchOutcome,
} from "../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { LlmRiskClassifier, ReviewerDispatchError, RuleBasedRiskClassifier } from "../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { authorizationRequiredStateOf } from "../../shared/authorization-required.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const temporaryDirectories: string[] = [];
const verdictCaches: VerdictCache[] = [];

function tempDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function verdictCache(path: string): VerdictCache {
  const cache = new VerdictCache(path);
  verdictCaches.push(cache);
  return cache;
}

function askingPermissionManager(): PermissionManager {
  const manager = new PermissionManager(join(tempDirectory("ave-auth-required-"), "permissions.json"));
  manager.setMode("strict");
  return manager;
}

function reviewingPermissionManager(outcome: "low" | "high" | "unavailable" | "error" | "timeout" | "malformed" | "no-reviewer"): PermissionManager {
  const root = tempDirectory("ave-auth-reviewed-");
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("auto");
  if (outcome === "no-reviewer") {
    wireJudgeForTest(manager);
  } else {
    const classifier = new LlmRiskClassifier({
      async complete() {
        if (outcome === "error") throw new Error("Review provider failed");
        if (outcome === "timeout") throw new ReviewerDispatchError("timeout", "Review provider timed out");
        return {
          text: outcome === "malformed" ? "invalid verdict" : JSON.stringify({ level: outcome === "high" ? "high" : "low", reason: "Completed review" }),
          tokensIn: 1, tokensOut: 1, costUsd: 0,
        };
      },
    }, "review-model", "deny", {}, { maxAttempts: 1, baseDelayMs: 0, jitterPct: 0 });
    const cache = verdictCache(join(root, "review-cache.jsonl"));
    setReviewerForTest(manager, {
      classifier, cache, recentlyDenied: makeRecentlyDeniedStore(join(root, "recently-denied.json")),
      ...(outcome === "unavailable" ? { unavailableReason: "Selected reviewer unavailable" } : {}),
    });
  }
  vi.spyOn(manager, "dispatchReviewer");
  return manager;
}

afterEach(async () => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  for (const cache of verdictCaches.splice(0)) await cache.flush();
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) await cleanupTmpDir(path);
});

describe("ToolExecutor authorization-required control", () => {
  it("terminates an ordinary ask when the host has no approval surface", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "write_probe",
      description: "Write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "ordinary-ask", name: "write_probe", input: {} }],
      {
        sessionId: "authorization-required",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toEqual({
      kind: "tool",
      toolName: "write_probe",
      source: "builtin",
      category: "write",
      reason: "approval-surface-unavailable",
    });
  });

  it("preserves the desktop approval flow when an interactive surface exists", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "interactive_write_probe",
      description: "Interactive write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn(async (request: { id: string }) => ({
      requestId: request.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "desktop-ask", name: "interactive_write_probe", input: {} }],
      {
        sessionId: "interactive-approval",
        permissionContext: userPermissionContext({ approvalSurface: "interactive" }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.content).toBe("executed");
    expect(result.authorizationRequired).toBeUndefined();
  });

  it("does not block an invocation the existing policy already allows", async () => {
    const execute = vi.fn(async () => ({ output: "read completed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_probe",
      description: "Read probe",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      isReadOnly: () => true,
      execute,
    }));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      new PermissionManager(join(tempDirectory("ave-auth-read-"), "permissions.json")),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "allowed-read", name: "read_probe", input: {} }],
      {
        sessionId: "allowed-without-surface",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).toBe("read completed");
    expect(result.authorizationRequired).toBeUndefined();
  });

  it("still executes an invocation the reviewer automatically allows", async () => {
    const execute = vi.fn(async () => ({ output: "reviewed write", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe",
      description: "Reviewed write probe",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute,
    }));
    const permissionManager = reviewingPermissionManager("low");
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "reviewed-allow", name: "reviewed_write_probe", input: { path: "authorization-result.txt" } }],
      {
        sessionId: "reviewed-without-surface",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(permissionManager.dispatchReviewer).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).toBe("reviewed write");
    expect(result.authorizationRequired).toBeUndefined();
  });

  it("keeps a completed routine reviewer verdict on the terminal denial lane", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_high_probe",
      description: "High-risk reviewed probe",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute,
    }));
    const permissionManager = reviewingPermissionManager("high");
    const executor = new ToolExecutor(registry, undefined, permissionManager);

    const [result] = await executor.executeAll(
      [{ id: "reviewed-high", name: "reviewed_high_probe", input: { path: "authorization-result.txt" } }],
      {
        sessionId: "reviewed-high-without-surface",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
    expect(permissionManager.dispatchReviewer).toHaveBeenCalledOnce();
  });

  it("returns authorization-required for a completed foreground verdict on a windowless host", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "foreground_high_probe",
      description: "Foreground high-risk probe",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute,
    }));
    const permissionManager = reviewingPermissionManager("high");
    const executor = new ToolExecutor(registry, undefined, permissionManager);

    const [result] = await executor.executeAll(
      [{ id: "foreground-high", name: "foreground_high_probe", input: { path: "authorization-result.txt" } }],
      {
        sessionId: "foreground-high-without-surface",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toMatchObject({
      kind: "tool",
      toolName: "foreground_high_probe",
      reason: "approval-surface-unavailable",
    });
  });

  it.each([
    "unavailable",
    "error",
    "timeout",
    "malformed",
  ] satisfies ReviewerDispatchOutcome[])(
    "returns normal human-fallback authorization for foreground reviewer %s on a windowless host",
    async (outcome) => {
      const execute = vi.fn(async () => ({ output: "executed", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "foreground_reviewer_failure_probe",
        description: "Foreground reviewer failure probe",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute,
      }));
      const permissionManager = reviewingPermissionManager(outcome);
      const executor = new ToolExecutor(registry, undefined, permissionManager);
      const permissionReviewEvents: Array<{ status: string; reason?: string }> = [];

      const [result] = await executor.executeAll(
        [{ id: `foreground-${outcome}`, name: "foreground_reviewer_failure_probe", input: { path: "authorization-result.txt" } }],
        {
          sessionId: `foreground-${outcome}-without-surface`,
          permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
          callbacks: {
            onPermissionReview: (event) => permissionReviewEvents.push(event),
          },
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result.is_error).toBe(true);
      expect(authorizationRequiredStateOf(result.authorizationRequired)).toMatchObject({
        kind: "tool", toolName: "foreground_reviewer_failure_probe", reason: "approval-surface-unavailable",
      });
      expect(result.content).toBe(NO_APPROVER_MESSAGE);
      expect(result.content).not.toContain("Authorization required");
      expect(permissionReviewEvents.map((event) => event.status)).toEqual([
        "reviewing",
        "needs_approval",
      ]);
      expect(permissionReviewEvents.at(-1)?.reason).toBe(NO_APPROVER_MESSAGE);
      await expect(vi.mocked(permissionManager.dispatchReviewer).mock.results[0]?.value).resolves.toMatchObject({ outcome });
    },
  );

  it.each(["no-reviewer", "timeout"] as const)(
    "keeps a headless reviewer %s as an ordinary policy failure",
    async (failure) => {
      const execute = vi.fn(async () => ({ output: "executed", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "reviewer_failure_probe",
        description: "Reviewer failure probe",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute,
      }));
      const permissionManager = reviewingPermissionManager(failure);
      const executor = new ToolExecutor(registry, undefined, permissionManager);

      const [result] = await executor.executeAll(
        [{ id: `reviewer-${failure}`, name: "reviewer_failure_probe", input: { path: "authorization-result.txt" } }],
        {
          sessionId: `reviewer-${failure}-without-surface`,
          permissionContext: userPermissionContext({
            headless: true,
            approvalSurface: "unavailable",
          }),
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result.is_error).toBe(true);
      expect(result.authorizationRequired).toBeUndefined();
      expect(result.content).not.toContain("Authorization required");
      expect(result.content).toBe(NO_APPROVER_MESSAGE);
      await expect(vi.mocked(permissionManager.dispatchReviewer).mock.results[0]?.value).resolves.toMatchObject({ outcome: failure === "timeout" ? "timeout" : "unavailable" });
    },
  );

  it("keeps an ordinary routine ask on the existing headless denial lane", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "routine_write_probe",
      description: "Routine write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "routine-ask", name: "routine_write_probe", input: {} }],
      {
        sessionId: "routine-authorization-required",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
  });

  it("returns the unified tool authorization control for an outside write without calling a hidden gate", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "out_of_scope_write",
      description: "Write outside the workspace",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute,
    }));
    const requestAndWait = vi.fn();
    const permissionDirectory = tempDirectory("ave-auth-dir-");
    const recentlyDenied = makeRecentlyDeniedStore(join(permissionDirectory, "deferred.jsonl"));
    const permissionManager = new PermissionManager(
      join(permissionDirectory, "permissions.json"),
    );
    permissionManager.setMode("strict");
    setReviewerForTest(permissionManager, {
      classifier: new RuleBasedRiskClassifier(),
      cache: verdictCache(join(permissionDirectory, "review-cache.jsonl")),
      recentlyDenied,
    });
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      { requestAndWait } as never,
    );
    const outside = join(tempDirectory("ave-auth-outside-"), "secret-command.txt");

    const [result] = await executor.executeAll(
      [{ id: "directory-ask", name: "out_of_scope_write", input: { path: outside } }],
      {
        sessionId: "directory-authorization",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).not.toContain(outside);
    const terminalState = authorizationRequiredStateOf(result.authorizationRequired);
    expect(terminalState).toMatchObject({
      kind: "tool",
      toolName: "out_of_scope_write",
      reason: "approval-surface-unavailable",
    });
    const pending = (await recentlyDenied.list());
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe("out_of_scope_write");
    expect(pending[0]).not.toHaveProperty("grant");
    expect(JSON.stringify(terminalState)).not.toContain(outside);
  });

  it("keeps a routine out-of-directory request in the terminal denial flow", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "routine_out_of_scope_write",
      description: "Routine write outside the workspace",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute,
    }));
    const requestAndWait = vi.fn();
    const permissionDirectory = tempDirectory("ave-routine-auth-dir-");
    const recentlyDenied = makeRecentlyDeniedStore(join(permissionDirectory, "deferred.jsonl"));
    const permissionManager = new PermissionManager(
      join(permissionDirectory, "permissions.json"),
    );
    permissionManager.setMode("strict");
    setReviewerForTest(permissionManager, {
      classifier: new RuleBasedRiskClassifier(),
      cache: verdictCache(join(permissionDirectory, "review-cache.jsonl")),
      recentlyDenied,
    });
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      { requestAndWait } as never,
    );
    const outside = join(tempDirectory("ave-routine-auth-outside-"), "output.txt");

    const [result] = await executor.executeAll(
      [{ id: "routine-directory-ask", name: "routine_out_of_scope_write", input: { path: outside } }],
      {
        sessionId: "routine-directory-authorization",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
    expect(result.content).toContain("do not retry");
    expect((await recentlyDenied.list())).toHaveLength(1);
  });

  it("returns ordinary authorization, carrying the fallback reason, for a requested-sandbox plain fallback", async () => {
    // An unavailable sandbox uses ordinary tool approval; the plan must still disclose uncontained execution.
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "none",
      confidence: "verified",
      platform: process.platform,
      reason: "fixture sandbox unavailable",
    });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    registry.register(bash);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{
        id: "sandbox-fallback",
        name: "bash",
        input: { command: "printf secret-command", timeoutSeconds: 1 },
      }],
      {
        sessionId: "sandbox-fallback-authorization",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).not.toContain("secret-command");
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toMatchObject({
      kind: "tool",
      toolName: "bash",
      reason: "approval-surface-unavailable",
      executionPlan: {
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: false,
      },
    });
  });

  it("returns host authorization for an explicit host request", async () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: process.platform,
      reason: "fixture full sandbox",
      confines: { filesystem: true, process: true, network: true },
    });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    registry.register(bash);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{
        id: "explicit-host",
        name: "bash",
        input: { command: "printf secret-command", executionMode: "host", justification: "Retry outside the sandbox", timeoutSeconds: 1 },
      }],
      {
        sessionId: "explicit-host-authorization",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).not.toContain("secret-command");
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toMatchObject({
      kind: "host-execution",
      toolName: "bash",
      reason: "host-execution-authorization-required",
      executionPlan: {
        executionRequest: "host",
        fallbackReason: "none",
        requiresExplicitUserApproval: true,
      },
    });
  });

  it("keeps a routine requested-sandbox fallback on the existing headless denial lane", async () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "none",
      confidence: "verified",
      platform: process.platform,
      reason: "fixture sandbox unavailable",
    });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    registry.register(bash);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{
        id: "routine-sandbox-fallback",
        name: "bash",
        input: { command: "printf routine-command", timeoutSeconds: 1 },
      }],
      {
        sessionId: "routine-sandbox-fallback",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
  });

  it("rejects a structural control lookalike that was not issued by the host", () => {
    const forged = {
      type: "authorization_required",
      state: {
        kind: "tool",
        toolName: "plugin_tool",
        source: "plugin",
        category: "write",
        reason: "approval-surface-unavailable",
      },
    };

    expect(authorizationRequiredStateOf(forged)).toBeUndefined();
  });

  it("keeps caller cancellation terminal and rejects foreign or late signed-card responses", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "cancelled_write_probe", description: "Cancellable write", source: "builtin", category: "write",
      jsonSchema: { type: "object", properties: {} }, execute,
    }));
    const surface = makeMockWebContents();
    const foreignSurface = makeMockWebContents();
    const shown = deferred<ApprovalRequest>();
    surface.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel === IPC_APPROVAL_REQUEST) shown.resolve(request);
    });
    const gate = new ApprovalGate(surface as never);
    const caller = new AbortController();
    const executor = new ToolExecutor(registry, undefined, askingPermissionManager(), undefined, gate);
    const running = executor.executeAll([{ id: "cancelled-write", name: "cancelled_write_probe", input: {} }], {
      sessionId: "cancelled-authorization", abortSignal: caller.signal,
      permissionContext: userPermissionContext({ approvalSurface: "interactive" }),
    });
    try {
      const card = await shown.promise;
      const response = { requestId: card.id, choice: "allow-once" as const, nonce: card.nonce, hmac: card.hmac };
      expect(gate.resolveFromDesktopRenderer(card.id, response, foreignSurface as never)).toBeNull();
      expect(gate.pendingCount).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      caller.abort(new Error("owner stopped"));
      const [result] = await running;
      expect(result.is_error).toBe(true);
      expect(result.content).toBe(t("be_executor.toolExecutionCancelled"));
      expect(result.authorizationRequired).toBeUndefined();
      expect(gate.pendingCount).toBe(0);
      expect(gate.resolveFromDesktopRenderer(card.id, response, surface as never)).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      caller.abort();
      gate.disposeAll();
      await running;
    }
  });
});
