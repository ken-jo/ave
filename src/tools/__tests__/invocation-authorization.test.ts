import { UnavailableRiskClassifier, RuleBasedRiskClassifier, _internal } from "../../permissions/reviewer/risk-classifier.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { listApprovals, __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
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
import { endUnattendedStage, onUnattendedDenied, registerUnattendedStage } from "../../permissions/unattended-lane-registry.js";
import * as shellFilesystemPath from "../../shared/shell-filesystem-path.js";
import { withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import { createToolEffectResolver } from "../../permissions/tool-effect-evidence.js";
import * as sensitivePaths from "../../permissions/sensitive-paths.js";
import * as targetSeal from "../../permissions/target-seal.js";
import { ReadFileTool, WriteFileTool } from "../file-tools.js";
import { BashTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";

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

// Windows path admission pins through the shipped path-kind helper; boot configures its resources first.
beforeAll(() => configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }));

describe("host shell invocation authorization", () => {
  it.each(["remove allow", "add deny"])("requires normal authorization again after %s invalidates a decision", async (change) => {
    const manager = new PermissionManager(join(directory, "permissions.json"));
    // An exact allow rule authorizes this host run in the ordinary mode.
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
    expect(check.mock.results[0]?.value).toMatchObject({ decision: "allow", });
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
      // Ordinary shell approval retains reusable rule choices.
      expect(cards[0]?.allowedChoices).toBeUndefined();
      expect(cards[0]).toMatchObject({ requireExplicit: true });
    } else {
      expect(check.mock.results[1]?.value).toMatchObject({ decision: "deny", });
      expect(cards).toHaveLength(0);
    }
  });
});

describe("confined shell reviewer invocation", () => {
  it.each(['node -e "process.stdout.write(process.version)"', 'printf "%s" "$(workspace_tool)"'])("reuses scoped review evidence and rechecks changed input: %s", async (command) => {
    vi.stubEnv("AVE_HOME", directory);
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "confined shell", confines: { filesystem: true, process: true, network: true } });
    const classify = vi.fn((_context: import("../../permissions/reviewer/risk-classifier.js").ToolInvocationContext): { level: "low" | "medium" | "high"; reason: string } => ({ level: "medium", reason: "reviewed command" }));
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("auto");
    setReviewerForTest(manager, { classifier: { classify },
      cache: reviewResources.makeVerdictCache(join(directory, "reviewer-cache.jsonl")),
      recentlyDenied: makeRecentlyDeniedStore(join(directory, "deferred.jsonl")) });

    const check = vi.spyOn(manager, "checkDetailed");
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "reviewed", isError: false });
    const registry = new ToolRegistry(); registry.register(tool);
    const requestAndWait = answeringRequestAndWait(async (_request: unknown) => ({ choice: "deny-once", approved: false }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never);
    const sessionId = "confined-shell-review";
    const input = { command };
    for (let index = 0; index < 2; index += 1) {
      const [result] = await runWithToolExecutionCwd(directory, () => executor.executeAll([
        { id: `shell-review-${index}`, name: "bash", input },
      ], { sessionId, permissionContext: userPermissionContext({ userIntent: "Review this workspace command" }) }));
      expect(result?.is_error, result?.content).not.toBe(true);
      const reviewed = classify.mock.calls[0]?.[0];
      expect(reviewed?.permissionReason).toBe(check.mock.results[index]?.value.reason);
      expect(_internal.buildUserPrompt(reviewed!)).toContain(reviewed!.permissionReason!);
    }
    expect(classify).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(await manager.listPersistedRules()).toEqual([]);
    expect(await listApprovals()).toEqual([]);
    classify.mockReturnValue({ level: "high", reason: "needs a person" });
    const [blocked] = await runWithToolExecutionCwd(directory, () => executor.executeAll([
      { id: "shell-review-high", name: "bash", input: { command: `${command}; printf changed` } },
    ], { sessionId, permissionContext: userPermissionContext({ userIntent: "Review this workspace command" }) }));
    expect(blocked?.is_error).toBe(true);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(requestAndWait.mock.calls[0]?.[0]).not.toMatchObject({ durableApprovalRecordAllowed: false });
  });
});

describe("shell review requires a risk judgment", () => {
  it.each([
    { command: "rm -rf ./build", disabled: true, allowed: false },
    { command: "workspace_tool inspect", disabled: false, allowed: true },
    { command: "echo ok; git reset --hard", disabled: false, allowed: false },
    { command: "env git reset --hard", disabled: false, allowed: false },
    { command: "echo ok && git push --force", disabled: false, allowed: false },
  ])("routes $command with disabled=$disabled and allowed=$allowed", async ({ command, disabled, allowed }) => {
    vi.stubEnv("AVE_HOME", directory);
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "confined shell", confines: { filesystem: true, process: true, network: true } });
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("auto");
    const classifier = disabled ? new UnavailableRiskClassifier() : new RuleBasedRiskClassifier();
    const classify = vi.spyOn(classifier, "classify");
    setReviewerForTest(manager, { classifier,
      cache: reviewResources.makeVerdictCache(join(directory, "judgment-cache.jsonl")),
      recentlyDenied: makeRecentlyDeniedStore(join(directory, "judgment-queue.jsonl")) });
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "executed", isError: false });
    const registry = new ToolRegistry(); registry.register(tool);
    const requestAndWait = answeringRequestAndWait(async (_request: unknown) => ({ choice: "deny-once", approved: false }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never);
    const [result] = await runWithToolExecutionCwd(directory, () => executor.executeAll([
      { id: "judgment-required", name: "bash", input: { command } },
    ], { sessionId: "judgment-required", permissionContext: userPermissionContext({ userIntent: "Review this workspace command" }) }));
    if (allowed) {
      expect(classify).toHaveBeenCalledOnce();
      expect(classify.mock.results[0]?.value).toMatchObject({ level: "medium" });
      expect(result?.is_error).toBeUndefined();
      expect(result?.content).toBe("executed");
      expect(execute).toHaveBeenCalledOnce();
      expect(requestAndWait).not.toHaveBeenCalled();
    } else {
      expect(result?.is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(requestAndWait).toHaveBeenCalledOnce();
    }
  });
});

it("routes the sealed edit-subject check through the unattended lane", async () => {
  vi.stubEnv("AVE_HOME", directory);
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("allow");
  const check = vi.spyOn(manager, "checkDetailed");
  const registry = new ToolRegistry();
  const tool = new WriteFileTool();
  const execute = vi.spyOn(tool, "execute");
  registry.register(tool);
  const executor = new ToolExecutor(registry, undefined, manager);
  const sessionId = "unattended-edit";
  registerUnattendedStage(sessionId, {
    runKey: "run", stageId: "stage", workspaceRoot: directory, isolation: { proven: false },
    envelope: {
      tools: [tool.name], readRoots: [], writePaths: ["**"], commands: [], network: [],
      mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
      outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
    },
  });
  try {
    await runWithToolExecutionCwd(directory, () => executor.executeAll([
      { id: "lane-edit", name: tool.name, input: { path: "report.txt", content: "report" } },
    ], { sessionId, permissionContext: userPermissionContext() }));
    const editCheck = check.mock.calls.findIndex(call => call[4]?.ruleSubject?.kind === "edit");
    expect(editCheck).toBeGreaterThanOrEqual(0);
    expect(check.mock.calls[editCheck][4]?.sessionId).toBe(sessionId);
    expect(check.mock.results[editCheck]?.value).toMatchObject({
      decision: "deny", reasonCode: "forbidden-unattended", pipelineRequest: { unattended: { stageId: "stage" } },
    });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    endUnattendedStage(sessionId);
  }
});

it.each([
  { path: "report.txt", allowed: true },
  { path: "draft.txt", allowed: false },
])("reports only terminal denials for a proven stage edit of $path", async ({ path, allowed }) => {
  vi.stubEnv("AVE_HOME", join(directory, "state"));
  const manager = new PermissionManager(join(directory, "permissions.json"));
  const check = vi.spyOn(manager, "checkDetailed");
  const registry = new ToolRegistry();
  const tool = new WriteFileTool();
  const execute = vi.spyOn(tool, "execute");
  registry.register(tool);
  manager.setUnattendedToolEffectResolver(createToolEffectResolver(registry));
  const executor = new ToolExecutor(registry, undefined, manager);
  const sessionId = "proven-edit";
  registerUnattendedStage(sessionId, {
    runKey: "run", stageId: "stage", workspaceRoot: directory, isolation: { proven: true },
    envelope: {
      tools: [tool.name], readRoots: [], writePaths: ["report.txt"], commands: [], network: [],
      mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
      outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
    },
  });
  const onDenied = vi.fn();
  const unsubscribe = onUnattendedDenied(onDenied);
  try {
    const [result] = await withCodeCheckpoint({ sessionId, messageId: "edit" }, () =>
      runWithToolExecutionCwd(directory, () => executor.executeAll([
        { id: "proven-edit", name: tool.name, input: { path, content: "report" } },
      ], { sessionId, permissionContext: userPermissionContext() })));
    expect(result?.is_error === true, result?.content).toBe(!allowed);
    expect(execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      expect(onDenied).not.toHaveBeenCalled();
    } else {
      expect(onDenied).toHaveBeenCalledExactlyOnceWith({
        sessionId, code: "outside-envelope",
        call: { toolName: tool.name, source: "builtin", inputSummary: expect.stringContaining(path) },
      });
    }
    const editCheck = check.mock.calls.findIndex(call => call[4]?.ruleSubject?.kind === "edit");
    expect(check.mock.results[editCheck]?.value).toMatchObject({
      decision: allowed ? "allow" : "deny",
      pipelineRequest: { unattended: { stageId: "stage" }, fileWrite: { checkpointAvailable: true } },
    });
  } finally {
    unsubscribe();
    endUnattendedStage(sessionId);
  }
});

it.each([
  ["write", "proven"], ["write", "unproven"], ["write", "interim"],
  ["read", "proven"], ["read", "unproven"], ["read", "interim"],
] as const)("reports an unresolved %s only for a linked stage with proven isolation (%s)", async (effect, state) => {
  const manager = new PermissionManager(join(directory, "permissions.json"));
  const registry = new ToolRegistry();
  const tool = effect === "write" ? new WriteFileTool() : new ReadFileTool();
  const execute = vi.spyOn(tool, "execute");
  registry.register(tool);
  const executor = new ToolExecutor(registry, undefined, manager);
  const sessionId = "unresolved-target";
  if (state !== "interim") registerUnattendedStage(sessionId, {
    runKey: "run", stageId: "stage", workspaceRoot: directory, isolation: { proven: state === "proven" },
    envelope: {
      tools: [tool.name], readRoots: [], writePaths: ["**"], commands: [], network: [],
      mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
      outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
    },
  });
  const onDenied = vi.fn();
  const unsubscribe = onUnattendedDenied(onDenied);
  const resolveTarget = effect === "write"
    ? vi.spyOn(shellFilesystemPath, "resolveShellFilesystemPath")
    : process.platform === "win32"
      ? vi.spyOn(targetSeal, "observeWindowsTarget")
      : vi.spyOn(sensitivePaths, "resolvePathForPolicy");
  resolveTarget.mockImplementationOnce(() => { throw new Error("Target identity unavailable"); });
  try {
    const [result] = await runWithToolExecutionCwd(directory, () => executor.executeAll([
      { id: "unresolved", name: tool.name, input: { path: "report.txt", ...(effect === "write" ? { content: "report" } : {}) } },
    ], { sessionId, permissionContext: userPermissionContext() }));
    expect(result?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    if (state === "proven") {
      expect(onDenied).toHaveBeenCalledExactlyOnceWith({
        sessionId, code: "outside-envelope", call: { toolName: tool.name, source: "builtin", inputSummary: expect.stringContaining("report.txt") },
      });
    } else {
      expect(onDenied).not.toHaveBeenCalled();
    }
  } finally {
    resolveTarget.mockRestore();
    unsubscribe();
    endUnattendedStage(sessionId);
  }
});
