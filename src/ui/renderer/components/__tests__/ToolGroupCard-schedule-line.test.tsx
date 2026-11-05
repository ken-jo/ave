// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ToolGroupCard } from "../ToolGroupCard.js";
import { ScheduleToolResultLine } from "../schedule/ScheduleChatChip.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

type ToolEntry = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];
const AT = new Date(2026, 10, 6, 9, 0).toISOString();
const ADDED = JSON.stringify({ routineId: "r-1", schedule: { at: AT, repeat: { kind: "daily" } }, connectedToThisChat: true });

function scheduleTool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    toolUseId: "t1", name: "routine_schedule", displayOrder: 0, status: "done",
    input: { execution: "llm-session", connectToThisChat: true }, result: ADDED, startedAt: 0, ...overrides,
  };
}

afterEach(cleanup);

describe("schedule tool result line", () => {
  it("says 스케줄 추가됨 · 이 대화에 연결 · 다음 <time> under an added schedule's row", () => {
    render(<TooltipProvider><ToolGroupCard group={{ kind: "tool_group", groupId: "g1", groupIds: ["g1"], status: "done", tools: [scheduleTool()] }} /></TooltipProvider>);
    expect(screen.getByTestId("schedule-tool-line").textContent).toContain(`스케줄 추가됨 · 이 대화에 연결 · 다음 ${formatMediumDateTime(AT)}`);
  });

  it("opens the item in the schedule panel from 스케줄에서 보기", () => {
    const onOpenRoutine = vi.fn();
    render(<ScheduleToolResultLine name="routine_schedule" input={scheduleTool().input} result={ADDED} failed={false} onOpenRoutine={onOpenRoutine} />);
    fireEvent.click(screen.getByRole("button", { name: "스케줄에서 보기" }));
    expect(onOpenRoutine).toHaveBeenCalledWith("r-1");
  });

  it("leaves out the connection for an item that runs in a new chat, and draws nothing for a change, a removal or an error", () => {
    const plain = JSON.stringify({ routineId: "r-2", schedule: { at: AT } });
    const view = render(<ScheduleToolResultLine name="routine_schedule" input={{ execution: "llm-session" }} result={plain} failed={false} />);
    expect(view.getByTestId("schedule-tool-line").textContent).toBe(`스케줄 추가됨 · 다음 ${formatMediumDateTime(AT)}`);
    view.unmount();
    for (const [input, result, failed] of [
      [{ action: "update", routineId: "r-1" }, ADDED, false],
      [{ action: "remove", routineId: "r-1" }, JSON.stringify({ routineId: "r-1", removed: true }), false],
      [{ execution: "llm-session" }, JSON.stringify({ error: "invalid schedule" }), true],
    ] as const) {
      const v = render(<ScheduleToolResultLine name="routine_schedule" input={input} result={result} failed={failed} />);
      expect(v.queryByTestId("schedule-tool-line")).toBeNull();
      v.unmount();
    }
  });
});
