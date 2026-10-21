import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import { t } from "../i18n/runtime.js";

type ShellEnvironmentPlan = Pick<HostShellExecutionPlanAuditProjection,
  "platform" | "mode" | "substrate" | "capability" | "requiresExplicitUserApproval" | "fallbackReason">;

/** Public descriptions of the selected child, never the host's environment values. */
export function shellExecutionEnvironmentLines(plan: ShellEnvironmentPlan): readonly string[] {
  if (plan.mode === "blocked") return [t("shellExecution.blocked")];
  return [
    // A requested sandbox that could not start runs under the normal rules
    // (design I3); say so wherever the plan is shown instead of failing closed.
    ...(plan.fallbackReason === "requested-sandbox-unavailable"
      ? [t("shellExecution.sandboxUnavailable")]
      : []),
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
    // Windows MXC containers: Git Bash cannot start there, so the model must
    // not plan around Bash (the tool refuses it with the same guidance).
    ...(plan.mode === "asrt" && plan.substrate === "mxc" ? [t("shellExecution.mxcBashUnavailable")] : []),
    interactive ? t("shellExecution.hostRequest") : t("shellExecution.noInteractiveApproval"),
    t("shellExecution.pipelineStatus"),
    "</shell-execution-environment>",
  ].join("\n");
}
