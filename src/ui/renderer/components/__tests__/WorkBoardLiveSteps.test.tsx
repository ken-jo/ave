// @vitest-environment jsdom
/** LS-2: the live step panel beside the board is the run's conversation. It draws the run's tool approval with the window's approval
 * card (chat mode) or the board draws it in a card over itself (dialog mode); in both the board claims the run's child sessions, so a
 * listed child no tile can open is never left parked with nothing drawing it. The panel also carries the steer composer and stop. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import { pendingAnswers } from "../chat-group-session-registry.js";
import type { AveApi, ApprovalRequest } from "../../types.js";
import type { RunProgressEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";
import { TEST_IDS, testIdSelector } from "../../../../shared/test-ids.js";
import { t } from "../../../../i18n/runtime.js";
import { approvalRequest, approvalSurfaceStub, withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { setContainerWidths } from "../../../../../test/renderer/setup.js";

const CHILD = "sub-exec-4";

function runningItem(overrides: Partial<WorkItemResolved> = {}): WorkItemResolved {
  return {
    id: 4,
    title: "Add login regression test",
    detail: "Reproduce the redirect loop",
    status: "in_progress",
    status_resolved: "in_progress",
    priority: "high",
    created_at: "2026-11-04T02:00:00.000Z",
    updated_at: "2026-11-04T02:00:00.000Z",
    runStatus: "executing",
    runId: "run-b",
    runHistory: [{ runId: "run-b", startedAt: "2026-11-04T03:00:00.000Z", status: "planning" }],
    ...overrides,
  };
}

interface BoardOptions {
  surface?: "chat" | "dialog";
  items?: WorkItemResolved[];
}

function boardApi({ surface = "chat", items = [runningItem()] }: BoardOptions = {}) {
  const progress: Array<(p: RunProgressEventPayload) => void> = [];
  const started: Array<(p: { itemId: number }) => void> = [];
  const noop = () => () => {};
  const steer = vi.fn(async (_id: number, _text: string, _intent?: unknown): Promise<unknown> => ({ ok: true, messageId: "m-1" }));
  const cancel = vi.fn(async (_id: number): Promise<unknown> => ({ ok: true }));
  const update = vi.fn(async (_id: number, _patch: unknown): Promise<unknown> => ({ status: "updated" }));
  const intent = { inputOrigin: "user-keyboard" as const, token: "tok" };
  const api = {
    listWorkBoard: vi.fn(async () => ({ status: "ok" as const, items })),

    getWorkBoardRunTranscript: vi.fn(async () => ({ events: [] })),
    runWorkBoardItem: vi.fn(() => new Promise(() => {})),
    getSettings: vi.fn(async () => ({ workBoard: { toolApprovalSurface: surface } })),
    onSettingsUpdated: noop,
    onWorkBoardItemChanged: noop,

    onWorkBoardRunProgress: (h: (p: RunProgressEventPayload) => void) => {
      progress.push(h);
      return () => {};
    },
    onWorkBoardRunStarted: (h: (p: { itemId: number }) => void) => {
      started.push(h);
      return () => {};
    },
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
    steerWorkBoardRun: steer,
    cancelWorkBoardRun: cancel,
    updateWorkBoardItem: update,
    captureUserKeyboardIntent: () => intent,
  } as unknown as AveApi;
  // A phase entry re-lists the board; settle that read so the cards are back before the test looks.
  const emit = async (ev: Omit<RunProgressEventPayload, "at"> & { at?: string }) => {
    await act(async () => {
      for (const h of progress) h({ at: "2026-11-04T03:04:00.000Z", ...ev });
    });
  };
  const start = async (itemId: number) => {
    await act(async () => { for (const h of started) h({ itemId }); });
  };
  return { api, emit, start, steer, cancel, update, intent };
}

function childApproval(): ApprovalRequest {
  return approvalRequest({ id: "req-child", sessionId: CHILD, toolName: "run_shell", toolCategory: "shell", args: { command: "k6 run load.js" } }) as unknown as ApprovalRequest;
}

async function mountBoard(options: BoardOptions = {}, queue: ApprovalRequest[] = []) {
  const harness = boardApi(options);
  const surface = { ...approvalSurfaceStub(), queue };
  const view = render(withApprovalSurface(<WorkBoardPanel api={harness.api} />, surface));
  await screen.findByText("Add login regression test");
  return { ...harness, surface, view };
}

async function openSteps() {
  fireEvent.click(screen.getByTestId("work-board-show-steps"));
  return screen.findByTestId("live-step-panel");
}

describe("Work Board — a run's tool approval (owner decision B)", () => {
  afterEach(() => cleanup());

  it("claims a listed child session no tile can open, and draws its card in the run's step panel", async () => {
    const queue = [childApproval()];
    const { emit, surface } = await mountBoard({ surface: "chat" }, queue);
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });

    // The window's routing: the child is a listed work-board row, so its card parks; the board's claim is what draws it.
    const owner = surface.claims.ownerOf(CHILD);
    expect(owner).toMatch(/^work-board:/);
    const routed = pendingAnswers({
      approvals: queue,
      tiles: [],
      overlayCards: [],
      sessions: [{ id: CHILD, family: "work-board" }],
      isClaimed: (id) => surface.claims.ownerOf(id) !== null,
    });
    expect(routed.unattributed).toEqual([]);
    expect([...routed.sessionIds]).toEqual([CHILD]);

    // The card says it waits and links to the run.
    const chip = screen.getByTestId("work-board-live-chip");
    expect(chip.dataset.state).toBe("tool-approval");
    expect(chip.textContent).toContain(t("workBoard.liveChipToolApproval"));
    fireEvent.click(screen.getByTestId("work-board-approve-in-chat"));

    const panel = await screen.findByTestId("live-step-panel");
    const card = within(panel).getByTestId("approval-lane-card");
    expect(card.dataset.approvalRequestId).toBe("req-child");
    // The same signed decision path as every other surface: the window's decide, with this request's id.
    fireEvent.click(card.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.approveButton))!);
    expect(surface.decide).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surface.decide).mock.calls[0]?.[0]).toBe("req-child");
    expect(vi.mocked(surface.decide).mock.calls[0]?.[1]).toMatch(/allow/);
    // No second card over the board in chat mode.
    expect(document.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeNull();
  });

  it("claims the child the listed item names before any event reached this board", async () => {
    const queue = [childApproval()];
    const { surface } = await mountBoard({ items: [runningItem({ runSessionId: CHILD })] }, queue);
    await waitFor(() => expect(surface.claims.ownerOf(CHILD)).toMatch(/^work-board:/));
  });

  it("draws the card over the board in dialog mode, still claimed", async () => {
    const queue = [childApproval()];
    const { emit, surface } = await mountBoard({ surface: "dialog" }, queue);
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    const dock = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(testIdSelector(TEST_IDS.approvalDock));
      expect(el).not.toBeNull();
      return el!;
    });
    expect(dock.dataset.approvalRequestId).toBe("req-child");
    expect(surface.claims.ownerOf(CHILD)).toMatch(/^work-board:/);
    expect(screen.queryByTestId("work-board-approve-in-chat")).toBeNull();
    fireEvent.click(dock.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.approveButton))!);
    expect(vi.mocked(surface.decide).mock.calls[0]?.[0]).toBe("req-child");
  });

  it("never claims a run of an item this board does not list (another project's board)", async () => {
    const other = approvalRequest({ id: "req-other", sessionId: "sub-other", toolName: "run_shell" }) as unknown as ApprovalRequest;
    const { emit, surface } = await mountBoard({}, [other]);
    await emit({ itemId: 99, phase: "executing", runSessionId: "sub-other" });
    expect(surface.claims.ownerOf("sub-other")).toBeNull();
    expect(document.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeNull();
  });

  it("releases the claim when the board leaves", async () => {
    const { emit, surface, view } = await mountBoard({}, [childApproval()]);
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    expect(surface.claims.ownerOf(CHILD)).not.toBeNull();
    view.unmount();
    expect(surface.claims.ownerOf(CHILD)).toBeNull();
  });

  it("leaves a session another surface claimed first to that surface", async () => {
    const surface = { ...approvalSurfaceStub(), queue: [childApproval()] };
    surface.claims.claim("side-chat:other", (id) => id === CHILD);
    const harness = boardApi();
    render(withApprovalSurface(<WorkBoardPanel api={harness.api} />, surface));
    await screen.findByText("Add login regression test");
    await harness.emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    expect(screen.getByTestId("work-board-live-chip").dataset.state).not.toBe("tool-approval");
  });
});

describe("Work Board — live step panel", () => {
  afterEach(() => {
    cleanup();
    setContainerWidths({ canvasWidth: Infinity });
  });

  it("opens from the card's toggle on that run, with its turns and tool steps", async () => {
    const { emit } = await mountBoard();
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    await emit({ itemId: 4, phase: "executing", turn: 1, text: "Read the refresh flow" });
    await emit({ itemId: 4, phase: "executing", turn: 2, text: "Wrote the failing test" });
    await emit({
      itemId: 4,
      phase: "executing",
      tools: [
        { toolUseId: "t1", name: "Edit", kind: "write", label: "refresh.ts", status: "done", turn: 2, durationMs: 200 },
        { toolUseId: "t2", name: "Bash", kind: "shell", label: "npm test -- auth/refresh", status: "running", turn: 2 },
      ],
    });
    const toggle = screen.getByTestId("work-board-show-steps");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("live-step-panel");
    const panel = await openSteps();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(panel.id).toBe("live-step-panel");
    const turns = within(panel).getAllByTestId("live-step-turn");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.dataset.current).toBe("true");
    const tools = within(turns[1]!).getAllByTestId("live-step-tool");
    expect(tools.map((row) => [row.textContent?.includes("refresh.ts") || row.textContent?.includes("npm test"), row.dataset.status])).toEqual([
      [true, "done"],
      [true, "running"],
    ]);
    expect(within(panel).getByTestId("live-step-summary").textContent).toContain(t("workBoard.liveSummaryTurn", { turn: 2 }));
  });

  it("sends a steer from Enter with the gesture's intent, and shows it sent, then delivered", async () => {
    const { emit, steer, intent } = await mountBoard();
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    await emit({ itemId: 4, phase: "executing", turn: 2, text: "Wrote the failing test" });
    const panel = await openSteps();
    const input = within(panel).getByTestId("live-step-steer-input");
    fireEvent.change(input, { target: { value: "also cover the refresh path" } });
    expect(within(panel).getByTestId("live-step-steer-count").textContent).toBe(t("workBoard.liveSteerCounter", { count: 27, max: 4000 }));
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(steer).toHaveBeenCalledWith(4, "also cover the refresh path", intent);
    const bubble = await within(panel).findByTestId("live-step-steer");
    expect(bubble.dataset.status).toBe("sent");
    expect(bubble.textContent).toContain("also cover the refresh path");
    expect((input as HTMLTextAreaElement).value).toBe("");

    await emit({ itemId: 4, phase: "executing", steer: { messageId: "m-1", status: "delivered", turn: 3 } });
    await emit({ itemId: 4, phase: "executing", turn: 3, text: "Covering the refresh path" });
    const delivered = within(panel).getByTestId("live-step-steer");
    expect(delivered.dataset.status).toBe("delivered");
    expect(delivered.textContent).toContain(t("workBoard.liveSteerDelivered", { turn: 3 }));
    expect(within(panel).getByTestId("live-step-summary").textContent).toContain(t("workBoard.liveSummarySteers", { count: 1 }));
  });

  it("keeps a refused steer's text and offers to add it to the task description", async () => {
    const { emit, steer, update } = await mountBoard();
    steer.mockResolvedValueOnce({ ok: false, reason: "recipient-unavailable" });
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    const panel = await openSteps();
    const input = within(panel).getByTestId("live-step-steer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "one more thing" } });
    await act(async () => { fireEvent.click(within(panel).getByTestId("live-step-steer-send")); });
    expect(within(panel).getByTestId("live-step-steer-error").textContent).toBe(t("workBoard.liveSteerRefusedUnavailable"));
    expect(input.value).toBe("one more thing");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(within(panel).queryByTestId("live-step-steer")).toBeNull();

    await act(async () => { fireEvent.click(within(panel).getByTestId("live-step-append")); });
    expect(update).toHaveBeenCalledWith(4, { detail: "Reproduce the redirect loop\n\none more thing" });
    expect(within(panel).getByTestId("live-step-appended")).toBeTruthy();
  });

  it("disables the composer and stop before execution, saying why", async () => {
    const { emit } = await mountBoard({ items: [runningItem({ runStatus: "planning" })] });
    await emit({ itemId: 4, phase: "planning" });
    const panel = await openSteps();
    expect((within(panel).getByTestId("live-step-steer-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect((within(panel).getByTestId("live-step-stop") as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByTestId("live-step-composer-note").textContent).toBe(t("workBoard.liveStopPlanningNote"));
  });

  it("stops without asking: stopping until the run settles, then 중지됨, never the error style", async () => {
    const { emit, cancel } = await mountBoard();
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    await emit({ itemId: 4, phase: "executing", turn: 3, text: "Working" });
    const panel = await openSteps();
    await act(async () => { fireEvent.click(within(panel).getByTestId("live-step-stop")); });
    expect(cancel).toHaveBeenCalledWith(4);
    expect(screen.getByTestId("work-board-live-chip").dataset.state).toBe("stopping");
    expect(within(panel).getByTestId("live-step-stop-requested")).toBeTruthy();
    expect(within(panel).getByTestId("live-step-stop").getAttribute("aria-busy")).toBe("true");

    await emit({ itemId: 4, phase: "cancelled", message: "user-stopped" });
    expect(screen.getByTestId("work-board-run-cancelled")).toBeTruthy();
    expect(screen.queryByTestId("work-board-run-error")).toBeNull();
    // The followed run stays in the panel once settled while nothing else runs.
    expect(within(panel).getByTestId("live-step-cancelled").textContent).toBe(t("workBoard.liveCancelledNarration", { turns: 3 }));
    expect(within(panel).getByTestId("live-step-rerun")).toBeTruthy();
    expect(within(panel).queryByTestId("live-step-composer")).toBeNull();
  });

  it("says the run is already finishing when the stop arrives too late", async () => {
    const { emit, cancel } = await mountBoard();
    cancel.mockResolvedValueOnce({ ok: false, reason: "not-running" });
    await emit({ itemId: 4, phase: "executing", runSessionId: CHILD });
    const panel = await openSteps();
    await act(async () => { fireEvent.click(within(panel).getByTestId("live-step-stop")); });
    expect(within(panel).getByTestId("live-step-stop-notice").textContent).toBe(t("workBoard.liveStopNotRunning"));
    expect(screen.getByTestId("work-board-live-chip").dataset.state).toBe("executing");
  });

  it("switches to a newly started run while auto-follow is on, and stays put when it is off", async () => {
    const other = runningItem({ id: 5, title: "Tune the order API timeout", runId: undefined, runStatus: undefined, runHistory: undefined });
    const { emit, start } = await mountBoard({ items: [runningItem(), other] });
    await emit({ itemId: 4, phase: "executing", turn: 1, text: "Working" });
    const panel = await openSteps();
    const selected = () => within(panel).getAllByTestId("live-step-run-row").find((row) => row.getAttribute("aria-current") === "true")?.dataset.itemId;
    await waitFor(() => expect(selected()).toBe("4"));

    await start(5);
    expect(selected()).toBe("5");

    fireEvent.click(within(panel).getByTestId("live-step-auto-follow"));
    fireEvent.click(within(panel).getAllByTestId("live-step-run-row").find((row) => row.dataset.itemId === "4")!);
    await emit({ itemId: 5, phase: "cancelled", message: "user-stopped" });
    await start(5);
    expect(selected()).toBe("4");
  });

  it("judges the layout by the board body beside an open step panel: 900px with steps open docks, 1000px keeps the lanes", async () => {
    setContainerWidths({ canvasWidth: 900 });
    const { emit } = await mountBoard();
    await emit({ itemId: 4, phase: "executing", turn: 1, text: "Working" });
    await waitFor(() => expect(screen.getByTestId("work-board-panel").dataset.layout).toBe("wide"));
    await openSteps();
    // 900 - the 312px steps column leaves a ~588px body: too narrow for three lanes, so the panel docks below and the lanes become tabs.
    await waitFor(() => expect(screen.getByTestId("work-board-panel").dataset.layout).toBe("narrow"));
    expect(screen.getByTestId("work-board-docked")).toContainElement(screen.getByTestId("live-step-panel"));
    // Docking widens the body, but the verdict reads the panel, so it does not flip back.
    expect(screen.getByTestId("work-board-panel").dataset.layout).toBe("narrow");
    cleanup();

    setContainerWidths({ canvasWidth: 1000 });
    const again = await mountBoard();
    await again.emit({ itemId: 4, phase: "executing", turn: 1, text: "Working" });
    await openSteps();
    await waitFor(() => expect(screen.getByTestId("work-board-panel").dataset.layout).toBe("wide"));
    expect(screen.getByTestId("work-board-steps-column")).toContainElement(screen.getByTestId("live-step-panel"));
  });

  it("below 900px shows status tabs and docks the panel under the board behind a separator", async () => {
    setContainerWidths({ canvasWidth: 760 });
    const { emit } = await mountBoard();
    await emit({ itemId: 4, phase: "executing", turn: 1, text: "Working" });
    await waitFor(() => expect(screen.getByTestId("work-board-panel").dataset.layout).toBe("narrow"));
    expect(screen.getByTestId("work-board-tab-in-progress").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("work-board-column-planned")).toBeNull();
    await openSteps();
    const separator = screen.getByTestId("work-board-dock-separator");
    expect(separator.getAttribute("role")).toBe("separator");
    expect(screen.getByTestId("work-board-docked")).toContainElement(screen.getByTestId("live-step-panel"));
  });
});

describe("Work Board — the path to a card while no board is open", () => {
  afterEach(() => cleanup());

  it("parks the listed child's card behind its row dot, and the board opened from that row draws the same request", async () => {
    const queue = [childApproval()];
    const surface = { ...approvalSurfaceStub(), queue };
    // No board mounted: nothing claims the child, so its card parks on the listed row (the dot) and the lane does not draw it.
    const parked = pendingAnswers({
      approvals: queue,
      tiles: [],
      overlayCards: [],
      sessions: [{ id: CHILD, family: "work-board" }],
      isClaimed: (id) => surface.claims.ownerOf(id) !== null,
    });
    expect([...parked.sessionIds]).toEqual([CHILD]);
    expect(parked.unattributed).toEqual([]);
    expect(surface.decide).not.toHaveBeenCalled();

    // Opening the row opens the board on that item: it claims the child and its step panel draws the card for the same request.
    const harness = boardApi({ items: [runningItem({ runSessionId: CHILD })] });
    const onFocusConsumed = vi.fn();
    render(withApprovalSurface(<WorkBoardPanel api={harness.api} focusItemId={4} onFocusConsumed={onFocusConsumed} />, surface));
    const panel = await screen.findByTestId("live-step-panel");
    const card = await within(panel).findByTestId("approval-lane-card");
    expect(card.dataset.approvalRequestId).toBe("req-child");
    expect(surface.claims.ownerOf(CHILD)).toMatch(/^work-board:/);
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("work-board-detail-dialog")).toBeNull();
  });
});

describe("Work Board — opened from the row while the run still plans", () => {
  afterEach(() => cleanup());

  it("claims the planning child the listed item records, and draws its card for the same request", async () => {
    const PLAN_CHILD = "sub-plan-4";
    const queue = [approvalRequest({ id: "req-plan", sessionId: PLAN_CHILD, toolName: "read_file" }) as unknown as ApprovalRequest];
    const surface = { ...approvalSurfaceStub(), queue };
    // The board mounts fresh: no progress event reached it; only the stored item names the planning child.
    const harness = boardApi({ items: [runningItem({ runStatus: "planning", runSessionId: PLAN_CHILD })] });
    render(withApprovalSurface(<WorkBoardPanel api={harness.api} focusItemId={4} onFocusConsumed={vi.fn()} />, surface));
    const panel = await screen.findByTestId("live-step-panel");
    const card = await within(panel).findByTestId("approval-lane-card");
    expect(card.dataset.approvalRequestId).toBe("req-plan");
    expect(surface.claims.ownerOf(PLAN_CHILD)).toMatch(/^work-board:/);
  });
});

describe("Work Board — the composer belongs to one run", () => {
  afterEach(() => cleanup());

  it("does not let a late steer reply for one run land on another run's composer", async () => {
    const other = runningItem({ id: 5, title: "Tune the order API timeout", runId: "run-c" });
    const { emit, steer } = await mountBoard({ items: [runningItem(), other] });
    let resolve!: (v: unknown) => void;
    steer.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await emit({ itemId: 4, phase: "executing", turn: 1, text: "Working" });
    await emit({ itemId: 5, phase: "executing", turn: 1, text: "Measuring" });
    fireEvent.click(screen.getAllByTestId("work-board-show-steps")[0]!);
    const panel = await screen.findByTestId("live-step-panel");
    const rowFor = (id: string) => within(panel).getAllByTestId("live-step-run-row").find((row) => row.dataset.itemId === id)!;
    fireEvent.click(rowFor("4"));
    fireEvent.change(within(panel).getByTestId("live-step-steer-input"), { target: { value: "for run four" } });
    fireEvent.click(within(panel).getByTestId("live-step-steer-send"));

    fireEvent.click(rowFor("5"));
    fireEvent.change(within(panel).getByTestId("live-step-steer-input"), { target: { value: "draft for five" } });
    await act(async () => { resolve({ ok: false, reason: "recipient-unavailable" }); });
    expect((within(panel).getByTestId("live-step-steer-input") as HTMLTextAreaElement).value).toBe("draft for five");
    expect(within(panel).queryByTestId("live-step-steer-error")).toBeNull();
  });
});
