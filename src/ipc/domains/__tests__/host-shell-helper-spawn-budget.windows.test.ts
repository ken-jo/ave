import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { allowOnceCardAnswer } from "../../../__tests__/support/approval-card-answer.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { takeWindowsHelperLaunches } from "../../../__tests__/support/windows-helper-spawns.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../../boot/steps/windows-sandbox-plan.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { configureHostResources } from "../../../main/host-resources.js";
import { windowsPathKindHelperIn } from "../../../main/windows-path-kind-launcher.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { ApprovalGate, type ApprovalRequest, IPC_APPROVAL_REQUEST } from "../../../permissions/approval-gate.js";
import { consumeHostShellExecutionPermitForSpawn, canonicalizeHostShellAllowedDirectories, resolveHostShellWorkingDirectory } from "../../../permissions/host-shell-execution-permit.js";
import { parseHostShellExecutionInput } from "../../../permissions/host-shell-execution-plan.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../../permissions/judge/judge-settings.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { LlmRiskClassifier, type LlmReviewerProvider } from "../../../permissions/reviewer/risk-classifier.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest, setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../../permissions/sandbox-capability.js";
import * as approvals from "../../../permissions/user-approval-store.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { pinWindowsPaths } from "../../../shared/windows-path-facts.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { BashTool, PowerShellTool } from "../../../tools/shell-tools.js";
import { userPermissionContext } from "../../../tools/__tests__/tool-context-fixture.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("../../../__tests__/support/windows-helper-spawns.js")).countingChildProcess(await importOriginal()));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) },
  session: { defaultSession: { resolveProxy: vi.fn(async () => "DIRECT") } },
}));

const resourcePath = fileURLToPath(new URL("../../../../resources/", import.meta.url));
const helperPresent = process.platform === "win32" && existsSync(windowsPathKindHelperIn(resourcePath));
const SESSION_ID = "spawn-budget-session";
const resources = new PermissionTestResources();
const cleanup: Array<() => Promise<void>> = [];

// Ratchet: these are the counts measured on main cde88405d. Lower them when a change removes launches; never raise them.
const HOST_SHELL_ADMISSION_LAUNCHES = {
  bash: { card: {}, approved: {} },
  powershell: { card: {}, approved: {} },
} as const;

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetWindowsSandboxSubstrateForTest();
  vi.restoreAllMocks();
  approvals.__resetSessionStoreForTest();
  vi.unstubAllEnvs();
  handlers.clear();
  await resources.cleanup();
});

async function subject() {
  const root = resources.makeTmpDir("ave-spawn-budget-");
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const contents = { id: 101, mainFrame: { url: "file:///application/index.html" }, isDestroyed: vi.fn(() => false), send: vi.fn() };
  const window = { isDestroyed: vi.fn(() => false), webContents: contents };
  const firstCard = deferred<ApprovalRequest>();
  contents.send.mockImplementation((channel: string, card: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) firstCard.resolve(card);
  });
  const gate = new ApprovalGate((sessionId) => sessionId === SESSION_ID ? contents as unknown as WebContents : null, undefined, undefined, audit);
  const complete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level: "low", reason: "reviewed action" }), tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
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
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, new ScriptHookManager(), audit);
  cleanup.push(async () => {
    gate.disposeAll();
    await audit.close();
  });
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers({
    conversationLoop: { permissionManager: manager }, approvalGate: gate, auditLogger: audit,
    toolRegistry: registry, getMainWindow: () => window, getAppWindows: () => [window],
  } as never);
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  return { root, executor, registry, event, card: firstCard.promise };
}

// The native helper only runs on Windows; elsewhere these launches do not exist.
describe.skipIf(!helperPresent)("host shell admission native helper launch budget", () => {
  beforeAll(() => configureHostResources({ resourcePath, isPackaged: false }));

  it("counts a synchronous pin as one helper launch", () => {
    takeWindowsHelperLaunches();
    expect(pinWindowsPaths([resourcePath])).toHaveLength(1);
    expect(takeWindowsHelperLaunches()).toEqual({ "--pin": 1 });
  });

  it.each(["bash", "powershell"] as const)("admits an approved host %s git status within its launch budget", async (toolName) => {
    const f = await subject();
    vi.stubEnv("AVE_HOME", f.root);
    const project = resources.makeTmpDir("ave-spawn-budget-project-");
    mkdirSync(join(project, ".git"), { recursive: true });
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability(windowsProxyOnlyCapability());
    const { substrate } = planWindowsSandbox({ shellRequested: true, shellLocalNetworkAccess: true, workerRequested: false,
      mxc: { state: "available" }, windowsBuild: "10.0.26300.9711", srtWinReady: false });
    setWindowsSandboxSubstrate(substrate, mxcShellCapability());
    const tool = toolName === "bash" ? new BashTool() : new PowerShellTool();
    // Admission ends at the permit check before the shell would start.
    const execute = vi.spyOn(tool, "execute").mockImplementation(async (input, ctx) => {
      const parsed = parseHostShellExecutionInput(input);
      const plan = ctx.hostShellExecutionPlan;
      if (!parsed || !plan) throw new Error("host shell admission reached the tool without a plan");
      const authority = consumeHostShellExecutionPermitForSpawn({
        permit: ctx.hostShellExecutionPermit, plan, toolName,
        toolUseId: ctx.metadata.toolUseId as string, command: parsed.command, requestedCwd: parsed.cwd,
        executionCwd: ctx.cwd, resolvedCwd: resolveHostShellWorkingDirectory(ctx.cwd, parsed.cwd),
        timeoutSeconds: parsed.timeoutSeconds, executionMode: parsed.executionMode, justification: parsed.justification,
        runInBackground: parsed.runInBackground, allowedDirectories: canonicalizeHostShellAllowedDirectories(ctx.extraAllowedDirectories),
      });
      expect(authority).toBeDefined();
      return { output: "admitted", isError: false };
    });
    f.registry.register(tool);
    takeWindowsHelperLaunches();
    const running = f.executor.executeAll([{ id: `${toolName}-budget`, name: toolName,
      input: { command: "git status", executionMode: "host", justification: "Show the working tree state" } }], {
      sessionId: SESSION_ID, executionCwd: project,
      permissionContext: userPermissionContext({ additionalDirectories: [project] }),
    });
    const card = await Promise.race([f.card, running.then(([result]) => { throw new Error(`settled before the card: ${JSON.stringify(result)}`); })]);
    const beforeCard = takeWindowsHelperLaunches();
    const respond = handlers.get(PERMISSIONS.approvalRespond);
    if (!respond) throw new Error("approval responder is not registered");
    await respond(f.event, allowOnceCardAnswer(card));
    const [result] = await running;
    const afterApproval = takeWindowsHelperLaunches();
    expect(result.is_error, JSON.stringify(result)).toBeUndefined();
    expect(result.content).toBe("admitted");
    expect(execute).toHaveBeenCalledOnce();
    expect({ card: beforeCard, approved: afterApproval }, JSON.stringify({ card: beforeCard, approved: afterApproval }))
      .toEqual(HOST_SHELL_ADMISSION_LAUNCHES[toolName]);
  });
});
