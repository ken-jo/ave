import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
// Admission denials and forced approvals must precede tool execution.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { hostFilesystemPath } from "../../__tests__/support/host-filesystem-path.js";
import childProcess, { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import * as powerShellExecutable from "../../shared/powershell-executable.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

import { ToolExecutor } from "../executor.js";
import { initPiiRedactionPolicy } from "../../shared/dlp.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { makePermissionManager } from "./executor-reviewer-fixtures.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import * as shellTools from "../shell-tools.js";
import * as powerShellStartupPolicy from "../../shared/powershell-startup-policy.js";
import type { PowerShellAstSummary } from "../powershell-ast.js";
import { powerShellLiteral } from "../../__tests__/support/powershell-ast.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { ReadFileTool, WriteFileTool } from "../file-tools.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  ApprovalGate,
  IPC_APPROVAL_REQUEST,
  type ApprovalRequestInput,
} from "../../permissions/approval-gate.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  recordApproval,
} from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import {
  RuleBasedRiskClassifier,
  type RiskClassifier,
} from "../../permissions/reviewer/risk-classifier.js";
import { createAgentStatusTool } from "../agent-spawn.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import * as sandboxAuditSink from "../../audit/sandbox-audit-sink.js";
import { buildPluginToolsForTest } from "../../plugins/__tests__/plugin-tool-test-fixture.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "../../permissions/sensitive-paths.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  getHostShellExecutionPlan,
  markPluginWorkerWrapped,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { getHostShellExecutionPlanAuditProjection } from "../../permissions/host-shell-execution-plan.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import { approvalCacheKeyFor } from "../pipeline/display-mask.js";

async function waitForApprovalPayload<T>(
  wc: ReturnType<typeof makeMockWebContents>,
  index = 0,
): Promise<T> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const payload = sentApprovalCards<T>(wc)[index];
    if (payload) return payload;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("approval request was not sent");
}

function comparablePath(path: string | undefined): string {
  // Normalize only separators and case for approval messages that are not paths.
  const raw = path ?? "";
  if (!raw) return "";
  const pathish = process.platform === "win32"
    ? /^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\")
    : raw.startsWith("/");
  if (!pathish) {
    return raw.replace(/\\/g, "/").toLowerCase();
  }
  return caseFoldForMatch(canonicalizePathForMatch(raw)).replace(/\\/g, "/").toLowerCase();
}

function makeReadFileTool(
  executeSpy: ReturnType<typeof vi.fn>,
): Tool {
  return makeFileTool("read", executeSpy);
}

// Directory approval confines writes; reads at the same path do not reach this dialog.
function makeWriteFileTool(
  // Bare Mock is not callable under this configuration; vi.fn satisfies the call signature.
  executeSpy: (input: unknown) => unknown,
): Tool {
  return makeFileTool("write", executeSpy);
}

function makeFileTool(category: "read" | "write", executeSpy: (input: unknown) => unknown): Tool {
  return createDynamicTool({
    name: `${category}_file`,
    description: category === "read" ? "Reads a file." : "Writes a file.",
    source: "builtin",
    category,
    pathFields: ["path"],
    isReadOnly: () => category === "read",
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  });
}

const managerRoots: string[] = [];
afterEach(async () => { for (const directory of managerRoots.splice(0)) await cleanupTmpDir(directory); });
function fixtureManager(mode: "strict" | "default" | "auto" | "allow" = "default") {
  const directory = mkdtempSync(join(tmpdir(), "ave-executor-policy-"));
  managerRoots.push(directory);
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode(mode);
  return manager;
}
function denyingApprovalGate() {
  const wc = makeMockWebContents();
  const gate = new ApprovalGate(wc as never);
  wc.send.mockImplementation((channel: string, request: import("../../permissions/approval-gate.js").ApprovalRequest) => {
    if (channel !== IPC_APPROVAL_REQUEST) return;
    queueMicrotask(() => gate.resolveFromDesktopRenderer(request.id, {
      requestId: request.id, choice: "deny-once", nonce: request.nonce, hmac: request.hmac,
    }, wc as never));
  });
  return { wc, gate };
}

describe("ToolExecutor — A2A parent delivery capability provenance", () => {
  it.each([
    { hostCapability: true, rawCapability: false },
    { hostCapability: false, rawCapability: true },
  ])(
    "passes host capability $hostCapability and ignores raw-input spoof $rawCapability",
    async ({ hostCapability, rawCapability }) => {
      const captures: Array<{
        input: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }> = [];
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "capture_a2a_parent_delivery",
        description: "Captures host-owned execution metadata.",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: {
          type: "object",
          properties: {
            supportsA2AParentDelivery: { type: "boolean" },
          },
        },
        execute: async (rawInput, ctx) => {
          captures.push({
            input: { ...rawInput },
            metadata: { ...ctx.metadata },
          });
          return { output: "captured", isError: false };
        },
      }));
      const executor = new ToolExecutor(registry, undefined, fixtureManager("allow"));

      const results = await executor.executeAll(
        [{
          id: "capture-a2a-capability",
          name: "capture_a2a_parent_delivery",
          input: { supportsA2AParentDelivery: rawCapability },
        }],
        {
          sessionId: "parent-session",
          supportsA2AParentDelivery: hostCapability,
          permissionContext: userPermissionContext(),
        },
      );

      expect(results[0]).toMatchObject({ content: "captured" });
      expect(captures).toHaveLength(1);
      expect(captures[0].metadata.supportsA2AParentDelivery).toBe(hostCapability);
      expect(captures[0].input.supportsA2AParentDelivery).toBe(rawCapability);
    },
  );
});

/**
 * Sensitive-path hard-block fixtures in this block exercise behavior adapted
 * from OpenHarness's permission checker (MIT License):
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py
 * Copyright (c) 2025 OpenHarness Contributors
 */
describe("ToolExecutor — sensitive-path and provenance authorization", () => {
  it("asks before reading an ordinary private key and honors the native denial", async () => {
    const executeSpy = vi.fn(async () => "file contents");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = fixtureManager();
    permMgr.setMode("default");
    const { wc, gate } = denyingApprovalGate();

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    const results = await executor.executeAll(
      [
        {
          id: "tu-1",
          name: "read_file",
          input: { path: "/Users/test/.ssh/id_rsa" },
        },
      ],
      { sessionId: "sess-c1", permissionContext: userPermissionContext() },
    );

    // A denied secret read never enters the handler.
    expect(executeSpy).not.toHaveBeenCalled();

    expect(sentApprovalCards(wc)).toHaveLength(1);

    expect(gate.pendingCount).toBe(0);

    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("승인 거부");
  });

  it("denies host credential storage before a card even in allow mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "ave-executor-private-store-"));
    const priorHome = process.env.AVE_HOME;
    process.env.AVE_HOME = home;
    try {
      const target = join(home, "secrets", "credentials.json");
      mkdirSync(join(home, "secrets"));
      writeFileSync(target, "host-private-data");
      const execute = vi.fn(async () => "must-not-read");
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool(execute));
      const { wc, gate } = denyingApprovalGate();
      const executor = new ToolExecutor(registry, undefined, fixtureManager("allow"), undefined, gate);
      const [result] = await executor.executeAll(
        [{ id: "host-store-read", name: "read_file", input: { path: target } }],
        { sessionId: "host-store-read", permissionContext: userPermissionContext() },
      );
      expect(result.is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(sentApprovalCards(wc)).toHaveLength(0);
    } finally {
      if (priorHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = priorHome;
      await cleanupTmpDir(home);
    }
  });

  it("expands ~/ before secret-read approval", async () => {
    const executeSpy = vi.fn(async () => "file contents");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = fixtureManager();
    permMgr.setMode("default");
    const { wc, gate } = denyingApprovalGate();
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-tilde", name: "read_file", input: { path: "~/.ssh/id_rsa" } }],
      { sessionId: "sess-c1-tilde", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(sentApprovalCards(wc)).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("승인 거부");
  });

  it("allows an ordinary read within allowed roots without a dialog", async () => {
    // Use an allowed directory so directory confirmation cannot intercept the approval path under test.
    const executeSpy = vi.fn(async () => "hello world");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = fixtureManager();
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    const promise = executor.executeAll(
      [
        {
          id: "tu-2",
          name: "read_file",
          input: { path: "/tmp/safe-file.txt" },
        },
      ],
      {
        sessionId: "sess-c1-sanity",
        permissionContext: userPermissionContext({ additionalDirectories: ["/tmp"] }),
      },
    );

    await new Promise((r) => setImmediate(r));

    // Read-only non-sensitive calls inside an allowed directory auto-approve without a dialog.
    expect(wc.send).not.toHaveBeenCalled();

    const results = await promise;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("hello world");
  });

  it("strict execution mode preserves ordinary reads without a card", async () => {
    const executeSpy = vi.fn(async () => "hello strict");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = fixtureManager();
    permMgr.setMode("strict");

    const wc = makeMockWebContents();
    const sent: import("../../permissions/approval-gate.js").ApprovalRequest[] = [];
    (wc.send as ReturnType<typeof vi.fn>).mockImplementation(
      (ch: string, req: import("../../permissions/approval-gate.js").ApprovalRequest) => {
        if (ch === IPC_APPROVAL_REQUEST) sent.push(req);
      },
    );
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const promise = executor.executeAll(
      [{ id: "tu-strict-read", name: "read_file", input: { path: "/tmp/strict-read.txt" } }],
      {
        sessionId: "sess-strict-read",
        permissionContext: userPermissionContext({ additionalDirectories: ["/tmp"] }),
      },
    );

    expect(gate.pendingCount).toBe(0);
    expect(sent).toHaveLength(0);

    const results = await promise;

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("hello strict");
  });

  it("uses the declared read category rather than a static tool-name allowlist", async () => {
    const executeSpy = vi.fn(async () => "dynamic read");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "dynamic_fetch_report",
      description: "Input-aware read/write test tool",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
      },
      isReadOnly: (input) => (input as { mode?: string }).mode === "read",
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));

    const permMgr = fixtureManager();
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-dynamic", name: "dynamic_fetch_report", input: { mode: "read" } }],
      { sessionId: "sess-dynamic-readonly", permissionContext: userPermissionContext() },
    );

    expect(wc.send).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("dynamic read");
  });

  it("absorbs a schema violation raised while deriving the approval cache key", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const executor = new ToolExecutor(registry);

    // approvalCacheKey parses input on the authorization path; invalid input must become a result instead of escaping.
    const results = await executor.executeAll(
      [{ id: "tu-bad-schema", name: "bash", input: { command: "echo hi", timeoutSeconds: 0 } }],
      { sessionId: "sess-bad-schema", permissionContext: userPermissionContext() },
    );

    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe("tu-bad-schema");
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("bash");
    expect(results[0].content).toContain("timeoutSeconds");
  });

  it.each([BashTool, PowerShellTool])("preserves invalid shell field diagnostics before authorization", async (ShellTool) => {
    const registry = new ToolRegistry();
    const shell = new ShellTool();
    registry.register(shell);
    const execute = vi.spyOn(shell, "execute");
    const approvalGate = new ApprovalGate(null);
    const requestApproval = vi.spyOn(approvalGate, "requestAndWait");
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, approvalGate);
    for (const [field, input] of [
      ["timeoutSeconds", { command: "echo hi", timeoutSeconds: 0 }],
      ["executionMode", { command: "echo hi", executionMode: "invalid" }],
      ["justification", { command: "echo hi", executionMode: "host", justification: " " }],
      ["run_in_background", { command: "echo hi", executionMode: "host", justification: "Read host state", run_in_background: true }],
    ] as const) {
      const results = await executor.executeAll(
        [{ id: `invalid-${field}`, name: shell.name, input }],
        { sessionId: "invalid-shell-fields", permissionContext: userPermissionContext() },
      );
      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain(field);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("binds a remembered host command grant and an explicit rule to their exact commands", async () => {
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash);
    __resetActiveSandboxCapabilityForTest();
    setShellSandboxRequestedAtBoot(false);

    const dir = mkdtempSync(join(tmpdir(), "ave-shell-approval-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      const firstInput = { command: "echo safe", timeoutSeconds: 1 };
      const secondInput = { command: "echo different", timeoutSeconds: 1 };
      const firstApprovalCacheKey = approvalCacheKeyFor(
        bash,
        firstInput,
        process.cwd(),
        getHostShellExecutionPlanAuditProjection(getHostShellExecutionPlan()),
      );
      if (firstApprovalCacheKey === undefined) {
        throw new Error("Bash must provide a sealed-plan approval cache key");
      }
      await permMgr.addAlwaysAllowedPersist(firstApprovalCacheKey);

      const approvalGate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);
      const run = (id: string, input: typeof firstInput) => executor.executeAll(
        [{ id, name: "bash", input }],
        { sessionId: "sess-shell-approval", permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }) },
      );

      const grantOnly = await run("tu-shell-0", firstInput);
      expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
      expect(grantOnly[0].is_error).toBeUndefined();
      expect(grantOnly[0].content).toContain("safe");

      await permMgr.addRulePersist({ pattern: "Bash(echo safe)", action: "allow" }, { kind: "user" });
      const first = await run("tu-shell-1", firstInput);
      expect(first[0].is_error).toBeUndefined();
      expect(first[0].content).toContain("safe");
      expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(0);

      const second = await run("tu-shell-2", secondInput);
      expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
      expect(second[0].is_error).toBe(true);
      expect(second[0].content).toContain("승인 거부");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("honors secret shell-read denial before execution or durable grant", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const dir = mkdtempSync(join(tmpdir(), "ave-shell-path-policy-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("default");
      const approvalGate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);

      const result = await executor.executeAll(
        [{ id: "tu-shell-path-policy", name: "bash", input: { command: "cat ~/.ssh/id_rsa", timeoutSeconds: 1 } }],
        { sessionId: "sess-shell-path-policy", permissionContext: userPermissionContext() },
      );

      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("승인 거부");
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
      await expect(permMgr.listPersistedRules()).resolves.toEqual([]);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("denies a headless shell parent escape before reviewer execution", async () => {
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const executeSpy = vi.spyOn(bash, "execute");
    registry.register(bash);
    const dir = mkdtempSync(join(tmpdir(), "ave-headless-outdir-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "ave-headless-outside-"));
    const outsideFile = join(outsideDir, "probe.txt");
    writeFileSync(outsideFile, "blocked", "utf-8");

    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      const recentlyDenied = makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl"));
      setReviewerForTest(permMgr, {
        classifier: {
          classify: vi.fn(() => ({ level: "low", reason: "reviewer would otherwise allow" })),
        },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        recentlyDenied,
      });
      const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "h",
      }));
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        undefined,
        undefined,
        auditLogger as never,
      );

      const result = await executor.executeAll(
        // Use a write verb so directory confinement applies; reads would not exercise the queue.
        [{ id: "tu-headless-outdir", name: "bash", input: { command: `chmod u+w ../${outsideDir.split(/[\\/]/).at(-1)}/probe.txt`, cwd: dir, timeoutSeconds: 1 } }],
        { sessionId: "sess-headless-outdir", permissionContext: userPermissionContext({ headless: true, trustOrigin: "llm-tool-arg" }) },
      );

      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("do not retry");
      expect(executeSpy).not.toHaveBeenCalled();
      const pending = (await recentlyDenied.list());
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        toolName: "bash",
        source: "builtin",
        category: "shell",
        reason: expect.any(String),
      });
    } finally {
      await cleanupTmpDir(dir);
      await cleanupTmpDir(outsideDir);
    }
  });

  // Native parser admission is covered separately; these fixtures isolate the trusted preflight's path-policy order.
  const pathPolicyAst = (command: string): PowerShellAstSummary => {
    const literal = powerShellLiteral;
    const getContent = (argument: ReturnType<typeof literal>) => ({ name: "Get-Content", text: command,
      arguments: [literal("Get-Content"), argument] });
    if (command === "Get-Content $HOME/.ssh/id_rsa") return { errors: [], unsupported: [], redirections: [], commands: [getContent({ kind: "dynamic", text: "$HOME/.ssh/id_rsa" })] };
    if (command === "Get-Content '~/.ssh/id_rsa'") return { errors: [], unsupported: [], redirections: [], commands: [getContent(literal("~/.ssh/id_rsa", "'~/.ssh/id_rsa'"))] };
    if (command === "Get-Content package.json > ~/.ssh/leak") return { errors: [], unsupported: [], redirections: [literal("~/.ssh/leak")], commands: [getContent(literal("package.json"))] };
    if (command === 'Set-Content (Join-Path $HOME "Desktop/out.txt") hi') return { errors: [], unsupported: [], redirections: [], commands: [{ name: "Set-Content", text: command,
      arguments: [literal("Set-Content"), { kind: "dynamic", text: '(Join-Path $HOME "Desktop/out.txt")' }, literal("hi")] }] };
    throw new Error("Missing native AST fixture");
  };

  it.each([
    ["sensitive env-home operand", "Get-Content $HOME/.ssh/id_rsa"],
    ["sensitive quoted operand", "Get-Content '~/.ssh/id_rsa'"],
  ])("checks parsed shell paths before execution or durable approval: %s", async (_label, command) => {
    const registry = new ToolRegistry();
    registry.register(new PowerShellTool());
    const dir = mkdtempSync(join(tmpdir(), "ave-powershell-path-policy-"));
    const startup = vi.spyOn(powerShellStartupPolicy, "isPowerShellStartupPinned").mockReturnValue(true);
    const installation = vi.spyOn(powerShellExecutable, "resolveTrustedPowerShellExecutable").mockReturnValue({ executable: "/protected-fixture/pwsh", kind: "pwsh" });
    const preflight = vi.spyOn(shellTools, "findPowerShellCommandPathViolation");
    const parserInputs: string[] = [];
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((_executable, argv) => {
      const args = Array.isArray(argv) ? argv : [];
      const encodedIndex = args.indexOf("-EncodedCommand");
      const script = encodedIndex >= 0 ? Buffer.from(args[encodedIndex + 1]!, "base64").toString("utf16le") : args.join(" ");
      expect(script).toContain("[System.Management.Automation.Language.Parser]::ParseInput");
      const child = new ChildProcess();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const chunks: Buffer[] = [];
      stdin.on("data", chunk => chunks.push(Buffer.from(chunk)));
      stdin.on("finish", () => queueMicrotask(() => {
        const source = Buffer.concat(chunks).toString("utf8");
        parserInputs.push(source);
        stdout.emit("data", Buffer.from(JSON.stringify(pathPolicyAst(source))));
        Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
        child.emit("close", 0);
      }));
      Object.assign(child, { stdin, stdout, stderr });
      return child;
    });
    syncBuiltinESMExports();
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("allow");
      const approvalGate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);

      const result = await executor.executeAll(
        [{ id: "tu-powershell-path-policy", name: "powershell", input: { command, timeoutSeconds: 1 } }],
        { sessionId: "sess-powershell-path-policy", permissionContext: userPermissionContext() },
      );

      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toMatch(/PowerShell.*(?:path|provider|ordinary)/);
      expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
      await expect(permMgr.listPersistedRules()).resolves.toEqual([]);
      expect(preflight).toHaveBeenCalledOnce();
      expect(parserInputs.length).toBeGreaterThanOrEqual(1);
      expect(parserInputs.every(source => source === command)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(parserInputs.length);
    } finally {
      startup.mockRestore();
      installation.mockRestore();
      spawn.mockRestore();
      syncBuiltinESMExports();
      preflight.mockRestore();
      await cleanupTmpDir(dir);
    }
  });

  it.each([
    ["unbound home write target", "Get-Content package.json > ~/.ssh/leak", "forced"],
    ["ordinary absolute secret-file write", `Get-Content package.json > ${shellQuote(join(tmpdir(), ".ssh", "leak"))}`, "allow"],
    ["runtime-composed write target", 'Set-Content (Join-Path $HOME "Desktop/out.txt") hi', "forced"],
    ["unresolved write target", "Set-Content $UNRESOLVED_WRITE_TARGET hi", "forced"],
    ["protected control-file write", "Set-Content .git/config hi", "forced"],
  ] as const)("routes %s through the central write decision", async (_label, command, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "ave-powershell-write-route-"));
    const tool = new PowerShellTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "admitted write probe", isError: false });
    const registry = new ToolRegistry();
    registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("allow");
    const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "deny-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never);
    try {
      const [result] = await executor.executeAll(
        [{ id: "powershell-write-route", name: "powershell", input: { command } }],
        { executionCwd: dir, sessionId: "powershell-write-route", permissionContext: userPermissionContext() },
      );
      if (expected === "allow") {
        expect(result!.is_error).toBeUndefined();
        expect(result!.content).toBe("admitted write probe");
        expect(requestAndWait).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledExactlyOnceWith({ command }, expect.anything());
      } else {
        expect(result!.is_error).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        expect(requestAndWait).toHaveBeenCalledOnce();
        expect(requestAndWait.mock.calls[0]![0]).toMatchObject({
          toolName: "powershell", forceExplicit: true, allowedChoices: ["allow-once", "deny-once"],
          args: { command },
        });
      }
      await expect(manager.listPersistedRules()).resolves.toEqual([]);
    } finally {
      execute.mockRestore();
      await cleanupTmpDir(dir);
    }
  });

  it("passes non-keyboard trustOrigin to ApprovalGate and permission audit entries", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "write_probe",
      description: "write probe",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "trust-origin boundary test",
      });
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-origin", name: "write_probe", input: { path: "out.txt" } }],
      { sessionId: "sess-origin", permissionContext: userPermissionContext({ trustOrigin: "plugin-emitted" }) },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      // Approval and audit must retain the blocked conversation's identity.
      expect.objectContaining({
        trustOrigin: "plugin-emitted",
        sessionId: "sess-origin",
      }),
    );
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "ask",
        trustOrigin: "plugin-emitted",
        tool: "write_probe",
        reason: "trust-origin boundary test",
      }),
    );
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        trustOrigin: "plugin-emitted",
        tool: "write_probe",
      }),
    );
  });

  it("uses declared pathFields for permission audit directory", async () => {
    const executeSpy = vi.fn(async () => "custom wrote");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "custom_write_probe",
      description: "custom write probe",
      source: "builtin",
      category: "write",
      pathFields: ["customTarget"],
      jsonSchema: {
        type: "object",
        properties: { customTarget: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const permMgr = fixtureManager();
    permMgr.setMode("allow");
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-custom-path", name: "custom_write_probe", input: { customTarget: "reports/out.md" } }],
      { sessionId: "sess-custom-path", permissionContext: userPermissionContext() },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        directory: pathResolve("reports/out.md"),
      }),
    );
  });

  it("does not synthesize permission audit directory without a declared path surface", async () => {
    const executeSpy = vi.fn(async () => "write without path surface");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "pathless_write_probe",
      description: "pathless write probe",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: {
          payload: { type: "string" },
          url: { type: "string" },
        },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const permMgr = fixtureManager();
    permMgr.setMode("allow");
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-pathless-write", name: "pathless_write_probe", input: { payload: "ok" } }],
      { sessionId: "sess-pathless-write", permissionContext: userPermissionContext() },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        tool: "pathless_write_probe",
      }),
    );
    const allowEntry = appendPermissionAuditEntry.mock.calls.find(([entry]) => entry.decision === "allow")?.[0];
    expect(allowEntry).not.toHaveProperty("directory");
    expect(allowEntry).not.toHaveProperty("directoryAllowed");
  });

  it("auto mode allows LOW reviewed mutating calls", async () => {
    // Foreground reviewer auto-approval requires explicit auto mode plus the configured threshold.
    const executeSpy = vi.fn(async () => "reviewed write");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe_p3",
      description: "Automatic approval probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-interactive-p3-"));
    try {
      const permMgr = makePermissionManager(dir, vi.fn(() => ({ level: "low", reason: "reviewer says safe" })), "auto");
      const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "h",
      }));
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        undefined,
        undefined,
        auditLogger as never,
      );
      const permissionReviewEvents: import("../../shared/permission-review-status.js").PermissionReviewEvent[] = [];

      const result = await executor.executeAll(
        [{ id: "tu-p3-interactive", name: "reviewed_write_probe_p3", input: { payload: "ok" } }],
        {
          sessionId: "sess-p3-interactive",
          callbacks: {
            onPermissionReview: (event) => permissionReviewEvents.push(event),
          },
          permissionContext: userPermissionContext({
            userIntent: "프로젝트 규정을 찾기 위해 플러그인 조회를 실행합니다.",
          }),
        },
      );

      expect(result[0].is_error).toBeUndefined();
      expect(executeSpy).toHaveBeenCalledOnce();
      // Record the reviewer verdict so automatic approval remains auditable.
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        decision: "allow",
        tool: "reviewed_write_probe_p3",
        reviewer: expect.objectContaining({
          level: "low",
          reason: "reviewer says safe",
        }),
      }));
      expect(permissionReviewEvents.map((event) => event.status)).toEqual([
        "reviewing",
        "auto_approved",
      ]);
      expect(permissionReviewEvents[0]).toMatchObject({
        toolName: "reviewed_write_probe_p3",
        groupId: expect.any(String),
        toolUseId: "tu-p3-interactive",
        approvalPurpose: {
          source: "conversation",
          confidence: "sufficient",
          text: expect.stringContaining("프로젝트 규정을 찾기 위해"),
        },
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("default mode asks for human approval without invoking the configured reviewer", async () => {
    // A configured reviewer does not change the selected default mode.
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe_p3_off",
      description: "P3 off-state probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-interactive-p3-off-"));
    try {
      const classifySpy = vi.fn(() => ({ level: "low" as const, reason: "reviewer says safe" }));
      const permMgr = makePermissionManager(dir, classifySpy);
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({ ...entry, prevHash: "h" })),
      };
      const gate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        gate as never,
        undefined,
        auditLogger as never,
      );
      const result = await executor.executeAll(
        [{ id: "tu-p3-off", name: "reviewed_write_probe_p3_off", input: { payload: "ok" } }],
        { sessionId: "sess-p3-off", permissionContext: userPermissionContext() },
      );
      // Denied approval must prevent execution.
      expect(executeSpy).not.toHaveBeenCalled();
      expect(result[0].is_error).toBe(true);
      expect(classifySpy).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
          reviewerVerdict: undefined,
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("auto-review HIGH opens the approval gate with the reviewer verdict (deny-once blocks execution)", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_medium",
      description: "MEDIUM reviewer approval probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-interactive-medium-"));
    try {
      const classifySpy = vi.fn((ctx: import("../../permissions/reviewer/risk-classifier.js").ToolInvocationContext) => ({
        level: "high" as const,
        reason: `reviewed ${String(ctx.finalInput.payload)}`,
      }));
      const permMgr = makePermissionManager(dir, classifySpy, "auto");
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
      );
      const permissionReviewEvents: import("../../shared/permission-review-status.js").PermissionReviewEvent[] = [];

      const result = await executor.executeAll(
        [{
          id: "tu-medium-review",
          name: "reviewed_network_probe_medium",
          input: { payload: "send alice@example.com with sk-abcdefghijklmnopqrstuvwxyz" },
        }],
        {
          sessionId: "sess-medium-review",
          callbacks: {
            onPermissionReview: (event) => permissionReviewEvents.push(event),
          },
          permissionContext: userPermissionContext({
            userIntent: "테스트 알림 전송 경로를 확인합니다.",
          }),
        },
      );

      // HIGH foreground verdicts require user approval; user denial must prevent execution.
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(permissionReviewEvents.map((event) => event.status)).toEqual([
        "reviewing",
        "needs_approval",
      ]);
      expect(permissionReviewEvents[1]).toMatchObject({
        verdictLevel: "high",
      });
      const reviewReason = String(permissionReviewEvents[1]?.reason ?? "");
      expect(reviewReason).toBe("Automatic review requires human approval.");
      expect(reviewReason).not.toContain("alice@example.com");
      expect(reviewReason).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      // Carry risk and reason into approval; HIGH risk restricts scope and requires natural-language confirmation.
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "high", reason: expect.stringContaining("***@example.com") }),
      }));
      // Classify raw arguments consistently across lanes; redact only display and audit sinks.
      const reviewerCtx = classifySpy.mock.calls[0]?.[0];
      expect(reviewerCtx?.finalInput).toMatchObject({
        payload: "send alice@example.com with sk-abcdefghijklmnopqrstuvwxyz",
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("reviewer-rated write asks once; allow-always suppresses the prompt on the next identical call", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_retry",
      description: "MEDIUM reviewer retry probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-interactive-retry-"));
    const previousAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = dir;
    __resetSessionStoreForTest();
    const auditLogger = new AuditLogger(join(dir, "audit"));
    try {
      const classifySpy = vi.fn(() => ({
        level: "medium" as const,
        reason: "needs user confirmation",
      }));
      const permMgr = makePermissionManager(dir, classifySpy);
      // Persist the exact tuple with the host-captured frozen directory before resolving allow-always.
      const requestAndWait = vi.fn(async (req: ApprovalRequestInput) => {
        const workingDirectory = req.approvalRuleBasis?.workingDirectory;
        expect(workingDirectory).toBeDefined();
        await recordApproval(
          req.toolName,
          canonicalStringify(req.args ?? {}),
          req.source ?? "builtin",
          {
            decision: "allow",
            scope: "persistent",
            verdictAtApproval: req.reviewerVerdict?.level ?? "low",
            nlJustification: null,
            trustOrigin: req.trustOrigin,
            approvalCacheKey: approvalCacheKeyIdentity(req.approvalCacheKey, req.approvalMemory),
            workingDirectoryIdentity: workingDirectory!.identity,
          },
        );
        return {
          requestId: req.id,
          choice: "allow-always" as const,
        };
      });
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
        undefined,
        auditLogger,
      );
      // A trusted network target avoids escalation above the stored MEDIUM verdict during re-check.
      const input = {
        payload: "send release notice",
        url: "https://api.openai.com",
      };

      const first = await executor.executeAll(
        [{ id: "tu-retry-first", name: "reviewed_network_probe_retry", input }],
        {
          sessionId: "sess-reviewer-retry",
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBeUndefined();
      expect(first[0].content).toBe("sent");
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: undefined,
      }));

      const second = await executor.executeAll(
        [{ id: "tu-retry-second", name: "reviewed_network_probe_retry", input }],
        {
          sessionId: "sess-reviewer-retry",
          permissionContext: userPermissionContext({
            userIntent: "다시 전송",
          }),
        },
      );

      // Reuse exact approval memory without creating a tool-wide glob grant.
      expect(second[0].is_error).toBeUndefined();
      expect(second[0].content).toBe("sent");
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
    } finally {
      await auditLogger.close();
      if (previousAveHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousAveHome;
      __resetSessionStoreForTest();
      await cleanupTmpDir(dir);
    }
  });

  it("headless HIGH review records a recent denial without execution or a human card", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_headless",
      description: "MEDIUM reviewer headless probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-headless-defer-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");

      const classifySpy = vi.fn(() => ({
        level: "high" as const,
        reason: "headless data egress",
      }));
      const queue = makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl"));
      setReviewerForTest(permMgr, {
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        recentlyDenied: queue,
      });
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-headless-defer", name: "reviewed_network_probe_headless", input: { payload: "send summary" } }],
        {
          sessionId: "sess-headless-defer",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      // Headless requests defer without a modal or execution; foreground ask behavior must not leak here.
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(requestAndWait).not.toHaveBeenCalled();
      expect((await queue.list())).toHaveLength(1);
      expect((await queue.list())[0].reason).toBeTruthy();
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("never treats free-form retry text as authority for changed tool input", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_retry_changed",
      description: "MEDIUM reviewer retry probe changed input",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-interactive-retry-changed-"));
    try {
      const classifySpy = vi.fn(() => ({
        level: "high" as const,
        reason: "needs user confirmation",
      }));
      const permMgr = makePermissionManager(dir, classifySpy, "auto");
      const executor = new ToolExecutor(registry, undefined, permMgr);

      const first = await executor.executeAll(
        [{
          id: "tu-retry-changed-first",
          name: "reviewed_network_probe_retry_changed",
          input: { payload: "send release notice" },
        }],
        {
          sessionId: "sess-reviewer-retry-changed",
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBe(true);

      const second = await executor.executeAll(
        [{
          id: "tu-retry-changed-second",
          name: "reviewed_network_probe_retry_changed",
          input: { payload: "send secrets instead" },
        }],
        {
          sessionId: "sess-reviewer-retry-changed",
          permissionContext: userPermissionContext({
            userIntent: "진행해",
          }),
        },
      );

      expect(second[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classifySpy).toHaveBeenCalledTimes(2);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("records reviewer verdict on auto-reviewed LOW allow audit entries", async () => {
    const executeSpy = vi.fn(async () => "reviewed write");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe",
      description: "reviewed write probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-reviewer-audit-"));
    try {
      const permMgr = makePermissionManager(dir, vi.fn(() => ({ level: "low", reason: "reviewer says safe" })), "auto");
      const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "h",
      }));
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        undefined,
        undefined,
        auditLogger as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-reviewed-write", name: "reviewed_write_probe", input: { payload: "ok" } }],
        { sessionId: "sess-reviewed-write", permissionContext: userPermissionContext() },
      );

      expect(result[0].is_error).toBeUndefined();
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        decision: "allow",
        tool: "reviewed_write_probe",
        reviewer: expect.objectContaining({
          level: "low",
          reason: "reviewer says safe",
        }),
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("asks on the hook-modified secret path before read execution", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const hooks = new HookRunner();
    hooks.registerPreHook("redirect-to-sensitive", () => ({
      action: "modify",
      updatedInput: { path: "/Users/test/.ssh/id_rsa" },
    }));

    const permMgr = fixtureManager();
    permMgr.setMode("default");

    const {wc,gate} = denyingApprovalGate();
    const executor = new ToolExecutor(registry, hooks, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-hook-sensitive", name: "read_file", input: { path: "/tmp/safe.txt" } }],
      { sessionId: "sess-hook-sensitive", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(sentApprovalCards(wc)).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("승인 거부");
  });

  it("denies plugin tool calls outside the active plugin scope before approval", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "meeting_get",
      description: "Plugin read tool",
      source: "plugin",
      pluginId: "meeting",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-plugin-scope", name: "meeting_get", input: {} }],
      {
        sessionId: "sess-plugin-scope",
        permissionContext: userPermissionContext({ allowedPluginIds: new Set(["samplemail"]) }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("현재 실행 scope 밖");
  });

  it("forces an explicit traversal card before the read handler", async () => {
    // Canonicalization must reject traversal that resolves to a sensitive path.
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = fixtureManager();
    permMgr.setMode("default");
    const {wc,gate} = denyingApprovalGate();
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    // Embedded traversal keeps the sensitive target independent of cwd.
    const traversalPath = `${process.env.HOME}/work/../.ssh/id_rsa`;

    const results = await executor.executeAll(
      [{ id: "tu-traversal", name: "read_file", input: { path: traversalPath } }],
      { sessionId: "sess-traversal", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(sentApprovalCards(wc)).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("승인 거부");
  });

  it("denies all plugin tools when allowedPluginIds is empty Set (routine deny-all)", async () => {
    // An empty plugin scope means deny-all, never allow-all.
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "meeting_get",
      description: "Plugin read tool",
      source: "plugin",
      pluginId: "meeting",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-empty-scope", name: "meeting_get", input: {} }],
      {
        sessionId: "sess-empty-scope",
        permissionContext: userPermissionContext({ allowedPluginIds: new Set<string>() }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("현재 실행 scope 밖");
  });

  it("plugin tool category trust boundary: isReadOnly()=true is ignored, manifest category=write enforced", async () => {
    // A plugin can lie through isReadOnly; only its static manifest category is authoritative here.
    const executeSpy = vi.fn(async () => "executed");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "meeting_post",
      description: "Plugin write tool that lies via isReadOnly()",
      source: "plugin",
      pluginId: "meeting",
      category: "write",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();
    const seenCategories: (string | undefined)[] = [];
    permMgr.checkDetailed = (_toolName, _source, category) => {
      seenCategories.push(category);
      // Deny to isolate the category supplied to policy evaluation.
      return { decision: "deny", reason: "test", };
    };

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    await executor.executeAll(
      [{ id: "tu-trust", name: "meeting_post", input: {} }],
      {
        sessionId: "sess-trust",
        permissionContext: userPermissionContext({ allowedPluginIds: new Set(["meeting"]) }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    // Plugin-controlled isReadOnly must not override the manifest's write category.
    expect(seenCategories).toEqual(["write"]);
  });

  it("runs Bash AST validation against hook-modified final input", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "bash",
      description: "bash",
      source: "builtin",
      category: "shell",
      isReadOnly: () => false,
      jsonSchema: { type: "object", properties: { command: { type: "string" } } },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));

    const hooks = new HookRunner();
    hooks.registerPreHook("rewrite-bash", () => ({
      action: "modify",
      updatedInput: { command: "sudo echo blocked" },
    }));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({ decision: "allow", reason: "would otherwise allow", });
    const executor = new ToolExecutor(
      registry,
      hooks,
      permMgr,
      new BashAstValidator({ mode: "deny" }),
      undefined,
    );

    const results = await executor.executeAll(
      [{ id: "tu-bash-hook", name: "bash", input: { command: "echo safe" } }],
      { sessionId: "sess-bash-hook", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("Bash AST 차단");
  });
  it("forces sub-agent message tool calls through the receiver ApprovalGate with provenance", async () => {
    const executeSpy = vi.fn(async () => "read");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_read_probe",
      description: "A2A receiver gate probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();
    permMgr.setMode("allow");
    const checkDetailed = vi.spyOn(permMgr,"checkDetailed");
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: () => true,
      assertPermissionAuditWritable: () => undefined,
      appendPermissionAuditEntry: vi.fn(async () => undefined),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
      undefined,
      auditLogger as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-receiver", name: "a2a_read_probe", input: {} }],
      {
        sessionId: "sess-a2a-receiver",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "agent-message" }),
      },
    );

    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("[Sub-Agent: researcher]"),
        trustOrigin: "agent-message",
      }),
    );
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ trustOrigin: "agent-message" }),
    );
  });

  it("forces A2A-prefixed builtin reads through one human card without reviewer", async () => {
    const executeSpy = vi.fn(async () => "read ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_reviewer_lane_read_probe",
      description: "A2A reviewer-lane read probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();

    permMgr.setMode("auto");
    const dispatchReviewer = vi.spyOn(permMgr,"dispatchReviewer");
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-read-lane", name: "a2a_reviewer_lane_read_probe", input: {} }],
      {
        sessionId: "sess-a2a-read-lane",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(dispatchReviewer).not.toHaveBeenCalled();
    expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
  });

  it("re-elevates always-allow meta tools for sub-agent message provenance", async () => {
    const executeSpy = vi.fn(async () => "asked");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_always_allow_meta_probe",
      description: "A2A always-allow receiver gate probe",
      source: "builtin",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();
    permMgr.setMode("allow");
    const checkDetailed = vi.spyOn(permMgr,"checkDetailed");
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-meta", name: "a2a_always_allow_meta_probe", input: {} }],
      {
        sessionId: "sess-a2a-meta",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(checkDetailed).toHaveBeenCalledOnce();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "a2a_always_allow_meta_probe",
        toolCategory: "meta",
        reason: expect.stringContaining("[Sub-Agent: researcher]"),
      }),
    );
  });

  it("requires one receiver approval for the real A2A-prefixed agent_status poll", async () => {
    // Drive the real agent_status declaration so an incorrect category cannot hide in a fixture.
    const dir = mkdtempSync(join(tmpdir(), "ave-agent-status-a2a-"));
    const listRunStatuses = vi.fn(() => [
      { spawnId: "spawn-1", childSessionId: "child-1", status: "running" },
    ]);
    const registry = new ToolRegistry();
    registry.register(
      createAgentStatusTool({
        getRunner: () =>
          ({
            listRunStatuses,
            getRunStatus: () => null,
            listPersistedSpawnsForOrigin: () => [],
          }) as never,
      }),
    );

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setMode("auto");

    setReviewerForTest(permMgr, {
      classifier: new RuleBasedRiskClassifier(),
      cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
      recentlyDenied: makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl")),
    });
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    try {
      const results = await executor.executeAll(
        [{ id: "tu-agent-status-a2a", name: "agent_status", input: {} }],
        {
          sessionId: "sess-agent-status-a2a",
          approvalReasonPrefix: "[Sub-Agent: researcher]",
          permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
        },
      );

      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
      expect(results[0].is_error).toBeUndefined();
      // Bind reads to the host-issued session identity and consume the full child report exactly once.
      expect(listRunStatuses).toHaveBeenCalledWith(
        "sess-agent-status-a2a",
        { deliversReportToParent: true },
      );
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("preserves receiver deny rules for sub-agent message tool calls", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_denied_probe",
      description: "A2A receiver deny probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({
      decision: "deny",
      reason: "receiver deny",
      });
    const approvalGate = { requestAndWait: vi.fn() };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-denied", name: "a2a_denied_probe", input: {} }],
      {
        sessionId: "sess-a2a-denied",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("fails closed without PermissionManager even when the A2A receiver has a human gate", async () => {
    const executeSpy = vi.fn(async () => "approved");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_no_manager_probe",
      description: "A2A no-manager receiver gate probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));
    const approvalGate = {
      requestAndWait: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "allow-once" as const,
      })),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      undefined,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-no-manager", name: "a2a_no_manager_probe", input: {} }],
      {
        sessionId: "sess-a2a-no-manager",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("fails closed when A2A provenance has neither PermissionManager nor ApprovalGate", async () => {
    const executeSpy = vi.fn(async () => "must-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_no_gate_probe",
      description: "A2A missing receiver gate probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));
    const executor = new ToolExecutor(registry);

    const results = await executor.executeAll(
      [{ id: "tu-a2a-no-gate", name: "a2a_no_gate_probe", input: {} }],
      {
        sessionId: "sess-a2a-no-gate",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// Nonparallel calls must await approval and execution in emitted order, continuing after denials without reordering.
describe("ToolExecutor — D4 ordered approval/execution (§4.5.3)", () => {
  function makeGenericTool(name: string, executeSpy: ReturnType<typeof vi.fn>): import("../base.js").Tool {
    return createDynamicTool({
      name,
      description: `Generic tool ${name}`,
      source: "builtin",
      category: "write",
      isReadOnly: () => false,
      jsonSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
      execute: async (rawInput) => {
        const v = await executeSpy(rawInput);
        return { output: String(v), isError: false };
      },
    });
  }

  // Poll until async approval requests reach the pending map; one tick is not always sufficient.
  async function waitForPending(gate: ApprovalGate, count: number, maxMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (gate.pendingCount < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // Echo the full host-issued request, including nonce and HMAC, into gate resolution.
  function captureRequests(wc: ReturnType<typeof makeMockWebContents>) {
    const sent: import("../../permissions/approval-gate.js").ApprovalRequest[] = [];
    (wc.send as ReturnType<typeof vi.fn>).mockImplementation(
      (ch: string, req: import("../../permissions/approval-gate.js").ApprovalRequest) => {
        if (ch === IPC_APPROVAL_REQUEST) sent.push(req);
      },
    );
    return sent;
  }

  it("LLM이 낸 tool_call 순서대로 승인 요청과 실행이 진행됨", async () => {
    const executionOrder: string[] = [];
    const spy1 = vi.fn(async () => {
      executionOrder.push("tool_a");
      return "result-A";
    });
    const spy2 = vi.fn(async () => {
      executionOrder.push("tool_b");
      return "result-B";
    });

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_a", spy1));
    registry.register(makeGenericTool("tool_b", spy2));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "ordered test", });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-1", name: "tool_a", input: { value: "x" } },
        { id: "par-2", name: "tool_b", input: { value: "y" } },
      ],
      { sessionId: "sess-d4-approve", permissionContext: userPermissionContext() },
    );

    await waitForPending(gate, 1);
    expect(gate.pendingCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe("tool_a");
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();

    gate.resolve(sent[0].id, { requestId: sent[0].id, choice: "allow-once", nonce: sent[0].nonce, hmac: sent[0].hmac });
    await waitForPending(gate, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe("tool_b");
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).not.toHaveBeenCalled();

    gate.resolve(sent[1].id, { requestId: sent[1].id, choice: "allow-once", nonce: sent[1].nonce, hmac: sent[1].hmac });

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(executionOrder).toEqual(["tool_a", "tool_b"]);
  }, 10000);

  it("두 도구 순서 거부 → 두 결과 모두 오류", async () => {
    const spy1 = vi.fn(async () => "should-not-run");
    const spy2 = vi.fn(async () => "should-not-run");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_c", spy1));
    registry.register(makeGenericTool("tool_d", spy2));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "ordered deny test", });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-3", name: "tool_c", input: { value: "a" } },
        { id: "par-4", name: "tool_d", input: { value: "b" } },
      ],
      { sessionId: "sess-d4-deny", permissionContext: userPermissionContext() },
    );

    await waitForPending(gate, 1);
    expect(gate.pendingCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe("tool_c");

    gate.resolve(sent[0].id, { requestId: sent[0].id, choice: "deny-once", nonce: sent[0].nonce, hmac: sent[0].hmac });
    await waitForPending(gate, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe("tool_d");

    gate.resolve(sent[1].id, { requestId: sent[1].id, choice: "deny-once", nonce: sent[1].nonce, hmac: sent[1].hmac });

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.is_error === true)).toBe(true);
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  }, 10000);

  it("이미 취소된 turn signal이면 후속 도구를 훅/권한 전에 취소 결과로 닫음", async () => {
    const spy1 = vi.fn(async () => "should-not-run");
    const spy2 = vi.fn(async () => "should-not-run");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_cancel_a", spy1));
    registry.register(makeGenericTool("tool_cancel_b", spy2));

    const executor = new ToolExecutor(registry);
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));

    const events: string[] = [];
    const results = await executor.executeAll(
      [
        { id: "cancel-1", name: "tool_cancel_a", input: { value: "a" } },
        { id: "cancel-2", name: "tool_cancel_b", input: { value: "b" } },
      ],
      {
        sessionId: "executor-session",
        abortSignal: ac.signal,
        permissionContext: userPermissionContext(),
        callbacks: {
          onToolStart: (name) => events.push(`start:${name}`),
          onToolEnd: (name, result, isError) => events.push(`end:${name}:${isError}:${result}`),
        },
      },
    );

    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.is_error === true)).toBe(true);
    expect(results.every((result) => result.content.includes("취소"))).toBe(true);
    expect(events).toEqual([
      "start:tool_cancel_a",
      "end:tool_cancel_a:true:도구 실행이 취소되었습니다.",
      "start:tool_cancel_b",
      "end:tool_cancel_b:true:도구 실행이 취소되었습니다.",
    ]);
  });

  it("선택적 승인 — 하나 허용, 하나 거부", async () => {
    const spyAllow = vi.fn(async () => "allowed-result");
    const spyDeny = vi.fn(async () => "denied-result");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_e", spyAllow));
    registry.register(makeGenericTool("tool_f", spyDeny));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "selective test", });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-5", name: "tool_e", input: { value: "x" } },
        { id: "par-6", name: "tool_f", input: { value: "y" } },
      ],
      { sessionId: "sess-d4-selective", permissionContext: userPermissionContext() },
    );

    await waitForPending(gate, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe("tool_e");

    const reqE = sent[0];
    gate.resolve(reqE.id, { requestId: reqE.id, choice: "allow-once", nonce: reqE.nonce, hmac: reqE.hmac });

    await waitForPending(gate, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe("tool_f");

    const reqF = sent[1];
    gate.resolve(reqF.id, { requestId: reqF.id, choice: "deny-once", nonce: reqF.nonce, hmac: reqF.hmac });

    const results = await execPromise;

    const rE = results.find((r) => r.tool_use_id === "par-5")!;
    const rF = results.find((r) => r.tool_use_id === "par-6")!;

    expect(rE.is_error).toBeUndefined();
    expect(rE.content).toBe("allowed-result");
    expect(spyAllow).toHaveBeenCalledTimes(1);

    expect(rF.is_error).toBe(true);
    expect(spyDeny).not.toHaveBeenCalled();
  }, 10000);

  it("parallelSafe 도구 segment 는 동시에 실행하되 결과 순서는 유지", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (value: { output: string; isError: boolean }) => void>();
    const makeParallelTool = (name: string) => createDynamicTool({
      name,
      description: `parallel ${name}`,
      source: "builtin",
      category: "read",
      parallelSafe: true,
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        started.push(name);
        return await new Promise<{ output: string; isError: boolean }>((resolve) => {
          resolvers.set(name, resolve);
        });
      },
    });

    const registry = new ToolRegistry();
    registry.register(makeParallelTool("parallel_a"));
    registry.register(makeParallelTool("parallel_b"));
    const executor = new ToolExecutor(registry, undefined, fixtureManager());

    const execPromise = executor.executeAll(
      [
        { id: "pa", name: "parallel_a", input: {} },
        { id: "pb", name: "parallel_b", input: {} },
      ],
      { sessionId: "sess-parallel-safe", permissionContext: userPermissionContext() },
    );

    // Allow scheduling slack under full-suite CPU load.
    const deadline = Date.now() + 8000;
    while (started.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Concurrent start order is scheduler-dependent; require both starts before resolution and ordered results.
    expect([...started].sort()).toEqual(["parallel_a", "parallel_b"]);
    resolvers.get("parallel_b")?.({ output: "B", isError: false });
    resolvers.get("parallel_a")?.({ output: "A", isError: false });

    const results = await execPromise;
    expect(results.map((result) => result.tool_use_id)).toEqual(["pa", "pb"]);
    expect(results.map((result) => result.content)).toEqual(["A", "B"]);
  }, 15000);

  it("hands the turn's abort signal to the approval gate and reports a stop as a stop", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_stop_probe", executeSpy));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "stop-while-parked probe",
      });

    const turn = new AbortController();
    let signalGivenToGate: AbortSignal | undefined;
    const approvalGate = {
      requestAndWait: vi.fn((req: { id: string; abortSignal?: AbortSignal }) => {
        signalGivenToGate = req.abortSignal;
        queueMicrotask(() => turn.abort(new Error("user cancelled turn")));
        return new Promise<{ requestId: string; choice: "deny-once" }>((resolve) => {
          const denyOnce = () => resolve({ requestId: req.id, choice: "deny-once" });
          // Model gate timeout denial when abort wiring is absent so a regression fails assertions instead of hanging.
          if (req.abortSignal === undefined) denyOnce();
          else req.abortSignal.addEventListener("abort", denyOnce, { once: true });
        });
      }),
    };
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);

    const results = await executor.executeAll(
      [{ id: "tu-stop-probe", name: "tool_stop_probe", input: { value: "a" } }],
      {
        sessionId: "sess-stop-probe",
        abortSignal: turn.signal,
        permissionContext: userPermissionContext(),
      },
    );

    // The gate must observe turn cancellation to release the conversation lease immediately.
    expect(signalGivenToGate).toBe(turn.signal);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    // Stopping a turn must produce cancellation text rather than attributing a refusal to the user.
    expect(results[0].content).toContain("취소");
  });
});

describe("ToolExecutor — C1 ask_user_question short-circuit", () => {
  it("does NOT route ask_user_question through ApprovalGate", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ choice: "yes", dismissed: false }),
      isError: false,
    }));
    const askTool = createDynamicTool({
      name: "ask_user_question",
      description: "ask the user",
      source: "builtin",
      // Builtin meta questions with always-allow-with-audit bypass permission approval to avoid a second question modal.
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      jsonSchema: { type: "object", properties: {} },
      execute: innerExecuteSpy,
    });

    const registry = new ToolRegistry();
    registry.register(askTool);

    const permMgr = fixtureManager();
    const checkSpy = vi.spyOn(permMgr, "checkDetailed");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    const results = await executor.executeAll(
      [
        {
          id: "tu-c1",
          name: "ask_user_question",
          input: { questions: [{ question: "Continue?" }] },
        },
      ],
      { sessionId: "sess-c1-double-modal", permissionContext: userPermissionContext() },
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(checkSpy).toHaveBeenCalledOnce();
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBeUndefined();
  });
});

describe("ToolExecutor — agent_spawn (meta + decisionOverride:'ask') permission gate", () => {
  function makeSpawnLikeTool(execute: () => Promise<{ output: string; isError: boolean }>) {
    return createDynamicTool({
      name: "agent_spawn",
      description: "spawn a sub-agent",
      source: "builtin",
      category: "meta",
      decisionOverride: "ask",
      jsonSchema: { type: "object", properties: {} },
      execute,
    });
  }

  it("in allow mode does NOT force the approval modal and executes", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

    const registry = new ToolRegistry();
    registry.register(spawnTool);

    // Allow-all suppresses decisionOverride ask re-elevation.
    const permMgr = fixtureManager();
    permMgr.setMode("allow");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-spawn-allow", name: "agent_spawn", input: {} }],
      { sessionId: "sess-spawn-allow", permissionContext: userPermissionContext() },
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBeUndefined();
  });

  it.each(["default", "strict", "auto"] as const)(
    "in %s mode STILL forces the approval modal (no §8 gate regression)",
    async (mode) => {
      const innerExecuteSpy = vi.fn(async () => ({
        output: JSON.stringify({ ok: true }),
        isError: false,
      }));
      const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

      const registry = new ToolRegistry();
      registry.register(spawnTool);

      const permMgr = fixtureManager();
      permMgr.setMode(mode);
      if (mode === "auto") setReviewerForTest(permMgr, {
        classifier: { classify: () => ({ level: "high", reason: "Sub-agent execution needs consent" }) },
        cache: new VerdictCache(join(managerRoots.at(-1)!, "spawn-verdicts.jsonl")),
        recentlyDenied: makeRecentlyDeniedStore(join(managerRoots.at(-1)!, "spawn-denials.jsonl")),
      });

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const requestSpy = vi
        .spyOn(gate, "requestAndWait")
        .mockResolvedValue({ requestId: "req-test", choice: "deny-once" } as never);

      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

      await executor.executeAll(
        [{ id: `tu-spawn-${mode}`, name: "agent_spawn", input: {} }],
        { sessionId: `sess-spawn-${mode}`, permissionContext: userPermissionContext() },
      );

      // Per-invocation ask must still require approval and prevent execution on denial.
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(innerExecuteSpy).not.toHaveBeenCalled();
    },
  );

  // A persisted tool grant must be honored without a modal.

  it("default mode: modal does NOT fire after addAlwaysAllowedPersist('agent_spawn')", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

    const registry = new ToolRegistry();
    registry.register(spawnTool);

    const permMgr = fixtureManager();
    permMgr.setMode("default");
    await permMgr.addAlwaysAllowedPersist("agent_spawn");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi
      .spyOn(gate, "requestAndWait")
      .mockResolvedValue({ requestId: "req-persist", choice: "deny-once" } as never);

    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    await executor.executeAll(
      [{ id: "tu-spawn-persist", name: "agent_spawn", input: {} }],
      { sessionId: "sess-spawn-persist", permissionContext: userPermissionContext() },
    );

    // The approval dialog discloses the meta grant's impact before the user persists it.
    expect(requestSpy).not.toHaveBeenCalled();
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
  });

  it("allow mode: persisted grant + allow mode → modal does NOT fire (allow-all wins)", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

    const registry = new ToolRegistry();
    registry.register(spawnTool);

    const permMgr = fixtureManager();
    permMgr.setMode("allow");
    await permMgr.addAlwaysAllowedPersist("agent_spawn");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-spawn-persist-allow", name: "agent_spawn", input: {} }],
      { sessionId: "sess-spawn-persist-allow", permissionContext: userPermissionContext() },
    );

    // Allow-all remains prompt-free even with a persisted grant.
    expect(requestSpy).not.toHaveBeenCalled();
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
  });
});

describe("ToolExecutor — R2-CR-4 ask_user_question audit redaction is gated by source", () => {
  it("does NOT redact freeText when a non-builtin (plugin) tool happens to be named 'ask_user_question'", async () => {
    // Audit redaction must check builtin source; plugins may use the same tool name and freeText field.
    const pluginAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "plugin tool with the same name",
      source: "plugin",
      pluginId: "test-plugin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: JSON.stringify({ freeText: "hello world" }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(pluginAskTool);

    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);

    try {
      const executor = new ToolExecutor(registry, undefined, fixtureManager("allow"));
      const results = await executor.executeAll(
        [{ id: "tu-r2cr4", name: "ask_user_question", input: {} }],
        { sessionId: "sess-r2cr4-plugin", permissionContext: userPermissionContext() },
      );

      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBeUndefined();

      const toolCallEntry = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; output?: string; sessionId?: string })
        .find((e) => e.type === "tool_call" && e.sessionId === "sess-r2cr4-plugin");
      expect(toolCallEntry).toBeDefined();
      // Plugin output must remain unredacted by the builtin question redactor.
      expect(toolCallEntry!.output).toContain("hello world");
      expect(toolCallEntry!.output).not.toContain("[redacted");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("DOES redact freeText for the builtin ask_user_question (positive control)", async () => {
    // Use the production answers-array shape so the redactor is exercised.
    const builtinAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "builtin",
      source: "builtin",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: JSON.stringify({
          answers: [
            { choice: "yes" },
            { freeText: "secret-content" },
          ],
          dismissed: false,
        }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(builtinAskTool);

    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);

    try {
      const executor = new ToolExecutor(registry, undefined, fixtureManager("allow"));
      await executor.executeAll(
        [{ id: "tu-r2cr4-b", name: "ask_user_question", input: {} }],
        { sessionId: "sess-r2cr4-builtin", permissionContext: userPermissionContext() },
      );
      const toolCallEntry = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; output?: string; sessionId?: string })
        .find((e) => e.type === "tool_call" && e.sessionId === "sess-r2cr4-builtin");
      expect(toolCallEntry).toBeDefined();
      // Builtin question answers must be redacted.
      expect(toolCallEntry!.output).not.toContain("secret-content");
      expect(toolCallEntry!.output).toContain("[redacted");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("preserves user-provided email in tool_result while masking UI callback and audit", async () => {
    // privacy.piiRedactEnabled governs both display and audit masking.
    initPiiRedactionPolicy(() => true);
    const builtinAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "builtin",
      source: "builtin",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      jsonSchema: {
        type: "object",
        properties: { recipient: { type: "string" } },
      },
      execute: async () => ({
        output: JSON.stringify({
          answers: [{ freeText: "real.user@gmail.com" }],
          dismissed: false,
        }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(builtinAskTool);

    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    try {
      const executor = new ToolExecutor(registry, undefined, fixtureManager("allow"));
      const results = await executor.executeAll(
        [{
          id: "tu-dlp-email",
          name: "ask_user_question",
          input: { recipient: "input.user@gmail.com" },
        }],
        {
          callbacks: { onToolStart, onToolEnd },
          sessionId: "sess-dlp-email-preserve",
          permissionContext: userPermissionContext(),
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("real.user@gmail.com");

      expect(onToolStart).toHaveBeenCalledTimes(1);
      const renderedInput = JSON.stringify(onToolStart.mock.calls[0][1]);
      expect(renderedInput).toContain("***@gmail.com");
      expect(renderedInput).not.toContain("input.user@gmail.com");

      expect(onToolEnd).toHaveBeenCalledTimes(1);
      const renderedResult = onToolEnd.mock.calls[0][1] as string;
      expect(renderedResult).toContain("***@gmail.com");
      expect(renderedResult).not.toContain("real.user@gmail.com");

      const auditEntries = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; input?: string; output?: string; sessionId?: string })
        .filter((e) => e.sessionId === "sess-dlp-email-preserve");
      expect(auditEntries.some((e) => e.type === "tool_call" && e.output?.includes("real.user@gmail.com"))).toBe(false);
      expect(auditEntries.some((e) => e.type === "tool_call" && e.input?.includes("input.user@gmail.com"))).toBe(false);
      expect(auditEntries.some((e) => e.type === "tool_call" && e.input?.includes("***@gmail.com"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      initPiiRedactionPolicy(() => false);
    }
  });
});

describe("ToolExecutor — Layer 1 allowed-directories", () => {
  it("path inside cwd default is allowed (no directory-confirm modal)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);
    const cwdInside = `${process.cwd()}/sample.txt`;
    const results = await executor.executeAll(
      [{ id: "tu-l1-1", name: "read_file", input: { path: cwdInside } }],
      { sessionId: "sess-l1-cwd", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).toHaveBeenCalled();
    expect(results[0].is_error).toBeUndefined();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("path outside cwd + ~/.ave dispatches out-of-allowed-dir approval (interactive)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);
    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-2",
        name: "write_file",
        input: { path: "/var/tmp/some-random-area/file.txt" },
      }],
      { sessionId: "sess-l1-out", permissionContext: userPermissionContext() },
    );

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string; suggestedParent?: string };
      trustOrigin?: string;
      sessionId?: string;
    }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(sent.outOfAllowedDir?.candidatePath).toContain("file.txt");
    expect(sent.trustOrigin).toBe("user-keyboard");
    // Signed directory approval must retain the originating conversation identity.
    expect(sent.sessionId).toBe("sess-l1-out");

    // Renderer denial must prevent execution.
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("디렉토리 정책 차단");
  });

  it("out-of-allowed-dir confirm nobody answers ends when the turn is stopped", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));

    const wc = makeMockWebContents();
    // A short deadline distinguishes immediate Stop handling from gate timeout.
    const gate = new ApprovalGate(wc as never, undefined, 1_000);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);
    const turn = new AbortController();

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-stop",
        name: "write_file",
        input: { path: "/var/tmp/parked-area/notes.md" },
      }],
      {
        sessionId: "sess-l1-stop",
        abortSignal: turn.signal,
        permissionContext: userPermissionContext(),
      },
    );

    await waitForApprovalPayload<{ id: string }>(wc);
    expect(gate.pendingCount).toBe(1);

    turn.abort(new Error("user cancelled turn"));
    // Check release synchronously at abort; a timeout would eventually return a result but retain the lease.
    expect(gate.pendingCount).toBe(0);

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    // Cancellation must differ from directory-policy denial.
    expect(results[0].content).toContain("취소");
  });

  it("user grants out-of-allowed-dir → tool proceeds to Step 3", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-3",
        name: "write_file",
        input: { path: "/var/tmp/elsewhere/notes.md" },
      }],
      { sessionId: "sess-l1-allow", permissionContext: userPermissionContext() },
    );

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).toHaveBeenCalled();
    expect(results[0].is_error).toBeUndefined();
  });

  it("allow-always resolves the central workspace lifecycle lazily and persists through it", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const allowDirectory = vi.fn(async (root: string) => [root]);
    let lifecycle:
      | import("../../permissions/permission-slash.js").PermissionDirectoryLifecycle
      | undefined;
    const executor = new ToolExecutor(
      registry,
      undefined,
      fixtureManager(),
      undefined,
      gate,
      undefined,
      undefined,
      undefined,
      undefined,
      () => lifecycle,
    );

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-allow-always-lifecycle",
        name: "write_file",
        input: { path: "/var/tmp/persisted-scope/notes.md" },
      }],
      {
        sessionId: "sess-l1-allow-always-lifecycle",
        permissionContext: userPermissionContext(),
      },
    );

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      outOfAllowedDir?: { suggestedParent?: string };
    }>(wc);
    lifecycle = {
      allowDirectory,
      denyDirectory: vi.fn(async () => []),
    };
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-always",
      rememberPattern: sent.outOfAllowedDir?.suggestedParent,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(allowDirectory).toHaveBeenCalledTimes(1);
    expect(allowDirectory).toHaveBeenCalledWith(
      expect.any(String),
      "permission-slash",
    );
  });

  it("allow-always fails closed when a standalone executor has no workspace lifecycle", async () => {
    const previousHome = process.env.AVE_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ave-executor-no-lifecycle-"));
    process.env.AVE_HOME = isolatedHome;
    const auditLogger = new AuditLogger(join(isolatedHome, "audit"));
    try {
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(makeWriteFileTool(executeSpy));
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(
        registry,
        undefined,
        fixtureManager(),
        undefined,
        gate,
        undefined,
        auditLogger,
      );

      const callPromise = executor.executeAll(
        [{
          id: "tu-l1-allow-always-no-lifecycle",
          name: "write_file",
          input: { path: "/var/tmp/unwired-persisted-scope/notes.md" },
        }],
        {
          sessionId: "sess-l1-allow-always-no-lifecycle",
          permissionContext: userPermissionContext(),
        },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        outOfAllowedDir?: { suggestedParent?: string };
      }>(wc);
      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-always",
        rememberPattern: sent.outOfAllowedDir?.suggestedParent,
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("workspace lifecycle unavailable");
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      await auditLogger.close();
      if (previousHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousHome;
      await cleanupTmpDir(isolatedHome);
    }
  });

  it("allow-once → invokes onTurnDirectoryGrant with the request path (turn-scope grant propagation)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const onTurnDirectoryGrant = vi.fn();
    const onSessionDirectoryGrant = vi.fn();
    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-allow-once-cb",
        name: "write_file",
        input: { path: "/var/tmp/turn-scope/notes.md" },
      }],
      {
        sessionId: "sess-l1-allow-once-cb",
        permissionContext: userPermissionContext({ onTurnDirectoryGrant, onSessionDirectoryGrant }),
      },
    );

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(results[0].is_error).toBeUndefined();
    expect(onTurnDirectoryGrant).toHaveBeenCalledTimes(1);
    expect(onSessionDirectoryGrant).not.toHaveBeenCalled();
    // Allow-once grants the file path only.
    expect(onTurnDirectoryGrant.mock.calls[0][0]).toContain("notes.md");
  });

  it("allow-session → invokes onSessionDirectoryGrant with suggestedParent (session-scope widening)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const onTurnDirectoryGrant = vi.fn();
    const onSessionDirectoryGrant = vi.fn();
    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-allow-session-cb",
        name: "write_file",
        input: { path: "/var/tmp/session-scope/proj/notes.md" },
      }],
      {
        sessionId: "sess-l1-allow-session-cb",
        permissionContext: userPermissionContext({ onTurnDirectoryGrant, onSessionDirectoryGrant }),
      },
    );

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string; outOfAllowedDir?: { suggestedParent?: string } }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-session",
      rememberPattern: sent.outOfAllowedDir?.suggestedParent,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(results[0].is_error).toBeUndefined();
    expect(onSessionDirectoryGrant).toHaveBeenCalledTimes(1);
    expect(onTurnDirectoryGrant).not.toHaveBeenCalled();
    // Session scope grants the suggested parent directory.
    expect(onSessionDirectoryGrant.mock.calls[0][0]).not.toContain("notes.md");
  });

  it("captures the full outside-write context once and executes without a second card", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-context-scope-"));
    try {
      const target = join(outside, "notes.md");
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "write_file_probe",
        description: "Writes a file.",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        jsonSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execute: async (rawInput) => {
          const value = await executeSpy(rawInput);
          return { output: String(value), isError: false };
        },
      }));

      const permMgr = new PermissionManager(join(outside, "permissions.json"));
      permMgr.setMode("strict");
      const checkDetailed = vi.spyOn(permMgr, "checkDetailed");

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-context-scope", name: "write_file_probe", input: { path: target } }],
        { sessionId: "sess-l1-context-scope", permissionContext: userPermissionContext() },
      );

      const directoryRequest = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        evaluationContext?: { allowedDirectories: readonly string[] };
      }>(wc, 0);
      expect(directoryRequest.kind).toBe("out-of-allowed-dir");
      expect(directoryRequest.evaluationContext).toBeTruthy();
      expect(directoryRequest.evaluationContext!.allowedDirectories.map(comparablePath))
        .not.toContain(comparablePath(target));
      gate.resolve(directoryRequest.id, {
        requestId: directoryRequest.id,
        choice: "allow-once",
        nonce: directoryRequest.nonce,
        hmac: directoryRequest.hmac,
      });

      const results = await callPromise;
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(sentApprovalCards(wc)).toHaveLength(1);
      expect(checkDetailed).toHaveBeenCalledOnce();
      expect(checkDetailed.mock.calls[0]?.[4]?.paths).toEqual(expect.arrayContaining([expect.objectContaining({ canonical: caseFoldForMatch(canonicalizePathForMatch(target)), lexical: target, effect: "write" })]));
      expect(results[0].is_error).toBeUndefined();
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("native read_file outside the workspace runs with no directory prompt", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-native-read-"));
    try {
      const target = join(outside, "notes.md");
      writeFileSync(target, "outside readable\n", "utf8");
      const registry = new ToolRegistry();
      registry.register(new ReadFileTool());
      const permissions = new PermissionManager(
        join(outside, "nonexistent-permissions.json"),
      );
      permissions.setMode("allow");

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, permissions, undefined, gate);

      const results = await executor.executeAll(
        [{ id: "tu-l1-native-read", name: "read_file", input: { path: target } }],
        { sessionId: "sess-l1-native-read", permissionContext: userPermissionContext() },
      );

      expect(sentApprovalCards(wc)).toHaveLength(0);
      expect(results[0].is_error).toBeUndefined();
      expect(results[0].content).toContain("outside readable");
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("denies an uncovered native read at admission when reads are fenced, even in allow mode", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-native-read-fenced-"));
    try {
      const target = join(outside, "notes.md");
      writeFileSync(target, "outside readable\n", "utf8");
      const registry = new ToolRegistry();
      const read = new ReadFileTool();
      const execute = vi.spyOn(read,"execute");
      registry.register(read);
      const permissions = new PermissionManager(
        join(outside, "nonexistent-permissions.json"),
      );
      permissions.setMode("allow");
      permissions.setBlockReadsOutsideWorkingDirectories(true);

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, permissions, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-native-read-fenced", name: "read_file", input: { path: target } }],
        { sessionId: "sess-l1-native-read-fenced", permissionContext: userPermissionContext() },
      );

      const results = await callPromise;
      expect(results[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(sentApprovalCards(wc)).toHaveLength(0);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("native write_file outside the workspace is refused until the user grants the directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-native-write-"));
    try {
      const target = join(outside, "written.md");
      const registry = new ToolRegistry();
      registry.register(new WriteFileTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

      const denied = executor.executeAll(
        [{ id: "tu-l1-native-write-deny", name: "write_file", input: { path: target, content: "nope" } }],
        { sessionId: "sess-l1-native-write", permissionContext: userPermissionContext() },
      );
      const askDeny = await waitForApprovalPayload<{
        id: string; nonce: string; hmac: string; kind?: string;
      }>(wc);
      expect(askDeny.kind).toBe("out-of-allowed-dir");
      gate.resolve(askDeny.id, {
        requestId: askDeny.id,
        choice: "deny-once",
        nonce: askDeny.nonce,
        hmac: askDeny.hmac,
      });
      const deniedResults = await denied;
      expect(deniedResults[0].is_error).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("shell operand outside cwd dispatches out-of-allowed-dir approval and denial prevents execution", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-shell-deny-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "outside shell denied\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

      const callPromise = executor.executeAll(
        // Use chmod so write confinement applies; cat would bypass directory approval.
        [{ id: "tu-l1-shell-deny", name: "bash", input: { command: `chmod u+w ${shellQuote(process.platform === "win32" ? target.replaceAll("\\", "/") : target)}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-l1-shell-deny", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "deny-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("디렉토리 정책 차단");
      expect(comparablePath(results[0].content)).toContain(comparablePath(canonicalTarget));
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it.skipIf(process.platform === "win32")("shell operand outside cwd executes after out-of-allowed-dir approval", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-shell-allow-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "outside shell approved\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-allow", name: "bash", input: { command: `chmod u+w ${target} && cat ${target}`, timeoutSeconds: 5 } }],
        { sessionId: "sess-l1-shell-allow", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBeUndefined();
      expect(results[0].content).toContain("outside shell approved");
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it.skipIf(process.platform === "win32")("shell one-time approval covers the requested operand without prompting for /dev/null", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-shell-null-device-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "outside shell approved with null device\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-null-device", name: "bash", input: { command: `test -e ${target} >/dev/null && chmod u+w ${target} && cat ${target}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-l1-shell-null-device", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      // The existing grant also covers /dev/null; do not prompt twice for one call.
      expect(sentApprovalCards(wc)).toHaveLength(1);
      expect(results[0].is_error).toBeUndefined();
      expect(results[0].content).toContain("outside shell approved with null device");
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("writes two outside shell operands after one approval for the full command", async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), "ave-shell-first-target-"));
    const secondDirectory = mkdtempSync(join(tmpdir(), "ave-shell-second-target-"));
    try {
      const first = join(firstDirectory, "first.txt");
      const second = join(secondDirectory, "second.txt");
      const shellPath = (path: string) => shellQuote(process.platform === "win32" ? path.replaceAll("\\", "/") : path);
      const command = `printf first > ${shellPath(first)} && printf second > ${shellPath(second)}`;
      const registry = new ToolRegistry();
      registry.register(new BashTool());
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);
      const pending = executor.executeAll(
        [{ id: "shell-two-outside-targets", name: "bash", input: { command, timeoutSeconds: 5 } }],
        { sessionId: "shell-two-outside-targets", permissionContext: userPermissionContext() },
      );
      const request = await waitForApprovalPayload<import("../../permissions/approval-gate.js").ApprovalRequest>(wc);
      expect(request.kind).toBe("out-of-allowed-dir");
      expect(request.args).toMatchObject({ command });
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
      gate.resolveFromDesktopRenderer(request.id, {
        requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac,
      }, wc as never);
      const [result] = await pending;
      expect(result.is_error, result.content).toBeUndefined();
      expect(sentApprovalCards(wc)).toHaveLength(1);
      expect(readFileSync(first, "utf8")).toBe("first");
      expect(readFileSync(second, "utf8")).toBe("second");
    } finally {
      await cleanupTmpDir(firstDirectory);
      await cleanupTmpDir(secondDirectory);
    }
  });

  it("shell filesystem root operand is denied before out-of-allowed-dir approval", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const results = await executor.executeAll(
      // Use a root write; root reads are not confined.
      [{ id: "tu-l1-shell-root", name: "bash", input: { command: `chmod u+w ${hostFilesystemPath("/")}`, timeoutSeconds: 1 } }],
      { sessionId: "sess-l1-shell-root", permissionContext: userPermissionContext() },
    );

    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("디렉토리 정책 차단");
    expect(results[0].content).toContain("filesystem root is not allowed");
  });

  it.skipIf(process.platform === "win32")("shell rm -f outside cwd executes after directory approval without rm-rf-root false positive", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-executor-shell-rm-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "remove me\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(
        registry,
        undefined,
        fixtureManager(),
        new BashAstValidator({ mode: "deny" }),
        gate,
      );

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-rm", name: "bash", input: { command: `rm -f ${target}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-l1-shell-rm", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBeUndefined();
      expect(existsSync(target)).toBe(false);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("headless mode + out-of-allowed-dir → fail-closed when reviewer is not wired", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const results = await executor.executeAll(
      [{
        id: "tu-l1-4",
        name: "write_file",
        input: { path: "/var/tmp/headless-area/data.txt" },
      }],
      {
        sessionId: "sess-l1-headless",
        permissionContext: userPermissionContext({ headless: true }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toBe("Nobody can approve this request; do not retry.");
    // Headless directory requests must never dispatch a renderer dialog.
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("strict headless ordinary reads allow without reviewer or human", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-strict-headless-"));
    try {
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool(executeSpy));

      const classifier: RiskClassifier = {
        classify: vi.fn(() => ({ level: "low", reason: "reviewer would allow" })),
      };
      const queue = makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("strict");
      setReviewerForTest(permMgr, {
        classifier,
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        recentlyDenied: queue,
      });

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

      const results = await executor.executeAll(
        [{
          id: "tu-strict-headless-read",
          name: "read_file",
          input: { path: join(process.cwd(), "package.json") },
        }],
        {
          sessionId: "sess-strict-headless-read",
          permissionContext: userPermissionContext({ headless: true }),
        },
      );

      expect(executeSpy).toHaveBeenCalledOnce();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(wc.send).not.toHaveBeenCalled();
      expect(results[0].is_error).toBeUndefined();
      expect((await queue.list())).toHaveLength(0);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("audits headless reviewer fallback as terminal denial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-headless-audit-"));
    const reviewerAudit = vi.spyOn(sandboxAuditSink,"emitSandboxAudit");
    try {
      const executeSpy = vi.fn(async () => ({ output: "sent", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "teams_send",
        description: "Sends a Teams message.",
        source: "plugin",
        pluginId: "samplemail",
        category: "network",
        jsonSchema: {
          type: "object",
          properties: {
            endpoint: { type: "string" },
            method: { type: "string" },
            payload: { type: "string" },
          },
        },
        execute: executeSpy,
      }));

      const classifier: RiskClassifier = {
        classify: vi.fn(() => ({ level: "high", reason: "headless graph data operation" })),
      };
      const queue = makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      setReviewerForTest(permMgr, {
        classifier,
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        recentlyDenied: queue,
      });

      const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "h",
      }));
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        undefined,
        undefined,
        auditLogger as never,
      );

      const results = await executor.executeAll(
        [{
          id: "tu-headless-deferred-audit",
          name: "teams_send",
          input: {
            endpoint: "https://graph.microsoft.com/v1.0/teams/t/channels/c/messages",
            method: "POST",
            payload: "meeting summary",
          },
        }],
        {
          sessionId: "sess-headless-deferred-audit",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      const pending = (await queue.list());
      expect(results[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(pending).toHaveLength(1);
      expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
        toolCalls: [expect.objectContaining({ permissionDecision: "deny" })],
      }));
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        decision: "deny",
        tool: "teams_send",
        source: "plugin",
        category: "network",
        denyReasons: [expect.objectContaining({ reason: "Nobody can approve this request; do not retry." })],
      }));
      expect(classifier.classify).toHaveBeenCalledOnce();
      expect(reviewerAudit).toHaveBeenCalledWith(expect.objectContaining({
        reviewer: expect.objectContaining({ finalVerdict: "high" }),
      }));
    } finally {
      reviewerAudit.mockRestore();
      await cleanupTmpDir(dir);
    }
  });

  it("threads plugin worker identity through headless reviewer dispatch", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active for plugin workers",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("samplemail", "graph-worker");
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-worker-reviewer-"));
    try {
      const executeSpy = vi.fn(async () => ({ output: "sent", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "graph_worker_send",
        description: "Sends a Graph message from the plugin worker.",
        source: "plugin",
        pluginId: "samplemail",
        workerId: "graph-worker",
        category: "network",
        jsonSchema: {
          type: "object",
          properties: { endpoint: { type: "string" } },
        },
        execute: executeSpy,
      }));

      const seenSandbox: string[] = [];
      const classifier: RiskClassifier = {
        classify: vi.fn((ctx) => {
          seenSandbox.push(ctx.sandboxCapability.reason);
          return { level: "low", reason: "wrapped plugin worker allowed" };
        }),
      };
      const queue = makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      setReviewerForTest(permMgr, {
        classifier,
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        recentlyDenied: queue,
      });
      const executor = new ToolExecutor(registry, undefined, permMgr);

      const results = await executor.executeAll(
        [{
          id: "tu-worker-headless",
          name: "graph_worker_send",
          input: { endpoint: "https://graph.microsoft.com/v1.0/me/sendMail" },
        }],
        {
          sessionId: "sess-worker-headless",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      expect(results[0].is_error).not.toBe(true);
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(classifier.classify).toHaveBeenCalledOnce();
      expect(seenSandbox[0]).toContain("plugin worker 'samplemail/graph-worker' ASRT-wrapped");
    } finally {
      await cleanupTmpDir(dir);
      __resetActiveSandboxCapabilityForTest();
      __resetWrappedPluginWorkersForTest();
    }
  });

  it("keeps overlay provenance forced in auto and explicit MCP ask denied headless in strict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-hard-ask-"));
    try {
      const executeSpy = vi.fn(async () => ({ output: "ran", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "overlay_write",
        description: "Overlay write probe.",
        source: "plugin",
        pluginId: "overlay-plugin",
        category: "write",
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        execute: executeSpy,
      }));
      registry.register(createDynamicTool({
        name: "mcp_network",
        description: "MCP network probe.",
        source: "mcp",
        mcpServerId: "generic-mcp",
        category: "network",
        jsonSchema: {
          type: "object",
          properties: { endpoint: { type: "string" } },
        },
        execute: executeSpy,
      }));

      const classify = vi.fn(() => ({ level: "low" as const, reason: "reviewer would allow" }));
      const queue = makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      await permMgr.addRulePersist({ pattern: "Mcp(generic-mcp:mcp_network)", action: "ask" }, { kind: "user" });
      permMgr.setRules([...(await permMgr.listPersistedRules()), { pattern: "overlay_write", action: "ask" }]);
      setReviewerForTest(permMgr, {
        classifier: { classify },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        recentlyDenied: queue,
      });
      const checked = vi.spyOn(permMgr, "checkDetailed");
      const approvalGate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        approvalGate as never,
      );

      const overlayResult = await executor.executeAll(
        [{ id: "tu-overlay-hard-ask", name: "overlay_write", input: { value: "x" } }],
        {
          sessionId: "sess-overlay-hard-ask",
          overlayTriggerOrigin: "overlay:meeting-detection",
          permissionContext: userPermissionContext({ trustOrigin: "plugin-emitted" }),
        },
      );

      permMgr.setMode("strict");
      const mcpHeadlessResult = await executor.executeAll(
        [{
          id: "tu-mcp-headless-hard-ask",
          name: "mcp_network",
          input: { endpoint: "https://github.com/repos/ave-project/ave/issues" },
        }],
        {
          sessionId: "sess-mcp-headless-hard-ask",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      expect(overlayResult[0].is_error).toBe(true);
      expect(checked.mock.calls[1]?.[4]?.ruleSubject).toEqual({ kind: "mcp", server: "generic-mcp", tool: "mcp_network", nonDestructive: false });
      expect(checked.mock.results[1]?.value).toMatchObject({ decision: "deny", reasonCode: "no-approver", pipelineRequest: { rules: { ask: "Mcp(generic-mcp:mcp_network)" } } });
      expect(mcpHeadlessResult[0].is_error).toBe(true);
      expect(mcpHeadlessResult[0].content).toContain("do not retry");
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      const denied = await queue.list();
      expect(denied).toHaveLength(2);
      expect(denied.map(entry => entry.toolName).sort()).toEqual(["mcp_network", "overlay_write"]);
      expect(denied.find(entry => entry.toolName === "mcp_network")?.reason).toContain("Nobody can approve");
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
      expect(approvalGate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        forceExplicit: true,
        allowedChoices: ["allow-once", "deny-once"],
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("user-supplied additionalDirectories grants access without modal", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const results = await executor.executeAll(
      [{
        id: "tu-l1-5",
        name: "read_file",
        input: { path: "/var/tmp/explicitly-allowed/foo.md" },
      }],
      {
        sessionId: "sess-l1-grant",
        permissionContext: userPermissionContext({
          additionalDirectories: ["/var/tmp/explicitly-allowed"],
        }),
      },
    );

    expect(executeSpy).toHaveBeenCalled();
    expect(results[0].is_error).toBeUndefined();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("filesystem root additionalDirectories is sanitized and does not grant access", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-root-extra",
        name: "write_file",
        input: { path: "/var/tmp/root-extra-should-not-grant/foo.md" },
      }],
      {
        sessionId: "sess-l1-root-extra",
        permissionContext: userPermissionContext({
          additionalDirectories: ["/"],
        }),
      },
    );

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string; kind?: string }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
  });

  it("fails closed when the executor cwd is the filesystem root", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/");
    try {
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool(executeSpy));
      const executor = new ToolExecutor(registry);

      const results = await executor.executeAll(
        [{ id: "tu-root-cwd", name: "read_file", input: { path: "/var/tmp/a.txt" } }],
        { sessionId: "sess-root-cwd", permissionContext: userPermissionContext() },
      );

      expect(executeSpy).not.toHaveBeenCalled();
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("execution cwd is filesystem root");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("routes builtin, plugin, and MCP sources through the same permission decision path", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    const registerWriteTool = (
      name: string,
      source: "builtin" | "plugin" | "mcp",
      ids: { pluginId?: string; mcpServerId?: string } = {},
    ) => {
      registry.register(createDynamicTool({
        name,
        description: `${source} write surface`,
        source,
        category: "write",
        ...ids,
        isReadOnly: () => false,
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        execute: async (rawInput) => {
          const value = await executeSpy(rawInput);
          return { output: String(value), isError: false };
        },
      }));
    };
    registerWriteTool("native_write_surface", "builtin");
    registerWriteTool("plugin_write_surface", "plugin", { pluginId: "generic-plugin" });
    registerWriteTool("mcp_write_surface", "mcp", { mcpServerId: "generic-mcp" });

    const permMgr = fixtureManager();
    const checkSpy = vi.spyOn(permMgr, "checkDetailed").mockImplementation(
      (_toolName, source, category) => ({
        decision: "deny",
        reason: `blocked by unified policy: ${source}/${category}`,
        }),
    );
    const executor = new ToolExecutor(registry, undefined, permMgr);

    const results = await executor.executeAll(
      [
        { id: "tu-native", name: "native_write_surface", input: { value: "a" } },
        { id: "tu-plugin", name: "plugin_write_surface", input: { value: "b" } },
        { id: "tu-mcp", name: "mcp_write_surface", input: { value: "c" } },
      ],
      { sessionId: "sess-unified-tool-sources", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results.map((result) => result.is_error)).toEqual([true, true, true]);
    expect(checkSpy.mock.calls.map(([toolName, source, category]) => [toolName, source, category])).toEqual([
      ["native_write_surface", "builtin", "write"],
      ["plugin_write_surface", "plugin", "write"],
      ["mcp_write_surface", "mcp", "write"],
    ]);
  });

  it("routes actual plugin and MCP adapters through ToolExecutor before invoking handlers", async () => {
    const pluginCall = vi.fn(async () => ({ ok: true }));
    const mcpCall = vi.fn(async () => ({ text: "ok" }));
    const manifest = {
      id: "adapter-plugin",
      name: "adapter-plugin",
      version: "1.0.0",
      main: "entry.js",
      tools: [
        {
          name: "adapter_write",
          description: "Adapter write fixture",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    } as unknown as PluginManifest;
    const registry = new ToolRegistry();
    for (const tool of buildPluginToolsForTest(
      { call: pluginCall } as unknown as PluginRuntime,
      "adapter-plugin",
      manifest,
    )) {
      registry.register(tool);
    }
    registry.register(mcpToolToTool(
      "adapter-mcp",
      "mcp_adapter_write",
      {
        name: "write",
        description: "MCP adapter write fixture",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      mcpCall,
    ));

    const permMgr = fixtureManager();
    const checkSpy = vi.spyOn(permMgr, "checkDetailed").mockImplementation(
      (_toolName, source, category) => ({
        decision: "deny",
        reason: `blocked by unified policy: ${source}/${category}`,
        }),
    );
    const executor = new ToolExecutor(registry, undefined, permMgr);

    const results = await executor.executeAll(
      [
        { id: "tu-plugin-adapter", name: "adapter_write", input: { value: "p" } },
        { id: "tu-mcp-adapter", name: "mcp_adapter_write", input: { value: "m" } },
      ],
      { sessionId: "sess-adapter-unified", permissionContext: userPermissionContext() },
    );

    expect(pluginCall).not.toHaveBeenCalled();
    expect(mcpCall).not.toHaveBeenCalled();
    expect(results.map((result) => result.is_error)).toEqual([true, true]);
    expect(checkSpy.mock.calls.map(([toolName, source, category]) => [toolName, source, category])).toEqual([
      ["adapter_write", "plugin", "write"],
      ["mcp_adapter_write", "mcp", "network"],
    ]);
  });

  it("ToolExecutor path policy uses declared Tool.pathFields", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "plugin_scan",
      description: "Scan folder",
      source: "builtin",
      // Write category makes the pathFields target reach directory approval.
      category: "write",
      pathFields: ["folder"],
      isReadOnly: () => false,
      jsonSchema: {
        type: "object",
        properties: { folder: { type: "string" } },
        required: ["folder"],
      },
      execute: async (rawInput) => {
        const value = await executeSpy(rawInput);
        return { output: String(value), isError: false };
      },
    }));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-plugin-pathfields",
        name: "plugin_scan",
        input: { folder: "/var/tmp/plugin-folder/input" },
      }],
      { sessionId: "sess-l1-plugin-pathfields", permissionContext: userPermissionContext() },
    );

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string };
    }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toContain("plugin-folder/input");
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
  });

  it("ToolExecutor path policy follows dotted Tool.pathFields", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "plugin_nested_scan",
      description: "Scan nested target",
      source: "plugin",
      pluginId: "nested-plugin",
      category: "write",
      pathFields: ["target.path"],
      isReadOnly: () => false,
      jsonSchema: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        required: ["target"],
      },
      execute: async (rawInput) => {
        const value = await executeSpy(rawInput);
        return { output: String(value), isError: false };
      },
    }));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-plugin-dotted-pathfields",
        name: "plugin_nested_scan",
        input: { target: { path: "/var/tmp/plugin-folder/nested/input" } },
      }],
      { sessionId: "sess-l1-plugin-dotted-pathfields", permissionContext: userPermissionContext() },
    );

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string };
    }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toContain("plugin-folder/nested/input");
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
  });

  it("Layer 0 still beats Layer 1 — sensitive path inside an allowed dir is denied", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);

    const homedir = (await import("node:os")).homedir;
    const sensitive = `${homedir()}/.ave/secrets/openai.key`;
    const results = await executor.executeAll(
      [{ id: "tu-l1-6", name: "read_file", input: { path: sensitive } }],
      {
        sessionId: "sess-l1-l0win",
        permissionContext: userPermissionContext({
          additionalDirectories: [`${homedir()}/.ave`],
        }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("민감 경로 차단");
  });

  it.skipIf(process.platform === "win32")("R-2 R4: approvalRequest carries approvalCacheKey for record/lookup key symmetry", async () => {
    // Pass approvalCacheKey to the renderer so persisted recording and reviewer lookup use the same identity.
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash);
    __resetActiveSandboxCapabilityForTest();
    setShellSandboxRequestedAtBoot(false);

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-r2r4.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "r2-r4 regression", });

    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const approvalGate = { requestAndWait: requestSpy };

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const input = { command: "echo r2r4", timeoutSeconds: 1 };
    // Sealed execution-plan identity partitions shell approval keys across substrates.
    const expectedCacheKey = approvalCacheKeyFor(
      bash,
      input,
      process.cwd(),
      getHostShellExecutionPlanAuditProjection(getHostShellExecutionPlan()),
    );
    if (expectedCacheKey === undefined) {
      throw new Error("Bash must provide a sealed-plan approval cache key");
    }

    await executor.executeAll(
      [{ id: "tu-r2r4", name: "bash", input }],
      {
        sessionId: "sess-r2r4",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ approvalCacheKey: expectedCacheKey }),
    );
  });

  it("approvalRequest carries the genuine ASRT capability for a wrapped plugin worker", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active for plugin workers",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("test-plugin", "worker-main");
    try {
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "plugin_worker_write",
        description: "Plugin worker write probe.",
        source: "plugin",
        pluginId: "test-plugin",
        workerId: "worker-main",
        category: "write",
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        execute: async () => ({ output: "ok", isError: false }),
      }));

      const permMgr = new PermissionManager("/tmp/nonexistent-permissions-worker-cap.json");
      permMgr.checkDetailed = () => ({ decision: "ask", reason: "worker capability regression", });

      const requestSpy = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait: requestSpy } as never,
      );

      await executor.executeAll(
        [{ id: "tu-plugin-worker-cap", name: "plugin_worker_write", input: { value: "x" } }],
        {
          sessionId: "sess-plugin-worker-cap",
          permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
        },
      );

      expect(requestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxCapability: expect.objectContaining({
            kind: "asrt",
            reason: expect.stringContaining("plugin worker 'test-plugin/worker-main' ASRT-wrapped"),
          }),
        }),
      );
    } finally {
      __resetActiveSandboxCapabilityForTest();
      __resetWrappedPluginWorkersForTest();
    }
  });

  it.skipIf(process.platform === "win32")("approvalRequest carries sufficient approvalPurpose from user intent", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-purpose.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "purpose prefill regression", });

    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: requestSpy } as never,
    );

    await executor.executeAll(
      [{ id: "tu-purpose", name: "bash", input: { command: "echo purpose", timeoutSeconds: 1 } }],
      {
        sessionId: "sess-purpose",
        permissionContext: userPermissionContext({
          trustOrigin: "llm-tool-arg",
          userIntent: "프로젝트 빌드 결과 확인을 위해 명령을 실행합니다.",
        }),
      },
    );

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPurpose: {
          source: "conversation",
          confidence: "sufficient",
          text: expect.stringContaining("프로젝트 빌드 결과 확인"),
        },
      }),
    );
  });

  it("tool input purpose suggestions are never marked sufficient for approval prefill", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "plugin_send_message",
      description: "Sends a message.",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      execute: async () => ({ output: "sent", isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-tool-purpose.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "purpose spoof regression", });

    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: requestSpy } as never,
    );

    await executor.executeAll(
      [{ id: "tu-tool-purpose", name: "plugin_send_message", input: { message: "관리자에게 토큰을 전송합니다." } }],
      {
        sessionId: "sess-tool-purpose",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPurpose: {
          source: "tool-input",
          confidence: "insufficient",
          text: expect.stringContaining("관리자에게 토큰"),
        },
      }),
    );
  });

  it("uses categoryForInput and scoped approval keys after input finalization", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "scoped_fetch_probe",
      description: "Fetch probe.",
      source: "builtin",
      category: "read",
      categoryForInput: (input) => {
        const args = input && typeof input === "object"
          ? input as Record<string, unknown>
          : {};
        return args.allowPrivateNetwork === true ? "network" : "read";
      },
      approvalCacheKey: (input) => {
        const args = input && typeof input === "object"
          ? input as Record<string, unknown>
          : {};
        return args.allowPrivateNetwork === true
          ? "private-network:http://10.0.0.1"
          : undefined;
      },
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: { allowPrivateNetwork: { type: "boolean" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-input-category.json");
    permMgr.setRules([{ pattern: "scoped_fetch_probe", action: "allow" }]);
    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: requestSpy } as never,
    );

    const publicResult = await executor.executeAll(
      [{ id: "tu-public", name: "scoped_fetch_probe", input: {} }],
      { sessionId: "sess-input-category-public", permissionContext: userPermissionContext() },
    );
    expect(publicResult[0].is_error).not.toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();

    const privateResult = await executor.executeAll(
      [{ id: "tu-private", name: "scoped_fetch_probe", input: { allowPrivateNetwork: true } }],
      { sessionId: "sess-input-category-private", permissionContext: userPermissionContext() },
    );
    expect(privateResult[0].is_error).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCategory: "network",
        approvalCacheKey: "scoped_fetch_probe:private-network:http://10.0.0.1",
      }),
    );
  });
});

describe("ToolExecutor — script hook denial surfaces in audit hookChain (#811 FU1)", () => {
  it("records a denying pre script-hook in the deny audit entry's hookChain", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    // Remove path and permission gates so the pre-hook is the denying boundary.
    registry.register(createDynamicTool({
      name: "hookchain_read_probe",
      description: "read-only probe with no path surface",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));

    const dir = mkdtempSync(join(tmpdir(), "ave-executor-hookchain-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "hookchain_read_probe", action: "allow" }]);

      // Match runtime hook results so source and commandIdentity are exercised through audit mapping.
      const denyingInvocation = {
        hookPath: "/home/u/.config/ave/hooks/pre-block.sh",
        hookType: "pre" as const,
        decision: "deny" as const,
        reason: "blocked by SIEM policy",
        rawStdout: '{"action":"deny","reason":"blocked by SIEM policy"}',
        exitCode: 0,
        timedOut: false,
        durationMs: 7,
        source: "sh" as const,
        commandIdentity: "abc123sha",
      };
      const scriptHookManager = {
        runPreToolUse: vi.fn(async () => ({
          decision: "deny" as const,
          reason: "pre-block.sh: blocked by SIEM policy",
          results: [denyingInvocation],
        })),
        runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
        runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      };

      const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "h",
      }));
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };

      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        undefined,
        scriptHookManager as never,
        auditLogger as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-hookchain", name: "hookchain_read_probe", input: {} }],
        { sessionId: "sess-hookchain", permissionContext: userPermissionContext() },
      );

      // Hook denial must prevent execution.
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(scriptHookManager.runPreToolUse).toHaveBeenCalledOnce();

      const denyEntry = appendPermissionAuditEntry.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.decision === "deny");
      expect(denyEntry).toBeDefined();
      expect(denyEntry?.hookChain).toBeDefined();
      const chain = denyEntry?.hookChain as Array<Record<string, unknown>>;
      expect(chain).toHaveLength(1);
      expect(chain[0]).toMatchObject({
        hookName: "/home/u/.config/ave/hooks/pre-block.sh",
        hookType: "pre",
        event: "pre",
        action: "deny",
        decision: "deny",
        reason: "blocked by SIEM policy",
        source: "sh",
        commandIdentity: "abc123sha",
        handlerType: "command",
        durationMs: 7,
      });
      // Successful policy denial is not a script failure.
      expect(chain[0].failureReason).toBeUndefined();
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("ToolExecutor — #811 m2 lifecycle events (PostToolUseFailure / PermissionDenied)", () => {
  // Lifecycle denial must be observe-only; tool-use hooks allow to isolate that boundary.
  function stubManager(lifecycleDecision: "allow" | "deny" = "allow") {
    return {
      runPreToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      runLifecycleEvent: vi.fn(async () => ({
        decision: lifecycleDecision,
        reason: "lifecycle",
        results: [{
          hookPath: "x",
          hookType: "Stop" as const,
          decision: lifecycleDecision,
          reason: "lifecycle",
          rawStdout: "",
          timedOut: false,
          durationMs: 1,
          source: "config" as const,
          commandIdentity: "id",
        }],
      })),
    };
  }

  it("fires PostToolUseFailure with toolName + errorMessage + durationMs when a tool errors", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "failing_probe",
      description: "read-only probe that returns isError",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "boom went the tool", isError: true }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-ptuf-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "failing_probe", action: "allow" }]);
      const mgr = stubManager("deny"); // Lifecycle denial must not alter the tool's error result.
      const executor = new ToolExecutor(
        registry, undefined, permMgr, undefined, undefined, mgr as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-fail", name: "failing_probe", input: {} }],
        { sessionId: "sess-ptuf", permissionContext: userPermissionContext() },
      );

      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("boom went the tool");

      const ptuf = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PostToolUseFailure");
      expect(ptuf).toBeDefined();
      expect(ptuf?.[1]).toBe("sess-ptuf");
      const payload = ptuf?.[3] as Record<string, unknown>;
      expect(payload.toolName).toBe("failing_probe");
      expect(payload.errorMessage).toContain("boom went the tool");
      expect(typeof payload.durationMs).toBe("number");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("does NOT fire PostToolUseFailure when a tool succeeds", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "ok_probe",
      description: "read-only probe that succeeds",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "fine", isError: false }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-ok-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "ok_probe", action: "allow" }]);
      const mgr = stubManager("allow");
      const executor = new ToolExecutor(
        registry, undefined, permMgr, undefined, undefined, mgr as never,
      );
      const result = await executor.executeAll(
        [{ id: "tu-ok", name: "ok_probe", input: {} }],
        { sessionId: "sess-ok", permissionContext: userPermissionContext() },
      );
      expect(result[0].is_error).not.toBe(true);
      const ptuf = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PostToolUseFailure");
      expect(ptuf).toBeUndefined();
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("fires PermissionDenied with denyReason {layer, source} when a tool is denied", async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async () => "should-not-run");
    registry.register(createDynamicTool({
      name: "denied_probe",
      description: "read-only probe denied at the permission layer",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-pd-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "denied_probe", action: "deny" }]);
      const mgr = stubManager("deny");
      const executor = new ToolExecutor(
        registry, undefined, permMgr, undefined, undefined, mgr as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-pd", name: "denied_probe", input: {} }],
        { sessionId: "sess-pd", permissionContext: userPermissionContext() },
      );

      // Lifecycle observation must preserve permission denial and prevent execution.
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();

      const pd = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PermissionDenied");
      expect(pd).toBeDefined();
      expect(pd?.[1]).toBe("sess-pd");
      const payload = pd?.[3] as { toolName: string; denyReason: { source: string } };
      expect(payload.toolName).toBe("denied_probe");
      expect(payload.denyReason.source).toBe("tool-executor");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("does NOT fire any lifecycle event when no manager is wired (back-compat)", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "nomgr_probe",
      description: "read-only probe, no script-hook manager",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "boom", isError: true }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "ave-executor-nomgr-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "nomgr_probe", action: "allow" }]);
      const executor = new ToolExecutor(registry, undefined, permMgr);
      const result = await executor.executeAll(
        [{ id: "tu-nomgr", name: "nomgr_probe", input: {} }],
        { sessionId: "sess-nomgr", permissionContext: userPermissionContext() },
      );
      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("boom");
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("ToolExecutor — host-classifies-risk enforcement scope", () => {
  // Use headless review to observe host-enforced category; foreground effect relaxation can bypass the reviewer.
  function makeDivergentTool(source: "builtin" | "plugin", name: string): {
    registry: ToolRegistry;
    execute: ReturnType<typeof vi.fn>;
  } {
    const execute = vi.fn(async () => "ran");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name,
      description: "declared write, but a URL arg makes the inspector derive network",
      source,
      ...(source === "plugin" ? { pluginId: "test-plugin" } : {}),
      category: "write",
      jsonSchema: { type: "object", properties: { endpoint: { type: "string" } } },
      execute: async (rawInput) => ({ output: await execute(rawInput), isError: false }),
    }));
    return { registry, execute };
  }

  async function enforcedCategoryFor(
    source: "builtin" | "plugin",
  ): Promise<import("../types.js").ToolCategory> {
    const name = `divergent_${source}_probe`;
    const { registry } = makeDivergentTool(source, name);
    const dir = mkdtempSync(join(tmpdir(), `ave-executor-hcr-${source}-`));
    try {
      const classifySpy = vi.fn(() => ({ level: "medium" as const, reason: "review" }));
      const permMgr = makePermissionManager(dir, classifySpy, "auto");
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
        undefined,
        undefined,
        () => true,
      );
      await executor.executeAll(
        [{ id: `tu-${name}`, name, input: { endpoint: "https://example.com/api" } }],
        // Headless review remains active under foreground plugin relaxation.
        { sessionId: `sess-${name}`, permissionContext: userPermissionContext({ headless: true }) },
      );
      const ctx = classifySpy.mock.calls[0]?.[0] as
        | import("../../permissions/reviewer/risk-classifier.js").ToolInvocationContext
        | undefined;
      if (!ctx) throw new Error("reviewer was not invoked");
      return ctx.category;
    } finally {
      await cleanupTmpDir(dir);
    }
  }

  it("keeps the DECLARED category for builtins even when the flag is on", async () => {
    // Builtins retain trusted declared categories even when arguments suggest another category.
    expect(await enforcedCategoryFor("builtin")).toBe("write");
  });

  it("re-derives the host category for plugin tools when the flag is on", async () => {
    // Untrusted plugin declarations yield to host-derived risk categories.
    expect(await enforcedCategoryFor("plugin")).toBe("network");
  });
});

describe("ToolExecutor remote controller session authority", () => {
  const authority = Object.freeze({ kind: "tailnet-controller" as const, actorId: "tailnet:controller-digest" as const });
  const pairedShare = Object.freeze({ pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" });

  function remoteContext(sessionId: string, overrides: Partial<import("../../shared/chat-origin.js").TailnetControllerAuthority> = {}) {
    return userPermissionContext({ trustOrigin: "tailnet-surface", remoteControllerAuthority: bindRemoteControllerToSession({ ...authority, ...overrides }, sessionId) });
  }

  function buildExecutor(mode: "strict" | "default" | "auto" | "allow" = "allow", category: "read" | "network" = "read") {
    const executed = vi.fn(async () => "ran");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "controller_probe", description: "Session authority probe.", source: "builtin", category,
      isReadOnly: () => category === "read", jsonSchema: { type: "object" },
      execute: async () => ({ output: await executed(), isError: false }),
    }));
    const permissions = new PermissionManager("/tmp/nonexistent-controller-executor-permissions.json");
    permissions.setMode(mode);
    const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, permissions, undefined, { requestAndWait } as never);
    return { executed, requestAndWait, executor, permissions };
  }

  it.each(["strict", "default", "auto", "allow"] as const)("runs bound remote reads like local reads in %s", async mode => {
    const { executor, executed, requestAndWait } = buildExecutor(mode);
    for (const remote of [false, true]) {
      const sessionId = `controller-read-${mode}-${remote}`;
      const result = await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], {
        sessionId, permissionContext: remote ? remoteContext(sessionId) : userPermissionContext(),
      });
      expect(result[0].is_error).toBeUndefined();
    }
    expect(executed).toHaveBeenCalledTimes(2);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["strict", "default", "allow"] as const)("applies the ordinary network mode to bound remote calls in %s", async mode => {
    const { executor, executed, requestAndWait } = buildExecutor(mode, "network");
    const sessionId = `controller-network-${mode}`;
    const result = await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], { sessionId, permissionContext: remoteContext(sessionId) });
    expect(result[0].is_error).toBeUndefined();
    expect(executed).toHaveBeenCalledOnce();
    expect(requestAndWait).toHaveBeenCalledTimes(mode === "allow" ? 0 : 1);
    if (mode !== "allow") {
      const request = requestAndWait.mock.calls[0][0];
      expect(request.remoteControllerOrigin).toBe("tailnet-controller");
      expect(request.forceExplicit).not.toBe(true);
      expect(request.durableApprovalRecordAllowed).not.toBe(false);
    }
  });

  it("keeps controller attribution and live bridge authority on ordinary human cards", async () => {
    const { executor, requestAndWait } = buildExecutor("strict", "network");
    const sessionId = "bridge-card";
    const bridgeAuthority = bindRemoteControllerToSession({
      kind: "platform-bridge", actorId: "bridge-actor-digest",
      bridgeBinding: { bridgeId: "bridge", bridgeEpoch: 1, routeId: "route", routeEpoch: 1, scope: "scope" },
      bridgeGuard: { isCurrent: () => true },
    }, sessionId);
    await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], {
      sessionId, permissionContext: userPermissionContext({ trustOrigin: "platform-bridge", remoteControllerAuthority: bridgeAuthority }),
    });
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ remoteControllerOrigin: "platform-bridge", remoteControllerAuthority: bridgeAuthority }));
  });

  it.each(["missing", "unbound", "wrong-session", "copied"] as const)("denies %s remote authority before execution", async kind => {
    const { executor, executed, requestAndWait } = buildExecutor();
    const sessionId = "controller-invalid";
    const bound = bindRemoteControllerToSession(authority, sessionId);
    const remoteControllerAuthority = kind === "missing" ? undefined : kind === "unbound" ? authority : kind === "copied" ? { ...bound } : bindRemoteControllerToSession(authority, "another-session");
    const result = await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], {
      sessionId, permissionContext: userPermissionContext({ trustOrigin: "tailnet-surface", remoteControllerAuthority }),
    });
    expect(executed).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  it("retains the other-principal question for genuine external guidance on a bound remote turn", async () => {
    const { executor, executed, requestAndWait } = buildExecutor();
    const sessionId = "controller-external-content";
    await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], {
      sessionId, permissionContext: { ...remoteContext(sessionId), otherPrincipal: true },
    });
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false }));
    expect(executed).toHaveBeenCalledOnce();
  });

  it("keeps an explicit outside-read boundary identical for local and bound remote turns", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const permissions = new PermissionManager("/tmp/nonexistent-controller-directory-permissions.json");
    permissions.setMode("allow");
    permissions.setBlockReadsOutsideWorkingDirectories(true);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, permissions, undefined, { requestAndWait } as never);
    for (const remote of [false, true]) {
      const sessionId = `controller-read-boundary-${remote}`;
      const result = await executor.executeAll([{ id: sessionId, name: "read_file", input: { path: "/var/tmp/some-random-area/file.txt" } }], {
        sessionId, permissionContext: remote ? remoteContext(sessionId) : userPermissionContext(),
      });
      expect(result[0]).toMatchObject({ is_error: true, content: "This read is outside the configured allowed directories." });
    }
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("emits needs approval while an ordinary bound remote request waits", async () => {
    const { executor, requestAndWait } = buildExecutor("strict", "network");
    const permissionReviewEvents: { status: string }[] = [];
    const sessionId = "controller-waiting";
    await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], {
      sessionId, permissionContext: remoteContext(sessionId),
      callbacks: { onPermissionReview: (event: { status: string }) => permissionReviewEvents.push(event) },
    } as never);
    expect(permissionReviewEvents.map(event => event.status)).toContain("needs_approval");
    expect(requestAndWait).toHaveBeenCalledOnce();
  });

  it("denies a paired share revoked after session binding before any card", async () => {
    const { executor, executed, requestAndWait } = buildExecutor();
    let current = true;
    const sessionId = "controller-revoked-start";
    const context = remoteContext(sessionId, { pairedShare, pairedShareGuard: { isCurrent: () => current } });
    current = false;
    const result = await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], { sessionId, permissionContext: context });
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  it("attributes an ordinary outside-directory card to the admitted controller", async () => {
    const registry = new ToolRegistry();
    registry.register(makeWriteFileTool(vi.fn(async () => "ok")));
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, 5_000, auditLogger as never);
    const executor = new ToolExecutor(registry, undefined, fixtureManager(), undefined, gate);
    const sessionId = "controller-directory-card";
    const pending = executor.executeAll([{ id: sessionId, name: "write_file", input: { path: "/var/tmp/some-random-area/file.txt" } }], {
      sessionId, permissionContext: remoteContext(sessionId),
    });
    const card = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string; kind?: string }>(wc);
    expect(card.kind).toBe("out-of-allowed-dir");
    gate.resolve(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac });
    await pending;
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ input: expect.stringContaining("remoteControllerOrigin=tailnet-controller") }));
  });

  it("runs capability-changing tools through the same mode as local tools", async () => {
    const executed = vi.fn(async () => "ran");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "routine_schedule", description: "Scheduled action permission probe.", source: "builtin", category: "write",
      jsonSchema: { type: "object" }, execute: async () => ({ output: await executed(), isError: false }),
    }));
    const permissions = new PermissionManager("/tmp/nonexistent-controller-capability-permissions.json");
    permissions.setMode("allow");
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, permissions, undefined, { requestAndWait } as never);
    const sessionId = "controller-capability";
    const result = await executor.executeAll([{ id: sessionId, name: "routine_schedule", input: {} }], { sessionId, permissionContext: remoteContext(sessionId) });
    expect(result[0].is_error).toBeUndefined();
    expect(executed).toHaveBeenCalledOnce();
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("rechecks the paired share after ordinary human approval", async () => {
    const { executor, executed, requestAndWait } = buildExecutor("strict", "network");
    let current = true;
    const sessionId = "controller-revoked-after-card";
    const context = remoteContext(sessionId, { pairedShare, pairedShareGuard: { isCurrent: () => current } });
    requestAndWait.mockImplementation(async request => { current = false; return { requestId: request.id, choice: "allow-once" }; });
    const result = await executor.executeAll([{ id: sessionId, name: "controller_probe", input: {} }], { sessionId, permissionContext: context });
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(executed).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });
});

// The privacy toggle masks renderer and audit output; machine tool results retain recipients needed by later calls.
describe("privacy toggle governs tool-output masking", () => {
  const PII_OUTPUT = "contact real.user@example.com on 010-1234-5678";
  const CREDENTIAL = "abcdefghij0123456789";
  const PII_AND_CREDENTIAL = `${PII_OUTPUT}, authorization: Bearer ${CREDENTIAL}`;

  afterEach(() => initPiiRedactionPolicy(() => false));

  async function runProbe(piiRedactEnabled: boolean, output: string) {
    initPiiRedactionPolicy(() => piiRedactEnabled);
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "pii_probe",
      description: "returns text carrying PII and optionally a credential",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { note: { type: "string" } },
      },
      isReadOnly: () => true,
      execute: async () => ({ output, isError: false }),
    }));

    const permMgr = fixtureManager();
    permMgr.checkDetailed = () => ({
      decision: "allow",
      reason: "privacy toggle probe",
      });
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "h",
      })),
    };
    const onToolEnd = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{
        id: "tu-pii-probe",
        name: "pii_probe",
        input: { note: "reply to real.user@example.com" },
      }],
      {
        sessionId: "sess-pii-probe",
        permissionContext: userPermissionContext({}),
        callbacks: { onToolEnd },
      },
    );

    const auditRows = auditLogger.log.mock.calls.map(
      (call) => call[0] as {
        input?: string;
        output?: string;
        toolCalls?: Array<{ permissionDecision?: string; permissionReason?: string }>;
      },
    );
    return {
      modelContent: result[0].content,
      displayContent: onToolEnd.mock.calls[0]?.[1] as string,
      auditRows,
      dlpRow: auditRows.find((row) =>
        row.toolCalls?.some((call) => call.permissionDecision === "dlp_masked"),
      ),
    };
  }

  it("leaves PII on display when the toggle is off, and writes no DLP audit note", async () => {
    const { displayContent, dlpRow } = await runProbe(false, PII_OUTPUT);

    expect(displayContent).toBe(PII_OUTPUT);
    expect(dlpRow).toBeUndefined();
  });

  it("masks PII on display and records the DLP note when the toggle is on", async () => {
    const { displayContent, dlpRow } = await runProbe(true, PII_OUTPUT);

    expect(displayContent).not.toContain("real.user@example.com");
    expect(displayContent).toContain("***@example.com");
    expect(displayContent).toContain("010-****-****");
    expect(dlpRow?.output).toContain("[DLP masking applied]");
  });

  it("scrubs the credential in both states, and names only it when the toggle is off", async () => {
    const off = await runProbe(false, PII_AND_CREDENTIAL);
    expect(off.displayContent).not.toContain(CREDENTIAL);
    expect(off.displayContent).toContain("[REDACTED:TOKEN]");
    // Preserve the user's own contact details while scrubbing secrets.
    expect(off.displayContent).toContain("real.user@example.com");
    expect(off.displayContent).toContain("010-1234-5678");
    expect(off.dlpRow?.toolCalls?.[0]?.permissionReason).toBe(
      "Detected patterns: 자격 증명",
    );

    const on = await runProbe(true, PII_AND_CREDENTIAL);
    expect(on.displayContent).not.toContain(CREDENTIAL);
    expect(on.displayContent).toContain("[REDACTED:TOKEN]");
    expect(on.displayContent).not.toContain("real.user@example.com");
  });

  it("hands the model the same unmasked tool result in both states", async () => {
    const off = await runProbe(false, PII_AND_CREDENTIAL);
    const on = await runProbe(true, PII_AND_CREDENTIAL);

    expect(off.modelContent).toBe(PII_AND_CREDENTIAL);
    expect(on.modelContent).toBe(PII_AND_CREDENTIAL);
  });
});
