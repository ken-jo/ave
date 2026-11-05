import "../../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ScheduleChatChip } from "../ScheduleChatChip.js";
import type { AveApi } from "../../../types.js";
import type { RoutineRecord } from "../../../../../shared/routines-types.js";
import { localIso } from "./schedule-test-helpers.js";

const CHAT = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2";

function routine(patch: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "build",
    trigger: "schedule",
    execution: "llm-session",
    prePrompt: "check the nightly build",
    title: "빌드 상태 확인",
    schedule: { at: localIso("2026-11-05T09:00:00"), repeat: { kind: "daily" } },
    createdAt: localIso("2026-11-02T08:41:00"),
    createdBy: "agent",
    targetSessionId: CHAT,
    ...patch,
  };
}

function makeApi(routines: RoutineRecord[]) {
  const handlers: { started?: (p: { routineId: string; firedAt: string; title: string }) => void } = {};
  const api = {
    listRoutines: vi.fn(async () => ({ routines, invalid: [] })),
    updateRoutine: vi.fn(async (id: string) => ({ ok: true as const, routine: routines.find((r) => r.id === id)! })),
    pauseRoutine: vi.fn(async (id: string) => ({ ok: true as const, routine: routines.find((r) => r.id === id)! })),
    resumeRoutine: vi.fn(async (id: string) => ({ ok: true as const, routine: routines.find((r) => r.id === id)! })),
    triggerRoutineNow: vi.fn(async () => ({ ok: true })),
    removeRoutine: vi.fn(async () => ({ ok: true })),
    onRoutineFired: vi.fn(() => () => {}),
    onRoutineRunningStarted: vi.fn((handler: typeof handlers.started) => { handlers.started = handler; return () => {}; }),
    onRoutineRunningFinished: vi.fn(() => () => {}),
    onRoutineFailed: vi.fn(() => () => {}),
  };
  return { api: api as typeof api & AveApi, handlers };
}

/** Radix opens its menu on pointer down, not on click. */
function openMenu(chip: HTMLElement) {
  fireEvent.pointerDown(chip, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

afterEach(() => { vi.useRealTimers(); });

describe("ScheduleChatChip", () => {
  it("shows only this chat's connected items, by repeat and time", async () => {
    const { api } = makeApi([routine(), routine({ id: "theirs", targetSessionId: OTHER }), routine({ id: "free", targetSessionId: undefined })]);
    const view = render(<ScheduleChatChip api={api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    const chip = await view.findByTestId("schedule-chat-chip");
    expect(chip.textContent).toBe("스케줄 매일 09:00");
  });

  it("reads again when a turn ends or the chat comes back into view, so an item added meanwhile shows", async () => {
    const routines: RoutineRecord[] = [];
    const { api } = makeApi(routines);
    const view = render(<ScheduleChatChip api={api} sessionId={CHAT} refreshKey="streaming" onOpenRoutine={() => {}} />);
    await waitFor(() => expect(api.listRoutines).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId("schedule-chat-chip")).toBeNull();
    routines.push(routine());
    view.rerender(<ScheduleChatChip api={api} sessionId={CHAT} refreshKey="idle" onOpenRoutine={() => {}} />);
    expect((await view.findByTestId("schedule-chat-chip")).textContent).toBe("스케줄 매일 09:00");
  });

  it("draws nothing for a chat with no connected item", async () => {
    const { api } = makeApi([routine({ targetSessionId: OTHER })]);
    const view = render(<ScheduleChatChip api={api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    await waitFor(() => expect(api.listRoutines).toHaveBeenCalled());
    expect(view.queryByTestId("schedule-chat-chip")).toBeNull();
  });

  it("reads 스케줄 2, 멈춤, 실패 and 실행 중 for its other states", async () => {
    const two = makeApi([routine(), routine({ id: "second" })]);
    const v1 = render(<ScheduleChatChip api={two.api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    expect((await v1.findByTestId("schedule-chat-chip")).textContent).toBe("스케줄 2");
    v1.unmount();

    const paused = makeApi([routine({ pausedAt: localIso("2026-11-04T10:00:00"), pausedBy: "user" })]);
    const v2 = render(<ScheduleChatChip api={paused.api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    expect((await v2.findByTestId("schedule-chat-chip")).textContent).toBe("스케줄 멈춤");
    v2.unmount();

    const failedRun = makeApi([routine({ lastFailure: { firedAt: localIso("2026-11-04T09:00:00"), at: localIso("2026-11-04T09:01:00"), kind: "error", reason: "429" } })]);
    const v3 = render(<ScheduleChatChip api={failedRun.api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    expect((await v3.findByTestId("schedule-chat-chip")).textContent).toBe("스케줄 실패");
    v3.unmount();

    const live = makeApi([routine()]);
    const v4 = render(<ScheduleChatChip api={live.api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    await v4.findByTestId("schedule-chat-chip");
    act(() => live.handlers.started?.({ routineId: "build", firedAt: localIso("2026-11-05T09:00:00"), title: "x" }));
    await waitFor(() => expect(v4.getByTestId("schedule-chat-chip").textContent).toBe("스케줄 · 실행 중"));
  });

  it("applies each menu action at once through the schedule IPC", async () => {
    const { api } = makeApi([routine()]);
    const onOpenRoutine = vi.fn();
    const view = render(<ScheduleChatChip api={api} sessionId={CHAT} onOpenRoutine={onOpenRoutine} />);
    const pick = async (name: RegExp) => {
      openMenu(await view.findByTestId("schedule-chat-chip"));
      fireEvent.click(await view.findByRole("menuitem", { name }));
    };
    await pick(/스케줄에서 보기/);
    expect(onOpenRoutine).toHaveBeenLastCalledWith("build");
    await pick(/지금 실행/);
    await waitFor(() => expect(api.triggerRoutineNow).toHaveBeenCalledWith("build"));
    await pick(/일시정지/);
    await waitFor(() => expect(api.pauseRoutine).toHaveBeenCalledWith("build"));
    await pick(/시각·프롬프트 편집/);
    expect(onOpenRoutine).toHaveBeenCalledTimes(2);
    await pick(/연결 해제/);
    await waitFor(() => expect(api.updateRoutine).toHaveBeenCalledWith("build", { targetSessionId: null }));
  });

  it("deletes with an undo notice and no confirm, and undo keeps the item", async () => {
    const { api } = makeApi([routine()]);
    const view = render(<ScheduleChatChip api={api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    openMenu(await view.findByTestId("schedule-chat-chip"));
    fireEvent.click(await view.findByRole("menuitem", { name: /삭제/ }));
    const undo = await view.findByTestId("schedule-chip-undo");
    expect(view.queryByTestId("schedule-chat-chip")).toBeNull();
    fireEvent.click(undo.querySelector("button")!);
    expect(await view.findByTestId("schedule-chat-chip")).toBeTruthy();
    expect(api.removeRoutine).not.toHaveBeenCalled();
  });

  it("commits the delete when the undo window closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = makeApi([routine()]);
    const view = render(<ScheduleChatChip api={api} sessionId={CHAT} onOpenRoutine={() => {}} />);
    openMenu(await view.findByTestId("schedule-chat-chip"));
    fireEvent.click(await view.findByRole("menuitem", { name: /삭제/ }));
    await view.findByTestId("schedule-chip-undo");
    await act(async () => { vi.advanceTimersByTime(6_100); });
    await waitFor(() => expect(api.removeRoutine).toHaveBeenCalledWith("build"));
  });
});
