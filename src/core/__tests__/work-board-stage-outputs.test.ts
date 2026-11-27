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
import { mintHostDecisionProof } from "../../main/workflow-template-decision.js";
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
    outputs: createRequestedOutputHooks(createHostGit(), send),
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
  const execute = vi.fn(async () => ({ output: "Sent", isError: false }));
  registry.register(createDynamicTool({ ...DECLARATION, name: DECLARATION.toolName, source: "mcp", mcpServerId: DECLARATION.ownerId,
    description: "Send a report", category: "write", jsonSchema: { type: "object" }, execute }));
  const manager = new PermissionManager(join(h.dir, "permissions.json"));
  manager.setMode("strict");
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, new AuditLogger());
  const invoke = governedWorkflowOutput(registry, executor);
  const recheck = vi.fn(async () => true);
  try {
    const dispatch = invoke({
      output: { id: "approved", decl: DECLARATION, args: '{"message":"Approved"}', summary: "Send report" },
      args: { message: "Changed" }, root: h.dir, surface: owner as never, recheck,
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

it.each(["manifest", "upload", "declared operand", "conventional operand"] as const)("refuses an unbound file argument from a %s", async (kind) => {
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
  try {
    const decl = { ...DECLARATION, kind: kind === "upload" ? "upload" : DECLARATION.kind } as const;
    const path = join(h.dir, "report.txt");
    writeFileSync(path, "Approved bytes");
    const args = kind === "declared operand" ? { document: { source: path } } : { path };
    const opened: string[] = [];
    const execute = vi.fn(async (input: typeof args) => {
      writeFileSync(path, "Later bytes");
      opened.push(readFileSync(String(input.document?.source ?? input.path), "utf8"));
      return { output: "Sent", isError: false };
    });
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({ name: decl.toolName, source: "mcp", mcpServerId: decl.ownerId,
      description: "Send a report", category: "write", jsonSchema: { type: "object" },
      ...(kind === "declared operand" && { pathFields: ["document.source"] }),
      execute: input => execute(input as typeof args) }));
    const manager = new PermissionManager(join(h.dir, "permissions.json"));
    manager.setMode("strict");
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, new AuditLogger());
    const hooks = createRequestedOutputHooks(createHostGit(), governedWorkflowOutput(registry, executor));
    const run = { itemId: 1, runId: "file-delivery", runKey: "file-delivery" };
    const request = await hooks.accept({ stage: stageOf("review", { requestedOutputs: [decl] }), workspaceRoot: h.dir, run,
      raw: { toolName: decl.toolName, owner: decl.owner, ownerId: decl.ownerId, args, summary: "Send report",
        ...(kind === "manifest" && { files: ["report.txt"] }) } });
    if (!request.ok) throw new Error(request.code);
    const dispatch = hooks.execute({ run, stageId: "review", output: request.output, approvalSurface: owner as never,
      workspace: { root: h.dir }, canExecute: () => true });
    const card = await Promise.race([shown.promise, dispatch.then(() => undefined)]);
    if (card) gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, owner as never);
    await expect(dispatch).resolves.toMatchObject({ status: "failed", detail: "output-file-unbound" });
    expect(execute).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  } finally {
    gate.disposeAll();
    await h.cleanup();
  }
});
