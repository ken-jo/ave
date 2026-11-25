// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { SHELL_ANALYSIS_LIMIT_REASON } from "../../../../permissions/decision-pipeline.js";
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
