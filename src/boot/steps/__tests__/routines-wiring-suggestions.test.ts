/** Create and promote the Suggestions conversation before sending scheduled routine cards. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireRoutinesScheduler } from "../routines-wiring.js";
import { ROUTINES } from "../../../shared/ipc-channels.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";
import type { BootContext } from "../../context.js";
import { setRoutineChatWaker, type RoutineChatWakeResult } from "../../../main/app-state.js";
import { sessionAuthorityWithheld } from "../../../shared/turn-extension-policy.js";

type Handler = (event: { routine: Record<string, unknown> }) => void;

function wire(
  runRoutine: (input: Record<string, unknown>) => Promise<{ summary: string; sessionId?: string; skipped?: "chat-busy" }>,
  chats: Record<string, { projectRoot?: string }> = {},
) {
  const handlers: { llm?: Handler; notification?: Handler } = {};
  const routinesStore = {
    update: vi.fn(async () => ({})), recordRunOutcome: vi.fn(async () => ({})),
    markOrphaned: vi.fn(async () => 1), markChatBusy: vi.fn(async () => ({})),
  };
  const send = vi.fn();
  const touchSessionTranscript = vi.fn();
  const window = { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } };
  const routinesScheduler = {
    onLlmSession: (handler: Handler) => { handlers.llm = handler; return () => {}; },
    onNotification: (handler: Handler) => { handlers.notification = handler; return () => {}; },
    markRunning: vi.fn(),
    markStopped: vi.fn(),
  };
  const ctx = {
    routinesScheduler,
    routineEngine: { runRoutine: vi.fn(runRoutine) },
    routinesStore,
    getMainWindow: () => window,
    host: { desktop: { getAppWindows: () => [window] } },
    notificationService: { fire: vi.fn() },
    memoryManager: { touchSessionTranscript, loadSessionMetadata: (id: string) => chats[id] ?? null },
  } as unknown as BootContext;
  wireRoutinesScheduler(ctx);
  return { handlers, send, touchSessionTranscript, routinesStore, routinesScheduler };
}

const routine = { id: "routine-a", trigger: { kind: "manual" }, execution: "llm-session", title: "Morning", lastFiredAt: "2026-11-04T01:00:00.000Z" };

function expectTouchedBefore(send: ReturnType<typeof vi.fn>, touch: ReturnType<typeof vi.fn>, channel: string) {
  const at = send.mock.calls.findIndex(([sent]) => sent === channel);
  expect(at).toBeGreaterThanOrEqual(0);
  const sentOrder = send.mock.invocationCallOrder[at]!;
  expect(touch.mock.invocationCallOrder.some((order) => order < sentOrder)).toBe(true);
}

describe("routine cards and the Suggestions conversation", () => {
  it("makes the conversation exist before the running and result cards go out", async () => {
    const { handlers, send, touchSessionTranscript } = wire(async () => ({ summary: "done", sessionId: "s-1" }));
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(touchSessionTranscript).toHaveBeenCalledWith(SUGGESTIONS_SESSION_ID, { bump: true });
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.runningStarted);
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.fired);
  });

  it("does the same for a failed run's card", async () => {
    const { handlers, send, touchSessionTranscript } = wire(async () => { throw new Error("boom"); });
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.failed, expect.anything()));
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.failed);
  });

  it("and for a notification-only routine's card", () => {
    const { handlers, send, touchSessionTranscript } = wire(async () => ({ summary: "" }));
    handlers.notification!({ routine: { ...routine, execution: "notification-only" } });
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.fired);
  });
});

describe("routine run outcome persistence", () => {
  it("records a thrown run as a failure of that fire", async () => {
    const { handlers, send, routinesStore } = wire(async () => { throw new Error("boom"); });
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith(
      "routine-a",
      "2026-11-04T01:00:00.000Z",
      { ok: false, kind: "error", reason: "boom" },
    );
  });

  it("records a successful run so an earlier failure clears", async () => {
    const { handlers, send, routinesStore } = wire(async () => ({ summary: "done", sessionId: "s-1" }));
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith("routine-a", "2026-11-04T01:00:00.000Z", { ok: true });
  });

  it("still sends the result card when persisting the outcome fails", async () => {
    const { handlers, send, routinesStore } = wire(async () => { throw new Error("boom"); });
    routinesStore.recordRunOutcome.mockRejectedValueOnce(new Error("disk full"));
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
  });
});

describe("runs in progress", () => {
  it.each([
    ["succeeds", async () => ({ summary: "done", sessionId: "s-1" })],
    ["rejects", async () => { throw new Error("boom"); }],
  ] as const)("marks the run stopped before the finished event when the run %s", async (_label, run) => {
    const { handlers, send, routinesScheduler } = wire(run);
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(routinesScheduler.markRunning).toHaveBeenCalledWith("routine-a", "2026-11-04T01:00:00.000Z");
    expect(routinesScheduler.markStopped).toHaveBeenCalledExactlyOnceWith("routine-a");
    const finishedAt = send.mock.calls.findIndex(([channel]) => channel === ROUTINES.runningFinished);
    expect(routinesScheduler.markStopped.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[finishedAt]!);
  });
});

describe("a schedule connected to a chat", () => {
  const TARGET = "22222222-2222-4222-8222-222222222222";
  const connected = { ...routine, trigger: "schedule", prePrompt: "check the build", targetSessionId: TARGET };
  afterEach(() => setRoutineChatWaker(null));

  it("runs in the open chat as a marked turn that withholds the chat's session allows", async () => {
    const wakes: Array<{ sessionId: string; input: string; displayText: string; withheld: boolean }> = [];
    setRoutineChatWaker(async (sessionId, turn) => {
      await Promise.resolve();
      wakes.push({ sessionId, ...turn, withheld: sessionAuthorityWithheld() });
      return { status: "ran" };
    });
    const { handlers, send, routinesStore, routinesScheduler } = wire(async () => { throw new Error("no headless run for an open chat"); }, { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.objectContaining({ routineSessionId: TARGET })));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ sessionId: TARGET, input: "check the build", withheld: true });
    expect(wakes[0]!.displayText).toContain("Morning");
    expect(wakes[0]!.displayText).toContain("check the build");
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith("routine-a", routine.lastFiredAt, { ok: true });
    expect(routinesScheduler.markStopped).toHaveBeenCalledWith("routine-a");
    // Outside the wake the flag is gone again: the next ordinary turn reads its allows.
    expect(sessionAuthorityWithheld()).toBe(false);
  });

  it("runs an unopened chat headless, loading that chat, with the same withheld authority", async () => {
    setRoutineChatWaker(async () => ({ status: "not-open" }));
    let withheld: boolean | undefined;
    const { handlers, send, routinesStore } = wire(async (input) => {
      withheld = sessionAuthorityWithheld();
      expect(input).toMatchObject({ id: "routine-a", prePrompt: "check the build", targetSessionId: TARGET });
      return { summary: "built", sessionId: TARGET };
    }, { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.objectContaining({ routineSessionId: TARGET, summary: "built" })));
    expect(withheld).toBe(true);
    expect(routinesStore.update).toHaveBeenCalledWith("routine-a", { lastRoutineSessionId: TARGET });
  });

  it.each([
    ["its open chat is busy", { status: "busy" } as RoutineChatWakeResult, undefined],
    ["another conversation holds the unopened chat", { status: "not-open" } as RoutineChatWakeResult, "chat-busy" as const],
  ])("skips with a recorded reason when %s", async (_label, live, headless) => {
    setRoutineChatWaker(async () => live);
    const run = vi.fn(async () => ({ summary: "", skipped: headless }));
    const { handlers, send, routinesStore, routinesScheduler } = wire(run, { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(routinesStore.markChatBusy).toHaveBeenCalledWith("routine-a", routine.lastFiredAt));
    await vi.waitFor(() => expect(routinesScheduler.markStopped).toHaveBeenCalledWith("routine-a"));
    expect(run).toHaveBeenCalledTimes(headless ? 1 : 0);
    expect(routinesStore.recordRunOutcome).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(ROUTINES.fired, expect.anything());
    expect(send).not.toHaveBeenCalledWith(ROUTINES.failed, expect.anything());
  });

  it("marks the item 대화 없음 and runs nothing when its chat no longer exists", async () => {
    const waker = vi.fn(async () => ({ status: "ran" }) as RoutineChatWakeResult);
    setRoutineChatWaker(waker);
    const run = vi.fn(async () => ({ summary: "" }));
    const { handlers, routinesStore, routinesScheduler } = wire(run);
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(routinesStore.markOrphaned).toHaveBeenCalledWith(TARGET));
    expect(waker).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(routinesScheduler.markRunning).not.toHaveBeenCalled();
  });
});
