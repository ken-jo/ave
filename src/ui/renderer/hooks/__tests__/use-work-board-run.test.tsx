// @vitest-environment jsdom
/** The run hook keeps every child turn of the live run, phase by phase, so the compact card can say which turn the agent is on
 * and the step panel (LS-2) can draw the whole timeline. A board that mounts mid-run backfills from the persisted transcript and
 * merges the live events that raced it. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AveApi } from "../../types.js";
import type {
  RunProgressEventPayload,
  RunTranscriptEvent,
  WorkItemResolved,
} from "../../../../shared/work-board-types.js";
import {
  currentPhaseTurn,
  formatElapsed,
  latestTurn,
  runStartedAt,
  useNowTick,
  useWorkBoardRun,
} from "../use-work-board-run.js";

type Handler<T> = (payload: T) => void;

function harness(transcript: () => Promise<{ events: RunTranscriptEvent[] }> = async () => ({ events: [] })) {
  const progress: Handler<RunProgressEventPayload>[] = [];
  const started: Handler<{ itemId: number }>[] = [];
  const getTranscript = vi.fn(async (_itemId: number, _runId: string) => transcript());
  const api = {
    onWorkBoardRunProgress: (h: Handler<RunProgressEventPayload>) => {
      progress.push(h);
      return () => {};
    },
    onWorkBoardRunStarted: (h: Handler<{ itemId: number }>) => {
      started.push(h);
      return () => {};
    },
    onWorkBoardRunFinished: () => () => {},
    onWorkBoardRunFailed: () => () => {},
    getWorkBoardRunTranscript: getTranscript,
    runWorkBoardItem: vi.fn(() => new Promise(() => {})),
  } as unknown as AveApi;
  const emit = (ev: Omit<RunProgressEventPayload, "at"> & { at?: string }) =>
    act(() => {
      for (const h of progress) h({ at: "2026-11-04T03:00:00.000Z", ...ev });
    });
  const start = (itemId: number) =>
    act(() => {
      for (const h of started) h({ itemId });
    });
  /** Deliver an event without act(): the updates it queues wait for whatever act() the test is inside. */
  const deliver = (ev: RunProgressEventPayload) => {
    for (const h of progress) h(ev);
  };
  return { api, emit, start, getTranscript, deliver };
}

function runningItem(overrides: Partial<WorkItemResolved> = {}): WorkItemResolved {
  return {
    id: 4,
    title: "Add login regression test",
    status: "in_progress",
    status_resolved: "in_progress",
    priority: "high",
    created_at: "2026-11-04T02:00:00.000Z",
    updated_at: "2026-11-04T02:00:00.000Z",
    runStatus: "executing",
    runId: "run-b",
    runHistory: [
      { runId: "run-a", startedAt: "2026-11-03T01:00:00.000Z", status: "completed" },
      { runId: "run-b", startedAt: "2026-11-04T03:00:00.000Z", status: "planning" },
    ],
    ...overrides,
  };
}

describe("useWorkBoardRun — turn accumulation", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps every turn across phase transitions and drops a repeated phase+turn", () => {
    const { api, emit } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));

    emit({ itemId: 4, phase: "planning" });
    emit({ itemId: 4, phase: "planning", turn: 1, text: "Reading the login flow" });
    emit({ itemId: 4, phase: "planning", turn: 1, text: "Reading the login flow" });
    emit({ itemId: 4, phase: "planning", turn: 2, text: "Drafting the plan" });
    emit({ itemId: 4, phase: "awaiting_approval" });
    emit({ itemId: 4, phase: "executing" });
    emit({ itemId: 4, phase: "executing", turn: 1, text: "Writing the failing test" });

    const run = result.current.runState[4];
    expect(run?.phase).toBe("executing");
    expect(run?.turns.map((x) => `${x.phase}:${x.turn}`)).toEqual(["planning:1", "planning:2", "executing:1"]);
    expect(currentPhaseTurn(run)).toBe(1);
    expect(latestTurn(run)?.text).toBe("Writing the failing test");
  });

  it("keeps the first text a turn arrived with when the same phase+turn arrives again with other text", () => {
    const { api, emit } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));

    emit({ itemId: 4, phase: "executing", turn: 1, text: "first copy", at: "2026-11-04T03:00:01.000Z" });
    emit({ itemId: 4, phase: "executing", turn: 1, text: "second copy", at: "2026-11-04T03:00:09.000Z" });

    const turns = result.current.runState[4]?.turns;
    expect(turns).toHaveLength(1);
    expect(turns?.[0]).toMatchObject({ text: "first copy", at: "2026-11-04T03:00:01.000Z" });
  });

  it("reports no current turn when the phase has not produced one yet", () => {
    const { api, emit } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));

    emit({ itemId: 4, phase: "planning", turn: 3, text: "plan turn" });
    emit({ itemId: 4, phase: "executing" });

    const run = result.current.runState[4];
    expect(currentPhaseTurn(run)).toBeUndefined();
    // The narration still shows the last thing the agent said.
    expect(latestTurn(run)?.text).toBe("plan turn");
  });

  it("starts a new run with an empty turn log", () => {
    const { api, emit, start } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));

    emit({ itemId: 4, phase: "executing", turn: 2, text: "old run" });
    start(4);

    expect(result.current.runState[4]?.turns).toEqual([]);
    expect(result.current.runState[4]?.busy).toBe(true);
  });

  it("keeps the child session id once an event carried it", () => {
    const { api, emit } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));

    emit({ itemId: 4, phase: "executing", runSessionId: "child-1" });
    emit({ itemId: 4, phase: "executing", turn: 1, text: "working" });

    expect(result.current.runState[4]?.runSessionId).toBe("child-1");
  });
});

describe("useWorkBoardRun — transcript backfill", () => {
  it("backfills an in-flight item from its transcript and merges live turns in phase-then-turn order", async () => {
    let resolveTranscript!: (v: { events: RunTranscriptEvent[] }) => void;
    const { api, emit, getTranscript } = harness(
      () => new Promise((resolve) => { resolveTranscript = resolve; }),
    );
    const item = runningItem();
    const { result } = renderHook(() => useWorkBoardRun(api, [item]));

    await waitFor(() => expect(getTranscript).toHaveBeenCalledWith(4, "run-b"));
    // A live turn lands before the transcript read resolves.
    emit({ itemId: 4, phase: "executing", turn: 3, text: "live turn 3" });

    await act(async () => {
      resolveTranscript({
        events: [
          { ts: "2026-11-04T03:00:05.000Z", phase: "planning", kind: "turn", turn: 1, text: "plan 1" },
          { ts: "2026-11-04T03:00:20.000Z", phase: "awaiting_approval", kind: "plan", text: "the plan" },
          { ts: "2026-11-04T03:01:00.000Z", phase: "executing", kind: "turn", turn: 1, text: "exec 1" },
          { ts: "2026-11-04T03:02:00.000Z", phase: "executing", kind: "turn", turn: 2, text: "exec 2" },
          { ts: "2026-11-04T03:03:00.000Z", phase: "executing", kind: "turn", turn: 3, text: "exec 3 (persisted)" },
        ],
      });
    });

    const run = result.current.runState[4];
    expect(run?.turns.map((x) => `${x.phase}:${x.turn}`)).toEqual([
      "planning:1",
      "executing:1",
      "executing:2",
      "executing:3",
    ]);
    expect(run?.turns[0]?.at).toBe("2026-11-04T03:00:05.000Z");
    // Live and persisted copies of executing turn 3 differ; the first one the board saw — the live event — is kept.
    expect(run?.turns[3]?.text).toBe("live turn 3");
    // The board learned the phase from the stored item, then from the live event.
    expect(run?.phase).toBe("executing");
    expect(currentPhaseTurn(run)).toBe(3);
    expect(run?.busy).toBe(true);
  });

  it("seeds the phase from the stored run status when no live event has arrived", async () => {
    const { api, getTranscript } = harness(async () => ({
      events: [{ ts: "2026-11-04T03:00:05.000Z", phase: "planning", kind: "turn", turn: 1, text: "plan 1" }],
    }));
    const item = runningItem({ runStatus: "awaiting_approval" });
    const { result } = renderHook(() => useWorkBoardRun(api, [item]));

    await waitFor(() => expect(result.current.runState[4]?.turns).toHaveLength(1));
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(result.current.runState[4]?.phase).toBe("awaiting_approval");
  });

  it("reads each run's transcript once and never for an idle or finished item", async () => {
    const { api, getTranscript } = harness();
    const idle = runningItem({ id: 5, runStatus: "completed" });
    const never = runningItem({ id: 6, runStatus: undefined, runId: undefined, runHistory: undefined });
    const live = runningItem();
    const { rerender } = renderHook(({ items }) => useWorkBoardRun(api, items), {
      initialProps: { items: [idle, never, live] },
    });
    await waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(1));
    rerender({ items: [idle, never, { ...live }] });
    await act(async () => {});
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(getTranscript).toHaveBeenCalledWith(4, "run-b");
  });

  it("drops a backfill that resolves after a newer run started", async () => {
    let resolveTranscript!: (v: { events: RunTranscriptEvent[] }) => void;
    const { api, start, getTranscript } = harness(
      () => new Promise((resolve) => { resolveTranscript = resolve; }),
    );
    const { result } = renderHook(() => useWorkBoardRun(api, [runningItem()]));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    start(4);
    await act(async () => {
      resolveTranscript({
        events: [{ ts: "2026-11-04T03:00:05.000Z", phase: "executing", kind: "turn", turn: 1, text: "stale" }],
      });
    });

    expect(result.current.runState[4]?.turns).toEqual([]);
  });
});

describe("run timing helpers", () => {
  it("formats elapsed time as m:ss, and h:mm:ss past an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(252_000)).toBe("4:12");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    // A clock that drifted behind the stored start never shows a negative time.
    expect(formatElapsed(-4_000)).toBe("0:00");
  });

  it("takes the start of the item's current run from its run history", () => {
    expect(runStartedAt(runningItem())).toBe("2026-11-04T03:00:00.000Z");
  });

  it("refuses a run history whose last entry is not the item's current run", () => {
    expect(runStartedAt(runningItem({ runId: "run-c" }))).toBeUndefined();
  });

  it("has no start for an item whose stored run is not in flight", () => {
    expect(runStartedAt(runningItem({ runStatus: "completed" }))).toBeUndefined();
    expect(runStartedAt(runningItem({ runStatus: undefined }))).toBeUndefined();
  });
});

describe("useNowTick — the chip's clock", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves no interval behind once the run is no longer live or the chip unmounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { result, rerender, unmount } = renderHook(({ active }) => useNowTick(active), {
      initialProps: { active: true },
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toBe(1_000);

    rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toBe(1_000);

    rerender({ active: true });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useWorkBoardRun — live steps (LS-2)", () => {
  function steerHarness() {
    const h = harness();
    const steer = vi.fn<(id: number, text: string, intent?: unknown) => Promise<unknown>>(async () => ({ ok: true, messageId: "m-1" }));
    const cancel = vi.fn<(id: number) => Promise<unknown>>(async () => ({ ok: true }));
    Object.assign(h.api as object, { steerWorkBoardRun: steer, cancelWorkBoardRun: cancel });
    return { ...h, steer, cancel };
  }

  it("never reads a steer acknowledgement or a tool step as the run's phase, nor as a phase entry", () => {
    const { api, emit } = harness();
    const entered = vi.fn();
    const { result } = renderHook(() => useWorkBoardRun(api, [], entered));
    emit({ itemId: 4, phase: "executing" });
    expect(entered).toHaveBeenCalledTimes(1);
    emit({ itemId: 4, phase: "executing", tools: [{ toolUseId: "t1", name: "Bash", kind: "shell", label: "npm test", status: "running", turn: 1 }] });
    emit({ itemId: 4, phase: "cancelled", message: "user-stopped" });
    // A steer dropped because the turn ended arrives after the run settled; it must not resurrect the card.
    emit({ itemId: 4, phase: "executing", steer: { messageId: "m-9", status: "dropped", reason: "turn-ended" } });
    const run = result.current.runState[4];
    expect(run?.phase).toBe("cancelled");
    expect(run?.busy).toBe(false);
    expect(entered).toHaveBeenCalledTimes(1);
  });

  it("keeps each phase's tool steps, updating a step in place by its id", () => {
    const { api, emit } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));
    emit({ itemId: 4, phase: "planning", tools: [{ toolUseId: "p1", name: "Read", kind: "read", label: "a.ts", status: "done", turn: 1 }] });
    emit({ itemId: 4, phase: "executing", tools: [{ toolUseId: "t1", name: "Bash", kind: "shell", label: "npm test", status: "running", turn: 2 }] });
    emit({
      itemId: 4,
      phase: "executing",
      tools: [
        { toolUseId: "t1", name: "Bash", kind: "shell", label: "npm test", status: "done", turn: 2, durationMs: 1800 },
        { toolUseId: "t2", name: "Edit", kind: "write", label: "refresh.ts", status: "running", turn: 2 },
      ],
    });
    const tools = result.current.runState[4]?.tools ?? [];
    expect(tools.map((s) => `${s.phase}:${s.toolUseId}:${s.status}`)).toEqual([
      "planning:p1:done",
      "executing:t1:done",
      "executing:t2:running",
    ]);
  });

  it("collects every phase child's session, and forgets them when the item's run restarts", () => {
    const { api, emit, start } = harness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));
    emit({ itemId: 4, phase: "planning", runSessionId: "sub-plan" });
    emit({ itemId: 4, phase: "executing", runSessionId: "sub-exec" });
    emit({ itemId: 4, phase: "executing", runSessionId: "sub-exec" });
    expect(result.current.runState[4]?.sessionIds).toEqual(["sub-plan", "sub-exec"]);
    start(4);
    expect(result.current.runState[4]?.sessionIds).toEqual([]);
  });

  it("records a sent steer with the renderer's own text, and marks it delivered with the turn that took it", async () => {
    const { api, emit, steer } = steerHarness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));
    emit({ itemId: 4, phase: "executing" });
    let res: unknown;
    await act(async () => { res = await result.current.steer(4, "also cover refresh", undefined); });
    expect(steer).toHaveBeenCalledWith(4, "also cover refresh", undefined);
    expect(res).toEqual({ ok: true, messageId: "m-1" });
    expect(result.current.runState[4]?.steers).toMatchObject([{ messageId: "m-1", text: "also cover refresh", status: "sent" }]);
    emit({ itemId: 4, phase: "executing", steer: { messageId: "m-1", status: "delivered", turn: 3 } });
    expect(result.current.runState[4]?.steers).toMatchObject([{ messageId: "m-1", status: "delivered", turn: 3 }]);
  });

  it("applies an acknowledgement that raced ahead of the steer's own reply", async () => {
    const { api, emit, steer } = steerHarness();
    let resolve!: (v: unknown) => void;
    steer.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useWorkBoardRun(api, []));
    emit({ itemId: 4, phase: "executing" });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.steer(4, "faster", undefined); });
    emit({ itemId: 4, phase: "executing", steer: { messageId: "m-1", status: "dropped", reason: "joined-limit" } });
    await act(async () => { resolve({ ok: true, messageId: "m-1" }); await pending; });
    expect(result.current.runState[4]?.steers).toMatchObject([{ messageId: "m-1", status: "dropped", reason: "joined-limit" }]);
  });

  it("applies an acknowledgement whose steer reply lands before React flushes the acknowledgement", async () => {
    // The loop drops a steer in a microtask and the IPC reply can follow before any render: the early-ack record must not wait for a flush.
    const h = steerHarness();
    let resolve!: (v: unknown) => void;
    h.steer.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useWorkBoardRun(h.api, []));
    h.emit({ itemId: 4, phase: "executing" });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.steer(4, "faster", undefined); });
    await act(async () => {
      h.deliver({ itemId: 4, phase: "executing", steer: { messageId: "m-1", status: "dropped", reason: "turn-ended" }, at: "2026-11-04T03:00:01.000Z" });
      resolve({ ok: true, messageId: "m-1" });
      await pending;
    });
    expect(result.current.runState[4]?.steers).toMatchObject([{ messageId: "m-1", status: "dropped", reason: "turn-ended" }]);
  });

  it("does not re-list for a child's link event, which carries the session and no turn", () => {
    const { api, emit } = harness();
    const entered = vi.fn();
    renderHook(() => useWorkBoardRun(api, [], entered));
    emit({ itemId: 4, phase: "planning" });
    emit({ itemId: 4, phase: "planning", runSessionId: "sub-plan" });
    emit({ itemId: 4, phase: "executing" });
    emit({ itemId: 4, phase: "executing", runSessionId: "sub-exec" });
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it("records nothing for a refused steer", async () => {
    const { api, emit, steer } = steerHarness();
    steer.mockResolvedValueOnce({ ok: false, reason: "recipient-unavailable" });
    const { result } = renderHook(() => useWorkBoardRun(api, []));
    emit({ itemId: 4, phase: "executing" });
    let res: unknown;
    await act(async () => { res = await result.current.steer(4, "x", undefined); });
    expect(res).toEqual({ ok: false, reason: "recipient-unavailable" });
    expect(result.current.runState[4]?.steers).toEqual([]);
  });

  it("holds 'stopping' from an accepted stop until the run settles; a refused stop leaves the run as it was", async () => {
    const { api, emit, cancel } = steerHarness();
    const { result } = renderHook(() => useWorkBoardRun(api, []));
    emit({ itemId: 4, phase: "executing" });
    cancel.mockResolvedValueOnce({ ok: false, reason: "not-running" });
    let refused: unknown;
    await act(async () => { refused = await result.current.stop(4); });
    expect(refused).toEqual({ ok: false, reason: "not-running" });
    expect(result.current.runState[4]?.stopping).toBe(false);

    await act(async () => { await result.current.stop(4); });
    expect(result.current.runState[4]?.stopping).toBe(true);
    expect(result.current.runState[4]?.phase).toBe("executing");
    emit({ itemId: 4, phase: "cancelled", message: "user-stopped" });
    expect(result.current.runState[4]?.stopping).toBe(false);
    expect(result.current.runState[4]?.phase).toBe("cancelled");
  });

  it("backfills the plan, the finished tool steps and when each phase began from the transcript", async () => {
    const events: RunTranscriptEvent[] = [
      { ts: "2026-11-04T03:00:05.000Z", phase: "planning", kind: "turn", turn: 1, text: "Reading" },
      { ts: "2026-11-04T03:00:06.000Z", phase: "planning", kind: "tool", turn: 1, tool: { toolUseId: "p1", name: "Read", kind: "read", label: "a.ts", status: "done", turn: 1 } },
      { ts: "2026-11-04T03:01:00.000Z", phase: "awaiting_approval", kind: "plan", text: "1. write test\n2. fix" },
      { ts: "2026-11-04T03:02:00.000Z", phase: "executing", kind: "turn", turn: 1, text: "Writing" },
    ];
    const { api } = harness(async () => ({ events }));
    const { result } = renderHook(() => useWorkBoardRun(api, [runningItem()]));
    await waitFor(() => expect(result.current.runState[4]?.plan).toEqual({ text: "1. write test\n2. fix", at: "2026-11-04T03:01:00.000Z" }));
    expect(result.current.runState[4]?.tools.map((s) => `${s.phase}:${s.toolUseId}`)).toEqual(["planning:p1"]);
  });
});
