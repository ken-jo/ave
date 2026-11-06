import type { HostShellExecutionPlan } from "./host-shell-execution-plan.js";

// Plans the host's live provider issued, with the capability generation they were issued under. A leaf module so
// startup proof and spawn admission read the same registry without importing sandbox-capability.
const issuedPlans = new WeakMap<HostShellExecutionPlan, string>();
let currentGeneration: (() => string) | undefined;

// sandbox-capability claims the only recorder when it loads and binds its generation counter; nothing else can issue.
export function claimHostShellExecutionPlanIssuer(
  generation: () => string,
): (plan: HostShellExecutionPlan, issuedGeneration: string) => void {
  if (currentGeneration !== undefined) throw new Error("The host shell execution plan issuer is already claimed.");
  currentGeneration = generation;
  return (plan, issuedGeneration) => { issuedPlans.set(plan, issuedGeneration); };
}

export function issuedHostShellExecutionPlanGeneration(plan: unknown): string | undefined {
  return typeof plan === "object" && plan !== null ? issuedPlans.get(plan as HostShellExecutionPlan) : undefined;
}

// Issued under the capability generation that is live now; a stale plan proves nothing.
export function isCurrentIssuedHostShellExecutionPlan(plan: unknown): boolean {
  const generation = issuedHostShellExecutionPlanGeneration(plan);
  return generation !== undefined && generation === currentGeneration?.();
}
