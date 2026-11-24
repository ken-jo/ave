import { describe, expect, it } from "vitest";
import { t } from "../../i18n/runtime.js";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { shellExecutionEnvironmentLines, shellExecutionEnvironmentPrompt } from "../shell-execution-environment.js";

function plan(sandbox: boolean) {
  return buildHostShellExecutionPlan({
    platform: "darwin",
    requestedSandbox: sandbox,
    activeCapability: {
      reason: "Fixture execution environment",
      kind: sandbox ? "asrt" : "none",
      confidence: "verified",
      platform: "darwin",
      confines: { filesystem: sandbox, process: sandbox, network: sandbox },
    },
  });
}

describe("shell execution environment", () => {
  it("separates the host location from the temporary home and authentication boundary", () => {
    const lines = shellExecutionEnvironmentLines(plan(true));
    expect(lines).toContain(t("shellExecution.location", { platform: "darwin" }));
    expect(lines).toContain(t("shellExecution.temporaryHome"));
    expect(lines).toContain(t("shellExecution.isolatedAuthentication"));
    expect(lines).not.toContain(t("shellExecution.hostHome"));
  });

  it("describes the actual plain child even when a sandbox was requested", () => {
    const fallback = buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true,
      activeCapability: { reason: "Fixture sandbox unavailable", kind: "none", confidence: "verified", platform: "linux" },
    });
    expect(shellExecutionEnvironmentLines(fallback)).toContain(t("shellExecution.hostHome"));
    expect(shellExecutionEnvironmentLines(fallback)).toContain(t("shellExecution.hostAuthentication"));
    expect(shellExecutionEnvironmentLines(fallback)).not.toContain(t("shellExecution.temporaryHome"));
  });

  it("warns that a requested sandbox is unavailable, and only then", () => {
    const fallback = buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true,
      activeCapability: { reason: "Fixture sandbox unavailable", kind: "none", confidence: "verified", platform: "linux" },
    });
    expect(shellExecutionEnvironmentLines(fallback)[0]).toBe(t("shellExecution.sandboxUnavailableAsk"));
    expect(shellExecutionEnvironmentPrompt(fallback, true)).toContain(t("shellExecution.sandboxUnavailableAsk"));
    expect(shellExecutionEnvironmentLines(plan(false))).not.toContain(t("shellExecution.sandboxUnavailableAsk"));
    expect(shellExecutionEnvironmentLines(plan(true))).not.toContain(t("shellExecution.sandboxUnavailableAsk"));
  });

  it("names what to install right after the unavailable notice, only when an install restores the sandbox", () => {
    const unavailable = (unavailableCauses: Parameters<typeof buildHostShellExecutionPlan>[0]["unavailableCauses"]) => buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true, unavailableCauses,
      activeCapability: { reason: "Fixture sandbox unavailable", kind: "none", confidence: "verified", platform: "linux" },
    });
    const hint = t("shellExecution.sandboxInstallHint", { packages: "bubblewrap (bwrap), socat" });
    expect(hint).toContain("bubblewrap (bwrap), socat");
    expect(hint).not.toContain("{packages}");
    const hinted = unavailable(["missing-bwrap", "missing-socat"]);
    expect(shellExecutionEnvironmentLines(hinted).slice(0, 2)).toEqual([t("shellExecution.sandboxUnavailableAsk"), hint]);
    expect(shellExecutionEnvironmentPrompt(hinted, true)).toContain(hint);
    expect(shellExecutionEnvironmentLines(unavailable(["missing-ripgrep"]))[1]).toBe(t("shellExecution.sandboxInstallHint", { packages: "ripgrep (rg)" }));
    expect(shellExecutionEnvironmentLines(unavailable(["linux-runtime-probe-failed"]))[1]).toBe(t("shellExecution.location", { platform: "linux" }));
    expect(shellExecutionEnvironmentLines(unavailable([]))[1]).toBe(t("shellExecution.location", { platform: "linux" }));
  });

  it("does not promise an interactive approval surface to a headless turn", () => {
    const prompt = shellExecutionEnvironmentPrompt(plan(true), false);
    expect(prompt).toContain(t("shellExecution.noInteractiveApproval"));
    expect(prompt).not.toContain(t("shellExecution.hostRequest"));
    expect(prompt).toContain(t("shellExecution.pipelineStatus"));
  });

  it("does not project arbitrary host environment values", () => {
    const projected = shellExecutionEnvironmentPrompt({
      ...plan(false),
      ...{ environment: { HOME: "/private-user-home", GH_TOKEN: "private-test-value" } },
    }, true);
    expect(projected).not.toContain("/private-user-home");
    expect(projected).not.toContain("private-test-value");
    expect(projected).toContain(t("shellExecution.currentUser"));
  });

  it("tells the model Bash is unavailable when shells run in Windows MXC containers, and only then", () => {
    const mxc = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      shellSubstrate: "mxc",
      activeCapability: {
        reason: "Fixture MXC",
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        confines: { filesystem: true, process: true, network: true },
      },
    });
    expect(shellExecutionEnvironmentPrompt(mxc, true)).toContain(t("shellExecution.mxcBashUnavailable"));
    expect(shellExecutionEnvironmentPrompt(plan(true), true)).not.toContain(t("shellExecution.mxcBashUnavailable"));
    expect(shellExecutionEnvironmentPrompt(plan(false), true)).not.toContain(t("shellExecution.mxcBashUnavailable"));
  });
});
