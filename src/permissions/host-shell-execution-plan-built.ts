import type { HostShellExecutionPlan } from "./host-shell-execution-plan.js";

// Plans built by buildHostShellExecutionPlan. Startup proof trusts only these, never a structural lookalike.
const builtPlans = new WeakSet<HostShellExecutionPlan>();

export function recordBuiltHostShellExecutionPlan(plan: HostShellExecutionPlan): HostShellExecutionPlan {
  builtPlans.add(plan);
  return plan;
}

export function isBuiltHostShellExecutionPlan(plan: unknown): plan is HostShellExecutionPlan {
  return typeof plan === "object" && plan !== null && builtPlans.has(plan as HostShellExecutionPlan);
}
