import { allowOnceCardAnswer } from "../../../__tests__/support/approval-card-answer.js";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput, IPC_APPROVAL_REQUEST } from "../../../permissions/approval-gate.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../../permissions/judge/judge-settings.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { __resetRunGrantsForTest } from "../../../permissions/run-grants.js";
import { createRunScopeHooks } from "../../../permissions/run-scope.js";
import * as approvals from "../../../permissions/user-approval-store.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { BashTool } from "../../../tools/shell-tools.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { makeWriteProbeTool } from "../../../tools/__tests__/approval-memory-test-fixtures.js";
import { userPermissionContext } from "../../../tools/__tests__/tool-context-fixture.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) },
  session: { defaultSession: { resolveProxy: vi.fn(async () => "DIRECT") } },
}));

const resources = new PermissionTestResources();
const cleanup: Array<() => Promise<void>> = [];
const RUN = "work-board:7#run-a";
const NEXT_RUN = "work-board:7#run-b";
const INTENT = { inputOrigin: "user-keyboard", userActivation: true };

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  approvals.__resetSessionStoreForTest();
  __resetRunGrantsForTest();
  vi.unstubAllEnvs();
  handlers.clear();
  await resources.cleanup();
});

async function subject() {
  __resetRunGrantsForTest();
  const root = resources.makeTmpDir("ave-run-grant-record-");
  vi.stubEnv("AVE_HOME", join(root, "home"));
  for (const stage of ["plan", "build"]) mkdirSync(join(root, stage));
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const contents = { id: 101, mainFrame: { url: "file:///application/index.html" }, isDestroyed: vi.fn(() => false), send: vi.fn() };
  const window = { isDestroyed: vi.fn(() => false), webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  // Every stage child of the board row is drawn by the window the run started from.
  const gate = new ApprovalGate(() => contents as unknown as WebContents, undefined, undefined, audit);
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  manager.setJudge({
    settings: { ...DEFAULT_JUDGE_SETTINGS, chain: [], categories: { ...DEFAULT_JUDGE_SETTINGS.categories }, breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker } },
    chain: [], breaker: manager.getJudgeBreaker(), audit,
  });
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => "wrote");
  registry.register(makeWriteProbeTool(execute));
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, new ScriptHookManager(), audit);
  const pending: Promise<unknown>[] = [];
  const track = <T>(run: Promise<T>): Promise<T> => { pending.push(run); void run.catch(() => undefined); return run; };
  cleanup.push(async () => {
    gate.disposeAll();
    await Promise.allSettled(pending);
    await audit.close();
  });
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers({
    conversationLoop: { permissionManager: manager }, approvalGate: gate, auditLogger: audit,
    toolRegistry: registry, getMainWindow: () => window, getAppWindows: () => [window],
  } as never);
  const hooks = createRunScopeHooks(manager);
  const invoke = (channel: string, payload: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing registered handler: ${channel}`);
    return handler(event, payload);
  };
  const cards = (): ApprovalRequest[] => contents.send.mock.calls.filter(([channel]) => channel === IPC_APPROVAL_REQUEST).map(([, card]) => card as ApprovalRequest);
  const nextCard = async (count: number): Promise<ApprovalRequest> => {
    await vi.waitFor(() => expect(cards()).toHaveLength(count));
    const card = cards()[count - 1];
    if (card === undefined) throw new Error("no approval card was raised");
    return card;
  };
  /** The same write from a stage session, in that stage's own folder. */
  const write = (sessionId: string, stage: string) => track(executor.executeAll(
    [{ id: randomUUID(), name: "write_probe", input: { path: join(root, "shared", "result.txt") } }],
    { sessionId, executionCwd: join(root, stage), permissionContext: userPermissionContext({ additionalDirectories: [root] }) },
  ));
  /** A write to a folder no stage may write to yet: the folder-access card. */
  const outside = resources.makeTmpDir("ave-run-grant-outside-");
  const writeOutside = (sessionId: string, stage: string) => track(executor.executeAll(
    [{ id: randomUUID(), name: "write_probe", input: { path: join(outside, "result.txt") } }],
    { sessionId, executionCwd: join(root, stage), permissionContext: userPermissionContext({ additionalDirectories: [root] }) },
  ));
  /** A host shell command from a stage session, in that stage's own folder. */
  const shellRun = (sessionId: string, stage: string, command: string) => track(executor.executeAll(
    [{ id: randomUUID(), name: "bash", input: { command, executionMode: "host", justification: "Print one local value", timeoutSeconds: 1 } }],
    { sessionId, executionCwd: join(root, stage), permissionContext: userPermissionContext({ additionalDirectories: [root] }) },
  ));
  const queueCard = (sessionId: string, overrides: Partial<ApprovalRequestInput> = {}) => {
    const request: ApprovalRequestInput = {
      id: randomUUID(), sessionId, category: "tool", kind: "tool", toolName: "write_probe", toolCategory: "write",
      source: "builtin", trustOrigin: "user-keyboard", args: { path: join(root, "remembered.txt") }, reason: "manual review", createdAt: Date.now(),
      reviewerVerdict: { level: "low", reason: "bounded action" },
      evaluationContext: buildPermissionEvaluationContext({
        policyMode: "default", headless: false, source: "builtin", category: "write", trustOrigin: "user-keyboard",
        executionCwd: root, allowedDirectories: [root], pathFields: ["path"], targetFilePaths: [], sensitivePathsAdjacent: [],
      }),
      ...overrides,
    };
    return { request, result: track(gate.requestAndWait(request)) };
  };
  const record = (card: Pick<ApprovalRequest, "id" | "args">, body: Record<string, unknown>) => invoke(PERMISSIONS.userApprovalRecord, {
    requestId: card.id, args: JSON.stringify(card.args), decision: "allow", scope: "run",
    verdictAtApproval: gate.getRequestSnapshot(card.id)?.verdictAtApproval, nlJustification: null, intent: INTENT, ...body,
  });
  const link = (runKey: string, sessionId: string, stageId: string, lane: "attended" | "unattended" = "attended") =>
    hooks.sessionLinked(runKey, sessionId, { stageId, stageName: stageId, lane });
  return { root, gate, manager, hooks, registry, execute, invoke, cards, nextCard, write, writeOutside, shellRun, queueCard, record, link };
}

describe("Allow for this run, from the card to node R", () => {
  it("one stage's run allow lets a sibling's same call pass without a card, leaves an open sibling card unanswered and ends with the run", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const planning = f.write("plan-session", "plan");
    const planCard = await f.nextCard(1);
    expect(planCard.runStage).toMatchObject({ stageId: "plan", runAllowOffered: true });
    // The sibling asked for the same thing before the grant existed: its card is open too.
    const building = f.write("build-session", "build");
    const buildCard = await f.nextCard(2);
    expect(buildCard.runStage).toMatchObject({ stageId: "build" });

    expect(await f.record(planCard, {})).toEqual({ ok: true });
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(planCard));
    const [planned] = await planning;
    expect(planned?.is_error, JSON.stringify(planned)).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    // The card that was already open is not auto-answered by the grant.
    expect(f.gate.pendingCount).toBe(1);
    expect(f.gate.getRequestSnapshot(buildCard.id)).not.toBeNull();
    f.invoke(PERMISSIONS.approvalRespond, { ...allowOnceCardAnswer(buildCard), choice: "deny-once" });
    expect((await building)[0]?.is_error).toBe(true);

    // A later call of the sibling stage reads the grant at R: no card, and it runs.
    const [reused] = await f.write("build-session", "build");
    expect(reused?.is_error, JSON.stringify(reused)).toBeUndefined();
    expect(f.cards()).toHaveLength(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    // Nothing was saved as a rule or an approval on disk.
    expect(existsSync(approvals.userApprovalFilePath())).toBe(false);
    expect(existsSync(join(f.root, "permissions.json"))).toBe(false);

    // The run ends: the same call of the item's next run asks again.
    f.hooks.runEnded(RUN);
    f.link(NEXT_RUN, "next-plan-session", "plan");
    const next = f.write("next-plan-session", "plan");
    const nextCard = await f.nextCard(3);
    f.invoke(PERMISSIONS.approvalRespond, { ...allowOnceCardAnswer(nextCard), choice: "deny-once" });
    expect((await next)[0]?.is_error).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("refuses run scope for a forced floor, a session outside a run, a schedule-started stage, a deny and a run that already ended", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link("work-board:9#run-s", "scheduled-session", "report", "unattended");

    const floor = f.queueCard("plan-session", { forceExplicit: true });
    expect(await f.record(floor.request, {})).toMatchObject({ ok: false, error: "one-shot-not-recordable" });

    const chat = f.queueCard("chat-session");
    expect(await f.record(chat.request, {})).toMatchObject({ ok: false, error: "run-scope-unavailable" });

    const scheduled = f.queueCard("scheduled-session");
    expect(await f.record(scheduled.request, {})).toMatchObject({ ok: false, error: "run-scope-unavailable" });

    // A card the host did not offer the run on takes no run allow, whatever the renderer sends: here a user-owned surface's card.
    const surface = f.queueCard("plan-session", { userOwnedSurface: "browser" });
    expect(f.gate.getRequestSnapshot(surface.request.id)?.runStage).toMatchObject({ stageId: "plan", runAllowOffered: false });
    expect(await f.record(surface.request, {})).toMatchObject({ ok: false });
    const surfaceShell = f.queueCard("plan-session", { userOwnedSurface: "host-terminal", toolName: "bash", toolCategory: "shell", args: { command: "printf surface" } });
    expect(f.gate.getRequestSnapshot(surfaceShell.request.id)?.runStage).toMatchObject({ runAllowOffered: false });
    expect(await f.record(surfaceShell.request, { rule: { action: "allow", scope: "run" } })).toMatchObject({ ok: false });
    expect(approvals.listSessionApprovals()).toEqual([]);

    const ordinary = f.queueCard("plan-session");
    expect(await f.record(ordinary.request, { decision: "deny" })).toMatchObject({ ok: false, error: "deny-requires-persistent-scope" });

    // The card is still open when its run ends: the late record stores nothing.
    f.hooks.runEnded(RUN);
    expect(await f.record(ordinary.request, {})).toMatchObject({ ok: false, error: "run-scope-unavailable" });
    expect(approvals.listSessionApprovals()).toEqual([]);
  });

  it("a shell card saves its run allow as a run rule under one policy step, and only where a session rule could be saved", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const shell = (sessionId: string) => f.manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command: "printf ready", cwd: join(f.root, "build") },
      shellExecution: { runsSandboxed: false }, sessionId,
    });
    const { request, result } = f.queueCard("plan-session", { toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    const card = await f.nextCard(1);
    expect(card.runStage).toMatchObject({ stageId: "plan", runAllowOffered: true });
    const before = f.manager.getPolicyEpoch();
    expect(await f.record(request, { rule: { action: "allow", scope: "run" } })).toEqual({ ok: true });
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(card));
    const answer = await result;
    expect(answer.choice).toBe("allow-once");
    expect(f.gate.allowsPolicyTransition(answer, before, f.manager.getPolicyEpoch())).toBe(true);
    expect(shell("build-session")).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(shell("chat-session")).toMatchObject({ decision: "ask" });
    expect(existsSync(join(f.root, "permissions.json"))).toBe(false);

    // The record's scope and the rule's scope must name the same choice.
    const mismatched = f.queueCard("build-session", { toolName: "bash", toolCategory: "shell", args: { command: "printf mismatch" } });
    expect(await f.record(mismatched.request, { scope: "session", rule: { action: "allow", scope: "run" } })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(await f.record(mismatched.request, { scope: "run", rule: { action: "allow", scope: "session" } })).toMatchObject({ ok: false, error: "invalid-rule" });

    const forced = f.queueCard("build-session", { toolName: "bash", toolCategory: "shell", args: { command: "printf other" },
      forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false });
    expect(await f.record(forced.request, { rule: { action: "allow", scope: "run" } })).toMatchObject({ ok: false, error: "one-shot-not-recordable" });

    f.hooks.runEnded(RUN);
    expect(shell("build-session")).toMatchObject({ decision: "ask" });
  });

  // Parallel stages each keep a card open. A policy change one of them makes must not void the others' answers, and must still
  // refuse a call the policy now denies.
  it("a sibling's open card is still answered after another stage saves a run rule", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const planning = f.write("plan-session", "plan");
    const planCard = await f.nextCard(1);
    const building = f.write("build-session", "build");
    const buildCard = await f.nextCard(2);
    const before = f.manager.getPolicyEpoch();
    f.manager.addRunRule("plan-session", "Bash(npm test)");
    expect(f.manager.getPolicyEpoch()).not.toBe(before);

    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(buildCard));
    const [built] = await building;
    expect(built?.is_error, JSON.stringify(built)).toBeUndefined();
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(planCard));
    const [planned] = await planning;
    expect(planned?.is_error, JSON.stringify(planned)).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("two stages ask for the same command: one allows it for the run, and the other's open card is still answered", async () => {
    const f = await subject();
    const bash = new BashTool();
    const ran = vi.spyOn(bash, "execute");
    f.registry.register(bash);
    f.link(RUN, "build-session", "build");
    f.link(RUN, "test-session", "plan");
    const building = f.shellRun("build-session", "build", "printf run-proof");
    const buildCard = await f.nextCard(1);
    const testing = f.shellRun("test-session", "plan", "printf run-proof");
    const testCard = await f.nextCard(2);
    expect(buildCard.runStage).toMatchObject({ stageId: "build", runAllowOffered: true });

    expect(await f.record(buildCard, { rule: { action: "allow", scope: "run" } })).toEqual({ ok: true });
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(buildCard));
    const [built] = await building;
    expect(built?.is_error, JSON.stringify(built)).toBeUndefined();
    // The run rule did not answer the sibling's card; the person does, and the answer is not void.
    expect(f.gate.getRequestSnapshot(testCard.id)).not.toBeNull();
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(testCard));
    const [tested] = await testing;
    expect(tested?.is_error, JSON.stringify(tested)).toBeUndefined();
    expect(tested?.content).toBe("run-proof");
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it.each(["sibling run rule", "other policy change"] as const)("a folder-access card answered across a policy change: %s", async (change) => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const building = f.writeOutside("build-session", "build");
    const card = await f.nextCard(1);
    expect(card.kind).toBe("out-of-allowed-dir");
    const before = f.manager.getPolicyEpoch();
    if (change === "sibling run rule") f.manager.addRunRule("plan-session", "Bash(npm test)");
    else f.manager.setRules([{ pattern: "Bash(npm test)", action: "allow" }]);
    expect(f.manager.getPolicyEpoch()).not.toBe(before);
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(card));
    const [built] = await building;
    if (change === "sibling run rule") {
      expect(built?.is_error, JSON.stringify(built)).toBeUndefined();
      expect(f.execute).toHaveBeenCalledTimes(1);
    } else {
      expect(built).toMatchObject({ is_error: true, content: "Permission policy changed during approval." });
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it("in auto mode a card the reviewer sent to a person is still answered after a sibling's run rule", async () => {
    const f = await subject();
    f.manager.setMode("auto");
    f.manager.setReviewer({ classifier: { classify: () => ({ level: "high", reason: "blocked" }) }, cache: resources.makeVerdictCache(join(f.root, "verdicts.jsonl")) });
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const building = f.write("build-session", "build");
    const buildCard = await f.nextCard(1);
    f.manager.addRunRule("plan-session", "Bash(npm test)");
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(buildCard));
    const [built] = await building;
    expect(built?.is_error, JSON.stringify(built)).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("a card open across any other policy change is refused as before: a mode change, a saved deny rule", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const building = f.write("build-session", "build");
    const buildCard = await f.nextCard(1);
    f.manager.addRunRule("plan-session", "Bash(npm test)");
    f.manager.setMode("auto");
    f.manager.setMode("default");
    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(buildCard));
    const [built] = await building;
    expect(built?.is_error).toBe(true);
    expect(built?.content).toContain("Permission policy changed");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("a card open while a deny rule is set is refused as a changed policy, whatever the answer", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.link(RUN, "build-session", "build");
    const building = f.write("build-session", "build");
    const buildCard = await f.nextCard(1);
    f.manager.addRunRule("plan-session", "Bash(npm test)");
    f.manager.setRules([{ pattern: "write_probe", action: "deny" }]);

    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(buildCard));
    const [built] = await building;
    expect(built?.is_error).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("another conversation's open card is still answered after a run that held a run rule ends", async () => {
    const f = await subject();
    f.link(RUN, "plan-session", "plan");
    f.manager.addRunRule("plan-session", "Bash(npm test)");
    const chatting = f.write("chat-session", "plan");
    const chatCard = await f.nextCard(1);
    expect(chatCard.runStage).toBeUndefined();
    const before = f.manager.getPolicyEpoch();
    f.hooks.runEnded(RUN);
    expect(f.manager.getPolicyEpoch()).not.toBe(before);

    f.invoke(PERMISSIONS.approvalRespond, allowOnceCardAnswer(chatCard));
    const [chatted] = await chatting;
    expect(chatted?.is_error, JSON.stringify(chatted)).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
