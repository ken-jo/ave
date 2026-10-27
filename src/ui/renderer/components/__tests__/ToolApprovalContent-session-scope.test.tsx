// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

/** A browser scope is remembered for this app session only: the remember button says so, records `scope: "session"`, and the scope line names the origin and whose tabs it covers. */
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
    sessionId: "11111111-1111-4111-8111-111111111111",
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
    renderApproval(browserRequest("agent"), onDecide);

    const remember = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(remember).toHaveTextContent("이번 세션 동안 허용");
    expect(remember).not.toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("https://a.example:443");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("에이전트가 연 탭");

    fireEvent.click(remember);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-session", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ scope: "session" }));
  });

  it("disables allow-for-this-session with its reason when the request has no conversation", async () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    const { sessionId: _omitted, ...request } = browserRequest("agent");
    renderApproval(request, onDecide);
    const remember = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(remember).toBeDisabled();
    const reason = "이 요청은 대화에 속하지 않아 세션 동안 허용할 수 없습니다. 한 번만 허용하세요.";
    expect(remember).toHaveAttribute("title", reason);
    expect(document.getElementById(remember.getAttribute("aria-describedby")!)).toHaveTextContent(reason);
    fireEvent.click(remember);
    expect(record).not.toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("names the user's own tabs for a user-tab scope", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(browserRequest("user"), vi.fn());
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
    renderApproval(request, vi.fn());
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.queryByTestId("allow-always-exact-scope")).toBeNull();
    const target = screen.getByTestId("approval-browser-target");
    expect(target).toHaveTextContent("https://a.example:443");
    expect(target).toHaveTextContent("직접 연 탭");
  });
});
