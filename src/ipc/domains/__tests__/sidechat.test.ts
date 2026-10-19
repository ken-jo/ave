/**
 * Side-chat IPC domain — engine isolation + trust boundary.
 *
 * Asserts the load-bearing guarantees of the companion PR:
 *   1. send drives the SIDE-CHAT loop (never the main loop) and publishes its
 *      stream frames to the DEDICATED `ave:sidechat:stream` channel — never
 *      `ave:chat:stream` (main/side stream isolation).
 *   2. abort aborts the SIDE-CHAT loop only.
 *   3. every mutating channel rejects an unauthorized frame.
 *   4. when the side-chat loop is absent, handlers fail closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_FENCE_OPEN,
} from "../../../shared/mcp-resource-bounds.js";

/** A real 1×1 PNG: the image normalizer decodes and sniffs the bytes. */
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

// Capture every (channel, payload) the domain publishes so we can assert the
// stream fan-out lands on the dedicated side-chat channel.
const sent: Array<{ channel: string; payload: unknown }> = [];
vi.mock("../../safe-send.js", () => ({
  sendToWebContents: vi.fn((_wc: unknown, channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  }),
}));

// The window a sender belongs to: renderer contents with id 1 are window 7's.
vi.mock("../../../main/app-state.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../main/app-state.js")>(),
  mainWindowForContents: vi.fn((contents: { id?: number }) => (contents?.id === 1 ? { id: 7 } : null)),
}));

import { registerSideChatHandlers } from "../sidechat.js";
import { browserTabRegistry } from "../../../main/browser/browser-tab-registry.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { deferred } from "../../../__tests__/test-helpers.js";

function rendererContents(senderId = 1): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id: senderId });
}

function ev(url?: string, senderId = 1, sender = rendererContents(senderId)): IpcMainInvokeEvent {
  return (url ? { senderFrame: { url }, sender } : { sender }) as unknown as IpcMainInvokeEvent;
}

function makeSideLoop() {
  let transitioning = false;
  const loop = {
    // runTurn emits one text delta + a done frame through the injected callbacks
    // so the stream sink is exercised, then resolves the TurnResult.
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
    loadSessionMetadata: vi.fn(() => existing ?? null),
    saveSessionMetadata: vi.fn(async (_sessionId: string, _metadata: Record<string, unknown>) => {}),
  };
}

function register(
  sideLoop: unknown,
  mainLoop: unknown,
  piiRedactEnabled = false,
  sideChatMemoryManager: unknown = makeSideChatStore(),
) {
  const deps = {
    conversationLoop: mainLoop,
    sideChatConversationLoop: sideLoop,
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
    // The SIDE loop ran the turn; the MAIN loop was never touched.
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    expect(main.runTurn).not.toHaveBeenCalled();
    // Every published frame went to the dedicated side-chat stream channel.
    expect(sent.length).toBeGreaterThan(0);
    for (const frame of sent) {
      expect(frame.channel).toBe(CHANNELS.sidechat.stream);
      expect(frame.channel).not.toBe(CHANNELS.chat.stream);
    }
  });

  // Side chat is a second send site into the same provider, and redaction lives at
  // the send sites rather than inside the loop — so this path simply did not have
  // one. With `piiRedactEnabled` on, the raw text the user typed went out on the
  // wire. These two assert the DLP boundary from the PRODUCER side: what the loop
  // actually received, not what the sanitizer returns in isolation.
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
  // Side chat parses its own payload — it never passes through `parseChatSendPayload`
  // — so a per-turn bound enforced at either send gate would simply not exist here.
  // It holds because the bound lives at the turn-entry chokepoint both paths share.
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
      // A peer renderer's departure, in-document or subframe navigation, and a
      // main-frame navigation the window's will-navigate policy then cancels
      // (an external link click) leave the owning document alive.
      peer.emit(eventName, ...args);
      owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      owner.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      owner.emit("did-navigate-in-page", {});
      owner.emit("did-frame-navigate", {});
      // A failed subframe keeps the document too, and so does every main-frame
      // `did-fail-load` without a committed error page (probed on Electron 44):
      // a stopped load, a `loadURL` refused as invalid, and a committed
      // document whose own load fails after commit.
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

    // A later turn belongs to its own sender; the earlier owner leaving does not reach it.
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
    // A side loop whose turn stays in-flight until we release it, so we can
    // observe the ordering: abort → turn settles → newConversation.
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
      // A real abort makes the in-flight runTurn settle.
      releaseTurn?.();
    });
    side.newConversation = vi.fn(() => order.push("newConversation"));
    register(side, makeMainLoop());

    // Start a turn (do NOT await — it is deliberately in-flight).
    const sendHandler = handlers.get(CHANNELS.sidechat.send)!;
    const sendPromise = sendHandler(ev("file:///index.html"), { input: "long turn" });

    // While it streams, request a new session.
    const newHandler = handlers.get(CHANNELS.sidechat.new)!;
    const newRequest = newHandler(ev("file:///index.html"));
    expect(side.isSessionTransitioning()).toBe(true);
    const result = await newRequest;

    expect(result).toEqual({ ok: true, sessionId: "34fd6270-309d-4e47-878b-75c0742a6ac2" });
    // The in-flight turn was aborted + awaited BEFORE the loop was mutated —
    // no new-session-receives-prior-turn-frames leak.
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

  // The shared composer offers an attachment-only send on this surface, and the
  // main chat accepts one. Refusing it here produced an empty user bubble
  // followed by an error entry — the renderer had already committed the turn.
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

  // Two turns on one ConversationLoop interleave into a single history. The
  // handler runs `runStreamedTurn` directly, so nothing else refuses the second
  // send: a queue drain fired by a superseded turn's trailing `done` would have
  // landed here on top of the live turn.
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

    // …and the loop is free again once the turn settles. Swap in a turn that
    // completes on its own so this send is not held by the same latch.
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
  const sessionId = "34fd6270-309d-4e47-878b-75c0742a6ac2";
  beforeEach(() => browserTabRegistry.__reset());

  it("binds the side chat's session to the pane tab its turn names", async () => {
    register(makeSideLoop(), makeMainLoop());
    const send = handlers.get(CHANNELS.sidechat.send)!;
    await expect(send(ev("file:///index.html"), {
      input: "fill the form", surface: { kind: "browser", tabId: "browser:pane" },
    })).resolves.toMatchObject({ ok: true });
    expect(browserTabRegistry.conversationSurface(7, sessionId)).toEqual({ kind: "browser", tabId: "browser:pane" });
  });

  it.each([
    [{ kind: "window", tabId: "x" }],
    [{ kind: "browser", tabId: "" }],
    ["browser:pane"],
  ])("refuses a malformed surface %j and runs no turn", async (surface) => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    await expect(handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), { input: "x", surface }))
      .resolves.toEqual({ ok: false, error: "invalid-surface" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("refuses a surface from a sender that is no main window", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    await expect(handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html", 9), {
      input: "x", surface: { kind: "terminal", tabId: "terminal:1" },
    })).resolves.toEqual({ ok: false, error: "invalid-surface" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });
});

// A side loop that really holds one session at a time: `new` mints one, `load`
// moves onto a stored one (false for a session with no file), and its history
// is the held session's.
const RAIL_SESSION = "11111111-1111-4111-8111-111111111111";
function makeSessionLoop(files: Record<string, unknown[]>, start = RAIL_SESSION) {
  const loop = makeSideLoop();
  let current = start;
  let minted = 0;
  loop.getSessionId.mockImplementation(() => current);
  loop.newConversation.mockImplementation(async () => {
    minted += 1;
    current = `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
  });
  loop.loadSession.mockImplementation(async (id: string) => {
    if (!(id in files)) return false;
    current = id;
    return true;
  });
  loop.getHistory.mockImplementation(() => ({ getMessages: vi.fn(() => files[current] ?? []) }));
  const sessionOfTurn: string[] = [];
  loop.runTurn.mockImplementation(async () => {
    sessionOfTurn.push(current);
    return { route: "chat" };
  });
  return Object.assign(loop, { sessionOfTurn });
}

function makePaneStore(files: Record<string, unknown[]>) {
  return {
    ...makeSideChatStore(),
    loadSession: vi.fn((id: string) => files[id] ?? null),
    hasSessionTranscript: vi.fn((id: string) => id in files),
    updateSessionRowFields: vi.fn(async (_id: string, _fields: Record<string, unknown>) => {}),
  };
}

const PANE_A = { kind: "browser", tabId: "browser:w-1" } as const;
const PANE_B = { kind: "terminal", tabId: "terminal:w-2" } as const;
const FIRST_FRESH = "00000000-0000-4000-8000-000000000001";
const SECOND_FRESH = "00000000-0000-4000-8000-000000000002";

describe("pane chats are their own conversations", () => {
  beforeEach(() => browserTabRegistry.__reset());

  function sendFrom(payload: Record<string, unknown>) {
    return handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), payload);
  }

  it("starts a pane's first turn in a fresh session bound to that pane", async () => {
    const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
    register(loop, makeMainLoop());
    await expect(sendFrom({ input: "read it", surface: PANE_A })).resolves.toMatchObject({ ok: true });
    expect(loop.sessionOfTurn).toEqual([FIRST_FRESH]);
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(FIRST_FRESH);
    expect(browserTabRegistry.isPaneConversation(RAIL_SESSION)).toBe(false);
  });

  it("keeps two panes' conversations apart and moves the loop onto each pane's own", async () => {
    const files: Record<string, unknown[]> = { [RAIL_SESSION]: [] };
    const loop = makeSessionLoop(files);
    register(loop, makeMainLoop());
    await sendFrom({ input: "page", surface: PANE_A });
    files[FIRST_FRESH] = [];
    await sendFrom({ input: "terminal", surface: PANE_B });
    files[SECOND_FRESH] = [];
    await sendFrom({ input: "page again", surface: PANE_A });
    expect(loop.sessionOfTurn).toEqual([FIRST_FRESH, SECOND_FRESH, FIRST_FRESH]);
    expect(loop.loadSession).toHaveBeenLastCalledWith(FIRST_FRESH, expect.anything());
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(FIRST_FRESH);
    expect(browserTabRegistry.paneConversation(7, PANE_B.tabId)).toBe(SECOND_FRESH);
    expect(browserTabRegistry.conversationSurface(7, SECOND_FRESH)).toEqual(PANE_B);
  });

  it("never runs a rail turn in a pane's conversation, and leaves the pane's binding alone", async () => {
    const files: Record<string, unknown[]> = { [RAIL_SESSION]: [] };
    const loop = makeSessionLoop(files);
    register(loop, makeMainLoop());
    await sendFrom({ input: "page", surface: PANE_A });
    files[FIRST_FRESH] = [];
    // The rail view names the side chat it shows: the loop goes back to it.
    await sendFrom({ input: "rail", sessionId: RAIL_SESSION });
    await sendFrom({ input: "page", surface: PANE_A });
    // A rail view holding no session, while the loop holds a pane's: a fresh one.
    await sendFrom({ input: "fresh rail" });
    // A rail view that names a pane's conversation does not get into it either.
    await sendFrom({ input: "page", surface: PANE_A });
    await sendFrom({ input: "rail into pane", sessionId: FIRST_FRESH });
    expect(loop.sessionOfTurn).toEqual([FIRST_FRESH, RAIL_SESSION, FIRST_FRESH, SECOND_FRESH, FIRST_FRESH, "00000000-0000-4000-8000-000000000003"]);
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(FIRST_FRESH);
    expect(browserTabRegistry.isPaneConversation(SECOND_FRESH)).toBe(false);
  });

  it("leaves the loop where it is for a rail turn when the loop holds no pane's conversation", async () => {
    const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
    register(loop, makeMainLoop());
    await sendFrom({ input: "rail", sessionId: "22222222-2222-4222-8222-222222222222" });
    expect(loop.runSessionTransition).not.toHaveBeenCalled();
    expect(loop.sessionOfTurn).toEqual([RAIL_SESSION]);
  });

  it("starts a pane afresh when its conversation never reached a file, and rebinds the pane", async () => {
    const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
    register(loop, makeMainLoop());
    await sendFrom({ input: "page", surface: PANE_A });
    await sendFrom({ input: "rail", sessionId: RAIL_SESSION });
    await sendFrom({ input: "page", surface: PANE_A });
    expect(loop.sessionOfTurn).toEqual([FIRST_FRESH, RAIL_SESSION, SECOND_FRESH]);
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(SECOND_FRESH);
    expect(browserTabRegistry.isPaneConversation(FIRST_FRESH)).toBe(false);
  });

  it("refuses a second send while the first is still moving the loop onto its session", async () => {
    const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
    const switching = deferred<void>();
    loop.newConversation.mockImplementationOnce(async () => {
      await switching.promise;
      loop.getSessionId.mockImplementation(() => FIRST_FRESH);
    });
    register(loop, makeMainLoop());
    const first = sendFrom({ input: "page", surface: PANE_A });
    const second = sendFrom({ input: "terminal", surface: PANE_B });
    await expect(second).resolves.toEqual({ ok: false, error: "streaming-active" });
    switching.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(loop.runTurn).toHaveBeenCalledTimes(1);
    expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBe(FIRST_FRESH);
    expect(browserTabRegistry.paneConversation(7, PANE_B.tabId)).toBeUndefined();
  });

  it("refuses a malformed session id and runs no turn", async () => {
    const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
    register(loop, makeMainLoop());
    await expect(sendFrom({ input: "x", sessionId: "../escape" })).resolves.toEqual({ ok: false, error: "invalid-session-id" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  describe("reading a pane's history", () => {
    const stored = [{ role: "user", content: "what is on this page?" }];

    it("returns the pane's conversation from the store without moving the loop", async () => {
      const files: Record<string, unknown[]> = { [RAIL_SESSION]: [] };
      const loop = makeSessionLoop(files);
      register(loop, makeMainLoop(), false, makePaneStore({ [FIRST_FRESH]: stored }));
      await sendFrom({ input: "page", surface: PANE_A });
      files[FIRST_FRESH] = stored;
      await sendFrom({ input: "rail", sessionId: RAIL_SESSION });
      loop.runSessionTransition.mockClear();
      const result = await handlers.get(CHANNELS.sidechat.paneHistory)!(ev("file:///index.html"), { tabId: PANE_A.tabId });
      expect(result).toMatchObject({ ok: true, sessionId: FIRST_FRESH, messages: [{ role: "user", content: "what is on this page?" }] });
      expect(loop.getSessionId()).toBe(RAIL_SESSION);
      expect(loop.runSessionTransition).not.toHaveBeenCalled();
    });

    it("reads the loop's own history while it holds the pane's conversation", async () => {
      const files: Record<string, unknown[]> = { [RAIL_SESSION]: [] };
      const loop = makeSessionLoop(files);
      const store = makePaneStore({});
      register(loop, makeMainLoop(), false, store);
      await sendFrom({ input: "page", surface: PANE_A });
      files[FIRST_FRESH] = stored;
      const result = await handlers.get(CHANNELS.sidechat.paneHistory)!(ev("file:///index.html"), { tabId: PANE_A.tabId });
      expect(result).toMatchObject({ ok: true, sessionId: FIRST_FRESH, messages: [{ content: "what is on this page?" }] });
      expect(store.loadSession).not.toHaveBeenCalled();
    });

    it("has no conversation for a pane that never chatted, nor for another window's pane", async () => {
      register(makeSessionLoop({ [RAIL_SESSION]: [] }), makeMainLoop());
      await sendFrom({ input: "page", surface: PANE_A });
      const read = handlers.get(CHANNELS.sidechat.paneHistory)!;
      expect(read(ev("file:///index.html"), { tabId: PANE_B.tabId })).toEqual({ ok: true, sessionId: null, messages: [] });
      expect(read(ev("file:///index.html", 9), { tabId: PANE_A.tabId })).toEqual({ ok: false, error: "invalid-surface" });
      expect(read(ev("file:///index.html"), { tabId: "" })).toEqual({ ok: false, error: "invalid-surface" });
    });
  });

  describe("ending a pane chat", () => {
    it("releases the pane's conversation for a new one without archiving it", async () => {
      const files: Record<string, unknown[]> = { [RAIL_SESSION]: [] };
      const loop = makeSessionLoop(files);
      const store = makePaneStore({ [FIRST_FRESH]: [] });
      register(loop, makeMainLoop(), false, store);
      await sendFrom({ input: "page", surface: PANE_A });
      files[FIRST_FRESH] = [];
      await expect(handlers.get(CHANNELS.sidechat.endPaneChat)!(ev("file:///index.html"), { tabId: PANE_A.tabId, reason: "new" }))
        .resolves.toEqual({ ok: true, sessionId: FIRST_FRESH });
      expect(store.updateSessionRowFields).not.toHaveBeenCalled();
      await sendFrom({ input: "page", surface: PANE_A });
      expect(loop.sessionOfTurn).toEqual([FIRST_FRESH, SECOND_FRESH]);
    });

    it("archives a closed pane's conversation", async () => {
      const store = makePaneStore({ [FIRST_FRESH]: [] });
      register(makeSessionLoop({ [RAIL_SESSION]: [] }), makeMainLoop(), false, store);
      await sendFrom({ input: "page", surface: PANE_A });
      await expect(handlers.get(CHANNELS.sidechat.endPaneChat)!(ev("file:///index.html"), { tabId: PANE_A.tabId, reason: "closed" }))
        .resolves.toEqual({ ok: true, sessionId: FIRST_FRESH });
      expect(store.updateSessionRowFields).toHaveBeenCalledWith(FIRST_FRESH, { archivedAt: expect.any(String) });
      expect(browserTabRegistry.paneConversation(7, PANE_A.tabId)).toBeUndefined();
    });

    it("stops the running turn only when it is that pane's", async () => {
      const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
      const running = deferred<{ route: string }>();
      register(loop, makeMainLoop(), false, makePaneStore({}));
      await sendFrom({ input: "terminal", surface: PANE_B });
      loop.runTurn.mockImplementationOnce(async () => running.promise);
      const turn = sendFrom({ input: "page", surface: PANE_A });
      await vi.waitFor(() => expect(loop.runTurn).toHaveBeenCalledTimes(2));
      const end = handlers.get(CHANNELS.sidechat.endPaneChat)!;
      await end(ev("file:///index.html"), { tabId: PANE_B.tabId, reason: "closed" });
      expect(loop.abortCurrentTurn).not.toHaveBeenCalled();
      const ending = end(ev("file:///index.html"), { tabId: PANE_A.tabId, reason: "closed" });
      await vi.waitFor(() => expect(loop.abortCurrentTurn).toHaveBeenCalledTimes(1));
      running.resolve({ route: "chat" });
      await ending;
      await turn;
    });

    it("refuses a reason it does not know", async () => {
      register(makeSessionLoop({ [RAIL_SESSION]: [] }), makeMainLoop(), false, makePaneStore({}));
      await expect(handlers.get(CHANNELS.sidechat.endPaneChat)!(ev("file:///index.html"), { tabId: PANE_A.tabId, reason: "later" }))
        .resolves.toEqual({ ok: false, error: "invalid-input" });
    });
  });

  it("refuses a new or loaded side chat elsewhere while a pane's turn runs", async () => {
    const loop = makeSessionLoop({ [RAIL_SESSION]: [] });
    const running = deferred<{ route: string }>();
    loop.runTurn.mockImplementationOnce(async () => running.promise);
    register(loop, makeMainLoop());
    const turn = sendFrom({ input: "page", surface: PANE_A });
    await vi.waitFor(() => expect(loop.runTurn).toHaveBeenCalledTimes(1));
    await expect(handlers.get(CHANNELS.sidechat.new)!(ev("file:///index.html"))).resolves.toEqual({ ok: false, error: "streaming-active" });
    await expect(handlers.get(CHANNELS.sidechat.load)!(ev("file:///index.html"), RAIL_SESSION))
      .resolves.toEqual({ ok: false, error: "streaming-active", messages: [] });
    expect(loop.abortCurrentTurn).not.toHaveBeenCalled();
    running.resolve({ route: "chat" });
    await turn;
  });
});
