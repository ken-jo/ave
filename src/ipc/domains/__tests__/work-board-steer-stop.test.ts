// Steer and stop are local-user controls (permission-decision-tree.md S→T): sender-validated, board-owner frame, and a consumed keyboard
// gesture. A call without the gesture is refused, never downgraded to another principal the way a chat guide without one is.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import type { IpcDeps } from "../../types.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../../gated.js";
import { PARENT_DIRECTIVE_MAX_CHARS } from "../../../engine/parent-directive.js";
import { MAX_PLAN_NOTE_LENGTH } from "../../../shared/work-board-types.js";

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
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

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const h = ipc.handlers.get(channel);
  if (!h) throw new Error(`missing handler for ${channel}`);
  return h as (...args: unknown[]) => Promise<unknown>;
}

function setup(privacy: { piiRedactEnabled: boolean } = { piiRedactEnabled: false }) {
  const owner = { isDestroyed: () => false, mainFrame: { url: "file:///index.html" } };
  const window = { isDestroyed: () => false, webContents: owner };
  const steerRun = vi.fn(() => ({ ok: true, messageId: "m-7" }));
  const cancelRun = vi.fn(() => ({ ok: true }));
  registerWorkBoardHandlers({
    workBoardStore: {
      get: async (id: number) => id === 7
        ? { status: "found", item: { id: 7, title: "t", status: "in_progress", status_resolved: "in_progress", priority: "medium", created_at: "x", updated_at: "x" } }
        : { status: "not_found", itemId: id },
    },
    workBoardEngine: { steerRun, cancelRun },
    settingsService: { get: (key: string) => (key === "privacy" ? privacy : undefined) },
    auditLogger: { log: vi.fn() },
    getMainWindow: () => window,
    getAppWindows: () => [window],
  } as unknown as IpcDeps);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  return { event, steerRun, cancelRun };
}

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  ipc.handlers.clear();
  vi.mocked(validateHostRendererSender).mockReturnValue(true);
  vi.mocked(auditUnauthorized).mockClear();
});

describe("work-board steer and stop IPC", () => {
  it("forwards a gesture-carrying steer for the item; the engine picks the child, the renderer cannot", async () => {
    const { event, steerRun } = setup();
    await expect(handler(WORK_BOARD.steerRun)(event, 7, "also cover the edge cases", GESTURE, "sub-forged-child")).resolves.toStrictEqual({ ok: true, messageId: "m-7" });
    expect(steerRun).toHaveBeenCalledWith(7, "also cover the edge cases");
  });

  it("forwards a gesture-carrying stop for the item", async () => {
    const { event, cancelRun } = setup();
    await expect(handler(WORK_BOARD.cancelRun)(event, 7, GESTURE)).resolves.toEqual({ ok: true });
    expect(cancelRun).toHaveBeenCalledWith(7);
  });

  it.each([
    ["no intent", undefined],
    ["intent without a consumed gesture", { inputOrigin: "user-keyboard", userActivation: false }],
    ["another origin", { inputOrigin: "queue-auto", userActivation: true }],
  ])("refuses a steer and a stop with %s instead of downgrading it", async (_label, intent) => {
    const { event, steerRun, cancelRun } = setup();
    await expect(handler(WORK_BOARD.steerRun)(event, 7, "go", intent)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
    await expect(handler(WORK_BOARD.cancelRun)(event, 7, intent)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
    expect(steerRun).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("rejects an unverified sender as UNAUTHORIZED and audits it", async () => {
    const { event, steerRun, cancelRun } = setup();
    vi.mocked(validateHostRendererSender).mockReturnValue(false);
    await expect(handler(WORK_BOARD.steerRun)(event, 7, "go", GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    await expect(handler(WORK_BOARD.cancelRun)(event, 7, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(auditUnauthorized).toHaveBeenCalledTimes(2);
    expect(steerRun).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("rejects a frame that is not a board window's main frame", async () => {
    const { event, steerRun, cancelRun } = setup();
    const subframe = { ...event, senderFrame: { url: "file:///index.html" } };
    await expect(handler(WORK_BOARD.steerRun)(subframe, 7, "go", GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    await expect(handler(WORK_BOARD.cancelRun)(subframe, 7, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(steerRun).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("refuses unknown items, empty text and file references the child cannot open mid-run", async () => {
    const { event, steerRun, cancelRun } = setup();
    await expect(handler(WORK_BOARD.steerRun)(event, 8, "go", GESTURE)).resolves.toEqual({ ok: false, reason: "not-found" });
    await expect(handler(WORK_BOARD.cancelRun)(event, 8, GESTURE)).resolves.toEqual({ ok: false, reason: "not-found" });
    await expect(handler(WORK_BOARD.steerRun)(event, 7, "   ", GESTURE)).resolves.toEqual({ ok: false, reason: "empty-text" });
    const mention = await handler(WORK_BOARD.steerRun)(event, 7, 'see [File #1 — path: "a.ts" — lines: 1-2 — turn: "t" — hunk: null]', GESTURE);
    expect(mention).toMatchObject({ ok: false, reason: expect.stringMatching(/^file-reference-/) });
    expect(steerRun).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("applies the outgoing PII redaction before the text reaches the engine and reports the count", async () => {
    const { event, steerRun } = setup({ piiRedactEnabled: true });
    const result = await handler(WORK_BOARD.steerRun)(event, 7, "mail me at someone@example.com", GESTURE);
    expect(steerRun).toHaveBeenCalledTimes(1);
    const sent = (steerRun.mock.calls[0] as unknown as [number, string])[1];
    expect(sent).not.toContain("someone@example.com");
    expect(result).toStrictEqual({ ok: true, messageId: "m-7", redactedCount: 1 });
  });
  it("answers a non-main frame UNAUTHORIZED before saying whether the item exists", async () => {
    const { event, steerRun, cancelRun } = setup();
    const subframe = { ...event, senderFrame: { url: "file:///index.html" } };
    await expect(handler(WORK_BOARD.steerRun)(subframe, 8, "go", GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    await expect(handler(WORK_BOARD.cancelRun)(subframe, 8, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(steerRun).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("refuses oversized text before redaction or file-reference parsing", async () => {
    const { event, steerRun } = setup({ piiRedactEnabled: true });
    const oversized = `someone@example.com [File #1 — path: ${"x".repeat(PARENT_DIRECTIVE_MAX_CHARS)}`;
    await expect(handler(WORK_BOARD.steerRun)(event, 7, oversized, GESTURE)).resolves.toEqual({ ok: false, reason: "message-too-long" });
    expect(steerRun).not.toHaveBeenCalled();
  });
});

// A plan decision is a work approval (permission-decision-tree.md "Work approvals"): a user action on a host work object, outside the
// tool tree, behind the same boundary as steer and stop. It forwards only the run id, the plan hash and the decision.
const HASH = "a".repeat(64);
const INPUT = { runId: "run-1", planHash: HASH, decision: "approve" } as const;

function setupDecide(opts: { privacy?: { piiRedactEnabled: boolean }; continuation?: Promise<unknown> } = {}) {
  const sent: Array<[string, unknown]> = [];
  const owner = { isDestroyed: () => false, mainFrame: { url: "file:///index.html" }, send: (channel: string, payload: unknown) => sent.push([channel, payload]) };
  const window = { isDestroyed: () => false, webContents: owner };
  const decidePlan = vi.fn(async (_id: number, input: { decision: string }) => ({
    result: { ok: true as const, status: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested" },
    ...(opts.continuation ? { continuation: opts.continuation } : {}),
  }));
  const log = vi.fn();
  registerWorkBoardHandlers({
    workBoardStore: {
      get: async (id: number) => id === 7
        ? { status: "found", item: { id: 7, title: "t", status: "planned", status_resolved: "planned", priority: "medium", created_at: "x", updated_at: "x" } }
        : { status: "not_found", itemId: id },
    },
    workBoardEngine: { decidePlan },
    settingsService: { get: (key: string) => (key === "privacy" ? (opts.privacy ?? { piiRedactEnabled: false }) : undefined) },
    auditLogger: { log },
    getMainWindow: () => window,
    getAppWindows: () => [window],
  } as unknown as IpcDeps);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  return { event, decidePlan, log, sent, owner };
}

describe("work-board decide-plan IPC", () => {
  it("forwards the decision with the deciding window as the surface and audits it without the note", async () => {
    const { event, decidePlan, log, owner } = setupDecide();
    await expect(handler(WORK_BOARD.decidePlan)(event, 7, { ...INPUT, note: "PRIVATE-NOTE" }, GESTURE)).resolves.toEqual({ ok: true, status: "approved" });
    expect(decidePlan).toHaveBeenCalledWith(7, { runId: "run-1", planHash: HASH, decision: "approve", note: "PRIVATE-NOTE" }, { approvalSurface: owner });
    expect(log).toHaveBeenCalledTimes(1);
    const record = log.mock.calls[0]![0] as { sessionId: string; type: string; output: string };
    expect(record).toMatchObject({ sessionId: "work-board:7", type: "approval" });
    expect(JSON.parse(record.output)).toEqual({ event: "work-approval:decided", runId: "run-1", plan: HASH.slice(0, 8), decision: "approved", note: true });
    expect(record.output).not.toContain("PRIVATE-NOTE");
  });

  it("broadcasts the continued run as resumed, then its result", async () => {
    let settle!: (value: unknown) => void;
    const continuation = new Promise((r) => { settle = r; });
    const { event, sent } = setupDecide({ continuation });
    await handler(WORK_BOARD.decidePlan)(event, 7, INPUT, GESTURE);
    expect(sent.find(([channel]) => channel === WORK_BOARD.runStarted)?.[1]).toMatchObject({ itemId: 7, resumed: true });
    expect(sent.some(([channel]) => channel === WORK_BOARD.runFinished)).toBe(false);
    settle({ status: "completed" });
    await vi.waitFor(() => expect(sent.find(([channel]) => channel === WORK_BOARD.runFinished)?.[1]).toMatchObject({ itemId: 7, status: "completed" }));
  });

  it.each([
    ["no intent", undefined],
    ["intent without a consumed gesture", { inputOrigin: "user-keyboard", userActivation: false }],
    ["another origin", { inputOrigin: "queue-auto", userActivation: true }],
  ])("refuses a decision with %s instead of downgrading it", async (_label, intent) => {
    const { event, decidePlan, log } = setupDecide();
    await expect(handler(WORK_BOARD.decidePlan)(event, 7, INPUT, intent)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
    expect(decidePlan).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects an unverified sender and a non-owner frame as UNAUTHORIZED and audits them", async () => {
    const { event, decidePlan } = setupDecide();
    vi.mocked(validateHostRendererSender).mockReturnValue(false);
    await expect(handler(WORK_BOARD.decidePlan)(event, 7, INPUT, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    vi.mocked(validateHostRendererSender).mockReturnValue(true);
    const subframe = { ...event, senderFrame: { url: "file:///index.html" } };
    await expect(handler(WORK_BOARD.decidePlan)(subframe, 7, INPUT, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(auditUnauthorized).toHaveBeenCalledTimes(2);
    expect(decidePlan).not.toHaveBeenCalled();
  });

  it.each([
    ["plan text instead of a hash", { ...INPUT, planHash: "PLAN: do A" }],
    ["an extra field (the plan body)", { ...INPUT, plan: "PLAN: do A" }],
    ["an unknown decision", { ...INPUT, decision: "allow-always" }],
    ["a non-string note", { ...INPUT, note: 3 }],
    ["no payload", undefined],
  ])("refuses %s as invalid input", async (_label, input) => {
    const { event, decidePlan } = setupDecide();
    await expect(handler(WORK_BOARD.decidePlan)(event, 7, input, GESTURE)).resolves.toEqual({ ok: false, reason: "invalid-input" });
    expect(decidePlan).not.toHaveBeenCalled();
  });

  it("refuses an unknown item and an oversized note before the engine", async () => {
    const { event, decidePlan } = setupDecide();
    await expect(handler(WORK_BOARD.decidePlan)(event, 8, INPUT, GESTURE)).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(handler(WORK_BOARD.decidePlan)(event, 7, { ...INPUT, note: "x".repeat(MAX_PLAN_NOTE_LENGTH + 1) }, GESTURE))
      .resolves.toEqual({ ok: false, reason: "note_too_long" });
    expect(decidePlan).not.toHaveBeenCalled();
  });

  it("redacts PII from the note before the engine sees it and reports the count", async () => {
    const { event, decidePlan } = setupDecide({ privacy: { piiRedactEnabled: true } });
    const result = await handler(WORK_BOARD.decidePlan)(event, 7, { ...INPUT, decision: "request_changes", note: "mail me at someone@example.com" }, GESTURE);
    expect(result).toMatchObject({ ok: true, redactedCount: 1 });
    const sentNote = (decidePlan.mock.calls[0]![1] as unknown as { note: string }).note;
    expect(sentNote).not.toContain("someone@example.com");
  });
});
