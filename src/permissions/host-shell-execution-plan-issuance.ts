import type { HostShellExecutionPlan } from "./host-shell-execution-plan.js";

// Plans built by buildHostShellExecutionPlan. Startup proof trusts only these, never a structural lookalike.
const issuedPlans = new WeakSet<HostShellExecutionPlan>();

export function recordIssuedHostShellExecutionPlan(plan: HostShellExecutionPlan): HostShellExecutionPlan {
  issuedPlans.add(plan);
  return plan;
}

export function isIssuedHostShellExecutionPlan(plan: unknown): plan is HostShellExecutionPlan {
  return typeof plan === "object" && plan !== null && issuedPlans.has(plan as HostShellExecutionPlan);
}
