// @vitest-environment jsdom
/** Schedule cards on the work board: 예정 / 진행 중 / 완료 cards from the schedule data, a per-project "스케줄 같이 보기"
 * toggle, and a link to the schedule panel. */
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import { PlannedScheduleCardView, RunningScheduleCardView, ScheduleWeekBundle } from "../schedule/BoardScheduleCards.js";
import type { AveApi } from "../../types.js";
import type { RoutineOccurrencesResult, RoutineRecord } from "../../../../shared/routines-types.js";
import { t } from "../../../../i18n/runtime.js";
import { boardScheduleCards } from "../schedule/board-schedule.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import { localIso } from "../schedule/__tests__/schedule-test-helpers.js";

const NOW = new Date("2026-11-05T10:00:00");
const iso = localIso;

function routine(id: string, title: string): RoutineRecord {
  return {
    id, title, trigger: "schedule", execution: "llm-session", prePrompt: "p", createdAt: "2026-11-01T00:00:00.000Z",
    schedule: { at: iso("2026-11-01T09:00:00"), repeat: { kind: "daily" } }, projectRoot: "/p/a", createdBy: "user",
  };
}

function stubApi(initialRunning: Array<{ routineId: string; firedAt: string }> = [], items: unknown[] = [], extraRoutines: RoutineRecord[] = []) {
  let started: ((p: { routineId: string; firedAt: string }) => void) | undefined;
  let finished: ((routineId: string) => void) | undefined;
  // The host's list of runs in progress, as listRoutineOccurrences reports it.
  const running = [...initialRunning];
  const noop = () => () => {};
  const occurrences: RoutineOccurrencesResult = {
    ok: true,
    occurrences: [{ routineId: "deps", at: iso("2026-11-05T13:00:00"), status: "scheduled" }],
    running: [],
    runs: [
      { routineId: "brief", firedAt: iso("2026-11-03T08:30:00"), status: "done", sessionId: "s-a" },
      { routineId: "brief", firedAt: iso("2026-11-04T08:30:00"), status: "done" },
      { routineId: "deps", firedAt: iso("2026-11-02T13:00:00"), status: "failed" },
      { routineId: "brief", firedAt: iso("2026-11-05T09:56:00"), status: "done", sessionId: "s-live" },
    ],
  };
  const api = {
    listWorkBoard: vi.fn(async () => ({ status: "ok" as const, items })),
    listWorkProposals: async () => ({ status: "ok" as const, proposals: [] }),
    onWorkBoardItemChanged: noop,
    onWorkProposalChanged: noop,
    onWorkBoardRunProgress: noop,
    onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
    listRoutines: vi.fn(async () => ({ routines: [routine("brief", "Morning brief"), routine("deps", "Dependency check"), ...extraRoutines], invalid: [] })),
    listRoutineOccurrences: vi.fn(async () => ({ ...occurrences, running: [...running] })),
    onRoutineFired: noop,
    onRoutineRunningStarted: (h: (p: { routineId: string; firedAt: string }) => void) => { started = h; return () => {}; },
    onRoutineRunningFinished: (h: (routineId: string) => void) => { finished = h; return () => {}; },
    onRoutineFailed: noop,
  } as unknown as AveApi;
  const startRun = (routineId: string, firedAt: string) => act(() => {
    running.push({ routineId, firedAt });
    started?.({ routineId, firedAt });
  });
  const finishRun = (routineId: string) => act(() => {
    running.splice(running.findIndex((r) => r.routineId === routineId), 1);
    finished?.(routineId);
  });
  return { api, startRun, finishRun };
}

const PROJECT_A = { projectRoot: "/p/a", name: "a" } as never;
const PROJECT_B = { projectRoot: "/p/b", name: "b" } as never;

describe("Work Board — schedule cards", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the next run in 예정, a run in progress in 진행 중, and this week's runs as one bundle in 완료", async () => {
    const { api, startRun } = stubApi();
    const onOpenSession = vi.fn();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} onOpenSession={onOpenSession} />));

    const planned = screen.getByTestId("work-board-column-planned");
    expect(await within(planned).findByText("Dependency check")).toBeTruthy();
    expect(within(planned).getByTestId("board-schedule-card-deps").textContent).toContain(t("schedulePanel.runsInNewChat"));

    startRun("brief", iso("2026-11-05T09:56:00"));
    const progress = screen.getByTestId("work-board-column-in-progress");
    const live = await within(progress).findByTestId("board-schedule-running-brief");
    expect(live.textContent).toContain(t("workBoard.scheduleRunning"));
    expect(live.textContent).toContain(t("workBoard.scheduleElapsed", { minutes: "4" }));
    fireEvent.click(within(live).getByRole("button", { name: t("schedulePanel.openChat") }));
    expect(onOpenSession).toHaveBeenCalledWith("s-live");

    const done = screen.getByTestId("work-board-column-completed");
    const bundle = within(done).getByTestId("board-schedule-week");
    // The run still in progress is not counted.
    expect(bundle.textContent).toContain(t("workBoard.scheduleWeekRuns", { count: "3" }));
    expect(within(bundle).queryByText("Morning brief")).toBeNull();
    fireEvent.click(within(bundle).getByRole("button", { expanded: false }));
    expect(within(bundle).getByText("Morning brief")).toBeTruthy();
    expect(within(bundle).getByTestId("board-schedule-week-row-deps").textContent).toContain(t("workBoard.scheduleFailedCount", { count: "1" }));
    expect(within(planned).getByTestId("work-board-column-planned-count").textContent).toBe(t("workBoard.columnCountWithSchedule", { items: "0", schedules: "1" }));
  });

  it("hides the cards when the toggle is off, and remembers that per project", async () => {
    const { api } = stubApi();
    const first = render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} />));
    await screen.findByTestId("board-schedule-card-deps");
    fireEvent.click(screen.getByRole("checkbox", { name: t("workBoard.showSchedule") }));
    expect(screen.queryByTestId("board-schedule-card-deps")).toBeNull();
    expect(screen.queryByTestId("board-schedule-week")).toBeNull();
    first.unmount();

    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} />));
    expect(screen.getByRole("checkbox", { name: t("workBoard.showSchedule") }).getAttribute("aria-checked")).toBe("false");
    cleanup();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_B} />));
    expect(screen.getByRole("checkbox", { name: t("workBoard.showSchedule") }).getAttribute("aria-checked")).toBe("true");
  });

  it("opens the schedule from the link, and a card opens the schedule on its item", async () => {
    const { api } = stubApi();
    const onOpenSchedule = vi.fn();
    const onOpenRoutine = vi.fn();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} onOpenSchedule={onOpenSchedule} onOpenRoutine={onOpenRoutine} />));
    fireEvent.click(screen.getByRole("button", { name: t("workBoard.openSchedule") }));
    expect(onOpenSchedule).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByTestId("board-schedule-card-deps"));
    expect(onOpenRoutine).toHaveBeenCalledWith("deps");
  });

  it("shows a run already in progress when the board opens, and no stale run after one ends while the cards are hidden", async () => {
    const { api, startRun, finishRun } = stubApi([{ routineId: "brief", firedAt: iso("2026-11-05T09:56:00") }]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} />));
    expect(await screen.findByTestId("board-schedule-running-brief")).toBeTruthy();
    finishRun("brief");
    await waitFor(() => expect(screen.queryByTestId("board-schedule-running-brief")).toBeNull());

    startRun("deps", iso("2026-11-05T10:00:00"));
    expect(await screen.findByTestId("board-schedule-running-deps")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: t("workBoard.showSchedule") }));
    finishRun("deps");
    fireEvent.click(screen.getByRole("checkbox", { name: t("workBoard.showSchedule") }));
    expect(await screen.findByTestId("board-schedule-card-deps")).toBeTruthy();
    expect(screen.queryByTestId("board-schedule-running-deps")).toBeNull();
  });

  it("places schedule cards among work cards by time, and lists a skipped item in the week's bundle", async () => {
    const work = (id: number, title: string, due: string) => ({ id, title, detail: "", status: "planned", status_resolved: "planned", priority: "medium",
      created_at: iso("2026-11-01T00:00:00"), updated_at: iso("2026-11-01T00:00:00"), due_at: iso(due) });
    const skipped = { ...routine("gh", "PR review reminder"), lastSkippedReason: "plugins-missing" as const, needsAttention: { missingPluginIds: ["github"] } };
    const { api } = stubApi([], [work(1, "Before", "2026-11-05T12:00:00"), work(2, "After", "2026-11-05T14:00:00")], [skipped]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} />));
    const planned = screen.getByTestId("work-board-column-planned");
    await within(planned).findByTestId("board-schedule-card-deps");
    const order = [...planned.querySelectorAll('[data-testid="work-board-card"], [data-testid^="board-schedule-card-"]')]
      .map((el) => el.getAttribute("data-testid") === "work-board-card" ? el.textContent?.includes("Before") ? "Before" : "After" : "deps");
    expect(order).toEqual(["Before", "deps", "After"]);
    const bundle = within(screen.getByTestId("work-board-column-completed")).getByTestId("board-schedule-week");
    fireEvent.click(within(bundle).getByRole("button", { expanded: false }));
    const row = within(bundle).getByTestId("board-schedule-week-skipped-gh");
    expect(row.textContent).toContain(t("workBoard.scheduleSkipped"));
    expect(row.textContent).toContain("github");
  });

  it("advances a running card's elapsed minutes on its own minute timer, between data refreshes", () => {
    const card = { routine: routine("brief", "Morning brief"), firedAt: new Date(NOW.getTime() - 90_000).toISOString() };
    render(<RunningScheduleCardView card={card} />);
    const view = screen.getByTestId("board-schedule-running-brief");
    expect(view.textContent).toContain(t("workBoard.scheduleElapsed", { minutes: "1" }));
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(view.textContent).toContain(t("workBoard.scheduleElapsed", { minutes: "2" }));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(view.textContent).toContain(t("workBoard.scheduleElapsed", { minutes: "3" }));
    cleanup();
    // Unmounted with the card: no timer stays behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("draws a card connected to a chat with the blue bar, the alarm mark and where it runs", () => {
    const card = { routine: { ...routine("deps", "Dependency check"), targetSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, nextAt: iso("2026-11-05T13:00:00") };
    render(<PlannedScheduleCardView card={card} />);
    const view = screen.getByTestId("board-schedule-card-deps");
    expect(view.getAttribute("data-connected")).toBe("true");
    expect(view.className).toContain("--color-info");
    expect(view.textContent).toContain(t("schedulePanel.runsInConnectedChat"));
    expect(view.textContent).not.toContain(t("schedulePanel.runsInNewChat"));
  });

  it("counts only work items in the done badge when this week has skipped items but no run", async () => {
    const skipped = { ...routine("gh", "PR review reminder"), lastSkippedReason: "plugins-missing" as const, needsAttention: { missingPluginIds: ["github"] } };
    const { api } = stubApi([], [], [skipped]);
    (api as unknown as { listRoutineOccurrences: unknown }).listRoutineOccurrences = vi.fn(async () => ({ ok: true, occurrences: [], running: [], runs: [] }));
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} />));
    const done = screen.getByTestId("work-board-column-completed");
    await within(done).findByTestId("board-schedule-week");
    // Never "업무 0 · 스케줄 0회": the bundle itself says what was skipped.
    expect(within(done).getByTestId("work-board-column-completed-count").textContent).toBe("0");
  });

  it("moves to the new week when the day turns over on an open board", async () => {
    vi.setSystemTime(new Date("2026-11-08T23:59:30"));
    const { api } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT_A} />));
    await waitFor(() => expect(api.listRoutineOccurrences).toHaveBeenCalled());
    const firstFrom = (vi.mocked(api.listRoutineOccurrences).mock.calls[0]![0] as { from: string }).from;
    expect(firstFrom).toBe(iso("2026-11-02T00:00:00"));
    vi.setSystemTime(new Date("2026-11-09T00:00:40"));
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    await waitFor(() => expect(vi.mocked(api.listRoutineOccurrences).mock.calls.some(([q]) => (q as { from: string }).from === iso("2026-11-09T00:00:00"))).toBe(true));
  });
});


it("shows only the latest dated metrics in a busy weekly group", () => {
  const item = routine("brief", "Morning brief");
  const runs = Array.from({ length: 21 }, (_, index) => ({
    routineId: item.id, firedAt: iso(`2026-11-0${2 + Math.floor(index / 3)}T${String(8 + index % 3).padStart(2, "0")}:00:00`), status: "done" as const,
    metrics: { startedAt: iso("2026-11-02T08:00:00"), durationMs: 192000, tokens: { input: 4000, output: 100, total: 4100 } },
  }));
  const latest = runs.at(-1)!;
  const { week } = boardScheduleCards({ records: [item], runs: runs.toReversed(), occurrences: [], running: new Map(), now: new Date("2026-11-08T12:00:00") });
  const view = render(<ScheduleWeekBundle week={week} />);
  fireEvent.click(view.getByRole("button", { expanded: false }));
  expect(view.getAllByTestId("routine-run-metrics")).toHaveLength(1);
  expect(view.getByTestId("routine-run-metrics").textContent).toBe("3분 12초 · 4.1k 토큰");
  expect(view.getByTestId("board-schedule-week-row-brief").textContent).toContain(formatMediumDateTime(latest.firedAt));
});
