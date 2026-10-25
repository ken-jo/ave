// @vitest-environment jsdom
/**
 * Relaunch rendering for a turn the previous app run never finished: the
 * partial answer keeps its interrupted badge, and the composer offers Continue
 * — which runs only when clicked.
 */
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InterruptedTurnBanner } from "../InterruptedTurnBanner.js";
import { AssistantCard } from "../AssistantCard.js";
import { historyToEntries, interruptedTurnOffer, type PersistedHistoryMessage } from "../../utils/history.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

const crashedTurn: PersistedHistoryMessage[] = [
  { index: 0, role: "user", content: "보고서 정리해 줘", messageId: "u1" },
  { index: 1, role: "assistant", content: "파일을 읽겠습니다", messageId: "a1", toolCalls: [{ id: "c1", name: "read_file", input: {} }] },
  { index: 2, role: "tool_result", content: "본문", toolUseId: "c1", messageId: "r1" },
  { index: 3, role: "assistant", content: "정리하면 첫째", messageId: "a2", interrupted: true, interruptedBy: "host-exit" },
];

function assistantEntries(entries: ChatEntry[]) {
  return entries.filter((e): e is Extract<ChatEntry, { kind: "assistant" }> => e.kind === "assistant");
}

describe("interruptedTurnOffer", () => {
  it("offers resume when the transcript ends in a host-exit interrupted row", () => {
    expect(interruptedTurnOffer(historyToEntries(crashedTurn))).toBe("resume");
  });

  it("keeps an empty host-exit marker as a card so the stop is visible", () => {
    const entries = historyToEntries([
      ...crashedTurn.slice(0, 3),
      { index: 3, role: "assistant", content: "", messageId: "m", interrupted: true, interruptedBy: "host-exit" },
    ]);
    const last = assistantEntries(entries).at(-1);
    expect(last).toMatchObject({ text: "", interrupted: true, interruptedBy: "host-exit", restored: true });
    expect(interruptedTurnOffer(entries)).toBe("resume");
  });

  it("offers rerun for a persisted question nothing answered", () => {
    expect(interruptedTurnOffer(historyToEntries(crashedTurn.slice(0, 1)))).toBe("rerun");
  });

  it("offers nothing for a finished turn, a user Stop, or a live unanswered bubble", () => {
    expect(interruptedTurnOffer(historyToEntries([
      crashedTurn[0],
      { index: 1, role: "assistant", content: "끝", messageId: "a" },
    ]))).toBeNull();
    expect(interruptedTurnOffer(historyToEntries([
      crashedTurn[0],
      { index: 1, role: "assistant", content: "멈춤", messageId: "a", interrupted: true },
    ]))).toBeNull();
    expect(interruptedTurnOffer([{ kind: "user", text: "방금 보낸 질문" }])).toBeNull();
  });
});

describe("InterruptedTurnBanner", () => {
  it("renders the resume notice and runs Continue only on click", () => {
    const onContinue = vi.fn();
    render(<InterruptedTurnBanner offer="resume" onContinue={onContinue} />);
    expect(screen.getByTestId("interrupted-turn-banner").getAttribute("data-offer")).toBe("resume");
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("interrupted-turn-continue"));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without an offer", () => {
    const { container } = render(<InterruptedTurnBanner offer={null} onContinue={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the restored partial answer with the interrupted badge", () => {
    const partial = assistantEntries(historyToEntries(crashedTurn)).at(-1)!;
    render(<AssistantCard entry={partial} />);
    const badge = screen.getByTestId("assistant-interrupted-badge");
    expect(badge.getAttribute("data-interrupted-by")).toBe("host-exit");
    expect(badge.textContent).toMatch(/Ave closed|Ave 종료/);
    expect(screen.getByText(/정리하면 첫째/)).toBeTruthy();
  });

  it("keeps the user's own Stop badge distinct from an app-exit interruption", () => {
    const stopped = assistantEntries(historyToEntries([
      crashedTurn[0],
      { index: 1, role: "assistant", content: "멈춤", messageId: "a", interrupted: true },
    ])).at(-1)!;
    render(<AssistantCard entry={stopped} />);
    const badge = screen.getByTestId("assistant-interrupted-badge");
    expect(badge.getAttribute("data-interrupted-by")).toBe("user");
    expect(badge.textContent).toMatch(/Stopped by user|사용자가 중지함/);
  });

  it("shows the resumed turn as its own Continue bubble and stops offering Continue", () => {
    const entries = historyToEntries([
      ...crashedTurn,
      { index: 4, role: "user", content: "Continue from where you left off.", displayText: "Continue", messageId: "u2" },
      { index: 5, role: "assistant", content: "마무리했습니다", messageId: "a3" },
    ]);
    const users = entries.filter((e) => e.kind === "user");
    expect(users.at(-1)).toMatchObject({ text: "Continue" });
    expect(interruptedTurnOffer(entries)).toBeNull();
  });
});
