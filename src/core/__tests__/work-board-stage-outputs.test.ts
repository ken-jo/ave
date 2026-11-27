import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { makeConversationLoopSettings } from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../engine/__tests__/support/subagent-loop-fixtures.js";
import { PARENT_ALL_TOOL_SCOPE, SubAgentRunner } from "../../engine/subagent-runner.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { mintHostDecisionProof } from "../../main/workflow-template-decision.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { PluginMcpHost } from "../../mcp/plugin-mcp-host.js";
import type { PluginManifest } from "../../plugins/types.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import * as sandbox from "../../permissions/asrt-sandbox.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ScheduleAttachment, StageEnvelope, WorkflowTemplateRecord } from "../../shared/workflow-template-types.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createStageRequestOutputTool } from "../../tools/stage-request-output.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { createHostGit } from "../../work-board/workflow/host-git.js";
import { createRequestedOutputHooks } from "../../work-board/workflow/requested-outputs.js";

const DECLARATION = { kind: "send-message", owner: "server", ownerId: "reports", toolName: "send_report" } as const;
const ENVELOPE: StageEnvelope = {
  tools: [], writePaths: [], readRoots: [], commands: [], network: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: ["branch"], budget: { rounds: 5, minutes: 1, costUsd: 0 },
};

it("a scheduled run ends at the gate with outputs pending and nothing sent", async () => {
  const send = vi.fn();
  const h = await stageRunHarness({ observeRunWork: true, workflow: {
    outputs: createRequestedOutputHooks(createHostGit(), { operands: (_decl, input) => ({ input, paths: [] }), invoke: send }),
    unattendedAllowed: () => ({ ok: true }),
    lane: { admit: async () => ({ ok: true }), sessionLinked: vi.fn(), sessionEnded: vi.fn(), onDenied: () => () => {} },
  } });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("review", { envelope: ENVELOPE, requestedOutputs: [DECLARATION] })]);
    const pin = h.pinOf(version);
    const proof = mintHostDecisionProof("local-desktop");
    await expect(h.templates.attachSchedule({ scheduleId: "daily", ...pin }, proof, { kind: "all" })).rejects.toMatchObject({ code: "schedule-requires-read-only" });
    const attachment: ScheduleAttachment = { ...pin, scheduleId: "daily", approvedScope: { kind: "all" },
      id: "daily-fixture", who: "user", origin: "local-desktop", at: proof.decidedAt };
    const path = join(h.dir, "templates.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { templates: WorkflowTemplateRecord[] };
    file.templates[0].scheduleAttachments = [attachment];
    writeFileSync(path, JSON.stringify(file));
    const start = h.engine.startScheduledTemplate({ kind: "schedule-attachment", pin, attachmentId: attachment.id, firedAt: proof.decidedAt }, "Scheduled report");
    const [child] = await h.untilLive(1);
    const cwd = child.input.projectRoot ?? "";
    expect(child.input.unattendedStage).toMatchObject({ stageId: "review" });
    const { toolName, owner, ownerId } = DECLARATION;
    expect(await child.input.stageOutputTool?.execute({ toolName, owner, ownerId, args: { body: "Ready" }, summary: "Send report" },
      { cwd, metadata: {}, extraAllowedDirectories: [] })).toMatchObject({ isError: false });
    child.finish({ summary: "Report ready" });
    const run = await start;
    if (!run.ok) throw new Error(run.code);
    await expect(run.result).resolves.toMatchObject({ status: "awaiting_approval" });
    const stage = await h.stageRun(run.itemId, "review");
    expect(stage).toMatchObject({ requestedOutputs: [{ decl: DECLARATION }], gate: { status: "pending" } });
    expect(stage.outputExecutions).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

async function withRunner(body: (fixture: {
  runner: SubAgentRunner; cwd: string; tools: string[][]; approval: Promise<ApprovalRequest>; gate: ApprovalGate;
  execute: ReturnType<typeof vi.fn>;
}) => Promise<void>) {
  const h = await stageRunHarness();
  const owner = makeMockWebContents();
  const gate = new ApprovalGate(owner as never);
  const approval = deferred<ApprovalRequest>();
  owner.send.mockImplementation((channel: string, request: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) approval.resolve(request);
  });
  const execute = vi.fn(async () => ({ output: "Sent", isError: false }));
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: DECLARATION.toolName, source: "mcp", mcpServerId: DECLARATION.ownerId,
    description: "Send a report", category: "write", jsonSchema: { type: "object" }, execute }));
  const tools: string[][] = [];
  const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider({ vendor: "claude", async *streamTurn({ messages, tools: schemas }) {
    tools.push((schemas ?? []).map(schema => schema.name));
    if (messages.some(message => message.role === "user" && message.content === "Send report") && !messages.some(message => message.role === "tool_result")) {
      yield { type: "tool_call", id: "delivery", name: DECLARATION.toolName, input: {} };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "Ready" };
    yield { type: "message_complete", stopReason: "end_turn" };
  } });
  const permissionManager = new PermissionManager(join(h.dir, "permissions.json"));
  permissionManager.setMode("strict");
  const runner = new SubAgentRunner({
    parentDeps: makeSubagentLoopDeps(registry, { approvalGate: gate, permissionManager, settingsService: makeConversationLoopSettings(false),
      auditLogger: new AuditLogger(), networkFetch: unusedNetworkFetch }),
    toolRegistry: registry, subAgentMemoryManager: new MemoryManager({ aveDir: join(h.dir, "children") }),
  });
  try { await body({ runner, cwd: h.dir, tools, approval: approval.promise, gate, execute }); }
  finally {
    gate.disposeAll();
    hasProviderSpy.mockRestore();
    refreshProviderSpy.mockRestore();
    await h.cleanup();
  }
}

it("an undeclared outward call is denied in a scheduled run and raises a card in an attended one", () => withRunner(async ({ runner, cwd, tools, gate, approval, execute }) => {
  const input = { title: "Stage", instructions: "Send report", toolScope: PARENT_ALL_TOOL_SCOPE, projectRoot: cwd };
  await runner.spawn({ ...input, unattendedStage: { runKey: "run", stageId: "review" } });
  expect(tools.every(names => !names.includes(DECLARATION.toolName))).toBe(true);
  expect(gate.pendingCount).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  const attended = runner.spawn(input);
  const card = await approval;
  expect(card.toolName).toBe(DECLARATION.toolName);
  expect(execute).not.toHaveBeenCalled();
  gate.disposeAll();
  await attended;
}));

it("git_push is in no tool schema of a stage child or a grandchild", () => withRunner(async ({ runner, cwd, tools }) => {
  const input = { title: "Stage", instructions: "Inspect result", toolScope: PARENT_ALL_TOOL_SCOPE, projectRoot: cwd };
  const tool = createStageRequestOutputTool([DECLARATION], async () => ({ ok: true, id: "delivery" }));
  await runner.spawn({ ...input, stageOutputTool: tool });
  await runner.spawn({ ...input, title: "Delegated child" });
  expect(tools).toHaveLength(2);
  expect(tools[0]).toContain("stage_request_output");
  expect(tools[1]).not.toContain("stage_request_output");
  expect(tools.every(names => !names.includes("git_push"))).toBe(true);
}));

it.each([
  "unverified", "partial hint", "unsigned policy", "policy without operands", "source read deny", "deny while awaiting permission",
  "registration replaced while awaiting permission", "inline upload", "file operands",
] as const)("binds requested output by verified operands for %s", async scenario => {
  const { governedWorkflowOutput } = await import("../../boot/steps/workflow-output-invocation.js");
  const { approvalSurfaceRegistry } = await import("../../permissions/approval-surface-registry.js");
  const { ToolExecutor } = await import("../../tools/executor.js");
  const h = await stageRunHarness();
  const owner = makeMockWebContents();
  const shown = deferred<ApprovalRequest>();
  owner.send.mockImplementation((channel: string, request: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) shown.resolve(request);
  });
  const gate = new ApprovalGate(sessionId => sessionId === "ordinary" ? owner as never : approvalSurfaceRegistry.resolve(sessionId));
  const readDenies = vi.spyOn(sandbox, "getUserReadDenies");
  const audit = new AuditLogger(join(h.dir, "audit"));
  let plugin: PluginMcpHost | undefined;
  try {
    const source = join(h.dir, "report.txt");
    const attachment = join(h.dir, "attachment.txt");
    writeFileSync(source, "Approved report");
    writeFileSync(attachment, "Approved attachment");
    const args = scenario === "inline upload" ? { operation: "send", path: "An inline label" }
      : scenario === "unverified" ? { documentSource: source }
      : scenario === "partial hint" ? { document: { sources: ["report.txt"] }, attachment }
      : { operation: "send", document: { sources: ["report.txt", "attachment.txt"] } };
    const execute = vi.fn(async (_name: string, input: Record<string, unknown>) => {
      if (scenario === "file operands") {
        const { sources } = input.document as { sources: string[] };
        const temp = sandbox.ensureSandboxTempPrincipalDir({ kind: "plugin", id: DECLARATION.ownerId });
        expect(sources.every(path => !isAbsolute(relative(temp.dir, path)) && !relative(temp.dir, path).startsWith(".."))).toBe(true);
        expect(sources.every(path => sandbox.protectedReadDenyCovering(path, [temp.root]) === temp.root)).toBe(true);
        expect(sources.map(path => readFileSync(path, "utf8"))).toEqual(["Approved report", "Approved attachment"]);
      }
      return { text: "Sent" };
    });
    const registry = new ToolRegistry();
    const decl = scenario === "unverified" ? DECLARATION
      : { ...DECLARATION, owner: "plugin", kind: scenario === "inline upload" ? "upload" : "external-write" } as const;
    const schema = { name: decl.toolName, description: "Send a report", inputSchema: { type: "object" as const, properties: {} } };
    const generationId = "reporting-generation";
    if (scenario === "unverified") {
      registry.register(mcpToolToTool(decl.ownerId, decl.toolName, schema, execute));
    } else {
      const pathFields = scenario === "inline upload" ? [] : ["document.sources"];
      const manifest: PluginManifest = {
        id: decl.ownerId, name: "Reports", description: "Report delivery fixture", version: "1.0.0", entry: "entry.mjs",
        tools: [{ ...schema, inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            operation: { type: "string", const: "send" },
            ...(scenario === "inline upload" ? { path: { type: "string" } } : {
              document: { type: "object", additionalProperties: false,
                properties: { sources: { type: "array", items: { type: "string" } } }, required: ["sources"] },
              ...(scenario === "partial hint" ? { attachment: { type: "string" } } : {}),
            }),
          },
          required: ["operation", ...(scenario === "inline upload" ? ["path"] : ["document"]),
            ...(scenario === "partial hint" ? ["attachment"] : [])],
        }, _meta: {
          ui: { visibility: ["model"] },
          "ai.agent-connector.ave/pathFields": pathFields,
          ...(scenario !== "partial hint" && { "ai.agent-connector.ave/operationPolicy": {
            discriminant: "operation", operations: { send: { kind: "write", minimumRisk: "write",
              ...(scenario !== "policy without operands" && { pathFields: [...pathFields] }) } },
          } }),
        } }],
      };
      plugin = PluginMcpHost.loopback(manifest, async (name, input) => {
        const result = await execute(name, input);
        return { content: [{ type: "text", text: result.text }] };
      }, undefined, generationId, scenario === "unsigned policy" ? undefined : manifest);
      const tools = await plugin.prepareTools();
      expect(tools).toHaveLength(1);
      registry.reservePluginReplacement(decl.ownerId, tools, []).publish();
      plugin.publishPrepared(tools);
    }
    const manager = new PermissionManager(join(h.dir, "permissions.json"));
    manager.setMode("strict");
    const generationAccess = {
      acquireExact: async () => ({ generation: { state: { runtime: { instance: { handlers: {} } } } }, release: vi.fn() }),
      runWithLease: async (_lease: unknown, invoke: () => Promise<unknown>) => invoke(),
    };
    const scriptHooks = new ScriptHookManager();
    await audit.setupPermissionAuditChain("a".repeat(64));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, scriptHooks, audit,
      undefined, undefined, undefined, () => generationAccess as never, (_tool, sessionId) => ({
        ownerVersion: "1.0.0", generationId, appSessionId: sessionId ?? "test-session",
        accountScopeHash: "sample-account-scope", accountHash: "sample-account", appGrantRequired: false,
      }));
    const hooks = createRequestedOutputHooks(createHostGit(), governedWorkflowOutput(registry, executor));
    const run = { itemId: 1, runId: "verified-operands", runKey: "verified-operands" };
    const raw = { toolName: decl.toolName, owner: decl.owner, ownerId: decl.ownerId, args, summary: "Send report" };
    if (scenario === "source read deny") readDenies.mockReturnValue([source]);
    const request = await hooks.accept({ stage: stageOf("review", { requestedOutputs: [decl] }), workspaceRoot: h.dir, run, raw });
    if (scenario === "partial hint" || scenario === "unsigned policy"
      || scenario === "policy without operands" || scenario === "source read deny") {
      expect(request).toEqual({ ok: false, code: scenario === "source read deny" ? "output-file-read-denied" : "output-operands-unverified" });
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "unverified") {
      expect(request).toEqual({ ok: false, code: "output-operands-unverified" });
      expect(execute).not.toHaveBeenCalled();
      const ordinary = executor.executeAll([{ id: "ordinary", name: decl.toolName, input: args }], {
        executionCwd: h.dir, sessionId: "ordinary", permissionContext: { trustOrigin: "llm-tool-arg" },
      });
      const card = await Promise.race([shown.promise, ordinary.then(() => undefined)]);
      expect(card?.toolName).toBe(decl.toolName);
      if (card) gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, owner as never);
      await ordinary;
      expect(execute).toHaveBeenCalledWith(decl.toolName, args);
      return;
    }
    if (process.platform === "win32" && scenario !== "inline upload") {
      expect(request).toEqual({ ok: false, code: "output-file-unbound" });
      return;
    }
    if (!request.ok) throw new Error(request.code);
    if (scenario === "file operands") {
      expect(request.output.files).toEqual(["report.txt", "attachment.txt"].map(path => ({ path,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), size: expect.any(Number) })));
    }
    const dispatch = hooks.execute({ run, stageId: "review", output: request.output, approvalSurface: owner as never,
      workspace: { root: h.dir }, canExecute: () => true });
    const card = await Promise.race([shown.promise, dispatch.then(() => undefined)]);
    expect(card?.toolName).toBe(decl.toolName);
    expect(execute).not.toHaveBeenCalled();
    const paths = (card?.args as { document?: { sources: string[] } } | undefined)?.document?.sources ?? [];
    if (scenario !== "inline upload") {
      expect(paths).toHaveLength(2);
      expect(paths.every(path => !existsSync(path))).toBe(true);
    }
    if (scenario === "deny while awaiting permission") readDenies.mockReturnValue([source]);
    if (scenario === "registration replaced while awaiting permission") {
      const original = registry.findByName(decl.toolName);
      if (!original) throw new Error("Missing registered tool");
      registry.reservePluginReplacement(decl.ownerId, [{ ...original }], []).publish();
    }
    writeFileSync(source, "Later report");
    writeFileSync(attachment, "Later attachment");
    if (card) gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, owner as never);
    if (scenario === "deny while awaiting permission") {
      await expect(dispatch).resolves.toMatchObject({ status: "failed", detail: "output-file-read-denied" });
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "registration replaced while awaiting permission") {
      await expect(dispatch).resolves.toMatchObject({ status: "failed" });
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    await expect(dispatch).resolves.toMatchObject({ status: "done" });
    expect(paths.every(path => !existsSync(path))).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    if (scenario === "inline upload") expect(execute).toHaveBeenCalledWith(decl.toolName, args);
  } finally {
    readDenies.mockRestore();
    gate.disposeAll();
    await plugin?.dispose();
    await audit.close();
    await h.cleanup();
  }
});
