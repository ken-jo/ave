import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { verifyChain } from "../../audit/hmac-chain.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { JudgeContractError } from "../../permissions/judge/judge-contract.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../permissions/judge/judge-settings.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { LlmRiskClassifier, type LlmReviewerProvider, type RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { LlmRationaleScopeReviewer } from "../../permissions/reviewer/rationale-scope-reviewer.js";
import * as approvals from "../../permissions/user-approval-store.js";
import type { ApprovalMemory } from "../../shared/permissions-events.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { createDynamicTool, type ToolExecutionContext } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { BashTool } from "../shell-tools.js";
import * as invocationExecution from "../invocation-execution.js";
import * as hostShellPermits from "../../permissions/host-shell-execution-permit.js";
import { WriteFileTool } from "../file-tools.js";
import { approvalIdentityFor } from "../pipeline/display-mask.js";
import { createTestRequestAnchor, rationaleResponseFor } from "../pipeline/__tests__/rationale-fixtures.js";
import { InMemoryHostAnchorRoundCasStore } from "../pipeline/rationale-control.js";
import { RationaleHostCoordinator } from "../pipeline/rationale-host-coordinator.js";
import { InMemoryHostInvocationStartCasStore, type InvocationAuditRecord } from "../pipeline/rationale-ticket-lifecycle.js";
import { InProcessRationaleTicketStore } from "../pipeline/rationale-ticket-store.js";
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
  vi.useRealTimers();
});

async function subject(sessionId = SESSION_ID) {
  const root = resources.makeTmpDir("ave-executor-pause-");
  const audit = new AuditLogger(join(root, "audit"));
  loggers.push(audit);
  const auditSecret = randomBytes(32).toString("hex");
  await audit.setupPermissionAuditChain(auditSecret);
  let level: RiskVerdict["level"] = "low";
  const complete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level, reason: "reviewed action" }),
    tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const manager = new PermissionManager(join(root, "permissions.json"));
  const cache = resources.makeVerdictCache(join(root, "verdicts.jsonl"));
  manager.setMode("auto");

  manager.setReviewer({
    classifier: new LlmRiskClassifier({ complete }, "review-model", "deny", {}, {
      maxAttempts: 1, baseDelayMs: 0, jitterPct: 0,
    }),
    cache,
    recentlyDenied: makeRecentlyDeniedStore(join(root, "recently-denied.json")),
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
    invocationId: randomUUID(),
    sessionId, source: "builtin", category: "write", pathFields: ["path"],
    finalInput: input, executionCwd: root, allowedDirectories: [root],
    sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
  });
  const pause = async () => {
    level = "high";
    for (let index = 0; index < 3; index += 1) {
      await review({ path: join(root, `blocked-${index}.txt`) });
    }
    level = "low";
    expect(manager.isAutomatedApprovalPaused(sessionId)).toBe(true);
  };
  return { root, audit, auditSecret, manager, complete, pause, review, sessionId, setLevel: (value: RiskVerdict["level"]) => { level = value; } };
}

function corruptAuditTail(audit: AuditLogger) {
  const file = audit.getPermissionAuditLogFile();
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const tail = JSON.parse(lines[lines.length - 1]);
  tail.entryHash = "0".repeat(64);
  lines[lines.length - 1] = JSON.stringify(tail);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

async function rationaleContinuation(surface: "native" | "unavailable" = "native") {
  const current = await subject("ef975fd1-380d-4acf-8e50-7f1535885ebc");
  current.setLevel("high");

  const execute = vi.fn(async () => "sealed write completed");
  const registry = new ToolRegistry();
  registry.register(makeWriteProbeTool(execute));
  const hooks = new ScriptHookManager();
  const { gate, cards, approve } = manualGate();
  const invocationAudits: InvocationAuditRecord[] = [];
  const scopeComplete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level: "medium", reason: "bounded action", scopeAlignment: "aligned", scopeReasons: ["sealed target matches the request"] }),
    tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const ticketStore = new InProcessRationaleTicketStore({ onAudit: () => {} });
  const coordinator = new RationaleHostCoordinator({
    requestAnchor: createTestRequestAnchor({ sessionId: current.sessionId }),
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    ticketStore,
    rationaleScopeReviewer: new LlmRationaleScopeReviewer({ complete: scopeComplete }, "review-model"),
    approvalGate: gate,
    getRationalePolicyEpoch: () => "policy-one",
    getRegistryGeneration: () => "registry-one",
    getSandboxGeneration: () => "sandbox-one",
    anchorRoundCas: new InMemoryHostAnchorRoundCasStore(),
    hostInvocationStartCas: new InMemoryHostInvocationStartCasStore(),
    onInvocationAudit: (record) => { invocationAudits.push(record); },
    onProjectionAudit: () => {},
  });
  const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, hooks, current.audit);
  const options = {
    sessionId: current.sessionId, executionCwd: current.root,
    permissionContext: userPermissionContext({
      trustOrigin: "llm-tool-arg", additionalDirectories: [current.root],
    }),
  };
  const initial = await executor.executeConversationBatch([
    { id: "sealed-coordinator-write", name: "write_probe", input: { path: join(current.root, "sealed.txt") } },
  ], { ...options, rationaleRuntime: coordinator });
  expect(initial.outcome).toBe("rationale-required");
  if (initial.outcome !== "rationale-required") throw new Error("Expected rationale control");
  const control = initial.control.control;
  const round = await coordinator.handleRationaleRoundResult({
    ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "explain-sealed-write", name: "permission_rationale", input: rationaleResponseFor(control, "Write the requested sealed target.") }] },
  });
  expect(round).toMatchObject({ autoApproved: true, reevaluation: { outcome: "fresh", scopeAlignment: "aligned" } });
  expect(scopeComplete).toHaveBeenCalledOnce();
  expect(cards).toHaveLength(0);
  const sealed = await coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: control.eligibilityContext });
  if (!sealed) throw new Error("Expected authentic coordinator resume");
  expect(ticketStore.isAuthenticConsumedAllowOnceReceipt(sealed.hostConsumedAllowOnceReceipt, Date.now())).toBe(true);
  const { reached, release } = heldPreToolUse(hooks);
  const resumeOptions = { ...options, rationaleResumeRuntime: coordinator, permissionContext: { ...options.permissionContext,
    ...(surface === "unavailable" ? { approvalSurface: "unavailable" as const } : {}),
  } };
  return { ...current, execute, hooks, reached, release, gate, cards, approve, invocationAudits, executor, sealed, resumeOptions };
}

function manualGate() {
  const cards: ApprovalRequest[] = [];
  const nativeWebContents = {
    isDestroyed: () => false,
    send(channel: string, request: ApprovalRequest) {
      if (channel === "ave:approval:request") cards.push(request);
    },
  };
  const gate = new ApprovalGate(nativeWebContents as never);
  const approve = (card: ApprovalRequest) => gate.resolveFromDesktopRenderer(card.id, {
    requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
  }, nativeWebContents as never);
  return { gate, cards, approve };
}

function heldHandlerFinalizers(toolUseId: string, count: number) {
  const waits = Array.from({ length: count }, () => {
    let enter!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    return { enter, release, reached, held };
  });
  const execute = invocationExecution.executeAuthorizedToolInvocation;
  let attempts = 0;
  let observed: invocationExecution.ExecutionStageContext | undefined;
  vi.spyOn(invocationExecution, "executeAuthorizedToolInvocation").mockImplementation(context => {
    if (context.toolUse.id !== toolUseId) return execute(context);
    observed = context;
    return execute({ ...context, finalizeExecutionRouteGrant: async () => {
      const wait = waits[attempts++];
      if (wait) { wait.enter(); await wait.held; }
      return context.finalizeExecutionRouteGrant?.();
    } });
  });
  return { waits, observed: () => observed };
}

function heldPreToolUse(hooks = new ScriptHookManager()) {
  const runPreToolUse = hooks.runPreToolUse.bind(hooks);
  let enter!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(hooks, "runPreToolUse").mockImplementationOnce(async (...args) => {
    enter();
    await held;
    return runPreToolUse(...args);
  });
  return { hooks, reached, release };
}

function denyingGate() {
  const cards: ApprovalRequest[] = [];
  const nativeWebContents = {
    isDestroyed: () => false,
    send(channel: string, request: ApprovalRequest) {
      if (channel !== "ave:approval:request") return;
      cards.push(request);
      queueMicrotask(() => gate.resolveFromDesktopRenderer(request.id, {
        requestId: request.id, choice: "deny-once", nonce: request.nonce, hmac: request.hmac,
      }, nativeWebContents as never));
    },
  };
  const gate = new ApprovalGate(nativeWebContents as never);
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
    randomUUID(),
    undefined, undefined, undefined, undefined, undefined, SESSION_ID, undefined,
    manager.dispatchReviewer.bind(manager),
  );
}

describe("executor automated approval pause", () => {
  it("cancels a pending late native card without entering the handler", async () => {
    const f = await subject();
    const controller = new AbortController();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, hooks, f.audit);
    const pending = executor.executeAll([{ id: "cancel-late-card", name: "write_probe", input: { path: join(f.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: f.root, abortSignal: controller.signal,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await reached;
    await f.pause();
    release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(gate.pendingCount).toBe(1);
    controller.abort(new Error("caller cancelled pending late card"));
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 });
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    expect(approve(cards[0])).toBeNull();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("settles caller cancellation while a late PermissionRequest hook is still held", async () => {
    const f = await subject();
    const controller = new AbortController();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const runPermissionRequest = hooks.runPermissionRequest.bind(hooks);
    let enterPermission!: () => void;
    let releasePermission!: () => void;
    const permissionReached = new Promise<void>((resolve) => { enterPermission = resolve; });
    const permissionHeld = new Promise<void>((resolve) => { releasePermission = resolve; });
    vi.spyOn(hooks, "runPermissionRequest").mockImplementationOnce(async (...args) => {
      enterPermission();
      await permissionHeld;
      return runPermissionRequest(...args);
    });
    const { gate, cards } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, hooks, f.audit);
    const pending = executor.executeAll([{ id: "cancel-held-permission-hook", name: "write_probe", input: { path: join(f.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: f.root, abortSignal: controller.signal,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await reached;
    await f.pause();
    release();
    await permissionReached;
    try {
      controller.abort(new Error("caller cancelled held permission hook"));
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 });
      expect((await pending)[0].is_error).toBe(true);
      expect(cards).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      releasePermission();
      await pending;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cards).toHaveLength(0);
    expect(gate.pendingCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    const rows = readFileSync(f.audit.getPermissionAuditLogFile(), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows.some((row) => row.decision === "ask" && row.toolUseId === "cancel-held-permission-hook")).toBe(false);
  });

  it.each(["caller abort", "execution ceiling"] as const)("propagates %s into the actual handler after late native approval", async (interruption) => {
    const f = await subject();
    const controller = new AbortController();
    let enterHandler!: () => void;
    const handlerReached = new Promise<void>((resolve) => { enterHandler = resolve; });
    let handlerSignal: AbortSignal | undefined;
    const execute = vi.fn(async (_input: unknown, context: ToolExecutionContext) => {
      handlerSignal = context.abortSignal;
      if (!handlerSignal) throw new Error("Handler cancellation signal is missing");
      const signal = handlerSignal;
      enterHandler();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "write_probe", description: "write probe", source: "builtin", category: "write", pathFields: ["path"],
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute,
    }));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, hooks, f.audit);
    const pending = executor.executeAll([{ id: "interrupt-late-approved-handler", name: "write_probe", input: { path: join(f.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: f.root, abortSignal: controller.signal,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await reached;
    await f.pause();
    release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    if (interruption === "execution ceiling") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    approve(cards[0]);
    await handlerReached;
    expect(handlerSignal?.aborted).toBe(false);
    if (interruption === "caller abort") controller.abort(new Error("caller cancelled late-approved handler"));
    else await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs);
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(handlerSignal?.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(1);
    expect(gate.pendingCount).toBe(0);
    expect(controller.signal.aborted).toBe(interruption === "caller abort");
  });

  it.each(["native", "unavailable"] as const)("refuses a sealed resume when sibling reviews pause before fresh permission with %s approval", async (surface) => {
    const f = await rationaleContinuation(surface);
    const pending = f.executor.executeSealedRationaleResume(f.sealed.resumeRequest, f.resumeOptions);
    await f.reached;
    expect(f.execute).not.toHaveBeenCalled();
    await f.pause();
    f.release();
    const result = await pending;
    expect(result.is_error).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.cards).toHaveLength(0);
    expect(f.manager.isAutomatedApprovalPaused(f.sessionId)).toBe(true);
    expect(f.invocationAudits.some((record) => record.state === "started" || record.state === "completed")).toBe(false);
    const replay = await f.executor.executeSealedRationaleResume(f.sealed.resumeRequest, f.resumeOptions);
    expect(replay.is_error).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["policy", "remembered", "reviewer", "rationale", "fresh native", "late native"] as const)("applies the common final audit gate to %s approval", async (source) => {
    if (source === "rationale") {
      const f = await rationaleContinuation();
      const order: string[] = [];
      const check = f.audit.assertPermissionAuditWritable.bind(f.audit);
      vi.spyOn(f.audit, "assertPermissionAuditWritable").mockImplementation(() => { order.push("audit"); check(); });
      f.execute.mockImplementation(async () => { order.push("handler"); return "sealed write completed"; });
      const pending = f.executor.executeSealedRationaleResume(f.sealed.resumeRequest, f.resumeOptions);
      await f.reached;
      order.push("pre-hook-finished");
      f.release();
      expect((await pending).is_error).toBeUndefined();
      expect(order.slice(-2)).toEqual(["audit", "handler"]);
      expect(order.indexOf("pre-hook-finished")).toBeLessThan(order.lastIndexOf("audit"));
      return;
    }
    const f = await subject();
    const order: string[] = [];
    const check = f.audit.assertPermissionAuditWritable.bind(f.audit);
    vi.spyOn(f.audit, "assertPermissionAuditWritable").mockImplementation(() => { order.push("audit"); check(); });
    const execute = vi.fn(async () => { order.push("handler"); return "wrote"; });
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const input = { path: join(f.root, "common-gate.txt") };
    if (source === "policy") f.manager.setMode("allow");
    if (source === "remembered") await remember(f.root, input);
    if (source === "fresh native") f.setLevel("high");
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, hooks, f.audit);
    const pending = executor.executeAll([{ id: "common-gate-write", name: "write_probe", input }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await reached;
    expect(f.complete).not.toHaveBeenCalled();
    if (source === "late native") await f.pause();
    order.push("pre-hook-finished");
    release();
    if (source === "late native" || source === "fresh native") {
      await vi.waitFor(() => expect(cards).toHaveLength(1));
      expect(execute).not.toHaveBeenCalled();
      order.push("late-card-approved");
      approve(cards[0]);
    }
    expect((await pending)[0].is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(order.slice(-2)).toEqual(["audit", "handler"]);
    expect(order.indexOf("pre-hook-finished")).toBeLessThan(order.lastIndexOf("audit"));
    if (source === "late native") expect(order.indexOf("late-card-approved")).toBeLessThan(order.lastIndexOf("audit"));
    expect(cards).toHaveLength(source === "fresh native" || source === "late native" ? 1 : 0);
  });

  it("refuses the handler when the authenticated audit tail changes while a late native card is pending", async () => {
    const f = await subject();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, hooks, f.audit);
    const pending = executor.executeAll([{ id: "tampered-pending-card", name: "write_probe", input: { path: join(f.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await reached;
    await f.pause();
    release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    corruptAuditTail(f.audit);
    const settled = pending.then((results) => ({ results, error: undefined }), (error: unknown) => ({ results: undefined, error }));
    approve(cards[0]);
    const outcome = await settled;
    expect(execute).not.toHaveBeenCalled();
    const failure = outcome.error instanceof Error ? outcome.error.message : outcome.results?.[0].content;
    expect(failure).toMatch(/permission audit active tail is not self-authenticated/);
    if (outcome.results) expect(outcome.results[0].is_error).toBe(true);
  });

  it.each(["approved", "expired"] as const)("keeps a late native card outside the execution ceiling until %s at the ordinary deadline", async (settlement) => {
    const f = await subject();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, hooks, f.audit);
    const pending = executor.executeAll([{ id: "long-wait-card", name: "write_probe", input: { path: join(f.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await reached;
    await f.pause();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs + 1);
    expect(settled).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(cards[0].createdAt + TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs - Date.now() - 1);
    expect(settled).toBe(false);
    if (settlement === "approved") approve(cards[0]);
    else await vi.advanceTimersByTimeAsync(1);
    const [result] = await pending;
    if (settlement === "approved") expect(result.content).toBe("wrote");
    expect(result.is_error).toBe(settlement === "approved" ? undefined : true);
    expect(execute).toHaveBeenCalledTimes(settlement === "approved" ? 1 : 0);
    expect(cards).toHaveLength(1);
  });

  it("requires native approval when sibling reviews pause before fresh permission evaluation", async () => {
    const current = await subject();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, hooks, current.audit);
    const pending = executor.executeAll([{ id: "held-automatic-write", name: "write_probe", input: { path: join(current.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: current.root,
      permissionContext: userPermissionContext({ additionalDirectories: [current.root] }),
    });
    await reached;
    expect(current.complete).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await current.pause();
    release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(execute).not.toHaveBeenCalled();
    expect(cards[0]).toMatchObject({ sessionId: SESSION_ID, toolName: "write_probe", isReadOnly: false });
    expect(cards[0].reason).toBe("Automated approval is paused for this turn; human approval is required.");
    const auditLines = readFileSync(current.audit.getPermissionAuditLogFile(), "utf8").trimEnd().split("\n");
    expect(verifyChain(current.auditSecret, auditLines)).toEqual({ ok: true });
    expect(auditLines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      decision: "ask", tool: "write_probe", toolUseId: "held-automatic-write", reason: cards[0].reason,
    }));
    approve(cards[0]);
    const [result] = await pending;
    expect(result.is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(hooks.runPreToolUse).toHaveBeenCalledOnce();
    expect(current.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("honors a PermissionRequest denial before showing a late pause card", async () => {
    const current = await subject();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const denyReason = "operator approval hook refused this action";
    const permissionHook = vi.spyOn(hooks, "runPermissionRequest").mockResolvedValueOnce({
      decision: "deny", reason: denyReason, results: [],
    });
    const postHook = vi.spyOn(hooks, "runPostToolUse");
    const lifecycle = vi.spyOn(hooks, "runLifecycleEvent");
    const { gate, cards } = manualGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, hooks, current.audit);
    const pending = executor.executeAll([{ id: "held-hook-refused-write", name: "write_probe", input: { path: join(current.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: current.root,
      permissionContext: userPermissionContext({ additionalDirectories: [current.root] }),
    });
    await reached;
    await current.pause();
    release();
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain(denyReason);
    expect(permissionHook).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(postHook).not.toHaveBeenCalled();
    expect(lifecycle.mock.calls.filter(([event]) => event === "PostToolUseFailure")).toHaveLength(0);
    expect(lifecycle.mock.calls.find(([event]) => event === "PermissionDenied")).toMatchObject([
      "PermissionDenied", SESSION_ID, "user-keyboard",
      { toolName: "write_probe", denyReason: { layer: 6, source: "tool-executor", reason: denyReason } },
    ]);
    const rows = readFileSync(current.audit.getPermissionAuditLogFile(), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows).toContainEqual(expect.objectContaining({
      decision: "deny", toolUseId: "held-hook-refused-write",
      denyReasons: expect.arrayContaining([expect.objectContaining({ reason: denyReason })]),
    }));
    expect(rows.some((row) => row.decision === "ask" && row.toolUseId === "held-hook-refused-write")).toBe(false);
  });

  it("does not show a late pause card or enter the handler when the required ask audit fails", async () => {
    const current = await subject();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const append = current.audit.appendPermissionAuditEntry.bind(current.audit);
    vi.spyOn(current.audit, "appendPermissionAuditEntry").mockImplementation(async (entry) => {
      if (entry.decision === "ask") throw new Error("late approval ask audit failed");
      return append(entry);
    });
    const { gate, cards } = manualGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, hooks, current.audit);
    const pending = executor.executeAll([{ id: "held-ask-audit-failed", name: "write_probe", input: { path: join(current.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: current.root,
      permissionContext: userPermissionContext({ additionalDirectories: [current.root] }),
    });
    await reached;
    await current.pause();
    release();
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("late approval ask audit failed");
    expect(cards).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(current.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it.each(["headless", "unavailable surface"] as const)("denies an automatic write paused during PreToolUse with %s", async (lane) => {
    const current = await subject();
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards } = manualGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, hooks, current.audit);
    const pending = executor.executeAll([{ id: "held-unattended-write", name: "write_probe", input: { path: join(current.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: current.root,
      permissionContext: userPermissionContext({
        additionalDirectories: [current.root], headless: lane === "headless",
        ...(lane === "unavailable surface" ? { approvalSurface: "unavailable" as const } : {}),
      }),
    });
    await reached;
    expect(current.complete).not.toHaveBeenCalled();
    await current.pause();
    release();
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("do not retry");
    expect(execute).not.toHaveBeenCalled();
    expect(cards).toHaveLength(0);
    expect(current.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("retains a genuine manual approval when sibling reviews pause while its card is pending", async () => {
    const current = await subject();
    current.setLevel("high");
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const { hooks, reached, release } = heldPreToolUse();
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, hooks, current.audit);
    const pending = executor.executeAll([{ id: "held-human-write", name: "write_probe", input: { path: join(current.root, "held.txt") } }], {
      sessionId: SESSION_ID, executionCwd: current.root,
      permissionContext: userPermissionContext({ additionalDirectories: [current.root] }),
    });
    await reached;
    release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    await current.pause();
    approve(cards[0]);
    const [result] = await pending;
    expect(result.is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(1);
    expect(current.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it.each(["approved", "policy changed"] as const)("rechecks a reviewed host permit paused during final routing and keeps its late card normal: %s", async outcome => {
    const f = await subject();
    const command = "printf late-card";
    f.manager.setMode("auto");
    const registry = new ToolRegistry();
    const shell = new BashTool();
    const execute = vi.spyOn(shell, "execute");
    registry.register(shell);
    const mint = vi.spyOn(hostShellPermits, "mintHostShellExecutionPermit");
    const held = heldHandlerFinalizers("late-host-permit", 2);
    const { gate, cards, approve } = manualGate();
    const request = vi.spyOn(gate, "requestAndWait");
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, undefined, f.audit);
    const pending = executor.executeAll([{ id: "late-host-permit", name: "bash", input: { command, executionMode: "host", justification: "Read fixture output" } }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await held.waits[0].reached;
    expect(held.observed()?.permissionResult).toMatchObject({ decision: "allow", reasonCode: "reviewer-allow" });
    expect(mint.mock.results[0]?.value).toBeDefined();
    expect(cards).toHaveLength(0);
    await f.pause();
    held.waits[0].release();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(execute).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      approvalCacheKey: expect.any(String),
      evaluationContext: expect.objectContaining({ executionCwd: f.root }),
      hostShellExecutionPermitBinding: expect.any(Object),
    });
    expect(request.mock.calls[0]?.[0].verifiedShellCommand).toBe(held.observed()?.verifiedShellCommand);
    expect(request.mock.calls[0]?.[0].forceExplicit).toBeUndefined();
    expect(request.mock.calls[0]?.[0].durableApprovalRecordAllowed).toBeUndefined();
    expect(cards[0].allowedChoices).toBeUndefined();
    expect(cards[0]).toMatchObject({ exactRecordAllowed: true,
      shellRule: expect.objectContaining({ sessionAllowed: true, persistentAllowed: true, exactRule: `Bash(${command})` }),
    });
    approve(cards[0]);
    await held.waits[1].reached;
    if (outcome === "policy changed") {
      await f.manager.addRulePersist({ pattern: `Bash(${command})`, action: "deny" }, { kind: "user" });
    }
    held.waits[1].release();
    const [result] = await pending;
    if (outcome === "approved") {
      expect(result.is_error, result.content).toBeUndefined();
      expect(result.content).toContain("late-card");
      expect(execute).toHaveBeenCalledOnce();
      expect(mint).toHaveBeenCalledTimes(2);
    } else {
      expect(result.is_error).toBe(true);
      expect(result.content).toBe("Permission policy changed before execution.");
      expect(execute).not.toHaveBeenCalled();
    }
    expect(cards).toHaveLength(1);
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("preserves a rule-issued host permit when the reviewer pauses before the handler", async () => {
    const f = await subject();
    const command = "printf rule-permit";
    await f.manager.addRulePersist({ pattern: `Bash(${command})`, action: "allow" }, { kind: "user" });
    const registry = new ToolRegistry();
    const shell = new BashTool();
    const execute = vi.spyOn(shell, "execute");
    registry.register(shell);
    const held = heldHandlerFinalizers("rule-host-permit", 1);
    const { gate, cards } = denyingGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, undefined, f.audit);
    const pending = executor.executeAll([{ id: "rule-host-permit", name: "bash", input: { command, executionMode: "host", justification: "Read fixture output" } }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await held.waits[0].reached;
    expect(held.observed()?.permissionResult).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    await f.pause();
    held.waits[0].release();
    const [result] = await pending;
    expect(result.is_error, result.content).toBeUndefined();
    expect(result.content).toContain("rule-permit");
    expect(execute).toHaveBeenCalledOnce();
    expect(cards).toHaveLength(0);
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("rejects a new deny rule after normal human consent while final routing is held", async () => {
    const f = await subject();
    f.setLevel("high");
    const execute = vi.fn(async () => "must-not-run");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const held = heldHandlerFinalizers("normal-human-policy-race", 1);
    const { gate, cards, approve } = manualGate();
    const executor = new ToolExecutor(registry, undefined, f.manager, undefined, gate, undefined, f.audit);
    const pending = executor.executeAll([{ id: "normal-human-policy-race", name: "write_probe", input: { path: join(f.root, "approved.txt") } }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    approve(cards[0]);
    await held.waits[0].reached;
    expect(held.observed()?.approvedPolicyEpoch).toBe(f.manager.getPolicyEpoch());
    f.manager.setRules([{ pattern: "write_probe", action: "deny" }]);
    held.waits[0].release();
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Permission policy changed before execution.");
    expect(execute).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
  });

  it("counts repeated classification of one invocation once after grant escalation", async () => {
    const previousHome = process.env.AVE_HOME;
    const isolatedHome = resources.makeTmpDir("ave-pause-state-");
    process.env.AVE_HOME = isolatedHome;
    try {
      const current = await subject();
      const tool = new WriteFileTool();
      const execute = vi.spyOn(tool, "execute");
      // An ordinary outside target exercises scope review without the protected home floor.
      const outsideRoot = resources.makeTmpDir("ave-pause-outside-");
      const input = { path: join(outsideRoot, "remembered.txt"), content: "approved" };
      const identity = await approvalIdentityFor(tool, input, current.root);
      expect(identity.approvalMemory).toMatchObject({ kind: "key", scope: { kind: "path", path: input.path } });
      await approvals.recordApproval(tool.name, approvals.canonicalStringify(input), "builtin", {
        scope: "session", sessionId: SESSION_ID, verdictAtApproval: "medium", riskCeilingAtApproval: "medium", nlJustification: null,
        trustOrigin: "user-keyboard", workingDirectoryIdentity: approvals.captureApprovalWorkingDirectory(current.root).identity,
        approvalCacheKey: approvals.approvalCacheKeyIdentity(identity.approvalCacheKey, identity.approvalMemory),
      });
      current.setLevel("high");
      const dispatch = vi.spyOn(current.manager, "dispatchReviewer");
      const registry = new ToolRegistry();
      registry.register(tool);
      const { gate, cards } = denyingGate();
      const executor = new ToolExecutor(registry, undefined, current.manager, undefined, gate, undefined, current.audit);
      const [result] = await executor.executeAll([{ id: "changed-remembered-write", name: tool.name, input: { ...input, content: "changed" } }], {
        sessionId: SESSION_ID, executionCwd: current.root,
        permissionContext: userPermissionContext({ additionalDirectories: [current.root] }),
      });
      expect(result.is_error).toBe(true);
      expect(current.complete).not.toHaveBeenCalled();
      expect(cards).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledOnce();
      const initialInput = dispatch.mock.calls[0][1];
      const firstAssessment = await dispatch.mock.results[0].value;
      expect(firstAssessment.outcome).toBe("host-determined");
      const repeated = await current.manager.dispatchReviewer(tool.name, initialInput, undefined, { purpose: "approval-scope" });
      expect(repeated.outcome).toBe("host-determined");
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch.mock.calls[1][3]).toMatchObject({ purpose: "approval-scope" });
      expect(dispatch.mock.calls[1][1].invocationId).toBe(initialInput.invocationId);
      expect(current.manager.getJudgeBreaker().snapshot(SESSION_ID)).toEqual({ consecutive: 1, total: 1, open: false });
    } finally {
      if (previousHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousHome;
    }
  });

  it.each(["before lookup", "during lookup"] as const)("preserves exact approval memory when the reviewer pauses %s", async (timing) => {
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
    const [remembered] = await executor.executeAll([{ id: "after-pause", name: "write_probe", input }], options);
    expect(remembered.is_error, remembered.content).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(cards).toHaveLength(0);
    expect(current.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("keeps other-principal reads once-only before and after the reviewer pauses", async () => {
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
    const [first] = await executor.executeAll([{ id: "read-before-pause", name: "read_probe", input: {} }], options);
    expect(first.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    await current.pause();
    const [blocked] = await executor.executeAll([{ id: "read-after-pause", name: "read_probe", input: {} }], options);
    expect(blocked.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ toolCategory: "read", isReadOnly: false });
    expect(cards[1]).toMatchObject({ allowedChoices: ["allow-once", "deny-once"], requireExplicit: true });
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
