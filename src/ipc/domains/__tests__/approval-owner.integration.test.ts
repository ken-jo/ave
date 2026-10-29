import { allowOnceCardAnswer } from "../../../__tests__/support/approval-card-answer.js";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../../../permissions/approval-gate.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../../permissions/judge/judge-settings.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { LlmRiskClassifier, type LlmReviewerProvider, type RiskVerdict } from "../../../permissions/reviewer/risk-classifier.js";
import { LlmApprovalSentenceSelector } from "../../../permissions/reviewer/approval-sentence-selector.js";
import * as approvals from "../../../permissions/user-approval-store.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { BashTool } from "../../../tools/shell-tools.js";
import { makeWriteProbeTool } from "../../../tools/__tests__/approval-memory-test-fixtures.js";
import { userPermissionContext } from "../../../tools/__tests__/tool-context-fixture.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }),
  },
  session: { defaultSession: { resolveProxy: vi.fn(async () => "DIRECT") } },
}));

const resources = new PermissionTestResources();
const cleanup: Array<() => Promise<void>> = [];
const SESSION_ID = "approval-owner-session";

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  approvals.__resetSessionStoreForTest();
  vi.unstubAllEnvs();
  handlers.clear();
  await resources.cleanup();
});

function appWindow(id: number) {
  const contents = {
    id, mainFrame: { url: "file:///application/index.html" },
    isDestroyed: vi.fn(() => false), send: vi.fn(),
  };
  return { isDestroyed: vi.fn(() => false), webContents: contents };
}

type AppWindow = ReturnType<typeof appWindow>;

function frameEvent(window: AppWindow, senderFrame = window.webContents.mainFrame): IpcMainInvokeEvent {
  return { sender: window.webContents, senderFrame } as unknown as IpcMainInvokeEvent;
}

function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing registered handler: ${channel}`);
  return handler(event, ...args);
}


async function subject(mode: "auto" | "default" = "auto") {
  const root = resources.makeTmpDir("ave-approval-owner-");
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const auditLog = vi.spyOn(audit, "log");
  const windowA = appWindow(101);
  const windowB = appWindow(202);
  let owner: AppWindow | undefined = windowA;
  const gate = new ApprovalGate(
    (sessionId) => sessionId === SESSION_ID && owner ? owner.webContents as unknown as WebContents : null,
    undefined, undefined, audit,
  );
  let level: RiskVerdict["level"] = "low";
  const complete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level, reason: "reviewed action" }), tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode(mode);

  manager.setReviewer({
    classifier: new LlmRiskClassifier({ complete }, "review-model", "deny", {}, { maxAttempts: 1, baseDelayMs: 0, jitterPct: 0 }),
    cache: resources.makeVerdictCache(join(root, "verdicts.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(root, "deferred.jsonl")),
  });
  manager.setJudge({
    settings: { ...DEFAULT_JUDGE_SETTINGS, chain: [], categories: { ...DEFAULT_JUDGE_SETTINGS.categories }, breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker } },
    chain: [], breaker: manager.getJudgeBreaker(), audit,
  });
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => "wrote");
  registry.register(makeWriteProbeTool(execute));
  const hooks = new ScriptHookManager();
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, hooks, audit);
  const pending: Promise<unknown>[] = [];
  const selectComplete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ optionId: "o1", confidence: "high", reason: "requested one action" }), tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const selector = new LlmApprovalSentenceSelector({ complete: selectComplete }, "review-model");
  cleanup.push(async () => {
    gate.disposeAll();
    await Promise.allSettled(pending);
    await audit.close();
  });
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers({
    conversationLoop: { permissionManager: manager }, approvalGate: gate, auditLogger: audit,
    toolRegistry: registry, getMainWindow: () => windowA, getAppWindows: () => [windowA, windowB],
    getApprovalSentenceSelector: () => selector,
  } as never);
  const pause = async () => {
    level = "high";
    for (let index = 0; index < 3; index += 1) {
      await manager.dispatchReviewer("write_probe", {
        invocationId: randomUUID(), sessionId: SESSION_ID, source: "builtin", category: "write", pathFields: ["path"],
        finalInput: { path: join(root, `blocked-${index}.txt`) }, executionCwd: root, allowedDirectories: [root],
        sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
      }, undefined, { lane: "foreground-auto" });
    }
    level = "low";
    expect(manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  };
  const start = (headless = false) => {
    const run = executor.executeAll([{ id: randomUUID(), name: "write_probe", input: { path: join(root, "requested.txt") } }], {
      sessionId: SESSION_ID, executionCwd: root,
      permissionContext: userPermissionContext({ additionalDirectories: [root], headless }),
    });
    pending.push(run);
    return run;
  };
  const cards = (window: AppWindow): ApprovalRequest[] => window.webContents.send.mock.calls
    .filter(([channel]) => channel === "ave:approval:request").map(([, card]) => card as ApprovalRequest);
  const waitForCard = async () => {
    await vi.waitFor(() => expect(cards(windowA)).toHaveLength(1));
    return cards(windowA)[0];
  };
  const holdNextPreToolUse = () => {
    const original = hooks.runPreToolUse.bind(hooks);
    let enter!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(hooks, "runPreToolUse").mockImplementationOnce(async (...args) => {
      enter();
      await held;
      return original(...args);
    });
    return { reached, release };
  };
  const queueCard = (overrides: Partial<ApprovalRequestInput> = {}) => {
    const request: ApprovalRequestInput = {
      id: randomUUID(), sessionId: SESSION_ID, category: "tool", kind: "tool", toolName: "write_probe", toolCategory: "write",
      source: "builtin", trustOrigin: "user-keyboard", args: { path: join(root, "remembered.txt") }, reason: "manual review", createdAt: Date.now(),
      reviewerVerdict: { level: "low", reason: "bounded action" },
      evaluationContext: buildPermissionEvaluationContext({
        policyMode: "default", headless: false, source: "builtin", category: "write", trustOrigin: "user-keyboard",
        executionCwd: root, allowedDirectories: [root], pathFields: ["path"], targetFilePaths: [], sensitivePathsAdjacent: [],
      }),
      ...overrides,
    };
    const result = gate.requestAndWait(request);
    pending.push(result);
    return { request, result };
  };
  return { root, auditLog, windowA, windowB, gate, manager, registry, executor, execute, complete, selectComplete, pause, start, cards, waitForCard, holdNextPreToolUse, queueCard, setOwner: (next: AppWindow | undefined) => { owner = next; } };
}

describe("live native approval ownership", () => {
  it.each(["session", "project"] as const)("accepts only the exact policy delta for a %s card rule", async (scope) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request, result } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    const card = await f.waitForCard();
    expect(card).not.toHaveProperty("ruleSaveTransition");
    const before = f.manager.getPolicyEpoch();
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: request.id, args: JSON.stringify(request.args), decision: "allow", scope: scope === "session" ? "session" : "persistent", verdictAtApproval: "low",
      rule: { action: "allow", scope, pattern: "Bash(printf *)" }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    })).toMatchObject({ ok: true });
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    const answer = await result;
    expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(true);
    expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(false);
  });

  it("burns a policy receipt on a mismatched consumption attempt", async () => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request, result } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    const card = await f.waitForCard();
    const before = f.manager.getPolicyEpoch();
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: request.id, args: JSON.stringify(request.args), decision: "allow", scope: "persistent", verdictAtApproval: "low",
      rule: { action: "allow", scope: "always" }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    })).toMatchObject({ ok: true });
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    const answer = await result;
    expect(f.gate.allowsPolicyTransition(answer, "forged-epoch", f.manager.getPolicyEpoch())).toBe(false);
    expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(false);
  });

  it.each(["parallel saves", "answer while saving", "invalid signature"] as const)("never grants a transition for %s", async (scenario) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request, result } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    const card = await f.waitForCard();
    const before = f.manager.getPolicyEpoch();
    const save = () => invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: request.id, args: JSON.stringify(request.args), decision: "allow", scope: "persistent", verdictAtApproval: "low",
      rule: { action: "allow", scope: "always" }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    });
    if (scenario === "invalid signature") {
      expect(await save()).toMatchObject({ ok: true });
      invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), { ...allowOnceCardAnswer(card), hmac: "invalid" });
      const answer = await result;
      expect(answer.choice).toBe("deny-once");
      expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(false);
      return;
    }
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const add = f.manager.addRulePersist.bind(f.manager);
    vi.spyOn(f.manager, "addRulePersist").mockImplementationOnce(async (...args) => { reached(); await held; await add(...args); });
    const saving = save();
    try {
      await entered;
      if (scenario === "parallel saves") {
        expect(await save()).toMatchObject({ ok: true });
        release();
        expect(await saving).toMatchObject({ ok: true });
        invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
      } else {
        invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
        release();
        expect(await saving).toMatchObject({ ok: true });
      }
      const answer = await result;
      expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(false);
    } finally {
      release();
      await saving;
    }
  });

  it.each(["one save", "sequential saves", "before", "during", "between", "after", "failed save", "deny save"] as const)("binds policy transition proof to its exact card: %s", async (scenario) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request, result } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    const card = await f.waitForCard();
    const before = f.manager.getPolicyEpoch();
    const save = (pattern = "Bash(printf *)", action: "allow" | "deny" = "allow") => invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: request.id, args: JSON.stringify(request.args), decision: action, scope: "persistent", verdictAtApproval: "low",
      rule: { action, scope: "always", pattern }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    });
    if (scenario === "before") f.manager.setRules([]);
    if (scenario === "during") {
      const add = f.manager.addRulePersist.bind(f.manager);
      vi.spyOn(f.manager, "addRulePersist").mockImplementation(async (...args) => { await add(...args); f.manager.setRules([]); });
    }
    if (scenario === "deny save") expect(await save("Bash(printf *)", "deny")).toMatchObject({ ok: true });
    else if (scenario === "failed save") expect(await save("Bash(unrelated *)")).toMatchObject({ ok: false });
    else expect(await save()).toMatchObject({ ok: true });
    if (scenario === "between" || scenario === "after") f.manager.setRules([]);
    if (scenario === "between" || scenario === "sequential saves") expect(await save("Bash(printf ready)")).toMatchObject({ ok: true });
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    const answer = await result;
    expect(f.gate.allowsPolicyTransition({ ...answer }, before, f.manager.getPolicyEpoch())).toBe(false);
    const allowed = scenario === "one save" || scenario === "sequential saves";
    expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(allowed);
    expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["own save", "unrelated before", "unrelated during", "unrelated after"] as const)("checks the exact host shell action after a prefix save: %s", async (scenario) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    f.registry.register(bash);
    const running = f.executor.executeAll([{
      id: "prefix-host-action", name: "bash",
      input: { command: "printf prefix-proof", executionMode: "host", justification: "Print one local value", timeoutSeconds: 1 },
    }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    cleanup.push(async () => { f.gate.disposeAll(); await running; });
    const card = await f.waitForCard();
    expect(execute).not.toHaveBeenCalled();
    expect(card.shellRule?.persistentAllowed).toBe(true);
    const epochBefore = f.manager.getPolicyEpoch();
    if (scenario === "unrelated before") f.manager.setRules([]);
    if (scenario === "unrelated during") {
      const add = f.manager.addRulePersist.bind(f.manager);
      vi.spyOn(f.manager, "addRulePersist").mockImplementation(async (...args) => { await add(...args); f.manager.setRules([]); });
    }
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: card.id, args: JSON.stringify(card.args), decision: "allow", scope: "persistent",
      verdictAtApproval: f.gate.getRequestSnapshot(card.id)?.verdictAtApproval,
      rule: { action: "allow", scope: "always", pattern: "Bash(printf *)" },
      intent: { inputOrigin: "user-keyboard", userActivation: true },
    })).toMatchObject({ ok: true });
    expect(f.manager.getPolicyEpoch()).not.toBe(epochBefore);
    if (scenario === "unrelated after") f.manager.setRules([]);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    const [result] = await running;
    if (scenario === "own save") {
      expect(result.is_error, JSON.stringify(result)).toBeUndefined();
      expect(result.content).toBe("prefix-proof");
      expect(execute).toHaveBeenCalledOnce();
    } else {
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Permission policy changed");
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("lets only the current owner record a durable exact approval from a pending card", async () => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request } = f.queueCard();
    const card = await f.waitForCard();
    expect(f.gate.getRequestSnapshot(request.id)).toMatchObject({ durableApprovalRecordAllowed: true, persistentAllowAllowed: true, verdictAtApproval: "low" });
    const payload = { requestId: request.id, args: JSON.stringify(request.args), scope: "persistent", verdictAtApproval: "low", intent: { inputOrigin: "user-keyboard", userActivation: true }, nlJustification: "owner one approved" };
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(await approvals.listApprovals()).toEqual([]);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), payload)).toEqual({ ok: true });
    expect(await approvals.listApprovals()).toEqual([expect.objectContaining({ decision: "allow", scope: "persistent", toolName: "write_probe", nlJustification: "owner one approved" })]);
    const stored = readFileSync(approvals.userApprovalFilePath(), "utf8");
    const generation = approvals.getUserApprovalGeneration();
    f.setOwner(f.windowB);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), { ...payload, nlJustification: "stale owner" })).toEqual(UNAUTHORIZED_FRAME);
    expect(approvals.getUserApprovalGeneration()).toBe(generation);
    expect(readFileSync(approvals.userApprovalFilePath(), "utf8")).toBe(stored);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), { ...payload, nlJustification: "owner two approved" })).toEqual({ ok: true });
    expect(await approvals.listApprovals()).toEqual([expect.objectContaining({ decision: "allow", nlJustification: "owner two approved" })]);
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), allowOnceCardAnswer(card));
  });

  it("lets only the current owner persist the host-derived exact shell rule", async () => {
    const f = await subject("default");
    const addRule = vi.spyOn(f.manager, "addRulePersist");
    const { request } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    const card = await f.waitForCard();
    const payload = { requestId: request.id, args: JSON.stringify(request.args), scope: "persistent", verdictAtApproval: "low", rule: { action: "allow", scope: "always" }, intent: { inputOrigin: "user-keyboard", userActivation: true } };
    expect(card.shellRule).toMatchObject({ exactRule: "Bash(printf ready)", persistentAllowed: true });
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(addRule).not.toHaveBeenCalled();
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), payload)).toEqual({ ok: true });
    expect(addRule).toHaveBeenCalledOnce();
    expect(await f.manager.listPersistedRules()).toContainEqual(expect.objectContaining({ pattern: "Bash(printf ready)", action: "allow" }));
    f.setOwner(f.windowB);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(addRule).toHaveBeenCalledOnce();
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), payload)).toEqual({ ok: true });
    expect(addRule).toHaveBeenCalledTimes(2);
    expect(f.gate.pendingCount).toBe(1);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), allowOnceCardAnswer(card));
  });

  it.each(["git status --short", "make build"])("does not let a current owner persist unproven %s", async (command) => {
    const f = await subject("default");
    const addRule = vi.spyOn(f.manager, "addRulePersist");
    const { request } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command } });
    const card = await f.waitForCard();
    const payload = { requestId: request.id, args: JSON.stringify(request.args), scope: "persistent", verdictAtApproval: "low", rule: { action: "allow", scope: "always" }, intent: { inputOrigin: "user-keyboard", userActivation: true } };
    expect(card.shellRule).toMatchObject({ exactRule: null, persistentAllowed: false });
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), payload)).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    f.setOwner(f.windowB);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), payload)).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    expect(addRule).not.toHaveBeenCalled();
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), allowOnceCardAnswer(card));
  });

  it("discloses proposal context only to the current owner and never settles from a proposal", async () => {
    const f = await subject();
    const { request } = f.queueCard({
      kind: "out-of-allowed-dir", toolName: "read_file", toolCategory: "read",
      outOfAllowedDir: { candidatePath: join(f.root, "private-target.txt"), suggestedParent: f.root, currentAllowed: [], adjacencyWarnings: [] },
    });
    const card = await f.waitForCard();
    const payload = { requestId: request.id, input: "/allow allow just this target once", intent: { inputOrigin: "user-keyboard", userActivation: true } };
    expect(await invoke(PERMISSIONS.approvalSentenceSelect, frameEvent(f.windowB), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(f.selectComplete).not.toHaveBeenCalled();
    expect(await invoke(PERMISSIONS.approvalSentenceSelect, frameEvent(f.windowA), payload)).toEqual({ ok: true, requestId: request.id, choice: "allow-once" });
    expect(f.selectComplete).toHaveBeenCalledOnce();
    const prompt = JSON.parse(f.selectComplete.mock.calls[0][0].userPrompt);
    expect(prompt.request).toMatchObject({ toolName: "read_file", candidatePath: request.outOfAllowedDir?.candidatePath });
    f.setOwner(f.windowB);
    expect(await invoke(PERMISSIONS.approvalSentenceSelect, frameEvent(f.windowA), payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(f.selectComplete).toHaveBeenCalledOnce();
    expect(await invoke(PERMISSIONS.approvalSentenceSelect, frameEvent(f.windowB), payload)).toEqual({ ok: true, requestId: request.id, choice: "allow-once" });
    expect(f.selectComplete).toHaveBeenCalledTimes(2);
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), allowOnceCardAnswer(card));
  });

  it.each(["subframe", "unregistered renderer"] as const)("rejects %s grant writes and proposal disclosure before host authority is consulted", async (source) => {
    const f = await subject();
    vi.stubEnv("AVE_HOME", f.root);
    const { request } = f.queueCard({
      kind: "out-of-allowed-dir", toolName: "read_file", toolCategory: "read",
      outOfAllowedDir: { candidatePath: join(f.root, "private-target.txt"), suggestedParent: f.root, currentAllowed: [], adjacencyWarnings: [] },
    });
    const card = await f.waitForCard();
    const event = source === "subframe" ? frameEvent(f.windowA, { url: f.windowA.webContents.mainFrame.url }) : frameEvent(appWindow(303));
    const snapshot = vi.spyOn(f.gate, "getRequestSnapshot");
    const state = vi.spyOn(f.gate, "getApprovalSentenceState");
    const addRule = vi.spyOn(f.manager, "addRulePersist");
    const record = { requestId: request.id, args: JSON.stringify(request.args), scope: "persistent", verdictAtApproval: "low", intent: { inputOrigin: "user-keyboard", userActivation: true } };
    expect(await invoke(PERMISSIONS.userApprovalRecord, event, record)).toEqual(UNAUTHORIZED_FRAME);
    expect(await invoke(PERMISSIONS.userApprovalRecord, event, { ...record, rule: { scope: "always" } })).toEqual(UNAUTHORIZED_FRAME);
    expect(await invoke(PERMISSIONS.approvalSentenceSelect, event, { requestId: request.id, input: "/allow just once", intent: record.intent })).toEqual(UNAUTHORIZED_FRAME);
    expect(snapshot).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(addRule).not.toHaveBeenCalled();
    expect(await approvals.listApprovals()).toEqual([]);
    expect(f.selectComplete).not.toHaveBeenCalled();
    expect(f.gate.pendingCount).toBe(1);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
  });

  it.each(["paused automation", "late pause", "ordinary default"] as const)("keeps a valid signed %s card pending after another window answers", async (lane) => {
    const f = await subject(lane === "ordinary default" ? "default" : "auto");
    if (lane === "paused automation") await f.pause();
    const held = lane === "late pause" ? f.holdNextPreToolUse() : undefined;
    const pending = f.start();
    if (held) {
      await held.reached;
      await f.pause();
      held.release();
    }
    const card = await f.waitForCard();
    const decision = allowOnceCardAnswer(card);
    const breakerBefore = f.manager.getJudgeBreaker().snapshot(SESSION_ID);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), decision);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.manager.getJudgeBreaker().snapshot(SESSION_ID)).toEqual(breakerBefore);
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(lane !== "ordinary default");
    expect(f.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval", sessionId: SESSION_ID, output: expect.stringContaining("approval:surface-owner-required"),
    }));
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowB))).toEqual([]);
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowA))).toEqual([card]);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    expect((await pending)[0].is_error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(lane !== "ordinary default");
    if (lane === "ordinary default") expect(f.complete).not.toHaveBeenCalled();
  });

  it("filters a paused card to its live session owner and follows ownership moves", async () => {
    const f = await subject();
    await f.pause();
    const pending = f.start();
    const card = await f.waitForCard();
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowB))).toEqual([]);
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowA))).toEqual([card]);
    f.setOwner(f.windowB);
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowA))).toEqual([]);
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowB))).toEqual([card]);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), allowOnceCardAnswer(card));
    expect((await pending)[0].is_error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });

  it("fails closed while the pending session has no live owner", async () => {
    const f = await subject();
    await f.pause();
    const pending = f.start();
    const card = await f.waitForCard();
    f.setOwner(undefined);
    for (const window of [f.windowA, f.windowB]) {
      expect(invoke(PERMISSIONS.approvalPending, frameEvent(window))).toEqual([]);
      invoke(PERMISSIONS.approvalRespond, frameEvent(window), allowOnceCardAnswer(card));
    }
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
    f.setOwner(f.windowB);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowB), allowOnceCardAnswer(card));
    expect((await pending)[0].is_error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each(["subframe", "unregistered renderer", "destroyed window", "destroyed contents"] as const)("rejects a %s before listing or settling a native card", async (source) => {
    const f = await subject();
    await f.pause();
    const pending = f.start();
    const card = await f.waitForCard();
    const stranger = appWindow(303);
    const event = source === "subframe"
      ? frameEvent(f.windowA, { url: f.windowA.webContents.mainFrame.url })
      : source === "unregistered renderer" ? frameEvent(stranger) : frameEvent(f.windowA);
    if (source === "destroyed window") f.windowA.isDestroyed.mockReturnValue(true);
    if (source === "destroyed contents") f.windowA.webContents.isDestroyed.mockReturnValue(true);
    expect(invoke(PERMISSIONS.approvalPending, event)).toEqual(UNAUTHORIZED_FRAME);
    expect(invoke(PERMISSIONS.approvalRespond, event, allowOnceCardAnswer(card))).toEqual(UNAUTHORIZED_FRAME);
    expect(f.gate.pendingCount).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
    expect(f.auditLog.mock.calls.filter(([entry]) => entry.sessionId === "ipc-guard")).toHaveLength(2);
    f.windowA.isDestroyed.mockReturnValue(false);
    f.windowA.webContents.isDestroyed.mockReturnValue(false);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    expect((await pending)[0].is_error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("denies a paused headless invocation without exposing a native card or approval authority", async () => {
    const f = await subject();
    await f.pause();
    const [result] = await f.start(true);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Nobody can approve this request; do not retry.");
    expect(f.cards(f.windowA)).toHaveLength(0);
    expect(f.cards(f.windowB)).toHaveLength(0);
    expect(f.gate.pendingCount).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(invoke(PERMISSIONS.approvalPending, frameEvent(f.windowA))).toEqual([]);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), { requestId: "headless", choice: "allow-once" });
    expect(f.gate.pendingCount).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  });
});
