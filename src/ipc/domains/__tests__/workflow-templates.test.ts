import { beforeEach, expect, it, vi } from "vitest";
import { registerWorkBoardHandlers } from "../work-board.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { validateHostRendererSender } from "../../gated.js";
import { ChangeSignal } from "../../../lib/change-signal.js";
import type { IpcDeps } from "../../types.js";
const h = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>());
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, fn: any) => h.set(key, fn) } }));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: vi.fn(() => true), auditUnauthorized: vi.fn(), UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" } }));
vi.mock("../../../main/project-root-authorization.js", () => ({ resolveAuthorizedWorkspaceProject: vi.fn(() => ({ authorized: false, project: null })) }));
vi.mock("../../window-fanout.js", () => ({ broadcastToAppWindows: vi.fn() }));
import { broadcastToAppWindows } from "../../window-fanout.js";
const graph = { name: "Template", scope: { kind: "all" }, stages: [{ id: "a", name: "A", goal: "Read", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" } }], edges: [] };
const gesture = { inputOrigin: "user-keyboard", userActivation: true };
function setup() {
  const sender = { isDestroyed: () => false, mainFrame: {} }; const window = { isDestroyed: () => false, webContents: sender };
  const changed = new ChangeSignal(() => {});
  const store = { list: vi.fn(async () => []), get: vi.fn(async (id: string) => ({ template: { id, scope: { kind: "all" } } })), draft: vi.fn(async () => { changed.emit(); return {}; }), confirm: vi.fn(async () => { changed.emit(); return {}; }), archive: vi.fn(async () => { changed.emit(); }), attachSchedule: vi.fn(async () => { changed.emit(); return {}; }), detachSchedule: vi.fn(async () => true), getAttachment: vi.fn(async () => ({ templateId: "t" })), changed };
  registerWorkBoardHandlers({ workflowTemplateStore: store, auditLogger: { log: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window] } as unknown as IpcDeps);
  return { store, event: { sender, senderFrame: sender.mainFrame } };
}
beforeEach(() => { h.clear(); vi.mocked(validateHostRendererSender).mockReturnValue(true); vi.mocked(broadcastToAppWindows).mockClear(); });
it("guards every template handler before reading the store", async () => {
  const { event, store } = setup(); vi.mocked(validateHostRendererSender).mockReturnValue(false);
  for (const channel of [WORK_BOARD.templateList, WORK_BOARD.templateGet, WORK_BOARD.templateDraft, WORK_BOARD.templateConfirm, WORK_BOARD.templateArchive, WORK_BOARD.templateAttachSchedule, WORK_BOARD.templateDetachSchedule]) expect(await h.get(channel)!(event)).toEqual({ ok: false, error: "unauthorized-frame" });
  for (const fn of [store.list, store.get, store.draft, store.confirm, store.archive, store.attachSchedule, store.detachSchedule]) expect(fn).not.toHaveBeenCalled();
});
it("rejects malformed input and renderer supplied hashes or versions", async () => {
  const { event, store } = setup();
  for (const bad of [null, [], {}, { ...graph, graphHash: "a".repeat(64) }, { ...graph, version: 1 }, { ...graph, stages: [{ ...graph.stages[0], gate: { type: "auto", pass: { kind: "unknown" } } }] }]) expect(await h.get(WORK_BOARD.templateDraft)!(event, null, bad)).toMatchObject({ ok: false });
  expect(await h.get(WORK_BOARD.templateGet)!(event, "../bad")).toEqual({ ok: false, error: "invalid-input" });
  expect(await h.get(WORK_BOARD.templateArchive)!(event, 3)).toEqual({ ok: false, error: "invalid-input" });
  expect(await h.get(WORK_BOARD.templateConfirm)!(event, "t", { expectedGraphHash: "bad" }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(await h.get(WORK_BOARD.templateConfirm)!(event, "t", { expectedGraphHash: "a".repeat(64), origin: "tailnet-surface" }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(store.draft).not.toHaveBeenCalled(); expect(store.confirm).not.toHaveBeenCalled();
});
it("requires a fresh local owner gesture for confirmation", async () => {
  const { event, store } = setup(); const request = { expectedGraphHash: "a".repeat(64) };
  expect(await h.get(WORK_BOARD.templateConfirm)!(event, "t", request)).toEqual({ ok: false, error: "user-gesture-required" });
  expect(await h.get(WORK_BOARD.templateConfirm)!({ ...event, senderFrame: {} }, "t", request, gesture)).toEqual({ ok: false, error: "unauthorized-frame" });
  expect(store.confirm).not.toHaveBeenCalled();
  expect(await h.get(WORK_BOARD.templateConfirm)!(event, "t", request, gesture)).toEqual({ ok: true, value: {} });
  expect(store.confirm).toHaveBeenCalledWith("t", request, { who: "user", origin: "local-desktop" });
});
it("broadcasts changed for successful draft, confirmation and archive writes", async () => {
  const { event } = setup();
  await h.get(WORK_BOARD.templateDraft)!(event, null, graph);
  await h.get(WORK_BOARD.templateConfirm)!(event, "t", { expectedGraphHash: "a".repeat(64) }, gesture);
  await h.get(WORK_BOARD.templateArchive)!(event, "t");
  expect(vi.mocked(broadcastToAppWindows).mock.calls.map(c => c[1])).toEqual([WORK_BOARD.templatesChanged, WORK_BOARD.templatesChanged, WORK_BOARD.templatesChanged]);
});

it("hides unauthorized project templates and refuses project drafts", async () => {
  const { event, store } = setup();
  store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "project", projectRoot: "/private" } } } as never);
  expect(await h.get(WORK_BOARD.templateGet)!(event, "t")).toEqual({ ok: false, error: "template-not-found" });
  expect(await h.get(WORK_BOARD.templateDraft)!(event, null, { ...graph, scope: { kind: "project", projectRoot: "/private" } })).toEqual({ ok: false, error: "invalid-input" });
  expect(store.draft).not.toHaveBeenCalled();
});

it("revalidates a draft project before confirmation", async () => {
  const { event, store } = setup();
  store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "all" } }, draft: { scope: { kind: "project", projectRoot: "/private" } } } as never);
  expect(await h.get(WORK_BOARD.templateConfirm)!(event, "t", { expectedGraphHash: "a".repeat(64) }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(store.confirm).not.toHaveBeenCalled();
});

it("requires local gesture and owner frame for schedule attachments and rejects remote origin", async () => {
  const { event, store } = setup(); const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!(event, request)).toEqual({ ok: false, error: "user-gesture-required" });
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!(event, { ...request, origin: "tailnet-surface" }, gesture)).toEqual({ ok: false, error: "invalid-input" });
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!({ ...event, senderFrame: {} }, request, gesture)).toEqual({ ok: false, error: "unauthorized-frame" });
  expect(store.attachSchedule).not.toHaveBeenCalled();
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!(event, request, gesture)).toEqual({ ok: true, value: {} });
  expect(store.attachSchedule).toHaveBeenCalledWith(request, expect.objectContaining({ origin: "local-desktop", auditId: expect.any(String), decidedAt: expect.any(String) }));
});

it("revalidates attachment project access and does not write on refusal", async () => {
  const { event, store } = setup(); store.get.mockResolvedValueOnce({ template: { id: "t", scope: { kind: "project", projectRoot: "/private" } } } as never);
  const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!(event, request, gesture)).toEqual({ ok: false, error: "template-not-found" }); expect(store.attachSchedule).not.toHaveBeenCalled();
});

it("requires detach gesture and refuses renderer-supplied host proofs", async () => {
  const { event, store } = setup(); const request = { templateId: "t", version: 1, graphHash: "a".repeat(64), scheduleId: "daily" };
  const forged = { origin: "local-desktop", auditId: "forged", decidedAt: "2026-01-01" };
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!(event, { ...request, proof: forged }, gesture)).toMatchObject({ ok: false, error: "invalid-input" });
  expect(await h.get(WORK_BOARD.templateAttachSchedule)!(event, request, gesture, forged)).toMatchObject({ ok: false, error: "invalid-input" });
  expect(await h.get(WORK_BOARD.templateDetachSchedule)!(event, "attachment")).toMatchObject({ ok: false, error: "user-gesture-required" });
  expect(await h.get(WORK_BOARD.templateDetachSchedule)!({ ...event, senderFrame: {} }, "attachment", gesture)).toMatchObject({ ok: false, error: "unauthorized-frame" });
  expect(await h.get(WORK_BOARD.templateDetachSchedule)!(event, { id: "attachment", proof: forged }, gesture)).toMatchObject({ ok: false, error: "invalid-input" });
  expect(store.detachSchedule).not.toHaveBeenCalled();
  expect(await h.get(WORK_BOARD.templateDetachSchedule)!(event, "attachment", gesture)).toEqual({ ok: true, value: true });
  expect(store.detachSchedule).toHaveBeenCalledWith("attachment", expect.objectContaining({ origin: "local-desktop", auditId: expect.any(String), decidedAt: expect.any(String) }));
});

it("returns the typed confirmation refusal list over IPC", async () => {
  const { WorkflowTemplateError } = await import("../../../work-board/template-graph.js"); const { store, event } = setup(); store.confirm.mockRejectedValueOnce(new WorkflowTemplateError("envelope-refused", "Stage confirmation refused", ["outputs-need-human-gate"]));
  expect(await h.get(WORK_BOARD.templateConfirm)!(event, "t", { expectedGraphHash: "a".repeat(64) }, gesture)).toEqual({ ok: false, error: "envelope-refused", refusals: ["outputs-need-human-gate"] });
});
