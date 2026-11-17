import { beforeEach, expect, it, vi } from "vitest";
import { registerWorkBoardHandlers } from "../work-board.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { validateHostRendererSender } from "../../gated.js";
import { ChangeSignal } from "../../../lib/change-signal.js";
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
  registerWorkBoardHandlers({ workflowTemplateStore: store, auditLogger: { log: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window], ...extra } as unknown as IpcDeps);
  return { store, event: { sender, senderFrame: sender.mainFrame } };
}
beforeEach(() => { h.clear(); vi.mocked(validateHostRendererSender).mockReturnValue(true); vi.mocked(broadcastToAppWindows).mockClear(); });
it("guards every template handler before reading the store", async () => {
  const { event, store } = setup(); vi.mocked(validateHostRendererSender).mockReturnValue(false);
  for (const channel of [WORK_BOARD.templateList, WORK_BOARD.templateGet, WORK_BOARD.templateDraft, WORK_BOARD.templateConfirm, WORK_BOARD.templateArchive, WORK_BOARD.templateAttachSchedule, WORK_BOARD.templateDetachSchedule]) expect(await handler(channel)(event)).toEqual({ ok: false, error: "unauthorized-frame" });
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
  const engine = { runItem: vi.fn(), decidePlan: vi.fn(), cancelRun: vi.fn(() => { throw new WorkflowTemplateError("invalid-template-run"); }) };
  const { event } = setup({ workBoardStore: board, workBoardEngine: engine } as unknown as Partial<IpcDeps>);
  expect(await handler(WORK_BOARD.get)(event, 2)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
  expect(await handler(WORK_BOARD.update)(event, 2, { title: "Changed" })).toMatchObject({ status: "invalid", reason: "invalid-template-run" });
  expect(await handler(WORK_BOARD.run)(event, 2)).toEqual({ status: "error", reason: "invalid-template-run" });
  expect(await handler(WORK_BOARD.decidePlan)(event, 2, { runId: "run", planHash: "a".repeat(64), decision: "approve" }, gesture)).toEqual({ ok: false, reason: "invalid-template-run" });
  expect(engine.runItem).not.toHaveBeenCalled(); expect(engine.decidePlan).not.toHaveBeenCalled();
  expect(await handler(WORK_BOARD.cancelRun)(event, 2, gesture)).toEqual({ ok: false, error: "invalid-template-run" });
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
