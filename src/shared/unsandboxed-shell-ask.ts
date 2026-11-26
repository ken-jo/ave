import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";

export const ASK_EVERY_COMMAND_SUFFIX = ":ask";
export const EXACT_RULE_PASS_MARKER = ":home-verified";

// Plain routes take this floor when shell containment or Ave home privacy lacks proof.
export function requiresUnsandboxedShellAsk(plan: HostShellExecutionPlan | undefined): boolean {
  if (plan === undefined || plan.mode !== "plain" || plan.sandboxed || plan.capability.kind !== "none" ||
    plan.requiresExplicitUserApproval !== true || !plan.identity.endsWith(ASK_EVERY_COMMAND_SUFFIX)) return false;
  return plan.executionRequest === "host"
    ? plan.fallbackReason === "none"
    : plan.executionRequest === "default" && plan.fallbackReason !== "none";
}

// A saved exact rule can answer this floor when boot verified Ave home privacy.
export function exactRulePassesUnsandboxedShellAsk(plan: HostShellExecutionPlan | undefined): boolean {
  return plan !== undefined && requiresUnsandboxedShellAsk(plan) && plan.identity.endsWith(EXACT_RULE_PASS_MARKER + ASK_EVERY_COMMAND_SUFFIX);
}
