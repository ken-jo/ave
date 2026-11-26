import { describe, expect, it } from "vitest";
import { getLocale, setLocale, t } from "../../i18n/runtime.js";
import { buildHostShellExecutionPlan, HOME_PRIVACY_HELPER_UNAVAILABLE_SHELL_DENIAL } from "../../permissions/host-shell-execution-plan.js";
import { shellExecutionEnvironmentLines, shellExecutionEnvironmentPrompt } from "../shell-execution-environment.js";

function helperUnavailablePlan() {
  return buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: false,
    activeCapability: { reason: "Fixture", kind: "none", confidence: "verified", platform: "win32" }, unconfinedShellDenied: true });
}

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

function environmentPrompt(defaultPlan: ReturnType<typeof plan>, interactive: boolean, hostPlan = defaultPlan) {
  return shellExecutionEnvironmentPrompt(defaultPlan, interactive, hostPlan);
}

describe("shell execution environment", () => {
  it("tells the model that a helper-unavailable boot denies shells until a restart", () => {
    const denied = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: false,
      activeCapability: { reason: "Fixture", kind: "none", confidence: "verified", platform: "win32" }, unconfinedShellDenied: true });
    expect(shellExecutionEnvironmentLines(denied)).toEqual([t("shellExecution.homePrivacyHelperUnavailable")]);
  });

  it.each([
    ["en", "Shell commands and hooks are off: Ave could not check its home folder privacy at startup. Restart Ave; if it persists, reinstall Ave."],
    ["ko", "시작할 때 Ave가 홈 폴더 보호를 확인하지 못해 셸 명령과 훅이 꺼져 있습니다. Ave를 다시 시작하세요. 문제가 계속되면 Ave를 다시 설치하세요."],
  ] as const)("words the helper-unavailable line in %s, and the denial reason is the English line", (locale, line) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      expect(shellExecutionEnvironmentLines(helperUnavailablePlan())).toEqual([line]);
    } finally {
      setLocale(previous);
    }
    if (locale === "en") expect(HOME_PRIVACY_HELPER_UNAVAILABLE_SHELL_DENIAL.reason).toBe(line);
  });

  it("offers no host-execution request while the helper-unavailable plan blocks every shell", () => {
    const prompt = environmentPrompt(helperUnavailablePlan(), true);
    expect(prompt).toContain(t("shellExecution.homePrivacyHelperUnavailable"));
    expect(prompt).not.toContain(t("shellExecution.hostRequest"));
    expect(environmentPrompt(plan(false), true)).toContain(t("shellExecution.hostRequest"));
  });

  it.each(["en", "ko"] as const)("describes an explicit host request on the floor in %s", (locale) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      const input = {
        platform: "win32", requestedSandbox: true, executionMode: "host",
        activeCapability: {
          kind: "asrt", platform: "win32", confidence: "verified", reason: "Fixture",
          confines: { filesystem: true, process: false, network: true },
        },
      } as const;
      const partial = buildHostShellExecutionPlan(input);
      const partialVerified = buildHostShellExecutionPlan({ ...input, homePrivacyVerified: true });
      const privacy = buildHostShellExecutionPlan({ ...input, requestedSandbox: false, unavailableSandboxRequiresAsk: true });
      const missingInput = { ...input, activeCapability: { ...input.activeCapability, kind: "none" as const } };
      const missing = buildHostShellExecutionPlan({ ...missingInput, homePrivacyVerified: true });
      const missingAndPrivacyUnverified = buildHostShellExecutionPlan({ ...missingInput, unavailableSandboxRequiresAsk: true });

      for (const hostPlan of [partial, partialVerified, privacy, missing, missingAndPrivacyUnverified]) {
        const prompt = environmentPrompt(plan(true), true, hostPlan);
        expect(prompt).toContain(t("shellExecution.hostRequestFloor"));
        expect(prompt).not.toContain(t("shellExecution.hostRequest"));
        expect(prompt.includes(t("shellExecution.hostRequestExactRule"))).toBe(hostPlan === missing || hostPlan === partialVerified);
        expect(environmentPrompt(plan(true), false, hostPlan)).not.toContain(t("shellExecution.hostRequestFloor"));
      }
    } finally {
      setLocale(previous);
    }
  });

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
    expect(environmentPrompt(fallback, true)).toContain(t("shellExecution.sandboxUnavailableAsk"));
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
    expect(environmentPrompt(hinted, true)).toContain(hint);
    expect(shellExecutionEnvironmentLines(unavailable(["missing-ripgrep"]))[1]).toBe(t("shellExecution.sandboxInstallHint", { packages: "ripgrep (rg)" }));
    expect(shellExecutionEnvironmentLines(unavailable(["linux-runtime-probe-failed"]))[1]).toBe(t("shellExecution.location", { platform: "linux" }));
    expect(shellExecutionEnvironmentLines(unavailable([]))[1]).toBe(t("shellExecution.location", { platform: "linux" }));
  });

  it("does not promise an interactive approval surface to a headless turn", () => {
    const prompt = environmentPrompt(plan(true), false);
    expect(prompt).toContain(t("shellExecution.noInteractiveApproval"));
    expect(prompt).not.toContain(t("shellExecution.hostRequest"));
    expect(prompt).toContain(t("shellExecution.pipelineStatus"));
  });

  it("does not project arbitrary host environment values", () => {
    const projected = environmentPrompt({
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
    expect(environmentPrompt(mxc, true)).toContain(t("shellExecution.mxcBashUnavailable"));
    expect(environmentPrompt(plan(true), true)).not.toContain(t("shellExecution.mxcBashUnavailable"));
    expect(environmentPrompt(plan(false), true)).not.toContain(t("shellExecution.mxcBashUnavailable"));
  });
});
