import { describe, expect, it, vi } from "vitest";
import { createConversationActivityCoordinator } from "../../../engine/conversation-activity-coordinator.js";
import type { IpcDeps } from "../../types.js";
import { handleChatSend, type ChatSendContext } from "../chat.js";

const completedTurn = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
} as const;

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(markMainActiveResume: () => Promise<void>) {
  const runTurn = vi.fn(async () => completedTurn);
  const sink = vi.fn();
  const activity = createConversationActivityCoordinator();
  let streamId = 0;
  const deps = {
    conversationLoop: {
      getSessionId: () => "session-completion",
      getSessionKind: () => "main",
      getHistory: () => [{ role: "user", content: "first" }],
      getSessionProjectIsDefault: () => true,
      runTurn,
    },
    settingsService: { get: () => undefined },
    auditLogger: { log: vi.fn() },
    memoryManager: { sessions: { markMainActiveResume } },
  } as unknown as IpcDeps;
  const context: ChatSendContext = {
    createStreamEventSink: () => sink,
    allocateStreamId: () => ++streamId,
    trackStreamTurn: activity.trackTurn,
  };
  return { activity, context, deps, runTurn, sink };
}

function completedEvents(sink: ReturnType<typeof vi.fn>) {
  return sink.mock.calls.filter(([event]) => (event as { kind?: unknown }).kind === "turn.completed");
}

describe("chat turn completion ordering", () => {
  it("publishes completion after post-turn work so queue-auto can acquire the released turn", async () => {
    const postTurn = deferred<void>();
    const markMainActiveResume = vi.fn(() => postTurn.promise);
    const f = fixture(markMainActiveResume);
    const first = handleChatSend(f.deps, {
      input: "first",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, f.context);

    await vi.waitFor(() => expect(markMainActiveResume).toHaveBeenCalledOnce());
    expect(completedEvents(f.sink)).toHaveLength(0);
    await expect(handleChatSend(f.deps, {
      input: "queued too early",
      inputOrigin: "queue-auto",
    }, f.context)).rejects.toThrow("streaming-active");

    postTurn.resolve();
    await expect(first).resolves.toEqual(completedTurn);
    expect(completedEvents(f.sink)).toHaveLength(1);
    await expect(handleChatSend(f.deps, {
      input: "queued after done",
      inputOrigin: "queue-auto",
    }, f.context)).resolves.toEqual(completedTurn);
    expect(f.runTurn).toHaveBeenCalledTimes(2);
    expect(completedEvents(f.sink)).toHaveLength(2);
  });

  it("publishes completion and releases the lease when post-turn work fails", async () => {
    const error = new Error("post-turn storage failed");
    const f = fixture(vi.fn(async () => { throw error; }));

    await expect(handleChatSend(f.deps, {
      input: "first",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, f.context)).rejects.toBe(error);

    expect(completedEvents(f.sink)).toHaveLength(1);
    expect(f.activity.isBusy()).toBe(false);
  });
});
