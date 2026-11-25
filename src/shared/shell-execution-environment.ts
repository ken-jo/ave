import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import { t } from "../i18n/runtime.js";

type ShellEnvironmentPlan = Pick<HostShellExecutionPlanAuditProjection,
  "platform" | "mode" | "substrate" | "capability" | "requiresExplicitUserApproval" | "fallbackReason" | "installHints">;

const INSTALL_HINT_NAMES = { bubblewrap: "bubblewrap (bwrap)", socat: "socat", ripgrep: "ripgrep (rg)" } as const;

/** Public descriptions of the selected child, never the host's environment values. */
export function shellExecutionEnvironmentLines(plan: ShellEnvironmentPlan): readonly string[] {
  if (plan.mode === "blocked") return [t(plan.fallbackReason === "home-privacy-helper-unavailable" ? "shellExecution.homePrivacyHelperUnavailable" : "shellExecution.blocked")];
  return [
    // When requested confinement is unavailable, report the unsandboxed route wherever the plan is shown.
    ...(plan.fallbackReason === "requested-sandbox-unavailable"
      ? [t("shellExecution.sandboxUnavailableAsk"),
        ...(plan.installHints?.length
          ? [t("shellExecution.sandboxInstallHint", { packages: plan.installHints.map((hint) => INSTALL_HINT_NAMES[hint]).join(", ") })] : [])]
      // A shell-scope-off plan requires approval only while boot cannot establish Ave home privacy (any category but helper-unavailable, whose plan is blocked).
      : plan.requiresExplicitUserApproval && (plan.fallbackReason === "disabled-by-setting" || plan.fallbackReason === "platform-unsupported")
        ? [t("shellExecution.boundaryUnverifiedAsk")]
        : plan.fallbackReason === "windows-partial-shell-acl-unsafe" ? [t("shellExecution.shellNotContainedAsk")] : []),
    t("shellExecution.location", { platform: plan.platform }),
    plan.mode === "asrt" ? t("shellExecution.temporaryHome") : t("shellExecution.hostHome"),
    plan.mode === "asrt" ? t("shellExecution.isolatedAuthentication") : t("shellExecution.hostAuthentication"),
    t("shellExecution.currentUser"),
  ];
}

/** Describe the default route; the final per-call plan remains authoritative. */
export function shellExecutionEnvironmentPrompt(plan: ShellEnvironmentPlan, interactive: boolean): string {
  const confines = plan.capability.confines;
  const confinement = confines === undefined
    ? t("shellExecution.confinementUnspecified")
    : t("shellExecution.confinement", {
      filesystem: String(confines.filesystem),
      process: String(confines.process),
      network: String(confines.network),
    });
  return [
    "<shell-execution-environment>",
    ...shellExecutionEnvironmentLines(plan),
    confinement,
    t("shellExecution.defaultRoute"),
    // Bash cannot start in Windows containers; model guidance and tool refusal must agree.
    ...(plan.mode === "asrt" && plan.substrate === "mxc" ? [t("shellExecution.mxcBashUnavailable")] : []),
    // A helper-unavailable plan blocks the host route too, so no host request is offered.
    ...(!interactive ? [t("shellExecution.noInteractiveApproval")]
      : plan.fallbackReason === "home-privacy-helper-unavailable" ? [] : [t("shellExecution.hostRequest")]),
    t("shellExecution.pipelineStatus"),
    "</shell-execution-environment>",
  ].join("\n");
}
