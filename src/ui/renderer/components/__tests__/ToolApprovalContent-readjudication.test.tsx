// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { selectDecision } from "./support/decision-bar.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { HOME_FOLDER_REFUSED } from "../../../../shared/permissions-events.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { formatIpcError } from "../../format-ipc-error.js";

const EVIDENCE = {
  pluginId: "fixture-plugin", artifactSha256: "a".repeat(64), signerKeyId: "trusted-production",
  staticReason: "write-path-not-declared" as const,
};

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "readjudication-request", category: "tool", kind: "tool", toolName: "fixture_write",
    toolCategory: "write", args: { operation: "save", value: "one" }, source: "plugin",
    sourcePluginId: EVIDENCE.pluginId, reason: "write path not declared", createdAt: 0,
    requireExplicit: true, sessionId: "conversation", trustOrigin: "user-keyboard",
    ruleVerdict: { level: "high", reason: "write path not declared" },
    persistentAllowAllowed: true, exactRecordAllowed: true, persistentApprovalCwd: "/workspace/project",
    readjudication: EVIDENCE,
    ...overrides,
  };
}

function show(card: ApprovalRequest = request(), record = vi.fn().mockResolvedValue({ ok: true }), proposedChoice: "allow-always" | null = null) {
  const onDecide = vi.fn();
  vi.stubGlobal("ave", { userApproval: { record } });
  const result = render(<ToolApprovalContent open request={card} conversationLabel="conversation" onDecide={onDecide} proposedChoice={proposedChoice} />);
  return { ...result, onDecide, record };
}

afterEach(() => vi.unstubAllGlobals());

describe("human evidence re-adjudication card", () => {
  it("shows host evidence and keeps re-adjudication unselected", () => {
    show();
    expect(screen.getByTestId("approval-readjudication-opt-in")).not.toBeChecked();
    expect(screen.getByTestId("approval-readjudication-evidence")).toHaveTextContent(EVIDENCE.pluginId);
    expect(screen.getByTestId("approval-readjudication-evidence")).toHaveTextContent(EVIDENCE.artifactSha256);
    expect(screen.getByTestId("approval-readjudication-evidence")).toHaveTextContent(EVIDENCE.signerKeyId);
  });

  it.each([
    ["allow-session", "session", "allow-session"],
    ["allow-project", "persistent", "allow-always"],
    ["allow-everywhere", "global", "allow-always"],
  ] as const)("explicit opt-in remembers at %s scope with the original HIGH display", async (choice, scope, answer) => {
    const { onDecide, record } = show();
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    selectDecision(choice);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "readjudication-request", scope, readjudicate: true, verdictAtApproval: "high",
      args: '{"operation":"save","value":"one"}',
    }));
    const recorded: unknown = record.mock.calls[0]?.[0];
    if (recorded === null || typeof recorded !== "object") throw new Error("Exact approval was not recorded");
    expect(recorded).not.toHaveProperty("readjudication");
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(answer, undefined));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it("ordinary remembered approval does not acquire re-adjudication intent", async () => {
    const { onDecide, record } = show();
    selectDecision("allow-project");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    const recorded: unknown = record.mock.calls[0]?.[0];
    if (recorded === null || typeof recorded !== "object") throw new Error("Exact approval was not recorded");
    expect(recorded).not.toHaveProperty("readjudicate");
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
  });

  it.each([TEST_IDS.approveButton, TEST_IDS.denyButton] as const)("%s never records re-adjudication even with opt-in selected", (button) => {
    const { onDecide, record } = show();
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    fireEvent.click(screen.getByTestId(button));
    expect(record).not.toHaveBeenCalled();
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it("an exact deny never carries a selected re-adjudication intent", async () => {
    const { onDecide, record } = show();
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    selectDecision("deny-always");
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    const recorded: unknown = record.mock.calls[0]?.[0];
    if (recorded === null || typeof recorded !== "object") throw new Error("Exact approval was not recorded");
    expect(recorded).not.toHaveProperty("readjudicate");
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("deny-once"));
  });

  it.each([
    ["missing host evidence", { readjudication: undefined }],
    ["concrete danger", { readjudication: undefined, ruleVerdict: { level: "high", reason: "critical deletion" } }],
    ["reviewer failure", { readjudication: undefined, reviewerVerdict: { level: "high", reason: "reviewer unavailable" } }],
    ["plugin self-report", { readjudication: undefined, args: { readjudication: EVIDENCE } }],
    ["forced floor", { allowedChoices: ["allow-once", "deny-once"], persistentAllowAllowed: false }],
    ["non-recordable request", { persistentAllowAllowed: false }],
    ["non-plugin request", { source: "builtin" }],
    ["non-HIGH request", { ruleVerdict: { level: "medium", reason: "write" } }],
  ] satisfies Array<[string, Partial<ApprovalRequest>]>)("does not offer re-adjudication for %s", (_name, overrides) => {
    show(request(overrides));
    expect(screen.queryByTestId("approval-readjudication-opt-in")).toBeNull();
  });

  it("an approval-sentence scope proposal never selects re-adjudication", () => {
    show(request(), undefined, "allow-always");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveAttribute("data-choice", "allow-project");
    expect(screen.getByTestId("approval-readjudication-opt-in")).not.toBeChecked();
  });

  it("resets opt-in for a replacement request", () => {
    const { rerender, onDecide } = show();
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    expect(screen.getByTestId("approval-readjudication-opt-in")).toBeChecked();
    rerender(<ToolApprovalContent open request={request({ id: "replacement-request" })} conversationLabel="conversation" onDecide={onDecide} />);
    expect(screen.getByTestId("approval-readjudication-opt-in")).not.toBeChecked();
  });

  it.each([HOME_FOLDER_REFUSED, "evidence-unavailable", "managed"])("a %s save failure never substitutes an ordinary allow", async (error) => {
    const { onDecide } = show(request(), vi.fn().mockResolvedValue({ ok: false, error }));
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    await waitFor(() => expect(screen.getByTestId("exact-decision-save-error")).toHaveTextContent(t("toolApprovalDialog.exactDecisionSaveFailed")));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("locks opt-in and decisions until the exact save completes", async () => {
    let finish: ((result: { ok: true }) => void) | undefined;
    const pending = new Promise<{ ok: true }>((resolve) => { finish = resolve; });
    const { onDecide, record } = show(request(), vi.fn(() => pending));
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(screen.getByTestId("approval-readjudication-opt-in")).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeDisabled();
    expect(onDecide).not.toHaveBeenCalled();
    if (!finish) throw new Error("Pending save resolver missing");
    finish({ ok: true });
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("maps a host eligibility refusal to localized text without approving", async () => {
    const { onDecide } = show(request(), vi.fn().mockResolvedValue({ ok: false, error: "readjudication-unavailable" }));
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    await waitFor(() => expect(screen.getByTestId("exact-decision-save-error")).toHaveTextContent(t("formatIpcError.readjudicationUnavailable")));
    expect(onDecide).not.toHaveBeenCalled();
    expect(formatIpcError("readjudication-unavailable", undefined)).toBe(t("formatIpcError.readjudicationUnavailable"));
  });

  it("does not answer the replacement request when an old save completes", async () => {
    let finish: ((result: { ok: true }) => void) | undefined;
    const pending = new Promise<{ ok: true }>((resolve) => { finish = resolve; });
    const { rerender, onDecide } = show(request(), vi.fn(() => pending));
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    rerender(<ToolApprovalContent open request={request({ id: "replacement-request" })} conversationLabel="conversation" onDecide={onDecide} />);
    if (!finish) throw new Error("Pending save resolver missing");
    finish({ ok: true });
    await waitFor(() => expect(screen.getByTestId("approval-readjudication-opt-in")).not.toBeChecked());
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("describes exact input even when ordinary memory covers an entire tool", () => {
    show(request({ approvalMemory: { kind: "key", key: "whole-tool", scope: { kind: "mcp-tool", serverId: "fixture-server", toolName: "fixture_write" } } }));
    fireEvent.click(screen.getByTestId("approval-readjudication-opt-in"));
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent(t("toolApprovalDialog.exactPersistentScope", { path: "/workspace/project" }));
    selectDecision("allow-everywhere");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent(t("toolApprovalDialog.exactScopeEverywhere"));
  });

  it.each(["ko", "en"] as const)("renders the %s label and explanatory wording", (locale) => {
    const previous = getLocale();
    try {
      setLocale(locale);
      show();
      expect(screen.getByLabelText(locale === "ko" ? "MEDIUM으로 재판정" : "Re-adjudicate as MEDIUM")).not.toBeChecked();
      expect(screen.getByTestId("approval-readjudication")).toHaveTextContent(t("toolApprovalDialog.readjudicationNote"));
    } finally { setLocale(previous); }
  });
});
