// A stage gate, a join decision, a stage retry and the start of a template run are work approvals: a sender-validated board-window main
// frame with a consumed keyboard gesture. The renderer names hashes and ids; it never mints the run source.
import { beforeEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import type { IpcDeps } from "../../types.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../../gated.js";
import { MAX_PLAN_NOTE_LENGTH } from "../../../shared/work-board-types.js";
import { registeredIpcHandlers } from "./test-helpers.js";

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return { handlers, handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) };
});

vi.mock("electron", () => {
  const electron = { ipcMain: { handle: ipc.handle } };
  return { ...electron, default: electron };
});

vi.mock("../../gated.js", () => ({
  validateHostRendererSender: vi.fn(() => true),
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" },
  auditUnauthorized: vi.fn(),
}));

const GESTURE = { inputOrigin: "user-keyboard", userActivation: true } as const;
const RUN = "0b0f5a9e-3a52-4c8e-9d0b-6f2f1c1f7a11";
const HASH = "a".repeat(64);
const TUPLE = { templateId: "tpl-1", version: 1, graphHash: HASH };
const gateInput = { runId: RUN, stageId: "a", attempt: 1, resultHash: HASH, decision: "approve" };
const joinInput = { runId: RUN, joinId: "step-1", conflictHash: HASH, decision: "retry_merge" };
const retryInput = { runId: RUN, stageId: "a" };

const handler = registeredIpcHandlers(ipc.handlers);

function setup(privacy: { piiRedactEnabled: boolean } = { piiRedactEnabled: false }) {
  const owner = { isDestroyed: () => false, send: vi.fn(), mainFrame: { url: "file:///index.html" } };
  const window = { isDestroyed: () => false, webContents: owner };
  const engine = {
    decideStageGate: vi.fn(async () => ({ ok: true, status: "approved" })),
    decideStageJoin: vi.fn(async () => ({ ok: true })),
    retryStage: vi.fn(async () => ({ ok: true })),
    runItem: vi.fn(async () => ({ status: "awaiting_approval" })),
    steerRun: vi.fn(() => ({ ok: true, messageId: "m-1" })),
  };
  const log = vi.fn();
  const base = { title: "t", status: "in_progress", status_resolved: "in_progress", priority: "medium", created_at: "x", updated_at: "x" };
  registerWorkBoardHandlers({
    workBoardStore: {
      get: async (id: number) => id === 7 ? { status: "found", item: { ...base, id: 7 } }
        : id === 9 ? { status: "found", item: { ...base, id: 9 } }
        : { status: "not_found", itemId: id },
    },
    workBoardEngine: engine,
    settingsService: { get: (key: string) => (key === "privacy" ? privacy : undefined) },
    auditLogger: { log },
    getMainWindow: () => window,
    getAppWindows: () => [window],
  } as unknown as IpcDeps);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  return { event, engine, log };
}

const decisions = [
  [WORK_BOARD.decideStage, gateInput, "decideStageGate"],
  [WORK_BOARD.decideJoin, joinInput, "decideStageJoin"],
  [WORK_BOARD.retryStage, retryInput, "retryStage"],
] as const;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  ipc.handlers.clear();
  vi.mocked(validateHostRendererSender).mockReturnValue(true);
  vi.mocked(auditUnauthorized).mockClear();
});

it("refuses without a keyboard gesture or from a non-owner frame", async () => {
  const { event, engine, log } = setup();
  const subframe = { ...event, senderFrame: { url: "file:///index.html" } };
  for (const [channel, input, method] of decisions) {
    for (const intent of [undefined, { inputOrigin: "user-keyboard", userActivation: false }, { inputOrigin: "queue-auto", userActivation: true }]) {
      await expect(handler(channel)(event, 7, input, intent)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
    }
    await expect(handler(channel)(subframe, 7, input, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    // A non-owner frame learns nothing about which items exist.
    await expect(handler(channel)(subframe, 8, input, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    vi.mocked(validateHostRendererSender).mockReturnValueOnce(false);
    await expect(handler(channel)(event, 7, input, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(engine[method]).not.toHaveBeenCalled();
  }
  expect(auditUnauthorized).toHaveBeenCalledTimes(9);
  expect(log).not.toHaveBeenCalled();
});

it("forwards a gesture-carrying decision with the host's approval surface and audits the decision, never the note", async () => {
  const { event, engine, log } = setup();
  await expect(handler(WORK_BOARD.decideStage)(event, 7, { ...gateInput, decision: "request_changes", note: "tighten the summary" }, GESTURE)).resolves.toEqual({ ok: true, status: "approved" });
  expect(engine.decideStageGate).toHaveBeenCalledWith(7, { ...gateInput, decision: "request_changes", note: "tighten the summary" }, { approvalSurface: event.sender });
  await expect(handler(WORK_BOARD.decideJoin)(event, 7, joinInput, GESTURE)).resolves.toEqual({ ok: true });
  expect(engine.decideStageJoin).toHaveBeenCalledWith(7, joinInput, { approvalSurface: event.sender });
  await expect(handler(WORK_BOARD.retryStage)(event, 7, retryInput, GESTURE)).resolves.toEqual({ ok: true });
  expect(engine.retryStage).toHaveBeenCalledWith(7, retryInput, { approvalSurface: event.sender });
  expect(log).toHaveBeenCalledTimes(3);
  const logged = log.mock.calls.map(call => (call[0] as { output: string; type: string; sessionId: string }));
  for (const entry of logged) {
    expect(entry).toMatchObject({ type: "approval", sessionId: "work-board:7" });
    expect(JSON.parse(entry.output)).toMatchObject({ event: "work-approval:stage-decided", origin: "local-desktop", runId: RUN });
    expect(entry.output).not.toContain("tighten");
  }
});

it("refuses a malformed or partial decision before the engine sees it", async () => {
  const { event, engine, log } = setup();
  const bad: [string, unknown][] = [
    [WORK_BOARD.decideStage, { ...gateInput, attempt: 4 }],
    [WORK_BOARD.decideStage, { ...gateInput, resultHash: "short" }],
    [WORK_BOARD.decideStage, { ...gateInput, stageId: "Not A Stage" }],
    [WORK_BOARD.decideStage, { ...gateInput, decision: "retry" }],
    [WORK_BOARD.decideStage, { ...gateInput, output: "the renderer's own text" }],
    [WORK_BOARD.decideStage, { runId: RUN, stageId: "a" }],
    [WORK_BOARD.decideJoin, { ...joinInput, decision: "approve" }],
    [WORK_BOARD.decideJoin, { ...joinInput, conflictHash: 5 }],
    [WORK_BOARD.retryStage, { ...retryInput, attempt: 2 }],
    [WORK_BOARD.retryStage, "a"],
  ];
  for (const [channel, input] of bad) await expect(handler(channel)(event, 7, input, GESTURE)).resolves.toEqual({ ok: false, reason: "invalid-input" });
  await expect(handler(WORK_BOARD.decideStage)(event, 7, { ...gateInput, note: "x".repeat(MAX_PLAN_NOTE_LENGTH + 1) }, GESTURE)).resolves.toEqual({ ok: false, reason: "note_too_long" });
  await expect(handler(WORK_BOARD.decideStage)(event, 8, gateInput, GESTURE)).resolves.toEqual({ ok: false, reason: "not_found" });
  await expect(handler(WORK_BOARD.decideStage)(event, "7", gateInput, GESTURE)).resolves.toEqual({ ok: false, reason: "invalid-input" });
  expect(engine.decideStageGate).not.toHaveBeenCalled();
  expect(engine.decideStageJoin).not.toHaveBeenCalled();
  expect(engine.retryStage).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it("redacts the note before the engine stores it and reports the count", async () => {
  const { event, engine } = setup({ piiRedactEnabled: true });
  const result = await handler(WORK_BOARD.decideStage)(event, 7, { ...gateInput, decision: "request_changes", note: "mail someone@example.com" }, GESTURE);
  const sent = (engine.decideStageGate.mock.calls[0] as unknown as [number, { note: string }])[1];
  expect(sent.note).not.toContain("someone@example.com");
  expect(result).toEqual({ ok: true, status: "approved", redactedCount: 1 });
});

it("starts a template run only from a gesture and the tuple the card showed, and mints the source itself", async () => {
  const { event, engine } = setup();
  const run = handler(WORK_BOARD.run);
  await expect(run(event, 7, { template: TUPLE })).resolves.toMatchObject({ status: "error", reasonCode: "user-gesture-required" });
  await expect(run(event, 7, { template: TUPLE }, { inputOrigin: "user-keyboard", userActivation: false })).resolves.toMatchObject({ status: "error", reasonCode: "user-gesture-required" });
  await expect(run(event, 7, { template: null }, GESTURE)).resolves.toMatchObject({ status: "error", reasonCode: "invalid-input" });
  await expect(run(event, 7, { template: { ...TUPLE, graphHash: "nope" } }, GESTURE)).resolves.toMatchObject({ status: "error", reasonCode: "invalid-input" });
  // A source object in the payload is not a tuple; nothing a renderer sends becomes the source.
  await expect(run(event, 7, { template: { ...TUPLE, kind: "schedule-attachment", attachmentId: "att-1" } }, GESTURE)).resolves.toMatchObject({ status: "error", reasonCode: "invalid-input" });
  await expect(run(event, 7, { template: TUPLE, templateSource: { kind: "schedule-attachment", attachmentId: "att-1", pin: TUPLE } }, GESTURE)).resolves.toEqual({ status: "awaiting_approval" });
  expect(engine.runItem).toHaveBeenCalledTimes(1);
  expect(engine.runItem).toHaveBeenCalledWith(7, { approvalSurface: event.sender, templateSource: { kind: "local-create-and-run", pin: TUPLE } });
});

it("leaves an ordinary run as it was: no gesture, no source", async () => {
  const { event, engine } = setup();
  await expect(handler(WORK_BOARD.run)(event, 9, { agentName: "helper", templateSource: { kind: "local-create-and-run", pin: TUPLE } })).resolves.toEqual({ status: "awaiting_approval" });
  expect(engine.runItem).toHaveBeenCalledWith(9, { agentName: "helper", approvalSurface: event.sender });
});

it("steers a template run by the exact stage shape and never lets any other argument reach the engine", async () => {
  const { event, engine } = setup();
  await expect(handler(WORK_BOARD.steerRun)(event, 7, "go", GESTURE, { stageId: "b" })).resolves.toEqual({ ok: true, messageId: "m-1" });
  expect(engine.steerRun).toHaveBeenLastCalledWith(7, "go", "b");
  for (const forged of ["b", { stageId: "sub-Forged Child" }, { stageId: "b", childSessionId: "child-9" }, null, ["b"]]) {
    await expect(handler(WORK_BOARD.steerRun)(event, 9, "go", GESTURE, forged)).resolves.toEqual({ ok: true, messageId: "m-1" });
    expect(engine.steerRun).toHaveBeenLastCalledWith(9, "go");
  }
});
