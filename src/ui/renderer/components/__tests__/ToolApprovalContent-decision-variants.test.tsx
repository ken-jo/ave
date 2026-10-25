// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { openDecisionMenu, selectDecision } from "./support/decision-bar.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { t } from "../../../../i18n/runtime.js";

function exactRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "exact-1", category: "tool", toolName: "write_file", toolCategory: "write",
    args: { path: "/workspace/project/notes.md", content: "x" }, source: "builtin",
    reason: "Review write", createdAt: 0, requireExplicit: false, sessionId: "conversation-1",
    reviewerVerdict: { level: "medium", reason: "write" },
    persistentAllowAllowed: true, persistentApprovalCwd: "/workspace/project",
    ...overrides,
  };
}

function folderRequest(suggestedParent: string | null = "/Users/me/project"): ApprovalRequest {
  return {
    id: "folder-1", category: "tool", kind: "out-of-allowed-dir", toolName: "read_file", toolCategory: "read",
    args: {}, reason: "outside allowed directories", createdAt: 0, requireExplicit: false,
    outOfAllowedDir: { candidatePath: "/Users/me/project/notes.md", suggestedParent, currentAllowed: ["/work"], adjacencyWarnings: [] },
  } as ApprovalRequest;
}

function renderCard(request: ApprovalRequest, record = vi.fn().mockResolvedValue({ ok: true })) {
  const onDecide = vi.fn();
  const onOpenPermanentDeny = vi.fn();
  vi.stubGlobal("ave", { userApproval: { record } });
  render(<ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={onDecide} onOpenPermanentDeny={onOpenPermanentDeny} />);
  return { onDecide, onOpenPermanentDeny, record };
}

afterEach(() => { vi.unstubAllGlobals(); });

// Owner 2026-10-25 (unified approval card): the same row on an exact tool approval and on a folder-access card, each mapped onto its own store.
describe("exact tool approval: the shared decision row", () => {
  it("offers session, project and everywhere, and draws no rule editor", () => {
    renderCard(exactRequest());
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "exact");
    openDecisionMenu("allow-session");
    for (const choice of ["allow-session", "allow-project", "allow-everywhere"]) {
      expect(screen.getByTestId(`approval-choice-${choice}`)).not.toHaveAttribute("data-disabled");
    }
    fireEvent.keyDown(screen.getByTestId("approval-choice-allow-everywhere"), { key: "Enter" });
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent(t("toolApprovalDialog.exactScopeEverywhere"));
    expect(screen.queryByTestId("approval-edit-rule")).toBeNull();
    expect(screen.queryByTestId("approval-rule-input")).toBeNull();
  });

  // The gate answer matches the record's lifetime: a conversation approval answers allow-session, so a host-held descriptor grant ends with it.
  it.each([
    ["allow-session", "session", "allow-session"],
    ["allow-project", "persistent", "allow-always"],
    ["allow-everywhere", "global", "allow-always"],
  ] as const)("%s records the exact approval at %s scope, then answers %s", async (choice, scope, answer) => {
    const { onDecide, record } = renderCard(exactRequest());
    selectDecision(choice);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ requestId: "exact-1", decision: "allow", scope }));
    expect(record.mock.calls[0]![0]).not.toHaveProperty("rule");
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(answer, undefined));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  // A request the host will not record (a layer-1/2 ask, a forced modal, a non-read reason prefix) is refused one-shot-not-recordable; the card does not offer it.
  it("offers no Always deny where the host records nothing, with the one-shot reason", () => {
    const { record } = renderCard(exactRequest({ exactRecordAllowed: false, persistentAllowAllowed: false }));
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "exact");
    expect(openDecisionMenu("deny-always")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-deny-always-reason")).toHaveTextContent(t("toolApprovalDialog.persistentUnavailableOneShot"));
    expect(record).not.toHaveBeenCalled();
  });

  it("Always deny records an exact deny and denies once, never the gate's tool-wide deny", async () => {
    const { onDecide, record } = renderCard(exactRequest());
    selectDecision("deny-always");
    expect(screen.getByTestId("approval-rule-row")).toHaveTextContent(t("toolApprovalDialog.exactDenyInSettings"));
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny", scope: "persistent" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("deny-once"));
    expect(onDecide).not.toHaveBeenCalledWith("deny-always");
  });

  it("Edit rule on Always deny opens the exact deny in Settings and decides nothing", () => {
    const { onDecide, onOpenPermanentDeny, record } = renderCard(exactRequest());
    selectDecision("deny-always");
    fireEvent.click(screen.getByTestId(TEST_IDS.openPermanentDenySettings));
    expect(onOpenPermanentDeny).toHaveBeenCalledWith(expect.objectContaining({ id: "exact-1" }), "medium");
    expect(onDecide).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("an /allow \"always\" proposal selects the project allow on the middle button", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={exactRequest()} onDecide={vi.fn()} proposedChoice="allow-always" />);
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveAttribute("data-choice", "allow-project");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent(t("toolApprovalDialog.decisionAllowProject"));
  });

  it("a high-risk request refuses every lasting allow with the high-risk reason", () => {
    renderCard(exactRequest({ reviewerVerdict: { level: "high", reason: "destructive" }, persistentAllowAllowed: undefined }));
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.getByTestId("allow-always-unavailable-reason")).toHaveTextContent(t("toolApprovalDialog.persistentUnavailableHighRisk"));
    expect(openDecisionMenu("deny-always")).not.toHaveAttribute("data-disabled");
  });
});

describe("folder-access card: the shared decision row", () => {
  it("allows the parent folder for good from the middle button and refuses session and project", async () => {
    const { onDecide, record } = renderCard(folderRequest());
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "path-grant");
    const middle = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(middle).toHaveTextContent(t("toolApprovalDialog.decisionAllowFolder"));
    expect(screen.getByTestId("approval-path-grant-evidence")).toHaveTextContent(t("toolApprovalDialog.decisionAllowFolder"));
    openDecisionMenu("allow-session");
    for (const choice of ["allow-session", "allow-project"]) {
      expect(screen.getByTestId(`approval-choice-${choice}`)).toHaveAttribute("data-disabled");
      expect(screen.getByTestId(`approval-choice-${choice}-reason`)).toHaveTextContent(t("toolApprovalDialog.pathGrantOnlyFolder"));
    }
    fireEvent.keyDown(screen.getByTestId("approval-choice-allow-everywhere"), { key: "Enter" });
    expect(screen.getByTestId("approval-rule-pattern")).toHaveTextContent("/Users/me/project");
    fireEvent.click(middle);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", "/Users/me/project"));
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses the folder allow when the host found no safe parent", () => {
    renderCard(folderRequest(null));
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.getByTestId("allow-always-unavailable-reason")).toHaveTextContent(t("toolApprovalDialog.persistentUnavailableNoParent"));
  });

  it("Always deny records an exact deny for the request and its Edit rule opens Settings", async () => {
    const { onDecide, onOpenPermanentDeny, record } = renderCard(folderRequest());
    selectDecision("deny-always");
    fireEvent.click(screen.getByTestId(TEST_IDS.openPermanentDenySettings));
    expect(onOpenPermanentDeny).toHaveBeenCalledWith(expect.objectContaining({ id: "folder-1" }), expect.any(String));
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny", scope: "persistent" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("deny-once"));
  });
});

describe("one-shot request: the shared decision row", () => {
  // One-shot is decided before the folder card: a host-narrowed folder request offers no remembered choice at all.
  it("a host-narrowed folder request is one-shot, not a folder card", () => {
    renderCard({ ...folderRequest(), allowedChoices: ["allow-once", "deny-once"], exactRecordAllowed: false });
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "one-shot");
    expect(openDecisionMenu("deny-always")).toHaveAttribute("data-disabled");
  });

  it("shows every remembering choice refused, keeps Deny and Allow once", () => {
    const { onDecide } = renderCard(exactRequest({ allowedChoices: ["allow-once", "deny-once"], persistentAllowAllowed: false }));
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "one-shot");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    openDecisionMenu("deny-always");
    expect(screen.getByTestId("approval-choice-deny-always")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-deny-once")).not.toHaveAttribute("data-disabled");
    fireEvent.keyDown(screen.getByTestId("approval-choice-deny-once"), { key: "Escape" });
    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});
