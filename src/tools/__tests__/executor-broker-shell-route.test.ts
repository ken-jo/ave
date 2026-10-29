import { reviewerJudgeOutcomeForTest } from "../../__tests__/support/reviewer-judge.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";

const localSpawn = vi.hoisted(() => vi.fn(() => {
  throw new Error("local spawn forbidden in broker route test");
}));
const hostPrepare = vi.hoisted(() => vi.fn(() => {
  throw new Error("host shell preparation forbidden in broker route test");
}));
const hostPathInspection = vi.hoisted(() => vi.fn(() => {
  throw new Error("host shell path inspection forbidden in broker route test");
}));
const hostToolPathInspection = vi.hoisted(() => vi.fn(() => {
  throw new Error("tool-local host path inspection forbidden in broker route test");
}));
const hostToolCwdValidation = vi.hoisted(() => vi.fn(() => {
  throw new Error("tool-local host cwd validation forbidden in broker route test");
}));
const broker = vi.hoisted(() => ({
  active: true,
  capability: Object.freeze({
    version: "brokered-workload-capability/v1",
    workload: Object.freeze({
      id: "1".repeat(64),
      generation: "executor-broker-1",
      boundaryFingerprint: "2".repeat(64),
      imageDigest: `sha256:${"3".repeat(64)}`,
      cwd: "/app",
      home: "/home/ave",
      platform: "linux",
    }),
    expiresAt: "2099-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze(["shell.run"]),
  }),
  acquire: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: localSpawn };
});

vi.mock("../prepared-shell-invocation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prepared-shell-invocation.js")>();
  return { ...actual, prepareShellInvocation: hostPrepare };
});

vi.mock("../pipeline/path-extraction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/path-extraction.js")>();
  return { ...actual, shellPathPolicyViolation: hostPathInspection };
});

vi.mock("../shell-path-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell-path-policy.js")>();
  return {
    ...actual,
    findShellPathPolicyViolation: hostToolPathInspection,
    validateShellWorkingDirectory: hostToolCwdValidation,
  };
});

vi.mock("../../workload/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workload/runtime.js")>();
  return {
    ...actual,
    isWorkloadBrokerActive: () => broker.active,
    acquireBrokeredWorkloadCapability: broker.acquire,
    resolveBrokeredWorkloadPath: (_capability: unknown, input: string) => posix.resolve(broker.capability.workload.cwd, input),
    isIssuedActiveBrokeredWorkloadCapability: (value: unknown) =>
      broker.active && value === broker.capability,
    executeBrokeredWorkloadRequest: broker.execute,
  };
});

let root: string;

beforeEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  setShellSandboxRequestedAtBoot(false);
  broker.active = true;
  broker.acquire.mockReset();
  broker.acquire.mockResolvedValue(broker.capability);
  broker.execute.mockReset();
  localSpawn.mockClear();
  hostPrepare.mockClear();
  hostPathInspection.mockClear();
  hostToolPathInspection.mockClear();
  hostToolCwdValidation.mockClear();
  root = mkdtempSync(join(tmpdir(), "ave-executor-broker-shell-"));
});

afterEach(async () => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  await cleanupTmpDir(root);
});

describe("executor broker shell route", () => {
  it.each([
    { cwd: "/git", expectedCwd: "/git" },
    { cwd: "nested", expectedCwd: "/app/nested" },
    { cwd: undefined, expectedCwd: "/app" },
  ])("authorizes and audits guest cwd $cwd without host preparation, path inspection, or spawn", async ({ cwd, expectedCwd }) => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 5 });
    const appendPermissionAuditEntry = vi.fn();
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: () => true,
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );
    broker.execute.mockResolvedValueOnce({
      output: "broker-executed",
      isError: false,
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: "4".repeat(64),
    });

    const [result] = await executor.executeAll(
      [{
        id: "tu-broker-guest-shell",
        name: "bash",
        input: {
          command: "printf broker-only > /logs/result",
          ...(cwd === undefined ? {} : { cwd }),
          timeoutSeconds: 30,
        },
      }],
      {
        sessionId: "sess-broker-guest-shell",
        executionCwd: root,
        permissionContext: {
          trustOrigin: "llm-tool-arg",
          approvalSurface: "unavailable",
        },
      },
    );

    expect(result).toMatchObject({
      content: "broker-executed",
      executionPlan: { mode: "plain" },
    });
    expect(result?.is_error).toBeUndefined();
    expect(broker.acquire.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(broker.execute).toHaveBeenCalledWith(
      broker.capability,
      "shell.run",
      {
        command: "printf broker-only > /logs/result",
        cwd: expectedCwd,
        timeoutMs: 30_000,
      },
      expect.objectContaining({ operation: "shell.run", toolName: "bash" }),
      expect.any(AbortSignal),
    );
    expect(hostPrepare).not.toHaveBeenCalled();
    expect(hostPathInspection).not.toHaveBeenCalled();
    expect(hostToolPathInspection).not.toHaveBeenCalled();
    expect(hostToolCwdValidation).not.toHaveBeenCalled();
    expect(localSpawn).not.toHaveBeenCalled();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: "tu-broker-guest-shell",
      executionRoute: expect.objectContaining({
        decision: "selected",
        route: "disposable-container",
        disposableCapability: expect.objectContaining({ kind: "workload-broker" }),
      }),
    }));
  });

  it("grades a routine-lane guest request against the disposable substrate, not the host shell plan", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.checkDetailed = () => ({
      decision: "ask",
      reason: "routine lane",
      layer: 5,
      reviewer: { route: "headless" },
    });
    const checkDetailed = vi.spyOn(permissionManager, "checkDetailed");
    permissionManager.hasReviewer = () => true;
    const dispatched: unknown[] = [];
    permissionManager.dispatchReviewer = vi.fn(async (_toolName, input) => {
      dispatched.push(input);
      return {
        verdict: { level: "low", reason: "shell confined to disposable guest" },
        judge: reviewerJudgeOutcomeForTest("allow", "shell confined to disposable guest"),
        outcome: "fresh",
        cacheReason: "miss-not-found",
      };
    }) as typeof permissionManager.dispatchReviewer;
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: () => true,
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry: vi.fn(),
    };
    const executor = new ToolExecutor(
      registry, undefined, permissionManager, undefined, undefined, undefined, auditLogger as never,
    );
    broker.execute.mockResolvedValueOnce({
      output: "x86_64",
      isError: false,
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: "5".repeat(64),
    });

    const [result] = await executor.executeAll(
      [{ id: "tu-broker-guest-probe", name: "bash", input: { command: "uname -m", timeoutSeconds: 30 } }],
      {
        sessionId: "sess-broker-guest-probe",
        executionCwd: root,
        permissionContext: { trustOrigin: "llm-tool-arg", approvalSurface: "unavailable", headless: true },
      },
    );

    expect(result).toMatchObject({ content: "x86_64" });
    expect(dispatched).toHaveLength(1);
    expect(result?.is_error).toBeUndefined();
    expect(dispatched[0]).toMatchObject({
      disposableSubstrate: { authority: "workload-broker", id: "1".repeat(64) },
    });
    expect(checkDetailed.mock.calls[0]?.[4]).toMatchObject({
      hostShellExecutionPlan: { sandboxed: false },
      shellExecution: { runsSandboxed: true },
    });
    expect(localSpawn).not.toHaveBeenCalled();
  });
});

describe("broker shell floor consent", () => {
  it("asks on every destructive guest call without consulting or storing review cache", async () => {
    const { setReviewerForTest } = await import("../../__tests__/support/reviewer-judge.js");
    const { VerdictCache } = await import("../../permissions/reviewer/verdict-cache.js");
    const { DeferredQueue } = await import("../../permissions/reviewer/deferred-queue.js");
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("auto"); manager.setInteractiveAutoApprove("medium");
    const classify = vi.fn(() => ({ level: "medium" as const, reason: "reviewed guest" }));
    const cache = new VerdictCache(join(root, "guest-cache.jsonl"));
    const lookup = vi.spyOn(cache, "lookup");
    const store = vi.spyOn(cache, "store");
    setReviewerForTest(manager, { classifier: { classify }, cache, deferredQueue: new DeferredQueue(join(root, "guest-queue.jsonl")) });
    const check = vi.spyOn(manager, "checkDetailed");
    const registry = new ToolRegistry(); registry.register(new BashTool());
    const requestAndWait = vi.fn(async (_request: unknown) => ({ choice: "deny-once", approved: false }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never);
    try {
      for (let index = 0; index < 2; index += 1) {
        const [result] = await executor.executeAll([
          { id: `guest-floor-${index}`, name: "bash", input: { command: "rm -rf ./build" } },
        ], { sessionId: "guest-floor", executionCwd: root,
          permissionContext: { trustOrigin: "llm-tool-arg", userIntent: "Review this guest command" } });
        expect(result?.is_error).toBe(true);
      }
      expect(check.mock.calls[0]?.[4]).toMatchObject({ hostShellExecutionPlan: { mode: "plain" },
        disposableSubstrate: { authority: "workload-broker" } });
      expect(requestAndWait).toHaveBeenCalledTimes(2);
      expect(classify).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(broker.execute).not.toHaveBeenCalled();
    } finally { await cache.flush(); }
  });
});
