// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { SHELL_ANALYSIS_LIMIT_REASON } from "../../../../permissions/decision-pipeline.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../../../shared/shell-analysis-limits.js";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection } from "../../../../permissions/host-shell-execution-plan.js";

function request(host: boolean): ApprovalRequest {
  return {
    id: "host-request", category: "tool", toolName: "bash", toolCategory: "shell",
    args: { command: "printf '%s' '" + "a".repeat(700) + "-final-marker'", executionMode: "host", justification: "Use the configured host client" },
    reason: "Explicit host execution request", source: "builtin", createdAt: Date.now(),
    requireExplicit: true, allowedChoices: ["allow-once", "deny-once"],
    executionCwd: "/workspace/project",
    executionPlan: getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
      executionMode: host ? "host" : "default", platform: "darwin", requestedSandbox: true,
      activeCapability: { reason: "Fixture sandbox available", kind: "asrt", confidence: "verified", platform: "darwin",
        confines: { filesystem: true, process: true, network: true } },
    })),
  };
}

describe("explicit host execution approval", () => {
  it("shows the exact host warning, reason, environment and full command before consent", () => {
    const { container } = renderApproval(request(true), () => undefined);
    const warning = container.querySelector('[data-testid="tool-approval-host-execution"]');
    expect(warning?.textContent).toContain(t("shellExecution.hostWarning"));
    expect(warning?.textContent).toContain("Use the configured host client");
    expect(container.querySelector('[data-testid="tool-approval-execution-cwd"]')?.textContent).toContain("/workspace/project");
    expect(container.querySelector('[data-testid="tool-approval-shell-environment"]')?.textContent).toContain(t("shellExecution.hostHome"));
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.textContent).toContain("-final-marker");
  });

  it("does not derive the host execution warning from model-provided arguments", () => {
    const { container } = renderApproval(request(false), () => undefined);
    expect(container.querySelector('[data-testid="tool-approval-host-execution"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-approval-shell-environment"]')?.textContent).toContain(t("shellExecution.temporaryHome"));
  });

  it.each([
    ["en", /exceeded the analysis limit/u],
    ["ko", /분석 한도를 초과했습니다/u],
  ] as const)("shows the analysis-limit reason in %s without offering a sandbox waiver", (locale, copy) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      const approval = request(false);
      approval.reason = SHELL_ANALYSIS_LIMIT_REASON;
      approval.reasonCode = "shell-analysis-limit";
      approval.shellAnalysisLimited = true;
      approval.executionPlan = getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
        platform: "linux", requestedSandbox: true,
        activeCapability: { reason: "Fixture sandbox unavailable", kind: "none", confidence: "verified", platform: "linux" },
      }));
      const { container } = renderApproval(approval, () => undefined);
      expect(container.querySelector('[data-testid="approval-ask-reason"]')?.textContent).toMatch(copy);
      const environment = container.querySelector('[data-testid="tool-approval-shell-environment"]')?.textContent;
      expect(environment).toContain(t("shellExecution.sandboxUnavailableOneTime"));
      expect(environment).not.toContain(t("shellExecution.sandboxUnavailableAsk"));
    } finally {
      setLocale(previous);
    }
  });

  describe.each([
    ["en", /the rest of the command past that limit was not checked/i],
    ["ko", /분석 한도 이후의 명령 내용은 확인하지 않았습니다/u],
  ] as const)("analysis-limit disclosure in %s", (locale, notice) => {
    it("preserves the other floor and shows the unchecked command with one-shot choices", () => {
      const previous = getLocale();
      setLocale(locale);
      try {
        const command = `printf %s${" word".repeat(MAX_SHELL_ANALYSIS_TOKENS)}\nprintf 'trailing marker'`;
        const approval = { ...request(false), args: { command }, shellAnalysisLimited: true as const, reason: "This principal requires local approval." };
        const { container, getByTestId } = renderApproval(approval, () => undefined);
        expect(getByTestId("approval-ask-reason")).toHaveTextContent(approval.reason);
        expect.soft(container.textContent).toMatch(notice);
        const commandRow = getByTestId("tool-approval-input");
        expect.soft(commandRow).toBeVisible();
        expect(commandRow.textContent).toBe(command);
        expect(Array.from(container.querySelectorAll("details pre")).at(-1)?.textContent).toContain("trailing marker");
        expect(getByTestId(TEST_IDS.approveButton)).toHaveTextContent(t("toolApprovalDialog.allowOnce"));
        expect(getByTestId(TEST_IDS.approveButton)).toBeEnabled();
        expect(getByTestId(TEST_IDS.denyButton)).toHaveTextContent(t("toolApprovalDialog.decisionDeny"));
        expect(getByTestId(TEST_IDS.denyButton)).toBeEnabled();
        expect(getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
      } finally {
        setLocale(previous);
      }
    });

    it.each(["host", "contained"] as const)("shows the unchecked notice and the full %s command before consent", (route) => {
      const previous = getLocale();
      setLocale(locale);
      try {
        const approval = request(false);
        const command = `printf '%s'${" word".repeat(MAX_SHELL_ANALYSIS_TOKENS)}\nprintf 'trailing marker'`;
        approval.args = { command };
        approval.reason = SHELL_ANALYSIS_LIMIT_REASON;
        approval.reasonCode = "shell-analysis-limit";
        approval.shellAnalysisLimited = true;
        if (route === "host") {
          approval.executionPlan = getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
            platform: "darwin", requestedSandbox: false,
            activeCapability: { reason: "Fixture sandbox disabled", kind: "none", confidence: "verified", platform: "darwin" },
          }));
        }
        const { container, getByTestId } = renderApproval(approval, () => undefined);
        const commandRow = getByTestId("tool-approval-input");
        expect.soft(getByTestId("approval-ask-reason").textContent).toMatch(notice);
        expect.soft(commandRow).toBeVisible();
        expect(commandRow.textContent).toBe(command);
        const fullInput = Array.from(container.querySelectorAll("details pre")).at(-1);
        expect(fullInput?.textContent).toContain("trailing marker");
      } finally {
        setLocale(previous);
      }
    });
  });

  it.each(["en", "ko"] as const)("shows a one-time boundary warning in %s", (locale) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      const approval = request(false);
      approval.reason = SHELL_ANALYSIS_LIMIT_REASON;
      approval.reasonCode = "shell-analysis-limit";
      approval.shellAnalysisLimited = true;
      approval.executionPlan = getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
        platform: "linux", requestedSandbox: false, unavailableSandboxRequiresAsk: true,
        activeCapability: { reason: "Fixture sandbox disabled", kind: "none", confidence: "verified", platform: "linux" },
      }));
      const { getByTestId } = renderApproval(approval, () => undefined);
      const environment = getByTestId("tool-approval-shell-environment");
      expect(environment.textContent).toMatch(locale === "en" ? /approve this command once/i : /이 명령을 한 번만 승인/u);
      expect(environment.textContent).not.toContain(t("shellExecution.boundaryUnverifiedAsk"));
    } finally {
      setLocale(previous);
    }
  });

  // An unavailable sandbox is a forced ask: the card says the sandbox is unavailable and shows the host warning, without the explicit-request justification.
  it("warns that the sandbox is unavailable on the forced fallback ask, with what to install", () => {
    const fallback = request(false);
    fallback.args = { command: "printf fallback" };
    fallback.executionPlan = getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true, unavailableCauses: ["missing-bwrap"],
      activeCapability: { reason: "Fixture sandbox unavailable", kind: "none", confidence: "verified", platform: "linux" },
    }));
    const { container } = renderApproval(fallback, () => undefined);
    const environment = container.querySelector('[data-testid="tool-approval-shell-environment"]')?.textContent;
    expect(environment).toContain(t("shellExecution.sandboxUnavailableAsk"));
    expect(environment).toContain(t("shellExecution.sandboxInstallHint", { packages: "bubblewrap (bwrap)" }));
    const host = container.querySelector('[data-testid="tool-approval-host-execution"]')?.textContent;
    expect(host).toContain(t("shellExecution.hostWarning"));
    expect(host).not.toContain(t("shellExecution.justification"));
  });
});
