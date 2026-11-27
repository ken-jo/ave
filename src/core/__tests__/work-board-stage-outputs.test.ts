import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { makeConversationLoopSettings } from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../engine/__tests__/support/subagent-loop-fixtures.js";
import { PARENT_ALL_TOOL_SCOPE, SubAgentRunner } from "../../engine/subagent-runner.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { mintHostDecisionProof } from "../../main/workflow-template-decision.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { mcpToolToPluginTool } from "../../mcp/plugin-tool-from-mcp.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
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

it("a recorded tool uses the deciding window for its fresh permission check and cannot execute rewritten arguments", async () => {
  const { governedWorkflowOutput } = await import("../../boot/steps/workflow-output-invocation.js");
  const { approvalSurfaceRegistry } = await import("../../permissions/approval-surface-registry.js");
  const { ToolExecutor } = await import("../../tools/executor.js");
  const h = await stageRunHarness();
  const owner = makeMockWebContents();
  const shown = deferred<ApprovalRequest>();
  owner.send.mockImplementation((channel: string, request: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) shown.resolve(request);
  });
  const gate = new ApprovalGate(sessionId => approvalSurfaceRegistry.resolve(sessionId));
  const registry = new ToolRegistry();
  const decl = { ...DECLARATION, owner: "plugin" } as const;
  const execute = vi.fn(async () => ({ output: "Sent", isError: false }));
  registry.register(createDynamicTool({ name: decl.toolName, source: "plugin", pluginId: decl.ownerId, pathFields: [],
    description: "Send a report", category: "write", jsonSchema: { type: "object" }, execute }));
  const manager = new PermissionManager(join(h.dir, "permissions.json"));
  manager.setMode("strict");
  const hooks = new HookRunner();
  hooks.registerPreHook("rewrite-payload", () => ({ action: "modify", updatedInput: { message: "Changed" } }));
  const executor = new ToolExecutor(registry, hooks, manager, undefined, gate, undefined, new AuditLogger());
  const adapter = governedWorkflowOutput(registry, executor);
  const recheck = vi.fn(async () => true);
  try {
    const dispatch = adapter.invoke({
      output: { id: "approved", decl, args: '{"message":"Approved"}', summary: "Send report" },
      args: { message: "Approved" }, root: h.dir, workspace: h.dir, surface: owner as never, recheck,
    });
    const card = await shown.promise;
    expect(card.toolName).toBe(DECLARATION.toolName);
    expect(execute).not.toHaveBeenCalled();
    expect(gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, owner as never))
      .toMatchObject({ choice: "allow-once" });
    await expect(dispatch).resolves.toBe("failed");
    expect(execute).not.toHaveBeenCalled();
  } finally {
    gate.disposeAll();
    await h.cleanup();
  }
});

it.each(["unverified", "inline upload", "file operands"] as const)("binds requested output by verified operands for %s", async scenario => {
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
  try {
    const source = join(h.dir, "report.txt");
    const attachment = join(h.dir, "attachment.txt");
    writeFileSync(source, "Approved report");
    writeFileSync(attachment, "Approved attachment");
    const args = scenario === "inline upload" ? { path: "An inline label" }
      : scenario === "unverified" ? { documentSource: source }
      : { document: { sources: ["report.txt", "attachment.txt"] } };
    const execute = vi.fn(async (_name: string, input: Record<string, unknown>) => {
      if (scenario === "file operands") {
        const { sources } = input.document as { sources: string[] };
        expect(sources).not.toContain(source);
        expect(sources.map(path => readFileSync(path, "utf8"))).toEqual(["Approved report", "Approved attachment"]);
      }
      return { text: "Sent" };
    });
    const registry = new ToolRegistry();
    const decl = scenario === "unverified" ? DECLARATION
      : { ...DECLARATION, owner: "plugin", kind: scenario === "inline upload" ? "upload" : "external-write" } as const;
    const schema = { name: decl.toolName, description: "Send a report", inputSchema: { type: "object" as const, properties: {} } };
    registry.register(scenario === "unverified" ? mcpToolToTool(decl.ownerId, decl.toolName, schema, execute)
      : mcpToolToPluginTool(decl.ownerId, { ...schema, _meta: { ui: { visibility: ["model"] },
        "ai.agent-connector.ave/pathFields": scenario === "inline upload" ? [] : ["document.sources"] } }, execute));
    const manager = new PermissionManager(join(h.dir, "permissions.json"));
    manager.setMode("strict");
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, new AuditLogger());
    const hooks = createRequestedOutputHooks(createHostGit(), governedWorkflowOutput(registry, executor));
    const run = { itemId: 1, runId: "verified-operands", runKey: "verified-operands" };
    const raw = { toolName: decl.toolName, owner: decl.owner, ownerId: decl.ownerId, args, summary: "Send report" };
    const request = await hooks.accept({ stage: stageOf("review", { requestedOutputs: [decl] }), workspaceRoot: h.dir, run, raw });
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
    writeFileSync(source, "Later report");
    writeFileSync(attachment, "Later attachment");
    if (card) gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, owner as never);
    await expect(dispatch).resolves.toMatchObject({ status: "done" });
    expect(execute).toHaveBeenCalledOnce();
    if (scenario === "inline upload") expect(execute).toHaveBeenCalledWith(decl.toolName, args);
  } finally {
    gate.disposeAll();
    await h.cleanup();
  }
});
