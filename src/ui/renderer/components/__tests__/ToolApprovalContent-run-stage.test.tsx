// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { openDecisionMenu, selectDecision } from "./support/decision-bar.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

const STAGE = { stageId: "plan", stageName: "Plan the change", runAllowOffered: true };

function exactRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "stage-exact", category: "tool", toolName: "write_file", toolCategory: "write",
    args: { path: "/workspace/project/notes.md", content: "x" }, source: "builtin",
    reason: "Review write", createdAt: 0, requireExplicit: false, sessionId: "plan-session",
    reviewerVerdict: { level: "medium", reason: "write" },
    persistentAllowAllowed: true, persistentApprovalCwd: "/workspace/project",
    ...overrides,
  };
}

function shellRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return exactRequest({
    id: "stage-shell", kind: "tool", toolName: "bash", toolCategory: "shell", args: { command: "printf %s ready" },
    shellRule: {
      dialect: "bash", denyRule: "Bash(printf %s ready)", denyAllowed: true, exactRule: "Bash(printf %s ready)",
      projectCwd: "/workspace/project", projectRoot: "/workspace/project", sessionAllowed: true, persistentAllowed: true,
    },
    ...overrides,
  });
}

function renderCard(request: ApprovalRequest, record = vi.fn().mockResolvedValue({ ok: true })) {
  const onDecide = vi.fn();
  vi.stubGlobal("ave", { userApproval: { record } });
  render(<ToolApprovalContent conversationLabel="Work item" open request={request} onDecide={onDecide} onOpenPermanentDeny={vi.fn()} />);
  return { onDecide, record };
}

const originalLocale = getLocale();
afterEach(() => { vi.unstubAllGlobals(); setLocale(originalLocale); });

// Owner decision 2026-11-16: each stage session's ask names its stage, and "Allow for this run" is kept by the host for the run's stage
// sessions while this request itself is answered once.
describe("a template-run stage card", () => {
  it.each(["en", "ko"] as const)("names its stage in %s", (locale) => {
    setLocale(locale);
    renderCard(exactRequest({ runStage: STAGE }));
    const stage = screen.getByTestId("approval-run-stage");
    expect(stage).toHaveAttribute("data-stage-id", "plan");
    expect(stage).toHaveTextContent(t("toolApprovalDialog.runStage", { stage: "Plan the change" }));
    expect(stage.textContent).toContain(locale === "en" ? "Stage: Plan the change" : "단계: Plan the change");
  });

  it("a card of no run names no stage and lists no run allow", () => {
    renderCard(exactRequest());
    expect(screen.queryByTestId("approval-run-stage")).toBeNull();
    openDecisionMenu("allow-session");
    expect(screen.queryByTestId("approval-choice-allow-run")).toBeNull();
  });

  it("an exact card's run allow is recorded at run scope, then the request is answered once", async () => {
    const { onDecide, record } = renderCard(exactRequest({ runStage: STAGE }));
    expect(openDecisionMenu("allow-run")).toHaveTextContent(t("toolApprovalDialog.decisionAllowRun"));
    fireEvent.keyDown(screen.getByTestId("approval-choice-allow-run"), { key: "Enter" });
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent(t("toolApprovalDialog.exactScopeRun"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ requestId: "stage-exact", decision: "allow", scope: "run" }));
    expect(record.mock.calls[0]?.[0]).not.toHaveProperty("rule");
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it("a shell card's run allow saves a run-scope rule, then the request is answered once", async () => {
    const { onDecide, record } = renderCard(shellRequest({ runStage: STAGE }));
    selectDecision("allow-run");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "stage-shell", decision: "allow", scope: "run", rule: { action: "allow", scope: "run" },
    }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(onDecide.mock.calls[0]?.[0]).toBe("allow-once");
  });

  it("a refused run record leaves the request unanswered and says why", async () => {
    const record = vi.fn().mockResolvedValue({ ok: false, error: "run-scope-unavailable" });
    const { onDecide } = renderCard(exactRequest({ runStage: STAGE }), record);
    selectDecision("allow-run");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    await waitFor(() => expect(screen.getByText(t("formatIpcError.runScopeUnavailable"))).toBeInTheDocument());
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("lists the run allow disabled, with its reason, where the host does not offer it", () => {
    renderCard(exactRequest({ runStage: { ...STAGE, runAllowOffered: false } }));
    const item = openDecisionMenu("allow-run");
    expect(item).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-allow-run-reason")).toHaveTextContent(t("toolApprovalDialog.runAllowUnavailable"));
  });
});
