import { trackPermissionEvents } from "./support/permission-events.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { foreignFrameEvent, hostFrameEvent } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  protocol: { handle: vi.fn() },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: {},
}));

const permissionEvents = trackPermissionEvents();
const feedbackEvents = () => permissionEvents().filter((entry) => entry.event === "chat_feedback");

const starredList = vi.fn(() => [] as unknown[]);
const starredAdd = vi.fn(() => ({ id: "x", sessionId: "s1", messageIndex: 0, role: "assistant", text: "", starredAt: new Date().toISOString() }));

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    starredStore: { list: starredList, add: starredAdd, remove: vi.fn(), removeBySessionAndIndex: vi.fn(), listBySession: vi.fn() },
    settingsService: { getAll: vi.fn(() => ({})), get: vi.fn(() => ({})), patch: vi.fn(), getSecret: vi.fn(() => null), setSecret: vi.fn(), deleteSecret: vi.fn() },
    conversationLoop: {
      getSessionId: vi.fn(() => "sess-test"),
      hasProvider: vi.fn(() => true),
      runTurn: vi.fn(),
      newConversation: vi.fn(),
      listSessions: vi.fn(() => []),
      loadSession: vi.fn(() => true),
      getHistory: vi.fn(() => ({ getMessages: vi.fn(() => []) })),
      refreshProvider: vi.fn(),
      abortCurrentTurn: vi.fn(),
      manualCompact: vi.fn(),
      resetAndResume: vi.fn(),
      permissionManager: null,
    },
    pluginRuntime: { subscribePluginStateChange: vi.fn(() => () => undefined), listUiExtensions: vi.fn(() => []), listPluginCards: vi.fn(() => []), callFromUi: vi.fn(), restartAll: vi.fn(), getPerfStats: vi.fn(() => ({})) },
    pluginMarketplace: { list: vi.fn(() => []), install: vi.fn(), uninstall: vi.fn() },
    memoryManager: { listMemoryEntries: vi.fn(() => []), saveMemory: vi.fn(), deleteMemory: vi.fn(), searchMemoryEntries: vi.fn(() => []), getMemoryContext: vi.fn(() => ""), getUserPreferences: vi.fn(() => ""), updateUserPreferences: vi.fn(), sessions: { saveSession: vi.fn() } },
    approvalGate: null,
    mcpManager: { listServers: vi.fn(() => []), killSwitch: vi.fn(), setPackageTransactionProbe: vi.fn() },
    ...overrides,
  };
}

import { registerIpcHandlers } from "../ipc-bridge.js";

describe("ave:feedback:submit", () => {
  beforeEach(() => {
    handlers.clear();
    starredList.mockClear();
    starredAdd.mockClear();

    registerIpcHandlers(makeServices() as never, () => null);
  });

  it("rejects unauthorized frame", async () => {
    const handler = handlers.get("ave:feedback:submit")!;
    const result = await handler(foreignFrameEvent("https://evil.example.com"), { sessionId: "s1", messageIndex: 0, rating: "up" });
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(starredAdd).not.toHaveBeenCalled();
    expect(feedbackEvents()).toEqual([]);
  });

  it("logs structured thumbs-up feedback without a reason", async () => {
    const handler = handlers.get("ave:feedback:submit")!;
    const result = await handler(hostFrameEvent(), { sessionId: "sess-42", messageIndex: 3, rating: "up" });
    expect(result).toEqual({ ok: true });
    expect(feedbackEvents()).toEqual([{ event: "chat_feedback", sessionId: "sess-42", rating: "up", messageIndex: 3 }]);
  });

  it("keeps a dislike log record free of reason text", async () => {
    const handler = handlers.get("ave:feedback:submit")!;
    const result = await handler(hostFrameEvent(), { sessionId: "sess-42", messageIndex: 5, rating: "down", reason: "not helpful" });
    expect(result).toEqual({ ok: true });

    expect(feedbackEvents()).toEqual([{ event: "chat_feedback", sessionId: "sess-42", rating: "down", messageIndex: 5 }]);
    expect(starredAdd).not.toHaveBeenCalled();
  });

  it("accepts a long reason without including it in the log record", async () => {
    const handler = handlers.get("ave:feedback:submit")!;
    const longReason = "x".repeat(300);
    await handler(hostFrameEvent(), { sessionId: "s", messageIndex: 0, rating: "down", reason: longReason });

    expect(feedbackEvents()).toEqual([{ event: "chat_feedback", sessionId: "s", rating: "down", messageIndex: 0 }]);
  });

  it("auto-stars on thumbs-up when not already starred", async () => {
    starredList.mockReturnValue([]);
    const handler = handlers.get("ave:feedback:submit")!;
    await handler(hostFrameEvent(), { sessionId: "s1", messageIndex: 2, rating: "up" });
    expect(starredAdd).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", messageIndex: 2 }));
    expect(feedbackEvents()).toEqual([{ event: "chat_feedback", sessionId: "s1", rating: "up", messageIndex: 2 }]);
  });

  it("skips auto-star on thumbs-up when already starred", async () => {
    starredList.mockReturnValue([{ id: "x", sessionId: "s1", messageIndex: 2, role: "assistant", text: "", starredAt: "" }]);
    const handler = handlers.get("ave:feedback:submit")!;
    await handler(hostFrameEvent(), { sessionId: "s1", messageIndex: 2, rating: "up" });
    expect(starredAdd).not.toHaveBeenCalled();
  });

  it("returns invalid-args for bad payload", async () => {
    const handler = handlers.get("ave:feedback:submit")!;
    const result = await handler(hostFrameEvent(), { sessionId: "s", messageIndex: 0, rating: "invalid" });
    expect(result).toMatchObject({ ok: false, error: "invalid-args" });
  });

  it("returns invalid-args for negative messageIndex", async () => {
    const handler = handlers.get("ave:feedback:submit")!;
    const result = await handler(hostFrameEvent(), { sessionId: "s", messageIndex: -1, rating: "down" });
    expect(result).toMatchObject({ ok: false, error: "invalid-args" });
  });
});
