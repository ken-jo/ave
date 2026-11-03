/** Create and promote the Suggestions conversation before sending scheduled routine cards. */
import { describe, expect, it, vi } from "vitest";
import { wireRoutinesScheduler } from "../routines-wiring.js";
import { ROUTINES } from "../../../shared/ipc-channels.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";
import type { BootContext } from "../../context.js";

type Handler = (event: { routine: Record<string, unknown> }) => void;

function wire(runRoutine: () => Promise<{ summary: string; sessionId?: string }>) {
  const handlers: { llm?: Handler; notification?: Handler } = {};
  const routinesStore = { update: vi.fn(async () => ({})), recordRunOutcome: vi.fn(async () => ({})) };
  const send = vi.fn();
  const touchSessionTranscript = vi.fn();
  const window = { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } };
  const ctx = {
    routinesScheduler: {
      onLlmSession: (handler: Handler) => { handlers.llm = handler; return () => {}; },
      onNotification: (handler: Handler) => { handlers.notification = handler; return () => {}; },
    },
    routineEngine: { runRoutine: vi.fn(runRoutine) },
    routinesStore,
    getMainWindow: () => window,
    host: { desktop: { getAppWindows: () => [window] } },
    notificationService: { fire: vi.fn() },
    memoryManager: { touchSessionTranscript },
  } as unknown as BootContext;
  wireRoutinesScheduler(ctx);
  return { handlers, send, touchSessionTranscript, routinesStore };
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
