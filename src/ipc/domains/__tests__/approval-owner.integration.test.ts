import { allowOnceCardAnswer } from "../../../__tests__/support/approval-card-answer.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { t } from "../../../i18n/runtime.js";
import { terminalSessionFixture } from "../../../__tests__/support/terminal-session-fixtures.js";
import { TERMINAL_TEST_NONCE, terminalMarker } from "../../../__tests__/support/terminal-markers.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { __resetTerminalBlocksForTest, registerTerminalBlockTracker, TerminalBlockTracker } from "../../../main/terminal/terminal-blocks.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput, IPC_APPROVAL_REQUEST, IPC_APPROVAL_SETTLED } from "../../../permissions/approval-gate.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../../permissions/judge/judge-settings.js";
import * as terminalWriteAuthority from "../../../permissions/host-terminal-write-authority.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { matchesProjectRuleRootBinding, projectRulesLocation } from "../../../permissions/rules/project-rule-files.js";
import { captureShellWorkingDirectoryIdentity } from "../../../permissions/shell-working-directory-identity.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { LlmRiskClassifier, type LlmReviewerProvider, type RiskVerdict } from "../../../permissions/reviewer/risk-classifier.js";
import { LlmApprovalSentenceSelector } from "../../../permissions/reviewer/approval-sentence-selector.js";
import * as approvals from "../../../permissions/user-approval-store.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { _resetAveHomePrivacyForTest, setAveHomeConfigurationRefusedAtBoot } from "../../../shared/ave-home.js";
import * as homeTrust from "../../../shared/ave-home-trust.js";
import { HOME_FOLDER_REFUSED } from "../../../shared/permissions-events.js";
import { consumeHostShellExecutionPermitForSpawn, canonicalizeHostShellAllowedDirectories, resolveHostShellWorkingDirectory } from "../../../permissions/host-shell-execution-permit.js";
import { parseHostShellExecutionInput } from "../../../permissions/host-shell-execution-plan.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest, getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../../permissions/sandbox-capability.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../../boot/steps/windows-sandbox-plan.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { noteOtherPrincipalGuidance, runWithHostTerminalTurn } from "../../../tools/host-terminal-turn.js";
import * as invocationExecution from "../../../tools/invocation-execution.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { BashTool } from "../../../tools/shell-tools.js";
import { createTerminalRunTool } from "../../../tools/terminal-run.js";
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

async function closeFixtures() {
  for (const close of cleanup.splice(0)) await close();
}

afterEach(async () => {
  await closeFixtures();
  __resetTerminalBlocksForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetWindowsSandboxSubstrateForTest();
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
  const firstCard = deferred<ApprovalRequest>();
  windowA.webContents.send.mockImplementation((channel: string, card: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) firstCard.resolve(card);
  });
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
  const releaseHolds: Array<() => void> = [];
  const hold = () => {
    const held = deferred<void>();
    releaseHolds.push(held.resolve);
    return held;
  };
  const pending: Promise<unknown>[] = [];
  const track = <T>(run: Promise<T>): Promise<T> => {
    pending.push(run);
    void run.catch(() => undefined);
    return run;
  };
  const selectComplete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ optionId: "o1", confidence: "high", reason: "requested one action" }), tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const selector = new LlmApprovalSentenceSelector({ complete: selectComplete }, "review-model");
  cleanup.push(async () => {
    gate.disposeAll();
    for (const release of releaseHolds) release();
    await Promise.allSettled(pending);
    await audit.close();
  });
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers({
    conversationLoop: { permissionManager: manager }, approvalGate: gate, auditLogger: audit,
    toolRegistry: registry, getMainWindow: () => windowA, getAppWindows: () => [windowA, windowB],
    getApprovalSentenceSelector: () => selector,
  } as never);
  const executeAll = (...args: Parameters<ToolExecutor["executeAll"]>) => track(executor.executeAll(...args));
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
    return executeAll([{ id: randomUUID(), name: "write_probe", input: { path: join(root, "requested.txt") } }], {
      sessionId: SESSION_ID, executionCwd: root,
      permissionContext: userPermissionContext({ additionalDirectories: [root], headless }),
    });
  };
  const cards = (window: AppWindow): ApprovalRequest[] => window.webContents.send.mock.calls
    .filter(([channel]) => channel === IPC_APPROVAL_REQUEST).map(([, card]) => card as ApprovalRequest);
  const waitForCard = async () => {
    const card = await Promise.race([
      firstCard.promise,
      ...pending.map((run) => run.then(() => {
        throw new Error("Approval work settled before the owner received its card");
      })),
    ]);
    expect(cards(windowA)).toEqual([card]);
    return card;
  };
  const holdNextPreToolUse = () => {
    const original = hooks.runPreToolUse.bind(hooks);
    const reached = deferred<void>();
    const held = hold();
    vi.spyOn(hooks, "runPreToolUse").mockImplementationOnce(async (...args) => {
      reached.resolve();
      await held.promise;
      return original(...args);
    });
    return { reached: reached.promise, release: held.resolve };
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
    return { request, result: track(requestBoundShellCard(gate, request, root)) };
  };
  return { root, audit, auditLog, windowA, windowB, gate, manager, registry, executeAll, execute, complete, selectComplete, pause, start, cards, waitForCard, hold, holdNextPreToolUse, queueCard, setOwner: (next: AppWindow | undefined) => { owner = next; } };
}

describe("live native approval ownership", () => {
  async function terminalFloorSubject() {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    setShellSandboxRequestedAtBoot(true);
    f.manager.setUserOwnedSurfaceChoice(SESSION_ID, "host-terminal", "allow");
    const cwd = join(f.root, "workspace", "work");
    mkdirSync(cwd, { recursive: true });
    const windowId = 101;
    const terminal = terminalSessionFixture("terminal:0000c0de-1", "manual");
    const tracker = new TerminalBlockTracker({ nonce: TERMINAL_TEST_NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${terminalMarker("D;0")}${terminalMarker(`P;Cwd=${cwd};Keys=emacs;Paste=1`)}${terminalMarker("A")}% ${terminalMarker("B")}`);
    registerTerminalBlockTracker(terminal, tracker, windowId);
    const write = vi.fn();
    f.registry.register(createTerminalRunTool({
      windowIdForHostedSession: sessionId => sessionId === SESSION_ID ? windowId : null,
      liveOriginSessionId: () => undefined,
      boundSurface: () => ({ kind: "terminal", tabId: terminal.tabId }),
      ensureConversationTerminal: async () => { throw new Error("Unexpected isolated terminal"); },
      typeCommand: async () => { throw new Error("Unexpected isolated terminal write"); },
      verifyShell: async () => { throw new Error("Unexpected isolated terminal verification"); },
      auditMismatch: () => {},
      host: {
        session: () => terminal,
        placement: () => "workspace",
        shellName: () => "zsh",
        control: () => ({ mode: "available", generation: 1, agentInput: "supported" }),
        verifyShell: async (_ref, _window, reportedCwd) => ({ ok: true, cwd: reportedCwd }),
        typeCommand: async (_ref, _window, request) => {
          const effect = await request.effectCheck();
          if (!effect.ok) return { ok: false, reason: "effect-refused", message: effect.message };
          const refusal = request.writeFence?.();
          if (refusal !== undefined) return { ok: false, reason: "effect-refused", message: refusal };
          write(request.line);
          return { ok: true, firstBlockId: 1 };
        },
        waitDisclosure: async (_ref, _window, sessionId, turnId) => ({
          requestingSessionId: sessionId, turnId, command: String(write.mock.lastCall?.[0]), cwd, blockId: 1,
          state: "done", exitCode: 0, output: "ready", outputChars: 5, truncated: false,
        }),
      },
    }));
    const runTerminal = (turnId: string, command: string) =>
      f.executeAll([{ id: turnId, name: "terminal_run", input: { command, waitSeconds: 0 } }], {
        sessionId: SESSION_ID, executionCwd: cwd,
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg", additionalDirectories: [cwd] }),
      });
    const recordTerminalWaiver = (card: ApprovalRequest) => Promise.resolve(invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: card.id, args: JSON.stringify(card.args), decision: "allow", scope: "session",
      verdictAtApproval: f.gate.getRequestSnapshot(card.id)?.verdictAtApproval,
      rule: { action: "allow", scope: "session" }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    }));
    return { ...f, cwd, write, runTerminal, recordTerminalWaiver };
  }

  it.each(["deny", "allow", "changed forced question", "changed forced question, denied"] as const)("rechecks the original terminal command after saving its late floor waiver: %s", async current => {
    const f = await terminalFloorSubject();
    const frame = frameEvent(f.windowA);
    const warmup = runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "initial-waiver" }, () =>
      f.runTerminal("initial-waiver", "printf initial"));
    const first = await f.waitForCard();
    expect(await f.recordTerminalWaiver(first)).toEqual({ ok: true });
    await invoke(PERMISSIONS.approvalRespond, frame, allowOnceCardAnswer(first));
    expect((await warmup)[0]?.is_error).toBeFalsy();
    expect(f.write.mock.calls).toEqual([["printf initial"]]);
    f.write.mockClear();
    const changed = current.startsWith("changed");
    const command = changed ? "printf ready > output/result.txt" : "printf ready";
    const outputDir = join(f.cwd, "output");
    const protectedDir = join(f.cwd, ".vscode");
    if (changed) {
      mkdirSync(outputDir);
      mkdirSync(protectedDir);
    }

    const reached = deferred<void>();
    const held = f.hold();
    const execute = invocationExecution.executeAuthorizedToolInvocation;
    const admission = vi.spyOn(invocationExecution, "executeAuthorizedToolInvocation").mockImplementationOnce(context => execute({
      ...context,
      finalizeExecutionRouteGrant: async () => {
        reached.resolve();
        await held.promise;
        return context.finalizeExecutionRouteGrant?.();
      },
    }));
    const lateCard = deferred<ApprovalRequest>();
    const freshCard = deferred<ApprovalRequest>();
    f.windowA.webContents.send.mockImplementation((channel: string, card: ApprovalRequest) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      if (f.cards(f.windowA).length === 2) lateCard.resolve(card);
      else freshCard.resolve(card);
    });
    const transition = vi.spyOn(f.gate, "allowsPolicyTransition");
    const issueWriteAuthority = vi.spyOn(terminalWriteAuthority, "issueHostTerminalWriteAuthority");
    const turnId = "late-waiver";
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId }, async () => {
      const pending = f.runTerminal(turnId, command);
      const settledEarly = pending.then(result => { throw new Error(`Terminal command settled early: ${result[0]?.content}`); });
      await Promise.race([reached.promise, lateCard.promise.then(() => { throw new Error("Approval card arrived before handler admission"); }), settledEarly]);
      expect(admission.mock.calls[0]?.[0].permissionResult).toMatchObject({ decision: "allow", reasonCode: "floor-session-allow" });
      expect(f.cards(f.windowA)).toEqual([first]);
      // The existing waiver covers the floor only while the ordinary decision allows the command.
      f.manager.setUserOwnedSurfaceChoice(SESSION_ID, "host-terminal", "ask");
      held.resolve();

      const card = await Promise.race([lateCard.promise, settledEarly]);
      expect(card).toMatchObject({
        args: { command },
        allowedChoices: ["allow-once", "deny-once"],
        shellRule: { floorSessionOnly: true, sessionAllowed: true },
      });
      expect(issueWriteAuthority).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      const openedEpoch = f.manager.getPolicyEpoch();
      expect(await f.recordTerminalWaiver(card)).toEqual({ ok: true });
      expect(f.manager.getPolicyEpoch()).not.toBe(openedEpoch);
      if (current === "deny") noteOtherPrincipalGuidance();
      if (changed) {
        renameSync(outputDir, join(f.cwd, "former-output"));
        symlinkSync(protectedDir, outputDir, "junction");
      }
      if (current === "changed forced question, denied") {
        await invoke(PERMISSIONS.approvalRespond, frame, { ...allowOnceCardAnswer(card), choice: "deny-once" });
        const [result] = await pending;
        expect(transition).toHaveReturnedWith(true);
        expect(result?.is_error).toBe(true);
        expect(f.cards(f.windowA)).toEqual([first, card]);
        expect(f.auditLog.mock.calls.some(([entry]) => entry.output?.startsWith("[approval:answer-stale]"))).toBe(false);
        expect(issueWriteAuthority).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
        return;
      }
      await invoke(PERMISSIONS.approvalRespond, frame, allowOnceCardAnswer(card));

      if (current === "changed forced question") {
        const fresh = await Promise.race([freshCard.promise, pending.then(() => undefined)]);
        expect(transition).toHaveReturnedWith(true);
        expect.soft(issueWriteAuthority).not.toHaveBeenCalled();
        expect.soft(f.write).not.toHaveBeenCalled();
        expect(fresh).toBeDefined();
        if (!fresh) return;
        expect(fresh.id).not.toBe(card.id);
        expect(fresh).toMatchObject({ args: { command }, reason: card.reason, allowedChoices: ["allow-once", "deny-once"] });
        expect(fresh.shellRule?.sessionAllowed).not.toBe(true);
        const stale = f.auditLog.mock.calls.map(([entry]) => entry.output ?? "").filter(output => output.startsWith("[approval:answer-stale]"));
        expect(stale).toEqual([expect.stringContaining(`[approval:answer-stale] ${card.id} `)]);
        expect(stale[0]).toMatch(/ choice=allow-once outcome=stale-reasked authority=none question=\[.*,true,null\] -> \[.*,false,"protected-path: /);
        const decided = f.auditLog.mock.calls.map(([entry]) => entry.output ?? "").filter(output => output.startsWith(`[approval:decided] ${card.id} `));
        expect(decided).toEqual([expect.stringContaining(" choice=allow-once ")]);
        expect(invoke(PERMISSIONS.approvalPending, frame)).toEqual([fresh]);
        await invoke(PERMISSIONS.approvalRespond, frame, allowOnceCardAnswer(card));
        expect(invoke(PERMISSIONS.approvalPending, frame)).toEqual([fresh]);
        await invoke(PERMISSIONS.approvalRespond, frame, allowOnceCardAnswer(fresh));
        const [result] = await pending;
        expect(result?.is_error, result?.content).toBeFalsy();
        expect(issueWriteAuthority).toHaveBeenCalled();
        expect(f.write.mock.calls).toEqual([[command]]);
        return;
      }

      const [result] = await pending;
      expect(transition).toHaveReturnedWith(true);
      expect(f.cards(f.windowA)).toEqual([first, card]);
      if (current === "deny") {
        expect.soft(issueWriteAuthority.mock.calls.length).toBe(0);
        expect(f.write).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          is_error: true,
          content: "Host terminal typing is available only to the user's own turn in its pane chat",
        });
      } else {
        expect(result?.is_error, result?.content).toBeFalsy();
        expect(result?.tool_use_id).toBe(turnId);
        expect(f.write.mock.calls).toEqual([[command]]);
      }
    });
  });

  it.each(["allow-once", "deny-once"] as const)("refuses the terminal floor card's %s when its save left another forced question", async choice => {
    const f = await terminalFloorSubject();
    const command = "printf ready > output/result.txt";
    const outputDir = join(f.cwd, "output");
    const protectedDir = join(f.cwd, ".vscode");
    mkdirSync(outputDir);
    mkdirSync(protectedDir);
    const transition = vi.spyOn(f.gate, "allowsPolicyTransition");
    const issueWriteAuthority = vi.spyOn(terminalWriteAuthority, "issueHostTerminalWriteAuthority");
    const pending = runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "changed-initial" }, () => f.runTerminal("changed-initial", command));
    const card = await f.waitForCard();
    expect(card).toMatchObject({ args: { command }, shellRule: { floorSessionOnly: true, sessionAllowed: true } });
    expect(await f.recordTerminalWaiver(card)).toEqual({ ok: true });
    renameSync(outputDir, join(f.cwd, "former-output"));
    symlinkSync(protectedDir, outputDir, "junction");
    await invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), { ...allowOnceCardAnswer(card), choice });
    const [result] = await pending;
    expect(transition).toHaveReturnedWith(true);
    const stale = f.auditLog.mock.calls.map(([entry]) => entry.output ?? "").filter(output => output.startsWith("[approval:answer-stale]"));
    if (choice === "allow-once") {
      expect(result).toMatchObject({ is_error: true, content: expect.stringContaining(t("be_executor.answerQuestionChanged")) });
      expect(stale).toEqual([expect.stringContaining(`[approval:answer-stale] ${card.id} `)]);
      expect(stale[0]).toMatch(/ choice=allow-once outcome=stale-refused authority=none question=\[.*,true,null\] -> \[.*,false,"protected-path: /);
      const decided = f.auditLog.mock.calls.map(([entry]) => entry.output ?? "").filter(output => output.startsWith(`[approval:decided] ${card.id} `));
      expect(decided).toEqual([expect.stringContaining(" choice=allow-once ")]);
    } else {
      expect(result).toMatchObject({ is_error: true, content: t("be_executor.approvalDeniedByUser", { name: "terminal_run" }) });
      expect(stale).toEqual([]);
    }
    expect(issueWriteAuthority).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each(["before save", "during audit", "unchanged"] as const)("checks the terminal floor card's directory when it is %s", async scenario => {
    const f = await terminalFloorSubject();
    const { cwd, write } = f;
    const originalCwd = captureShellWorkingDirectoryIdentity(cwd);
    expect(originalCwd).toBeDefined();
    const run = (turnId: string, command: string) => runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId }, () =>
      f.runTerminal(turnId, command));
    const original = run("original-terminal-command", "printf ready");
    const card = await f.waitForCard();
    expect(card.shellRule).toMatchObject({ floorSessionOnly: true, sessionAllowed: true });
    const replaceCwd = () => {
      renameSync(cwd, join(f.root, "former-work"));
      mkdirSync(cwd);
      expect(captureShellWorkingDirectoryIdentity(cwd)?.ino).not.toBe(originalCwd?.ino);
    };
    const auditReached = deferred<void>();
    const auditRelease = f.hold();
    const append = f.audit.append.bind(f.audit);
    const audit = vi.spyOn(f.audit, "append").mockImplementation(async entry => {
      if (entry.output?.startsWith("[approval:remembered]")) {
        auditReached.resolve();
        if (scenario === "during audit") await auditRelease.promise;
      }
      await append(entry);
    });
    if (scenario === "before save") replaceCwd();
    const record = f.recordTerminalWaiver(card);
    if (scenario === "during audit") {
      await Promise.race([auditReached.promise, record.then(() => { throw new Error("Waiver save skipped its audit wait"); })]);
      replaceCwd();
      auditRelease.resolve();
    }
    const saved = await record;
    if (scenario === "unchanged") {
      expect(saved).toEqual({ ok: true });
      await invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
      expect((await original)[0]?.is_error).toBeFalsy();
      expect((await run("later-terminal-command", "printf later"))[0]?.is_error).toBeFalsy();
      expect(write.mock.calls).toEqual([["printf ready"], ["printf later"]]);
      expect(f.cards(f.windowA)).toEqual([card]);
      return;
    }
    expect.soft(saved).toEqual({ ok: false, error: "project-scope-changed" });
    if (scenario === "before save") {
      expect.soft(audit.mock.calls.some(([entry]) => entry.output?.startsWith("[approval:remembered]"))).toBe(false);
    }
    expect.soft(f.windowA.webContents.send).toHaveBeenCalledWith(IPC_APPROVAL_SETTLED, { requestId: card.id });
    expect.soft(f.gate.getRequestSnapshot(card.id)).toBeNull();
    // An authenticated late answer cannot revive the settled card.
    await invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    const [result] = await original;
    expect.soft(result?.is_error).toBe(true);
    expect.soft(result?.content).toContain("project-scope-changed");
    expect.soft(write).not.toHaveBeenCalled();

    const nextCard = deferred<ApprovalRequest>();
    f.windowA.webContents.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel === IPC_APPROVAL_REQUEST) nextCard.resolve(request);
    });
    const later = run("later-terminal-command", "printf later");
    const fresh = await Promise.race([nextCard.promise, later.then(() => { throw new Error("Terminal command settled without a fresh card"); })]);
    expect(fresh.shellRule).toMatchObject({ floorSessionOnly: true, sessionAllowed: true });
    expect(fresh.id).not.toBe(card.id);
    await invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), { ...allowOnceCardAnswer(fresh), choice: "deny-once" });
    expect((await later)[0]?.is_error).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["project allow", "project allow with raw Windows cwd", "user deny", "user deny with allow answer", "user deny-always"] as const)("applies a card's saved %s to its pending host request", async (scenario) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const project = resources.makeTmpDir("ave-host-rule-project-");
    if (process.platform === "win32") {
      setShellSandboxRequestedAtBoot(true);
      setActiveSandboxCapability(windowsProxyOnlyCapability());
      const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: false,
        mxc: { state: "available" }, windowsBuild: "10.0.26300.9711", srtWinReady: false });
      setWindowsSandboxSubstrate(substrate, mxcShellCapability());
      expect(getHostShellExecutionPlan()).toMatchObject({ sandboxed: true, substrate: "mxc" });
    }
    mkdirSync(join(project, ".git"), { recursive: true });
    const executionCwd = scenario === "project allow with raw Windows cwd" && process.platform === "win32"
      ? project[0].toLowerCase() + project.slice(1).replace(/\\/g, "/") : project;
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute").mockImplementation(async (input, ctx) => {
      const parsed = parseHostShellExecutionInput(input)!;
      const authority = consumeHostShellExecutionPermitForSpawn({
        permit: ctx.hostShellExecutionPermit, plan: ctx.hostShellExecutionPlan!, toolName: "bash",
        toolUseId: ctx.metadata.toolUseId as string, command: parsed.command, requestedCwd: parsed.cwd,
        executionCwd: ctx.cwd, resolvedCwd: resolveHostShellWorkingDirectory(ctx.cwd, parsed.cwd),
        timeoutSeconds: parsed.timeoutSeconds, executionMode: parsed.executionMode, justification: parsed.justification,
        runInBackground: parsed.runInBackground, allowedDirectories: canonicalizeHostShellAllowedDirectories(ctx.extraAllowedDirectories),
      });
      expect(authority).toBeDefined();
      return { output: "approved", isError: false };
    });
    f.registry.register(bash);
    const running = f.executeAll([{ id: "saved-rule-host", name: "bash",
      input: { command: "echo sbon-c2", executionMode: "host", justification: "Verify saved rule" } }], {
      sessionId: SESSION_ID, executionCwd,
      permissionContext: userPermissionContext({ additionalDirectories: [project] }),
    });
    const card = await f.waitForCard();
    const action = scenario.startsWith("project allow") ? "allow" : "deny";
    expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: card.id, args: JSON.stringify(card.args), decision: action, scope: "persistent",
      verdictAtApproval: f.gate.getRequestSnapshot(card.id)?.verdictAtApproval,
      rule: { action, scope: action === "allow" ? "project" : "always", pattern: "Bash(echo *)" },
      intent: { inputOrigin: "user-keyboard", userActivation: true },
    })).toMatchObject({ ok: true });
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), { ...allowOnceCardAnswer(card), choice: scenario === "user deny-always" ? "deny-always" : scenario === "user deny" ? "deny-once" : "allow-once" });
    const [result] = await running;
    expect(result.content).not.toContain("Permission policy changed");
    if (action === "allow") {
      expect(result.is_error, JSON.stringify(result)).toBeUndefined();
      expect(result.content).toBe("approved");
      expect(execute).toHaveBeenCalledOnce();
    } else {
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Bash(echo *)");
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("requires a durable audit row before persisting a card rule (audit closed: %s)", async (closed) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request } = f.queueCard({ toolName: "bash", toolCategory: "shell", args: { command: "printf ready" } });
    await f.waitForCard();
    const before = f.manager.getPolicyEpoch();
    if (closed) await f.audit.close();
    const response = await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: request.id, args: JSON.stringify(request.args), decision: "allow", scope: "persistent", verdictAtApproval: "low",
      rule: { action: "allow", scope: "always" }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    });
    const file = join(f.root, "permissions.json");
    if (closed) {
      expect(response).toMatchObject({ ok: false, error: "rule-save-failed" });
      expect(f.manager.getPolicyEpoch()).toBe(before);
      expect(existsSync(file)).toBe(false);
    } else {
      expect(response).toEqual({ ok: true });
      expect(readFileSync(file, "utf8")).toContain("Bash(printf ready)");
    }
    await f.audit.flush();
    const rows = (await f.audit.search({ limit: 100 })).entries.filter((row) => row.output?.startsWith("[approval:remembered] store=rules"));
    expect(rows).toHaveLength(closed ? 0 : 1);
  });

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

  it("refuses This project when an ordinary Bash card's directory was replaced", async () => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    setShellSandboxRequestedAtBoot(false);
    const project = join(f.root, "project");
    const original = join(f.root, "original");
    mkdirSync(project);
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute").mockResolvedValue({ output: "mock launch", isError: false });
    f.registry.register(bash);
    const running = f.executeAll([{ id: "project-rule-cwd", name: "bash", input: { command: "printf ready" } }], {
      sessionId: SESSION_ID, executionCwd: project,
      permissionContext: userPermissionContext({ additionalDirectories: [project] }),
    });
    const card = await f.waitForCard();
    expect(card.allowedChoices).toBeUndefined();
    expect(card.shellRule?.persistentAllowed).toBe(true);
    const issued = captureShellWorkingDirectoryIdentity(project);
    expect(issued).toBeDefined();
    renameSync(project, original);
    mkdirSync(project);
    const replacement = projectRulesLocation(f.root, project);
    expect(captureShellWorkingDirectoryIdentity(project)?.ino).not.toBe(issued?.ino);

    const response = await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
      requestId: card.id, args: JSON.stringify(card.args), decision: "allow", scope: "persistent",
      verdictAtApproval: f.gate.getRequestSnapshot(card.id)?.verdictAtApproval,
      rule: { action: "allow", scope: "project" }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    });
    expect.soft(response).toMatchObject({ ok: false });
    expect.soft(existsSync(replacement.filePath)).toBe(false);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
    expect((await running)[0]?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["project", "moves its marker before saving"],
    ["project", "moves its marker while saving"],
    ["project", "loses its marker without changing its root path"],
    ["project", "is replaced at the same path"],
    ["project", "is replaced with a fresh working directory below it"],
    ["project", "is replaced as the working directory"],
    ["project", "keeps its root but replaces the working directory before saving"],
    ["project", "keeps its root but replaces the working directory while saving"],
    ["session", "keeps its root but replaces the working directory before saving"],
    ["session", "keeps its root but replaces the working directory while saving"],
    ["always", "keeps its root but replaces the working directory before saving"],
    ["always", "keeps its root but replaces the working directory while saving"],
  ] as const)("refuses the %s choice when the issued repository %s", async (scope, scenario) => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    setShellSandboxRequestedAtBoot(false);
    const outer = join(f.root, "outer");
    const inner = join(outer, "inner");
    const sameRootWithoutMarker = scenario === "loses its marker without changing its root path";
    const replacesOnlyCwd = scenario === "keeps its root but replaces the working directory before saving" ||
      scenario === "keeps its root but replaces the working directory while saving";
    const duringSave = scenario === "moves its marker while saving" || scenario === "keeps its root but replaces the working directory while saving";
    const replacesCwd = replacesOnlyCwd || scenario === "is replaced with a fresh working directory below it" || scenario === "is replaced as the working directory";
    const cwd = sameRootWithoutMarker || scenario === "is replaced as the working directory" ? inner : join(inner, "work");
    mkdirSync(cwd, { recursive: true });
    for (const root of sameRootWithoutMarker ? [inner] : [outer, inner]) {
      const marker = join(root, ".git");
      mkdirSync(join(marker, "objects"), { recursive: true });
      mkdirSync(join(marker, "refs"));
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    }
    const userStore = join(f.root, "permissions.json");
    const innerStore = projectRulesLocation(f.root, cwd);
    const outerStore = projectRulesLocation(f.root, outer);
    const issuedCwd = captureShellWorkingDirectoryIdentity(cwd);
    expect(issuedCwd).toBeDefined();
    expect(innerStore.filePath).not.toBe(outerStore.filePath);

    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute").mockResolvedValue({ output: "mock launch", isError: false });
    f.registry.register(bash);
    const invokeShell = (id: string) => f.executeAll([{ id, name: "bash", input: { command: "printf ready" } }], {
      sessionId: SESSION_ID, executionCwd: cwd,
      permissionContext: userPermissionContext({ additionalDirectories: [cwd] }),
    });
    const running = invokeShell("nested-project-rule");
    const card = await f.waitForCard();
    expect(card.shellRule).toMatchObject({ exactRule: "Bash(printf ready)", sessionAllowed: true, persistentAllowed: true, projectRoot: innerStore.projectRoot });
    const snapshot = f.gate.getRequestSnapshot(card.id);
    const replaced = replacesCwd || scenario === "is replaced at the same path";
    const currentStore = replaced || sameRootWithoutMarker ? innerStore : outerStore;
    const moveMarker = () => {
      renameSync(join(inner, ".git"), join(inner, "former-marker"));
      expect(captureShellWorkingDirectoryIdentity(cwd)).toEqual(issuedCwd);
      expect(projectRulesLocation(f.root, cwd)).toEqual(currentStore);
    };
    const replaceOnlyCwd = () => {
      renameSync(cwd, join(inner, "former-work"));
      mkdirSync(cwd);
      expect(captureShellWorkingDirectoryIdentity(cwd)?.ino).not.toBe(issuedCwd?.ino);
      const projectRoot = snapshot?.shellRuleProjectRoot;
      expect(projectRoot && matchesProjectRuleRootBinding(cwd, projectRoot)).toBe(true);
      expect(f.gate.capturePendingRequestAuthority(card.id)?.isWorkingDirectoryCurrent()).toBe(false);
    };
    const changeScope = replacesOnlyCwd ? replaceOnlyCwd : moveMarker;
    if (replaced && !replacesOnlyCwd) {
      const former = join(outer, "former-inner");
      renameSync(inner, former);
      mkdirSync(inner);
      renameSync(join(former, ".git"), join(inner, ".git"));
      if (replacesCwd) {
        if (cwd !== inner) mkdirSync(cwd);
        expect(captureShellWorkingDirectoryIdentity(cwd)?.ino).not.toBe(issuedCwd?.ino);
      } else {
        renameSync(join(former, "work"), cwd);
        expect(captureShellWorkingDirectoryIdentity(cwd)).toEqual(issuedCwd);
      }
      expect(projectRulesLocation(f.root, cwd)).toEqual(innerStore);
    } else if (!duringSave) {
      changeScope();
    } else if (scope === "session") {
      const append = f.audit.append.bind(f.audit);
      vi.spyOn(f.audit, "append").mockImplementationOnce(async (...args) => {
        await append(...args);
        changeScope();
      });
    } else {
      const read = homeTrust.readAveHomeInput;
      const saveFile = scope === "always" ? userStore : innerStore.filePath;
      const spy = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async (...args) => {
        const input = await read(...args);
        if (args[0] === saveFile) {
          spy.mockRestore();
          expect.soft(existsSync(saveFile)).toBe(false);
          changeScope();
        }
        return input;
      });
    }

    const record = {
      requestId: card.id, args: JSON.stringify(card.args), decision: "allow", scope: scope === "session" ? "session" : "persistent",
      verdictAtApproval: snapshot?.verdictAtApproval,
      rule: { action: "allow", scope }, intent: { inputOrigin: "user-keyboard", userActivation: true },
    };
    if (replacesCwd) {
      expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowB), record)).toEqual(UNAUTHORIZED_FRAME);
      expect(f.gate.getRequestSnapshot(card.id)).not.toBeNull();
    }
    const response = await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), record);
    expect.soft(response).toMatchObject({ ok: false, error: "project-scope-changed" });
    expect.soft(existsSync(innerStore.filePath)).toBe(false);
    expect.soft(existsSync(outerStore.filePath)).toBe(false);
    expect.soft(existsSync(userStore)).toBe(false);
    expect.soft(f.manager.listSessionRules(SESSION_ID)).toEqual([]);
    expect(projectRulesLocation(f.root, cwd)).toEqual(currentStore);
    expect.soft(f.windowA.webContents.send).toHaveBeenCalledWith(IPC_APPROVAL_SETTLED, { requestId: card.id });
    expect(f.gate.getRequestSnapshot(card.id)).toBeNull();
    expect((await running)[0]?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const nextCard = deferred<ApprovalRequest>();
    f.windowA.webContents.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel === IPC_APPROVAL_REQUEST) nextCard.resolve(request);
    });
    const retried = invokeShell("fresh-project-rule");
    const fresh = await Promise.race([
      nextCard.promise,
      retried.then(() => { throw new Error("Shell retry settled without a fresh card"); }),
    ]);
    expect(fresh.id).not.toBe(card.id);
    expect(fresh.shellRule?.projectRoot).toBe(currentStore.projectRoot);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), { ...allowOnceCardAnswer(fresh), choice: "deny-once" });
    expect((await retried)[0]?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
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
    const { promise: held, resolve: release } = f.hold();
    const entered = deferred<void>();
    const add = f.manager.addRulePersist.bind(f.manager);
    vi.spyOn(f.manager, "addRulePersist").mockImplementationOnce(async (...args) => { entered.resolve(); await held; await add(...args); });
    const saving = save();
    try {
      await entered.promise;
      if (scenario === "parallel saves") {
        expect(await save()).toMatchObject({ ok: true });
        release();
        expect(await saving).toMatchObject({ ok: true });
        invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
      } else {
        invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
        release();
        expect(await saving).toMatchObject({ ok: false });
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
    const allowed = scenario === "one save" || scenario === "sequential saves" || scenario === "deny save";
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
    const running = f.executeAll([{
      id: "prefix-host-action", name: "bash",
      input: { command: "printf prefix-proof", executionMode: "host", justification: "Print one local value", timeoutSeconds: 1 },
    }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
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

  it("reports a durable exact approval refused by a refused home folder and records nothing", async () => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const { request } = f.queueCard();
    const card = await f.waitForCard();
    setAveHomeConfigurationRefusedAtBoot(f.root);
    try {
      expect(await invoke(PERMISSIONS.userApprovalRecord, frameEvent(f.windowA), {
        requestId: request.id, args: JSON.stringify(request.args), scope: "persistent", verdictAtApproval: "low",
        intent: { inputOrigin: "user-keyboard", userActivation: true }, nlJustification: null,
      })).toEqual({ ok: false, error: HOME_FOLDER_REFUSED, message: expect.stringMatching(/Fix the folder permissions first/) });
      expect(await approvals.listApprovals()).toEqual([]);
    } finally {
      _resetAveHomePrivacyForTest();
    }
    expect(existsSync(approvals.userApprovalFilePath())).toBe(false);
    invoke(PERMISSIONS.approvalRespond, frameEvent(f.windowA), allowOnceCardAnswer(card));
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
      try {
        await held.reached;
        await f.pause();
      } finally {
        held.release();
      }
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
    expect(await invoke(PERMISSIONS.approvalRespond, event, allowOnceCardAnswer(card))).toEqual(UNAUTHORIZED_FRAME);
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

  it("audits a host denial before closing the fixture with a card still being prepared", async () => {
    const f = await subject("default");
    vi.stubEnv("AVE_HOME", f.root);
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute").mockResolvedValue({ output: "unexpected execution", isError: false });
    f.registry.register(bash);
    const askReached = deferred<void>();
    const releaseAsk = f.hold();
    const appendEntry = f.audit.appendPermissionAuditEntry.bind(f.audit);
    const append = vi.spyOn(f.audit, "appendPermissionAuditEntry").mockImplementationOnce(async (entry) => {
      askReached.resolve();
      await releaseAsk.promise;
      return appendEntry(entry);
    });
    const running = f.executeAll([{
      id: "host-approval-during-cleanup", name: "bash",
      input: { command: "printf approval", executionMode: "host", justification: "Check approval cleanup" },
    }], {
      sessionId: SESSION_ID, executionCwd: f.root,
      permissionContext: userPermissionContext({ additionalDirectories: [f.root] }),
    });
    let closing: Promise<void>;
    try {
      await askReached.promise;
      closing = closeFixtures();
    } finally {
      releaseAsk.resolve();
    }
    await closing;

    expect(await running).toMatchObject([{ is_error: true }]);
    expect(f.cards(f.windowA)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(await Promise.all(append.mock.results.map(({ value }) => value))).toEqual([
      expect.objectContaining({ decision: "ask", tool: "bash" }),
      expect.objectContaining({ decision: "deny", tool: "bash" }),
    ]);
  });
});
import { requestBoundShellCard } from "../../../__tests__/support/host-shell-approval.js";
