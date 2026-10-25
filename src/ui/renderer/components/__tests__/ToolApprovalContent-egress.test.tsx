// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { openDecisionMenu, selectDecision } from "./support/decision-bar.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { t } from "../../../../i18n/runtime.js";

const RULE = "Network(downloads.example.com:443)";

const request: ApprovalRequest = {
  id: "domain-ask", category: "tool", kind: "egress-host", toolName: "bash",
  toolCategory: "network", args: { host: "downloads.example.com", port: 443 },
  reason: "A sandboxed command requested a connection", createdAt: 0, sessionId: "conversation-1",
  requireExplicit: true, allowedChoices: ["allow-once", "deny-once"],
  egressHost: { host: "downloads.example.com", port: 443, rule: RULE, network: "public", scopes: ["once", "session", "project", "always"], projectCwd: "/workspace/project" },
};

function renderCard(ask: ApprovalRequest, onDecide = vi.fn(), interactionLocked = false) {
  render(<ToolApprovalContent open request={ask} conversationLabel="project session" interactionLocked={interactionLocked} onDecide={onDecide} />);
  return onDecide;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Owner 2026-10-25 (unified approval card): the network card draws the same Deny ▾ | Allow for session ▾ | Allow once row as every card.
describe("network approval dock card", () => {
  it("draws the shared row and allows once without saving anything", () => {
    const record = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    const onDecide = renderCard(request);
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "network");
    expect(screen.getByTestId("egress-approval-target")).toHaveTextContent("downloads.example.com:443");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent(t("toolApprovalDialog.decisionAllowSession"));
    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: "once" });
    expect(record).not.toHaveBeenCalled();
    expect(screen.queryByTestId("allow-always-exact-scope")).not.toBeInTheDocument();
  });

  it.each([
    ["allow-session", "session"],
    ["allow-project", "project"],
    ["allow-everywhere", "always"],
  ] as const)("an unedited %s answers with the %s grant and saves no rule", (choice, scope) => {
    const record = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    const onDecide = renderCard(request);
    selectDecision(choice);
    expect(screen.getByTestId("approval-rule-pattern")).toHaveTextContent(RULE);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: scope });
    expect(record).not.toHaveBeenCalled();
  });

  it("Deny denies once, and Always deny saves the host deny rule first", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    const onDecide = renderCard(request);
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(onDecide).toHaveBeenLastCalledWith("deny-once");
    expect(record).not.toHaveBeenCalled();
    selectDecision("deny-always");
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "domain-ask", decision: "deny", scope: "persistent", rule: { action: "deny", scope: "always" },
    }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(2));
    expect(onDecide).toHaveBeenLastCalledWith("deny-once");
  });

  // A wildcard host allow decides only sandboxed commands' connections: the card says so while it is edited, and shows the host's warning on save.
  it("an edited wildcard host allow warns while edited, saves the host rule, shows the host's warning, then allows once", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true, warning: "wildcard-allow-sandboxed-only" });
    vi.stubGlobal("ave", { userApproval: { record } });
    const onDecide = renderCard(request);
    selectDecision("allow-project");
    fireEvent.click(screen.getByTestId("approval-edit-rule"));
    fireEvent.change(screen.getByTestId("approval-rule-input"), { target: { value: "Network(api.example.com)" } });
    expect(screen.queryByTestId("approval-rule-wildcard-warning")).toBeNull();
    fireEvent.change(screen.getByTestId("approval-rule-input"), { target: { value: "Network(*.example.com)" } });
    expect(screen.getByTestId("approval-rule-wildcard-warning")).toHaveTextContent(t("toolApprovalDialog.wildcardHostAllowSandboxedOnly"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      decision: "allow", scope: "persistent", rule: { action: "allow", scope: "project", pattern: "Network(*.example.com)" },
    }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: "once" }));
    expect(screen.getByTestId("egress-approval-save-warning")).toHaveTextContent(t("toolApprovalDialog.wildcardHostAllowSandboxedOnly"));
  });

  it("a wildcard host deny carries no warning", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderCard(request);
    selectDecision("deny-always");
    fireEvent.click(screen.getByTestId("approval-edit-rule"));
    fireEvent.change(screen.getByTestId("approval-rule-input"), { target: { value: "Network(*.example.com)" } });
    expect(screen.queryByTestId("approval-rule-wildcard-warning")).toBeNull();
  });

  // One component for every network decision: a request without its payload draws the shared row with Deny only.
  it("draws a request without its payload as the shared row, Deny only", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    const onDecide = renderCard({ ...request, egressHost: undefined });
    expect(screen.getByTestId("egress-approval-card")).toHaveTextContent(t("egressApprovalCard.invalid"));
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "one-shot");
    expect(screen.queryByTestId(TEST_IDS.allowSessionButton)).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.approveButton)).toBeNull();
    expect(openDecisionMenu("deny-always")).toHaveAttribute("data-disabled");
    fireEvent.keyDown(screen.getByTestId("approval-choice-deny-always"), { key: "Escape" });
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });

  it("keeps the ask pending and says why when the host refuses the rule", async () => {
    const record = vi.fn().mockResolvedValue({ ok: false, error: "rule-does-not-match", message: "Network(other.org) does not deny this request" });
    vi.stubGlobal("ave", { userApproval: { record } });
    const onDecide = renderCard(request);
    selectDecision("deny-always");
    fireEvent.click(screen.getByTestId("approval-edit-rule"));
    fireEvent.change(screen.getByTestId("approval-rule-input"), { target: { value: "Network(other.org)" } });
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    await waitFor(() => expect(screen.getByTestId("egress-approval-save-error"))
      .toHaveTextContent(`${t("formatIpcError.ruleDoesNotMatch")} (Network(other.org) does not deny this request)`));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("offers no host rule for an address literal", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderCard({ ...request, egressHost: { ...request.egressHost!, host: "203.0.113.7", rule: null } });
    expect(openDecisionMenu("deny-always")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-deny-always-reason")).toHaveTextContent(t("toolApprovalDialog.networkRuleUnavailable"));
    fireEvent.keyDown(screen.getByTestId("approval-choice-deny-always"), { key: "Escape" });
    selectDecision("allow-everywhere");
    expect(screen.queryByTestId("approval-edit-rule")).toBeNull();
  });

  it("refuses the lasting allows a local destination is not offered", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderCard({ ...request, egressHost: { ...request.egressHost!, network: "local", scopes: ["once", "session"], projectCwd: undefined } });
    openDecisionMenu("allow-project");
    expect(screen.getByTestId("approval-choice-allow-session")).not.toHaveAttribute("data-disabled");
    for (const choice of ["allow-project", "allow-everywhere"]) {
      expect(screen.getByTestId(`approval-choice-${choice}`)).toHaveAttribute("data-disabled");
      expect(screen.getByTestId(`approval-choice-${choice}-reason`)).toHaveTextContent(t("toolApprovalDialog.networkLocalScopeNotOffered"));
    }
  });

  it("locks every decision while Settings holds the request", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderCard({ ...request, egressHost: { ...request.egressHost!, scopes: ["once"] } }, vi.fn(), true);
    for (const testId of [TEST_IDS.denyButton, TEST_IDS.allowSessionButton, TEST_IDS.approveButton, "approval-deny-menu", "approval-allow-menu"]) {
      expect(screen.getByTestId(testId)).toBeDisabled();
    }
  });
});
