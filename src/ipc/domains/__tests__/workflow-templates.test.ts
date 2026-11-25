import { beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinTools } from "../../../boot/tools.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { WorkflowTemplateStore } from "../../../main/workflow-template-store.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { isValidToolName } from "../../../tools/types.js";
import { graphHashOf } from "../../../work-board/template-graph.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { validateHostRendererSender } from "../../gated.js";
import { ChangeSignal } from "../../../lib/change-signal.js";
import { runWithEffectGateContext } from "../../../permissions/effect-enforcement.js";
import type { IpcDeps } from "../../types.js";
type Handler = (...args: unknown[]) => Promise<unknown>;
const h = vi.hoisted(() => new Map<string, Handler>());
function handler(channel: string): Handler {
  const listener = h.get(channel); if (!listener) throw new Error("Missing handler"); return listener;
}
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, fn: Handler) => h.set(key, fn) } }));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: vi.fn(() => true), auditUnauthorized: vi.fn(), UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" } }));
vi.mock("../../../main/project-root-authorization.js", () => ({ resolveAuthorizedWorkspaceProject: vi.fn(() => ({ authorized: false, project: null })) }));
vi.mock("../../window-fanout.js", () => ({ broadcastToAppWindows: vi.fn() }));
import { broadcastToAppWindows } from "../../window-fanout.js";
const graph = { name: "Template", scope: { kind: "all" }, stages: [{ id: "a", name: "A", goal: "Read", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" } }], edges: [] };
const gesture = { inputOrigin: "user-keyboard", userActivation: true };
function setup(extra: Partial<IpcDeps> = {}) {
  const sender = { isDestroyed: () => false, mainFrame: {} }; const window = { isDestroyed: () => false, webContents: sender };
  const changed = new ChangeSignal(() => {});
  const store = { list: vi.fn(async () => []), get: vi.fn(async (id: string) => ({ template: { id, scope: { kind: "all" } } })), draft: vi.fn(async () => { changed.emit(); return {}; }), confirmDraft: vi.fn(async () => { changed.emit(); return {}; }), archive: vi.fn(async () => { changed.emit(); }), attachSchedule: vi.fn(async () => { changed.emit(); return {}; }), detachSchedule: vi.fn(async () => true), getAttachment: vi.fn(async () => ({ templateId: "t" })), changed };
  const auditLog = vi.fn();
  registerWorkBoardHandlers({ workflowTemplateStore: store, auditLogger: { log: auditLog }, getMainWindow: () => window, getAppWindows: () => [window], ...extra } as unknown as IpcDeps);
  return { store, auditLog, event: { sender, senderFrame: sender.mainFrame } };
}
beforeEach(() => { h.clear(); vi.mocked(validateHostRendererSender).mockReturnValue(true); vi.mocked(broadcastToAppWindows).mockClear(); });
const proposalToolName = "workflow_template_propose";
const reportDraft = {
  name: "Daily report",
  scope: { kind: "all" },
  stages: [
    { id: "gather", name: "Gather", goal: "Gather the daily source material", inputs: [], toolScope: "read", allowSubAgents: false,
      gate: { type: "auto", pass: { kind: "stage_ok" } } },
    { id: "review", name: "Review", goal: "Summarize the source material for review", inputs: ["gather"], toolScope: "read",
      allowSubAgents: false, gate: { type: "human" } },
  ],
  edges: [{ from: "gather", to: "review" }],
};
const reportEnvelope = {
  tools: [], writePaths: ["reports/**"], readRoots: [], network: [],
  commands: ["prepare-report"], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
  outputs: [], budget: { rounds: 4, minutes: 3, costUsd: 0.1 },
};
const reportWithEnvelope = {
  ...reportDraft,
  stages: [
    reportDraft.stages[0],
    {
      ...reportDraft.stages[1], toolScope: "all", gate: { type: "auto", pass: { kind: "model_verdict" } },
      envelope: reportEnvelope,
    },
  ],
  setupCommands: reportEnvelope.commands,
};
const reportSessionId = "report-session";

function proposalRegistry(store: WorkflowTemplateStore) {
  const registry = new ToolRegistry();
  const deps = { workflowTemplateStore: store, networkFetch: unusedNetworkFetch, singleHopNetworkFetch: unusedNetworkFetch };
  registerBuiltinTools(registry, { get: () => ({}) } as unknown as Parameters<typeof registerBuiltinTools>[1], deps);
  return registry;
}

async function withTemplateProposal<T>(body: (fixture: {
  store: WorkflowTemplateStore;
  path: string;
  event: ReturnType<typeof setup>["event"];
  auditLog: ReturnType<typeof setup>["auditLog"];
  propose: (draft: unknown, options?: { headless?: boolean; sessionId?: string }) => Promise<{ isError: boolean; output: string }>;
}) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "template-proposals-"));
  const path = join(directory, "templates.json");
  const store = new WorkflowTemplateStore(path);
  try {
    const { event, auditLog } = setup({ workflowTemplateStore: store });
    const tool = proposalRegistry(store).getVisibleTools().find(entry => entry.name === proposalToolName);
    if (!tool) throw new Error("Workflow template proposal tool is missing from host registration");
    return await body({ store, path, event, auditLog, propose: (draft, { headless = false, sessionId = reportSessionId } = {}) =>
      tool.execute(draft, { cwd: directory, extraAllowedDirectories: [], metadata: { sessionId }, headless }) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("registers a host-owned template proposal tool with a valid tool name", () => {
  const registry = proposalRegistry(new WorkflowTemplateStore(join(tmpdir(), "unused-templates.json")));
  const tool = registry.getVisibleTools().find(entry => entry.name === proposalToolName);
  expect(isValidToolName(proposalToolName)).toBe(true);
  expect(tool).toMatchObject({ name: proposalToolName, source: "builtin" });
  expect(tool?.pluginId).toBeUndefined();
});

it("holds a valid draft with the graph hash and saves nothing before confirmation", async () => {
  await withTemplateProposal(async ({ event, path, store, propose }) => {
    const draft = reportWithEnvelope;
    const result = await propose(draft);
    expect(result.isError).toBe(false);
    const proposal = JSON.parse(result.output);
    const graphHash = graphHashOf(draft);
    expect(proposal).toMatchObject({ status: "pending-confirmation", proposalId: expect.any(String), graphHash });
    expect(await handler(WORK_BOARD.templateProposalGet)(event, proposal.proposalId))
      .toMatchObject({ ok: true, value: { id: proposal.proposalId, graphHash, draft } });
    expect(await store.list()).toEqual([]);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("saves a new version only through a matching user confirmation", async () => {
  await withTemplateProposal(async ({ event, store, auditLog, propose }) => {
    const { proposalId, graphHash } = JSON.parse((await propose(reportWithEnvelope)).output);
    const decision = { expectedGraphHash: graphHash, expectedDraftRevision: proposalId };
    const confirm = handler(WORK_BOARD.templateConfirm);
    expect(await confirm(event, proposalId, { ...decision, expectedGraphHash: "a".repeat(64) }, gesture))
      .toEqual({ ok: false, error: "stale-draft" });
    expect(await store.list()).toEqual([]);
    expect(await confirm(event, proposalId, decision)).toEqual({ ok: false, error: "user-gesture-required" });
    const results = await Promise.all([confirm(event, proposalId, decision, gesture), confirm(event, proposalId, decision, gesture)]);
    expect(results.filter(result => (result as { ok: boolean }).ok)).toHaveLength(1);
    const [template] = await store.list();
    expect(template).toMatchObject({ currentVersion: 1, name: reportDraft.name });
    expect(await store.getVersion(template.id, 1)).toMatchObject({
      graphHash, version: 1, stages: reportWithEnvelope.stages, confirmation: { who: "user", origin: "local-desktop" },
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(auditLog.mock.calls[0][0].output)).toEqual({
      event: "template_confirmed", proposalId, templateId: template.id, version: 1, graphHash, origin: "local-desktop",
    });
    expect(await handler(WORK_BOARD.templateProposalGet)(event, proposalId)).toEqual({ ok: false, error: "no-draft" });
  });
});

it.each([
  ["network", [{ host: "reports.example" }]],
  ["tools", ["read_file"]],
  ["mcpGenerationTools", [{ name: "media.render", effect: "generate", dataSent: true }]],
  ["pluginGenerationTools", [{ name: "media.render", effect: "generate", dataSent: false }]],
] as const)("refuses a model-drafted %s declaration", async (field, entries) => {
  await withTemplateProposal(async ({ path, propose }) => {
    const stages = [
      reportDraft.stages[0],
      { ...reportWithEnvelope.stages[1], envelope: { ...reportEnvelope, [field]: entries } },
    ];
    const result = await propose({ ...reportWithEnvelope, stages });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ error: "invalid-input", field: `stages.1.envelope.${field}` });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each([
  ["stages.0.gate.pass.kind", { ...reportDraft, stages: [{ ...reportDraft.stages[0], gate: { type: "auto", pass: { kind: "unknown" } } }] }],
  ["stages.0.allowSubAgents", { ...reportDraft, stages: [{ ...reportDraft.stages[0], allowSubAgents: undefined }] }],
  ["stages.0.envelope.writePaths", { ...reportDraft, stages: [{ ...reportDraft.stages[0], envelope: {} }] }],
  ["edges.0.to", { ...reportDraft, edges: [{ from: "gather", to: "missing" }] }],
  ["edges", { ...reportDraft, edges: [...reportDraft.edges, { from: "review", to: "gather" }] }],
  ["setupCommands", { ...reportDraft, setupCommands: ["prepare-report"] }],
] as const)("refuses invalid draft field %s without saving", async (field, input) => {
  await withTemplateProposal(async ({ path, propose }) => {
    const result = await propose(input);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ error: expect.any(String), field });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("refuses a headless proposal with a named reason and no confirmable draft", async () => {
  await withTemplateProposal(async ({ store, path, propose }) => {
    const result = await propose(reportDraft, { headless: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ error: "human-confirmation-unavailable" });
    expect(await store.list()).toEqual([]);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("refuses a proposal when the owner is unattended", async () => {
  await withTemplateProposal(async ({ path, propose }) => {
    const result = await runWithEffectGateContext({
      toolName: proposalToolName, headless: false, sessionId: reportSessionId, permissionContext: { ownerUnattended: true },
    }, () => propose(reportDraft));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ error: "human-confirmation-unavailable" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("refuses a proposal without a host session", async () => {
  await withTemplateProposal(async ({ propose }) => {
    const result = await propose(reportDraft, { sessionId: "" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ error: "human-confirmation-unavailable" });
  });
});

it("refuses a draft larger than 256 KiB", async () => {
  await withTemplateProposal(async ({ path, propose }) => {
    const setupCommands = Array.from({ length: 33 }, (_, index) => `prepare-${index}-${"x".repeat(8100)}`);
    const result = await propose({ ...reportDraft, setupCommands });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ error: "too-many-entries", field: "draft" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("evicts the oldest proposal upon exceeding 16 in one session", async () => {
  await withTemplateProposal(async ({ event, path, propose }) => {
    const receipts = [];
    for (let index = 0; index < 17; index++) {
      const result = await propose(reportDraft);
      expect(result.isError).toBe(false);
      receipts.push(JSON.parse(result.output) as { proposalId: string; graphHash: string });
    }
    const [oldest, ...retained] = receipts;
    const get = handler(WORK_BOARD.templateProposalGet);
    expect(await get(event, oldest.proposalId)).toEqual({ ok: false, error: "no-draft" });
    for (const { proposalId } of retained) {
      expect(await get(event, proposalId)).toMatchObject({ ok: true, value: { id: proposalId } });
    }
    expect(await handler(WORK_BOARD.templateConfirm)(event, oldest.proposalId, {
      expectedGraphHash: oldest.graphHash, expectedDraftRevision: oldest.proposalId,
    }, gesture)).toEqual({ ok: false, error: "no-draft" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("keeps an open proposal confirmable when another session exceeds its cap", async () => {
  await withTemplateProposal(async ({ event, propose }) => {
    const result = await propose(reportDraft);
    expect(result.isError).toBe(false);
    const { proposalId, graphHash } = JSON.parse(result.output);
    for (let index = 0; index < 17; index++) {
      expect((await propose(reportDraft, { sessionId: "another-session" })).isError).toBe(false);
    }
    expect(await handler(WORK_BOARD.templateConfirm)(event, proposalId, {
      expectedGraphHash: graphHash, expectedDraftRevision: proposalId,
    }, gesture)).toMatchObject({ ok: true, value: { version: 1, graphHash } });
  });
});

it("returns no-draft when confirming a proposal cleared by a restart", async () => {
  await withTemplateProposal(async ({ path, propose }) => {
    const result = await propose(reportDraft);
    expect(result.isError).toBe(false);
    const { proposalId, graphHash } = JSON.parse(result.output);
    const { event } = setup({ workflowTemplateStore: new WorkflowTemplateStore(path) });
    expect(await handler(WORK_BOARD.templateConfirm)(event, proposalId, {
      expectedGraphHash: graphHash, expectedDraftRevision: proposalId,
    }, gesture)).toEqual({ ok: false, error: "no-draft" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("guards every template handler before reading the store", async () => {
  const { event, store } = setup(); vi.mocked(validateHostRendererSender).mockReturnValue(false);
  for (const channel of [WORK_BOARD.templateList, WORK_BOARD.templateGet, WORK_BOARD.templateProposalGet, WORK_BOARD.templateDraft, WORK_BOARD.templateConfirm, WORK_BOARD.templateArchive, WORK_BOARD.templateAttachSchedule, WORK_BOARD.templateDetachSchedule]) expect(await handler(channel)(event)).toEqual({ ok: false, error: "unauthorized-frame" });
  for (const fn of [store.list, store.get, store.draft, store.confirmDraft, store.archive, store.attachSchedule, store.detachSchedule]) expect(fn).not.toHaveBeenCalled();
});
it("rejects malformed input and renderer supplied hashes or versions", async () => {
  const { event, store } = setup();
  for (const bad of [null, [], {}, { ...graph, graphHash: "a".repeat(64) }, { ...graph, revision: "renderer" }, { ...graph, version: 1 }, { ...graph, stages: [{ ...graph.stages[0], gate: { type: "auto", pass: { kind: "unknown" } } }] }]) expect(await handler(WORK_BOARD.templateDraft)(event, null, bad)).toMatchObject({ ok: false });
  expect(await handler(WORK_BOARD.templateGet)(event, "../bad")).toEqual({ ok: false, error: "invalid-input" });
  expect(await handler(WORK_BOARD.templateArchive)(event, 3)).toEqual({ ok: false, error: "invalid-input" });
  expect(await handler(WORK_BOARD.templateConfirm)(event, "t", { expectedGraphHash: "bad" }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(await handler(WORK_BOARD.templateConfirm)(event, "t", { expectedGraphHash: "a".repeat(64), expectedDraftRevision: "revision", origin: "tailnet-surface" }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(store.draft).not.toHaveBeenCalled(); expect(store.confirmDraft).not.toHaveBeenCalled();
});
it("requires a fresh local owner gesture for confirmation", async () => {
  const { event, store } = setup(); const request = { expectedGraphHash: "a".repeat(64), expectedDraftRevision: "revision" };
  expect(await handler(WORK_BOARD.templateConfirm)(event, "t", request)).toEqual({ ok: false, error: "user-gesture-required" });
  expect(await handler(WORK_BOARD.templateConfirm)({ ...event, senderFrame: {} }, "t", request, gesture)).toEqual({ ok: false, error: "unauthorized-frame" });
  expect(store.confirmDraft).not.toHaveBeenCalled();
  expect(await handler(WORK_BOARD.templateConfirm)(event, "t", request, gesture)).toEqual({ ok: true, value: {} });
  expect(store.confirmDraft).toHaveBeenCalledWith("t", request, { who: "user", origin: "local-desktop" });
});
it("broadcasts changed for successful draft, confirmation and archive writes", async () => {
  const { event } = setup();
  await handler(WORK_BOARD.templateDraft)(event, null, graph);
  await handler(WORK_BOARD.templateConfirm)(event, "t", { expectedGraphHash: "a".repeat(64), expectedDraftRevision: "revision" }, gesture);
  await handler(WORK_BOARD.templateArchive)(event, "t");
  expect(vi.mocked(broadcastToAppWindows).mock.calls.map(c => c[1])).toEqual([WORK_BOARD.templatesChanged, WORK_BOARD.templatesChanged, WORK_BOARD.templatesChanged]);
});

it("archives a template without touching the board or its run records", async () => {
  const touched: PropertyKey[] = [];
  const board = new Proxy({}, { get: (_target, key) => { touched.push(key); return undefined; } });
  const { event, store } = setup({ workBoardStore: board } as unknown as Partial<IpcDeps>);
  touched.length = 0;
  expect(await handler(WORK_BOARD.templateArchive)(event, "t")).toEqual({ ok: true, value: null });
  expect(store.archive).toHaveBeenCalledWith("t");
  expect(touched).toEqual([]);
});

it("hides unauthorized project templates and refuses project drafts", async () => {
  const { event, store } = setup();
  store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "project", projectRoot: "/private" } } } as never);
  expect(await handler(WORK_BOARD.templateGet)(event, "t")).toEqual({ ok: false, error: "template-not-found" });
  expect(await handler(WORK_BOARD.templateDraft)(event, null, { ...graph, scope: { kind: "project", projectRoot: "/private" } })).toEqual({ ok: false, error: "scope-not-authorised" });
  expect(store.draft).not.toHaveBeenCalled();
});

it("revalidates a draft project before confirmation", async () => {
  const { event, store } = setup();
  store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "all" } }, draft: { scope: { kind: "project", projectRoot: "/private" } } } as never);
  expect(await handler(WORK_BOARD.templateConfirm)(event, "t", { expectedGraphHash: "a".repeat(64), expectedDraftRevision: "revision" }, gesture)).toEqual({ ok: false, error: "scope-not-authorised" });
  expect(store.confirmDraft).not.toHaveBeenCalled();
});

it("requires local gesture and owner frame for schedule attachments and rejects remote origin", async () => {
  const { event, store } = setup(); const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, request)).toEqual({ ok: false, error: "user-gesture-required" });
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, { ...request, origin: "tailnet-surface" }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(await handler(WORK_BOARD.templateAttachSchedule)({ ...event, senderFrame: {} }, request, gesture)).toEqual({ ok: false, error: "unauthorized-frame" });
  expect(store.attachSchedule).not.toHaveBeenCalled();
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, request, gesture)).toEqual({ ok: true, value: {} });
  expect(store.attachSchedule).toHaveBeenCalledWith(request, expect.objectContaining({ origin: "local-desktop", auditId: expect.any(String), decidedAt: expect.any(String) }), { kind: "all" });
});

it("revalidates attachment project access and does not write on refusal", async () => {
  const { event, store } = setup(); store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "project", projectRoot: "/private" } } } as never);
  const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, request, gesture)).toEqual({ ok: false, error: "scope-not-authorised" }); expect(store.attachSchedule).not.toHaveBeenCalled();
});

it("requires detach gesture and refuses renderer-supplied host proofs", async () => {
  const { event, store } = setup(); const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  const forged = { origin: "local-desktop", auditId: "forged", decidedAt: "2026-01-01" };
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, { ...request, proof: forged }, gesture)).toMatchObject({ ok: false, error: "invalid-input" });
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, request, gesture, forged)).toMatchObject({ ok: false, error: "invalid-input" });
  expect(await handler(WORK_BOARD.templateDetachSchedule)(event, "attachment")).toMatchObject({ ok: false, error: "user-gesture-required" });
  expect(await handler(WORK_BOARD.templateDetachSchedule)({ ...event, senderFrame: {} }, "attachment", gesture)).toMatchObject({ ok: false, error: "unauthorized-frame" });
  expect(await handler(WORK_BOARD.templateDetachSchedule)(event, { id: "attachment", proof: forged }, gesture)).toMatchObject({ ok: false, error: "invalid-input" });
  expect(store.detachSchedule).not.toHaveBeenCalled();
  expect(await handler(WORK_BOARD.templateDetachSchedule)(event, "attachment", gesture)).toEqual({ ok: true, value: true });
  expect(store.detachSchedule).toHaveBeenCalledWith("attachment", expect.objectContaining({ origin: "local-desktop", auditId: expect.any(String), decidedAt: expect.any(String) }));
});

it("returns the typed confirmation refusal list over IPC", async () => {
  const { WorkflowTemplateError } = await import("../../../work-board/template-graph.js"); const { store, event } = setup(); store.confirmDraft.mockRejectedValueOnce(new WorkflowTemplateError("envelope-refused", "Stage confirmation refused", ["outputs-need-human-gate"]));
  expect(await handler(WORK_BOARD.templateConfirm)(event, "t", { expectedGraphHash: "a".repeat(64), expectedDraftRevision: "revision" }, gesture)).toEqual({ ok: false, error: "envelope-refused", refusals: ["outputs-need-human-gate"] });
});

it("stores the authorized project root instead of its renderer alias", async () => {
  const { resolveAuthorizedWorkspaceProject } = await import("../../../main/project-root-authorization.js");
  vi.mocked(resolveAuthorizedWorkspaceProject).mockReturnValueOnce({ authorized: true, project: { projectRoot: "/project/example", projectName: "Example", isDefault: false } });
  const { store, event } = setup();
  expect(await handler(WORK_BOARD.templateDraft)(event, null, { ...graph, scope: { kind: "project", projectRoot: "/project/example/" } })).toMatchObject({ ok: true });
  expect(store.draft).toHaveBeenCalledWith(null, expect.objectContaining({ scope: { kind: "project", projectRoot: "/project/example" } }));
});

it("returns typed row refusals over IPC without invoking execution or gates", async () => {
  const { WorkflowTemplateError } = await import("../../../work-board/template-graph.js");
  const board = { get: vi.fn(async () => ({ status: "found", itemId: 2, item: { id: 2, templateRunError: "invalid-template-run" } })), update: vi.fn(async () => { throw new WorkflowTemplateError("invalid-template-run"); }) };
  const engine = { runItem: vi.fn(), decidePlan: vi.fn(), projectTemplateRuns: async (items: unknown[]) => items, adoptParkedTemplateRuns: async () => {}, cancelRun: vi.fn(() => { throw new WorkflowTemplateError("invalid-template-run"); }) };
  const { event } = setup({ workBoardStore: board, workBoardEngine: engine } as unknown as Partial<IpcDeps>);
  expect(await handler(WORK_BOARD.get)(event, 2)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
  expect(await handler(WORK_BOARD.update)(event, 2, { title: "Changed" })).toMatchObject({ status: "invalid", reason: "invalid-template-run" });
  expect(await handler(WORK_BOARD.run)(event, 2)).toEqual({ status: "error", reason: "invalid-template-run" });
  expect(await handler(WORK_BOARD.decidePlan)(event, 2, { runId: "run", planHash: "a".repeat(64), decision: "approve" }, gesture)).toEqual({ ok: false, reason: "invalid-template-run" });
  expect(engine.runItem).not.toHaveBeenCalled(); expect(engine.decidePlan).not.toHaveBeenCalled();
  expect(await handler(WORK_BOARD.cancelRun)(event, 2, gesture)).toEqual({ ok: false, error: "invalid-template-run" });
  // A row whose run file awaits review is refused the same way by run and decide.
  board.get.mockImplementation(async () => ({ status: "found", itemId: 2, item: { id: 2, templateRunError: "template-runs-pending-review" } }));
  expect(await handler(WORK_BOARD.run)(event, 2)).toEqual({ status: "error", reason: "invalid-template-run" });
  expect(await handler(WORK_BOARD.decidePlan)(event, 2, { runId: "run", planHash: "a".repeat(64), decision: "approve" }, gesture)).toEqual({ ok: false, reason: "invalid-template-run" });
  expect(engine.runItem).not.toHaveBeenCalled(); expect(engine.decidePlan).not.toHaveBeenCalled();
});

it("passes the resolved authorized project snapshot to attachment storage", async () => {
  const { resolveAuthorizedWorkspaceProject } = await import("../../../main/project-root-authorization.js");
  vi.mocked(resolveAuthorizedWorkspaceProject).mockReturnValue({ authorized: true, project: { projectRoot: "/projects/a", projectName: "A", isDefault: false } });
  const { event, store } = setup(); store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "project", projectRoot: "/projects/a/" } } } as never);
  const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  expect(await handler(WORK_BOARD.templateAttachSchedule)(event, request, gesture)).toMatchObject({ ok: true });
  expect(store.attachSchedule).toHaveBeenCalledWith(request, expect.anything(), { kind: "project", projectRoot: "/projects/a" });
  vi.mocked(resolveAuthorizedWorkspaceProject).mockReturnValue({ authorized: false, project: null });
});

it("detaches after project authorization is withdrawn while preserving local decision checks", async () => {
  const { resolveAuthorizedWorkspaceProject } = await import("../../../main/project-root-authorization.js");
  vi.mocked(resolveAuthorizedWorkspaceProject).mockReturnValue({ authorized: false, project: null });
  const { event, store } = setup(); store.get.mockResolvedValue({ template: { id: "t", scope: { kind: "project", projectRoot: "/projects/a" } } } as never);
  expect(await handler(WORK_BOARD.templateDetachSchedule)(event, "attachment")).toEqual({ ok: false, error: "user-gesture-required" });
  expect(await handler(WORK_BOARD.templateDetachSchedule)({ ...event, senderFrame: {} }, "attachment", gesture)).toEqual({ ok: false, error: "unauthorized-frame" });
  vi.mocked(validateHostRendererSender).mockReturnValueOnce(false);
  expect(await handler(WORK_BOARD.templateDetachSchedule)(event, "attachment", gesture)).toEqual({ ok: false, error: "unauthorized-frame" });
  expect(store.getAttachment).not.toHaveBeenCalled(); expect(store.detachSchedule).not.toHaveBeenCalled();
  expect(await handler(WORK_BOARD.templateDetachSchedule)(event, "attachment", gesture)).toEqual({ ok: true, value: true });
  expect(store.get).not.toHaveBeenCalled();
  expect(store.detachSchedule).toHaveBeenCalledWith("attachment", expect.objectContaining({ origin: "local-desktop" }));
});

it("returns the declared read error when a board read throws on a malformed run file", async () => {
  const { WorkflowTemplateError } = await import("../../../work-board/template-graph.js");
  const read = vi.fn(async () => { throw new WorkflowTemplateError("invalid-template-run"); });
  const { event } = setup({ workBoardStore: { get: read, list: read } } as unknown as Partial<IpcDeps>);
  expect(await handler(WORK_BOARD.list)(event)).toEqual({ ok: false, error: "invalid-template-run" });
  expect(await handler(WORK_BOARD.get)(event, 2)).toEqual({ ok: false, error: "invalid-template-run" });
});
