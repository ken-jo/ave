import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SchedulePanel } from "../SchedulePanel.js";
import { ScheduleItemPopover } from "../ScheduleItemPopover.js";
import type { AveApi } from "../../../types.js";
import type { RoutineOccurrence, RoutineRecord, RoutineRun } from "../../../../../shared/routines-types.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../../../installed-content.js";
import type { InstalledContentApi } from "../../../../../shared/installed-content.js";
import type { AgentPluginRoutineTemplate } from "../../../../../shared/agent-plugin-routine-template.js";

const NOW = new Date(2026, 10, 4, 11, 20);
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).toISOString();

function routine(patch: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "build",
    trigger: "schedule",
    execution: "llm-session",
    prePrompt: "check the build",
    title: "빌드 상태 확인",
    schedule: { at: at(5, 9), repeat: { kind: "daily" } },
    createdAt: at(2, 8, 41),
    createdBy: "user",
    ...patch,
  };
}

function makeApi(state: { routines: RoutineRecord[]; occurrences?: RoutineOccurrence[]; runs?: RoutineRun[]; running?: Array<{ routineId: string; firedAt: string }>; invalid?: Array<{ id: string; field: string; value: string; reason: "invalid-plugin-id" }> }) {
  const api = {
    listRoutines: vi.fn(async () => ({ routines: state.routines, invalid: state.invalid ?? [] })),
    listRoutineOccurrences: vi.fn(async () => ({ ok: true as const, occurrences: state.occurrences ?? [], runs: state.runs ?? [], running: state.running ?? [] })),
    updateRoutine: vi.fn(async (id: string) => ({ ok: true as const, routine: state.routines.find((r) => r.id === id)! })),
    pauseRoutine: vi.fn(async (id: string) => ({ ok: true as const, routine: state.routines.find((r) => r.id === id)! })),
    resumeRoutine: vi.fn(async (id: string) => ({ ok: true as const, routine: state.routines.find((r) => r.id === id)! })),
    triggerRoutineNow: vi.fn(async () => ({ ok: true })),
    removeRoutine: vi.fn(async () => ({ ok: true })),
    listPluginCards: vi.fn(async () => []),
    addRoutine: vi.fn(async () => ({ ok: true, routine: routine() })),
    onRoutineFired: vi.fn(() => () => {}),
    onRoutineRunningStarted: vi.fn(() => () => {}),
    onRoutineRunningFinished: vi.fn(() => () => {}),
    onRoutineFailed: vi.fn(() => () => {}),
  };
  return api as typeof api & AveApi;
}

const project = { projectRoot: "/work/checkout", projectName: "checkout-service" };

describe("SchedulePanel", () => {
  it("shows the empty state with 스케줄 추가 and asks only for this project", async () => {
    const api = makeApi({ routines: [] });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    const empty = await view.findByTestId("schedule-empty");
    expect(empty.textContent).toContain("아직 스케줄이 없습니다");
    expect(within(empty).getByRole("button", { name: /스케줄 추가/ })).toBeTruthy();
    expect(api.listRoutines).toHaveBeenCalledWith({ projectRoot: "/work/checkout" });
    expect(api.listRoutineOccurrences).toHaveBeenCalledWith({
      projectRoot: "/work/checkout",
      from: new Date(2026, 10, 2).toISOString(),
      to: new Date(2026, 10, 9).toISOString(),
    });
  });

  it("draws occurrences and past runs as chips with their status", async () => {
    const api = makeApi({
      routines: [routine()],
      occurrences: [{ routineId: "build", at: at(5, 9), status: "scheduled" }],
      runs: [{ routineId: "build", firedAt: at(3, 9), status: "failed", sessionId: "s1" }, { routineId: "build", firedAt: at(2, 9), status: "done" }],
    });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    await waitFor(() => expect(view.getAllByTestId("schedule-chip")).toHaveLength(3));
    expect(view.getAllByTestId("schedule-chip").map((c) => c.getAttribute("data-status"))).toEqual(["done", "failed", "scheduled"]);
    expect(view.queryByTestId("schedule-empty")).toBeNull();
  });

  it("edits from the chip popover; 저장 waits for a change", async () => {
    const api = makeApi({ routines: [routine()], occurrences: [{ routineId: "build", at: at(5, 9), status: "scheduled" }] });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByTestId("schedule-chip"));
    const popover = await view.findByTestId("schedule-item-popover");
    const save = within(popover).getByRole("button", { name: "저장" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(within(popover).getByTestId("schedule-provenance").textContent).toContain("직접 추가");
    fireEvent.change(within(popover).getByTestId("schedule-edit-prompt"), { target: { value: "check it twice" } });
    await act(async () => { fireEvent.click(save); });
    expect(api.updateRoutine).toHaveBeenCalledWith("build", { prePrompt: "check it twice" });
  });

  it("draws a one-shot missed while paused, says it will not run on its own, and still offers 지금 실행", async () => {
    const api = makeApi({
      routines: [routine({ schedule: { at: at(3, 9) }, resumedAt: at(4, 8) })],
      occurrences: [{ routineId: "build", at: at(3, 9), status: "missed" }],
    });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    const chip = await view.findByTestId("schedule-chip");
    expect(chip.getAttribute("data-status")).toBe("missed");
    fireEvent.click(chip);
    const popover = await view.findByTestId("schedule-item-popover");
    expect(within(popover).getByTestId("schedule-missed-note").textContent).toContain("저절로 실행되지 않으니");
    await act(async () => { fireEvent.click(within(popover).getByRole("button", { name: /지금 실행/ })); });
    expect(api.triggerRoutineNow).toHaveBeenCalledWith("build");
  });

  it("pauses and resumes at once, without confirmation", async () => {
    const state: { routines: RoutineRecord[]; occurrences: RoutineOccurrence[] } = {
      routines: [routine()], occurrences: [{ routineId: "build", at: at(5, 9), status: "scheduled" }],
    };
    const api = makeApi(state);
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByTestId("schedule-chip"));
    const pause = within(await view.findByTestId("schedule-item-popover")).getByRole("button", { name: /일시정지/ });
    // The store's answer after the pause: the refresh that follows it reads this.
    state.routines = [routine({ pausedAt: at(4, 11), pausedBy: "user" })];
    state.occurrences = [{ routineId: "build", at: at(5, 9), status: "paused" }];
    await act(async () => { fireEvent.click(pause); });
    expect(api.pauseRoutine).toHaveBeenCalledWith("build");
    await waitFor(() => expect(view.getByTestId("schedule-chip").getAttribute("data-status")).toBe("paused"));
    // The popover stays open on the paused item and now says so.
    const popover = await view.findByTestId("schedule-item-popover");
    await waitFor(() => expect(within(popover).queryByTestId("schedule-paused-note")).not.toBeNull());
    expect(within(popover).getByTestId("schedule-paused-note").textContent).toContain("내가 일시정지함");
    expect((within(popover).getByRole("button", { name: /지금 실행/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(within(popover).getByRole("button", { name: /다시 시작/ })); });
    expect(api.resumeRoutine).toHaveBeenCalledWith("build");
  });

  it("deletes at once with an undo toast; undo keeps it, otherwise it is removed when the panel closes", async () => {
    const api = makeApi({ routines: [routine()], occurrences: [{ routineId: "build", at: at(5, 9), status: "scheduled" }] });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByTestId("schedule-chip"));
    fireEvent.click(within(await view.findByTestId("schedule-item-popover")).getByRole("button", { name: /삭제/ }));
    expect(view.queryByTestId("schedule-chip")).toBeNull();
    // A click inside the popover must not reach the day column underneath and open 스케줄 추가.
    expect(view.queryByTestId("add-routine-modal")).toBeNull();
    const toast = view.getByTestId("schedule-undo-toast");
    fireEvent.click(await within(toast).findByRole("button", { name: "실행 취소" }));
    expect(view.getByTestId("schedule-chip")).toBeTruthy();
    expect(api.removeRoutine).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId("schedule-chip"));
    fireEvent.click(within(await view.findByTestId("schedule-item-popover")).getByRole("button", { name: /삭제/ }));
    expect(api.removeRoutine).not.toHaveBeenCalled();
    view.unmount();
    expect(api.removeRoutine).toHaveBeenCalledWith("build");
  });

  it("clicking an empty slot opens 스케줄 추가 at that time for this project", async () => {
    const api = makeApi({ routines: [routine()] });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    await waitFor(() => expect(api.listRoutines).toHaveBeenCalled());
    const thursday = view.getAllByTestId("schedule-day-column")[3]!;
    thursday.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 1152, width: 100, height: 1152, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(thursday, { clientY: 11 * 48 + 5 });
    const modal = await view.findByTestId("add-routine-modal");
    expect(modal.textContent).toContain("스케줄 추가");
    expect((within(modal).getByDisplayValue("2026-11-05") as HTMLInputElement).value).toBe("2026-11-05");
    expect(within(modal).getByDisplayValue("11:00")).toBeTruthy();
    fireEvent.change(within(modal).getByTestId("pre-prompt-input"), { target: { value: "deploy check" } });
    await act(async () => { fireEvent.click(within(modal).getByRole("button", { name: "등록" })); });
    expect(api.addRoutine).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/work/checkout", prePrompt: "deploy check" }));
  });

  it("month view shows three lines a day, then +N with a day popover", async () => {
    const occurrences: RoutineOccurrence[] = [8, 9, 10, 13, 15].map((h) => ({ routineId: "build", at: at(5, h), status: "scheduled" }));
    const api = makeApi({ routines: [routine()], occurrences });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByRole("tab", { name: "월간" }));
    const more = await view.findByTestId("schedule-month-more");
    expect(more.textContent).toContain("+2");
    fireEvent.click(more);
    expect((await view.findByText(/11월 5일 \(목\) · 5개/))).toBeTruthy();
    expect(view.getByRole("button", { name: "이 날 일일 보기" })).toBeTruthy();
  });

  it("a refresh that moves `at` forward after a fire neither dirties the open form nor sends the old time back", async () => {
    const onSave = vi.fn(async () => null);
    const props = { recentRuns: [], running: false, onClose: () => {}, onSave, onPause: () => {}, onResume: () => {}, onRunNow: () => {}, onDelete: () => {} };
    const view = render(<ScheduleItemPopover {...props} routine={routine()} />);
    view.rerender(<ScheduleItemPopover {...props} routine={routine({ schedule: { at: at(6, 9), repeat: { kind: "daily" } }, lastFiredAt: at(5, 9) })} />);
    const save = view.getByRole("button", { name: "저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((view.getByDisplayValue("2026-11-06") as HTMLInputElement).value).toBe("2026-11-06");
    fireEvent.change(view.getByPlaceholderText("데일리 리포트"), { target: { value: "새 제목" } });
    await act(async () => { fireEvent.click(save); });
    expect(onSave).toHaveBeenCalledWith({ title: "새 제목" });
  });

  it("day view: an item hidden behind +N opens from +N and from its row in the day list", async () => {
    const routines = ["a", "b", "c", "d"].map((id) => routine({ id, title: `항목 ${id}` }));
    const occurrences: RoutineOccurrence[] = routines.map((r) => ({ routineId: r.id, at: at(4, 14), status: "scheduled" }));
    const api = makeApi({ routines, occurrences });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByRole("tab", { name: "일일" }));
    fireEvent.click(await view.findByTestId("schedule-more"));
    const hidden = within(await view.findByTestId("schedule-more-list")).getByTestId("schedule-chip");
    expect(hidden.getAttribute("data-routine-id")).toBe("d");
    fireEvent.click(hidden);
    expect(within(await view.findByTestId("schedule-item-popover")).getByText("항목 d")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(view.queryByTestId("schedule-item-popover")).toBeNull());

    const rows = view.getAllByTestId("schedule-day-list-row");
    fireEvent.click(rows[3]!);
    expect(within(await view.findByTestId("schedule-item-popover")).getByText("항목 d")).toBeTruthy();
  });

  it("month view: a chip shown in the cell and in the day popover opens only the popover that was used", async () => {
    const occurrences: RoutineOccurrence[] = [8, 9, 10, 13].map((h) => ({ routineId: "build", at: at(5, h), status: "scheduled" }));
    const api = makeApi({ routines: [routine()], occurrences });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByRole("tab", { name: "월간" }));
    fireEvent.click(await view.findByTestId("schedule-month-more"));
    const inPopover = (await view.findByText(/11월 5일 \(목\) · 4개/)).parentElement!;
    fireEvent.click(within(inPopover).getAllByTestId("schedule-chip")[0]!);
    await waitFor(() => expect(view.getAllByTestId("schedule-item-popover")).toHaveLength(1));
  });

  it("names a chip's state, adds from the keyboard, and moves between view tabs with the arrow keys", async () => {
    const api = makeApi({
      routines: [routine()],
      runs: [{ routineId: "build", firedAt: at(3, 9), status: "failed" }],
    });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    expect(await view.findByRole("button", { name: "09:00 빌드 상태 확인, 실패" })).toBeTruthy();

    fireEvent.click(view.getAllByTestId("schedule-day-add")[3]!);
    const modal = await view.findByTestId("add-routine-modal");
    expect(within(modal).getByDisplayValue("2026-11-05")).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: /취소/ }));

    const week = view.getByRole("tab", { name: "주간" });
    const panel = view.getByRole("tabpanel");
    expect(week.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(week.id);
    week.focus();
    fireEvent.keyDown(week, { key: "ArrowRight" });
    const month = view.getByRole("tab", { name: "월간" });
    expect(month.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(month);
    expect(week.tabIndex).toBe(-1);
  });

  it("keeps the open popover and the user's edits when its occurrence fires, and says so when the item is deleted", async () => {
    const state: Parameters<typeof makeApi>[0] = { routines: [routine()], occurrences: [{ routineId: "build", at: at(4, 14), status: "scheduled" }] };
    const api = makeApi(state);
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByRole("button", { name: "14:00 빌드 상태 확인, 예정" }));
    fireEvent.change(within(await view.findByTestId("schedule-item-popover")).getByTestId("schedule-edit-prompt"), { target: { value: "draft prompt" } });

    // The 14:00 occurrence fires: it becomes a run, and the next occurrence is tomorrow.
    state.occurrences = [{ routineId: "build", at: at(5, 14), status: "scheduled" }];
    state.runs = [{ routineId: "build", firedAt: new Date(2026, 10, 4, 14, 0, 3).toISOString(), status: "done" }];
    const fired = (api.onRoutineFired.mock.calls[0] as unknown as [() => void])[0];
    await act(async () => { fired(); });
    await waitFor(() => expect(view.getByRole("button", { name: /^14:00 빌드 상태 확인, 완료/ })).toBeTruthy());
    const popover = view.getByTestId("schedule-item-popover");
    expect((within(popover).getByTestId("schedule-edit-prompt") as HTMLTextAreaElement).value).toBe("draft prompt");

    // Deleted elsewhere (the agent): the popover closes with a notice, not silently.
    state.routines = [];
    await act(async () => { fired(); });
    await waitFor(() => expect(view.queryByTestId("schedule-item-popover")).toBeNull());
    expect(view.getByRole("alert").textContent).toContain("스케줄이 삭제되어 상세 창을 닫았습니다.");
  });

  it("week view: +N lists the hidden items and offers 이 날 일일 보기", async () => {
    const routines = ["a", "b", "c"].map((id) => routine({ id, title: `항목 ${id}` }));
    const api = makeApi({ routines, occurrences: routines.map((r) => ({ routineId: r.id, at: at(5, 14), status: "scheduled" as const })) });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByTestId("schedule-more"));
    const list = await view.findByTestId("schedule-more-list");
    expect(within(list).getByTestId("schedule-chip").getAttribute("data-routine-id")).toBe("c");
    fireEvent.click(view.getByRole("button", { name: "이 날 일일 보기" }));
    expect(view.getByRole("tab", { name: "일일" }).getAttribute("aria-selected")).toBe("true");
    expect(view.getByTestId("schedule-range-label").textContent).toContain("11월 5일");
  });

  it("an open +N list and the hidden item opened from it stay open when that item fires", async () => {
    const routines = ["a", "b", "c", "d"].map((id) => routine({ id, title: `항목 ${id}` }));
    const state: Parameters<typeof makeApi>[0] = { routines, occurrences: routines.map((r) => ({ routineId: r.id, at: at(4, 14), status: "scheduled" as const })) };
    const api = makeApi(state);
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByRole("tab", { name: "일일" }));
    fireEvent.click(await view.findByTestId("schedule-more"));
    fireEvent.click(within(await view.findByTestId("schedule-more-list")).getByTestId("schedule-chip"));
    expect(within(await view.findByTestId("schedule-item-popover")).getByText("항목 d")).toBeTruthy();

    state.occurrences = routines.filter((r) => r.id !== "d").map((r) => ({ routineId: r.id, at: at(4, 14), status: "scheduled" as const }));
    state.runs = [{ routineId: "d", firedAt: new Date(2026, 10, 4, 14, 0, 4).toISOString(), status: "done" }];
    const fired = (api.onRoutineFired.mock.calls[0] as unknown as [() => void])[0];
    await act(async () => { fired(); });
    await waitFor(() => expect(within(view.getByTestId("schedule-more-list")).getByTestId("schedule-chip").getAttribute("data-status")).toBe("done"));
    expect(within(view.getByTestId("schedule-item-popover")).getByText("항목 d")).toBeTruthy();
  });

  it("undoing a delete brings the item back without the edits that were open", async () => {
    const api = makeApi({ routines: [routine()], occurrences: [{ routineId: "build", at: at(5, 9), status: "scheduled" }] });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    fireEvent.click(await view.findByTestId("schedule-chip"));
    const popover = await view.findByTestId("schedule-item-popover");
    fireEvent.change(within(popover).getByTestId("schedule-edit-prompt"), { target: { value: "half-typed" } });
    fireEvent.click(within(popover).getByRole("button", { name: "삭제" }));
    fireEvent.click(await view.findByRole("button", { name: "실행 취소" }));
    fireEvent.click(await view.findByTestId("schedule-chip"));
    expect((within(await view.findByTestId("schedule-item-popover")).getByTestId("schedule-edit-prompt") as HTMLTextAreaElement).value).toBe("check the build");
  });

  it("shows a run already in progress when the panel opens", async () => {
    const api = makeApi({ routines: [routine()], runs: [{ routineId: "build", firedAt: at(4, 11, 15), status: "done" }], running: [{ routineId: "build", firedAt: at(4, 11, 15) }] });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    await waitFor(() => expect(view.getAllByTestId("schedule-chip").map((c) => c.getAttribute("data-status"))).toContain("running"));
  });

  it("shows held-back and missing-extension items above the grid with a delete", async () => {
    const api = makeApi({
      routines: [routine({ id: "missing", needsAttention: { missingPluginIds: ["missing-plugin"] }, lastSkippedReason: "plugins-missing" })],
      invalid: [{ id: "legacy-routine", field: "scope.pluginIds.ids", value: "Legacy.Plugin", reason: "invalid-plugin-id" }],
    });
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
    const invalid = await view.findByTestId("invalid-routine-row");
    expect(invalid.textContent).toContain("Legacy.Plugin");
    expect(view.getByTestId("schedule-attention-row").textContent).toContain("missing-plugin");
    await act(async () => { fireEvent.click(within(invalid).getByRole("button", { name: "삭제" })); });
    expect(api.removeRoutine).toHaveBeenCalledWith("legacy-routine");
  });

  it("names the template an item came from, and says when it is gone", async () => {
    const template: AgentPluginRoutineTemplate = { id: "daily", packageName: "writer-plugin", version: "1.0.0", title: "Daily draft",
      description: "Write a draft", trigger: "schedule", schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } },
      execution: "llm-session", prePrompt: "Write the full draft" };
    const contentApi = { languageMessages: vi.fn(), installed: vi.fn() } as unknown as InstalledContentApi;
    const content = (templates: AgentPluginRoutineTemplate[]) => ({ themes: [], languages: [], fonts: [], routineTemplates: templates, broken: [] });
    const api = makeApi({
      routines: [routine({ source: "agent-plugin:writer-plugin:daily" })],
      occurrences: [{ routineId: "build", at: at(5, 9), status: "scheduled" }],
    });
    try {
      act(() => applyInstalledContent(content([template]), contentApi));
      const view = render(<SchedulePanel api={api} project={project} now={() => NOW} />);
      fireEvent.click(await view.findByTestId("schedule-chip"));
      expect((await view.findByTestId("schedule-template-note")).textContent).toContain("writer-plugin");
      act(() => applyInstalledContent(content([]), contentApi));
      expect(view.getByTestId("schedule-template-note").textContent).toContain("더 이상 설치");
      view.unmount();
    } finally { resetInstalledContentForTests(); }
  });
});

describe("SchedulePanel focus target (확인 필요 → 스케줄에서 열기)", () => {
  it("opens the requested item's popover from its chip once loaded, then reports it consumed", async () => {
    const target = routine({ id: "target-routine", title: "평일 테스트", needsAttention: { missingPluginIds: ["mail"] }, lastSkippedReason: "plugins-missing" });
    const api = makeApi({ routines: [routine(), target], occurrences: [
      { routineId: "build", at: at(5, 9), status: "scheduled" },
      { routineId: "target-routine", at: at(5, 10), status: "scheduled" },
    ] });
    const onFocusConsumed = vi.fn();
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} focusRoutineId="target-routine" onFocusConsumed={onFocusConsumed} />);
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    const popover = await view.findByTestId("schedule-item-popover");
    expect(within(popover).getByText("평일 테스트")).toBeTruthy();
  });

  it("focuses the attention row of a requested item with no chip in view", async () => {
    const api = makeApi({ routines: [routine({ id: "target-routine", needsAttention: { missingPluginIds: ["mail"] }, lastSkippedReason: "plugins-missing" })] });
    const onFocusConsumed = vi.fn();
    const view = render(<SchedulePanel api={api} project={project} now={() => NOW} focusRoutineId="target-routine" onFocusConsumed={onFocusConsumed} />);
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("schedule-attention-row");
    expect(view.queryByTestId("schedule-item-popover")).toBeNull();
  });

  it("consumes a request for an item that is gone without focusing anything", async () => {
    const api = makeApi({ routines: [] });
    const onFocusConsumed = vi.fn();
    render(<SchedulePanel api={api} project={project} now={() => NOW} focusRoutineId="gone" onFocusConsumed={onFocusConsumed} />);
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    expect(document.activeElement?.getAttribute("data-routine-id")).toBeFalsy();
  });
});
