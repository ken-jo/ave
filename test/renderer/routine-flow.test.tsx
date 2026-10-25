// Routine results can dismiss or open their session; snooze is excluded by the overlay contract.
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { deferred, submitChatMessage } from "./helpers.js";
import { SUGGESTIONS_SESSION_ID } from "../../src/shared/suggestions-session.js";

function makeRoutineResult() {
  return {
    id: "schedule-daily",
    trigger: "schedule",
    firedAt: new Date().toISOString(),
    title: "Daily schedule",
    summary: "daily summary",
  };
}


// Open Suggestions because routine cards must not appear in unrelated conversations.
describe("Routine flow (Phase 3.3 regression net)", () => {
  it("onRoutineFired renders the OverlayCard", async () => {
    const { container, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    await act(async () => {
      emitRoutineFired(makeRoutineResult());
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("replays the latest result on mount when one was already generated", async () => {
    const routineResult = makeRoutineResult();
    const { container } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID, latestRoutineResult: routineResult });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("rehydrates an unacknowledged routine result on mount after restart", async () => {
    const routineResult = {
      ...makeRoutineResult(),
      routineSessionId: "routine-session-1",
    };
    const { container, api } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID, pendingRoutineResults: [routineResult] });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
      expect(container.textContent).toContain("결과 보기");
    });
    const primary = container.querySelector('[data-testid="overlay-card-primary-action"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(primary);
    });
    await waitFor(() => {
      expect(api.acknowledgeRoutineResult).toHaveBeenCalledWith(routineResult.id, routineResult.firedAt);
    });
  });

  it("does not let a delayed replay overwrite a newer live result", async () => {
    let resolveLatest: ((value: unknown) => void) | null = null;
    const stale = { ...makeRoutineResult(), firedAt: new Date(Date.now() - 10_000).toISOString(), summary: "stale summary" };
    const fresh = { ...makeRoutineResult(), summary: "fresh summary" };
    const { container, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID,
      latestRoutineResult: new Promise((resolve) => {
        resolveLatest = resolve;
      }),
    });

    await act(async () => {
      emitRoutineFired(fresh);
    });
    await act(async () => {
      resolveLatest?.(stale);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("fresh summary");
      expect(container.textContent).not.toContain("stale summary");
    });
  });

  it("clicking dismiss removes the card", async () => {
    const { container, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    await act(async () => {
      emitRoutineFired(makeRoutineResult());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="routine-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });

    const closeBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "닫기",
    ) as HTMLButtonElement | undefined;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeFalsy();
    });
  });

  // Snooze must stay absent; see the overlay contract for its rationale.
  it("renders the result-view action for routines with a session id", async () => {
    const { container, api, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    await act(async () => {
      emitRoutineFired({
        ...makeRoutineResult(),
        routineSessionId: "routine-session-1",
      });
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="routine-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });
    expect(card.querySelector('[data-testid="routine-card-snooze-trigger"]')).toBeFalsy();
    const primary = card.querySelector('[data-testid="overlay-card-primary-action"]');
    expect(primary).toBeTruthy();
    expect(primary?.textContent).toContain("결과 보기");

    await act(async () => {
      fireEvent.click(primary!);
    });

    await waitFor(() => {
      expect(api.chatSessionResume).toHaveBeenCalledWith("routine-session-1");
      expect(api.chatSessionHistory).toHaveBeenCalledWith("routine-session-1");
    });
    await waitFor(() => {
      expect(api.acknowledgeRoutineResult).toHaveBeenCalledWith("schedule-daily", expect.any(String));
      expect(container.querySelector('[data-testid="routine-card"]')).toBeFalsy();
    });
    expect(api.listRoutineSessions).not.toHaveBeenCalled();
  });

  it("does not acknowledge or dismiss a routine result when opening its session fails", async () => {
    const { container, api, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    api.chatSessionResume.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
    });
    await act(async () => {
      emitRoutineFired({
        ...makeRoutineResult(),
        routineSessionId: "missing-routine-session",
      });
    });
    const primary = await waitFor(() => {
      const el = container.querySelector('[data-testid="overlay-card-primary-action"]');
      if (!el) throw new Error("primary action not rendered");
      return el;
    });

    await act(async () => {
      fireEvent.click(primary);
      await Promise.resolve();
    });

    expect(api.chatSessionResume).toHaveBeenCalledWith("missing-routine-session");
    expect(api.chatSessionHistory).not.toHaveBeenCalledWith("missing-routine-session");
    expect(api.acknowledgeRoutineResult).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
  });

  it("opens a routine's session while the active chat is streaming, without taking its place", async () => {
    const { container, api, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "진행 중인 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitRoutineFired({
        ...makeRoutineResult(),
        routineSessionId: "routine-session-1",
      });
    });
    const primary = await waitFor(() => {
      const el = container.querySelector('[data-testid="overlay-card-primary-action"]');
      if (!el) throw new Error("primary action not rendered");
      return el;
    });

    await act(async () => {
      fireEvent.click(primary);
      await Promise.resolve();
    });

    // Opening a routine session creates its own group so it remains available during another turn.
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith("routine-session-1"));
    await waitFor(() => expect(api.acknowledgeRoutineResult).toHaveBeenCalled());

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("stacks results with distinct routineIds and shows the index indicator", async () => {
    const { container, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    await act(async () => {
      emitRoutineFired({ ...makeRoutineResult(), id: "wakeup", summary: "morning" });
    });
    await act(async () => {
      emitRoutineFired({ ...makeRoutineResult(), id: "schedule-1", trigger: "schedule", summary: "midday" });
    });

    await waitFor(() => {
      const indicator = container.querySelector('[data-testid="routine-card-indicator"]');
      expect(indicator?.textContent).toBe("2/2");
      expect(container.textContent).toContain("midday");
    });
  });

  it("in-place updates a card when the same routineId arrives again", async () => {
    const { container, emitRoutineFired } = await renderApp({ currentSession: SUGGESTIONS_SESSION_ID });
    await act(async () => {
      emitRoutineFired({ ...makeRoutineResult(), summary: "v1" });
    });
    await waitFor(() => expect(container.textContent).toContain("v1"));
    await act(async () => {
      emitRoutineFired({ ...makeRoutineResult(), summary: "v2" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("v2");
      expect(container.textContent).not.toContain("v1");
      expect(container.querySelector('[data-testid="routine-card-indicator"]')).toBeFalsy();
    });
  });

  it("keeps the card out of the user's own conversation and counts it on the Suggestions row", async () => {
    const { container, emitRoutineFired } = await renderApp({
      sessions: [{ id: SUGGESTIONS_SESSION_ID, modifiedAt: new Date().toISOString() }],
    });
    await act(async () => {
      emitRoutineFired(makeRoutineResult());
    });
    await waitFor(() => {
      const badge = container.querySelector(`[data-testid="sidebar-pending-count-${SUGGESTIONS_SESSION_ID}"]`);
      expect(badge?.textContent).toBe("1");
    });
    expect(container.querySelector('[data-testid="routine-card"]')).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
