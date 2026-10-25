// Drive approval sentences through the real composer and selector bridge before confirming a decision.
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "./mock-ave-api.js";
import { TEST_IDS, testIdSelector } from "../../src/shared/test-ids.js";

const TARGET = "/home/example/reports/q3.md";
const PARENT = "/home/example/reports";

// Bind the directory request to the focused pane's turn so its composer owns the dock.
function approvalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-allow-1",
    category: "tool",
    kind: "out-of-allowed-dir",
    toolName: "read_file",
    args: {},
    reason: "outside allowed directories",
    createdAt: 0,
    requireExplicit: false,
    sessionId: MOCK_DEFAULT_SESSION_ID,
    outOfAllowedDir: {
      candidatePath: TARGET,
      suggestedParent: PARENT,
      currentAllowed: ["/home/example/work"],
      adjacencyWarnings: [],
    },
    ...overrides,
  };
}

async function appWithPendingApproval() {
  const app = await renderApp({ hasApiKey: true });
  await act(async () => {
    app.emitApproval(approvalRequest());
  });
  await waitFor(() =>
    expect(app.container.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeTruthy(),
  );
  return app;
}

const CHOICE_TESTID: Record<string, string> = {
  "deny-once": "deny-button",
  "allow-always": "allow-session-button",
  "allow-once": "approve-button",
};

const choice = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-testid="${CHOICE_TESTID[name]}"]`) as HTMLButtonElement | null;

const systemText = (container: HTMLElement) => container.textContent ?? "";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/allow — the sentence fills the form", () => {
  it("pre-selects the scope the host chose, and grants nothing until the button is pressed", async () => {
    const app = await appWithPendingApproval();
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-always",
    });

    await submitChatMessage(app.container, "/allow 이 폴더는 앞으로 계속 열어도 돼");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    expect(ns.approval.selectSentence.mock.calls[0][0]).toBe("req-allow-1");
    expect(ns.approval.selectSentence.mock.calls[0][1]).toContain("/allow");

    // Proposed focus and the visible grant target must move together before confirmation.
    await waitFor(() =>
      expect(choice(app.container, "allow-always")?.dataset.proposed).toBe("true"),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(choice(app.container, "allow-always")),
    );
    expect(
      app.container.querySelector('[data-testid="approval-decision-target"]')?.textContent,
    ).toContain(PARENT);

    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.container.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeTruthy();

    await act(async () => {
      choice(app.container, "allow-always")!.click();
    });
    await waitFor(() => expect(ns.approval.respond).toHaveBeenCalledTimes(1));
    expect(ns.approval.respond.mock.calls[0][0]).toMatchObject({
      requestId: "req-allow-1",
      choice: "allow-always",
      rememberPattern: PARENT,
    });
  });

  it("fills the lane card of a request that names no conversation — a host or plugin ask drawn in the focused pane", async () => {
    // Sessionless requests live in the pane lane; its composer can still address them.
    const app = await renderApp({ hasApiKey: true });
    const { sessionId: _own, ...unattributed } = approvalRequest({ id: "req-allow-host" });
    await act(async () => {
      app.emitApproval(unattributed);
    });
    await waitFor(() =>
      expect(app.container.querySelector('[data-testid="approval-lane-card"]')).toBeTruthy(),
    );
    expect(app.container.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeNull();
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-host",
      choice: "allow-always",
      rememberPattern: PARENT,
    });

    await submitChatMessage(app.container, "/allow 그 폴더 허용해줘");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    expect(ns.approval.selectSentence.mock.calls[0][0]).toBe("req-allow-host");
    await waitFor(() =>
      expect(choice(app.container, "allow-always")?.getAttribute("data-proposed")).toBe("true"),
    );
    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.api.chatSend).not.toHaveBeenCalled();
    expect(app.container.querySelector('[data-testid="approval-lane-card"]')).toBeTruthy();
  });

  it("never sends the sentence to the model as a chat message", async () => {
    const app = await appWithPendingApproval();
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-once",
    });

    await submitChatMessage(app.container, "/allow 한 번만 허용");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    // Approval sentences are control gestures and must never enter the conversation or deferred turn queue.
    expect(app.api.chatSend).not.toHaveBeenCalled();
  });

  it("ignores a proposal for a scope this request does not offer", async () => {
    // Remote requests allow only one-shot or denial; reject wider proposals instead of approximating them.
    const app = await renderApp({ hasApiKey: true });
    await act(async () => {
      app.emitApproval(
        approvalRequest({ allowedChoices: ["allow-once", "deny-once"] }),
      );
    });
    await waitFor(() =>
      expect(app.container.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeTruthy(),
    );
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-always",
    });

    await submitChatMessage(app.container, "/allow 앞으로 계속 허용");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    expect(choice(app.container, "allow-always")).toBeDisabled();
    expect(choice(app.container, "allow-always")).not.toHaveAttribute("data-proposed");
    expect(choice(app.container, "deny-once")?.tabIndex).toBe(0);
    expect(choice(app.container, "allow-once")?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(choice(app.container, "deny-once"));
    expect(ns.approval.respond).not.toHaveBeenCalled();
  });
});

describe("/allow — every failure is plain, and none of it is a grant", () => {
  it("does not invoke the filesystem scope selector for a generic tool approval", async () => {
    const app = await renderApp({ hasApiKey: true });
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    await act(async () => {
      app.emitApproval(approvalRequest({
        id: "req-generic-tool",
        kind: "tool",
        toolName: "bash",
        outOfAllowedDir: undefined,
      }));
    });
    await waitFor(() =>
      expect(app.container.querySelector('[data-testid="tool-approval-panel"]')).toBeTruthy(),
    );

    await submitChatMessage(app.container, "/allow this folder");

    expect(ns.approval.selectSentence).not.toHaveBeenCalled();
    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.api.chatSend).not.toHaveBeenCalled();
    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(app.container.querySelector(testIdSelector(TEST_IDS.approvalDock))).toBeTruthy();
  });

  it.each([
    ["no clear match", "allow-no-match"],
    ["no provider configured", "allow-selector-unavailable"],
    ["selection failed", "allow-selection-failed"],
    ["stale request id", "allow-no-pending-request"],
  ])("surfaces %s as ordinary text and decides nothing", async (_label, code) => {
    const app = await appWithPendingApproval();
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({ ok: false, error: code });

    await submitChatMessage(app.container, "/allow 허용해줘");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ns.approval.respond).not.toHaveBeenCalled());
    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(choice(app.container, "deny-once")?.tabIndex).toBe(0);
    expect(choice(app.container, "allow-once")?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(choice(app.container, "deny-once"));
    expect(systemText(app.container)).not.toContain(code);
  });

  it("says so plainly when nothing is waiting, and does not talk to the model", async () => {
    const app = await renderApp({ hasApiKey: true });
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };

    await submitChatMessage(app.container, "/allow 그 폴더 허용해줘");

    // Without a pending request id, answer locally without calling the host selector.
    await waitFor(() => expect(systemText(app.container)).toContain("/allow"));
    expect(ns.approval.selectSentence).not.toHaveBeenCalled();
    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.api.chatSend).not.toHaveBeenCalled();
  });

  it("drops a proposal that arrives after its request is gone", async () => {
    const app = await appWithPendingApproval();
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    let release!: (v: unknown) => void;
    ns.approval.selectSentence.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    await submitChatMessage(app.container, "/allow 계속 허용");
    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));

    await act(async () => {
      choice(app.container, "deny-once")!.click();
    });
    await waitFor(() => expect(ns.approval.respond).toHaveBeenCalledTimes(1));

    await act(async () => {
      release({ ok: true, requestId: "req-allow-1", choice: "allow-always" });
      await Promise.resolve();
    });
    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(ns.approval.respond).toHaveBeenCalledTimes(1);
  });

  it("never carries a proposal from one FIFO head onto the next request", async () => {
    const app = await appWithPendingApproval();
    const ns = window.ave as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-always",
    });

    await act(async () => {
      app.emitApproval(approvalRequest({
        id: "req-allow-2",
        outOfAllowedDir: {
          candidatePath: "/home/example/reports/q4.md",
          suggestedParent: "/home/example/reports",
          currentAllowed: ["/home/example/work"],
          adjacencyWarnings: [],
        },
      }));
    });

    await submitChatMessage(app.container, "/allow continue for this folder");
    await waitFor(() =>
      expect(choice(app.container, "allow-always")?.dataset.proposed).toBe("true"),
    );

    await act(async () => {
      choice(app.container, "deny-once")!.click();
    });
    await waitFor(() =>
      expect(
        app.container.querySelector(testIdSelector(TEST_IDS.approvalDock))
          ?.getAttribute("data-approval-request-id"),
      ).toBe("req-allow-2"),
    );

    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(choice(app.container, "deny-once")?.tabIndex).toBe(0);
    expect(choice(app.container, "allow-once")?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(choice(app.container, "deny-once"));
    expect(choice(app.container, "allow-always")?.tabIndex).toBe(-1);
    expect(
      app.container.querySelector(testIdSelector(TEST_IDS.approvalReviewDetails))?.textContent,
    ).toContain("/home/example/reports/q4.md");
    expect(ns.approval.respond).toHaveBeenCalledTimes(1);
  });
});
