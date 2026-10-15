// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ToolGroupCard } from "../ToolGroupCard.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

type ToolEntry = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

function shellTool(toolUseId: string, overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    toolUseId,
    name: "bash",
    displayOrder: 0,
    status: "running",
    input: { command: "make" },
    startedAt: Date.now(),
    ...overrides,
  };
}

function renderGroup(tools: ToolEntry[]) {
  return render(
    <TooltipProvider>
      <ToolGroupCard
        group={{
          kind: "tool_group",
          groupId: "g1",
          groupIds: ["g1"],
          status: tools.some((tool) => tool.status === "running") ? "running" : "done",
          tools,
        }}
      />
    </TooltipProvider>,
  );
}

describe("ToolGroupCard live output", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the last lines of a running tool without expanding its row", () => {
    const lines = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n");
    renderGroup([shellTool("t1", { liveOutput: `${lines}\n` })]);
    const live = screen.getByTestId("tool-live-output");
    expect(live.textContent).toBe(["line 4", "line 5", "line 6", "line 7", "line 8", "line 9"].join("\n"));
  });

  it("renders a carriage-return progress line as its latest state without terminal codes", () => {
    renderGroup([shellTool("t1", { liveOutput: "\u001b[32mfetch 10%\rfetch 55%\rfetch 90%\u001b[0m" })]);
    expect(screen.getByTestId("tool-live-output").textContent).toBe("fetch 90%");
  });

  it("shows each running tool's output in a multi-tool group, collapsed or expanded", () => {
    renderGroup([
      shellTool("t1", { liveOutput: "first\n" }),
      shellTool("t2", { displayOrder: 1, liveOutput: "second\n" }),
    ]);
    const texts = () => screen.getAllByTestId("tool-live-output").map((node) => node.textContent);
    expect(texts()).toEqual(["first", "second"]);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(texts()).toEqual(["first", "second"]);
  });

  it("shows nothing once the tool has completed", () => {
    renderGroup([shellTool("t1", { status: "done", result: "ok", liveOutput: "stale" })]);
    expect(screen.queryByTestId("tool-live-output")).toBeNull();
  });
});
