import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { JudgeContractError } from "../../permissions/judge/judge-contract.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../permissions/judge/judge-settings.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { LlmRiskClassifier, type LlmReviewerProvider, type RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import * as approvals from "../../permissions/user-approval-store.js";
import type { ApprovalMemory } from "../../shared/permissions-events.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { tryUserApprovalMemorySkip } from "../pipeline/approval-memory-skip.js";
import { ToolRegistry } from "../registry.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const SESSION_ID = "automatic-pause-session";
const resources = new PermissionTestResources();
const loggers: AuditLogger[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  approvals.__resetSessionStoreForTest();
  for (const logger of loggers.splice(0)) await logger.close();
  await resources.cleanup();
});

async function subject() {
  const root = resources.makeTmpDir("ave-executor-pause-");
  const audit = new AuditLogger(join(root, "audit"));
  loggers.push(audit);
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  let level: RiskVerdict["level"] = "low";
  const complete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level, reason: "reviewed action" }),
    tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const manager = new PermissionManager(join(root, "permissions.json"));
  const cache = resources.makeVerdictCache(join(root, "verdicts.jsonl"));
  manager.setMode("auto");
  manager.setInteractiveAutoApprove("medium");
  manager.setReviewer({
    classifier: new LlmRiskClassifier({ complete }, "review-model", "deny", {}, {
      maxAttempts: 1, baseDelayMs: 0, jitterPct: 0,
    }),
    cache,
    deferredQueue: new DeferredQueue(join(root, "deferred.jsonl")),
  });
  manager.setJudge({
    settings: {
      ...DEFAULT_JUDGE_SETTINGS, chain: [],
      categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
      breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
    },
    chain: [], breaker: manager.getJudgeBreaker(), audit,
  });
  const review = (input: Record<string, unknown>) => manager.dispatchReviewer("write_probe", {
    sessionId: SESSION_ID, source: "builtin", category: "write", pathFields: ["path"],
    finalInput: input, executionCwd: root, allowedDirectories: [root],
    sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
  }, undefined, { defer: "none" });
  const pause = async () => {
    level = "high";
    for (let index = 0; index < 3; index += 1) {
      await review({ path: join(root, `blocked-${index}.txt`) });
    }
    level = "low";
    expect(manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  };
  return { root, audit, manager, complete, pause, review };
}

function denyingGate() {
  const cards: ApprovalRequest[] = [];
  const gate = new ApprovalGate({
    isDestroyed: () => false,
    send(channel: string, request: ApprovalRequest) {
      if (channel !== "ave:approval:request") return;
      cards.push(request);
      queueMicrotask(() => gate.resolveFromDesktopRenderer(request.id, {
        requestId: request.id, choice: "deny-once",
      }));
    },
  } as never);
  return { gate, cards };
}

async function remember(root: string, input: Record<string, unknown>, memory?: ApprovalMemory) {
  await approvals.recordApproval("write_probe", approvals.canonicalStringify(input), "builtin", {
    scope: "session", sessionId: SESSION_ID, verdictAtApproval: memory ? "high" : "low", nlJustification: null,
    trustOrigin: "user-keyboard",
    workingDirectoryIdentity: approvals.captureApprovalWorkingDirectory(root).identity,
    ...(memory ? { approvalCacheKey: approvals.approvalCacheKeyIdentity("write-scope", memory) } : {}),
  });
}

function memoryReview(current: Awaited<ReturnType<typeof subject>>, input: Record<string, unknown>, memory: ApprovalMemory, manager = current.manager) {
  return tryUserApprovalMemorySkip(
    "write_probe", "builtin", "write", ["path"], input, current.root, [current.root], [],
    userPermissionContext({ approvalMemory: memory }), "write-scope", {},
    undefined, undefined, undefined, undefined, undefined, SESSION_ID, undefined,
    manager.dispatchReviewer.bind(manager),
  );
}

describe("executor automated approval pause", () => {
  it.each(["before lookup", "during lookup"] as const)("requires the user card despite exact approval memory when paused %s", async (timing) => {
    const current = await subject();
    const input = { path: join(current.root, "approved.txt") };
    await remember(current.root, input);
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { gate, cards } = denyingGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate);
    const options = {
      sessionId: SESSION_ID, executionCwd: current.root,
      permissionContext: userPermissionContext({ additionalDirectories: [current.root] }),
    };
    const [allowed] = await executor.executeAll([{ id: "before-pause", name: "write_probe", input }], options);
    expect(allowed.is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(0);

    if (timing === "before lookup") await current.pause();
    else {
      const lookup = approvals.lookupApproval;
      let paused = false;
      vi.spyOn(approvals, "lookupApproval").mockImplementation(async (...args) => {
        if (!paused && args[0] === "write_probe" && args[1] === approvals.canonicalStringify(input)) {
          paused = true;
          await current.pause();
        }
        return lookup(...args);
      });
    }
    const [blocked] = await executor.executeAll([{ id: "after-pause", name: "write_probe", input }], options);
    expect(blocked.is_error).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(1);
    expect(cards[0].reason).toMatch(/3/);
    expect(current.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("puts a paused read reviewer request on the real approval card instead of the read shortcut", async () => {
    const current = await subject();
    const execute = vi.fn(async () => ({ output: "read", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_probe", description: "Read probe", source: "builtin", category: "read",
      isReadOnly: () => true, jsonSchema: { type: "object", properties: {} }, execute,
    }));
    const { gate, cards } = denyingGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate);
    const options = {
      sessionId: SESSION_ID, executionCwd: current.root,
      approvalReasonPrefix: "[Sub-Agent: reader]",
      permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg", additionalDirectories: [current.root] }),
    };
    const [allowed] = await executor.executeAll([{ id: "read-before-pause", name: "read_probe", input: {} }], options);
    expect(allowed.is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(0);
    await current.pause();
    const [blocked] = await executor.executeAll([{ id: "read-after-pause", name: "read_probe", input: {} }], options);
    expect(blocked.is_error).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolCategory: "read", isReadOnly: false });
    expect(cards[0].reason).toMatch(/3/);
  });

  it("propagates a fresh memory review's missing-engine contract error", async () => {
    const current = await subject();
    const path = join(current.root, "scoped.txt");
    const memory: ApprovalMemory = { kind: "key", key: "write-scope", scope: { kind: "path", path } };
    await remember(current.root, { path, content: "approved" }, memory);
    const unwired = new PermissionManager(join(current.root, "unwired.json"));
    await expect(memoryReview(current, { path, content: "new" }, memory, unwired)).rejects.toBeInstanceOf(JudgeContractError);
  });

  it("propagates an authenticated audit failure from fresh memory review", async () => {
    const current = await subject();
    const path = join(current.root, "scoped.txt");
    const memory: ApprovalMemory = { kind: "key", key: "write-scope", scope: { kind: "path", path } };
    await remember(current.root, { path, content: "approved" }, memory);
    await current.review({ path: join(current.root, "seed.txt") });
    const auditDirectory = current.audit.getAuditDir();
    const name = readdirSync(auditDirectory).find((entry) => entry.endsWith(".permission-audit.jsonl"));
    if (!name) throw new Error("Permission audit file missing");
    const file = join(auditDirectory, name);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const tail = JSON.parse(lines[lines.length - 1]);
    tail.entryHash = "0".repeat(64);
    lines[lines.length - 1] = JSON.stringify(tail);
    writeFileSync(file, `${lines.join("\n")}\n`);
    await expect(memoryReview(current, { path, content: "new" }, memory)).rejects.toThrow(/permission audit active tail is not self-authenticated/);
  });
});
