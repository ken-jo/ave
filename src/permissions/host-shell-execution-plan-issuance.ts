import type { HostShellExecutionPlan } from "./host-shell-execution-plan.js";

// Plans the host's live provider issued, with the capability generation they were issued under. A leaf module so
// startup proof and spawn admission read the same registry without importing sandbox-capability.
const issuedPlans = new WeakMap<HostShellExecutionPlan, string>();
let currentGeneration: (() => string) | undefined;

export function recordIssuedHostShellExecutionPlan(plan: HostShellExecutionPlan, generation: string): void {
  issuedPlans.set(plan, generation);
}

export function issuedHostShellExecutionPlanGeneration(plan: unknown): string | undefined {
  return typeof plan === "object" && plan !== null ? issuedPlans.get(plan as HostShellExecutionPlan) : undefined;
}

// sandbox-capability owns the generation counter and binds it here when it loads.
export function bindCurrentSandboxGeneration(source: () => string): void {
  currentGeneration = source;
}

// Issued under the capability generation that is live now; a stale plan proves nothing.
export function isCurrentIssuedHostShellExecutionPlan(plan: unknown): boolean {
  const generation = issuedHostShellExecutionPlanGeneration(plan);
  return generation !== undefined && generation === currentGeneration?.();
}
