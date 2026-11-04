import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SchedulePanel } from "../SchedulePanel.js";
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

function makeApi(state: { routines: RoutineRecord[]; occurrences?: RoutineOccurrence[]; runs?: RoutineRun[]; invalid?: Array<{ id: string; field: string; value: string; reason: "invalid-plugin-id" }> }) {
  const api = {
    listRoutines: vi.fn(async () => ({ routines: state.routines, invalid: state.invalid ?? [] })),
    listRoutineOccurrences: vi.fn(async () => ({ ok: true as const, occurrences: state.occurrences ?? [], runs: state.runs ?? [] })),
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
  it("focuses the requested item's attention row once loaded, then reports it consumed", async () => {
    const api = makeApi({ routines: [routine({ id: "target-routine", needsAttention: { missingPluginIds: ["mail"] }, lastSkippedReason: "plugins-missing" })] });
    const onFocusConsumed = vi.fn();
    render(<SchedulePanel api={api} project={project} now={() => NOW} focusRoutineId="target-routine" onFocusConsumed={onFocusConsumed} />);
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("schedule-attention-row");
    expect(document.activeElement?.getAttribute("data-routine-id")).toBe("target-routine");
  });

  it("consumes a request for an item that is gone without focusing anything", async () => {
    const api = makeApi({ routines: [] });
    const onFocusConsumed = vi.fn();
    render(<SchedulePanel api={api} project={project} now={() => NOW} focusRoutineId="gone" onFocusConsumed={onFocusConsumed} />);
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    expect(document.activeElement?.getAttribute("data-routine-id")).toBeFalsy();
  });
});
