/**
 * Routine cards are addressed to the dedicated Suggestions conversation.
 *
 * A routine fires on a schedule, with no conversation behind it. Its running,
 * failed and result cards used to be drawn over whichever conversation was
 * focused; the renderer now addresses them to the Suggestions conversation, so
 * main makes that conversation exist — and rise in the list — before each one
 * is sent.
 */
import { describe, expect, it, vi } from "vitest";
import { wireRoutinesScheduler } from "../routines-wiring.js";
import { ROUTINES } from "../../../shared/ipc-channels.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";
import type { BootContext } from "../../context.js";

type Handler = (event: { routine: Record<string, unknown> }) => void;

function wire(runRoutine: () => Promise<{ summary: string; sessionId?: string }>) {
  const handlers: { llm?: Handler; notification?: Handler } = {};
  const send = vi.fn();
  const touchSessionTranscript = vi.fn();
  const ctx = {
    routinesScheduler: {
      onLlmSession: (handler: Handler) => { handlers.llm = handler; return () => {}; },
      onNotification: (handler: Handler) => { handlers.notification = handler; return () => {}; },
    },
    routineEngine: { runRoutine: vi.fn(runRoutine) },
    routinesStore: { update: vi.fn(async () => ({})) },
    getMainWindow: () => ({ webContents: { send } }),
    notificationService: { fire: vi.fn() },
    memoryManager: { touchSessionTranscript },
  } as unknown as BootContext;
  wireRoutinesScheduler(ctx);
  return { handlers, send, touchSessionTranscript };
}

const routine = { id: "routine-a", trigger: { kind: "manual" }, execution: "llm-session", title: "Morning" };

/** Each card send is preceded by a touch of the Suggestions conversation. */
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
