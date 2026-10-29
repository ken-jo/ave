import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { listApprovals, __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
} from "../../permissions/sandbox-capability.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const reviewResources = new PermissionTestResources();
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-invocation-authorization-"));
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
});
afterEach(async () => {
  await reviewResources.cleanup();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  await cleanupTmpDir(directory);
});

describe("host shell invocation authorization", () => {
  it.each(["remove allow", "add deny"])("requires normal authorization again after %s invalidates a decision", async (change) => {
    const manager = new PermissionManager(join(directory, "permissions.json"));
    // No sandbox here, so only an exact allow rule can authorize the host run.
    manager.setRules([{ pattern: "Bash(printf authorized)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const check = vi.spyOn(manager, "checkDetailed");
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute");
    const registry = new ToolRegistry();
    registry.register(tool);
    const cards: ApprovalRequest[] = [];
    let gate: ApprovalGate;
    const nativeWebContents = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== IPC_APPROVAL_REQUEST) return;
        cards.push(request);
        gate.resolveFromDesktopRenderer(request.id, {
          requestId: request.id, choice: "deny-once", nonce: request.nonce, hmac: request.hmac,
        }, nativeWebContents as never);
      },
    };
    gate = new ApprovalGate(nativeWebContents as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate);
    const call = {
      id: "host-authorization", name: "bash",
      input: { command: "printf authorized", executionMode: "host", justification: "Run on the host" },
    };
    const [stale] = await runWithToolExecutionCwd(directory, () => executor.executeAll([call], {
      sessionId: "host-authorization", permissionContext: userPermissionContext(),
      callbacks: {
        onToolStart: () => manager.setRules(change === "remove allow" ? [] : [
          { pattern: "Bash(printf authorized)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION },
          { pattern: "Bash(printf authorized)", action: "deny" },
        ]),
      },
    }));
    expect(check.mock.results[0]?.value).toMatchObject({ decision: "allow", layer: 3 });
    expect(check.mock.calls[0]?.[4]).toMatchObject({ hostShellExecutionPlan: { executionRequest: "host" } });
    expect(stale?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(cards).toHaveLength(0);

    const [fresh] = await runWithToolExecutionCwd(directory, () => executor.executeAll([call], {
      sessionId: "host-authorization", permissionContext: userPermissionContext(),
    }));
    expect(fresh?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    if (change === "remove allow") {
      expect(cards).toHaveLength(1);
      // A bash card is not narrowed to once/deny: the gate offers the five choices for its exact rule (owner 2026-10-25, five-choice shell card).
      expect(cards[0]?.allowedChoices).toBeUndefined();
      expect(cards[0]).toMatchObject({ requireExplicit: true });
    } else {
      expect(check.mock.results[1]?.value).toMatchObject({ decision: "deny", layer: 1 });
      expect(cards).toHaveLength(0);
    }
  });
});

describe("confined shell reviewer invocation", () => {
  it.each(['echo "$TARGET"', "rm -rf ./build"])("reviews each call without remembered authority: %s", async (command) => {
    vi.stubEnv("AVE_HOME", directory);
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "confined shell", confines: { filesystem: true, process: true, network: true } });
    const classify = vi.fn((): { level: "low" | "medium" | "high"; reason: string } => ({ level: "medium", reason: "reviewed command" }));
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("auto");
    setReviewerForTest(manager, { classifier: { classify },
      cache: reviewResources.makeVerdictCache(join(directory, "reviewer-cache.jsonl")),
      deferredQueue: new DeferredQueue(join(directory, "deferred.jsonl")) });
    manager.setInteractiveAutoApprove("medium");
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "reviewed", isError: false });
    const registry = new ToolRegistry(); registry.register(tool);
    const requestAndWait = vi.fn(async (_request: unknown) => ({ choice: "deny-once", approved: false }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never);
    const sessionId = "confined-shell-review";
    const input = { command };
    for (let index = 0; index < 2; index += 1) {
      const [result] = await runWithToolExecutionCwd(directory, () => executor.executeAll([
        { id: `shell-review-${index}`, name: "bash", input },
      ], { sessionId, permissionContext: userPermissionContext({ userIntent: "Review this workspace command" }) }));
      expect(result?.is_error).not.toBe(true);
    }
    expect(classify).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(await manager.listPersistedRules()).toEqual([]);
    expect(await listApprovals()).toEqual([]);
    classify.mockReturnValue({ level: "high", reason: "needs a person" });
    const [blocked] = await runWithToolExecutionCwd(directory, () => executor.executeAll([
      { id: "shell-review-high", name: "bash", input },
    ], { sessionId, permissionContext: userPermissionContext({ userIntent: "Review this workspace command" }) }));
    expect(blocked?.is_error).toBe(true);
    expect(classify).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(requestAndWait.mock.calls[0]?.[0]).toMatchObject({ durableApprovalRecordAllowed: false });
  });
});
