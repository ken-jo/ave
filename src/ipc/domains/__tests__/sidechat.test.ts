import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_FENCE_OPEN,
} from "../../../shared/mcp-resource-bounds.js";

// Use a decodable PNG because normalization checks the bytes.
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const sent: Array<{ channel: string; payload: unknown }> = [];
vi.mock("../../safe-send.js", () => ({
  sendToWebContents: vi.fn((_wc: unknown, channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  }),
}));

vi.mock("../../../main/app-state.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../main/app-state.js")>();
  return {
    ...original,
    mainWindowForContents: vi.fn((contents: { id?: number }) => (contents?.id === 1 ? { id: 7 } : null)),
    setSideChatOwnerContents: vi.fn(original.setSideChatOwnerContents),
  };
});

import { registerSideChatHandlers } from "../sidechat.js";
import { setSideChatOwnerContents } from "../../../main/app-state.js";
import { browserTabRegistry } from "../../../main/browser/browser-tab-registry.js";
const terminalOwners = new Map<string, number>();
vi.mock("../../../main/terminal/pty-manager.js", () => ({
  terminalTabOwnerWindow: (tabId: string) => terminalOwners.get(tabId),
}));
import { CHANNELS } from "../../../contract/app-contract.js";
import { deferred } from "../../../__tests__/test-helpers.js";
import * as shellTasks from "../../../tools/shell-tools.js";

function rendererContents(senderId = 1): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id: senderId });
}

function ev(url?: string, senderId = 1, sender = rendererContents(senderId)): IpcMainInvokeEvent {
  return (url ? { senderFrame: { url }, sender } : { sender }) as unknown as IpcMainInvokeEvent;
}

function makeSideLoop() {
  let transitioning = false;
  const loop = {
    runTurn: vi.fn(async (_input: string, callbacks: Record<string, (...a: unknown[]) => void>) => {
      callbacks.onTextDelta?.("hi");
      return { route: "chat" };
    }),
    newConversation: vi.fn(),
    loadSession: vi.fn((_sessionId: string, _lease?: object): boolean | Promise<boolean> => true),
    getSessionId: vi.fn(() => "34fd6270-309d-4e47-878b-75c0742a6ac2"),
    getHistory: vi.fn(() => ({ getMessages: vi.fn((): unknown[] => []) })),
    listSessions: vi.fn(() => []),
    abortCurrentTurn: vi.fn(),
    isSessionTransitioning: vi.fn(() => transitioning),
    runSessionTransition: vi.fn(async (_reason: string, operation: (lease: object) => unknown) => {
      if (transitioning) throw new Error("conversation-loop:session-transition-in-progress");
      transitioning = true;
      try {
        return await operation({});
      } finally {
        transitioning = false;
      }
    }),
  };
  return loop;
}

function makeMainLoop() {
  return {
    runTurn: vi.fn(),
    abortCurrentTurn: vi.fn(),
    getSessionId: vi.fn(() => "89df5053-7dd8-4550-85c5-1a11011f7868"),
  };
}

function makeSideChatStore(existing?: Record<string, unknown>) {
  return {
    loadSessionMetadata: vi.fn((_sessionId: string): Record<string, unknown> | null => existing ?? null),
    saveSessionMetadata: vi.fn(async (_sessionId: string, _metadata: Record<string, unknown>) => {}),
    findPaneSession: vi.fn((_tabId: string): string | undefined => undefined),
    loadSession: vi.fn((_sessionId: string): unknown[] | null => null),
    hasSessionTranscript: vi.fn((_sessionId: string) => false),
    updateSessionRowFields: vi.fn(async (_sessionId: string, _fields: Record<string, unknown>) => {}),
  };
}

function makePanePool(make: () => ReturnType<typeof makeSideLoop> = makeSideLoop) {
  const entries = new Map<string, { windowId: number; tabId: string; loop: ReturnType<typeof makeSideLoop> }>();
  const key = (windowId: number, tabId: string) => `${windowId}/${tabId}`;
  return {
    entries,
    resolve: vi.fn((windowId: number, tabId: string) => {
      const existing = entries.get(key(windowId, tabId));
      if (existing) return existing.loop;
      const loop = make();
      entries.set(key(windowId, tabId), { windowId, tabId, loop });
      return loop;
    }),
    get: (windowId: number, tabId: string) => entries.get(key(windowId, tabId))?.loop,
    release: vi.fn((windowId: number, tabId: string) => {
      const entry = entries.get(key(windowId, tabId));
      if (!entry) return undefined;
      entries.delete(key(windowId, tabId));
      entry.loop.abortCurrentTurn();
      return entry.loop;
    }),
    inWindow: (windowId: number) => [...entries.values()].filter((entry) => entry.windowId === windowId).map(({ tabId, loop }) => ({ tabId, loop })),
    holding: (sessionId: string) => [...entries.values()].find((entry) => entry.loop.getSessionId() === sessionId),
    all: () => [...entries.values()].map((entry) => entry.loop),
  };
}

function register(
  sideLoop: unknown,
  mainLoop: unknown,
  piiRedactEnabled = false,
  sideChatMemoryManager: unknown = makeSideChatStore(),
  paneChatLoops: unknown = makePanePool(),
) {
  const deps = {
    conversationLoop: mainLoop,
    sideChatConversationLoop: sideLoop,
    paneChatLoops,
    sideChatMemoryManager,
    auditLogger: { log: vi.fn() },
    getMainWindow: () => ({ webContents: {} }),
    settingsService: {
      get: vi.fn((key: string) => (key === "privacy" ? { piiRedactEnabled } : undefined)),
    },
  };
  registerSideChatHandlers(deps as never);
  return { sideChatMemoryManager };
}

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
});

describe("side-chat IPC domain", () => {
  it("announces its current session before the first pending turn can publish tool events", async () => {
    const pending = deferred<{ route: string }>();
    const side = makeSideLoop();
    const main = makeMainLoop();
    let preludeAtTurnStart: unknown;
    side.runTurn.mockImplementation(async () => {
      preludeAtTurnStart = sent.find(({ payload }) => (payload as { type?: string }).type === "user_message")?.payload;
      return pending.promise;
    });
    register(side, main);
    const turn = handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), {
      input: "first turn", originSessionId: main.getSessionId(),
      sendRequestId: "side-request",
    });
    try {
      expect(side.runTurn).toHaveBeenCalledOnce();
      expect(preludeAtTurnStart).toMatchObject({
        type: "user_message", sessionId: side.getSessionId(), streamId: 1,
        sendRequestId: "side-request",
      });
      expect((preludeAtTurnStart as { sessionId: string }).sessionId).not.toBe(main.getSessionId());
    } finally {
      pending.resolve({ route: "chat" });
      await turn;
    }
  });

  it.each([null, 42, {}, [], "", " ", "x".repeat(257)])("refuses an invalid side-chat send correlation %j before starting a turn", async (sendRequestId) => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const result = await handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), { input: "hello", sendRequestId });
    expect(result).toEqual({ ok: false, error: "invalid-input" });
    expect(side.runTurn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("send drives the side loop and streams to ave:sidechat:stream (never chat.stream)", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "hello" });

    expect(result).toMatchObject({ ok: true });
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    expect(main.runTurn).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
    for (const frame of sent) {
      expect(frame.channel).toBe(CHANNELS.sidechat.stream);
      expect(frame.channel).not.toBe(CHANNELS.chat.stream);
    }
  });

  // Side-chat send sites must apply the same PII policy as main chat.
  it("redacts side-chat input before it reaches the loop when PII redaction is on", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop(), true);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    await handler(ev("file:///index.html"), { input: "email me at alice@example.com" });

    expect(side.runTurn).toHaveBeenCalledTimes(1);
    const forwarded = side.runTurn.mock.calls[0]![0] as string;
    expect(forwarded).not.toContain("alice@example.com");
  });

  it("forwards side-chat input verbatim when PII redaction is off", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop(), false);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    await handler(ev("file:///index.html"), { input: "email me at alice@example.com" });

    const forwarded = side.runTurn.mock.calls[0]![0] as string;
    expect(forwarded).toBe("email me at alice@example.com");
  });
  // Enforce attachment limits at turn entry because side-chat bypasses the main send parser.
  it("enforces the resource-attachment bound on the side loop too", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const fence = (i: number) =>
      `${MCP_RESOURCE_FENCE_OPEN} server="s" uri="file:///f${i}">\nB${i}\n</mcp-resource>`;

    const result = await handler(ev("file:///index.html"), {
      input: "compare these",
      attachments: Array.from({ length: MCP_RESOURCE_ATTACHMENTS_PER_TURN + 1 }, (_, i) => ({
        type: "text",
        text: fence(i),
      })),
    });

    expect(result).toMatchObject({ ok: false, error: "too-many-resource-attachments" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("a finished cancellation request leaves both loops untouched", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.abort)!;
    const result = await handler(ev("file:///index.html"), { sendRequestId: "finished-request" });
    expect(result).toEqual({ ok: true });
    expect(side.abortCurrentTurn).not.toHaveBeenCalled();
    expect(main.abortCurrentTurn).not.toHaveBeenCalled();
  });

  it.each(["missing-payload", "peer-renderer"] as const)("does not cancel an accepted turn from %s", async (scope) => {
    const turn = deferred<{ route: string }>();
    const side = makeSideLoop();
    side.runTurn.mockReturnValueOnce(turn.promise);
    register(side, makeMainLoop());
    const pending = handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html", 1), {
      input: "Own request", sendRequestId: "own-request",
    });
    let cancellation: unknown;
    try {
      cancellation = scope === "missing-payload"
        ? handlers.get(CHANNELS.sidechat.abort)!(ev("file:///index.html", 1))
        : handlers.get(CHANNELS.sidechat.abort)!(ev("file:///index.html", 2), { sendRequestId: "own-request" });
      expect(side.abortCurrentTurn).not.toHaveBeenCalled();
      await expect(cancellation).resolves.toEqual(scope === "missing-payload"
        ? { ok: false, error: "invalid-send-request-id" } : { ok: true });
    } finally {
      turn.resolve({ route: "chat" });
      await Promise.all([pending, cancellation]);
    }
  });

  it.each((["new", "load"] as const).flatMap((pendingTransition) =>
    (["send", "new", "load"] as const).map((attempt) => ({ pendingTransition, attempt })),
  ))("refuses $attempt while a $pendingTransition session transition is pending", async ({ pendingTransition, attempt }) => {
    const completion = deferred<boolean>();
    const entered = deferred<void>();
    const side = makeSideLoop();
    if (pendingTransition === "new") side.newConversation.mockImplementationOnce(() => {
      entered.resolve(undefined); return completion.promise;
    });
    else side.loadSession.mockImplementationOnce(() => {
      entered.resolve(undefined); return completion.promise;
    });
    register(side, makeMainLoop());
    const pending = pendingTransition === "new"
      ? handlers.get(CHANNELS.sidechat.new)!(ev("file:///index.html"))
      : handlers.get(CHANNELS.sidechat.load)!(ev("file:///index.html"), side.getSessionId());
    try {
      await entered.promise;
      side.abortCurrentTurn.mockClear();
      const blocked = attempt === "send"
        ? handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), { input: "Blocked request", sendRequestId: "blocked-request" })
        : attempt === "new" ? handlers.get(CHANNELS.sidechat.new)!(ev("file:///index.html"))
          : handlers.get(CHANNELS.sidechat.load)!(ev("file:///index.html"), side.getSessionId());
      await expect(blocked).resolves.toMatchObject({ ok: false, error: "streaming-active" });
      expect(side.runTurn).not.toHaveBeenCalled();
      expect(side.abortCurrentTurn).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    } finally {
      completion.resolve(true);
      await pending;
    }
  });

  it("a refused request cannot abort a peer's active turn", async () => {
    const turn = deferred<{ route: string }>();
    const side = makeSideLoop();
    side.runTurn.mockReturnValueOnce(turn.promise);
    register(side, makeMainLoop());
    const send = handlers.get(CHANNELS.sidechat.send)!;
    const abort = handlers.get(CHANNELS.sidechat.abort)!;
    const peer = send(ev("file:///index.html"), { input: "Peer request", sendRequestId: "peer-request" });
    let cancellation: unknown;
    try {
      await expect(send(ev("file:///index.html"), { input: "Local request", sendRequestId: "local-request" }))
        .resolves.toMatchObject({ ok: false, error: "streaming-active" });
      cancellation = abort(ev("file:///index.html"), { sendRequestId: "local-request" });
      expect(side.abortCurrentTurn).not.toHaveBeenCalled();
      await expect(cancellation).resolves.toEqual({ ok: true });
    } finally {
      turn.resolve({ route: "chat" });
      await Promise.all([peer, cancellation]);
    }
  });

  it("the accepted request can abort its own active turn", async () => {
    const turn = deferred<{ route: string }>();
    const side = makeSideLoop();
    side.runTurn.mockReturnValueOnce(turn.promise);
    const main = makeMainLoop();
    register(side, main);
    const pending = handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), { input: "Own request", sendRequestId: "own-request" });
    const cancellation = handlers.get(CHANNELS.sidechat.abort)!(ev("file:///index.html"), { sendRequestId: "own-request" });
    try {
      expect(side.abortCurrentTurn).toHaveBeenCalledOnce();
      expect(main.abortCurrentTurn).not.toHaveBeenCalled();
    } finally {
      turn.resolve({ route: "chat" });
      await Promise.all([pending, cancellation]);
    }
  });

  it.each([
    ["reloads", "did-navigate", []],
    ["fails to reload into an error page", "did-fail-provisional-load", [{}, -6, "ERR_FILE_NOT_FOUND", "file:///index.html", true]],
    ["crashes", "render-process-gone", [{}]],
    ["is destroyed", "destroyed", []],
  ] as const)("cancels its accepted turn when the owning renderer %s", async (_label, eventName, args) => {
    const turn = deferred<{ route: string }>();
    const side = makeSideLoop();
    side.abortCurrentTurn.mockImplementation(() => turn.resolve({ route: "chat" }));
    side.runTurn.mockReturnValueOnce(turn.promise);
    register(side, makeMainLoop());
    const owner = rendererContents(1);
    const peer = rendererContents(2);
    const pending = handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html", 1, owner), {
      input: "Own request", sendRequestId: "own-request",
    });
    try {
      // Cancelled main-frame, in-page, and subframe navigation retain the turn's owning document.
      peer.emit(eventName, ...args);
      owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      owner.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      owner.emit("did-navigate-in-page", {});
      owner.emit("did-frame-navigate", {});
      // Only a committed main-frame error page replaces ownership; aborted loads and subframe failures do not.
      owner.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "file:///index.html", true);
      owner.emit("did-fail-provisional-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///frame.html", false);
      owner.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///index.html", true);
      owner.emit("did-fail-load", {}, -300, "ERR_INVALID_URL", "http://[/", true);
      owner.emit("did-fail-load", {}, -354, "ERR_CONTENT_LENGTH_MISMATCH", "file:///index.html", true);
      expect(side.abortCurrentTurn).not.toHaveBeenCalled();
      owner.emit(eventName, ...args);
      expect(side.abortCurrentTurn).toHaveBeenCalledOnce();
      await pending;
      expect(owner.listenerCount("did-start-navigation") + owner.listenerCount("did-navigate")
        + owner.listenerCount("did-fail-provisional-load") + owner.listenerCount("render-process-gone")
        + owner.listenerCount("destroyed")).toBe(0);
    } finally {
      turn.resolve({ route: "chat" });
      await pending;
    }
  });

  it("keeps one departure watch per accepted turn and none after a turn fails", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const owner = rendererContents(1);
    const peer = rendererContents(2);
    const send = handlers.get(CHANNELS.sidechat.send)!;
    const watches = (contents: EventEmitter) => contents.listenerCount("did-navigate")
      + contents.listenerCount("did-fail-provisional-load") + contents.listenerCount("render-process-gone") + contents.listenerCount("destroyed");

    side.runTurn.mockRejectedValueOnce(new Error("provider failed"));
    await expect(send(ev("file:///index.html", 1, owner), { input: "fails", sendRequestId: "failed-request" }))
      .resolves.toMatchObject({ ok: false });
    expect(watches(owner)).toBe(0);
    await send(ev("file:///index.html", 1, owner), { input: "first", sendRequestId: "first-request" });
    expect(watches(owner)).toBe(0);

    const turn = deferred<{ route: string }>();
    side.runTurn.mockReturnValueOnce(turn.promise);
    const pending = send(ev("file:///index.html", 2, peer), { input: "peer", sendRequestId: "peer-request" });
    try {
      expect(watches(peer)).toBe(4);
      owner.emit("did-navigate");
      owner.emit("destroyed");
      expect(side.abortCurrentTurn).not.toHaveBeenCalled();
    } finally {
      turn.resolve({ route: "chat" });
      await pending;
    }
    expect(watches(peer)).toBe(0);
  });

  it.each([undefined, null, 17, [], {}, { sendRequestId: "" }, { sendRequestId: " " }, { sendRequestId: 17 }, { sendRequestId: "x".repeat(257) }])(
    "refuses malformed scoped abort payload %j", async (payload) => {
      const side = makeSideLoop();
      register(side, makeMainLoop());
      await expect(handlers.get(CHANNELS.sidechat.abort)!(ev("file:///index.html"), payload))
        .resolves.toEqual({ ok: false, error: "invalid-send-request-id" });
      expect(side.abortCurrentTurn).not.toHaveBeenCalled();
    },
  );

  it("new creates a fresh session on the side loop", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.new)!;
    const result = await handler(ev("file:///index.html"));
    expect(result).toEqual({ ok: true, sessionId: "34fd6270-309d-4e47-878b-75c0742a6ac2" });
    expect(side.newConversation).toHaveBeenCalledTimes(1);
  });

  it("new aborts + awaits an in-flight turn BEFORE starting the fresh session", async () => {
    let releaseTurn!: () => void;
    const order: string[] = [];
    const side = makeSideLoop();
    side.runTurn = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseTurn = () => {
            order.push("turn-settled");
            resolve({ route: "chat" });
          };
        }),
    );
    side.abortCurrentTurn = vi.fn(() => {
      order.push("abort");
      releaseTurn?.();
    });
    side.newConversation = vi.fn(() => order.push("newConversation"));
    register(side, makeMainLoop());

    const sendHandler = handlers.get(CHANNELS.sidechat.send)!;
    const sendPromise = sendHandler(ev("file:///index.html"), { input: "long turn" });

    const newHandler = handlers.get(CHANNELS.sidechat.new)!;
    const newRequest = newHandler(ev("file:///index.html"));
    expect(side.isSessionTransitioning()).toBe(true);
    const result = await newRequest;

    expect(result).toEqual({ ok: true, sessionId: "34fd6270-309d-4e47-878b-75c0742a6ac2" });
    // Abort and await the prior turn before mutating the session to prevent cross-session frames.
    expect(order).toEqual(["abort", "turn-settled", "newConversation"]);
    expect(side.abortCurrentTurn).toHaveBeenCalledTimes(1);
    await sendPromise;
  });

  it("load aborts + awaits an in-flight turn BEFORE loading the session", async () => {
    let releaseTurn!: () => void;
    const order: string[] = [];
    const side = makeSideLoop();
    side.runTurn = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseTurn = () => {
            order.push("turn-settled");
            resolve({ route: "chat" });
          };
        }),
    );
    side.abortCurrentTurn = vi.fn(() => {
      order.push("abort");
      releaseTurn?.();
    });
    side.loadSession = vi.fn(() => {
      order.push("loadSession");
      return true;
    });
    register(side, makeMainLoop());

    const sendHandler = handlers.get(CHANNELS.sidechat.send)!;
    const sendPromise = sendHandler(ev("file:///index.html"), { input: "long turn" });

    const loadHandler = handlers.get(CHANNELS.sidechat.load)!;
    const loadRequest = loadHandler(ev("file:///index.html"), "a17050c7-bb84-4fde-8554-b9ef7a678a92");
    expect(side.isSessionTransitioning()).toBe(true);
    const result = await loadRequest;

    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(["abort", "turn-settled", "loadSession"]);
    await sendPromise;
  });

  it("rejects an unauthorized frame on send", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("https://evil.example.com"), { input: "hello" });
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("rejects a send carrying neither text nor an attachment", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "   " });
    expect(result).toMatchObject({ ok: false, error: "empty-text" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  // Attachment-only sends are valid on the shared composer and must not leave an error bubble here.
  it("accepts an attachment-only send (no text)", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), {
      input: "",
      attachments: [{ type: "image", image: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`, mimeType: "image/png" }],
    });

    expect(result).toMatchObject({ ok: true });
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    const [, , , options] = side.runTurn.mock.calls[0] as unknown as [
      string,
      unknown,
      unknown,
      { attachments?: unknown[] },
    ];
    expect(options.attachments).toHaveLength(1);
  });

  // Refuse concurrent turns on the same loop; interleaved histories cannot be repaired by queue draining.
  it("refuses a second send while a side turn is still streaming", async () => {
    let releaseTurn!: () => void;
    const side = makeSideLoop();
    side.runTurn = vi.fn(
      () => new Promise((resolve) => { releaseTurn = () => resolve({ route: "chat" }); }),
    );
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    const first = handler(ev("file:///index.html"), { input: "first", sendRequestId: "first-request" });
    const second = await handler(ev("file:///index.html"), { input: "second", sendRequestId: "second-request" });

    expect(second).toMatchObject({ ok: false, error: "streaming-active" });
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "user_message")
      .map(({ payload }) => (payload as { sendRequestId?: string }).sendRequestId)).toEqual(["first-request"]);

    releaseTurn();
    await first;

    const settledTurn = vi.fn(async () => ({ route: "chat" }));
    side.runTurn = settledTurn;
    const third = await handler(ev("file:///index.html"), { input: "third", sendRequestId: "third-request" });
    expect(third).toMatchObject({ ok: true });
    expect(settledTurn).toHaveBeenCalledTimes(1);
    expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "user_message")
      .map(({ payload }) => (payload as { sendRequestId?: string }).sendRequestId)).toEqual(["first-request", "third-request"]);
  });

  it("can start the next turn while an earlier failed reply awaits origin persistence", async () => {
    const originReady = deferred<void>();
    const nextTurnReady = deferred<{ route: string }>();
    const side = makeSideLoop();
    const main = makeMainLoop();
    const store = makeSideChatStore();
    store.saveSessionMetadata.mockReturnValueOnce(originReady.promise);
    side.runTurn.mockImplementationOnce(async (...args: unknown[]) => {
      (args[1] as { onError: (message: string) => void }).onError("First turn failed");
      throw new Error("First turn failed");
    }).mockReturnValueOnce(nextTurnReady.promise);
    register(side, main, false, store);
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const first = handler(ev("file:///index.html"), {
      input: "first", originSessionId: main.getSessionId(), sendRequestId: "first-request",
    });
    let firstSettled = false;
    void Promise.resolve(first).then(() => { firstSettled = true; });
    let next: unknown;
    try {
      await vi.waitFor(() => expect(store.saveSessionMetadata).toHaveBeenCalledOnce());
      next = handler(ev("file:///index.html"), {
        input: "next", originSessionId: main.getSessionId(), sendRequestId: "next-request",
      });
      expect(firstSettled).toBe(false);
      expect(side.runTurn).toHaveBeenCalledTimes(2);
      expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "user_message")
        .map(({ payload }) => (payload as { sendRequestId?: string }).sendRequestId)).toEqual(["first-request", "next-request"]);
    } finally {
      originReady.resolve(undefined);
      nextTurnReady.resolve({ route: "chat" });
      await Promise.all([first, next]);
    }
  });

  it("fails closed when the side-chat loop is absent", async () => {
    register(undefined, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "hello" });
    expect(result).toMatchObject({ ok: false, error: "side-chat-unavailable" });
  });
});

describe("side-chat parentage", () => {
  const PARENT = "89df5053-7dd8-4550-85c5-1a11011f7868";

  it("keeps the first parent when consecutive turns overlap origin persistence", async () => {
    const entered = deferred<void>();
    const completion = deferred<void>();
    let metadata: Record<string, unknown> | null = null;
    const store = makeSideChatStore();
    store.loadSessionMetadata.mockImplementation(() => metadata);
    store.saveSessionMetadata.mockImplementation(async (_id, next) => {
      entered.resolve(undefined);
      await completion.promise;
      metadata = next;
    });
    const side = makeSideLoop();
    register(side, makeMainLoop(), false, store);
    const send = handlers.get(CHANNELS.sidechat.send)!;
    const first = send(ev("file:///index.html"), { input: "First prompt", originSessionId: PARENT, sendRequestId: "first-request" });
    let second: unknown;
    try {
      await entered.promise;
      second = send(ev("file:///index.html"), {
        input: "Second prompt", originSessionId: side.getSessionId(), sendRequestId: "second-request",
      });
      await vi.waitFor(() => expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "done")).toHaveLength(2));
      expect(side.runTurn).toHaveBeenCalledTimes(2);
    } finally {
      completion.resolve(undefined);
      await Promise.all([first, second]);
    }
    expect(metadata).toMatchObject({ originSessionId: PARENT });
    expect(store.saveSessionMetadata).toHaveBeenCalledOnce();
  });

  it("records the conversation a side chat belongs to on its first turn", async () => {
    const store = makeSideChatStore();
    register(makeSideLoop(), makeMainLoop(), false, store);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    await handler(ev("file:///index.html"), { input: "hello", originSessionId: PARENT });

    expect(store.saveSessionMetadata).toHaveBeenCalledWith(
      "34fd6270-309d-4e47-878b-75c0742a6ac2",
      expect.objectContaining({ originSessionId: PARENT }),
    );
  });

  it("does not re-parent a side chat that already has a conversation", async () => {
    const store = makeSideChatStore({ originSessionId: "11111111-2222-3333-4444-555555555555" });
    register(makeSideLoop(), makeMainLoop(), false, store);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    await handler(ev("file:///index.html"), { input: "hello", originSessionId: PARENT });

    expect(store.saveSessionMetadata).not.toHaveBeenCalled();
  });

  it("ignores a parent that is not a session id, and still runs the turn", async () => {
    const store = makeSideChatStore();
    const side = makeSideLoop();
    register(side, makeMainLoop(), false, store);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    const result = await handler(ev("file:///index.html"), {
      input: "hello",
      originSessionId: "../../etc/passwd",
    });

    expect(result).toMatchObject({ ok: true });
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    expect(store.saveSessionMetadata).not.toHaveBeenCalled();
  });
});

describe("side-chat turns bound to a pane", () => {
  beforeEach(() => browserTabRegistry.__reset());

  it("binds the pane chat's session to the pane tab its turn names", async () => {
    const panes = makePanePool();
    register(makeSideLoop(), makeMainLoop(), false, makeSideChatStore(), panes);
    const send = handlers.get(CHANNELS.sidechat.send)!;
    await expect(send(ev("file:///index.html"), {
      input: "fill the form", surface: { kind: "browser", tabId: "browser:pane" },
    })).resolves.toMatchObject({ ok: true });
    const paneSession = panes.get(7, "browser:pane")!.getSessionId();
    expect(browserTabRegistry.conversationSurface(7, paneSession)).toEqual({ kind: "browser", tabId: "browser:pane" });
  });

  it.each([
    [{ kind: "window", tabId: "x" }],
    [{ kind: "browser", tabId: "" }],
    ["browser:pane"],
  ])("refuses a malformed surface %j and runs no turn", async (surface) => {
    const side = makeSideLoop();
    const panes = makePanePool();
    register(side, makeMainLoop(), false, makeSideChatStore(), panes);
    await expect(handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), { input: "x", surface }))
      .resolves.toEqual({ ok: false, error: "invalid-surface" });
    expect(side.runTurn).not.toHaveBeenCalled();
    expect(panes.resolve).not.toHaveBeenCalled();
  });

  it("refuses a surface from a sender that is no main window", async () => {
    const side = makeSideLoop();
    const panes = makePanePool();
    register(side, makeMainLoop(), false, makeSideChatStore(), panes);
    await expect(handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html", 9), {
      input: "x", surface: { kind: "terminal", tabId: "terminal:1" },
    })).resolves.toEqual({ ok: false, error: "invalid-surface" });
    expect(side.runTurn).not.toHaveBeenCalled();
    expect(panes.resolve).not.toHaveBeenCalled();
  });
});

// Model one held session per loop and unique ids so pane isolation tests cannot share accidental state.
let mintedSessions = 0;
const mintSession = () => `00000000-0000-4000-8000-${String(++mintedSessions).padStart(12, "0")}`;
function makeSessionLoop(files: Record<string, unknown[]>, start = mintSession()) {
  const loop = makeSideLoop();
  let current = start;
  loop.getSessionId.mockImplementation(() => current);
  loop.newConversation.mockImplementation(async () => {
    current = mintSession();
  });
  loop.loadSession.mockImplementation(async (id: string) => {
    if (!(id in files)) return false;
    current = id;
    return true;
  });
  loop.getHistory.mockImplementation(() => ({ getMessages: vi.fn((): unknown[] => files[current] ?? []) }));
  const sessionOfTurn: string[] = [];
  loop.runTurn.mockImplementation(async () => {
    sessionOfTurn.push(current);
    return { route: "chat" };
  });
  return Object.assign(loop, { sessionOfTurn });
}

function makePaneStore(files: Record<string, unknown[]>, paneOf: Record<string, string> = {}) {
  const metadata = new Map<string, Record<string, unknown>>(
    Object.entries(paneOf).map(([sessionId, tabId]) => [sessionId, { paneTabId: tabId }]),
  );
  return {
    metadata,
    loadSessionMetadata: vi.fn((id: string) => metadata.get(id) ?? null),
    saveSessionMetadata: vi.fn(async (id: string, next: Record<string, unknown>) => { metadata.set(id, next); }),
    findPaneSession: vi.fn((tabId: string) => [...metadata.entries()]
      .find(([id, row]) => row.paneTabId === tabId && row.archivedAt === undefined && id in files)?.[0]),
    loadSession: vi.fn((id: string) => files[id] ?? null),
    hasSessionTranscript: vi.fn((id: string) => id in files),
    updateSessionRowFields: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      metadata.set(id, { ...(metadata.get(id) ?? {}), ...fields });
    }),
  };
}

const PANE_A = { kind: "browser", tabId: "browser:0000000a-1" } as const;
const PANE_B = { kind: "terminal", tabId: "terminal:0000000a-2" } as const;
const RAIL_SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_RAIL_SESSION = "22222222-2222-4222-8222-222222222222";
const STORED_PANE_SESSION = "33333333-3333-4333-8333-333333333333";

describe("pane chats are their own conversations", () => {
  beforeEach(() => browserTabRegistry.__reset());

  function setup(files: Record<string, unknown[]> = {}, paneOf: Record<string, string> = {}) {
    const rail = makeSessionLoop(files, RAIL_SESSION);
    const store = makePaneStore(files, paneOf);
    const panes = makePanePool(() => makeSessionLoop(files));
    register(rail, makeMainLoop(), false, store, panes);
    const pane = (tab: { tabId: string }) => panes.get(7, tab.tabId) as ReturnType<typeof makeSessionLoop> | undefined;
    return { rail, store, panes, pane, files };
  }
  const sendFrom = (payload: Record<string, unknown>, sender = rendererContents()) =>
    handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html", 1, sender), payload);
  const endPane = (tab: { tabId: string }, reason: string) =>
    handlers.get(CHANNELS.sidechat.endPaneChat)!(ev("file:///index.html"), { tabId: tab.tabId, reason });

  it("binds command controls to the exact side session and its renderer owner", async () => {
    const { rail, pane } = setup();
    await sendFrom({ input: "rail" });
    await sendFrom({ input: "pane", surface: PANE_A });
    const paneSessionId = pane(PANE_A)!.getSessionId();
    const list = vi.spyOn(shellTasks, "listShellTasks").mockReturnValue([]);
    const control = vi.spyOn(shellTasks, "controlShellTask").mockReturnValue({ ok: true, shellId: "owned-shell" });
    try {
      expect(handlers.get(CHANNELS.sidechat.listShellTasks)!(ev("file:///index.html"), RAIL_SESSION)).toEqual([]);
      expect(list).toHaveBeenCalledWith(RAIL_SESSION);
      expect(handlers.get(CHANNELS.sidechat.controlShellTask)!(ev("file:///index.html"), paneSessionId, "background")).toEqual({ ok: true, shellId: "owned-shell" });
      expect(control).toHaveBeenCalledWith(paneSessionId, "background", undefined);
      expect(handlers.get(CHANNELS.sidechat.controlShellTask)!(ev("file:///index.html", 2), paneSessionId, "background")).toEqual({ ok: false, error: "session-changed" });
      expect(handlers.get(CHANNELS.sidechat.controlShellTask)!(ev("file:///index.html", 2), RAIL_SESSION, "background")).toEqual({ ok: false, error: "session-changed" });
      rail.getSessionId.mockReturnValue(OTHER_RAIL_SESSION);
      expect(handlers.get(CHANNELS.sidechat.controlShellTask)!(ev("file:///index.html"), RAIL_SESSION, "background")).toEqual({ ok: false, error: "session-changed" });
      expect(control).toHaveBeenCalledTimes(1);
    } finally { list.mockRestore(); control.mockRestore(); }
  });

  it("runs a pane's turn on that pane's own loop, binds it to the pane and records the pane on its row", async () => {
    const { rail, store, pane } = setup();
    await expect(sendFrom({ input: "read it", surface: PANE_A })).resolves.toMatchObject({ ok: true });
    const loop = pane(PANE_A)!;
    expect(loop.sessionOfTurn).toEqual([loop.getSessionId()]);
    expect(rail.runTurn).not.toHaveBeenCalled();
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(loop.getSessionId());
    await vi.waitFor(() => expect(store.metadata.get(loop.getSessionId())).toMatchObject({ paneTabId: PANE_A.tabId }));
  });

  it("leaves the rail's window as the rail's: a pane turn does not claim it", async () => {
    setup();
    vi.mocked(setSideChatOwnerContents).mockClear();
    await sendFrom({ input: "page", surface: PANE_A });
    expect(setSideChatOwnerContents).not.toHaveBeenCalled();
    await sendFrom({ input: "rail" });
    expect(setSideChatOwnerContents).toHaveBeenCalledOnce();
  });

  it("streams two panes and the rail at the same time, each on its own loop", async () => {
    const { rail, pane } = setup();
    await sendFrom({ input: "warm up", surface: PANE_A });
    const holdA = deferred<{ route: string }>();
    pane(PANE_A)!.runTurn.mockImplementationOnce(async () => holdA.promise);
    const turnA = sendFrom({ input: "slow page", surface: PANE_A });
    await vi.waitFor(() => expect(pane(PANE_A)!.runTurn).toHaveBeenCalledTimes(2));
    await expect(sendFrom({ input: "terminal", surface: PANE_B })).resolves.toMatchObject({ ok: true });
    await expect(sendFrom({ input: "rail" })).resolves.toMatchObject({ ok: true });
    await expect(sendFrom({ input: "again", surface: PANE_A })).resolves.toEqual({ ok: false, error: "streaming-active" });
    holdA.resolve({ route: "chat" });
    await expect(turnA).resolves.toMatchObject({ ok: true });
    expect(pane(PANE_B)!.runTurn).toHaveBeenCalledTimes(1);
    expect(rail.runTurn).toHaveBeenCalledTimes(1);
    expect(pane(PANE_A)!.getSessionId()).not.toBe(pane(PANE_B)!.getSessionId());
  });

  it.each(["new", "closed"])("runs a rail turn in the rail's own session after the pane chat ended (%s)", async (reason) => {
    const { rail, pane, files } = setup({ [RAIL_SESSION]: [] });
    await sendFrom({ input: "page", surface: PANE_A });
    const paneLoop = pane(PANE_A)!;
    const paneSession = paneLoop.getSessionId();
    files[paneSession] = [];
    await expect(endPane(PANE_A, reason)).resolves.toMatchObject({ ok: true, sessionId: paneSession });
    const freshRailView = "44444444-4444-4444-8444-444444444444";
    await expect(sendFrom({ input: "from the rail", sessionId: freshRailView })).resolves.toMatchObject({ ok: true });
    expect(rail.sessionOfTurn).toHaveLength(1);
    expect(rail.sessionOfTurn[0]).not.toBe(paneSession);
    expect(paneLoop.sessionOfTurn).toEqual([paneSession]);
  });

  it("refuses a delayed send to a closed pane and releases its unused loop", async () => {
    const { pane } = setup();
    await sendFrom({ input: "page", surface: PANE_A });
    await endPane(PANE_A, "closed");
    await expect(sendFrom({ input: "late", surface: PANE_A })).resolves.toEqual({ ok: false, error: "pane-chat-ended" });
    expect(pane(PANE_A)).toBeUndefined();
  });

  it("runs a rail turn in the session its view shows, not the one the rail loop last held", async () => {
    const { rail } = setup({ [RAIL_SESSION]: [], [OTHER_RAIL_SESSION]: [] });
    await sendFrom({ input: "this view", sessionId: OTHER_RAIL_SESSION });
    await sendFrom({ input: "that view", sessionId: RAIL_SESSION });
    expect(rail.sessionOfTurn).toEqual([OTHER_RAIL_SESSION, RAIL_SESSION]);
  });

  it("refuses to send or load in the rail a conversation a pane chat holds", async () => {
    const { rail, pane } = setup();
    await sendFrom({ input: "page", surface: PANE_A });
    const paneSession = pane(PANE_A)!.getSessionId();
    await expect(sendFrom({ input: "rail", sessionId: paneSession })).resolves.toEqual({ ok: false, error: "session-open-in-pane" });
    await expect(handlers.get(CHANNELS.sidechat.load)!(ev("file:///index.html"), paneSession))
      .resolves.toEqual({ ok: false, error: "session-open-in-pane", messages: [] });
    expect(rail.runTurn).not.toHaveBeenCalled();
    expect(rail.loadSession).not.toHaveBeenCalled();
  });

  it("reopens a restored pane on its stored conversation, read before and continued on its first turn", async () => {
    const stored = [{ role: "user", content: "what is on this page?" }];
    const { pane } = setup({ [STORED_PANE_SESSION]: stored }, { [STORED_PANE_SESSION]: PANE_A.tabId });
    expect(handlers.get(CHANNELS.sidechat.paneHistory)!(ev("file:///index.html"), { tabId: PANE_A.tabId }))
      .toMatchObject({ ok: true, sessionId: STORED_PANE_SESSION, messages: [{ role: "user", content: "what is on this page?" }] });
    await sendFrom({ input: "and now?", surface: PANE_A });
    expect(pane(PANE_A)!.sessionOfTurn).toEqual([STORED_PANE_SESSION]);
  });

  it("reopens from the unified binding when the session row has no pane hint", async () => {
    const stored = [{ role: "user", content: "continue this pane" }];
    const { pane } = setup({ [STORED_PANE_SESSION]: stored });
    browserTabRegistry.bindConversationSurface(STORED_PANE_SESSION, { windowId: 7, surface: PANE_A });
    expect(handlers.get(CHANNELS.sidechat.paneHistory)!(ev("file:///index.html"), { tabId: PANE_A.tabId }))
      .toMatchObject({ ok: true, sessionId: STORED_PANE_SESSION, messages: stored });
    await sendFrom({ input: "continue", surface: PANE_A });
    expect(pane(PANE_A)!.sessionOfTurn).toEqual([STORED_PANE_SESSION]);
  });

  it("resumes a stored pane through the row hint in a non-primary window", async () => {
    const stored = [{ role: "user", content: "continue this pane" }];
    const { store, pane } = setup({ [STORED_PANE_SESSION]: stored }, { [STORED_PANE_SESSION]: PANE_A.tabId });
    const load = vi.fn((windowId: number) => windowId === 1 ? {
      version: 1 as const, tree: { kind: "leaf" as const, chatGroupId: "main" }, focusedId: "main",
      surfaces: {}, sideTabs: {}, panelOpenIds: ["main"], thumbnailOpenIds: [],
    } : undefined);
    const save = vi.fn(async () => {});
    browserTabRegistry.setBindingPersistence({
      savedWindowId: () => 1, load, save,
      sessionExists: store.hasSessionTranscript,
    });
    expect(handlers.get(CHANNELS.sidechat.paneHistory)!(ev("file:///index.html"), { tabId: PANE_A.tabId }))
      .toMatchObject({ ok: true, sessionId: STORED_PANE_SESSION, messages: stored });
    await expect(sendFrom({ input: "continue", surface: PANE_A })).resolves.toMatchObject({ ok: true });
    expect(load).toHaveBeenCalledWith(7);
    expect(load).toHaveBeenCalledWith(1);
    expect(store.findPaneSession).toHaveBeenCalledWith(PANE_A.tabId);
    expect(pane(PANE_A)!.loadSession).toHaveBeenCalledWith(STORED_PANE_SESSION, expect.anything());
    expect(pane(PANE_A)!.sessionOfTurn).toEqual([STORED_PANE_SESSION]);
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(STORED_PANE_SESSION);
    expect(save).not.toHaveBeenCalled();
  });

  it("reads a pane's live history from its loop once it holds the pane's conversation", async () => {
    const files: Record<string, unknown[]> = {};
    const { store, pane } = setup(files);
    await sendFrom({ input: "page", surface: PANE_A });
    files[pane(PANE_A)!.getSessionId()] = [{ role: "user", content: "page" }];
    const read = handlers.get(CHANNELS.sidechat.paneHistory)!(ev("file:///index.html"), { tabId: PANE_A.tabId });
    expect(read).toMatchObject({ ok: true, sessionId: pane(PANE_A)!.getSessionId(), messages: [{ content: "page" }] });
    expect(store.loadSession).not.toHaveBeenCalled();
  });

  it("has no conversation for a pane that never chatted, nor for another window's pane", async () => {
    setup();
    await sendFrom({ input: "page", surface: PANE_A });
    const read = handlers.get(CHANNELS.sidechat.paneHistory)!;
    expect(read(ev("file:///index.html"), { tabId: PANE_B.tabId })).toEqual({ ok: true, sessionId: null, messages: [] });
    expect(read(ev("file:///index.html", 9), { tabId: PANE_A.tabId })).toEqual({ ok: false, error: "invalid-surface" });
    expect(read(ev("file:///index.html"), { tabId: "" })).toEqual({ ok: false, error: "invalid-surface" });
  });

  it("refuses a pane request for a tab another window holds, or a tab id that is not one", async () => {
    const { store } = setup({ [STORED_PANE_SESSION]: [] }, { [STORED_PANE_SESSION]: PANE_B.tabId });
    const read = handlers.get(CHANNELS.sidechat.paneHistory)!;
    const end = handlers.get(CHANNELS.sidechat.endPaneChat)!;
    terminalOwners.set(PANE_B.tabId, 8);
    try {
      expect(read(ev("file:///index.html"), { tabId: PANE_B.tabId })).toEqual({ ok: false, error: "invalid-surface" });
      await expect(end(ev("file:///index.html"), { tabId: PANE_B.tabId, reason: "closed" })).resolves.toEqual({ ok: false, error: "invalid-surface" });
      expect(store.loadSession).not.toHaveBeenCalled();
    } finally {
      terminalOwners.delete(PANE_B.tabId);
    }
    browserTabRegistry.bindConversationSurface("55555555-5555-4555-8555-555555555555", { windowId: 8, surface: PANE_A });
    expect(read(ev("file:///index.html"), { tabId: PANE_A.tabId })).toEqual({ ok: false, error: "invalid-surface" });
    for (const tabId of ["terminal:1", "browser:pane", "../x"]) {
      expect(read(ev("file:///index.html"), { tabId })).toEqual({ ok: false, error: "invalid-surface" });
    }
    expect(read(ev("file:///index.html"), { tabId: PANE_B.tabId })).toMatchObject({ ok: true, sessionId: STORED_PANE_SESSION });
  });

  it("refuses a malformed session id and runs no turn", async () => {
    const { rail } = setup();
    await expect(sendFrom({ input: "x", sessionId: "../escape" })).resolves.toEqual({ ok: false, error: "invalid-session-id" });
    expect(rail.runTurn).not.toHaveBeenCalled();
  });

  describe("ending a pane chat", () => {
    it("starts the pane afresh on its own loop, and the last conversation is no longer the pane's", async () => {
      const files: Record<string, unknown[]> = {};
      const { store, pane } = setup(files);
      await sendFrom({ input: "page", surface: PANE_A });
      const loop = pane(PANE_A)!;
      const first = loop.getSessionId();
      files[first] = [];
      await vi.waitFor(() => expect(store.metadata.get(first)).toMatchObject({ paneTabId: PANE_A.tabId }));
      await expect(endPane(PANE_A, "new")).resolves.toEqual({ ok: true, sessionId: first });
      expect(store.metadata.get(first)?.paneTabId).toBeUndefined();
      expect(store.updateSessionRowFields).not.toHaveBeenCalled();
      await sendFrom({ input: "again", surface: PANE_A });
      expect(pane(PANE_A)).toBe(loop);
      expect(loop.sessionOfTurn).toEqual([first, loop.getSessionId()]);
      expect(loop.getSessionId()).not.toBe(first);
    });

    it("refuses a send that arrives while a pane is being started afresh, even after its last turn let go", async () => {
      const files: Record<string, unknown[]> = {};
      const { store, pane } = setup(files);
      await sendFrom({ input: "warm up", surface: PANE_A });
      const loop = pane(PANE_A)!;
      const first = loop.getSessionId();
      files[first] = [];
      const running = deferred<{ route: string }>();
      loop.runTurn.mockImplementationOnce(async () => running.promise);
      // Reset waits for durable row writes after the active turn has released the pane.
      const rowWrite = deferred<void>();
      store.saveSessionMetadata.mockImplementationOnce(async () => rowWrite.promise);
      const writesBefore = store.saveSessionMetadata.mock.calls.length;
      const turn = sendFrom({ input: "page", surface: PANE_A, originSessionId: RAIL_SESSION });
      await vi.waitFor(() => expect(loop.runTurn).toHaveBeenCalledTimes(2));
      const ending = endPane(PANE_A, "new");
      running.resolve({ route: "chat" });
      await vi.waitFor(() => expect(store.saveSessionMetadata.mock.calls.length).toBeGreaterThan(writesBefore));
      await expect(sendFrom({ input: "between", surface: PANE_A })).resolves.toEqual({ ok: false, error: "streaming-active" });
      rowWrite.resolve();
      await expect(ending).resolves.toMatchObject({ ok: true });
      await turn;
      expect(loop.runTurn).toHaveBeenCalledTimes(2);
      await expect(sendFrom({ input: "fresh", surface: PANE_A })).resolves.toMatchObject({ ok: true });
      expect(loop.sessionOfTurn.at(-1)).not.toBe(first);
    });

    it("archives a closed pane's conversation and drops its loop", async () => {
      const files: Record<string, unknown[]> = {};
      const { store, panes, pane } = setup(files);
      await sendFrom({ input: "page", surface: PANE_A });
      const session = pane(PANE_A)!.getSessionId();
      files[session] = [];
      await expect(endPane(PANE_A, "closed")).resolves.toEqual({ ok: true, sessionId: session });
      expect(store.updateSessionRowFields).toHaveBeenCalledWith(session, { archivedAt: expect.any(String) });
      expect(panes.get(7, PANE_A.tabId)).toBeUndefined();
      expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBeUndefined();
    });

    it("stops a closed pane's turn when the user closed it", async () => {
      const { pane } = setup();
      await sendFrom({ input: "warm up", surface: PANE_A });
      const loop = pane(PANE_A)!;
      const running = deferred<{ route: string }>();
      loop.runTurn.mockImplementationOnce(async () => running.promise);
      const turn = sendFrom({ input: "page", surface: PANE_A });
      await vi.waitFor(() => expect(loop.runTurn).toHaveBeenCalledTimes(2));
      const ending = endPane(PANE_A, "closed");
      await vi.waitFor(() => expect(loop.abortCurrentTurn).toHaveBeenCalled());
      running.resolve({ route: "chat" });
      await ending;
      await turn;
    });

    it("lets the turn that closed its own pane's page finish, then ends the pane chat", async () => {
      const files: Record<string, unknown[]> = {};
      const { store, panes, pane } = setup(files);
      await sendFrom({ input: "warm up", surface: PANE_A, sendRequestId: "warm" });
      const loop = pane(PANE_A)!;
      files[loop.getSessionId()] = [];
      const running = deferred<{ route: string }>();
      loop.runTurn.mockImplementationOnce(async () => running.promise);
      const turn = sendFrom({ input: "close this tab", surface: PANE_A, sendRequestId: "closer" });
      await vi.waitFor(() => expect(loop.runTurn).toHaveBeenCalledTimes(2));
      const closedByAgent = vi.spyOn(browserTabRegistry, "isClosedByAgent").mockReturnValue(true);
      try {
        await expect(handlers.get(CHANNELS.sidechat.abort)!(ev("file:///index.html"), { sendRequestId: "closer" })).resolves.toEqual({ ok: true });
        await expect(endPane(PANE_A, "closed")).resolves.toMatchObject({ ok: true });
        expect(loop.abortCurrentTurn).not.toHaveBeenCalled();
        expect(store.updateSessionRowFields).not.toHaveBeenCalled();
        running.resolve({ route: "chat" });
        await expect(turn).resolves.toMatchObject({ ok: true });
        await vi.waitFor(() => expect(store.updateSessionRowFields).toHaveBeenCalledWith(loop.getSessionId(), { archivedAt: expect.any(String) }));
        expect(panes.get(7, PANE_A.tabId)).toBeUndefined();
      } finally {
        closedByAgent.mockRestore();
      }
    });

    it("sends nothing and binds nothing when the pane closed while its conversation was loading", async () => {
      const { pane } = setup({ [STORED_PANE_SESSION]: [] }, { [STORED_PANE_SESSION]: PANE_A.tabId });
      const loading = deferred<void>();
      const send = sendFrom({ input: "page", surface: PANE_A });
      const loop = pane(PANE_A)!;
      loop.loadSession.mockImplementationOnce(async () => { await loading.promise; return true; });
      await expect(endPane(PANE_A, "closed")).resolves.toMatchObject({ ok: true });
      loading.resolve();
      await expect(send).resolves.toEqual({ ok: false, error: "pane-chat-ended" });
      expect(loop.runTurn).not.toHaveBeenCalled();
      expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBeUndefined();
    });

    it("refuses a reason it does not know", async () => {
      setup();
      await expect(endPane(PANE_A, "later")).resolves.toEqual({ ok: false, error: "invalid-input" });
    });
  });

  it("ends every pane chat of a window when that window navigates away", async () => {
    const { panes } = setup();
    const sender = rendererContents();
    await sendFrom({ input: "page", surface: PANE_A }, sender);
    await sendFrom({ input: "terminal", surface: PANE_B }, sender);
    sender.emit("did-navigate");
    expect(panes.all()).toEqual([]);
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBeUndefined();
    expect(browserTabRegistry.paneConversation(7, PANE_B.tabId)).toBeUndefined();
  });

  it("reads a pane chat's sub-agent transcript by the pane's own session", async () => {
    const { pane } = setup();
    await sendFrom({ input: "page", surface: PANE_A });
    const result = handlers.get(CHANNELS.sidechat.getSubAgentTranscript)!(ev("file:///index.html"), {
      originSessionId: pane(PANE_A)!.getSessionId(), childSessionId: "55555555-5555-4555-8555-555555555555",
    });
    expect(result).toEqual({ ok: false, error: "sub-agent-runner-unavailable" });
  });
});
