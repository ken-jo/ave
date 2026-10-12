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

import { registerSideChatHandlers } from "../sidechat.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { deferred } from "../../../__tests__/test-helpers.js";

function ev(url?: string): IpcMainInvokeEvent {
  return (url ? { senderFrame: { url } } : {}) as unknown as IpcMainInvokeEvent;
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
    loadSession: vi.fn(() => true),
    getSessionId: vi.fn(() => "34fd6270-309d-4e47-878b-75c0742a6ac2"),
    getHistory: vi.fn(() => ({ getMessages: vi.fn(() => []) })),
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
    saveSessionMetadata: vi.fn(async () => {}),
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

  it("abort aborts the side loop only", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.abort)!;
    const result = await handler(ev("file:///index.html"));
    expect(result).toEqual({ ok: true });
    expect(side.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(main.abortCurrentTurn).not.toHaveBeenCalled();
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
    register(side, makeMainLoop());
    const pending = handlers.get(CHANNELS.sidechat.send)!(ev("file:///index.html"), { input: "Own request", sendRequestId: "own-request" });
    const cancellation = handlers.get(CHANNELS.sidechat.abort)!(ev("file:///index.html"), { sendRequestId: "own-request" });
    try {
      expect(side.abortCurrentTurn).toHaveBeenCalledOnce();
    } finally {
      turn.resolve({ route: "chat" });
      await Promise.all([pending, cancellation]);
    }
  });

  it.each([null, 17, [], {}, { sendRequestId: "" }, { sendRequestId: " " }, { sendRequestId: 17 }, { sendRequestId: "x".repeat(257) }])(
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
