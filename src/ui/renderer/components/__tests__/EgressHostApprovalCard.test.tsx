// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressHostApprovalCard } from "../permissions/EgressHostApprovalCard.js";
import type { ApprovalRequest } from "../../types.js";
import { noteTerminalTabLabel } from "../../preview/terminal-tab-labels.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

const TAB = "terminal:0a1b2c3d-1";

function terminalAsk(id: string, overrides: Partial<NonNullable<ApprovalRequest["egressHost"]>> = {}, tabId = TAB): ApprovalRequest {
  return {
    id,
    category: "tool",
    kind: "egress-host",
    toolName: "terminal",
    args: { host: "github.com", port: 443, tabId },
    reason: `A command in workspace terminal ${tabId} wants to connect to github.com:443.`,
    createdAt: 0,
    allowedChoices: ["allow-once", "deny-once"],
    // Host rules are shell-origin: the host sends a terminal tab's ask with no rule to save.
    egressHost: { host: "github.com", port: 443, rule: null, network: "public", scopes: ["once", "tab", "always"], terminalTabId: tabId, ...overrides },
  } as unknown as ApprovalRequest;
}

let previousLocale: ReturnType<typeof getLocale>;
beforeEach(() => { previousLocale = getLocale(); });
afterEach(() => { setLocale(previousLocale); });

describe("EgressHostApprovalCard terminal-scoped grants", () => {
  beforeEach(() => { setLocale("en"); });

  it("names the terminal tab by its visible name instead of a conversation and offers This tab", () => {
    noteTerminalTabLabel(TAB, "Terminal 3");
    const onDecide = vi.fn();
    render(<EgressHostApprovalCard request={terminalAsk("ask-1")} conversationLabel="unused" onDecide={onDecide} />);
    const card = screen.getByTestId("egress-approval-card");
    expect(card.textContent).toContain("A command in a workspace terminal wants to connect");
    expect(card.textContent).toContain("Terminal tab: Terminal 3");
    expect(card.textContent).not.toContain(TAB);
    expect(card.textContent).not.toContain("Conversation:");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton).textContent).toBe("Allow for this tab");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: "tab" });
  });

  it("says when the tab is one this window never showed, never printing its id", () => {
    render(<EgressHostApprovalCard request={terminalAsk("ask-9", {}, "terminal:0a1b2c3d-9")} conversationLabel="unused" onDecide={vi.fn()} />);
    const card = screen.getByTestId("egress-approval-card");
    expect(card.textContent).toContain("Terminal tab: a terminal tab in another window");
    expect(card.textContent).not.toContain("terminal:0a1b2c3d-9");
  });

  it("says a local grant lasts until the tab's shell exits, including an exit and restart", () => {
    render(<EgressHostApprovalCard
      request={terminalAsk("ask-1", { host: "10.0.0.5", network: "local", scopes: ["once", "tab"] })}
      conversationLabel="unused"
      onDecide={vi.fn()}
    />);
    expect(screen.getByTestId("egress-approval-local-warning").textContent).toContain("until this tab's shell exits (the tab closes, or the shell exits and restarts)");
  });
});
