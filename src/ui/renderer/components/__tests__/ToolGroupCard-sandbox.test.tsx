// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ToolGroupCard, type ToolSandboxModesByToolUseId } from "../ToolGroupCard.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

type ToolEntry = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

const tool = (toolUseId: string, displayOrder = 0): ToolEntry => ({
  toolUseId, name: "bash", displayOrder, status: "done", source: "builtin", input: { command: "whoami" }, result: "ok", durationMs: 1_000,
});

function renderGroup(tools: ToolEntry[], sandboxModes?: ToolSandboxModesByToolUseId) {
  return render(
    <TooltipProvider>
      <ToolGroupCard group={{ kind: "tool_group", groupId: "g1", groupIds: ["g1"], status: "done", tools }} sandboxModes={sandboxModes} />
    </TooltipProvider>,
  );
}

describe("ToolGroupCard sandbox chip", () => {
  afterEach(() => cleanup());

  it("shows how a command ran between its source and its status", () => {
    renderGroup([tool("t1")], new Map([["t1", "isolated"]]));
    const header = screen.getByTestId("tool-row-header");
    const chips = [...header.querySelectorAll("[data-testid^='tool-']")].map((node) => node.getAttribute("data-testid"));
    expect(chips.slice(0, 3)).toEqual(["tool-source", "tool-sandbox", "tool-status"]);
    expect(screen.getByTestId("tool-sandbox").getAttribute("data-sandbox-mode")).toBe("isolated");
  });

  it("marks each row of a group, and only rows that ran a command", () => {
    renderGroup([tool("t1"), tool("t2", 1)], new Map([["t2", "unconfined"]]));
    fireEvent.click(screen.getAllByRole("button")[0]!);
    const chips = screen.getAllByTestId("tool-sandbox");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.getAttribute("data-sandbox-mode")).toBe("unconfined");
  });

  it("shows no chip without an observed command", () => {
    renderGroup([tool("t1")]);
    expect(screen.queryByTestId("tool-sandbox")).toBeNull();
  });
});
