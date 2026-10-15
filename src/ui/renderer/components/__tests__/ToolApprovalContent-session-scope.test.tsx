// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

/**
 * A browser scope is remembered for this app session only: the remember
 * button says so, records `scope: "session"`, and the scope line names the
 * origin and whose tabs it covers.
 */
function browserRequest(tabOpener: "agent" | "user"): ApprovalRequest {
  return {
    id: `browser-click-${tabOpener}`,
    category: "tool",
    kind: "tool",
    toolName: "browser_click",
    toolCategory: "write",
    args: { tabId: "tab-1", ref: "e3" },
    reason: "browser page action",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: false,
    trustOrigin: "user-keyboard",
    reviewerVerdict: { level: "medium", reason: "browser page action" },
    persistentAllowAllowed: true,
    persistentApprovalCwd: "/workspace/project",
    approvalMemory: {
      kind: "key",
      key: "browser_click:origin",
      scope: { kind: "browser-origin", origin: "https://a.example:443", tabOpener, tabId: "tab-1", documentId: 1 },
    },
  };
}

describe("ToolApprovalContent session-only browser scope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers allow-for-this-session and records it for the session only", async () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={browserRequest("agent")} onDecide={onDecide} />);

    const remember = screen.getByTestId(TEST_IDS.allowAlwaysButton);
    expect(remember).toHaveTextContent("이번 세션 동안 허용");
    expect(remember).not.toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("https://a.example:443");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("에이전트가 연 탭");

    fireEvent.click(remember);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ scope: "session" }));
  });

  it("names the user's own tabs for a user-tab scope", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={browserRequest("user")} onDecide={vi.fn()} />);
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("직접 연 탭");
  });

  it("names the page and whose tab it is on a one-shot user-tab card", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    const request: ApprovalRequest = {
      ...browserRequest("user"),
      allowedChoices: ["allow-once", "deny-once"],
      persistentAllowAllowed: false,
      requireExplicit: true,
    };
    render(<ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    expect(screen.queryByTestId("allow-always-exact-scope")).toBeNull();
    const target = screen.getByTestId("approval-browser-target");
    expect(target).toHaveTextContent("https://a.example:443");
    expect(target).toHaveTextContent("직접 연 탭");
  });
});
