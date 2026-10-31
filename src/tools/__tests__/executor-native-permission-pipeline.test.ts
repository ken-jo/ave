import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";
useConfigurationOwner();
import { HookRunner } from "../../hooks/hook-runner.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { addAllowedDirectoryPersist } from "../../permissions/permission-settings-store.js";
import { LlmRationaleScopeReviewer } from "../../permissions/reviewer/rationale-scope-reviewer.js";
import { RationaleHostCoordinator } from "../pipeline/rationale-host-coordinator.js";
import { InProcessRationaleTicketStore } from "../pipeline/rationale-ticket-store.js";
import { InMemoryHostAnchorRoundCasStore } from "../pipeline/rationale-control.js";
import { InMemoryHostInvocationStartCasStore } from "../pipeline/rationale-ticket-lifecycle.js";
import { captureRationalePolicySnapshot } from "../pipeline/rationale-policy-epoch.js";
import { createRationaleHostRuntime } from "../../__tests__/support/rationale-host-runtime.js";
import { createTestRequestAnchor } from "../pipeline/__tests__/rationale-fixtures.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import { withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { getHostShellExecutionPlanAuditProjection } from "../../permissions/host-shell-execution-plan.js";
import { getHostShellExecutionPlan, setShellSandboxRequestedAtBoot, setActiveSandboxCapability, __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest } from "../../permissions/sandbox-capability.js";
import { caseFoldForMatch, foldCanonicalPathSeparators } from "../../permissions/sensitive-paths.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { approvalCacheKeyIdentity, captureApprovalWorkingDirectory, recordApproval, __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { modelShellPath } from "../../shared/shell-native-path.js";
import { ToolExecutor } from "../executor.js";
import { ApplyPatchTool, CopyPathTool, ExtractArchiveTool, ReadFileTool, WriteFileTool } from "../file-tools.js";
import { BashTool } from "../shell-tools.js";
import { preparedShellFacts } from "../prepared-shell-invocation.js";
import { approvalIdentityFor } from "../pipeline/display-mask.js";
import { ToolRegistry } from "../registry.js";

// win32 yields separator-folded canonicals ("c:/users/..."); compare against the same fold, never the raw backslash spelling.
const directoryIdentity = (path: string | undefined): string | undefined =>
  path === undefined ? undefined : canonicalForMatch(modelShellPath(path, { dialect: "bash" }).nativePath ?? path);
const canonicalForMatch = (path: string): string => foldCanonicalPathSeparators(caseFoldForMatch(path));

const resources = new PermissionTestResources();
let root: string;
let project: string;
let sessionId: string;
let audit: AuditLogger;
let manager: PermissionManager;
let registry: ToolRegistry;
let requests: ApprovalRequestInput[];
let readTool: ReadFileTool;
let writeTool: WriteFileTool;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-native-permission-")));
  project = join(root, "project");
  await mkdir(project);
  vi.stubEnv("AVE_HOME", join(root, "state"));
  sessionId = randomUUID();
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  audit = new AuditLogger(join(root, "audit"));
  manager = new PermissionManager(join(root, "permissions.json"));
  registry = new ToolRegistry();
  readTool = new ReadFileTool();
  writeTool = new WriteFileTool();
  for (const tool of [readTool, writeTool, new ApplyPatchTool()]) registry.register(tool);
  requests = [];
});
afterEach(async () => {
  await resources.cleanup();
  await audit.close();
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function executor(hooks?: ScriptHookManager, choice: "allow-once" | "deny-once" = "deny-once") {
  const gate = { requestAndWait: async (request: ApprovalRequestInput) => {
    requests.push(request);
    return { requestId: request.id, choice };
  } };
  return new ToolExecutor(registry, undefined, manager, undefined, gate as never, hooks, audit);
}
function run(executor: ToolExecutor, name: string, input: Record<string, unknown>, options: { onDirectoryGrant?: (directory: string) => void; additionalDirectories?: string[]; headless?: boolean; executionCwd?: string } = {}) {
  return executor.executeAll([{ id: randomUUID(), name, input }], {
    sessionId, executionCwd: options.executionCwd ?? project,
    permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: options.additionalDirectories ?? [], onTurnDirectoryGrant: options.onDirectoryGrant, headless: options.headless },
  });
}
async function recordShellGrant(tool: BashTool, input: Record<string, unknown>) {
  const plan = getHostShellExecutionPlan(input.executionMode === "host" ? "host" : "default");
  const identity = await approvalIdentityFor(tool, input, project, getHostShellExecutionPlanAuditProjection(plan), sessionId);
  await recordApproval(tool.name, canonicalStringify(input), "builtin", {
    scope: "session", sessionId, verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard",
    workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
    approvalCacheKey: approvalCacheKeyIdentity(identity.approvalCacheKey, identity.approvalMemory),
  });
}
function reviewer() {
  const classify = vi.fn(() => ({ level: "medium" as const, reason: "resource needs review" }));
  setReviewerForTest(manager, {
    classifier: { classify },
    cache: resources.makeVerdictCache(join(root, "review-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(root, "recently-denied.json")),
  });
  return vi.spyOn(manager, "dispatchReviewer");
}

describe("native invocation permission evidence", () => {
  it.each([false, true])("uses the prepared child environment for a deterministic write target, sandboxed=%s", async (sandboxed) => {
    manager.setMode("allow");
    vi.stubEnv("PWD", join(root, "state"));
    if (sandboxed) {
      setShellSandboxRequestedAtBoot(true);
      setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
        reason: "Fixture confinement", confines: { filesystem: true, process: true, network: true } });
    }
    const tool = new BashTool();
    let childEnvironment: Readonly<Record<string, string | undefined>> | undefined;
    const execute = vi.spyOn(tool, "execute").mockImplementation(async (_input, context) => {
      childEnvironment = preparedShellFacts(context!.preparedShellInvocation!).environment;
      return { output: "prepared operation", isError: false };
    });
    registry.register(tool);
    const check = vi.spyOn(manager, "checkDetailed");
    const [result] = await run(executor(), tool.name, { command: 'echo x > "$PWD/out.txt"',
      executionMode: sandboxed ? "default" : "host", justification: "Write the project fixture" });
    expect(result.is_error, result.content).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
    // win32 prepares PWD in shell form (/c/...) while the fixture holds the host form (C:\...): compare one canonical identity.
    expect(directoryIdentity(childEnvironment?.PWD)).toBe(directoryIdentity(project));
    const permissionCall = check.mock.calls.findLast((call) => call[4]?.shellExecution?.environmentSnapshot !== undefined);
    expect(permissionCall?.[4]?.shellExecution?.environmentSnapshot).toBe(childEnvironment);
    expect(check.mock.results.at(-1)?.value.pipelineRequest?.floor).toBeUndefined();
  });

  it("keeps a write through a changed PWD forced", async () => {
    manager.setMode("allow");
    await mkdir(join(project, "sub"));
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "must not execute", isError: false });
    registry.register(tool);
    const check = vi.spyOn(manager, "checkDetailed");
    const [result] = await run(executor(), tool.name, { command: 'cd sub && echo x > "$PWD/out.txt"',
      executionMode: "host", justification: "Write the project fixture" });
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ forceExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
    expect(check.mock.results.at(-1)?.value).toMatchObject({ decision: "ask", reasonCode: "protected-path", forceModal: true,
      pipelineRequest: { floor: { code: "protected-path" } } });
  });

  it("does not borrow a stripped parent variable as a deterministic child write target", async () => {
    manager.setMode("allow");
    vi.stubEnv("UNFORWARDED_WRITE_TARGET", join(project, "out.txt"));
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "must not execute", isError: false });
    registry.register(tool);
    const check = vi.spyOn(manager, "checkDetailed");
    const [result] = await run(executor(), tool.name, { command: 'echo x > "$UNFORWARDED_WRITE_TARGET"',
      executionMode: "host", justification: "Write the project fixture" });
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ forceExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
    const permissionCall = check.mock.calls.findLast((call) => call[4]?.shellExecution?.environmentSnapshot !== undefined);
    expect(permissionCall?.[4]?.shellExecution?.environmentSnapshot).not.toHaveProperty("UNFORWARDED_WRITE_TARGET");
  });

  it.each(["strict", "default"] as const)("asks before reading a secret file in %s", async (mode) => {
    manager.setMode(mode);
    const path = join(project, ".env");
    await writeFile(path, "FIXTURE_SECRET=private-value\n");
    const execute = vi.spyOn(readTool, "execute");
    const check = vi.spyOn(manager, "checkDetailed");
    const [result] = await run(executor(), "read_file", { path });
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(check.mock.results.at(-1)?.value).toMatchObject({
      decision: "ask", reasonCode: "secret-read", pipelineRequest: { secretRead: true,
        paths: [{ lexical: path, canonical: canonicalForMatch(path), effect: "read" }] },
    });
  });

  it("reviews a native secret-file read in auto mode", async () => {
    manager.setMode("auto");
    const dispatch = reviewer();
    const path = join(project, ".env");
    await writeFile(path, "FIXTURE_SECRET=private-value\n");
    const check = vi.spyOn(manager, "checkDetailed");
    await run(executor(), "read_file", { path });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(check.mock.results.at(-1)?.value).toMatchObject({
      reasonCode: "review-required", pipelineRequest: { secretRead: true }, reviewer: { route: "foreground-auto" },
    });
  });

  it.each([
    { scope: "session", mode: "default" }, { scope: "persistent", mode: "default" },
    { scope: "session", mode: "strict" }, { scope: "session", mode: "auto" },
  ] as const)("honors a $scope grant in $mode before headless human fallback", async ({ scope, mode }) => {
    manager.setMode(mode);
    const path = join(project, ".env");
    await writeFile(path, "FIXTURE_SECRET=remembered-value\n");
    await recordApproval("read_file", canonicalStringify({ path }), "builtin", {
      scope, ...(scope === "session" ? { sessionId } : { projectCwd: project }), verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
    });
    const execute = vi.spyOn(readTool, "execute");
    const resolveMemory = vi.spyOn(manager, "resolveRememberedPermission");
    const dispatch = vi.spyOn(manager, "dispatchReviewer");
    const [result] = await run(executor(), "read_file", { path }, { headless: true });
    expect(result.is_error, result.content).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(resolveMemory).toHaveBeenCalledOnce();
    expect(resolveMemory.mock.results[0]?.value).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("honors a remembered outside write before its headless directory fallback", async () => {
    manager.setMode("default");
    const path = join(root, "remembered-outside.txt");
    const input = { path, content: "remembered outside effect" };
    const identity = await approvalIdentityFor(writeTool, input, project, undefined, sessionId);
    await recordApproval(writeTool.name, canonicalStringify(input), "builtin", {
      scope: "session", sessionId, verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
      approvalCacheKey: approvalCacheKeyIdentity(identity.approvalCacheKey, identity.approvalMemory),
    });
    const [result] = await run(executor(), writeTool.name, input, { headless: true });
    expect(result.is_error, result.content).not.toBe(true);
    expect(requests).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe(input.content);
  });

  it("keeps headless ask rules above a matching stored grant", async () => {
    manager.setMode("default");
    const path = join(project, ".env");
    await writeFile(path, "FIXTURE_SECRET=remembered-value\n");
    await recordApproval("read_file", canonicalStringify({ path }), "builtin", {
      scope: "session", sessionId, verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
    });
    manager.setRules([{ pattern: "read_file", action: "ask" }]);
    const execute = vi.spyOn(readTool, "execute");
    const resolveMemory = vi.spyOn(manager, "resolveRememberedPermission");
    const [result] = await run(executor(), "read_file", { path }, { headless: true });
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(resolveMemory).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("allows a protected-path read with a matching stored grant in headless", async () => {
    manager.setMode("allow");
    await mkdir(join(project, ".git"));
    const path = join(project, ".git", "config");
    await writeFile(path, "[core]\nrepositoryformatversion = 0\n");
    await recordApproval("read_file", canonicalStringify({ path }), "builtin", {
      scope: "session", sessionId, verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
    });
    const execute = vi.spyOn(readTool, "execute");
    const resolveMemory = vi.spyOn(manager, "resolveRememberedPermission");
    const dispatch = vi.spyOn(manager, "dispatchReviewer");
    const [result] = await run(executor(), "read_file", { path }, { headless: true });
    expect(result.is_error, result.content).not.toBe(true);
    expect(resolveMemory).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it.each([
    { ToolClass: CopyPathTool, sourceField: "sourcePath" },
    { ToolClass: ExtractArchiveTool, sourceField: "archivePath" },
  ] as const)("treats a protected $sourceField as a read and its destination as a write", async ({ ToolClass, sourceField }) => {
    manager.setMode("allow");
    await mkdir(join(project, ".git"));
    const source = join(project, ".git", "source.data");
    await writeFile(source, "read-only transfer source");
    const tool = new ToolClass();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "transfer completed", isError: false });
    registry.register(tool);
    const check = vi.spyOn(manager, "checkDetailed");
    const destination = join(project, "ordinary-output");
    const [allowed] = await run(executor(), tool.name, { [sourceField]: source, destinationPath: destination });
    expect(allowed.is_error, allowed.content).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
    expect(check.mock.results.at(-1)?.value.pipelineRequest?.paths).toEqual([
      expect.objectContaining({ lexical: source, effect: "read" }),
      expect.objectContaining({ lexical: destination, effect: "write" }),
    ]);
    execute.mockClear();
    const protectedDestination = join(project, ".git", "new-control");
    const [blocked] = await run(executor(), tool.name, { [sourceField]: source, destinationPath: protectedDestination });
    expect(blocked.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ forceExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
  });

  it("reuses a remembered explicit host command only on its sealed plan", async () => {
    manager.setMode("strict");
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "remembered host operation", isError: false });
    registry.register(tool);
    const input = { command: "mkdir output", executionMode: "host", justification: "Execute the approved fixture operation" };
    await recordShellGrant(tool, input);
    const [result] = await run(executor(), tool.name, input, { headless: true });
    expect(result.is_error, result.content).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("does not reuse a remembered host command after the shell plan changes", async () => {
    manager.setMode("strict");
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "must not execute", isError: false });
    registry.register(tool);
    const input = { command: "mkdir output" };
    await recordShellGrant(tool, input);
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "Changed fixture confinement", confines: { filesystem: true, process: true, network: true } });
    const [result] = await run(executor(), tool.name, input, { headless: true });
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("does not reuse a remembered host command from another working directory", async () => {
    manager.setMode("strict");
    const tool = new BashTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "must not execute", isError: false });
    registry.register(tool);
    const input = { command: "mkdir output", executionMode: "host", justification: "Execute the approved fixture operation" };
    await recordShellGrant(tool, input);
    const otherProject = join(root, "other-project");
    await mkdir(otherProject);
    const [result] = await run(executor(), tool.name, input, { headless: true, executionCwd: otherProject });
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("allows a native secret-file read in allow mode", async () => {
    manager.setMode("allow");
    const path = join(project, ".env");
    await writeFile(path, "FIXTURE_SECRET=private-value\n");
    const execute = vi.spyOn(readTool, "execute");
    const [result] = await run(executor(), "read_file", { path });
    expect(result.is_error, result.content).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("keeps the host credential store admission-denied in allow mode", async () => {
    manager.setMode("allow");
    const path = join(root, "state", "secrets", "fixture.json");
    await mkdir(join(root, "state", "secrets"), { recursive: true });
    await writeFile(path, "host-private-data");
    const execute = vi.spyOn(readTool, "execute");
    const [result] = await run(executor(), "read_file", { path }, { additionalDirectories: [root] });
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("forces direct protected writes once before allow mode, rules, review or memory", async () => {
    manager.setMode("allow");
    manager.setRules([{ pattern: "write_file", action: "allow" }]);
    const dispatch = reviewer();
    const remembered = vi.spyOn(manager, "resolveRememberedPermission");
    await mkdir(join(project, ".git"));
    const path = join(project, ".git", "config");
    await writeFile(path, "[core]\nrepositoryformatversion = 0\n");
    const input = { path, content: "unapproved control change" };
    const identity = await approvalIdentityFor(writeTool, input, project, undefined, sessionId);
    await recordApproval("write_file", canonicalStringify(input), "builtin", {
      scope: "session", sessionId, verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
      approvalCacheKey: approvalCacheKeyIdentity(identity.approvalCacheKey, identity.approvalMemory),
    });
    const execute = vi.spyOn(writeTool, "execute");
    const [result] = await run(executor(), "write_file", input);
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("[core]\nrepositoryformatversion = 0\n");
    expect(dispatch).not.toHaveBeenCalled();
    expect(remembered).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      category: "tool", forceExplicit: true,
      allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false,
    });
  });

  it.each(["symlink", "parent-segment"] as const)("forces a %s escape despite an existing outside grant", async (boundary) => {
    manager.setMode("allow");
    const dispatch = reviewer();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside resource");
    if (boundary === "symlink") await symlink(outside, join(project, "linked.txt"));
    const path = boundary === "symlink" ? "linked.txt" : "../outside.txt";
    expect(process.cwd()).not.toBe(project);
    const check = vi.spyOn(manager, "checkDetailed");
    const execute = vi.spyOn(readTool, "execute");
    const [result] = await run(executor(), "read_file", { path }, { additionalDirectories: [root] });
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ category: "tool", forceExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
    expect(check.mock.results.at(-1)?.value).toMatchObject({ reasonCode: "project-escape", pipelineRequest: {
      floor: { code: "project-escape" }, paths: [{ canonical: canonicalForMatch(outside), effect: "read" }],
    } });
  });

  it("allows read-only protocol discovery metadata through the real executor", async () => {
    manager.setMode("strict");
    const callTool = vi.fn(async () => ({ text: "fixture result" }));
    const tool = mcpToolToTool("fixture-server", "fixture_inspect", {
      name: "inspect", description: "Inspect fixture state", inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    }, callTool);
    registry.register(tool);
    const [result] = await run(executor(), tool.name, {});
    expect(result.is_error, result.content).not.toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("stops a mixed-target patch at its protected floor before an unrelated directory grant", async () => {
    manager.setMode("allow");
    const grant = vi.fn();
    await mkdir(join(project, ".git"));
    const protectedPath = join(project, ".git", "config");
    await writeFile(protectedPath, "original\n");
    const outside = join(root, "outside.txt");
    const patch = `*** Begin Patch\n*** Add File: ${outside}\n+outside\n*** Update File: ${protectedPath}\n@@\n-original\n+modified\n*** End Patch`;
    const [result] = await withCodeCheckpoint({ sessionId, messageId: "mixed-patch" }, () => run(executor(), "apply_patch", { patch }, { onDirectoryGrant: grant }));
    expect(result.is_error).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ category: "tool", forceExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
    expect(requests[0]).toMatchObject({ durableApprovalRecordAllowed: false });
    expect(grant).not.toHaveBeenCalled();
    expect(await readFile(protectedPath, "utf8")).toBe("original\n");
    await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes both ordinary outside patch targets after one combined approval", async () => {
    manager.setMode("default");
    const first = join(root, "first-outside", "one.txt");
    const second = join(root, "second-outside", "two.txt");
    await mkdir(join(root, "first-outside"));
    await mkdir(join(root, "second-outside"));
    const patch = `*** Begin Patch\n*** Add File: ${first}\n+first effect\n*** Add File: ${second}\n+second effect\n*** End Patch`;
    const [result] = await withCodeCheckpoint({ sessionId, messageId: "accepted-outside-patch" }, () => run(executor(undefined, "allow-once"), "apply_patch", Object.freeze({ patch })));
    expect(result.is_error, result.content).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "out-of-allowed-dir", args: { patch } });
    expect(await readFile(first, "utf8")).toBe("first effect\n");
    expect(await readFile(second, "utf8")).toBe("second effect\n");
  });

  it("runs a blocking user script before any write approval card", async () => {
    manager.setMode("strict");
    const hooks = new ScriptHookManager();
    const authorizeCommand = vi.fn(async () => ({ decision: "allow" as const, reason: "The fixture command is authorized." }));
    hooks.setCommandAuthorizer(authorizeCommand);
    hooks.setTrustedRegistry([], parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{
      type: "command", command: ["node", resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs"), "block"],
    }] }] } }).entries);
    const path = join(project, "blocked.txt");
    const execute = vi.spyOn(writeTool, "execute");
    const [result] = await withCodeCheckpoint({ sessionId, messageId: "blocked-write" }, () => run(executor(hooks), "write_file", { path, content: "must not write" }));
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("Policy requires a focused correction") });
    expect(authorizeCommand).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([false, true])("offers model choice for an outside write without granting its folder (headless=%s)", async (headless) => {
    manager.setMode("auto");
    const classify = vi.fn(() => ({ level: "high" as const, reason: "The outside change needs explicit grounds" }));
    setReviewerForTest(manager, { classifier: { classify }, cache: resources.makeVerdictCache(join(root, "outside-choice-cache.jsonl")), recentlyDenied: makeRecentlyDeniedStore(join(root, "outside-choice-denied.jsonl")) });
    const { runtime, materialize } = createRationaleHostRuntime(createTestRequestAnchor({ sessionId }));
    const execute = vi.spyOn(writeTool, "execute");
    const grant = vi.fn();
    const path = join(root, "outside-choice.txt");
    const outcome = await executor().executeConversationBatch([
      { id: "outside-choice", name: "write_file", input: { path, content: "must wait for authority" } },
    ], { executionCwd: project, sessionId, rationaleRuntime: runtime,
      permissionContext: { trustOrigin: "llm-tool-arg", headless, additionalDirectories: [], onTurnDirectoryGrant: grant } });
    expect(outcome.outcome).toBe("rationale-required");
    if (outcome.outcome !== "rationale-required") throw new Error("Expected model choice for the outside write");
    expect(outcome.control.control.action.canonicalTargets).toContain(canonicalForMatch(path));
    expect(materialize).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the existing single folder card and permission hook for an outside model-choice fallback", async () => {
    manager.setMode("auto");
    const classify = vi.fn(() => ({ level: "high" as const, reason: "The outside change needs explicit grounds" }));
    setReviewerForTest(manager, { classifier: { classify }, cache: resources.makeVerdictCache(join(root, "outside-card-cache.jsonl")), recentlyDenied: makeRecentlyDeniedStore(join(root, "outside-card-denied.jsonl")) });
    const { runtime, materialize } = createRationaleHostRuntime(createTestRequestAnchor({ sessionId }));
    const hooks = new ScriptHookManager();
    const permissionHook = vi.spyOn(hooks, "runPermissionRequest");
    const execute = vi.spyOn(writeTool, "execute");
    const path = join(root, "outside-card.txt");
    const outcome = await executor(hooks).executeConversationBatch([
      { id: "outside-card", name: "write_file", input: { path, content: "must wait for authority" } },
    ], { executionCwd: project, sessionId, rationaleRuntime: runtime,
      permissionContext: { trustOrigin: "llm-tool-arg", additionalDirectories: [] } });
    expect(outcome.outcome).toBe("rationale-required");
    const callback = materialize.mock.calls[0]?.[0].requestHumanApproval;
    if (!callback) throw new Error("Expected the original folder approval callback");
    await expect(callback({ requestId: "outside-folder-card" })).resolves.toMatchObject({ requestId: "outside-folder-card", choice: "deny-once" });
    expect(permissionHook).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: "outside-folder-card", kind: "out-of-allowed-dir", args: { path }, outOfAllowedDir: { candidatePath: path } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { scope: "session", change: "none" }, { scope: "always", change: "none" },
    { scope: "session", change: "unrelated-folder" }, { scope: "session", change: "deny-rule" },
    { scope: "session", change: "protected-target" }, { scope: "session", change: "late-owner" },
  ] as const)("checks the exact outside write after native $scope folder approval with $change", async ({ scope, change }) => {
    manager.setMode("auto");
    const classify = vi.fn(() => ({ level: "high" as const, reason: "The outside write needs consent" }));
    setReviewerForTest(manager, { classifier: { classify }, cache: resources.makeVerdictCache(join(root, "folder-resume-cache.jsonl")), recentlyDenied: makeRecentlyDeniedStore(join(root, "folder-resume-denied.jsonl")) });
    const outside = join(root, "approved-folder");
    await mkdir(outside);
    const path = join(outside, "result.txt");
    const cards: ApprovalRequest[] = [];
    const contents = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => { if (channel === IPC_APPROVAL_REQUEST) cards.push(request); } };
    const gate = new ApprovalGate(contents as never);
    const hookRunner = new HookRunner();
    const hooks = new ScriptHookManager();
    let directories: string[] = [];
    let directorySaveFailure: string | undefined;
    const policy = () => captureRationalePolicySnapshot({ permissionManager: manager, hookRunner, scriptHookManager: hooks, additionalDirectories: directories });
    const scopeComplete = vi.fn();
    const coordinator = new RationaleHostCoordinator({
      requestAnchor: createTestRequestAnchor({ sessionId }), userRoleTexts: ["Perform the requested operation."],
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
      ticketStore: new InProcessRationaleTicketStore({ onAudit: () => {} }),
      rationaleScopeReviewer: new LlmRationaleScopeReviewer({ complete: scopeComplete }, "fixture-reviewer"),
      approvalGate: gate, getRationalePolicyEpoch: () => policy().epoch, getRationalePolicySnapshot: policy,
      getRegistryGeneration: () => registry.getGeneration(), getSandboxGeneration: () => "fixture-sandbox",
      anchorRoundCas: new InMemoryHostAnchorRoundCasStore(), hostInvocationStartCas: new InMemoryHostInvocationStartCasStore(),
      onInvocationAudit: () => {}, onProjectionAudit: () => {},
      onReviewerChoiceResolved: (session, request, decision) => manager.resolveReviewerChoice(session, request, decision),
    });
    const lifecycle = { allowDirectory: async (directory: string) => {
      try { directories = await addAllowedDirectoryPersist(directory, join(root, "folder-settings.json")); return directories; }
      catch (error) { directorySaveFailure = error instanceof Error ? error.message : String(error); throw error; }
    }, denyDirectory: async () => { throw new Error("No directory removal was requested"); } };
    const realExecutor = new ToolExecutor(registry, hookRunner, manager, undefined, gate, hooks, audit, undefined, undefined, () => lifecycle);
    const execute = vi.spyOn(writeTool, "execute");
    const options = { sessionId, executionCwd: project, permissionContext: { trustOrigin: "llm-tool-arg" as const, ownerUnattended: change === "late-owner", additionalDirectories: [], getAdditionalDirectories: () => directories,
      onSessionDirectoryGrant: (directory: string) => { directories = [...new Set([...directories, directory])]; } } };
    const initial = await realExecutor.executeConversationBatch([{ id: "outside-folder-resume", name: "write_file", input: { path, content: "approved exact effect" } }], { ...options, rationaleRuntime: coordinator });
    expect(initial.outcome).toBe("rationale-required");
    if (initial.outcome !== "rationale-required") throw new Error("Expected outside-write model choice");
    const control = initial.control.control;
    const round = await coordinator.handleRationaleRoundResult({ ticketId: control.ticketId, result: { kind: "calls", calls: [{ id: "ask-folder", name: "permission_rationale", input: { contractVersion: 1, anchorId: control.anchor.anchorId, ticketId: control.ticketId, actionDigest: control.action.actionDigest, round: 1, choice: "ask_user" } }] } });
    expect(round?.autoApproved).toBe(false);
    expect(scopeComplete).not.toHaveBeenCalled();
    const pending = coordinator.promptForApproval(control.ticketId);
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const card = cards[0]!;
    expect(card).toMatchObject({ kind: "out-of-allowed-dir", outOfAllowedDir: { candidatePath: path, suggestedParent: canonicalForMatch(outside) } });
    if (change === "late-owner") vi.spyOn(Date, "now").mockReturnValue(control.anchor.expiresAt + 60_001);
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: scope === "session" ? "allow-session" : "allow-always", rememberPattern: outside, nonce: card.nonce, hmac: card.hmac }, contents as never);
    const approval = await pending;
    expect(approval, JSON.stringify({ outcome: approval?.outcome, reason: approval !== null && "reason" in approval ? approval.reason : undefined, directorySaveFailure })).toMatchObject({ outcome: "allowed-once" });
    expect(directories).toEqual([scope === "always" ? foldCanonicalPathSeparators(outside) : canonicalForMatch(outside)]);
    const protectedTarget = join(project, ".git", "config");
    if (change === "unrelated-folder") directories = [...directories, join(root, "unrelated-folder")];
    if (change === "deny-rule") manager.setRules([{ pattern: "write_file", action: "deny" }]);
    if (change === "protected-target") {
      await mkdir(join(project, ".git"));
      await writeFile(protectedTarget, "original protected content");
      await symlink(protectedTarget, path);
    }
    const sealed = await coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: control.eligibilityContext });
    if (change !== "none" && change !== "late-owner") {
      if (sealed) {
        const refused = await realExecutor.executeSealedRationaleResume(sealed.resumeRequest, { ...options, rationaleResumeRuntime: coordinator });
        expect(refused.is_error, refused.content).toBe(true);
      } else {
        expect(sealed).toBeNull();
      }
      expect(execute).not.toHaveBeenCalled();
      expect(cards).toHaveLength(1);
      if (change === "protected-target") expect(await readFile(protectedTarget, "utf8")).toBe("original protected content");
      else await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    if (!sealed) throw new Error("Expected the native folder approval to issue an authentic resume");
    const result = await realExecutor.executeSealedRationaleResume(sealed.resumeRequest, { ...options, rationaleResumeRuntime: coordinator });
    expect(result.is_error, result.content).not.toBe(true);
    expect(await readFile(path, "utf8")).toBe("approved exact effect");
    expect(cards).toHaveLength(1);
  });

});
