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
